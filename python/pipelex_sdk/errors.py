"""Pipelex SDK errors — the argument, transport, run-lifecycle, input-preparation, artifact and codegen
errors `pipelex-sdk` raises, each carrying a verdict.

Every error class this module exports says two things a program needs before anything else:
`retryable`, whether asking again can plausibly succeed, and `error_domain`, who can fix the failure
(`input`, `config` or `runtime`, `pipelex_sdk.error_verdicts.ErrorDomain`). Both are always decided,
and `pipelex_sdk.error_verdicts.error_verdict_of` reads the pair off anything an `except` holds. The
verdicts mirror `@pipelex/sdk`'s, class for class, and the case file
`tests/fixtures/error-verdicts.json` the two packages share holds them.

The errors raised over a request derive from `PipelexRequestError`, itself the protocol base
`PipelineRequestError` (`mthds.protocol.exceptions`), mirroring `@pipelex/sdk`'s `errors.ts`:

- `RequestArgumentError` — the client refused a call's arguments before sending any request.
- `ApiUnreachableError` — the HTTP exchange never produced a response (DNS / connect / TLS / timeout).
  Distinguished from `ApiResponseError`, which represents a non-2xx response that *did* come back.
- `ApiResponseError` — a non-2xx response from the API, carrying the members of its RFC 9457 problem
  document. It also subclasses `mthds`'s own `ApiResponseError`, narrowing its `validation_errors` to
  this SDK's `ValidationErrorItem`, deciding its verdict, and adding the Pipelex members the standard's
  client leaves out (`code`, `error_category`, `errors`), so every route — protocol, lifecycle and
  product alike — raises this one class.
- `PipelineExecuteTimeoutError` — a blocking `execute()` killed by the hosted gateway's ~30s
  synchronous-request ceiling; points the caller at the durable start+poll path.
- `PagingNotTerminatingError` — a paged-list iterator hit its runaway backstop, meaning the server never
  stopped handing out cursors.

The run-lifecycle errors (`RunFailedError`, `RunTimeoutError`, `RunLifecycleUnavailableError`,
`RunStillRunningError`, `MissingMainStuffError`) are owned here. `RunStillRunningError` also subclasses
`mthds`'s class of the same name, which the protocol `execute()` raises on its 202-degrade path, so a
handler written against the standard's client still catches it.

The input-preparation errors (`InputPreparationError` and its subclasses) are raised by `upload_file` and
`prepare_inputs`, before any run is created. The artifact errors (`ArtifactOperationError` and its
subclasses, plus `FieldNotIncludedError`) are the download twin of that family: they are raised only
where the artifact operations can produce no verdict at all, per-reference failure being a value on the
verdict's item. See `docs/artifact-download.md`.

The codegen tree errors (`CodegenError`, `CodegenLockError`) are not request errors at all: they are
raised by `pipelex_sdk.codegen_writer`, `pipelex_sdk.codegen_check`, `pipelex_sdk.codegen_lock` and
`pipelex_sdk.codegen_stamp` over bytes and a directory, so they derive from `Exception` rather than from
the protocol base, and declare the two verdict members themselves.

`FieldNotIncludedError` is raised by `pipelex_sdk.usage` and `pipelex_sdk.artifacts` over an
already-validated `RunResults` whose body did not carry a key the operation needs. Like
`MissingMainStuffError`, it reports a results read that did not deliver what the caller reads, so it
stays under the protocol base.

See `docs/errors.md` for the verdict of each class.
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Any

from mthds.protocol.exceptions import PipelineRequestError
from mthds.runners.api.exceptions import ApiResponseError as _MthdsApiResponseError
from mthds.runners.api.exceptions import RunStillRunningError as _MthdsRunStillRunningError

from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_domain_of, error_verdict_of, fallback_verdict
from pipelex_sdk.validation_models import ValidationErrorItem

if TYPE_CHECKING:
    from mthds.runners.api.problem import UserAction

    from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult
    from pipelex_sdk.error_models import FieldError, RunErrorReport
    from pipelex_sdk.runs import RunStatus

#: The `ApiUnreachableError.code` of a request that reached the API and that the client's own time limit
#: cut off while it was sent or answered — `@pipelex/sdk`'s code for the same case. Every other transport
#: failure carries the httpx exception's class name instead, a connect or pool timeout included.
ABORT_TIMEOUT_CODE = "ABORT_TIMEOUT"


def _verdict(error_domain: ErrorDomain, *, retryable: bool) -> ErrorVerdict:
    """A verdict; each class below declares its own with it."""
    return ErrorVerdict(error_domain=error_domain, retryable=retryable)


# ── The base every request error derives from ─────────────────────────


class PipelexRequestError(PipelineRequestError):
    """The base of every error this SDK raises over a request, carrying the verdict as two attributes:
    `retryable` and `error_domain`.

    Each subclass passes its verdict to this constructor, as the keyword `verdict`, so every class says
    its verdict where it is defined. It refines the standard's `PipelineRequestError`, so
    `except PipelineRequestError` still catches every SDK request error. To read a verdict from anything
    an `except` holds, use `pipelex_sdk.error_verdicts.error_verdict_of`, which also reads it off an
    error that is not one of these classes but carries the two members.

    The keyword arguments the constructor does not name pass on to the next class in the method
    resolution order: that is how `ApiResponseError` and `RunStillRunningError`, which also refine one of
    the standard's own classes, hand it its members. Its subclasses are meant to be raised, never this
    class itself.
    """

    #: Whether asking again can plausibly succeed. Always decided.
    retryable: bool
    #: Who can fix the failure: `input`, `config` or `runtime`. Always decided.
    error_domain: ErrorDomain

    def __init__(self, message: str, /, *, verdict: ErrorVerdict, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.retryable = verdict.retryable
        self.error_domain = verdict.error_domain


# ── Argument refusals ─────────────────────────────────────────────────


class RequestArgumentError(PipelexRequestError):
    """The SDK refused a call's arguments before sending any request: no run source given to `execute()`
    or `start()`, a protocol argument or a reserved one passed through `extra`, run sources or method
    selectors that exclude each other, a selector that is not a string, a suffixed `method_id` beside
    inline `mthds_contents`, a selector rule of `validate()`, an empty `validate_files()`, an artifact
    selection that is empty or names an unknown artifact, a suffixed id given to a method route, a `publish_method()` token that is not a
    string, a `get_method_version()` version that is not a positive integer, a value
    `parse_method_selector()` refuses, or a base URL that is not host-only. Nothing reached the API, so
    the message says what to change.

    Its verdict is `input`, not retryable — the caller must change the arguments — unless `verdict`
    declares another: the client declares `config` for a base URL that is not host-only, since it
    typically comes from `PIPELEX_BASE_URL`. A refusal the standard's own client raises before sending
    (nothing to run, a protocol argument in `extra`) is raised again as this class with the same message,
    the standard's error as its `__cause__`.
    """

    def __init__(self, message: str, *, verdict: ErrorVerdict | None = None) -> None:
        super().__init__(message, verdict=verdict or _verdict(ErrorDomain.INPUT, retryable=False))


# ── Transport and refusals ────────────────────────────────────────────


class ApiUnreachableError(PipelexRequestError):
    """Raised when the Pipelex API host cannot be reached at all.

    DNS failure, connection refused, TLS handshake failure, or a request timeout — the HTTP exchange
    never produced a response. Distinguish from `ApiResponseError`, which represents a non-2xx response
    that did come back. Every route of `PipelexAPIClient` raises it, the protocol routes it inherits from
    `mthds` included, because they all send through its `_send` override; the httpx exception is the
    `__cause__`.

    `code` names the failure: `ABORT_TIMEOUT` when the request reached the API and its time limit ran
    out while it was sent or answered (httpx's `ReadTimeout` or `WriteTimeout`), otherwise the httpx
    transport exception's class name, `ConnectError`, `ConnectTimeout` and `PoolTimeout` included, none
    of which sent the request.

    Its verdict is `config` and retryable: the address or the network must be checked, and a later
    attempt can get through. With the code `ABORT_TIMEOUT`, the SDK's own request timeout, it is
    `runtime` and retryable instead: the API took the request and did not answer in time, which is no
    fault of the base URL.

    It derives from the SDK's base directly because the `mthds` client has no unreachable error of its
    own; when it gains one, this class subclasses it.
    """

    def __init__(self, message: str, api_url: str, code: str | None = None) -> None:
        error_domain = ErrorDomain.RUNTIME if code == ABORT_TIMEOUT_CODE else ErrorDomain.CONFIG
        super().__init__(message, verdict=_verdict(error_domain, retryable=True))
        self.api_url = api_url
        self.code = code


class MethodErrorCode(StrEnum):
    """The platform codes a refusal about a stored method or one of its versions carries in `ApiResponseError.code`.

    `code` stays a `str`, since the platform adds codes; this enum names the ones a method caller
    branches on, and being a `StrEnum` each member equals its string (`match exc.code:` with
    `case MethodErrorCode.METHOD_NOT_PUBLISHED:`). Each is `input` and not retryable by the fallback
    verdict.
    """

    METHOD_UPDATE_CONFLICT = "method_update_conflict"
    """`409`: the draft moved since the token a `write_draft` or a `publish_method` sent, so nothing
    was written or published. Read the method again and decide whether to keep its draft or
    overwrite it with the fresh token."""

    METHOD_BEING_DELETED = "method_being_deleted"
    """`409`: the method's erasure has started, on every route that addresses it."""

    METHOD_NOT_PUBLISHED = "method_not_published"
    """`409`: a bare `method_id` names the latest published version and the method was never
    published. Publish it, or address its draft as `mt_…@draft`."""

    METHOD_VERSION_NOT_FOUND = "method_version_not_found"
    """`404`: `mt_…@<n>`, or `get_method_version`, names a version the method never published. An
    unknown method is `not_found` instead."""


class ApiResponseError(PipelexRequestError, _MthdsApiResponseError[ValidationErrorItem]):
    """A non-2xx response that DID come back from the API, with its problem document parsed.

    Every route of `PipelexAPIClient` raises it on a non-2xx answer: the protocol routes it inherits
    from `mthds` (`execute`, `start`, `validate`, `models`, `version`), the run status and results
    reads, the product routes and `health`. It is `mthds`'s own `ApiResponseError` narrowed to this SDK,
    so a handler written against the standard's client
    (`except mthds.runners.api.exceptions.ApiResponseError`) catches it too. Every error the hosted API
    answers is an RFC 9457 `application/problem+json` document, and this error carries its members as
    typed attributes, each `None` when the document did not carry it — except the verdict, which is
    always decided:

    - **The verdict.** `error_domain` says who can fix the failure — `input` (the caller), `config` (a
      configuration change), `runtime` (nobody beforehand) — and `retryable` whether asking again can
      succeed. Each is the document's member when the server sent a valid one, and otherwise the SDK's
      fallback (`pipelex_sdk.error_verdicts.fallback_verdict`), read from the status, the platform
      `code` and whether the body names what it refused. A runner often sends `error_domain` without
      `retryable`, and then the domain it sent decides `retryable`: `input` and `config` are not
      retryable, as a stored report that says nothing is not, since the caller or the environment must
      change, while `runtime` takes the fallback's. Nothing on the error says which a value came from:
      `problem` keeps what the server sent.
    - **What happened, for a person.** `str(exc)` names the request and the status, gives the reason
      (the problem's `detail`, else its `title`, else the raw body, else the status text) and, when
      the server advised one, the next step on its own line (`Next step: …`). `server_message` is the
      `detail` alone, `title` the stable label of the error class, `user_action` the advised next
      step (`kind` and `detail`, the `mthds` `UserAction`), and `error_category` a finer
      classification of an inference failure.
    - **The branch fields.** `error_domain`, and `type_uri` (the problem's `type`), the stable URI
      naming the error class, on every problem. Branch on these, never on the HTTP status or on the
      wording of a message; they are the fields that mean the same on both surfaces.
    - **The native codes.** `code` is the platform's own closed code (`conflict`, `not_found`,
      `pipelex_api_key_limit_reached`, …; `MethodErrorCode` names the ones about a stored method and
      its versions) and `error_type` the runner's open exception class name. Each is finer than
      `error_domain` and specific to the surface that emits it, and a client of that surface may
      branch on it: on the platform's own problems `type_uri` is derived from `code` one to one
      (`https://pipelex.com/errors/<code>`), so the two read the same answer. A problem the platform
      relays from the runner carries the runner's `type_uri` and `error_type` and no `code`.
    - **For support.** `request_id` correlates the response with the server's logs; it is read from
      the body, or from the `X-Request-ID` response header when the body has none. `instance` names
      the occurrence.
    - **Per-item failures.** `validation_errors` holds the structured diagnostics of a run route's
      refusal to run an invalid method (a `422` from `execute` or `start`), typed as
      `ValidationErrorItem`, so the failing pipe reads as `validation_errors[0].pipe_code`; it is
      `None` when the refusal is not itemized, or when an item does not fit that type (the raw list
      stays on `problem`). `errors` is the platform's field-level list (`field`, `code`, `detail`).

    `problem` is the decoded document whole, so a member this SDK does not name — the `run_status`
    and `error` of a failed run's results read, say, or the `error_domain` and `retryable` the server
    sent — stays reachable; `response_body` is the raw text, `status` / `status_text` the transport's,
    `headers` the answer's headers (lower-case names), `request_url` the URL requested and `api_url` the
    configured base URL. `problem` is `None` when the body was not a JSON object.
    """

    # The standard's error leaves both members optional, `None` meaning the runner did not say; this SDK
    # narrows them to always decided.
    retryable: bool
    error_domain: ErrorDomain

    def __init__(
        self,
        message: str,
        *,
        api_url: str,
        status: int,
        status_text: str,
        response_body: str,
        headers: dict[str, str] | None = None,
        request_url: str | None = None,
        error_type: str | None = None,
        server_message: str | None = None,
        validation_errors: list[ValidationErrorItem] | None = None,
        type_uri: str | None = None,
        title: str | None = None,
        instance: str | None = None,
        request_id: str | None = None,
        error_domain: str | None = None,
        retryable: bool | None = None,
        user_action: UserAction | None = None,
        problem: dict[str, Any] | None = None,
        code: str | None = None,
        error_category: str | None = None,
        errors: list[FieldError] | None = None,
    ) -> None:
        """Build the error: the verdict, the `mthds` members, then the Pipelex ones.

        Args:
            message: What failed and why, e.g. `API POST /v1/start failed (422): <reason>`. The next
                step is appended on its own line unless `message` already ends with it.
            api_url: The configured base URL of the API that answered.
            status: The HTTP status code of the answer.
            status_text: The HTTP reason phrase of the answer.
            response_body: The answer's body, as text.
            headers: The answer's headers, names in lower case.
            request_url: The URL the request was sent to.
            error_type: The runner's exception class name.
            server_message: The problem's `detail`, the reason for this occurrence.
            validation_errors: The per-error diagnostics of a refused run.
            type_uri: The problem's `type`, the stable URI of the error class.
            title: The problem's `title`, the stable label of the error class.
            instance: The problem's `instance`, the occurrence.
            request_id: The request's correlation id.
            error_domain: The `error_domain` the server sent, `None` when it sent none. The error's own
                `error_domain` is this when it is one of the three domains, and the fallback's otherwise.
            retryable: The `retryable` the server sent, `None` when it sent none. The error's own
                `retryable` is this when it is a boolean, and decided as the class says otherwise.
            user_action: The next step the server advises.
            problem: The decoded problem document whole.
            code: The platform's closed native code.
            error_category: The finer classification of an inference failure.
            errors: The platform's field-level failures.
        """
        verdict = _response_verdict(status=status, error_type=error_type, code=code, sent_domain=error_domain, sent_retryable=retryable)
        super().__init__(
            message,
            verdict=verdict,
            api_url=api_url,
            status=status,
            status_text=status_text,
            response_body=response_body,
            headers=headers,
            request_url=request_url,
            error_type=error_type,
            server_message=server_message,
            validation_errors=validation_errors,
            type_uri=type_uri,
            title=title,
            instance=instance,
            request_id=request_id,
            error_domain=verdict.error_domain,
            retryable=verdict.retryable,
            user_action=user_action,
            problem=problem,
        )
        self.code = code
        self.error_category = error_category
        self.errors = errors


def _response_verdict(*, status: int, error_type: str | None, code: str | None, sent_domain: object, sent_retryable: object) -> ErrorVerdict:
    """The verdict of a refused request: each member the server's own when it is valid, and the
    fallback's otherwise, except that a sent `input` or `config` domain with no sent `retryable` is not
    retryable. A `404` is named when the body carries a platform `code` or a runner `error_type`, read
    from the constructor's arguments, so an `ApiResponseError` a caller builds by hand gets the verdict
    the client would give it.
    """
    fallback = fallback_verdict(status=status, code=code, named=code is not None or error_type is not None)
    retryable = sent_retryable if isinstance(sent_retryable, bool) else None
    domain = error_domain_of(sent_domain)
    match domain:
        case None:
            return _verdict(fallback.error_domain, retryable=fallback.retryable if retryable is None else retryable)
        case ErrorDomain.RUNTIME:
            return _verdict(domain, retryable=fallback.retryable if retryable is None else retryable)
        case ErrorDomain.INPUT | ErrorDomain.CONFIG:
            # The server said who fixes the failure and nothing of a retry. When the caller or the
            # environment must change, asking again unchanged meets the same answer, whatever the
            # status would suggest.
            return _verdict(domain, retryable=False if retryable is None else retryable)


class PipelineExecuteTimeoutError(PipelexRequestError):
    """Raised when a blocking `execute()` (`POST /v1/execute`) is killed by the hosted
    gateway's ~30s synchronous-request ceiling.

    The blocking path cannot run methods longer than ~30s behind the hosted gateway — use
    the durable run lifecycle (`start` + `wait_for_result`, or `start_and_wait`) instead,
    which survives long runs and client disconnects. `elapsed_seconds` is how long the
    request ran before the gateway cut it off.

    Its verdict is `input`, not retryable: asking again meets the same limit, and the caller fixes it by
    starting the run and polling.
    """

    def __init__(self, message: str, elapsed_seconds: float) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.INPUT, retryable=False))
        self.elapsed_seconds = elapsed_seconds


