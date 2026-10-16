"""Pipelex SDK errors — the argument, transport, run-lifecycle, input-preparation, artifact and codegen
errors `pipelex-sdk` raises, each carrying a verdict.

Every error class this module exports says what a program needs to know before anything else:
`retryable`, whether asking again can plausibly succeed, and `error_domain`, who can fix the failure
(`input`, `config` or `runtime`, `pipelex_sdk.error_verdicts.ErrorDomain`). Both are always decided,
and `pipelex_sdk.error_verdicts.error_verdict_of` reads the pair off anything an `except` holds. A
request error also says, as `run_may_have_started`, whether a failed start or execute may still have
started a run, which `pipelex_sdk.error_verdicts.run_may_have_started_of` reads. The verdicts mirror
`@pipelex/sdk`'s, class for class, and the case file `tests/fixtures/error-verdicts.json` the two
packages share holds them.

The errors raised over a request derive from `PipelexRequestError`, itself the protocol base
`PipelineRequestError` (`mthds.protocol.exceptions`), mirroring `@pipelex/sdk`'s `errors.ts`. Each
carries, beside its verdict, the base's `problem`: the failure as the standard's problem document
under a registered code (see "The standard's problem" below).

- `RequestArgumentError` — the client refused a call's arguments before sending any request.
- `ApiUnreachableError` — the HTTP exchange never produced a response (DNS / connect / TLS / timeout).
  Distinguished from `ApiResponseError`, which represents a non-2xx response that *did* come back. It
  also subclasses `mthds`'s own `ApiTransportError`.
- `ApiResponseError` — a non-2xx response from the API, carrying the members of its RFC 9457 problem
  document as the hosted plane sends them. It also subclasses `mthds`'s own `ApiResponseError`, whose
  `problem` is the standard's reading of the same answer, deciding its verdict and adding the hosted
  members the standard's error leaves out (`code`, `error_category`, `errors`, `validation_errors`,
  `user_action`, …), so every route — protocol, lifecycle and product alike — raises this one class.
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
the protocol base, and declare the verdict members themselves.

`FieldNotIncludedError` is raised by `pipelex_sdk.usage` and `pipelex_sdk.artifacts` over an
already-validated `RunResults` whose body did not carry a key the operation needs. Like
`MissingMainStuffError`, it reports a results read that did not deliver what the caller reads, so it
stays under the protocol base.

**The standard's problem.** `exc.problem` is a `mthds.protocol.problem.models.Problem` on every error
this module raises over a request. On `ApiResponseError` it is the standard's reading of the answer,
the one the `mthds` client gives the same answer: the body's own problem document when it is one, and
otherwise the problem the client reads from the status (`client.response_unreadable`,
`client.outcome_unknown` on a route that creates a run, …), except that on a `start` or an `execute` the
error's `run_may_have_started` decides: `client.outcome_unknown` wherever a run may have started, whatever
the body, and the reading of a request that creates no run wherever none did (`answer_reading`). On
`ApiUnreachableError` it is the
transport's (`client.unreachable`, `client.timeout`, `client.outcome_unknown`). On an error wrapping
another, an upload refused by the API say, it is the wrapped error's. On every other error it is the
core code the class states, built from the registry by `make_client_problem`. The problem never decides
the verdict, which stays the SDK's own (`retryable`, `error_domain`, `run_may_have_started`), and
`str(exc)` stays the SDK's message: unlike the `mthds` errors, this module's do not append the
problem's next step to it, since the hosted plane's own advice, when it gave one, is already there.

See `docs/errors.md` for the verdict of each class.
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Any, cast

import httpx
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.answers import AnswerReading, decode_json, read_answer, unreadable_answer
from mthds.protocol.problem.client_problems import make_client_problem
from mthds.protocol.problem.registry import CoreCode
from mthds.runners.api.exceptions import ApiResponseError as _MthdsApiResponseError
from mthds.runners.api.exceptions import ApiTransportError as _MthdsApiTransportError
from mthds.runners.api.exceptions import RunStillRunningError as _MthdsRunStillRunningError
from mthds.runners.api.problem import transport_failure_problem

from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_domain_of, error_verdict_of, fallback_verdict
from pipelex_sdk.run_may_have_started import answer_may_have_started_run, transport_may_have_started_run

if TYPE_CHECKING:
    from collections.abc import Mapping

    from mthds.protocol.problem.models import Problem

    from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult
    from pipelex_sdk.error_models import FieldError, ProblemUserAction, RunErrorReport
    from pipelex_sdk.runs import RunStatus
    from pipelex_sdk.validation_models import ValidationErrorItem

#: The `ApiUnreachableError.code` of a request that reached the API and that the client's own time limit
#: cut off while it was sent or answered — `@pipelex/sdk`'s code for the same case. Every other transport
#: failure carries the httpx exception's class name instead, a connect or pool timeout included.
ABORT_TIMEOUT_CODE = "ABORT_TIMEOUT"

# The reason `client.argument_invalid` names when an argument refusal is built from a message alone,
# which says what was refused only in words.
_UNSPECIFIED_REASON = "unspecified"


def _verdict(error_domain: ErrorDomain, *, retryable: bool) -> ErrorVerdict:
    """A verdict; each class below declares its own with it."""
    return ErrorVerdict(error_domain=error_domain, retryable=retryable)


# ── The standard's problems this module states ────────────────────────


def argument_invalid_problem(*, argument: str, reason: str) -> Problem:
    """The problem of an argument refused before any request left: `client.argument_invalid`.

    The problem a `RequestArgumentError`, and an input-preparation or artifact refusal of an argument,
    carries.

    Args:
        argument: The argument refused, by name (`idempotency_key`, `files`, …).
        reason: Why it was refused, as an identifier (`not_a_string`, `mutually_exclusive`, `empty`, …).

    Returns:
        `client.argument_invalid` naming the argument and the reason.
    """
    return make_client_problem(CoreCode.CLIENT_ARGUMENT_INVALID, params={"argument": argument, "reason": reason})


def response_unreadable_problem(*, status: int, pipeline_run_id: str | None = None) -> Problem:
    """The problem of an answer the client cannot use as the route's answer: `client.response_unreadable`.

    Args:
        status: The HTTP status of the answer.
        pipeline_run_id: The run the answer is about, when there is one.

    Returns:
        `client.response_unreadable` naming the status, and the run as its member when given.
    """
    return make_client_problem(CoreCode.CLIENT_RESPONSE_UNREADABLE, params={"status": status}, pipeline_run_id=pipeline_run_id)


def _credential_refused_problem(*, credential_sent: bool) -> Problem:
    """The problem of a request refused for its credential (a `401` or a `403`).

    Args:
        credential_sent: Whether the request carried a credential: the client holds a non-empty API key.

    Returns:
        `auth.invalid_credential` when the request carried a credential, and `auth.missing_credential`
        when it carried none, as a client with no API key sends its requests.
    """
    return make_client_problem(CoreCode.AUTH_INVALID_CREDENTIAL if credential_sent else CoreCode.AUTH_MISSING_CREDENTIAL)


def _outcome_unknown_problem(*, pipeline_run_id: str | None = None) -> Problem:
    """`client.outcome_unknown`, naming the run in its parameters and as its member when its id is known."""
    if pipeline_run_id is None:
        return make_client_problem(CoreCode.CLIENT_OUTCOME_UNKNOWN)
    return make_client_problem(CoreCode.CLIENT_OUTCOME_UNKNOWN, params={"pipeline_run_id": pipeline_run_id}, pipeline_run_id=pipeline_run_id)


def _status_problem(status: int) -> Problem:
    """The problem the standard reads from an answer's status alone, as for a body that is no problem document."""
    return read_answer(status=status, body="", headers={}, creates_run=False).problem


