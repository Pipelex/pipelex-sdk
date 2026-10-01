"""Present SDK errors as actionable CLI messages.

This module defines no exception classes — it is a presentation mapper. Each mode
package's `_run()` wrapper (`widget/blocking/cli.py`, `widget/attended/cli.py`,
`widget/detached/cli.py`) catches `PipelineRequestError` (the base of the typed errors
the `pipelex-sdk` client raises) exactly once, turns it into an `ErrorPresentation` here —
a message, the lines that explain it, and a hint — prints it with `print_error`, and
exits non-zero. Unexpected exceptions are deliberately NOT caught anywhere: they crash
loudly with a full traceback, and so, for now, does a connection that fails on `execute`
or `start`, which the SDK passes through as httpx's own transport error rather than as
`ApiUnreachableError`.

A run that ended without a result is presented from the error report the runner stored
when it failed, which the SDK hands back typed as `RunErrorReport`: `report_lines` reads
out its reason, its next step and its retry advice, and the detached `status` and
`result` commands print the same lines, so a failed run reads the same wherever you
meet it. A request the API refused — a method it will not run, a key it does not accept —
arrives as the SDK's typed `ApiResponseError` whatever the route, and `problem_lines`
reads its problem document out the same way: the reason, the pipes the refusal names,
the next step and the retry advice.

Error presentation is orthogonal to execution mode, so it is shared — but the hints
name the mode *groups*, since the fix for a timed-out blocking run is to rerun it under
another group.
"""

from typing import NamedTuple

from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.error_models import RunErrorReport
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    ArtifactAuthenticationError,
    ArtifactOperationError,
    InputPreparationError,
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
from pipelex_sdk.validation_models import ValidationErrorItem
from rich.console import Console
from rich.markup import escape

#: A sentence for each kind of advice the runner names, for a report whose `user_action` carries no
#: `detail`. The kinds are an open set on the wire, so a kind missing here prints no next step rather
#: than a guess — `unknown` among them.
_NEXT_STEP_BY_KIND: dict[str, str] = {
    "wait_and_retry": "Wait a moment, then run it again.",
    "check_billing": "Check your plan and credits.",
    "check_credentials": "Check the credentials the failing call uses.",
    "change_input": "Change the inputs, then run it again.",
    "change_model": "Change the model the failing pipe uses.",
    "contact_support": "Contact support with the run id.",
}

#: The runner's `error_type` for a `/start` it cannot honor: its orchestration is synchronous only.
_START_REQUIRES_ASYNC_ORCHESTRATION = "StartRequiresAsyncOrchestration"

_API_KEY_HINT = "Set PIPELEX_API_KEY in your environment or .env file — get a key at https://app.pipelex.com"


class ErrorPresentation(NamedTuple):
    """What the CLI shows for a failed command: the error, the lines that explain it, and what to do about it."""

    message: str
    hint: str | None
    #: Lines printed under the message — for a failed run, its stored report read out field by field.
    details: tuple[str, ...] = ()