# ── The run lifecycle ─────────────────────────────────────────────────


class RunFailedError(PipelexRequestError):
    """Raised when a run reaches a terminal state that is not `COMPLETED`.

    Surfaced by `wait_for_result`, `start_and_wait` and `download_artifacts` when the platform
    answers the results read with HTTP 409 (`FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`).

    - `status` is the run's terminal status, the typed `RunStatus` enum, read from the problem's
      `run_status` member — so callers can match/case on it.
    - `error` is the run's stored error report, typed whole as `RunErrorReport`: the runner's
      `error_type`, `message`, `title`, `type_uri`, `error_domain`, `error_category`, `retryable`,
      `user_action`, `model`, `provider`, `provider_metadata`, `validation_errors` and anything newer
      on `model_extra`. Branch on `error.error_domain`, `error.type_uri` and `error.retryable`; show
      `error.user_action` as the next step. It is the runner's VERBOSE report, so `message` and
      `provider_metadata` can hold a provider's raw text — deciding what a person sees is yours.
      `None` when the run ended with no stored report (a cancelled, terminated or timed-out run, or
      one the platform finalized itself).
    - The exception's own message is the problem's `detail`, which names the status and then the
      report's message (`Run finished with status FAILED: <message>`), so printing the error already
      tells the reason.
    - `run_id` locates the run, for a status read or a support request.

    Its verdict comes from the report. `error_domain` is the report's `error_domain` when it is one of
    the three domains, and `runtime` otherwise, including a run with no report. `retryable` is true only
    when the report's `retryable` is `True`: a report that says nothing, and a run with none, read as not
    retryable, since starting the run again spends credit and nothing says it would succeed. The report
    keeps its own `retryable` as written, so a consumer that words the unknown differently still can.
    """

    def __init__(self, message: str, run_id: str, status: RunStatus, error: RunErrorReport | None = None) -> None:
        super().__init__(message, verdict=_run_failure_verdict(error))
        self.run_id = run_id
        self.status = status
        self.error = error