# ── The base every request error derives from ─────────────────────────


class PipelexRequestError(PipelineRequestError):
    """The base of every error this SDK raises over a request, carrying the verdict as attributes,
    `retryable` and `error_domain`, and a third, `run_may_have_started`.

    Each subclass passes its verdict to this constructor, as the keyword `verdict`, so every class says
    its verdict where it is defined, and its problem, as the keyword `problem`, which the standard's
    `PipelineRequestError` keeps as `problem`. `run_may_have_started` is `False` unless the subclass passes it:
    only `ApiUnreachableError` and `ApiResponseError` built for a request that may create a run, and
    `PipelineExecuteTimeoutError`, ever carry it as `True`, and when they do, `retryable` is `False`
    whatever the verdict passed. It refines the standard's `PipelineRequestError`, so
    `except PipelineRequestError` still catches every SDK request error. To read a verdict from anything
    an `except` holds, use `pipelex_sdk.error_verdicts.error_verdict_of`, which also reads it off an
    error that is not one of these classes but carries both members, and
    `pipelex_sdk.error_verdicts.run_may_have_started_of` for the third member.

    The keyword arguments the constructor does not name pass on to the next class in the method
    resolution order: that is how `ApiResponseError`, `ApiUnreachableError` and `RunStillRunningError`,
    which also refine one of the standard's own classes, hand it its members. Its subclasses are meant
    to be raised, never this class itself.

    `str(exc)` is the message the subclass gives, as it was before the standard's errors carried a
    problem: the standard's `PipelineRequestError` appends the problem's next step to its message, and
    this constructor sets the message back, since an SDK message already says what to change and the
    hosted plane's own advice, when it gave one, already rides it (`ApiResponseError`).
    """

    #: Whether asking again can plausibly succeed. Always decided.
    retryable: bool
    #: Who can fix the failure: `input`, `config` or `runtime`. Always decided.
    error_domain: ErrorDomain
    #: Whether the failed request may still have started a run whose id never reached the caller: a `start`
    #: or an `execute` (and so `start_and_wait`'s start, or the blocking execute it falls back to) that
    #: failed in a way that does not prove the server started nothing. When it is `True`, `retryable` is
    #: `False`: look the run up in the run history before starting it again. `False` for every other
    #: request, a wait on a run already named included. Always decided.
    run_may_have_started: bool

    def __init__(self, message: str, /, *, verdict: ErrorVerdict, problem: Problem, run_may_have_started: bool = False, **kwargs: Any) -> None:
        super().__init__(message, problem=problem, **kwargs)
        # The standard's base appended the problem's next step; the SDK's message is its own. Pickling
        # rebuilds the error from these args, so it keeps the same message.
        self.args = (message,)
        self.run_may_have_started = run_may_have_started
        # Asking again could start a second run, so a run that may have started is never retryable.
        self.retryable = False if run_may_have_started else verdict.retryable
        self.error_domain = verdict.error_domain


# ── Argument refusals ─────────────────────────────────────────────────