def present_error(exc: PipelineRequestError) -> ErrorPresentation:
    """Map an SDK error to a CLI-facing message and an actionable hint.

    Every route of the SDK — the protocol routes (`execute`, `start`, `runs/*`) as much
    as the product ones — raises the typed `ApiResponseError` on a non-2xx answer, with
    the answer's problem document parsed onto it, so one branch presents every refusal
    whichever route raised it. The SDK's own translations of a status come first: a
    blocking run cut off at the gateway and a `/start` on a server with no run store
    each have a class of their own.
    """
    if isinstance(exc, PipelineExecuteTimeoutError):
        return ErrorPresentation(
            message=f"The blocking run exceeded the hosted gateway's ~30s synchronous cap ({exc.elapsed_seconds:.0f}s elapsed).",
            hint="Rerun the same command with `widget attended ...` — the durable path survives long runs.",
        )
    if isinstance(exc, RunLifecycleUnavailableError):
        return ErrorPresentation(
            message=f"The server at {exc.api_url} has no run store (durable run lifecycle unavailable).",
            hint="You are talking to a bare runner — use `widget blocking ...`.",
        )
    if isinstance(exc, ApiResponseError):
        return _present_api_response_error(exc)
    if isinstance(exc, ApiUnreachableError):
        return ErrorPresentation(
            message=f"Could not reach the Pipelex API at {exc.api_url}.",
            hint="Check PIPELEX_BASE_URL — and if you self-host, make sure your runner is up.",
        )
    if isinstance(exc, RunFailedError):
        return present_failed_run(run_id=exc.run_id, status=exc.status, report=exc.error, platform_message=str(exc))
    if isinstance(exc, RunTimeoutError):
        return ErrorPresentation(
            message=f"Gave up waiting for run {exc.run_id} after {exc.timeout_seconds:.0f}s — the run is still executing server-side.",
            hint=f"Resume waiting with `widget detached wait {exc.run_id}`.",
        )
    # File upload (summarize-pdf) preparation errors — raised before any run is created.
    if isinstance(exc, InputPreparationError):
        return _present_upload_error(exc)
    # Artifact download (generate-image) errors — raised after the run has already been paid for.
    if isinstance(exc, ArtifactOperationError):
        return _present_artifact_error(exc)
    return ErrorPresentation(message=str(exc), hint=None)


def present_failed_run(*, run_id: str, status: RunStatus, report: RunErrorReport | None, platform_message: str | None) -> ErrorPresentation:
    """Present a run that ended without a result, from the report the runner stored when it failed.

    The SDK hands the same three things back wherever such a run surfaces — `RunFailedError` out of
    `wait_for_result`, `start_and_wait` or an artifact download, the failed arm of `get_run_result`, and
    the status read: the terminal `status`, the stored `report` (`None` when the run ended with none,
    as a cancelled run does), and, on the first two, the platform's one sentence about the run.

    With a report, the lines under the message read it out and there is no hint: the report's next
    step is the advice, and a hint pointing at `widget detached status` would only print the same
    lines again. Without one, the platform's sentence is kept — on a stored result the platform
    refuses to serve it is the only thing that says what happened — and the hint says what is left.
    """
    how_it_ended = _how_the_run_ended(status)
    lines = report_lines(report)
    if lines:
        return ErrorPresentation(message=f"Run {run_id} {how_it_ended}.", hint=None, details=lines)
    platform_lines = (f"The platform said: {platform_message}",) if platform_message else ()
    return ErrorPresentation(
        message=f"Run {run_id} {how_it_ended}, and no reason was recorded for it.",
        hint=_hint_without_a_reason(run_id=run_id, status=status),
        details=platform_lines,
    )


def report_lines(report: RunErrorReport | None) -> tuple[str, ...]:
    """A failed run's stored report as the lines a person reads: the reason, the next step, the retry advice.

    The reason is the report's `title` and `message` (its `error_type`, the runner's exception class,
    when it carries neither); the next step is its `user_action`; the retry advice is its `retryable`,
    left unsaid when that is `None`, which means unknown rather than no. Empty when there is no report
    or it carries none of these, so the caller can tell a report worth reading from its absence.

    The report is the runner's verbose one, so `message` can hold a provider's raw text. This is a
    developer's tool, so it is printed as it came; an application in front of end users decides what
    of it they see.
    """
    if report is None:
        return ()
    user_action = report.user_action
    return _advice_lines(
        reason=_reason(title=report.title, message=report.message, last_resort=report.error_type),
        next_step=_next_step(kind=user_action.kind, detail=user_action.detail) if user_action else None,
        retryable=report.retryable,
    )