def _run_failure_verdict(report: RunErrorReport | None) -> ErrorVerdict:
    """The verdict of a failed run, read from its stored report."""
    if report is None:
        return _verdict(ErrorDomain.RUNTIME, retryable=False)
    return _verdict(error_domain_of(report.error_domain) or ErrorDomain.RUNTIME, retryable=report.retryable is True)


class RunTimeoutError(PipelexRequestError):
    """Raised when `wait_for_result` exceeds its timeout before the run is terminal.

    The run is NOT cancelled — it keeps executing server-side and can be resumed
    later by `run_id` (the poll loop just stopped waiting).

    Its verdict is `runtime` and retryable: the run is still going, and waiting again can succeed.
    """

    def __init__(self, message: str, run_id: str, timeout_seconds: float) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.RUNTIME, retryable=True))
        self.run_id = run_id
        self.timeout_seconds = timeout_seconds


class RunStillRunningError(PipelexRequestError, _MthdsRunStillRunningError):
    """Raised when a run asked for its result is still running.

    `execute()` raises it when the server answers `202` instead of a final result: the MTHDS Protocol
    permits an implementation to degrade a synchronous `/execute` into an accepted-async response when
    it cannot hold the connection open. `download_artifacts` raises it for a run read by id that has not
    completed yet. Either way the run keeps executing server-side — resume by `run_id` (the durable run
    lifecycle on a hosted deployment, or the `location` status resource when provided);
    `retry_after_seconds` is the server's hint, when it gave one.

    It also subclasses `mthds`'s class of the same name, which the protocol `execute()` raises, so a
    handler written against the standard's client catches it too.

    Its verdict is `runtime` and retryable: the run is still going, and is resumed by its id.
    """

    def __init__(self, message: str, run_id: str, retry_after_seconds: int | None = None, location: str | None = None) -> None:
        super().__init__(
            message,
            verdict=_verdict(ErrorDomain.RUNTIME, retryable=True),
            run_id=run_id,
            retry_after_seconds=retry_after_seconds,
            location=location,
        )