class RequestArgumentError(PipelexRequestError):
    """The SDK refused a call's arguments before sending any request: no run source given to `execute()`
    or `start()`, a protocol argument or a reserved one passed through `extra`, run sources or method
    selectors that exclude each other, a selector that is not a string, a suffixed `method_id` beside
    inline `mthds_contents`, a selector rule of `validate()`, an empty `validate_files()`, an artifact
    selection that is empty or names an unknown artifact, a suffixed id given to a method route, a `publish_method()` token that is not a
    string, a `get_method_version()` version that is not a positive integer, a value
    `parse_method_selector()` refuses, a start's `idempotency_key` that is not 1 to 255 visible ASCII
    characters, or a base URL that is not host-only. Nothing reached the API, so the message says what
    to change.

    Its verdict is `input`, not retryable — the caller must change the arguments — unless `verdict`
    declares another: the client declares `config` for a base URL that is not host-only, since it
    typically comes from `PIPELEX_BASE_URL`. A refusal the standard's own client raises before sending
    (nothing to run, a protocol argument in `extra`, a request time limit it cannot state) is raised
    again as this class with the same message and the standard's problem, the standard's error as its
    `__cause__`.

    `problem` is `client.argument_invalid` naming the argument and why it was refused
    (`argument_invalid_problem`), or `client.not_configured` naming the setting for a base URL that is
    not host-only. The SDK states one on every refusal it raises; one built with none, from a message
    alone, carries `client.argument_invalid` naming `arguments`, for the reason `unspecified`.
    """

    def __init__(self, message: str, *, problem: Problem | None = None, verdict: ErrorVerdict | None = None) -> None:
        super().__init__(
            message,
            verdict=verdict or _verdict(ErrorDomain.INPUT, retryable=False),
            problem=problem or argument_invalid_problem(argument="arguments", reason=_UNSPECIFIED_REASON),
        )


# ── Transport and refusals ────────────────────────────────────────────


