"""`lib/errors.py`: what a person reads on stderr when the command fails.

Carried from the Python starter's error presentation, with the hints renamed for the flags of a
one-command CLI: a gateway cut-off names dropping `--blocking`, a server with no run store names
adding it, and a run still going names `--resume`. Every error is built the way the SDK raises it:
an answer the API refused carries the problem document it sent, a bare answer is left to the SDK's
reading of its status, and a failed run carries `run.failed` with the run's own problem nested in it.
"""

import io
import json
from typing import Any

import pytest
from mthds.protocol.problem.models import Problem
from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    ArtifactAuthenticationError,
    ArtifactOperationError,
    InvalidLocalSourceError,
    PipelineExecuteTimeoutError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunTimeoutError,
    UnsupportedUploadCapabilityError,
    UploadAuthenticationError,
    run_failed_problem,
)
from pipelex_sdk.runs import RunStatus
from rich.console import Console

from pipelex_method_cli_python.lib.app import COMMAND_NAME, AppError, RunMode
from pipelex_method_cli_python.lib.errors import ErrorPresentation, present_error, print_error, problem_lines

RETRY_NO = "Retry: running it again unchanged will fail the same way."
RETRY_YES = "Retry: running it again can succeed."
RETRY_UNKNOWN = "Retry: the run may already have started, so look it up by its id before running it again, or it is paid for twice."
WHO_ACTS_METHOD = "Who acts: whoever authors the method, by changing it."
WHO_ACTS_RUNTIME = "Who acts: nobody on your side: the service failed, and nothing you sent caused it."

#: A failed run's own problem, as the runtime stores it for content the provider refused.
MODEL_REFUSAL: dict[str, Any] = {
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
    "location": {"pipe": "draft_pitch"},
}


def _problem(**members: Any) -> Problem:
    """A problem document as the API sends one, with the members a test does not name filled in."""
    document: dict[str, Any] = {
        "type": "https://mthds.ai/errors/runtime.unexpected",
        "title": "An unexpected error occurred",
        "detail": "The runtime met an unexpected error.",
        "code": "runtime.unexpected",
        "domain": "runtime",
        "retry": "no",
        "next_step": {"kind": "report", "detail": "Report this to whoever runs the runtime."},
    }
    document.update(members)
    return Problem.model_validate(document)


def _refusal(status: int, status_text: str, problem: Problem | None = None, *, may_start_run: bool = False) -> ApiResponseError:
    """An answer the API refused, as the SDK raises it: with the problem document it sent, or with none, read by its status."""
    body = json.dumps(problem.as_wire()) if problem is not None else ""
    return ApiResponseError(
        f"API POST /v1/start failed ({status})",
        api_url="https://api.pipelex.com",
        status=status,
        status_text=status_text,
        response_body=body,
        problem=problem,
        may_start_run=may_start_run,
    )


def _failed_run(status: RunStatus, run_error: dict[str, Any] | None = None) -> RunFailedError:
    """A run that ended without a result, as `wait_for_result` raises it: `run.failed`, with the run's own problem nested."""
    nested = Problem.model_validate(run_error) if run_error is not None else None
    return RunFailedError(
        f"Run finished with status {status}",
        run_id="run-9",
        status=status,
        problem=run_failed_problem(run_id="run-9", status=status, run_error=nested),
    )


