import asyncio
from pathlib import Path
from typing import Any

from pipelex_sdk.errors import ApiResponseError, StoredTextLoadError
from pipelex_sdk.execute_result import PipelexExecuteResult
from pipelex_sdk.runs import RunResults
from pytest_mock import MockerFixture
from typer.testing import CliRunner

from widget.blocking.cli import execute_pipe
from widget.cli import app
from widget.inputs import SAMPLE_ENTITIES_TEXT, SAMPLE_IMAGE_PROMPT

ENTITIES_CONTENT = {"people": ["Marie Curie"], "orgs": ["University of Paris"], "dates": ["1906"]}
SUMMARY_CONTENT = {"title": "Q3 Report", "doc_type": "report", "key_points": ["Revenue up 12%"]}
# The shape the hosted runtime really returns: the durable storage reference the artifact stack
# walks, plus the short-lived signed link beside it, which is never what gets downloaded.
IMAGE_CONTENT = {"url": "pipelex-storage://run-1/cat.png", "public_url": "https://cdn.example.com/signed/cat.png"}


# The lifecycle helpers hand back a whole `RunResults`; these offline tests carry no usage, so the
# cost report is a no-op. The produced-file half is not: the image demos' output carries a real
# `pipelex-storage://` reference, which is what the hosted runtime returns, so it goes past
# `download_produced_files`'s offline short-circuit and needs the `stub_download` fixture — a text
# demo's output references nothing and never reaches a client. The usage pair is passed explicitly
# because both real paths set it: a `RunResults` that never carried the key is a read that did not
# deliver it, which `summarize_usage` refuses rather than reads as "no usage".
def _results(main_stuff: object) -> RunResults:
    return RunResults(pipeline_run_id="run-1", main_stuff=main_stuff, tokens_usages=None, usage_assembly_error=None)


runner = CliRunner()


def _stored_reference(url: str) -> dict[str, Any]:
    """A stored text's reference, as the runtime answers a `Text` value past its inline threshold."""
    return {"url": url, "size": 4096, "mime_type": "text/plain", "preview": "The start…"}


def _stored_text_answer(main_stuff: object) -> PipelexExecuteResult:
    """An execute answer whose main stuff is a `native.Text` held by reference, its concept in the working memory."""
    return PipelexExecuteResult.model_validate(
        {
            "pipeline_run_id": "run-4",
            "main_stuff_name": "essay",
            "pipe_output": {
                "pipeline_run_id": "run-4",
                "working_memory": {
                    "root": {"essay": {"concept": "native.Text", "content": main_stuff}},
                    "aliases": {"main_stuff": "essay"},
                },
            },
        }
    )


class _FakeClient:
    """A `PipelexAPIClient` stand-in whose `execute` answers with a given result and that resolves nothing."""

    def __init__(self, answer: PipelexExecuteResult) -> None:
        self.answer = answer
        self.resolved: list[Any] = []

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    async def execute(self, **_kwargs: Any) -> PipelexExecuteResult:
        return self.answer

    async def resolve_storage_urls(self, *args: Any, **kwargs: Any) -> Any:
        self.resolved.append((args, kwargs))
        msg = "a data: URL is decoded where it is, never resolved"
        raise AssertionError(msg)