class ApiUnreachableError(PipelexRequestError, _MthdsApiTransportError):
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

    On a request that may create a run (`may_start_run`, which the client sets on `start` and `execute`),
    `run_may_have_started` is `True` unless `failure`, the httpx exception the request met, proves the
    request never left: the connection or the TLS handshake failed, or no connection came. A read or
    write timeout, a connection closed once the request had left or a body that could not be decoded
    proves nothing, so the run may have started and the error is not retryable.

    It also subclasses `mthds`'s `ApiTransportError`, the standard client's error for a request that
    got no answer, so a handler written against the standard's client catches it too. Its `problem` is
    `client.outcome_unknown` when the run may have started, and otherwise the transport's reading of
    `failure` (`client.timeout` naming the time limit for a request that timed out, `client.unreachable`
    naming the base URL for one that never connected). `request_url` is the URL requested, the base
    URL when it is not given, and `timeout_seconds` the request's time limit, which the problem of a
    timeout names.
    """

    def __init__(
        self,
        message: str,
        api_url: str,
        code: str | None = None,
        *,
        may_start_run: bool = False,
        failure: BaseException | None = None,
        request_url: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        error_domain = ErrorDomain.RUNTIME if code == ABORT_TIMEOUT_CODE else ErrorDomain.CONFIG
        run_may_have_started = may_start_run and transport_may_have_started_run(failure)
        super().__init__(
            message,
            verdict=_verdict(error_domain, retryable=True),
            problem=_transport_problem(
                run_may_have_started=run_may_have_started, code=code, failure=failure, api_url=api_url, timeout_seconds=timeout_seconds
            ),
            run_may_have_started=run_may_have_started,
            api_url=api_url,
            request_url=request_url or api_url,
        )
        self.code = code


def _transport_problem(
    *, run_may_have_started: bool, code: str | None, failure: BaseException | None, api_url: str, timeout_seconds: float | None
) -> Problem:
    """The standard's problem of a request that got no answer, agreeing with the SDK's own reading of whether a run may have started."""
    if run_may_have_started:
        return _outcome_unknown_problem()
    if timeout_seconds is not None:
        if isinstance(failure, (httpx.TransportError, httpx.DecodingError)):
            return transport_failure_problem(failure, creates_run=False, base_url=api_url, timeout_seconds=timeout_seconds)
        if code == ABORT_TIMEOUT_CODE:
            return make_client_problem(CoreCode.CLIENT_TIMEOUT, params={"seconds": timeout_seconds})
    return make_client_problem(CoreCode.CLIENT_UNREACHABLE, params={"base_url": api_url})


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


class IdempotencyErrorCode(StrEnum):
    """The platform code a refusal about a request's `Idempotency-Key` carries in `ApiResponseError.code`.

    `code` stays a `str`, since the platform adds codes; this enum names the one a caller sending an
    idempotency key branches on, and being a `StrEnum` its member equals its string. The key's other
    refusal carries the generic `conflict` (`409`, `input`, not retryable): the key was used before with
    a different body, or is bound to a run that has since been deleted. Either way the request is sent
    again under a new key, with the original body for the first.
    """

    IDEMPOTENCY_KEY_IN_USE = "idempotency_key_in_use"
    """`409`: an earlier request under the same key and the same body is still being handled, or this
    one lost the key while it was handled, so nothing ran for this one. `runtime` and retryable: wait a
    few seconds (the answer's `Retry-After`) and send the same request again under the **same** key,
    which is answered with the earlier request's outcome once it is stored. A new key would run it a
    second time. On a `start`, its `run_may_have_started` is `False`: this request started nothing."""


class ApiResponseError(PipelexRequestError, _MthdsApiResponseError):
    """A response that DID come back from the API and that the SDK cannot hand back as a result: a
    non-2xx refusal, with its problem document parsed, or a 2xx answer the SDK could not read — a body
    that is not UTF-8 or not JSON, an empty one where the route answers JSON, or JSON that is not the
    answer the route returns. The second carries the answer's status and raw text, no problem member
    but the `X-Request-ID` header as `request_id`, the parse failure as `__cause__`, and the verdict the
    fallback gives a 2xx: `runtime`, not retryable.

    Every route of `PipelexAPIClient` raises it on a non-2xx answer and on a 2xx it cannot read: the
    protocol routes it inherits from `mthds` (`execute`, `start`, `validate`, `models`, `version`), the
    run status and results reads, the product routes and `health`. It is `mthds`'s own
    `ApiResponseError` refined for this SDK, so a handler written against the standard's client
    (`except mthds.runners.api.exceptions.ApiResponseError`) catches it too. Every error the hosted API
    answers is an RFC 9457 `application/problem+json` document in the hosted plane's own shape, which
    predates the standard's, and this error carries its members as typed attributes, each `None` when
    the document did not carry it — except the verdict, which is always decided:

    - **The verdict.** `error_domain` says who can fix the failure — `input` (the caller), `config` (a
      configuration change), `runtime` (nobody beforehand) — and `retryable` whether asking again can
      succeed. Each is the document's member when the server sent a valid one, and otherwise the SDK's
      fallback (`pipelex_sdk.error_verdicts.fallback_verdict`), read from the status, the platform
      `code` and whether the body names what it refused. A runner often sends `error_domain` without
      `retryable`, and then the domain it sent decides `retryable`: `input` and `config` are not
      retryable, as a stored report that says nothing is not, since the caller or the environment must
      change, while `runtime` takes the fallback's. Nothing on the error says which a value came from:
      `problem_document` keeps what the server sent.
    - **A run that may have started.** On a `start` or an `execute`, `run_may_have_started` says whether
      the answer leaves a run possibly started without its id reaching the caller: any `2xx` the SDK
      could not read, a `408`, and every `5xx` but a `501` and the platform's `503` coded
      `pipeline_start_unavailable`, which says the runner was never reached. Then `retryable` is
      `False`, whatever the server sent: asking again could start a second run. A runner's own failure
      of a blocking execute reads the same, since the SDK cannot tell a run that ended from one that
      goes on, and its `retryable` stays readable on `problem_document`. On every other route it is `False`.
    - **What happened, for a person.** `str(exc)` names the request and the status, gives the reason
      (the problem's `detail`, else its `title`, else the raw body, else the status text) and, when
      the server advised one, the next step on its own line (`Next step: …`); for a 2xx it could not
      read, it is `API <method> <path> answered <status> with <what>`, naming what could not be
      read. `server_message` is the `detail` alone, `title` the stable label of the error class,
      `user_action` the advised next step (`kind` and `detail`, `ProblemUserAction`), and
      `error_category` a finer classification of an inference failure.
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
      stays on `problem_document`). `errors` is the platform's field-level list (`field`, `code`, `detail`).
    - **The standard's reading.** `problem` is the answer as the standard's `mthds` client reads it,
      a `mthds.protocol.problem.models.Problem` under a registered code: the body itself when it is a
      core problem document, and otherwise the problem the standard reads from the status, such as
      `client.response_unreadable` naming it. On a `start` or an `execute`, `run_may_have_started`
      decides (`answer_reading`): `client.outcome_unknown` for every answer that leaves a run possibly
      started, a `408` included, even when the body is a core problem document, and the reading of a
      request that creates no run for one that started nothing, such as a `501` or the platform's `503`
      coded `pipeline_start_unavailable`.
      Its `code` is the registry's and its `errors` the standard's problem items, which share their
      names with the platform's `code` and `errors` above and never replace them. The verdict and the
      message are not read from it.

    `problem_document` is the decoded document whole, so a member this SDK does not name — the
    `run_status` and `error` of a failed run's results read, say, or the `error_domain` and
    `retryable` the server sent — stays reachable; `response_body` is the raw text, `status` /
    `status_text` the transport's, `headers` the answer's headers (lower-case names), `request_url` the
    URL requested and `api_url` the configured base URL. `problem_document` is `None` when the body was
    not a JSON object.
    """

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
        user_action: ProblemUserAction | None = None,
        problem: Problem | None = None,
        problem_document: dict[str, Any] | None = None,
        code: str | None = None,
        error_category: str | None = None,
        errors: list[FieldError] | None = None,
        may_start_run: bool = False,
    ) -> None:
        """Build the error: the verdict, the standard's reading and the `mthds` members, then the hosted ones.

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
                `error_domain` is this when it is a known domain, and the fallback's otherwise.
            retryable: The `retryable` the server sent, `None` when it sent none. The error's own
                `retryable` is this when it is a boolean, and decided as the class says otherwise.
            user_action: The next step the server advises.
            problem: The standard's reading of the answer. The client passes the one `answer_reading`
                gives; left out, it is read here the same way, from `status`, `response_body`, `headers`,
                `code` and `may_start_run`, so an error a caller builds by hand carries the problem the
                client would give it.
            problem_document: The decoded problem document whole.
            code: The platform's closed native code.
            error_category: The finer classification of an inference failure.
            errors: The platform's field-level failures.
            may_start_run: The request was a `start` or an `execute`, so the answer is read for whether it
                may have started a run (`run_may_have_started`). The client sets it on those two routes
                alone; a caller building the error by hand sets it to get the verdict the client would give.
        """
        run_may_have_started = may_start_run and answer_may_have_started_run(status=status, code=code)
        verdict = _response_verdict(status=status, error_type=error_type, code=code, sent_domain=error_domain, sent_retryable=retryable)
        reading = problem or answer_reading(status=status, body=response_body, headers=headers or {}, may_start_run=may_start_run, code=code).problem
        super().__init__(
            _with_next_step(message, user_action),
            verdict=verdict,
            problem=reading,
            run_may_have_started=run_may_have_started,
            api_url=api_url,
            status=status,
            status_text=status_text,
            response_body=response_body,
            headers=headers,
            request_url=request_url,
            request_id=request_id,
        )
        self.error_type = error_type
        self.server_message = server_message
        self.validation_errors = validation_errors
        self.type_uri = type_uri
        self.title = title
        self.instance = instance
        self.user_action = user_action
        self.problem_document = problem_document
        self.code = code
        self.error_category = error_category
        self.errors = errors


def _with_next_step(message: str, user_action: ProblemUserAction | None) -> str:
    """Append the advised next step to a message, unless there is none or the message already ends with it."""
    if user_action is None or message.rstrip().endswith(user_action.detail.strip()):
        return message
    return f"{message}\nNext step: {user_action.detail}"


def answer_reading(*, status: int, body: str, headers: Mapping[str, str], may_start_run: bool, code: str | None) -> AnswerReading:
    """The standard's reading of an answer the SDK raises as an `ApiResponseError`, agreeing with its `run_may_have_started`.

    The answer is read as the `mthds` client reads it (`read_answer`), except on a request that may create
    a run, where the SDK's own reading of whether a run may have started (`answer_may_have_started_run`)
    decides, as `ApiUnreachableError`'s does for a request that got no answer, so that `problem` never says a
    run may exist where `run_may_have_started` says none started, nor the reverse.

    - Where a run may have started, the answer reads as `client.outcome_unknown`, naming the run when the
      body names one (the platform's `bad_gateway` does when it lost a start's acknowledgement), whatever
      the body: a `408`, which a proxy may answer for a request it forwarded, every `5xx` but a `501` and a
      `503` carrying the platform's code `pipeline_start_unavailable`, and a 2xx the SDK could not read,
      since the server accepted the request. A core problem document in such a body is not kept, since one
      inviting a retry would contradict `run_may_have_started`.
    - Where none started, which is every answer to a request that creates no run, a non-2xx whose body is
      a core problem document reads as that document, `from_body` true, and any other non-2xx as the
      answer to a request that creates none: the code its status names (`runtime.unavailable` for that
      `503`), else `client.response_unreadable` naming the status (that `501`). A 2xx the SDK could not
      read is `client.response_unreadable`.

    Args:
        status: The HTTP status of the answer.
        body: The answer's body, as text.
        headers: The answer's headers, whatever the case of their names.
        may_start_run: Whether the request may create a run: a `start` or an `execute`.
        code: The platform's native code, when the body carried one, which decides a `503`.

    Returns:
        The problem, and whether it is the body's own problem document.
    """
    run_may_have_started = may_start_run and answer_may_have_started_run(status=status, code=code)
    if not run_may_have_started:
        if 200 <= status < 300:
            return AnswerReading(problem=unreadable_answer(status), from_body=False)
        lower_case = {name.lower(): value for name, value in headers.items()}
        return read_answer(status=status, body=body, headers=lower_case, creates_run=False)
    decoded: object = decode_json(body).value
    started_run_id: object = cast("dict[str, Any]", decoded).get("pipeline_run_id") if isinstance(decoded, dict) else None
    if isinstance(started_run_id, str) and started_run_id:
        return AnswerReading(problem=_outcome_unknown_problem(pipeline_run_id=started_run_id), from_body=False)
    return AnswerReading(problem=_outcome_unknown_problem(), from_body=False)


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
    starting the run and polling. `run_may_have_started` is always `True`: the gateway gave up on the
    request, and the run it carried goes on without its id reaching the caller. Its `problem` is
    `client.outcome_unknown`, for the same reason.
    """

    def __init__(self, message: str, elapsed_seconds: float) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.INPUT, retryable=False), problem=_outcome_unknown_problem(), run_may_have_started=True)
        self.elapsed_seconds = elapsed_seconds


