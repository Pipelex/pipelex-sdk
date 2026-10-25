"""Present SDK errors as actionable CLI messages.

This module defines no exception classes — it is a presentation mapper. Each mode
package's `_run()` wrapper (`widget/blocking/cli.py`, `widget/attended/cli.py`,
`widget/detached/cli.py`) catches `PipelineRequestError` (the base of the typed errors
the `pipelex-sdk` client raises) exactly once, turns it into an `ErrorPresentation` here —
a message, the lines that explain it, and a hint — prints it with `print_error`, and
exits non-zero. Unexpected exceptions are deliberately NOT caught anywhere: they crash
loudly with a full traceback.

Every error the SDK raises carries its failure as one problem document, `exc.problem`, and
this module reads that problem, never the error's class: a request the API refused is the
problem it sent, whatever the route; a run that ended without a result is the run's own
problem, which the platform's `run.failed` nests as `run_error`; and a failure the SDK
detected itself, a connection that failed or a start whose outcome is unknown, is a problem
it built under a registered code. `problem_lines` reads any problem out the same way: the
reason, the faults its `errors` list with where each one is, who must act (its `domain`),
the next step (its `next_step`), whether running it again can succeed (its `retry`, with
`retry_after`, and `outcome_unknown` saying to look the run up by its id before starting
another), and the line to quote to support, with the run, the code and the request id. The
detached `status` and `result` commands print the same lines for a failed run, so it reads
the same wherever you meet it.

The hint is the CLI's own action, chosen by the problem's `code` or its step's `kind`: the
key for a refused credential, the base URL for an API out of reach, `widget blocking` for a
server with no durable runs, `widget detached` for a run still going. Error presentation is
orthogonal to execution mode, so it is shared — but the hints name the mode *groups*, since
the fix for a blocking run cut off at the gateway is to rerun it under another group, which
is why the blocking group says it is the one presenting. `isinstance` reads only a class's
own data: an answer's status and base URL, or the time a blocking run took before it was cut
off.
"""

import math
from typing import NamedTuple

from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.models import Problem, ProblemItem, ProblemLocation
from mthds.protocol.problem.registry import CoreCode, ProblemDomain, RetryVerdict, StepKind
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    ArtifactOperationError,
    PipelineExecuteTimeoutError,
    RunLifecycleUnavailableError,
    nested_run_error,
)
from pipelex_sdk.runs import RunStatus
from rich.console import Console
from rich.markup import escape

_API_KEY_HINT = "Set PIPELEX_API_KEY in your environment or .env file — get a key at https://app.pipelex.com"

#: Who must act on a problem, by its domain, as the "Who acts" line says it.
_WHO_ACTS: dict[ProblemDomain, str] = {
    ProblemDomain.INPUT: "you, by changing the inputs or the request",
    ProblemDomain.METHOD: "whoever authors the method, by changing it",
    ProblemDomain.ACCOUNT: "whoever owns the account, by changing a credential, a plan or a role",
    ProblemDomain.OPERATOR: "whoever runs the deployment, by fixing its configuration",
    ProblemDomain.RUNTIME: "nobody on your side: the service failed, and nothing you sent caused it",
}

#: The failures the SDK detects itself with no answer to read: the API out of reach, or silent past the time
#: limit. Their problems sit in the `runtime` domain, but the URL or the network is as likely a cause as the
#: service, so no "Who acts" line blames either.
_CLIENT_DETECTED = frozenset({CoreCode.CLIENT_UNREACHABLE, CoreCode.CLIENT_TIMEOUT})

#: The capabilities a `runtime.unsupported` names when the server runs no durable run: the SDK's reading of a
#: server with no run store, and a runner whose orchestration is synchronous only.
_DURABLE_CAPABILITIES = frozenset({"the durable run lifecycle", "asynchronous execution"})

#: The codes of a refused credential. The API's own problem gives them the step `check_credentials`, and the SDK's
#: reading of a bare `401` or `403` the step `contact_owner`; either way the fix on this side is the key.
_CREDENTIAL_CODES = frozenset({CoreCode.AUTH_MISSING_CREDENTIAL, CoreCode.AUTH_INVALID_CREDENTIAL, CoreCode.AUTH_CREDENTIAL_EXPIRED})

#: The capability a `runtime.unsupported` names when the server stores no file.
_UPLOAD_CAPABILITY = "file upload"


class ErrorPresentation(NamedTuple):
    """What the CLI shows for a failed command: the error, the lines that explain it, and what to do about it."""

    message: str
    hint: str | None
    #: Lines printed under the message: the problem read out, a line per thing it says.
    details: tuple[str, ...] = ()