class TestBlockingCli:
    def test_help_lists_the_demos(self):
        result = runner.invoke(app, ["blocking", "--help"])
        assert result.exit_code == 0
        for command in ("extract-entities", "summarize-pdf", "generate-image"):
            assert command in result.output

    def test_extract_entities_executes_and_prints_result(self, mocker: MockerFixture):
        execute_mock = mocker.patch("widget.blocking.cli.execute_pipe", return_value=_results(ENTITIES_CONTENT))
        result = runner.invoke(app, ["blocking", "extract-entities", "some text"])
        assert result.exit_code == 0
        execute_mock.assert_awaited_once()
        assert execute_mock.await_args is not None
        assert execute_mock.await_args.kwargs["pipe_code"] == "extract_entities.extract_entities"
        # The bundle travels as the method's tree, `contents`, keyed by its path in the method's directory.
        assert list(execute_mock.await_args.kwargs["contents"]) == ["main.mthds"]
        assert execute_mock.await_args.kwargs["inputs"] == {"text": "some text"}
        assert "Marie Curie" in result.output

    def test_extract_entities_falls_back_to_the_sample(self, mocker: MockerFixture):
        execute_mock = mocker.patch("widget.blocking.cli.execute_pipe", return_value=_results(ENTITIES_CONTENT))
        result = runner.invoke(app, ["blocking", "extract-entities"])
        assert result.exit_code == 0
        assert execute_mock.await_args is not None
        assert execute_mock.await_args.kwargs["inputs"] == {"text": SAMPLE_ENTITIES_TEXT}

    def test_extract_entities_rejects_both_text_and_file(self, tmp_path: Path):
        input_file = tmp_path / "input.txt"
        input_file.write_text("from a file")
        result = runner.invoke(app, ["blocking", "extract-entities", "inline text", "--file", str(input_file)])
        assert result.exit_code != 0

    def test_extract_entities_reads_the_file_input(self, mocker: MockerFixture, tmp_path: Path):
        execute_mock = mocker.patch("widget.blocking.cli.execute_pipe", return_value=_results(ENTITIES_CONTENT))
        input_file = tmp_path / "input.txt"
        input_file.write_text("text from a file")
        result = runner.invoke(app, ["blocking", "extract-entities", "--file", str(input_file)])
        assert result.exit_code == 0
        assert execute_mock.await_args is not None
        assert execute_mock.await_args.kwargs["inputs"] == {"text": "text from a file"}

    def test_summarize_pdf_falls_back_to_the_sample_invoice(self, mocker: MockerFixture, stub_upload: str):
        execute_mock = mocker.patch("widget.blocking.cli.execute_pipe", return_value=_results(SUMMARY_CONTENT))
        result = runner.invoke(app, ["blocking", "summarize-pdf"])
        assert result.exit_code == 0
        assert execute_mock.await_args is not None
        document_input = execute_mock.await_args.kwargs["inputs"]["document"]
        assert document_input["concept"] == "Document"
        assert document_input["content"]["filename"] == "sample-invoice.pdf"
        assert document_input["content"]["url"] == stub_upload

    def test_summarize_pdf_rejects_a_missing_file(self, tmp_path: Path):
        result = runner.invoke(app, ["blocking", "summarize-pdf", str(tmp_path / "nope.pdf")])
        assert result.exit_code != 0

    def test_summarize_pdf_sends_the_document_envelope(self, mocker: MockerFixture, tmp_path: Path, stub_upload: str):
        execute_mock = mocker.patch("widget.blocking.cli.execute_pipe", return_value=_results(SUMMARY_CONTENT))
        pdf = tmp_path / "doc.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")
        result = runner.invoke(app, ["blocking", "summarize-pdf", str(pdf)])
        assert result.exit_code == 0
        assert "Q3 Report" in result.output
        assert execute_mock.await_args is not None
        document_input = execute_mock.await_args.kwargs["inputs"]["document"]
        assert document_input["concept"] == "Document"
        assert document_input["content"]["mime_type"] == "application/pdf"
        assert document_input["content"]["url"] == stub_upload

    def test_generate_image_falls_back_to_the_sample(self, mocker: MockerFixture, stub_download: str):
        execute_mock = mocker.patch("widget.blocking.cli.execute_pipe", return_value=_results(IMAGE_CONTENT))
        result = runner.invoke(app, ["blocking", "generate-image"])
        assert result.exit_code == 0
        assert execute_mock.await_args is not None
        assert execute_mock.await_args.kwargs["inputs"] == {"image_prompt": SAMPLE_IMAGE_PROMPT}

    def test_generate_image_sends_the_prompt(self, mocker: MockerFixture, stub_download: str):
        execute_mock = mocker.patch("widget.blocking.cli.execute_pipe", return_value=_results(IMAGE_CONTENT))
        result = runner.invoke(app, ["blocking", "generate-image", "a cat wearing a hat"])
        assert result.exit_code == 0
        assert "pipelex-storage://run-1/cat.png" in result.output
        # The produced file came down and the command said where it landed.
        assert stub_download in result.output
        assert execute_mock.await_args is not None
        assert execute_mock.await_args.kwargs["inputs"] == {"image_prompt": "a cat wearing a hat"}

    def test_execute_pipe_loads_a_stored_text_of_the_result(self, mocker: MockerFixture):
        fake = _FakeClient(_stored_text_answer(_stored_reference("data:text/plain;charset=utf-8,A%20long%20essay")))
        mocker.patch("widget.blocking.cli.PipelexAPIClient", return_value=fake)
        results = asyncio.run(execute_pipe(pipe_code="essay.write", inputs={}, contents={"main.mthds": "x"}))
        # The value the generated model requires, as a durable read hands it back, not the reference.
        assert results.main_stuff == {"text": "A long essay"}
        assert fake.resolved == []

    def test_a_stored_text_that_failed_to_load_is_a_finished_run_whose_result_could_not_be_loaded(self, mocker: MockerFixture):
        failure = StoredTextLoadError(
            "The stored text at $ could not be loaded: the store answered 503.",
            uri="pipelex-storage://org/runs/run-4/generated/ab/value.txt",
            path="$",
            reason="store_error",
            status=503,
        )
        mocker.patch("widget.blocking.cli.execute_pipe", side_effect=failure)
        result = runner.invoke(app, ["blocking", "extract-entities", "some text"])
        assert result.exit_code == 1
        output = " ".join(result.output.split())
        assert "The run finished, but its result could not be loaded." in output
        assert "Where: $ in the result" in output
        assert "Why: store_error" in output
        assert "kept nowhere else" in output
        # Never told as the ~30s cap, a run still going, or files that failed to save.
        assert "may still be going" not in output
        assert "saving its files" not in output

    def test_a_refused_execute_prints_the_reason_the_pipe_and_the_next_step(self, mocker: MockerFixture, refused_start: ApiResponseError):
        mocker.patch("widget.blocking.cli.execute_pipe", side_effect=refused_start)
        result = runner.invoke(app, ["blocking", "extract-entities", "some text"])
        assert result.exit_code == 1
        output = " ".join(result.output.split())
        assert "The API answered 422 Unprocessable Entity." in output
        assert "Reason: The method does not validate." in output
        assert "In pipe draft_pitch, field model: Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found" in output
        assert "Who acts: whoever authors the method, by changing it." in output
        assert "Next step: Fix each fault the problem's errors list, then validate the method again." in output
        assert "For support: method.invalid · request req_a3dd6900-7909-48d3-b551-0140e73ac7fc" in output