# ── The run lifecycle ─────────────────────────────────────────────────


class RunFailedError(PipelexRequestError):
    """Raised when a run reaches a terminal state that is not `COMPLETED`.

    Surfaced by `wait_for_result`, `start_and_wait` and `download_artifacts` when the platform
    answers the results read with HTTP 409 (`FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`).

    - `status` is the run's terminal status, the typed `RunStatus` enum, read from the problem's
      `run_status` member — so callers can match/case on it.
    - `error` is the run's stored error report as the platform serves it, typed whole as
      `RunErrorReport`: the runner's `error_type`, `message`, `title`, `type_uri`, `error_domain`,
      `error_category`, `retryable`, `user_action`, `provider_metadata`, `caller_facing_message`,
      `validation_errors` and anything newer on `model_extra`. Branch on `error.error_domain`,
      `error.type_uri` and `error.retryable`; show `error.user_action` as the next step. The platform
      serves the runner's STRICT projection, so `message` is the author's copy only when
      `caller_facing_message` is `True` and the placeholder `An internal error occurred.` otherwise,
      `user_action` comes only with caller-facing copy, `provider_metadata` keeps only `status_code`
      and `retry_after_seconds`, and `model`, `provider` and `migration` are `None`; deciding what a
      person sees is still yours. A run the platform ended or settled itself carries the
      caller-facing report the platform wrote, in the same shape. A cancelled, terminated or timed-out
      run carries a report when a completion callback carried one, and a timed-out run otherwise the
      platform's timeout report. `None` when the run ended with no stored report (one whose start
      failed, or one cancelled, terminated or given its status by hand with no completion callback
      carrying a report).
    - The exception's own message is the problem's `detail`, which names the status and then the
      report's message (`Run finished with status FAILED: <message>`), so printing the error already
      tells the reason.
    - `run_id` locates the run, for a status read or a support request.

    Its verdict comes from the report. `error_domain` is the report's `error_domain` when it is a known
    domain, and `runtime` otherwise, including a run with no report. `retryable` is true only
    when the report's `retryable` is `True`: a report that says nothing, and a run with none, read as not
    retryable, since starting the run again spends credit and nothing says it would succeed. The report
    keeps its own `retryable` as written, so a consumer that words the unknown differently still can.

    Its `problem` is `run.failed`, naming the run and the status it ended with.
    """

    def __init__(self, message: str, run_id: str, status: RunStatus, error: RunErrorReport | None = None) -> None:
        problem = make_client_problem(CoreCode.RUN_FAILED, params={"pipeline_run_id": run_id, "run_status": status}, pipeline_run_id=run_id)
        super().__init__(message, verdict=_run_failure_verdict(error), problem=problem)
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

    Its verdict is `runtime` and retryable: the run is still going, and waiting again can succeed. Its
    `problem` is `run.not_finished`, naming the run.
    """

    def __init__(self, message: str, run_id: str, timeout_seconds: float) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.RUNTIME, retryable=True), problem=_run_not_finished_problem(run_id))
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

    Its verdict is `runtime` and retryable: the run is still going, and is resumed by its id. Its
    `problem` is `run.not_finished`, naming the run and the server's hint, unless `problem` gives
    another: raised again from the protocol `execute()`'s `202`, it keeps the standard's own,
    `client.follow_failed` naming the run.
    """

    def __init__(
        self, message: str, run_id: str, retry_after_seconds: int | None = None, location: str | None = None, *, problem: Problem | None = None
    ) -> None:
        super().__init__(
            message,
            verdict=_verdict(ErrorDomain.RUNTIME, retryable=True),
            problem=problem or _run_not_finished_problem(run_id, retry_after_seconds=retry_after_seconds),
            run_id=run_id,
            retry_after_seconds=retry_after_seconds,
            location=location,
        )


