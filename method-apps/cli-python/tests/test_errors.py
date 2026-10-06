"""`lib/errors.py`: what a person reads on stderr when the command fails.

Carried from the Python starter's error presentation, with the hints renamed for the flags of a
one-command CLI: a gateway cut-off names dropping `--blocking`, a server with no run store names
adding it, and a run still going names `--resume`.
"""

import io

import pytest
from mthds.runners.api.problem import UserAction as ProblemUserAction
from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult
from pipelex_sdk.error_models import RunErrorReport, UserAction
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    ArtifactAuthenticationError,
    ArtifactOperationError,
    InvalidLocalSourceError,
    PipelineExecuteTimeoutError,
    RejectedAssetError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunTimeoutError,
    UnsupportedUploadCapabilityError,
    UploadAuthenticationError,
)
from pipelex_sdk.runs import RunStatus
from pipelex_sdk.validation_models import ValidationErrorCategory, ValidationErrorItem
from rich.console import Console

from pipelex_method_cli_python.lib.app import COMMAND_NAME, AppError, RunMode
from pipelex_method_cli_python.lib.errors import ErrorPresentation, present_error, print_error, problem_lines, report_lines

# A failed run's stored report as the runner writes it for an inference failure, and the platform's
# sentence about the run with and without one (`Run finished with status <STATUS>: <message>`).
MODEL_REPORT = RunErrorReport(
    error_type="LLMCompletionError",
    title="LLM completion",
    message="The model refused the request.",
    error_domain="runtime",
    retryable=True,
    user_action=UserAction(kind="change_input", detail="Rephrase the prompt, or pick another model."),
)
REPORTED_DETAIL = "Run finished with status FAILED: The model refused the request."
UNREPORTED_DETAIL = "Run finished with status FAILED; no result available"


def _api_response_error(
    status: int,
    status_text: str,
    *,
    title: str | None = None,
    detail: str | None = None,
    error_type: str | None = None,
    code: str | None = None,
    user_action: ProblemUserAction | None = None,
    retryable: bool | None = None,
    validation_errors: list[ValidationErrorItem] | None = None,
) -> ApiResponseError:
    """A non-2xx answer as the SDK raises it, carrying only the problem members a test names."""
    return ApiResponseError(
        f"API POST /v1/start failed ({status}): {detail or title or status_text}",
        api_url="https://api.pipelex.com",
        status=status,
        status_text=status_text,
        response_body="",
        title=title,
        server_message=detail,
        error_type=error_type,
        code=code,
        user_action=user_action,
        retryable=retryable,
        validation_errors=validation_errors,
    )


def _item(message: str, *, pipe_code: str | None = None, concept_code: str | None = None) -> ValidationErrorItem:
    return ValidationErrorItem(category=ValidationErrorCategory.PIPE_VALIDATION, message=message, pipe_code=pipe_code, concept_code=concept_code)


