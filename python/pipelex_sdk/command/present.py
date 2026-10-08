"""What the command prints: a finished run's result on stdout, and every failure on stderr.

A failure is worded by the command from the error's typed fields, never from an SDK message whose
wording is the SDK's own, wherever the fields carry what a person needs: the API's reason, the next
step it advises and the request id support asks for. That keeps this command and its JavaScript
twin saying the same thing for the same answer, which is what the recorded case table
holds them to.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast

from mthds.protocol.exceptions import PipelineRequestError
from pydantic import ValidationError

from pipelex_sdk.command.io import EXIT_FAILED, EXIT_USAGE, CommandError
from pipelex_sdk.command.json_text import to_json_text
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    InputPreparationError,
    InvalidInputValueError,
    InvalidLocalSourceError,
    MethodLoadError,
    RejectedAssetError,
    RunFailedError,
    UnsupportedUploadCapabilityError,
    UploadAuthenticationError,
    UploadTransportError,
)

if TYPE_CHECKING:
    from pipelex_sdk.command.io import CommandIO
    from pipelex_sdk.validation_models import ValidationErrorItem

#: The first line of a method that does not load, after `Error: `.
METHOD_DOES_NOT_LOAD_SENTENCE = "the method does not load."

#: What a file input takes, the hint under a value it cannot take.
_FILE_INPUT_FORMS = 'A file input takes a local path, an http(s) or pipelex-storage:// URL, a data: URL, or an object whose "url" is one of these.'

#: The keys of the runtime's absence document, and no other.
_ABSENCE_KEYS = frozenset({"absent", "variable_name", "kind", "reason", "producing_pipe", "upstream"})
_ABSENCE_KINDS = frozenset({"declared_absent", "skipped", "not_provided"})


@dataclass(frozen=True)
class PresentedError:
    """A failure as the command prints it: its lines, and the exit code it ends with."""

    lines: list[str]
    exit_code: int


def present_error(exc: Exception) -> PresentedError:
    """Word any failure for stderr and choose its exit code."""
    if isinstance(exc, CommandError):
        return PresentedError(lines=[f"Error: {exc.message}", *exc.details], exit_code=exc.exit_code)
    if isinstance(exc, RunFailedError):
        report = exc.error
        lines = [f"Error: run {exc.run_id} ended with status {exc.status}."]
        reason = report.message if report is not None and report.message is not None else str(exc)
        lines.append(f"Reason: {reason}")
        if report is not None and report.user_action is not None and report.user_action.detail:
            lines.append(f"Next step: {report.user_action.detail}")
        return PresentedError(lines=lines, exit_code=EXIT_FAILED)
    if isinstance(exc, InvalidLocalSourceError):
        # A file the inputs name that cannot be read is the inputs' fault, as an unreadable inputs
        # file is, so it is a usage error.
        return PresentedError(
            lines=[f"Error: {exc}", "A relative path in the inputs resolves against the current directory."],
            exit_code=EXIT_USAGE,
        )
    if isinstance(exc, InvalidInputValueError):
        # A value at a file input that is no file, such as a data: URL that does not decode or a
        # number, is the inputs' fault too.
        return PresentedError(
            lines=["Error: the inputs hold a value at a file input that cannot be read as a file.", f"Reason: {exc}", _FILE_INPUT_FORMS],
            exit_code=EXIT_USAGE,
        )
    if isinstance(exc, MethodLoadError):
        # The same lines whichever route said so: the input preparation here, the pipe I/O call of
        # `--inputs-template` and `script` in `source.py`.
        return PresentedError(
            lines=[f"Error: {METHOD_DOES_NOT_LOAD_SENTENCE}", *load_failure_lines(exc.validation_errors, exc.server_message)],
            exit_code=EXIT_FAILED,
        )
    if isinstance(exc, (RejectedAssetError, UploadAuthenticationError, UnsupportedUploadCapabilityError, UploadTransportError)):
        return _present_upload_failure(exc)
    if isinstance(exc, InputPreparationError) and isinstance(exc.__cause__, ApiResponseError):
        return _present_refusal(exc.__cause__)
    if isinstance(exc, ApiResponseError):
        return _present_refusal(exc)
    if isinstance(exc, ApiUnreachableError):
        return PresentedError(
            lines=[f"Error: could not reach the Pipelex API at {exc.api_url} ({exc.code or 'network error'})."],
            exit_code=EXIT_FAILED,
        )
    if isinstance(exc, PipelineRequestError):
        return PresentedError(lines=[f"Error: {exc}"], exit_code=EXIT_FAILED)
    if isinstance(exc, (ValidationError, json.JSONDecodeError, UnicodeDecodeError)):
        # An answer the SDK could not read into the shape the route promises: the API's fault, not
        # the person's, and not worth a traceback.
        first_line = str(exc).splitlines()[0]
        return PresentedError(lines=["Error: the API's answer could not be read.", f"Reason: {first_line}"], exit_code=EXIT_FAILED)
    return PresentedError(lines=[f"Error: unexpected failure, {type(exc).__name__}: {exc}"], exit_code=EXIT_FAILED)


def _present_upload_failure(
    exc: RejectedAssetError | UploadAuthenticationError | UnsupportedUploadCapabilityError | UploadTransportError,
) -> PresentedError:
    """A file the inputs name that could not be uploaded: which file, the status the upload route
    answered when it answered, and the SDK's own sentence, which says what the status means for an
    upload (a file past the size limit, a deployment without upload), followed by the advice and the
    request id of the API's answer when it carries them.
    """
    cause = exc.__cause__ if isinstance(exc.__cause__, ApiResponseError) else None
    # A deployment without upload carries no status of its own: its 404 is the cause's.
    status = None if isinstance(exc, UnsupportedUploadCapabilityError) else exc.status
    if status is None and cause is not None:
        status = cause.status
    what = "an upload failed" if exc.filename is None else f'the upload of "{exc.filename}" failed'
    lines = [f"Error: {what}{'' if status is None else f' (status {status})'}.", f"Reason: {exc}"]
    if cause is not None and cause.user_action is not None and cause.user_action.detail:
        lines.append(f"Next step: {cause.user_action.detail}")
    if cause is not None and cause.request_id:
        lines.append(f"Request id: {cause.request_id}")
    return PresentedError(lines=lines, exit_code=EXIT_FAILED)


def _present_refusal(exc: ApiResponseError) -> PresentedError:
    """An answer the API gave instead of a result: its status, its reason and its advice."""
    if 200 <= exc.status < 300:
        lines = [f"Error: the API's answer could not be read (status {exc.status})."]
    else:
        lines = [f"Error: the API refused the request (status {exc.status})."]
    reason: str
    if exc.server_message is not None:
        reason = exc.server_message
    elif exc.title is not None:
        reason = exc.title
    else:
        reason = "the answer gives no reason"
    lines.append(f"Reason: {reason}")
    lines.extend(validation_line(source=item.source, message=item.message) for item in exc.validation_errors or [])
    if exc.user_action is not None and exc.user_action.detail:
        lines.append(f"Next step: {exc.user_action.detail}")
    if exc.request_id:
        lines.append(f"Request id: {exc.request_id}")
    return PresentedError(lines=lines, exit_code=EXIT_FAILED)


def load_failure_lines(items: list[ValidationErrorItem], message: str | None) -> list[str]:
    """The lines under "the method does not load": one per validation item, and when there is none,
    the answer's own message.
    """
    lines = [validation_line(source=item.source, message=item.message) for item in items]
    return lines or [f"  - {message if message is not None else 'the answer gives no reason'}"]


def validation_line(*, source: str | None, message: str) -> str:
    """One validation error, as an indented line naming its file when it has one."""
    prefix = f"{source}: " if source else ""
    return f"  - {prefix}{message}"


def is_absence(main_stuff: Any) -> bool:
    """Whether a run's main output is the absence of one: nothing at all, or the runtime's absence
    document, matched by its whole shape (exactly its keys, each of the type the runtime writes) and
    never by its `absent` key alone, since a method's own output may carry such a field. The same rule
    `cli-python` applies.
    """
    if main_stuff is None:
        return True
    if not isinstance(main_stuff, dict):
        return False
    document = cast("dict[str, Any]", main_stuff)
    if frozenset(document) != _ABSENCE_KEYS:
        return False
    kind = document["kind"]
    producing_pipe = document["producing_pipe"]
    upstream = document["upstream"]
    return (
        document["absent"] is True
        and isinstance(document["variable_name"], str)
        and isinstance(kind, str)
        and kind in _ABSENCE_KINDS
        and isinstance(document["reason"], str)
        and (producing_pipe is None or isinstance(producing_pipe, str))
        and (upstream is None or isinstance(upstream, dict))
    )


def print_result(main_stuff: Any, io: CommandIO) -> None:
    """Print a finished run's main output on stdout, as the method produced it: indented JSON,
    unvalidated and unrepaired, a list included whichever shape it arrived in. An output the method
    left absent prints `null`, and a line on stderr says so.
    """
    if is_absence(main_stuff):
        io.write_stdout("null\n")
        if isinstance(main_stuff, dict):
            document = cast("dict[str, Any]", main_stuff)
            io.write_stderr(f'The method left its output "{document["variable_name"]}" absent ({document["reason"]}), so the result is null.\n')
        else:
            io.write_stderr("The method produced no output, so the result is null.\n")
        return
    io.write_stdout(f"{to_json_text(main_stuff)}\n")