def _run_not_finished_problem(run_id: str, *, retry_after_seconds: int | None = None) -> Problem:
    """`run.not_finished`, naming the run, with the server's hint as `retry_after` when it gave one."""
    return make_client_problem(CoreCode.RUN_NOT_FINISHED, params={"pipeline_run_id": run_id}, retry_after=retry_after_seconds, pipeline_run_id=run_id)


class MissingMainStuffError(PipelexRequestError):
    """Raised when a completed run cannot deliver its main stuff.

    Every completed run delivers a main stuff (the pipelex >= 0.37 wire invariant), so the SDK
    hands consumers a non-null `RunResults.main_stuff`. This surfaces the contract violation when it
    cannot: the hosted results endpoint answered a `200` with a null `main_stuff`, or a blocking
    `execute` response named a `main_stuff_name` whose stuff is absent from the returned working
    memory. `run_id` locates the run. (A falsy-but-present main stuff — an empty list, `0` — is a
    valid output and does NOT raise; only a genuinely absent one does.)

    Its verdict is `runtime`, not retryable: the API broke its own contract on a completed run. Its
    `problem` is `client.response_unreadable` for the `200` that broke it, naming the run.
    """

    def __init__(self, message: str, run_id: str) -> None:
        super().__init__(
            message, verdict=_verdict(ErrorDomain.RUNTIME, retryable=False), problem=response_unreadable_problem(status=200, pipeline_run_id=run_id)
        )
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
    lifecycle. Its `problem` is `runtime.unsupported`, naming the durable run lifecycle as the
    capability the server lacks.
    """

    def __init__(self, message: str, api_url: str) -> None:
        problem = make_client_problem(CoreCode.RUNTIME_UNSUPPORTED, params={"capability": "the durable run lifecycle"})
        super().__init__(message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False), problem=problem)
        self.api_url = api_url


class PagingNotTerminatingError(PipelexRequestError):
    """Raised when a paged-list iterator refuses to keep following cursors.

    The ceiling sits far beyond any real catalog, so reaching it is a server-side fault —
    an endpoint minting a fresh cursor forever — not a coverage limit the caller can raise.
    Raising beats returning, because a silently truncated list is exactly the bug paging
    was introduced to remove. Its verdict is `runtime`, not retryable, and its `problem`
    `client.response_unreadable` for the `200` pages that never stopped.
    """

    def __init__(self, message: str, page_limit: int) -> None:
        super().__init__(message, verdict=_verdict(ErrorDomain.RUNTIME, retryable=False), problem=response_unreadable_problem(status=200))
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
    form reporting a missing input in its own words. `problem` is the failure as the standard's problem
    document: each subclass states its own, and a direct raise gives it, `client.argument_invalid` for
    an argument refused (`argument_invalid_problem`) or the wrapped error's for a refusal the API
    answered. One built with none, from a message alone, carries `client.argument_invalid` naming
    `inputs`, for the reason `unspecified`.
    """

    def __init__(self, message: str, *, problem: Problem | None = None, verdict: ErrorVerdict | None = None) -> None:
        super().__init__(
            message,
            verdict=verdict or _verdict(ErrorDomain.INPUT, retryable=False),
            problem=problem or argument_invalid_problem(argument="inputs", reason=_UNSPECIFIED_REASON),
        )


class InvalidLocalSourceError(InputPreparationError):
    """A local asset could not be turned into bytes — a missing or unreadable path.
    `source` is the offending path. Its `problem` is `input.file_unreadable`, naming the path.
    """

    def __init__(self, message: str, source: str) -> None:
        problem = make_client_problem(CoreCode.INPUT_FILE_UNREADABLE, params={"input": source, "file_type": "file", "reason": "unreadable"})
        super().__init__(message, problem=problem)
        self.source = source


class InvalidInputValueError(InputPreparationError):
    """A value the caller gave at a file input cannot be turned into a file to upload: a `data:` URL
    that does not decode (no comma, bad base64), or a value of a type no file input takes, neither a
    path or URL string, nor `bytes` or a `Path`, nor `{url}` content. `prepare_inputs` raises it while
    it reads the inputs, before anything is uploaded. As with `InvalidLocalSourceError`, the inputs are
    what must change, which is how a consumer tells it apart from `MethodLoadError`, a method that does
    not load, raised by the same preparation.

    As on `UploadNotAllowedError`, `input_name` is the input the value belongs to and `input_path` where
    it sits inside that input (`report.attachments[1]`, or the name alone for a top-level file). The
    message names that path and describes the value by its kind, never by its content, since the value
    is the caller's data. The twin of `@pipelex/sdk`'s class of the same name, whose `inputName` and
    `inputPath` these are. Its `problem` is `input.invalid`, naming the input and the path inside it.
    """

    def __init__(self, message: str, *, input_name: str, input_path: str) -> None:
        super().__init__(message, problem=make_client_problem(CoreCode.INPUT_INVALID, params={"input": input_name, "field": input_path}))
        self.input_name = input_name
        self.input_path = input_path