class TestPresentError:
    def test_an_app_error_is_its_own_message_and_hint(self):
        presentation = present_error(AppError("PIPELEX_API_KEY is not set.", hint="Set it."))
        assert presentation == ErrorPresentation(message="PIPELEX_API_KEY is not set.", hint="Set it.")

    def test_execute_timeout_says_to_drop_blocking(self):
        presentation = present_error(PipelineExecuteTimeoutError("timed out", elapsed_seconds=31.2), mode=RunMode.BLOCKING)
        assert "~30s" in presentation.message
        assert presentation.hint is not None
        assert "without --blocking" in presentation.hint

    def test_lifecycle_unavailable_names_blocking(self):
        presentation = present_error(RunLifecycleUnavailableError("no run store", api_url="http://localhost:8081"), mode=RunMode.ATTENDED)
        assert "http://localhost:8081" in presentation.message
        assert presentation.hint is not None
        assert "--blocking" in presentation.hint

    def test_lifecycle_unavailable_on_resume_says_there_is_nothing_to_resume(self):
        presentation = present_error(RunLifecycleUnavailableError("no run store", api_url="http://localhost:8081"), mode=RunMode.RESUME)
        assert presentation.hint is not None
        assert "resumed" in presentation.hint
        assert "--blocking" in presentation.hint

    def test_a_refused_start_reads_out_the_reason_the_pipe_the_next_step_and_the_retry_advice(self, refused_start: ApiResponseError):
        # Every route raises the typed error, so a method the plane will not run says why, where and what to do.
        presentation = present_error(refused_start, mode=RunMode.ATTENDED)
        assert presentation.message == "The API answered 422 Unprocessable Entity."
        assert presentation.details == (
            "Reason: Validate bundle — Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck"
            "\n\nDid you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna",
            # The item's message is the reason's detail verbatim, so only where it is is added.
            "Pipe: draft_pitch",
            "Next step: Edit the bundle as each validation error says: apply its suggested fix where it has one, after confirming an unsafe one",
            "Retry: running it again will fail the same way until the cause is fixed.",
        )
        # The next step is the advice, so no hint competes with it.
        assert presentation.hint is None

    def test_an_auth_refusal_hints_api_key_and_keeps_the_reason(self):
        for status, status_text in ((401, "Unauthorized"), (403, "Forbidden")):
            presentation = present_error(_api_response_error(status, status_text, detail="This key may not use the route."))
            assert presentation.message == f"The API rejected the request ({status} {status_text})."
            assert presentation.details == ("Reason: This key may not use the route.",)
            assert presentation.hint is not None
            assert "PIPELEX_API_KEY" in presentation.hint

    def test_a_server_error_has_no_hint(self):
        presentation = present_error(_api_response_error(500, "Internal Server Error", title="Internal error"))
        assert presentation.details == ("Reason: Internal error",)
        assert presentation.hint is None

    def test_start_without_async_orchestration_names_blocking(self):
        detail = "Orchestration mode 'direct' cannot honor fire-and-forget delivery. Use /execute instead."
        presentation = present_error(_api_response_error(400, "Bad Request", detail=detail, error_type="StartRequiresAsyncOrchestration"))
        assert presentation.message == detail
        assert presentation.hint is not None
        assert "--blocking" in presentation.hint

    @pytest.mark.parametrize(("status", "status_text"), [(502, "Bad Gateway"), (504, "Gateway Timeout")])
    def test_a_gateway_status_on_the_blocking_path_says_to_drop_the_flag(self, status: int, status_text: str):
        presentation = present_error(_api_response_error(status, status_text), mode=RunMode.BLOCKING)
        assert presentation.hint is not None
        assert "without --blocking" in presentation.hint

    def test_a_gateway_status_off_the_blocking_path_has_no_hint(self):
        # On the durable path a 502 is the platform's own trouble, not the blocking cut-off.
        presentation = present_error(_api_response_error(502, "Bad Gateway"), mode=RunMode.ATTENDED)
        assert presentation.hint is None

    def test_an_answer_without_a_problem_document_names_the_status(self):
        presentation = present_error(_api_response_error(502, "Bad Gateway"))
        assert presentation.message == "The API answered 502 Bad Gateway."
        assert presentation.details == ()
        assert presentation.hint is None

    def test_unreachable_hints_base_url(self):
        presentation = present_error(ApiUnreachableError("connect failed", api_url="http://nowhere.invalid"))
        assert "http://nowhere.invalid" in presentation.message
        assert presentation.hint is not None
        assert "PIPELEX_BASE_URL" in presentation.hint

    def test_run_failed_reads_out_the_stored_report(self):
        presentation = present_error(RunFailedError(REPORTED_DETAIL, run_id="run-9", status=RunStatus.FAILED, error=MODEL_REPORT))
        assert presentation.message == "Run run-9 failed."
        assert presentation.details == (
            "Reason: LLM completion — The model refused the request.",
            "Next step: Rephrase the prompt, or pick another model.",
            "Retry: running it again may succeed.",
        )
        assert presentation.hint is None

    def test_run_failed_without_a_stored_report_still_says_what_happened(self):
        presentation = present_error(RunFailedError(UNREPORTED_DETAIL, run_id="run-9", status=RunStatus.FAILED))
        assert presentation.message == "Run run-9 failed, and no reason was recorded for it."
        # The platform's own sentence is kept: on a refused stored result it is the only thing that says what happened.
        assert presentation.details == (f"The platform said: {UNREPORTED_DETAIL}",)
        assert presentation.hint is not None
        assert "support" in presentation.hint
        assert "run-9" in presentation.hint

    def test_a_cancelled_run_without_a_report_is_told_to_start_again(self):
        presentation = present_error(
            RunFailedError("Run finished with status CANCELLED; no result available", run_id="run-9", status=RunStatus.CANCELLED)
        )
        assert presentation.message == "Run run-9 was cancelled, and no reason was recorded for it."
        assert presentation.hint is not None
        assert "start it again" in presentation.hint.lower()

    def test_a_report_carrying_nothing_to_read_out_is_treated_as_no_report(self):
        presentation = present_error(RunFailedError(UNREPORTED_DETAIL, run_id="run-9", status=RunStatus.TIMED_OUT, error=RunErrorReport()))
        assert presentation.message == "Run run-9 timed out, and no reason was recorded for it."
        assert presentation.details == (f"The platform said: {UNREPORTED_DETAIL}",)

    def test_run_timeout_names_resume(self):
        presentation = present_error(RunTimeoutError("too slow", run_id="run-9", timeout_seconds=1200.0))
        assert presentation.hint is not None
        assert f"{COMMAND_NAME} --resume run-9" in presentation.hint

    def test_unsupported_upload_capability_hints_the_hosted_api(self):
        presentation = present_error(UnsupportedUploadCapabilityError("no /v1/upload route here"))
        assert "no /v1/upload route here" in presentation.message
        assert presentation.hint is not None
        assert "PIPELEX_BASE_URL" in presentation.hint

    def test_upload_authentication_hints_api_key(self):
        presentation = present_error(UploadAuthenticationError("not authorized (401)", status=401))
        assert presentation.hint is not None
        assert "PIPELEX_API_KEY" in presentation.hint

    def test_rejected_asset_hints_a_smaller_file(self):
        presentation = present_error(RejectedAssetError("too large", filename="huge.pdf", status=413))
        assert presentation.hint is not None
        assert "smaller" in presentation.hint

    def test_invalid_local_source_hints_the_path(self):
        presentation = present_error(InvalidLocalSourceError("cannot read", source="/nope.pdf"))
        assert presentation.hint is not None
        assert "path" in presentation.hint

    def test_artifact_authentication_hints_api_key(self):
        verdict = DownloadArtifactsResult(scope=ArtifactScope.MAIN_STUFF, all_saved=False)
        presentation = present_error(ArtifactAuthenticationError("not authorized (401)", status=401, verdict=verdict))
        assert presentation.hint is not None
        assert "PIPELEX_API_KEY" in presentation.hint

    def test_artifact_operation_hints_the_download_directory_without_saying_rerun(self):
        presentation = present_error(ArtifactOperationError("outputs/ is a file"))
        assert "outputs/ is a file" in presentation.message
        assert presentation.hint is not None
        assert "download directory" in presentation.hint
        # The run itself succeeded: a hint that sent the reader back to rerun it would cost them.
        assert "rerun" not in presentation.hint.lower()

    @pytest.mark.parametrize(
        ("report", "expected_lines"),
        [
            pytest.param(None, (), id="no report"),
            pytest.param(RunErrorReport(message="The input 'text' is empty."), ("Reason: The input 'text' is empty.",), id="message alone"),
            pytest.param(RunErrorReport(title="LLM completion"), ("Reason: LLM completion",), id="title alone"),
            pytest.param(RunErrorReport(error_type="SandboxProvisioningError"), ("Reason: SandboxProvisioningError",), id="class as last resort"),
            pytest.param(
                RunErrorReport(message="Rate limited.", user_action=UserAction(kind="wait_and_retry")),
                ("Reason: Rate limited.", "Next step: Wait a moment, then run it again."),
                id="kind speaks without detail",
            ),
            pytest.param(
                RunErrorReport(message="Something broke.", user_action=UserAction(kind="unknown")),
                ("Reason: Something broke.",),
                id="unknown kind without detail",
            ),
            pytest.param(
                RunErrorReport(message="The model does not exist.", retryable=False),
                ("Reason: The model does not exist.", "Retry: running it again will fail the same way until the cause is fixed."),
                id="not retryable",
            ),
            # `None` means the runner does not know, never "no", so nothing is claimed either way.
            pytest.param(RunErrorReport(message="Something broke."), ("Reason: Something broke.",), id="retry advice unknown"),
        ],
    )
    def test_report_lines_read_out_what_the_report_carries(self, report: RunErrorReport | None, expected_lines: tuple[str, ...]):
        assert report_lines(report) == expected_lines

    @pytest.mark.parametrize(
        ("exc", "expected_lines"),
        [
            pytest.param(
                _api_response_error(400, "Bad Request", title="Bad input", detail="Missing required input 'text'."),
                ("Reason: Bad input — Missing required input 'text'.",),
                id="title and detail",
            ),
            pytest.param(
                _api_response_error(404, "Not Found", error_type="PackageNotFoundError"), ("Reason: PackageNotFoundError",), id="runner class"
            ),
            pytest.param(_api_response_error(409, "Conflict", code="conflict"), ("Reason: conflict",), id="platform code"),
            pytest.param(
                _api_response_error(
                    422,
                    "Unprocessable Entity",
                    title="Validate bundle",
                    detail="The method is invalid.",
                    validation_errors=[
                        _item("Model handle 'gpt-5.1' was not found.", pipe_code="draft_pitch"),
                        _item("Field 'ideas' is not a list.", concept_code="TopicReview"),
                        _item("The bundle declares no domain."),
                    ],
                ),
                (
                    "Reason: Validate bundle — The method is invalid.",
                    "In pipe draft_pitch: Model handle 'gpt-5.1' was not found.",
                    "In concept TopicReview: Field 'ideas' is not a list.",
                    "Problem: The bundle declares no domain.",
                ),
                id="items saying more than the reason",
            ),
            pytest.param(
                _api_response_error(
                    422,
                    "Unprocessable Entity",
                    validation_errors=[_item("Model handle 'gpt-5.1' was not found.", pipe_code="draft_pitch")],
                    user_action=ProblemUserAction(kind="change_input", detail="Fix the bundle."),
                ),
                ("In pipe draft_pitch: Model handle 'gpt-5.1' was not found.", "Next step: Fix the bundle."),
                id="items without a reason",
            ),
            pytest.param(
                _api_response_error(
                    422,
                    "Unprocessable Entity",
                    detail="First. Second.",
                    validation_errors=[_item("First.", pipe_code="a"), _item("Second.", concept_code="B"), _item("Second.")],
                ),
                ("Reason: First. Second.", "Pipe: a", "Concept: B"),
                id="items the reason already says",
            ),
            pytest.param(
                _api_response_error(429, "Too Many Requests", detail="Slow down.", retryable=True),
                ("Reason: Slow down.", "Retry: running it again may succeed."),
                id="retryable",
            ),
        ],
    )
    def test_problem_lines_read_out_what_the_problem_carries(self, exc: ApiResponseError, expected_lines: tuple[str, ...]):
        assert problem_lines(exc) == expected_lines