class MissingMainStuffError(PipelexRequestError):
    """Raised when a completed run cannot deliver its main stuff.

    Every completed run delivers a main stuff (the pipelex >= 0.37 wire invariant), so the SDK
    hands consumers a non-null `RunResults.main_stuff`. This surfaces the contract violation when it
    cannot: the hosted results endpoint answered a `200` with a null `main_stuff`, or a blocking
    `execute` response named a `main_stuff_name` whose stuff is absent from the returned working
    memory. `run_id` locates the run. (A falsy-but-present main stuff — an empty list, `0` — is a
    valid output and does NOT raise; only a genuinely absent one does.)

    Its verdict is `runtime`, not retryable: the API broke its own contract on a completed run.
    """

    def __init__(self, message: str, run_id: str) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.RUNTIME, retryable=False))
        self.run_id = run_id


class RunLifecycleUnavailableError(PipelexRequestError):
    """Raised when the durable run lifecycle (`/v1/runs/*`) is not served by the
    configured `PIPELEX_BASE_URL`.

    Run polling is a hosted-API extension, not part of the MTHDS Protocol: the
    open-source `pipelex-api` runner executes methods but has no run store, so it
    404s those routes; only a deployment that includes the platform block (the
    Pipelex Hosted API) serves status/results. Distinguished from a genuine
    run-not-found 404, which carries the platform's structured error envelope.

    Its verdict is `config`, not retryable: the base URL points at a bare runner without the run
    lifecycle.
    """

    def __init__(self, message: str, api_url: str) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False))
        self.api_url = api_url