def present_error(exc: PipelineRequestError, *, blocking: bool = False) -> ErrorPresentation:
    """Map an SDK error to a CLI-facing message and an actionable hint, from the problem it carries.

    A failed run is read from the run's own problem (`present_failed_run`); every other problem is
    read out by `problem_lines` under the CLI's own sentence for it, and the hint is chosen by the
    problem's code or its step's kind, never by the error's class. `blocking` says the failed
    command ran under `widget blocking`, whose cut-off at the gateway is worded as such.
    """
    problem = exc.problem
    match problem.code:
        case CoreCode.RUN_FAILED:
            return present_failed_run(
                run_id=problem.pipeline_run_id or _param(problem, "pipeline_run_id") or "(unknown)",
                status=_run_status(problem),
                run_error=nested_run_error(problem),
                platform_message=problem.detail,
            )
        case CoreCode.RUNTIME_UNSUPPORTED if _param(problem, "capability") in _DURABLE_CAPABILITIES:
            where = _api_url(exc)
            return ErrorPresentation(
                message=f"The server{f' at {where}' if where else ''} does not run durable runs.",
                hint="This server only does synchronous runs — use `widget blocking ...` instead.",
                details=problem_lines(problem, request_id=_request_id(exc)),
            )
        case _:
            return ErrorPresentation(
                message=_message(exc, blocking=blocking),
                hint=_hint(exc, blocking=blocking),
                details=problem_lines(problem, request_id=_request_id(exc)),
            )


def present_failed_run(*, run_id: str, status: RunStatus, run_error: Problem | None, platform_message: str | None) -> ErrorPresentation:
    """Present a run that ended without a result, from the run's own problem.

    The SDK hands the same things back wherever such a run surfaces — `RunFailedError` out of
    `wait_for_result`, `start_and_wait` or an artifact download, the failed arm of `get_run_result`, and
    the status read: the terminal `status`, the run's own `run_error` (`None` when the run ended with
    none stored, as one whose start failed does, or one cancelled with no completion callback carrying
    one), and, on the first two, the platform's one sentence about the run.

    With the run's problem, the lines under the message read it out as `problem_lines` reads any
    problem, and the hint is the CLI's action for its step, when it has one. Without one, the
    platform's sentence is kept — it is then the only thing that says what happened — and the hint
    says what is left.
    """
    how_it_ended = _how_the_run_ended(status)
    if run_error is not None:
        return ErrorPresentation(
            message=f"Run {run_id} {how_it_ended}.",
            hint=_step_hint(run_error, run_id=run_error.pipeline_run_id or run_id),
            details=problem_lines(run_error, request_id=_problem_request_id(run_error), run_id=run_id),
        )
    platform_lines = (f"The platform said: {platform_message}",) if _text(platform_message) else ()
    return ErrorPresentation(
        message=f"Run {run_id} {how_it_ended}, and no reason was recorded for it.",
        hint=_hint_without_a_reason(run_id=run_id, status=status),
        details=platform_lines,
    )


def problem_lines(problem: Problem, *, request_id: str | None = None, run_id: str | None = None) -> tuple[str, ...]:
    """A problem as the lines a person reads, each only when the problem says it.

    - `Reason:` its `title` and `detail`, the detail alone when it only restates the title;
    - one line per fault its `errors` list, located by the pipe, the input, the field and the file it
      names, with the close matches it suggests; an item whose detail the reason already says is
      reduced to where it is;
    - `Who acts:` who must act, from its `domain`, except for a failure the SDK detected with no answer to
      read (`client.unreachable`, `client.timeout`), where the URL or the network is as likely a cause;
    - `Next step:` its `next_step`, the step's own sentence, except for a step that is to retry or to
      wait, which the retry line says with its delay;
    - `Retry:` whether running it again can succeed, from its `retry`: after `retry_after` seconds when
      it gives them, and, for `outcome_unknown`, that the run may already have started and is looked up
      by its id before another is started;
    - `For support:` the run, the problem's `code` and the request id, each when there is one, the line
      to quote to whoever runs the API. `run_id` names the run when the problem itself does not.
    """
    lines: list[str] = []
    reason = _reason(title=problem.title, detail=problem.detail)
    if reason:
        lines.append(f"Reason: {reason}")
    said = _text(problem.detail)
    lines.extend(line for item in problem.errors or () if (line := _item_line(item, said=said)))
    if problem.code not in _CLIENT_DETECTED:
        lines.append(f"Who acts: {_WHO_ACTS[problem.effective_domain]}.")
    next_step = _next_step(problem)
    if next_step:
        lines.append(f"Next step: {next_step}")
    lines.append(_retry_line(problem))
    lines.append(_support_line(problem, request_id=request_id, run_id=run_id))
    return tuple(lines)


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

    The server's text can span lines — a refused method's fault ends with a blank line and the
    model names it suggests instead — and a continuation line at the margin would read as a line
    of its own.
    """
    first, *rest = line.splitlines() or [""]
    return "\n".join([f"  {first}", *(f"    {part}" if part.strip() else "" for part in rest)])


def _message(exc: PipelineRequestError, *, blocking: bool) -> str:
    """The sentence the error opens with: the CLI's own for the codes it words, else the answer's status or the SDK's sentence."""
    problem = exc.problem
    match problem.code:
        case CoreCode.CLIENT_UNREACHABLE:
            return f"Could not reach the Pipelex API at {_api_location(exc)}."
        case CoreCode.CLIENT_TIMEOUT:
            return f"The Pipelex API at {_api_location(exc)} did not answer in time."
        case CoreCode.CLIENT_OUTCOME_UNKNOWN if blocking:
            elapsed = f" after {exc.elapsed_seconds:.0f}s" if isinstance(exc, PipelineExecuteTimeoutError) else ""
            return (
                f"The blocking run's result never came back{elapsed}, and the run may still be going on the server: "
                "behind the hosted gateway, a synchronous request is cut off at about 30 seconds."
            )
        case _:
            if isinstance(exc, ApiResponseError):
                return f"The API answered {f'{exc.status} {exc.status_text}'.strip()}."
            return str(exc)


