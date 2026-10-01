from pathlib import Path

from pipelex_sdk.error_models import RunErrorReport, UserAction
from pipelex_sdk.errors import ApiResponseError, RunFailedError
from pipelex_sdk.runs import RunRead, RunResultCompleted, RunResultFailed, RunResultRunning, RunResults, RunStatus
from pytest_mock import MockerFixture
from typer.testing import CliRunner

from widget.cli import app
from widget.inputs import SAMPLE_ENTITIES_TEXT, SAMPLE_IMAGE_PROMPT

ENTITIES_CONTENT = {"people": ["Marie Curie"], "orgs": ["University of Paris"], "dates": ["1906"]}
# The shape the hosted runtime really returns: the durable storage reference the artifact stack
# walks, plus the short-lived signed link beside it, which is never what gets downloaded.
IMAGE_CONTENT = {"url": "pipelex-storage://run-1/cat.png", "public_url": "https://cdn.example.com/signed/cat.png"}
RUN_ID = "run-abc123"
# A failed run's stored report, and the platform's sentence about the run that carries it.
MODEL_REPORT = RunErrorReport(
    title="LLM completion",
    message="The model refused the request.",
    retryable=True,
    user_action=UserAction(kind="change_input", detail="Rephrase the prompt, or pick another model."),
)
REPORTED_DETAIL = "Run finished with status FAILED: The model refused the request."


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