def problem_lines(exc: ApiResponseError) -> tuple[str, ...]:
    """A refused request's problem document as the lines a person reads, worded as `report_lines` words a run's.

    The reason is the problem's `title` and `detail` (its `error_type`, else the platform's `code`,
    when it carries neither); then one line per item a refused method's `validation_errors` lists,
    naming the pipe or concept it is about, so the reader knows where to look; then the next step
    the server advised and whether running it again can succeed. Empty when the answer carried
    none of these — a body that was not a problem document, say.

    The runner writes a refusal's `detail` from its items — the one item's message, verbatim — so
    an item whose message the reason already says is reduced to where it is, rather than printed
    twice.
    """
    reason = _reason(title=exc.title, message=exc.server_message, last_resort=exc.error_type or exc.code)
    said = _text(exc.server_message)
    items = tuple(line for item in exc.validation_errors or () if (line := _validation_line(item, said=said)))
    next_step = _next_step(kind=exc.user_action.kind, detail=exc.user_action.detail) if exc.user_action else None
    lines = _advice_lines(reason=reason, next_step=next_step, retryable=exc.retryable)
    if not items:
        return lines
    # The items sit between the reason and the advice, which is about them.
    split = 1 if reason else 0
    return lines[:split] + items + lines[split:]


def print_error(console: Console, presentation: ErrorPresentation) -> None:
    """Print a presentation: the message, its detail lines, then the hint.

    Every piece is escaped before it reaches Rich, because the message and the details carry the
    server's text: a bracketed span in a provider's message would otherwise be read as a style tag,
    swallowed, or crash the print as an unmatched closing tag.
    """
    console.print(f"[red]Error:[/red] {escape(presentation.message)}")
    for line in presentation.details:
        console.print(escape(_indented(line)))
    if presentation.hint:
        console.print(f"\n[yellow]Hint:[/yellow] {escape(presentation.hint)}")


def _indented(line: str) -> str:
    """A detail line under the message, the continuation lines of a multi-line one hanging under its label.

    The server's text can span lines — a refused method's reason ends with a blank line and the
    model names it suggests instead — and a continuation line at the margin would read as a line
    of its own.
    """
    first, *rest = line.splitlines() or [""]
    return "\n".join([f"  {first}", *(f"    {part}" if part.strip() else "" for part in rest)])


def _how_the_run_ended(status: RunStatus) -> str:
    match status:
        case RunStatus.FAILED:
            return "failed"
        case RunStatus.CANCELLED:
            return "was cancelled"
        case RunStatus.TERMINATED:
            return "was terminated"
        case RunStatus.TIMED_OUT:
            return "timed out"
        case RunStatus.PENDING | RunStatus.STARTED | RunStatus.RUNNING | RunStatus.COMPLETED:
            # Not an ending without a result, so it is named as the status rather than worded as one.
            return f"ended with status {status}"


def _hint_without_a_reason(*, run_id: str, status: RunStatus) -> str:
    match status:
        case RunStatus.FAILED:
            return f"Nothing more is recorded about this failure — contact support with the run id {run_id}."
        case RunStatus.CANCELLED | RunStatus.TERMINATED | RunStatus.TIMED_OUT:
            return "The run stopped before it produced a result — start it again to get one."
        case RunStatus.PENDING | RunStatus.STARTED | RunStatus.RUNNING | RunStatus.COMPLETED:
            return f"Check it again with `widget detached status {run_id}`."


def _advice_lines(*, reason: str | None, next_step: str | None, retryable: bool | None) -> tuple[str, ...]:
    """The reason, the next step and the retry advice, each only when known.

    `retryable` is left unsaid when it is `None`, which means unknown rather than no.
    """
    lines: list[str] = []
    if reason:
        lines.append(f"Reason: {reason}")
    if next_step:
        lines.append(f"Next step: {next_step}")
    match retryable:
        case True:
            lines.append("Retry: running it again may succeed.")
        case False:
            lines.append("Retry: running it again will fail the same way until the cause is fixed.")
        case None:
            pass
    return tuple(lines)


def _reason(*, title: str | None, message: str | None, last_resort: str | None) -> str | None:
    """The title and the message, whichever are there, or the error's class name as a last resort."""
    title = _text(title)
    message = _text(message)
    if title and message:
        return f"{title} — {message}"
    return title or message or _text(last_resort)