class TestPresentError:
    def test_an_app_error_is_its_own_message_and_hint(self):
        presentation = present_error(AppError("PIPELEX_API_KEY is not set.", hint="Set it."))
        assert presentation == ErrorPresentation(message="PIPELEX_API_KEY is not set.", hint="Set it.")

    def test_execute_timeout_says_to_drop_blocking(self):
        presentation = present_error(PipelineExecuteTimeoutError("timed out", elapsed_seconds=31.2), mode=RunMode.BLOCKING)
        assert "after 31s" in presentation.message
        assert "about 30 seconds" in presentation.message
        assert presentation.hint is not None
        assert "without --blocking" in presentation.hint
        # The run may have started, so the retry line says to look it up rather than pay for it twice.
        assert RETRY_UNKNOWN in presentation.details

    @pytest.mark.parametrize(("status", "status_text"), [(502, "Bad Gateway"), (504, "Gateway Timeout")])
    def test_a_gateway_cut_off_of_a_blocking_run_says_to_drop_the_flag(self, status: int, status_text: str):
        # A bare 502 or 504 on a request that creates a run is `client.outcome_unknown` in the SDK's reading.
        presentation = present_error(_refusal(status, status_text, may_start_run=True), mode=RunMode.BLOCKING)
        assert presentation.hint is not None
        assert "without --blocking" in presentation.hint

    def test_a_start_whose_outcome_is_unknown_says_where_to_look_for_the_run(self):
        presentation = present_error(_refusal(502, "Bad Gateway", may_start_run=True), mode=RunMode.ATTENDED)
        assert presentation.message == "The API answered 502 Bad Gateway."
        assert presentation.hint is not None
        assert "run history" in presentation.hint
        assert RETRY_UNKNOWN in presentation.details

    def test_a_server_fault_on_a_read_can_be_retried_and_has_no_hint(self):
        presentation = present_error(_refusal(502, "Bad Gateway"))
        assert presentation.message == "The API answered 502 Bad Gateway."
        assert presentation.details == (
            "Reason: The runtime or a service it depends on is unavailable — The runtime, or a service it depends on, is unavailable.",
            WHO_ACTS_RUNTIME,
            # A step to retry is the retry line's to say, so no next step repeats it.
            RETRY_YES,
            "For support: runtime.unavailable",
        )
        assert presentation.hint is None

    def test_a_retry_after_is_named_on_the_retry_line(self):
        presentation = present_error(
            ApiResponseError(
                "API GET /v1/runs/run-9 failed (429)",
                api_url="https://api.pipelex.com",
                status=429,
                status_text="Too Many Requests",
                response_body="",
                headers={"retry-after": "7"},
            )
        )
        assert "Retry: running it again can succeed in 7 seconds." in presentation.details

    def test_lifecycle_unavailable_names_blocking(self):
        presentation = present_error(RunLifecycleUnavailableError("no run store", api_url="http://localhost:8081"), mode=RunMode.ATTENDED)
        assert presentation.message == "The server at http://localhost:8081 does not run durable runs."
        assert presentation.hint is not None
        assert "--blocking" in presentation.hint

    def test_lifecycle_unavailable_on_detach_says_to_drop_the_flag(self):
        # A blocking run cannot be detached, and `--detach --blocking` is refused.
        presentation = present_error(RunLifecycleUnavailableError("no run store", api_url="http://localhost:8081"), mode=RunMode.DETACH)
        assert presentation.hint is not None
        assert "drop --detach" in presentation.hint

    def test_lifecycle_unavailable_on_resume_says_there_is_nothing_to_resume(self):
        presentation = present_error(RunLifecycleUnavailableError("no run store", api_url="http://localhost:8081"), mode=RunMode.RESUME)
        assert presentation.hint is not None
        assert "resumed" in presentation.hint
        assert "--blocking" in presentation.hint

    @pytest.mark.parametrize("mode", [RunMode.ATTENDED, RunMode.DETACH])
    def test_a_runner_without_asynchronous_execution_names_blocking(self, mode: RunMode):
        # The runner's refusal of a `/start` in its synchronous orchestration: `runtime.unsupported`, naming the capability.
        problem = _problem(
            type="https://mthds.ai/errors/runtime.unsupported",
            title="This runtime cannot do what was asked",
            detail="Asynchronous pipeline execution is not enabled on this deployment.",
            code="runtime.unsupported",
            domain="operator",
            params={"capability": "asynchronous execution"},
            next_step={"kind": "change_input", "detail": "Send a request that does not need asynchronous execution."},
        )
        presentation = present_error(_refusal(501, "Not Implemented", problem), mode=mode)
        assert presentation.message == "The server at https://api.pipelex.com does not run durable runs."
        assert presentation.hint is not None
        assert "--blocking" in presentation.hint
        assert ("drop --detach" in presentation.hint) is (mode is RunMode.DETACH)
        assert (
            "Reason: This runtime cannot do what was asked — Asynchronous pipeline execution is not enabled on this deployment."
            in presentation.details
        )

    def test_a_refused_start_reads_out_the_reason_the_fault_who_acts_the_next_step_and_the_support_line(self, refused_start: ApiResponseError):
        # Every route raises the typed error, so a method the plane will not run says why, where and what to do.
        presentation = present_error(refused_start, mode=RunMode.ATTENDED)
        assert presentation.message == "The API answered 422 Unprocessable Entity."
        assert presentation.details == (
            "Reason: The method does not validate.",
            "In pipe draft_pitch, field model: Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck"
            "\n\nDid you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna",
            WHO_ACTS_METHOD,
            "Next step: Fix each fault the problem's errors list, then validate the method again.",
            RETRY_NO,
            "For support: method.invalid · request req_a3dd6900-7909-48d3-b551-0140e73ac7fc",
        )
        # The next step is the advice, so no hint competes with it.
        assert presentation.hint is None

    @pytest.mark.parametrize(("status", "status_text"), [(401, "Unauthorized"), (403, "Forbidden")])
    def test_a_bare_credential_refusal_hints_the_api_key(self, status: int, status_text: str):
        presentation = present_error(_refusal(status, status_text))
        assert presentation.message == f"The API answered {status} {status_text}."
        assert "Who acts: whoever owns the account, by changing a credential, a plan or a role." in presentation.details
        assert presentation.hint is not None
        assert "PIPELEX_API_KEY" in presentation.hint

    def test_the_api_s_own_credential_refusal_hints_the_api_key(self):
        problem = _problem(
            title="The credential was refused",
            detail="The API key is not valid.",
            code="auth.invalid_credential",
            domain="account",
            next_step={"kind": "check_credentials", "detail": "Check the API key the request sends."},
            request_id="req_1",
        )
        presentation = present_error(_refusal(401, "Unauthorized", problem))
        assert presentation.hint is not None
        assert "PIPELEX_API_KEY" in presentation.hint
        assert "Next step: Check the API key the request sends." in presentation.details
        assert "For support: auth.invalid_credential · request req_1" in presentation.details

    def test_unreachable_hints_base_url(self):
        presentation = present_error(ApiUnreachableError("connect failed", api_url="http://nowhere.invalid"))
        assert presentation.message == "Could not reach the Pipelex API at http://nowhere.invalid."
        assert presentation.hint is not None
        assert "PIPELEX_BASE_URL" in presentation.hint
        assert RETRY_YES in presentation.details

    def test_a_wait_that_gave_up_says_how_to_wait_again(self):
        presentation = present_error(RunTimeoutError("too slow", run_id="run-9", timeout_seconds=1200.0))
        assert presentation.hint == f"Wait for the run with `{COMMAND_NAME} --resume run-9` rather than start it again."
        assert "For support: run run-9 · client.follow_failed" in presentation.details

    def test_run_failed_reads_out_the_run_s_own_problem(self):
        presentation = present_error(_failed_run(RunStatus.FAILED, MODEL_REFUSAL))
        assert presentation.message == "Run run-9 failed."
        assert presentation.details == (
            "Reason: The provider refused the content — The model 'gpt-5.5' or its provider refused the request's content on policy grounds.",
            "Who acts: you, by changing the inputs or the request.",
            "Next step: Change the inputs so that they meet the provider's content policy, then send the request again.",
            RETRY_NO,
            # The run's problem names no run, so the failed run's id is quoted for it.
            "For support: run run-9 · model.content_refused",
        )
        assert presentation.hint is None

    def test_a_cancelled_run_s_problem_says_it_can_be_run_again(self):
        cancelled = {
            "type": "https://mthds.ai/errors/run.cancelled",
            "title": "The run was cancelled",
            "detail": "The run was cancelled by its caller before it ended.",
            "code": "run.cancelled",
            "domain": "input",
            "retry": "yes",
            "next_step": {"kind": "retry", "detail": "Start the run again."},
        }
        presentation = present_error(_failed_run(RunStatus.CANCELLED, cancelled))
        assert presentation.message == "Run run-9 was cancelled."
        assert RETRY_YES in presentation.details

    def test_run_failed_without_a_problem_still_says_what_happened(self):
        presentation = present_error(_failed_run(RunStatus.FAILED))
        assert presentation.message == "Run run-9 failed, and no reason was recorded for it."
        # The platform's own sentence is kept: with no problem stored it is the only thing that says what happened.
        assert presentation.details == ("The platform said: The run 'run-9' ended as 'FAILED', without success.",)
        assert presentation.hint is not None
        assert "support" in presentation.hint
        assert "run-9" in presentation.hint

    def test_a_cancelled_run_without_a_problem_is_told_to_start_again(self):
        presentation = present_error(_failed_run(RunStatus.CANCELLED))
        assert presentation.message == "Run run-9 was cancelled, and no reason was recorded for it."
        assert presentation.hint is not None
        assert "start it again" in presentation.hint.lower()

    def test_unsupported_upload_capability_hints_the_hosted_api(self):
        presentation = present_error(UnsupportedUploadCapabilityError("no /v1/upload route here"))
        assert presentation.message == "no /v1/upload route here"
        assert presentation.hint is not None
        assert "PIPELEX_BASE_URL" in presentation.hint

    def test_upload_authentication_hints_api_key(self):
        presentation = present_error(UploadAuthenticationError("not authorized (401)", status=401))
        assert presentation.hint is not None
        assert "PIPELEX_API_KEY" in presentation.hint

    def test_an_unreadable_local_file_says_what_to_change(self):
        presentation = present_error(InvalidLocalSourceError("cannot read", source="/nope.pdf"))
        assert presentation.message == "cannot read"
        assert "Next step: Give a readable file as the input '/nope.pdf', then send the request again." in presentation.details
        assert presentation.hint is None

    def test_artifact_authentication_hints_api_key(self):
        verdict = DownloadArtifactsResult(scope=ArtifactScope.MAIN_STUFF, all_saved=False)
        presentation = present_error(ArtifactAuthenticationError("not authorized (401)", status=401, verdict=verdict))
        assert presentation.hint is not None
        assert "PIPELEX_API_KEY" in presentation.hint

    def test_an_artifact_failure_never_says_to_run_the_method_again(self):
        presentation = present_error(ArtifactOperationError("outputs/ is a file"))
        assert presentation.message == "outputs/ is a file"
        assert presentation.hint is not None
        # The run itself succeeded: a hint that sent the reader back to run it again would cost them.
        assert "no need to run the method again" in presentation.hint

    @pytest.mark.parametrize(
        ("problem", "expected_lines"),
        [
            pytest.param(
                _problem(
                    title="Bad input",
                    detail="Missing required input 'text'.",
                    code="input.missing",
                    domain="input",
                    next_step={"kind": "change_input", "detail": "Give it."},
                ),
                (
                    "Reason: Bad input — Missing required input 'text'.",
                    "Who acts: you, by changing the inputs or the request.",
                    "Next step: Give it.",
                    RETRY_NO,
                    "For support: input.missing",
                ),
                id="title and detail",
            ),
            pytest.param(
                _problem(
                    title="The method does not validate",
                    detail="The method does not validate.",
                    code="method.invalid",
                    domain="method",
                    next_step={"kind": "change_method", "detail": "Fix each fault."},
                    errors=[
                        {"code": "model.unknown", "detail": "Model handle 'gpt-5.1' was not found.", "location": {"pipe": "draft_pitch"}},
                        {"code": "method.syntax", "detail": "Unexpected token.", "location": {"file": "main.mthds", "line": 3}},
                        {"code": "method.concept_unresolved", "detail": "No concept 'Topic'.", "suggestions": ["Topics"]},
                    ],
                ),
                (
                    "Reason: The method does not validate.",
                    "In pipe draft_pitch: Model handle 'gpt-5.1' was not found.",
                    "In main.mthds:3: Unexpected token.",
                    "Fault: No concept 'Topic'. (did you mean: Topics)",
                    WHO_ACTS_METHOD,
                    "Next step: Fix each fault.",
                    RETRY_NO,
                    "For support: method.invalid",
                ),
                id="faults with their location",
            ),
            pytest.param(
                _problem(
                    detail="Pipe 'a' fails. Pipe 'b' fails.",
                    code="method.invalid",
                    domain="method",
                    errors=[{"code": "x.y", "detail": "Pipe 'a' fails.", "location": {"pipe": "a"}}, {"code": "x.y", "detail": "Pipe 'b' fails."}],
                ),
                (
                    "Reason: An unexpected error occurred — Pipe 'a' fails. Pipe 'b' fails.",
                    "In pipe a",
                    WHO_ACTS_METHOD,
                    "Next step: Report this to whoever runs the runtime.",
                    RETRY_NO,
                    "For support: method.invalid",
                ),
                id="faults the reason already says",
            ),
            pytest.param(
                _problem(
                    code="client.outcome_unknown",
                    retry="outcome_unknown",
                    pipeline_run_id="run-9",
                    next_step={"kind": "read_run", "detail": "Read the run."},
                ),
                (
                    "Reason: An unexpected error occurred — The runtime met an unexpected error.",
                    WHO_ACTS_RUNTIME,
                    "Next step: Read the run.",
                    RETRY_UNKNOWN,
                    "For support: run run-9 · client.outcome_unknown",
                ),
                id="outcome unknown",
            ),
            pytest.param(
                _problem(code="pipelex.something_new", domain="nobody-knows", retry="maybe", next_step={"kind": "dance", "detail": "Do it."}),
                (
                    "Reason: An unexpected error occurred — The runtime met an unexpected error.",
                    # A domain or a verdict this version does not know reads as the family's, then as the safe one.
                    WHO_ACTS_RUNTIME,
                    "Next step: Do it.",
                    RETRY_NO,
                    "For support: pipelex.something_new",
                ),
                id="members this version does not know",
            ),
        ],
    )
    def test_problem_lines_read_out_what_the_problem_carries(self, problem: Problem, expected_lines: tuple[str, ...]):
        assert problem_lines(problem) == expected_lines

    def test_the_request_id_and_the_run_join_the_support_line(self):
        assert problem_lines(_problem(), request_id="req_1", run_id="run-9")[-1] == "For support: run run-9 · runtime.unexpected · request req_1"