class TestDetachedCli:
    def test_help_lists_the_demos_and_the_lifecycle_commands(self):
        result = runner.invoke(app, ["detached", "--help"])
        assert result.exit_code == 0
        for command in ("extract-entities", "summarize-pdf", "generate-image", "wait", "status", "result"):
            assert command in result.output

    def test_extract_entities_starts_the_run_and_prints_its_id(self, mocker: MockerFixture):
        start_mock = mocker.patch("widget.detached.cli.start_pipe", return_value=RUN_ID)
        result = runner.invoke(app, ["detached", "extract-entities", "some text"])
        assert result.exit_code == 0
        start_mock.assert_awaited_once()
        assert start_mock.await_args is not None
        assert start_mock.await_args.kwargs["pipe_code"] == "extract_entities.extract_entities"
        assert start_mock.await_args.kwargs["inputs"] == {"text": "some text"}
        # The bare id on stdout is the contract: RUN_ID=$(widget detached extract-entities "…")
        assert result.stdout.strip() == RUN_ID

    def test_extract_entities_falls_back_to_the_sample(self, mocker: MockerFixture):
        start_mock = mocker.patch("widget.detached.cli.start_pipe", return_value=RUN_ID)
        result = runner.invoke(app, ["detached", "extract-entities"])
        assert result.exit_code == 0
        assert start_mock.await_args is not None
        assert start_mock.await_args.kwargs["inputs"] == {"text": SAMPLE_ENTITIES_TEXT}
        # The sample notice goes to stderr, so stdout stays the bare run id.
        assert result.stdout.strip() == RUN_ID

    def test_extract_entities_rejects_both_text_and_file(self, tmp_path: Path):
        input_file = tmp_path / "input.txt"
        input_file.write_text("from a file")
        result = runner.invoke(app, ["detached", "extract-entities", "inline text", "--file", str(input_file)])
        assert result.exit_code != 0

    def test_extract_entities_reads_the_file_input(self, mocker: MockerFixture, tmp_path: Path):
        start_mock = mocker.patch("widget.detached.cli.start_pipe", return_value=RUN_ID)
        input_file = tmp_path / "input.txt"
        input_file.write_text("text from a file")
        result = runner.invoke(app, ["detached", "extract-entities", "--file", str(input_file)])
        assert result.exit_code == 0
        assert start_mock.await_args is not None
        assert start_mock.await_args.kwargs["inputs"] == {"text": "text from a file"}

    def test_summarize_pdf_falls_back_to_the_sample_invoice(self, mocker: MockerFixture, stub_upload: str):
        start_mock = mocker.patch("widget.detached.cli.start_pipe", return_value=RUN_ID)
        result = runner.invoke(app, ["detached", "summarize-pdf"])
        assert result.exit_code == 0
        assert start_mock.await_args is not None
        document_input = start_mock.await_args.kwargs["inputs"]["document"]
        assert document_input["concept"] == "Document"
        assert document_input["content"]["filename"] == "sample-invoice.pdf"
        assert document_input["content"]["url"] == stub_upload

    def test_summarize_pdf_rejects_a_missing_file(self, tmp_path: Path):
        result = runner.invoke(app, ["detached", "summarize-pdf", str(tmp_path / "nope.pdf")])
        assert result.exit_code != 0

    def test_summarize_pdf_sends_the_document_envelope(self, mocker: MockerFixture, tmp_path: Path, stub_upload: str):
        start_mock = mocker.patch("widget.detached.cli.start_pipe", return_value=RUN_ID)
        pdf = tmp_path / "doc.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")
        result = runner.invoke(app, ["detached", "summarize-pdf", str(pdf)])
        assert result.exit_code == 0
        assert start_mock.await_args is not None
        document_input = start_mock.await_args.kwargs["inputs"]["document"]
        assert document_input["concept"] == "Document"
        assert document_input["content"]["mime_type"] == "application/pdf"
        assert document_input["content"]["url"] == stub_upload

    def test_generate_image_falls_back_to_the_sample(self, mocker: MockerFixture):
        start_mock = mocker.patch("widget.detached.cli.start_pipe", return_value=RUN_ID)
        result = runner.invoke(app, ["detached", "generate-image"])
        assert result.exit_code == 0
        assert start_mock.await_args is not None
        assert start_mock.await_args.kwargs["inputs"] == {"image_prompt": SAMPLE_IMAGE_PROMPT}
        assert result.stdout.strip() == RUN_ID

    def test_generate_image_sends_the_prompt(self, mocker: MockerFixture):
        start_mock = mocker.patch("widget.detached.cli.start_pipe", return_value=RUN_ID)
        result = runner.invoke(app, ["detached", "generate-image", "a cat wearing a hat"])
        assert result.exit_code == 0
        assert start_mock.await_args is not None
        assert start_mock.await_args.kwargs["inputs"] == {"image_prompt": "a cat wearing a hat"}
        assert result.stdout.strip() == RUN_ID

    def test_a_refused_start_prints_the_reason_the_pipe_and_the_next_step(self, mocker: MockerFixture, refused_start: ApiResponseError):
        mocker.patch("widget.detached.cli.start_pipe", side_effect=refused_start)
        result = runner.invoke(app, ["detached", "extract-entities", "some text"])
        assert result.exit_code == 1
        # No run was created, so nothing reaches stdout for `$(widget detached …)` to capture as an id.
        assert result.stdout == ""
        output = " ".join(result.output.split())
        assert "The API answered 422 Unprocessable Entity." in output
        assert "Reason: Validate bundle — Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found" in output
        assert "Pipe: draft_pitch" in output
        assert "Next step: Edit the bundle as each validation error says" in output

    def test_wait_prints_the_raw_main_stuff(self, mocker: MockerFixture):
        attend_mock = mocker.patch("widget.detached.cli.attend_run", return_value=_results(ENTITIES_CONTENT))
        result = runner.invoke(app, ["detached", "wait", RUN_ID])
        assert result.exit_code == 0
        attend_mock.assert_awaited_once_with(RUN_ID)
        assert "Marie Curie" in result.output

    def test_wait_brings_down_the_files_the_run_produced(self, mocker: MockerFixture, stub_download: str):
        # Collection time is where detached downloads, and `wait` and `result` share the renderer —
        # so a run that produced a file hands it over here rather than at start.
        mocker.patch("widget.detached.cli.attend_run", return_value=_results(IMAGE_CONTENT))
        result = runner.invoke(app, ["detached", "wait", RUN_ID])
        assert result.exit_code == 0
        assert stub_download in result.output

    def test_status_reports_the_run_status(self, mocker: MockerFixture):
        # The platform records the pipe_code the run was started with, which the demos send qualified.
        run = RunRead(
            pipeline_run_id=RUN_ID, pipe_code="extract_entities.extract_entities", status=RunStatus.RUNNING, created_at="2026-07-13T10:00:00Z"
        )
        mocker.patch("widget.detached.cli.fetch_run_status", return_value=run)
        result = runner.invoke(app, ["detached", "status", RUN_ID])
        assert result.exit_code == 0
        assert RUN_ID in result.output
        assert "RUNNING" in result.output
        assert "extract_entities.extract_entities" in result.output

    def test_status_flags_a_degraded_reading(self, mocker: MockerFixture):
        run = RunRead(pipeline_run_id=RUN_ID, status=RunStatus.RUNNING, created_at="2026-07-13T10:00:00Z", degraded=True)
        mocker.patch("widget.detached.cli.fetch_run_status", return_value=run)
        result = runner.invoke(app, ["detached", "status", RUN_ID])
        assert result.exit_code == 0
        assert "degraded" in result.output

    def test_result_hints_at_wait_while_the_run_is_running(self, mocker: MockerFixture):
        mocker.patch("widget.detached.cli.fetch_run_result", return_value=RunResultRunning(pipeline_run_id=RUN_ID))
        result = runner.invoke(app, ["detached", "result", RUN_ID])
        assert result.exit_code == 0
        # rich wraps the hint at the console width, and the project name is not fixed:
        # a bootstrapped project's is longer than the placeholder, which pushed the wrap
        # into the middle of the command. What matters is that the hint names the
        # command, not where the console happened to break the line.
        assert "widget detached wait" in " ".join(result.output.split())

    def test_result_prints_the_raw_main_stuff_when_completed(self, mocker: MockerFixture):
        completed = RunResultCompleted(pipeline_run_id=RUN_ID, result=_results(ENTITIES_CONTENT))
        mocker.patch("widget.detached.cli.fetch_run_result", return_value=completed)
        result = runner.invoke(app, ["detached", "result", RUN_ID])
        assert result.exit_code == 0
        assert "Marie Curie" in result.output

    def test_result_exits_non_zero_when_the_run_failed(self, mocker: MockerFixture):
        failed = RunResultFailed(pipeline_run_id=RUN_ID, status=RunStatus.FAILED, message="the pipe blew up")
        mocker.patch("widget.detached.cli.fetch_run_result", return_value=failed)
        result = runner.invoke(app, ["detached", "result", RUN_ID])
        assert result.exit_code == 1
        assert "the pipe blew up" in result.output

    def test_result_of_a_failed_run_reads_out_its_stored_report(self, mocker: MockerFixture):
        failed = RunResultFailed(pipeline_run_id=RUN_ID, status=RunStatus.FAILED, message=REPORTED_DETAIL, error=MODEL_REPORT)
        mocker.patch("widget.detached.cli.fetch_run_result", return_value=failed)
        result = runner.invoke(app, ["detached", "result", RUN_ID])
        assert result.exit_code == 1
        _assert_reads_out_the_report(result.output)

    def test_wait_on_a_failed_run_reads_out_its_stored_report(self, mocker: MockerFixture):
        error = RunFailedError(REPORTED_DETAIL, run_id=RUN_ID, status=RunStatus.FAILED, error=MODEL_REPORT)
        mocker.patch("widget.detached.cli.attend_run", side_effect=error)
        result = runner.invoke(app, ["detached", "wait", RUN_ID])
        assert result.exit_code == 1
        _assert_reads_out_the_report(result.output)

    def test_status_of_a_failed_run_reads_out_its_stored_report(self, mocker: MockerFixture):
        run = RunRead(pipeline_run_id=RUN_ID, status=RunStatus.FAILED, created_at="2026-07-13T10:00:00Z", error=MODEL_REPORT)
        mocker.patch("widget.detached.cli.fetch_run_status", return_value=run)
        result = runner.invoke(app, ["detached", "status", RUN_ID])
        assert result.exit_code == 0
        assert "FAILED" in result.stdout
        # The report is what the status read answered, so it is the command's output: stdout.
        _assert_reads_out_the_report(result.stdout)

    def test_status_of_a_failed_run_without_a_report_says_no_reason_was_recorded(self, mocker: MockerFixture):
        run = RunRead(pipeline_run_id=RUN_ID, status=RunStatus.FAILED, created_at="2026-07-13T10:00:00Z")
        mocker.patch("widget.detached.cli.fetch_run_status", return_value=run)
        result = runner.invoke(app, ["detached", "status", RUN_ID])
        assert result.exit_code == 0
        output = " ".join(result.output.split())
        assert "No reason was recorded for this run." in output
        assert "support" in output

    def test_status_of_a_cancelled_run_without_a_report_says_to_start_again(self, mocker: MockerFixture):
        run = RunRead(pipeline_run_id=RUN_ID, status=RunStatus.CANCELLED, created_at="2026-07-13T10:00:00Z")
        mocker.patch("widget.detached.cli.fetch_run_status", return_value=run)
        result = runner.invoke(app, ["detached", "status", RUN_ID])
        assert result.exit_code == 0
        output = " ".join(result.output.split())
        assert "No reason was recorded for this run." in output
        assert "start it again" in output.lower()

    def test_status_of_a_run_in_flight_says_nothing_about_a_reason(self, mocker: MockerFixture):
        run = RunRead(pipeline_run_id=RUN_ID, status=RunStatus.RUNNING, created_at="2026-07-13T10:00:00Z")
        mocker.patch("widget.detached.cli.fetch_run_status", return_value=run)
        result = runner.invoke(app, ["detached", "status", RUN_ID])
        assert result.exit_code == 0
        assert "reason" not in result.output.lower()
        assert "Hint" not in result.output


def _assert_reads_out_the_report(output: str) -> None:
    """The report's title and message, its next step and its retry advice, whatever the console wrapped."""
    flattened = " ".join(output.split())
    assert "Reason: LLM completion — The model refused the request." in flattened
    assert "Next step: Rephrase the prompt, or pick another model." in flattened
    assert "Retry: running it again may succeed." in flattened