class UploadNotAllowedKind(StrEnum):
    """What a value refused under `allow_uploads=False` is, in a closed vocabulary a caller branches on
    rather than on the message: `local_path` — a string or a `Path` that is neither an `http(s)` URL nor
    a `pipelex-storage://` reference, which preparation would read from disk; `data_url` — a `data:`
    URL, which it would decode and upload; `bytes` — inline `bytes`. The vocabulary is `@pipelex/sdk`'s
    `UploadNotAllowedKind`, shared so a consumer of both SDKs branches on one set.
    """

    LOCAL_PATH = "local_path"
    DATA_URL = "data_url"
    BYTES = "bytes"


_UPLOAD_NOT_ALLOWED_KIND_WORDS: dict[UploadNotAllowedKind, str] = {
    UploadNotAllowedKind.LOCAL_PATH: "a local file path",
    UploadNotAllowedKind.DATA_URL: "a data: URL",
    UploadNotAllowedKind.BYTES: "inline bytes",
}


class UploadNotAllowedError(InputPreparationError):
    """`prepare_inputs` was called with `allow_uploads=False`, and a value at a file input would need an
    upload: a local path, a `data:` URL or bytes.

    It is raised before anything is read from disk, decoded or sent to the upload route, so a server
    preparing inputs on a caller's behalf never reads a file of its own because the caller named it.
    `input_name` is the input the value belongs to, `input_path` where it sits inside that input
    (`report.attachments[1]`, or the name alone for a top-level file), and `value_kind` what it is. The
    value itself is neither in the message nor on the error, since it is the caller's data. Its verdict
    is `input`, not retryable: the caller must pass an `http(s)` URL or a `pipelex-storage://` reference
    instead. The twin of `@pipelex/sdk`'s class of the same name, whose `inputName`, `inputPath` and
    `valueKind` these are. Its `problem` is `client.argument_invalid`, naming the input's path and the
    value's kind as the reason.
    """

    def __init__(self, *, input_name: str, input_path: str, value_kind: UploadNotAllowedKind) -> None:
        super().__init__(
            f'Input "{input_path}" is {_UPLOAD_NOT_ALLOWED_KIND_WORDS[value_kind]}, which would need an upload, and this '
            "preparation uploads nothing: pass an http(s) URL or a pipelex-storage:// reference instead.",
            problem=argument_invalid_problem(argument=input_path, reason=value_kind),
        )
        self.input_name = input_name
        self.input_path = input_path
        self.value_kind = value_kind


class MethodLoadError(InputPreparationError):
    """The pipe I/O answer said the method does not load (`is_valid: false`), so its signature cannot
    be read and no input can be prepared: the method, not the inputs, must change.

    `validation_errors` holds the answer's items, possibly none, and `server_message` the answer's own
    `message`. The error's message names the first item's message, else the answer's own. The twin of
    `@pipelex/sdk`'s class of the same name, whose `validationErrors` and `serverMessage` these are.
    Its `problem` is `method.invalid`.
    """

    def __init__(self, message: str, *, validation_errors: list[ValidationErrorItem], server_message: str | None = None) -> None:
        super().__init__(message, problem=make_client_problem(CoreCode.METHOD_INVALID))
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
    Its `problem` is the refusal's as the API answered it, which `upload_file` passes, and otherwise
    the one the standard reads from `status` alone.
    """

    def __init__(self, message: str, filename: str, status: int, *, code: RejectedAssetCode | None = None, problem: Problem | None = None) -> None:
        super().__init__(message, problem=problem or _status_problem(status))
        self.filename = filename
        self.status = status
        self.code = code


class UnsupportedUploadCapabilityError(InputPreparationError):
    """The configured deployment does not support upload (no `/v1/upload` route, seen
    as a `404`). Upload is a hosted Pipelex-product capability even though the SDK can
    be pointed at other base URLs. `filename` is the file whose upload met it, as `upload_file`
    sent it; the route's `ApiResponseError` is its `__cause__`. Its verdict is `config`, not
    retryable: the base URL must point at a deployment that serves upload. Its `problem` is
    `runtime.unsupported`, naming file upload as the capability the deployment lacks.
    """

    def __init__(self, message: str, *, filename: str | None = None) -> None:
        problem = make_client_problem(CoreCode.RUNTIME_UNSUPPORTED, params={"capability": "file upload"})
        super().__init__(message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False), problem=problem)
        self.filename = filename


class UploadAuthenticationError(InputPreparationError):
    """Upload was not authorized — a `401`/`403` from the upload route. `filename` is the file
    whose upload was refused, as `upload_file` sent it. Its verdict is `config`, not retryable: the
    credential must change. Its `problem` is `auth.invalid_credential` when the request carried a
    credential, and `auth.missing_credential` when it carried none (`credential_sent` false, which
    `upload_file` passes for a client holding no API key).
    """

    def __init__(self, message: str, status: int, *, filename: str | None = None, credential_sent: bool = True) -> None:
        super().__init__(
            message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False), problem=_credential_refused_problem(credential_sent=credential_sent)
        )
        self.status = status
        self.filename = filename


class UploadTransportCode(StrEnum):
    """Which transport failure an upload met, in a closed vocabulary a caller branches on rather than on
    the message.

    The vocabulary is `@pipelex/sdk`'s, shared so a consumer of both SDKs branches on one set.
    `upload_file` raises `timeout`, `unreachable`, `server_error` and `unexpected`; the others name the
    failures of an upload to storage made with a grant, which `@pipelex/sdk`'s `uploadWithGrant` performs.

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

    Its `problem` is the wrapped error's when `cause` carries one, and otherwise the one the standard
    reads from `status` alone, or `runtime.unexpected` when no status came back.
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
        super().__init__(
            message,
            verdict=error_verdict_of(cause) or _upload_transport_verdict(code=code, status=status),
            problem=_wrapped_problem(cause) or (_status_problem(status) if status is not None else make_client_problem(CoreCode.RUNTIME_UNEXPECTED)),
        )
        self.status = status
        self.filename = filename
        self.code = code