class PagingNotTerminatingError(PipelexRequestError):
    """Raised when a paged-list iterator refuses to keep following cursors.

    The ceiling sits far beyond any real catalog, so reaching it is a server-side fault —
    an endpoint minting a fresh cursor forever — not a coverage limit the caller can raise.
    Raising beats returning, because a silently truncated list is exactly the bug paging
    was introduced to remove. Its verdict is `runtime`, not retryable.
    """

    def __init__(self, message: str, page_limit: int) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.RUNTIME, retryable=False))
        self.page_limit = page_limit


# ── Input preparation ─────────────────────────────────────────────────


class InputPreparationError(PipelexRequestError):
    """Base class for every failure raised by input preparation (`upload_file` /
    `prepare_inputs`).

    Catch this to handle any preparation failure; catch a subclass to branch on the
    semantic category. All preparation failures are raised BEFORE any run is created —
    a run never triggers a hidden upload. Mirrors `@pipelex/sdk`'s
    `InputPreparationError` family.

    Its verdict is `input`, not retryable — the asset, the inputs or the method selector must change —
    unless `verdict` declares another: the SDK's own subclasses do, and so can a consumer's, such as a
    form reporting a missing input in its own words.
    """

    def __init__(self, message: str, *, verdict: ErrorVerdict | None = None) -> None:
        super().__init__(message, verdict=verdict or _verdict(ErrorDomain.INPUT, retryable=False))


class InvalidLocalSourceError(InputPreparationError):
    """A local asset could not be turned into bytes — a missing or unreadable path.
    `source` is the offending path.
    """

    def __init__(self, message: str, source: str) -> None:
        super().__init__(message)
        self.source = source


class InvalidInputValueError(InputPreparationError):
    """A value the caller gave at a file input cannot be turned into a file to upload: a `data:` URL
    that does not decode (no comma, bad base64), or a value of a type no file input takes, neither a
    path or URL string, nor `bytes` or a `Path`, nor `{url}` content. `prepare_inputs` raises it while
    it reads the inputs, before anything is uploaded. As with `InvalidLocalSourceError`, the inputs are
    what must change, which is how a consumer tells it apart from `MethodLoadError`, a method that does
    not load, raised by the same preparation. The twin of `@pipelex/sdk`'s class of the same name.
    """