def _api_location(exc: PipelineRequestError) -> str:
    """The base URL a failure to reach the API names: the problem's own `base_url`, else the error's, else a phrase."""
    return _param(exc.problem, "base_url") or _api_url(exc) or "the configured base URL"


def _hint(exc: PipelineRequestError, *, blocking: bool) -> str | None:
    """The CLI's own action for a problem, chosen by its code, then by its step's kind; `None` when the next step says it all."""
    problem = exc.problem
    match problem.code:
        case CoreCode.CLIENT_UNREACHABLE | CoreCode.CLIENT_TIMEOUT:
            return "Check PIPELEX_BASE_URL — and if you self-host, make sure your runner is up."
        case CoreCode.CLIENT_OUTCOME_UNKNOWN if blocking:
            return "Rerun the same command with `widget attended ...` — the durable path survives long runs."
        case CoreCode.RUNTIME_UNSUPPORTED if _param(problem, "capability") == _UPLOAD_CAPABILITY:
            return "File upload is a hosted capability — point PIPELEX_BASE_URL at https://api.pipelex.com (a bare runner may not store files)."
        case _:
            hint = _step_hint(problem, run_id=problem.pipeline_run_id)
            if hint is None and isinstance(exc, ArtifactOperationError):
                # The run's files come down after the run succeeded and its output was printed, so the hint never
                # sends the reader back to run the demo again: that would pay for a second run.
                return "The run itself succeeded and only saving its files failed — there is no need to run it again."
            return hint


def _step_hint(problem: Problem, *, run_id: str | None) -> str | None:
    """The CLI's action for a problem's next step, for the kinds it has one for.

    A refused credential is the key's to fix, whatever step the problem names. A step to read the run
    names the commands that look it up and wait for it, by `run_id`; without an id, it is only worth a
    hint when the run may have started, since its id then never reached this command.
    """
    if problem.code in _CREDENTIAL_CODES:
        return _API_KEY_HINT
    match problem.effective_step_kind:
        case StepKind.CHECK_CREDENTIALS:
            return _API_KEY_HINT
        case StepKind.READ_RUN:
            if run_id:
                # The commands go in locals so the line keeps headroom for a bootstrapped project's longer name.
                status = f"widget detached status {run_id}"
                wait = f"widget detached wait {run_id}"
                return f"Look the run up with `{status}`, or wait for it with `{wait}`, rather than start it again."
            if problem.outcome_is_unknown:
                return "The run's id never reached this command — look for it in the organization's run history before running it again."
            return None
        case (
            StepKind.RETRY
            | StepKind.WAIT
            | StepKind.REFRESH
            | StepKind.CHANGE_INPUT
            | StepKind.CHANGE_METHOD
            | StepKind.CHANGE_MODEL
            | StepKind.REQUEST_ACCESS
            | StepKind.CHECK_ACCOUNT
            | StepKind.FIX_CONFIGURATION
            | StepKind.UPGRADE
            | StepKind.CONTACT_OWNER
            | StepKind.REPORT
        ):
            # The next step's own sentence, or the retry line, says it.
            return None