class TestPrintError:
    def test_prints_the_message_the_details_and_the_hint(self):
        buffer = io.StringIO()
        print_error(Console(file=buffer, width=200), ErrorPresentation(message="Run run-9 failed.", hint="Do this.", details=("Reason: it broke.",)))
        rendered = buffer.getvalue()
        assert "Error: Run run-9 failed." in rendered
        assert "Reason: it broke." in rendered
        assert "Hint: Do this." in rendered

    def test_hangs_a_multi_line_detail_under_its_label(self):
        # A refused method's reason ends with a blank line and the model names it suggests instead; at
        # the margin, that suggestion would read as a line of its own.
        buffer = io.StringIO()
        print_error(
            Console(file=buffer, width=200),
            ErrorPresentation(message="Refused.", hint=None, details=("Reason: Unknown model.\n\nDid you mean: gpt-5?",)),
        )
        assert buffer.getvalue() == "Error: Refused.\n  Reason: Unknown model.\n\n    Did you mean: gpt-5?\n"

    def test_prints_server_text_verbatim_rather_than_as_markup(self):
        # A report's message is the runner's text: a bracketed span in it must neither vanish as a
        # style tag nor crash the print as an unmatched closing tag.
        buffer = io.StringIO()
        presentation = ErrorPresentation(message="Bad value [x] in [/y].", hint=None, details=("Reason: list [1, 2] [bold]",))
        print_error(Console(file=buffer, width=200), presentation)
        rendered = buffer.getvalue()
        assert "Bad value [x] in [/y]." in rendered
        assert "Reason: list [1, 2] [bold]" in rendered