def _wrapped_problem(cause: BaseException | None) -> Problem | None:
    """The problem a wrapped error carries, when it is one of the standard's request errors."""
    return cause.problem if isinstance(cause, PipelineRequestError) else None


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
    where the environment refuses the download (a directory that cannot be created). `problem` is the
    failure as the standard's problem document: each subclass states its own, and a direct raise gives
    it — `client.argument_invalid` for an argument refused, `client.write_failed` for a directory that
    cannot be created, `client.response_unreadable` for an answer the operation cannot use. One built
    with none, from a message alone, carries `runtime.unexpected`, which states the family's own
    verdict, `runtime` and not retryable.
    """

    def __init__(self, message: str, *, problem: Problem | None = None, verdict: ErrorVerdict | None = None) -> None:
        super().__init__(
            message,
            verdict=verdict or _verdict(ErrorDomain.RUNTIME, retryable=False),
            problem=problem or make_client_problem(CoreCode.RUNTIME_UNEXPECTED),
        )


class ScopeUnavailableError(ArtifactOperationError):
    """The scope `download_artifacts` was asked to walk is `None` on the run's results.

    The key WAS relayed — it is in `results.model_fields_set` — and its value is `None`, which is
    the platform saying it has no such artifact for this run. Distinct from a key the results read
    never carried, which is `FieldNotIncludedError`, and from an empty walk over a present scope,
    which is a produced verdict with no artifacts. `scope` names the scope, `run_id` the run. Its
    verdict is the family's, `runtime` and not retryable, and its `problem` `client.response_unreadable`
    for the `200` that relayed it, naming the run.
    """

    def __init__(self, scope: ArtifactScope, run_id: str) -> None:
        msg = f'Run "{run_id}" carries no "{scope}" artifact to walk for produced files — the results relayed it as null.'
        super().__init__(msg, problem=response_unreadable_problem(status=200, pipeline_run_id=run_id))
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

    Its `problem` follows `code` too, unless `problem` gives one: `input.reference_not_found` naming the
    reference for `invalid_storage_uri`, `forbidden` and `not_found`, `client.link_refused` for
    `unsupported_url`, `plain_http_refused` and `redirect_refused`, the one the standard reads from the
    store's `status` for `store_refused` and `store_error`, and `runtime.unexpected` otherwise. The SDK
    passes `client.download_limit_exceeded` naming the cap for `too_large`, `client.timeout` naming
    the budget for `timeout`, and the transport's `client.unreachable` naming the store's origin for a
    `network` failure that is one of a transport.
    """

    def __init__(self, message: str, uri: str, code: str, status: int | None = None, *, problem: Problem | None = None) -> None:
        super().__init__(
            message,
            verdict=_artifact_fetch_verdict(code=code, status=status),
            problem=problem or _artifact_fetch_problem(code=code, uri=uri, status=status),
        )
        self.uri = uri
        self.code = code
        self.status = status


def _artifact_fetch_problem(*, code: str, uri: str, status: int | None) -> Problem:
    """The standard's problem of one reference's fetch failure, by its code and the store's status."""
    match code:
        case "invalid_storage_uri" | "forbidden" | "not_found":
            return make_client_problem(CoreCode.INPUT_REFERENCE_NOT_FOUND, params={"input": uri})
        case "unsupported_url":
            return make_client_problem(CoreCode.CLIENT_LINK_REFUSED, params={"reason": "unsupported_scheme"})
        case "plain_http_refused":
            return make_client_problem(CoreCode.CLIENT_LINK_REFUSED, params={"reason": "plain_http"})
        case "redirect_refused":
            return make_client_problem(CoreCode.CLIENT_LINK_REFUSED, params={"reason": "redirect"})
        case "store_refused" | "store_error" if status is not None:
            return _status_problem(status)
        case _:
            # `too_large`, `timeout` and `network` without the problem their raise site states, a store
            # refusal without its status, and a code this version does not know.
            return make_client_problem(CoreCode.RUNTIME_UNEXPECTED)


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
    must change. Its `problem` is `auth.invalid_credential` when the request carried a credential, and
    `auth.missing_credential` when it carried none: `credential_sent` false, which `download_artifacts`
    passes for a client holding no API key.)
    """

    def __init__(self, message: str, status: int, verdict: DownloadArtifactsResult, *, credential_sent: bool = True) -> None:
        super().__init__(
            message, verdict=_verdict(ErrorDomain.CONFIG, retryable=False), problem=_credential_refused_problem(credential_sent=credential_sent)
        )
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

    Its `problem` is `client.argument_invalid`, naming the results the caller handed over, unless
    `problem` gives another: `download_artifacts` gives `client.response_unreadable` for the `200` that
    left the field out.
    """

    def __init__(self, field_name: str, *, verdict: ErrorVerdict | None = None, problem: Problem | None = None) -> None:
        msg = f"RunResults field `{field_name}` was not in the results body: the read did not carry it"
        super().__init__(
            msg,
            verdict=verdict or _verdict(ErrorDomain.INPUT, retryable=False),
            problem=problem or argument_invalid_problem(argument="results", reason="field_not_included"),
        )
        self.field_name = field_name