def _next_step(problem: Problem) -> str | None:
    """The next step's sentence, except for a step to retry or to wait, which the retry line says with its delay."""
    match problem.effective_step_kind:
        case StepKind.RETRY | StepKind.WAIT:
            return None
        case (
            StepKind.READ_RUN
            | StepKind.REFRESH
            | StepKind.CHANGE_INPUT
            | StepKind.CHANGE_METHOD
            | StepKind.CHANGE_MODEL
            | StepKind.CHECK_CREDENTIALS
            | StepKind.REQUEST_ACCESS
            | StepKind.CHECK_ACCOUNT
            | StepKind.FIX_CONFIGURATION
            | StepKind.UPGRADE
            | StepKind.CONTACT_OWNER
            | StepKind.REPORT
        ):
            return _text(problem.next_step.detail)


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


def _retry_line(problem: Problem) -> str:
    """Whether running it again can succeed, as the problem's `retry` says."""
    match problem.effective_retry:
        case RetryVerdict.YES:
            after = f" in {_seconds(problem.retry_after)}" if problem.retry_after else ""
            return f"Retry: running it again can succeed{after}."
        case RetryVerdict.NO:
            return "Retry: running it again unchanged will fail the same way."
        case RetryVerdict.OUTCOME_UNKNOWN:
            return "Retry: the run may already have started, so look it up by its id before running it again, or it is paid for twice."


def _seconds(value: float) -> str:
    """A number of seconds as a sentence says it, rounded up to a whole second."""
    whole = math.ceil(value)
    return "1 second" if whole == 1 else f"{whole} seconds"


def _support_line(problem: Problem, *, request_id: str | None, run_id: str | None) -> str:
    """The run, the code and the request, each when there is one, to quote to whoever runs the API."""
    run = problem.pipeline_run_id or run_id
    parts = [f"run {run}" if run else None, problem.code, f"request {request_id}" if request_id else None]
    return f"For support: {' · '.join(part for part in parts if part)}"


def _item_line(item: ProblemItem, *, said: str | None) -> str | None:
    """One fault of a problem, located where its location says, with the close matches it suggests.

    `said` is the problem's detail as the reason already printed it: an item whose detail it contains is
    reduced to where it is, and an item with neither a new detail nor a location prints nothing.
    """
    detail = _text(item.detail)
    if detail is not None and said is not None and detail in said:
        detail = None
    suggestions = f" (did you mean: {', '.join(item.suggestions)})" if item.suggestions else ""
    where = _where(item.location)
    if where:
        return f"In {where}: {detail}{suggestions}" if detail else f"In {where}{suggestions}"
    return f"Fault: {detail}{suggestions}" if detail else None


def _where(location: ProblemLocation | None) -> str | None:
    """Where a fault is, from the pipe, the input, the field and the file its location names."""
    if location is None:
        return None
    parts = [
        f"pipe {location.pipe}" if location.pipe else None,
        f"input {location.input}" if location.input else None,
        f"field {location.field}" if location.field else None,
    ]
    named = ", ".join(part for part in parts if part)
    if location.file:
        file = f"{location.file}:{location.line}" if location.line is not None else location.file
        return f"{named} ({file})" if named else file
    return named or None


def _reason(*, title: str, detail: str) -> str | None:
    """The title and the detail, the detail alone when it only restates the title."""
    title_text = _text(title)
    detail_text = _text(detail)
    if title_text and detail_text:
        if title_text.rstrip(".").casefold() == detail_text.rstrip(".").casefold():
            return detail_text
        return f"{title_text} — {detail_text}"
    return title_text or detail_text


def _param(problem: Problem, name: str) -> str | None:
    """A parameter of the problem's code, when it is text."""
    value: object = (problem.params.model_extra or {}).get(name) if problem.params is not None else None
    return value if isinstance(value, str) and value else None


def _run_status(problem: Problem) -> RunStatus:
    """The terminal status a `run.failed` names, `FAILED` when it names none this version knows."""
    try:
        return RunStatus(_param(problem, "run_status") or RunStatus.FAILED)
    except ValueError:
        return RunStatus.FAILED


def _request_id(exc: PipelineRequestError) -> str | None:
    """The id the API knows the failed request by: the answer's, header included, else the problem's own member."""
    if isinstance(exc, ApiResponseError) and exc.request_id:
        return exc.request_id
    return _problem_request_id(exc.problem)


def _problem_request_id(problem: Problem) -> str | None:
    """The `request_id` member a problem carries, when it carries one."""
    value: object = (problem.model_extra or {}).get("request_id")
    return value if isinstance(value, str) and value else None


def _api_url(exc: PipelineRequestError) -> str | None:
    """The base URL the failed request went to, when the error names it."""
    if isinstance(exc, (ApiResponseError, ApiUnreachableError, RunLifecycleUnavailableError)):
        return exc.api_url or None
    return None


def _text(value: str | None) -> str | None:
    """A member as printable text: `None` for a missing or blank one."""
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None
