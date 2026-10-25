from pathlib import Path

from mthds.protocol.problem.models import Problem
from pipelex_sdk.errors import ApiResponseError, RunFailedError, run_failed_problem
from pipelex_sdk.runs import RunResults, RunStatus
from pytest_mock import MockerFixture
from typer.testing import CliRunner

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


class TestAttendedCli:
    def test_help_lists_the_demos(self):
        result = runner.invoke(app, ["attended", "--help"])
        assert result.exit_code == 0
        for command in ("extract-entities", "summarize-pdf", "generate-image"):
            assert command in result.output

    def test_extract_entities_starts_waits_and_prints_result(self, mocker: MockerFixture):
        attended_mock = mocker.patch("widget.attended.cli.start_and_wait", return_value=_results(ENTITIES_CONTENT))
        result = runner.invoke(app, ["attended", "extract-entities", "some text"])
        assert result.exit_code == 0
        attended_mock.assert_awaited_once()
        assert attended_mock.await_args is not None
        assert attended_mock.await_args.kwargs["pipe_code"] == "extract_entities.extract_entities"
        # The bundle travels as the method's tree, `contents`, keyed by its path in the method's directory.
        assert list(attended_mock.await_args.kwargs["contents"]) == ["main.mthds"]
        assert attended_mock.await_args.kwargs["inputs"] == {"text": "some text"}
        assert "Marie Curie" in result.output

    def test_extract_entities_falls_back_to_the_sample(self, mocker: MockerFixture):
        attended_mock = mocker.patch("widget.attended.cli.start_and_wait", return_value=_results(ENTITIES_CONTENT))
        result = runner.invoke(app, ["attended", "extract-entities"])
        assert result.exit_code == 0
        assert attended_mock.await_args is not None
        assert attended_mock.await_args.kwargs["inputs"] == {"text": SAMPLE_ENTITIES_TEXT}

    def test_extract_entities_rejects_both_text_and_file(self, tmp_path: Path):
        input_file = tmp_path / "input.txt"
        input_file.write_text("from a file")
        result = runner.invoke(app, ["attended", "extract-entities", "inline text", "--file", str(input_file)])
        assert result.exit_code != 0

    def test_extract_entities_reads_the_file_input(self, mocker: MockerFixture, tmp_path: Path):
        attended_mock = mocker.patch("widget.attended.cli.start_and_wait", return_value=_results(ENTITIES_CONTENT))
        input_file = tmp_path / "input.txt"
        input_file.write_text("text from a file")
        result = runner.invoke(app, ["attended", "extract-entities", "--file", str(input_file)])
        assert result.exit_code == 0
        assert attended_mock.await_args is not None
        assert attended_mock.await_args.kwargs["inputs"] == {"text": "text from a file"}

    def test_summarize_pdf_falls_back_to_the_sample_invoice(self, mocker: MockerFixture, stub_upload: str):
        attended_mock = mocker.patch("widget.attended.cli.start_and_wait", return_value=_results(SUMMARY_CONTENT))
        result = runner.invoke(app, ["attended", "summarize-pdf"])
        assert result.exit_code == 0
        assert attended_mock.await_args is not None
        document_input = attended_mock.await_args.kwargs["inputs"]["document"]
        assert document_input["concept"] == "Document"
        assert document_input["content"]["filename"] == "sample-invoice.pdf"
        assert document_input["content"]["url"] == stub_upload

    def test_summarize_pdf_rejects_a_missing_file(self, tmp_path: Path):
        result = runner.invoke(app, ["attended", "summarize-pdf", str(tmp_path / "nope.pdf")])
        assert result.exit_code != 0

    def test_summarize_pdf_sends_the_document_envelope(self, mocker: MockerFixture, tmp_path: Path, stub_upload: str):
        attended_mock = mocker.patch("widget.attended.cli.start_and_wait", return_value=_results(SUMMARY_CONTENT))
        pdf = tmp_path / "doc.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")
        result = runner.invoke(app, ["attended", "summarize-pdf", str(pdf)])
        assert result.exit_code == 0
        assert "Q3 Report" in result.output
        assert attended_mock.await_args is not None
        document_input = attended_mock.await_args.kwargs["inputs"]["document"]
        assert document_input["concept"] == "Document"
        assert document_input["content"]["mime_type"] == "application/pdf"
        assert document_input["content"]["url"] == stub_upload

    def test_generate_image_falls_back_to_the_sample(self, mocker: MockerFixture, stub_download: str):
        attended_mock = mocker.patch("widget.attended.cli.start_and_wait", return_value=_results(IMAGE_CONTENT))
        result = runner.invoke(app, ["attended", "generate-image"])
        assert result.exit_code == 0
        assert attended_mock.await_args is not None
        assert attended_mock.await_args.kwargs["inputs"] == {"image_prompt": SAMPLE_IMAGE_PROMPT}

    def test_generate_image_sends_the_prompt(self, mocker: MockerFixture, stub_download: str):
        attended_mock = mocker.patch("widget.attended.cli.start_and_wait", return_value=_results(IMAGE_CONTENT))
        result = runner.invoke(app, ["attended", "generate-image", "a cat wearing a hat"])
        assert result.exit_code == 0
        assert "pipelex-storage://run-1/cat.png" in result.output
        # The produced file came down and the command said where it landed.
        assert stub_download in result.output
        assert attended_mock.await_args is not None
        assert attended_mock.await_args.kwargs["inputs"] == {"image_prompt": "a cat wearing a hat"}

    def test_a_failed_run_prints_the_reason_the_next_step_and_the_retry_advice(self, mocker: MockerFixture):
        # The run's own problem, nested in the `run.failed` the results read answers, as `wait_for_result` raises it.
        run_error = Problem.model_validate(
            {
                "type": "https://mthds.ai/errors/model.content_refused",
                "title": "The provider refused the content",
                "detail": "The model 'gpt-5.5' or its provider refused the request's content on policy grounds.",
                "code": "model.content_refused",
                "domain": "input",
                "retry": "no",
                "next_step": {
                    "kind": "change_input",
                    "detail": "Change the inputs so that they meet the provider's content policy, then send the request again.",
                },
            }
        )
        error = RunFailedError(
            "Run finished with status FAILED",
            run_id="run-1",
            status=RunStatus.FAILED,
            problem=run_failed_problem(run_id="run-1", status=RunStatus.FAILED, run_error=run_error),
        )
        mocker.patch("widget.attended.cli.start_and_wait", side_effect=error)
        result = runner.invoke(app, ["attended", "extract-entities", "some text"])
        assert result.exit_code == 1
        output = " ".join(result.output.split())
        assert "Run run-1 failed." in output
        assert (
            "Reason: The provider refused the content — The model 'gpt-5.5' or its provider refused the request's content on policy grounds."
            in output
        )
        assert "Next step: Change the inputs so that they meet the provider's content policy, then send the request again." in output
        assert "Retry: running it again unchanged will fail the same way." in output
        assert "For support: run run-1 · model.content_refused" in output

    def test_a_refused_start_prints_the_reason_the_pipe_and_the_next_step(self, mocker: MockerFixture, refused_start: ApiResponseError):
        mocker.patch("widget.attended.cli.start_and_wait", side_effect=refused_start)
        result = runner.invoke(app, ["attended", "extract-entities", "some text"])
        assert result.exit_code == 1
        output = " ".join(result.output.split())
        assert "The API answered 422 Unprocessable Entity." in output
        assert "Reason: The method does not validate." in output
        assert "In pipe draft_pitch, field model: Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found" in output
        assert "Who acts: whoever authors the method, by changing it." in output
        assert "Next step: Fix each fault the problem's errors list, then validate the method again." in output
        assert "For support: method.invalid · request req_a3dd6900-7909-48d3-b551-0140e73ac7fc" in output