def _next_step(*, kind: str | None, detail: str | None) -> str | None:
    """The advice's own words, or a sentence for its kind when it gives none."""
    return _text(detail) or _NEXT_STEP_BY_KIND.get(kind or "")


def _validation_line(item: ValidationErrorItem, *, said: str | None) -> str | None:
    """One item of a refused method's `validation_errors`, located by its pipe or concept when it names one.

    `said` is the refusal's reason as already printed: an item whose message it contains is reduced
    to where it is, and an item with neither a new message nor a location prints nothing.
    """
    message = _text(item.message)
    if message is not None and said is not None and message in said:
        message = None
    if item.pipe_code:
        return f"In pipe {item.pipe_code}: {message}" if message else f"Pipe: {item.pipe_code}"
    if item.concept_code:
        return f"In concept {item.concept_code}: {message}" if message else f"Concept: {item.concept_code}"
    return f"Problem: {message}" if message else None


def _text(value: str | None) -> str | None:
    """A report field as printable text: `None` for a missing or blank one."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _present_upload_error(exc: InputPreparationError) -> ErrorPresentation:
    """Present a file-upload (input-preparation) failure. The SDK already gives each a clear
    message; here we add the actionable hint per semantic category."""
    if isinstance(exc, UnsupportedUploadCapabilityError):
        hint = "File upload is a hosted capability — point PIPELEX_BASE_URL at https://api.pipelex.com (a bare runner may not serve /v1/upload)."
    elif isinstance(exc, UploadAuthenticationError):
        hint = _API_KEY_HINT
    elif isinstance(exc, RejectedAssetError):
        hint = "The server rejected the file (usually past the service size cap) — try a smaller file."
    elif isinstance(exc, InvalidLocalSourceError):
        hint = "Check the path points at a readable file."
    else:
        hint = "Check PIPELEX_BASE_URL and that the API is reachable."
    return ErrorPresentation(message=str(exc), hint=hint)


def _present_artifact_error(exc: ArtifactOperationError) -> ErrorPresentation:
    """Present a failure to bring a run's produced files down.

    This family is raised by `widget/artifacts.py` *after* the run itself succeeded and its output
    was printed, so no hint here ever says to rerun: the run has been paid for, and what is left
    is to recover the files it produced.
    """
    if isinstance(exc, ArtifactAuthenticationError):
        hint = _API_KEY_HINT
    else:
        hint = "The run itself succeeded — check the download directory is writable and is not an existing file."
    return ErrorPresentation(message=str(exc), hint=hint)


def _present_api_response_error(exc: ApiResponseError) -> ErrorPresentation:
    """Present a non-2xx answer from the problem document the SDK parsed onto the error.

    A request the API refused is read out by `problem_lines`: the reason, the pipes a refused
    method names, the next step and the retry advice. The branch that earns a hint goes on the
    runner's structured `error_type`, never the wording: a `/start` on a deployment whose
    orchestration is synchronous only, whose fix is to run the same demo under `widget blocking`.
    The HTTP status decides only an authentication failure, whose fix is the key whatever the
    route; its reason is read out too, because a `403` can be a key that was recognised but may
    not use the route.
    """
    status = f"{exc.status} {exc.status_text}".strip()
    if exc.error_type == _START_REQUIRES_ASYNC_ORCHESTRATION:
        return ErrorPresentation(
            message=_text(exc.server_message) or "This deployment cannot start durable runs — it has no async orchestration.",
            hint="This runner only does synchronous runs — use `widget blocking ...` instead.",
        )
    if exc.status in (401, 403):
        return ErrorPresentation(message=f"The API rejected the request ({status}).", hint=_API_KEY_HINT, details=problem_lines(exc))
    return ErrorPresentation(message=f"The API answered {status}.", hint=None, details=problem_lines(exc))