class MethodLoadError(InputPreparationError):
    """The pipe I/O answer said the method does not load (`is_valid: false`), so its signature cannot
    be read and no input can be prepared: the method, not the inputs, must change.

    `validation_errors` holds the answer's items, possibly none, and `server_message` the answer's own
    `message`. The error's message names the first item's message, else the answer's own. The twin of
    `@pipelex/sdk`'s class of the same name, whose `validationErrors` and `serverMessage` these are.
    """

    def __init__(self, message: str, *, validation_errors: list[ValidationErrorItem], server_message: str | None = None) -> None:
        super().__init__(message)
        self.validation_errors = validation_errors
        self.server_message = server_message


class RejectedAssetCode(StrEnum):
    """Why an asset was refused, in a closed vocabulary a caller branches on rather than on the message.

    The vocabulary is `@pipelex/sdk`'s, shared so a consumer of both SDKs branches on one set.
    `upload_file` raises `too_large`, the upload route's `413` past the service-defined size cap. The
    others name the refusals of storage to an upload made with a grant, which `@pipelex/sdk`'s
    `uploadWithGrant` performs: `grant_used` — the grant already wrote its object (`412`);
    `grant_expired` — the grant's validity window has passed; `signature_mismatch` — the file's size,
    content type or metadata differ from what the grant signed; `unsigned_header` — the request carried a
    storage header the grant did not sign; `store_refused` — any other refusal from storage.
    """

    TOO_LARGE = "too_large"
    GRANT_USED = "grant_used"
    GRANT_EXPIRED = "grant_expired"
    SIGNATURE_MISMATCH = "signature_mismatch"
    UNSIGNED_HEADER = "unsigned_header"
    STORE_REFUSED = "store_refused"


class RejectedAssetError(InputPreparationError):
    """The server refused the asset — most commonly a `413` past the service-defined
    size cap. The SDK imposes no client-side cap; it surfaces the server's rejection.
    `filename` and `status` locate it, and `code` says why: the SDK sets it on every one it raises, so
    it is `None` only on one a caller constructs without it. Its verdict is `input`, not retryable,
    whatever the code: the asset, or the grant it was sent with, must change before a retry can pass.
    """

    def __init__(self, message: str, filename: str, status: int, *, code: RejectedAssetCode | None = None) -> None:
        super().__init__(message)
        self.filename = filename
        self.status = status
        self.code = code


class UnsupportedUploadCapabilityError(InputPreparationError):
    """The configured deployment does not support upload (no `/v1/upload` route, seen
    as a `404`). Upload is a hosted Pipelex-product capability even though the SDK can
    be pointed at other base URLs. `filename` is the file whose upload met it, as `upload_file`
    sent it; the route's `ApiResponseError` is its `__cause__`. Its verdict is `config`, not
    retryable: the base URL must point at a deployment that serves upload.
    """

    def __init__(self, message: str, *, filename: str | None = None) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False))
        self.filename = filename


class UploadAuthenticationError(InputPreparationError):
    """Upload was not authorized — a `401`/`403` from the upload route. `filename` is the file
    whose upload was refused, as `upload_file` sent it. Its verdict is `config`, not retryable: the
    credential must change.
    """

    def __init__(self, message: str, status: int, *, filename: str | None = None) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False))
        self.status = status
        self.filename = filename


class UploadTransportCode(StrEnum):
    """Which transport failure an upload met, in a closed vocabulary a caller branches on rather than on
    the message.

    The vocabulary is `@pipelex/sdk`'s, shared so a consumer of both SDKs branches on one set.
    `upload_file` raises the first three and `unexpected`; the others name the failures of an upload to
    storage made with a grant, which `@pipelex/sdk`'s `uploadWithGrant` performs.

    - `timeout` — the SDK's own time limit ran out before an answer came back (the client's request
      timeout, `ApiUnreachableError` with code `ABORT_TIMEOUT`). Whether the file was stored is unknown.
    - `unreachable` — no response reached the SDK.
    - `server_error` — a `5xx`. Whether the file was stored is unknown, except after a `501`: the
      deployment does not implement the request it was sent, and stored nothing.
    - `storage_timeout` — storage's `400 RequestTimeout`: it stopped waiting for the file's bytes and
      stored nothing.
    - `conflict` — storage's `409 ConditionalRequestConflict`: another write with the same grant was in
      flight.
    - `redirected` — storage redirected the write, and the redirect was refused.
    - `invalid_grant_url` — the grant's `url` is not an absolute `http(s)` URL free of user info, so
      nothing was sent.
    - `unexpected` — a status or a failure the SDK has no specific mapping for.
    """

    TIMEOUT = "timeout"
    UNREACHABLE = "unreachable"
    SERVER_ERROR = "server_error"
    STORAGE_TIMEOUT = "storage_timeout"
    CONFLICT = "conflict"
    REDIRECTED = "redirected"
    INVALID_GRANT_URL = "invalid_grant_url"
    UNEXPECTED = "unexpected"