class TestPrintError:
    def test_prints_the_message_the_details_and_the_hint(self):
        buffer = io.StringIO()
        print_error(Console(file=buffer, width=200), ErrorPresentation(message="Run run-9 failed.", hint="Do this.", details=("Reason: it broke.",)))
        rendered = buffer.getvalue()
        assert "Error: Run run-9 failed." in rendered
        assert "Reason: it broke." in rendered
        assert "Hint: Do this." in rendered

    def test_hangs_a_multi_line_detail_under_its_label(self):
        # A refused method's fault ends with a blank line and the model names it suggests instead; at
        # the margin, that suggestion would read as a line of its own.
        buffer = io.StringIO()
        print_error(
            Console(file=buffer, width=200),
            ErrorPresentation(message="Refused.", hint=None, details=("Reason: Unknown model.\n\nDid you mean: gpt-5?",)),
        )
        assert buffer.getvalue() == "Error: Refused.\n  Reason: Unknown model.\n\n    Did you mean: gpt-5?\n"

    def test_prints_server_text_verbatim_rather_than_as_markup(self):
        # A problem's detail is the runtime's text: a bracketed span in it must neither vanish as a
        # style tag nor crash the print as an unmatched closing tag.
        buffer = io.StringIO()
        presentation = ErrorPresentation(message="Bad value [x] in [/y].", hint=None, details=("Reason: list [1, 2] [bold]",))
        print_error(Console(file=buffer, width=200), presentation)
        rendered = buffer.getvalue()
        assert "Bad value [x] in [/y]." in rendered
        assert "Reason: list [1, 2] [bold]" in rendered