class UploadTransportError(InputPreparationError):
    """A network or server fault reaching the upload route (unreachable host, `5xx`), or any other
    status the route answered. `status` is the HTTP status when an answer produced it and `None`
    when none came back; `filename` is the file it was sending; `code` says which failure it was: the
    SDK sets it on every one it raises, so it is `None` only on one a caller constructs without it. From
    `upload_file` the `ApiResponseError` or `ApiUnreachableError` the client raised is its `__cause__`.

    Its verdict is the wrapped error's when `cause` carries one: `upload_file` passes the error the
    client's `upload()` raised, and `code` is too coarse to judge it by (a `402` plan limit is
    `unexpected`, like any status the SDK has no mapping for), so a wrapped `402` is `config` and not
    retryable. Pass the same error as `cause` and raise this one `from` it. Otherwise `code` decides:
    `timeout`, `storage_timeout` and `conflict` are `runtime` and retryable, `conflict` because storage
    documents its `409 ConditionalRequestConflict` as retryable and the grant is not spent by it;
    `server_error` is `runtime`, and retryable when the fallback table a refused API request reads would
    call its `status` retryable — any `5xx` but a `501` — or when it carries no status; `unexpected` is
    `runtime`, and retryable when that table would call its `status` retryable — a `408` or a `429`,
    refused for its timing — and not retryable for any other status or none; `unreachable` is `config`
    and retryable, like `ApiUnreachableError`; `redirected` is `config` and not retryable;
    `invalid_grant_url`, and no code at all, are `runtime` and not retryable.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        filename: str | None = None,
        code: UploadTransportCode | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message, verdict=error_verdict_of(cause) or _upload_transport_verdict(code=code, status=status))
        self.status = status
        self.filename = filename
        self.code = code


def _upload_transport_verdict(*, code: UploadTransportCode | None, status: int | None) -> ErrorVerdict:
    """The verdict of an upload transport failure that wraps no error carrying one."""
    match code:
        case UploadTransportCode.TIMEOUT | UploadTransportCode.STORAGE_TIMEOUT | UploadTransportCode.CONFLICT:
            return _verdict(ErrorDomain.RUNTIME, retryable=True)
        case UploadTransportCode.SERVER_ERROR:
            # A fault may pass, but a 501 says the request is not implemented, and sending it again will
            # not change that. The status reads as an API's would.
            return _verdict(ErrorDomain.RUNTIME, retryable=status is None or _status_is_retryable(status))
        case UploadTransportCode.UNEXPECTED:
            # A 408 or a 429 refused the request for its timing, which a later attempt can pass; any other
            # status, or none, says nothing of the kind.
            return _verdict(ErrorDomain.RUNTIME, retryable=status is not None and _status_is_retryable(status))
        case UploadTransportCode.UNREACHABLE:
            return _verdict(ErrorDomain.CONFIG, retryable=True)
        case UploadTransportCode.REDIRECTED:
            return _verdict(ErrorDomain.CONFIG, retryable=False)
        case UploadTransportCode.INVALID_GRANT_URL | None:
            return _verdict(ErrorDomain.RUNTIME, retryable=False)


def _status_is_retryable(status: int) -> bool:
    """Whether the fallback table calls a status retryable, read as a named answer from a store: a `408`, a
    `429`, or a `5xx` other than `501`.
    """
    return fallback_verdict(status=status, code=None, named=True).retryable


# ── Codegen trees ─────────────────────────────────────────────────────


class CodegenError(Exception):
    """A codegen tree this SDK refuses to write or read.

    Raised before the first byte is written when a `/v1/codegen` response, or the directory it is
    headed for, is unsafe: a `lock_filename` other than `codegen.lock`, an artifact path that could
    leave the output root or name a file type codegen never emits (absolute or drive-prefixed, a `..`
    or empty component, a backslash, a control character, an unstampable suffix, a duplicate), a lock
    that cannot be read or does not track exactly the artifacts, a symbolic link or a regular file on
    the way to a destination, a symbolic link on the way to a previously tracked path about to be pruned,
    a destination or such a path that is not a regular file, or a file already at an artifact's path that
    codegen does not own.

    Nothing was requested over the wire, so it derives from `Exception` rather than from the protocol
    base, and declares the verdict itself: `input`, not retryable. The output directory, the files in it
    or the report written into it must change, and writing the same tree again meets the same refusal.
    """

    #: Whether asking again can plausibly succeed: never, for a tree refused as it stands.
    retryable: bool
    #: Who can fix the failure: the caller, whose directory and report these are.
    error_domain: ErrorDomain

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.retryable = False
        self.error_domain = ErrorDomain.INPUT


class CodegenLockError(CodegenError):
    """A `codegen.lock` that cannot be read: malformed TOML, a shape the format does not define,
    bytes that are not UTF-8, or a `lock_version` this SDK does not know.

    It is also the offline check's one no-verdict class, raised where that check can reach no verdict at
    all rather than find a drift — including a file or directory under the output root the process cannot
    read, so a CI caller has a single thing to catch.

    An unsafe artifact path inside an otherwise well-formed lock is deliberately NOT this error but a
    plain `CodegenError`: it is a containment violation, not corrupt state a writer may recover from
    by replacing the lock.

    Its verdict is `CodegenError`'s, `input` and not retryable: the lock is the caller's own file, as
    `@pipelex/sdk`'s `CodegenLockError` says.
    """


# ── Artifact operations ───────────────────────────────────────────────


class ArtifactOperationError(PipelexRequestError):
    """Base class for the failures the artifact operations raise on their own
    (`fetch_artifact` / `download_artifacts`) — the download twin of `InputPreparationError`.

    Catch this to handle any artifact failure; catch a subclass to branch on the category. A
    per-reference failure inside a `download_artifacts` verdict is a **value on the item**, never
    one of these: the operation throws only when it can produce no verdict at all. The transport
    failures of the resolve route (`ApiResponseError`, `ApiUnreachableError`) and the run-lifecycle
    errors propagate unchanged, so they are not subclasses. Mirrors `@pipelex/sdk`'s
    `ArtifactOperationError` family.

    Its verdict is `runtime`, not retryable, unless `verdict` declares another: the SDK declares `input`
    where it refuses an argument (a `scope`, a bound, a location, both selectors or neither) and `config`
    where the environment refuses the download (a directory that cannot be created).
    """

    def __init__(self, message: str, *, verdict: ErrorVerdict | None = None) -> None:
        super().__init__(message, verdict=verdict or _verdict(ErrorDomain.RUNTIME, retryable=False))


class ScopeUnavailableError(ArtifactOperationError):
    """The scope `download_artifacts` was asked to walk is `None` on the run's results.

    The key WAS relayed — it is in `results.model_fields_set` — and its value is `None`, which is
    the platform saying it has no such artifact for this run. Distinct from a key the results read
    never carried, which is `FieldNotIncludedError`, and from an empty walk over a present scope,
    which is a produced verdict with no artifacts. `scope` names the scope, `run_id` the run. Its
    verdict is the family's, `runtime` and not retryable.
    """

    def __init__(self, scope: ArtifactScope, run_id: str) -> None:
        msg = f'Run "{run_id}" carries no "{scope}" artifact to walk for produced files — the results relayed it as null.'
        super().__init__(msg)
        self.scope = scope
        self.run_id = run_id


class ArtifactFetchError(ArtifactOperationError):
    """One reference could not be turned into a bounded stream by `fetch_artifact`.

    `code` says why, in a closed vocabulary the download verdict shares for its per-item errors:
    the resolve route's own per-reference codes (`invalid_storage_uri`, `forbidden`), then the
    fetch boundary's — `unsupported_url`, `plain_http_refused`, `redirect_refused`, `store_refused`
    (a 401/403 from the object store), `not_found` (404/410), `store_error` (any other non-2xx),
    `too_large`, `timeout`, `network`. `status` is the store's HTTP status when one was received.
    `download_artifacts` never lets this escape: it becomes the item's `error`.

    Its verdict follows `code`: `invalid_storage_uri`, `forbidden`, `unsupported_url`, `not_found` and
    `too_large` are `input` and not retryable, since the reference or the bound must change;
    `plain_http_refused` is `config` and not retryable; `redirect_refused` and `store_refused` are
    `runtime` and not retryable; `timeout` and `network` are `runtime` and retryable; `store_error` is
    `runtime`, and retryable when the fallback table a refused API request reads would call its `status`
    retryable — a `408`, a `429` or a `5xx` other than `501` — and not retryable for any other status or
    none. A code this version does not know is `runtime` and not retryable.
    """

    def __init__(self, message: str, uri: str, code: str, status: int | None = None) -> None:
        super().__init__(message, verdict=_artifact_fetch_verdict(code=code, status=status))
        self.uri = uri
        self.code = code
        self.status = status


def _artifact_fetch_verdict(*, code: str, status: int | None) -> ErrorVerdict:
    """The verdict of one reference's fetch failure, by its code and the store's status."""
    match code:
        case "invalid_storage_uri" | "forbidden" | "unsupported_url" | "not_found" | "too_large":
            return _verdict(ErrorDomain.INPUT, retryable=False)
        case "plain_http_refused":
            return _verdict(ErrorDomain.CONFIG, retryable=False)
        case "timeout" | "network":
            return _verdict(ErrorDomain.RUNTIME, retryable=True)
        case "store_error":
            # The store's status reads as an API's would: refused for its timing (408, 429) or a fault
            # that may pass (a 5xx) can succeed on a retry, while a 501 or a 4xx will not.
            return _verdict(ErrorDomain.RUNTIME, retryable=status is not None and _status_is_retryable(status))
        case _:
            # `redirect_refused`, `store_refused`, and a code this version does not know.
            return _verdict(ErrorDomain.RUNTIME, retryable=False)


class ArtifactAuthenticationError(ArtifactOperationError):
    """The resolve route refused the caller's credential (`401` / `403`) during a download.

    No further reference can be resolved with it, so the download stops — but the files already
    saved are real, and `verdict` carries the result as it stood: every item saved before the
    refusal, and the rest marked `aborted`. `status` is the route's status; the wrapped
    `ApiResponseError` is reachable through `__cause__`. (`verdict` is the download's result, not the
    error's own: that is `retryable` and `error_domain`, `config` and not retryable, since the credential
    must change.)
    """

    def __init__(self, message: str, status: int, verdict: DownloadArtifactsResult) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False))
        self.status = status
        self.verdict = verdict


class FieldNotIncludedError(PipelexRequestError):
    """A `RunResults` field this operation needs was not carried by the results body it was read from.

    Raised when the field is absent from `results.model_fields_set` — the body did not carry the key —
    as opposed to relayed as `None`, which is a value. Carries the field's name in `field_name`.

    Its verdict is `input`, not retryable, unless `verdict` declares another: the results a caller hands
    over were read without the field, so the caller reads them again asking for it. `download_artifacts`
    declares `runtime` when it read the results itself, asking for the field, and the API did not carry
    it, which breaks the API's own contract.
    """

    def __init__(self, field_name: str, *, verdict: ErrorVerdict | None = None) -> None:
        msg = f"RunResults field `{field_name}` was not in the results body: the read did not carry it"
        super().__init__(msg, verdict=verdict or _verdict(ErrorDomain.INPUT, retryable=False))
        self.field_name = field_name
