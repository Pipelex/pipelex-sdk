"""Pipelex SDK errors — the argument, transport, run-lifecycle, input-preparation, artifact and codegen errors
`pipelex-sdk` raises, each carrying its failure as a problem document.

Every error this module exports carries `problem`, a `mthds.protocol.problem.models.Problem`: the runtime's own
problem document when it answered with one, and otherwise the problem the SDK builds for a failure it detects
itself, under a registered code. A program branches on `exc.problem.code`, and on `exc.problem.effective_domain`
(who must act: `input`, `method`, `account`, `operator` or `runtime`), `exc.problem.effective_retry` (`yes`, `no`,
or `outcome_unknown` where a run may already exist and must be read, never started again) and
`exc.problem.next_step` when it handles several codes alike; the rest of the problem (`params`, `location`,
`errors`, `pipeline_run_id`, `retry_after`, and the `request_id` and any member the runtime added, which ride
`problem.model_extra`) is read off it the same way. `@pipelex/sdk` builds the same code for every failure, which
the shared case file `tests/fixtures/sdk-problems.json` pins in both suites.

The errors raised over a request derive from `PipelexRequestError`, itself the protocol base `PipelineRequestError`
(`mthds.protocol.exceptions`), mirroring `@pipelex/sdk`'s `errors.ts`:

- `RequestArgumentError` — the client refused a call's arguments before sending any request.
- `ApiUnreachableError` — the HTTP exchange never produced a response (DNS / connect / TLS / timeout). It also
  subclasses `mthds`'s own `ApiTransportError`.
- `ApiResponseError` — an answer that came back and is a failure: a non-2xx, a body that could not be decoded,
  or a 2xx the SDK cannot read. It also subclasses `mthds`'s own `ApiResponseError`, so every route — protocol,
  lifecycle and product alike — raises this one class.
- `PipelineExecuteTimeoutError` — a blocking `execute()` killed by the hosted gateway's ~30s synchronous-request
  ceiling; points the caller at the durable start+poll path.
- `PagingNotTerminatingError` — a paged-list iterator hit its runaway backstop, meaning the server never stopped
  handing out cursors.

The run-lifecycle errors (`RunFailedError`, `RunTimeoutError`, `RunLifecycleUnavailableError`,
`RunStillRunningError`, `MissingMainStuffError`) are owned here. `RunStillRunningError` also subclasses `mthds`'s
class of the same name, which the protocol `execute()` raises on its 202-degrade path, so a handler written
against the standard's client still catches it.

The input-preparation errors (`InputPreparationError` and its subclasses) are raised by `upload_file` and
`prepare_inputs`, before any run is created. The artifact errors (`ArtifactOperationError` and its subclasses,
plus `FieldNotIncludedError`) are the download twin of that family: they are raised only where the artifact
operations can produce no verdict at all, per-reference failure being a value on the verdict's item. See
`docs/artifact-download.md`.

`MethodFileTransferError` is raised when a file of a method's tree could not be moved between this machine and
the platform's storage: a blob uploaded before a save, or a saved file downloaded through the link a method read
serves. See `docs/method-trees.md`.

The codegen tree errors (`CodegenError`, `CodegenLockError`) are not request errors at all: they are raised by
`pipelex_sdk.codegen_writer`, `pipelex_sdk.codegen_check`, `pipelex_sdk.codegen_lock` and
`pipelex_sdk.codegen_stamp` over bytes and a directory, so they derive from `Exception` rather than from the
protocol base, and carry their problem as `problem` all the same, as `@pipelex/sdk`'s `CodegenLockError` does.

The caller-webhook receiver's errors (`WebhookVerificationError`, `WebhookEventUnreadableError`) are not request
errors either: `pipelex_sdk.webhooks.verify_webhook` raises them over a call the receiver was sent, so they derive
from `Exception` and carry their `problem` as the codegen errors do. See `docs/webhooks.md`.

`str(exc)` is the SDK's own sentence, rather than the problem's: unlike the `mthds` errors, this module's do not
append the problem's next step to it. The problem's `detail` and `next_step.detail` are on `problem` for whoever
renders them. See `docs/errors.md`.
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Any

import httpx
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.answers import read_answer, read_problem_document
from mthds.protocol.problem.client_problems import make_client_problem
from mthds.protocol.problem.models import Problem
from mthds.protocol.problem.registry import CoreCode
from mthds.runners.api.exceptions import ApiResponseError as _MthdsApiResponseError
from mthds.runners.api.exceptions import ApiTransportError as _MthdsApiTransportError
from mthds.runners.api.exceptions import RunStillRunningError as _MthdsRunStillRunningError
from mthds.runners.api.problem import REQUEST_ID_HEADER, transport_failure_problem
from pydantic import ValidationError

from pipelex_sdk.answer_reading import outcome_unknown_problem, read_hosted_answer
from pipelex_sdk.transport_reading import request_may_have_left

if TYPE_CHECKING:
    from collections.abc import Mapping

    from mthds.protocol.problem.models import ProblemItem

    from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult
    from pipelex_sdk.runs import RunStatus

#: The `ApiUnreachableError.network_code` of a request that reached the API and that the client's own time limit
#: cut off while it was sent or answered — `@pipelex/sdk`'s code for the same case. Every other transport failure
#: carries the httpx exception's class name instead, a connect or pool timeout included.
ABORT_TIMEOUT_CODE = "ABORT_TIMEOUT"

# The reason `client.argument_invalid` names when an argument refusal is built from a message alone, which says
# what was refused only in words.
_UNSPECIFIED_REASON = "unspecified"


# ── The problems this module builds ──────────────────────────────────


def argument_invalid_problem(*, argument: str, reason: str) -> Problem:
    """The problem of an argument refused before any request left: `client.argument_invalid`.

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


def status_problem(status: int) -> Problem:
    """The problem the standard reads from an answer's status alone, as for a body that is no problem document.

    Args:
        status: The HTTP status of the answer.

    Returns:
        The one core code raised with that status when a client can state it, else `client.response_unreadable`.
    """
    return read_answer(status=status, body="", headers={}, creates_run=False).problem


def is_transient_storage_status(status: int) -> bool:
    """Whether a storage answer's `status` refuses the request for its timing or fails in a way a later attempt can
    pass: a `408`, a `429`, or a `5xx` other than `501`.

    Args:
        status: The HTTP status storage answered.

    Returns:
        Whether asking storage again can succeed.
    """
    return status in {408, 429} or (500 <= status <= 599 and status != 501)


def storage_status_problem(status: int) -> Problem:
    """The problem of a storage answer the SDK reads by its status, storage answering no problem document.

    Args:
        status: The HTTP status storage answered.

    Returns:
        `runtime.unavailable` for a transient status (`is_transient_storage_status`), so that asking again can
        succeed; `runtime.unsupported` for a `501`, storage not implementing the request it was sent; and
        `client.response_unreadable` naming the status otherwise, an answer the SDK has no reading for.
    """
    if is_transient_storage_status(status):
        return make_client_problem(CoreCode.RUNTIME_UNAVAILABLE)
    if status == 501:
        return make_client_problem(CoreCode.RUNTIME_UNSUPPORTED, params={"capability": "this storage request"})
    return response_unreadable_problem(status=status)


def _credential_refused_problem(*, credential_sent: bool) -> Problem:
    """The problem of a request refused for its credential: `auth.invalid_credential`, or `auth.missing_credential`
    when the request carried none, as a client with no API key sends its requests.
    """
    return make_client_problem(CoreCode.AUTH_INVALID_CREDENTIAL if credential_sent else CoreCode.AUTH_MISSING_CREDENTIAL)


def _wrapped_problem(cause: BaseException | None) -> Problem | None:
    """The problem a wrapped error carries, when it is one of the standard's request errors."""
    return cause.problem if isinstance(cause, PipelineRequestError) else None


def _credential_problem(*, cause: BaseException | None, credential_sent: bool | None) -> Problem:
    """The problem of a refused credential, in this order: the server's own, when the wrapped `ApiResponseError`
    answered a problem document; then what the caller knows of its own request, when it says whether the request
    carried a credential, which the edge's bare `401` or `403` does not say; then the wrapped error's problem, its
    reading of that status; and otherwise `auth.invalid_credential`.
    """
    if isinstance(cause, _MthdsApiResponseError) and read_problem_document(cause.response_body, status=cause.status, headers={}) is not None:
        return cause.problem
    if credential_sent is not None:
        return _credential_refused_problem(credential_sent=credential_sent)
    return _wrapped_problem(cause) or _credential_refused_problem(credential_sent=True)


# ── The base every request error derives from ─────────────────────────


class PipelexRequestError(PipelineRequestError):
    """The base of every error this SDK raises over a request, carrying the failure as `problem`.

    It refines the standard's `PipelineRequestError`, so `except PipelineRequestError` still catches every SDK
    request error, and `problem` is always a problem document under a registered code, a Pipelex one
    (`pipelex.*`) included when the hosted API answered with it. The keyword arguments the constructor does not
    name pass on to the next class in the method resolution order: that is how `ApiResponseError`,
    `ApiUnreachableError` and `RunStillRunningError`, which also refine one of the standard's own classes, hand
    it its members. Its subclasses are meant to be raised, never this class itself.

    `str(exc)` is the message the subclass gives: the standard's `PipelineRequestError` appends the problem's
    next step to its message, and this constructor sets the message back, since an SDK message is its own
    sentence and the problem's next step is on `problem` for whoever renders it.
    """

    def __init__(self, message: str, /, *, problem: Problem, **kwargs: Any) -> None:
        super().__init__(message, problem=problem, **kwargs)
        # The standard's base appended the problem's next step; the SDK's message is its own. Pickling rebuilds
        # the error from these args, so it keeps the same message.
        self.args = (message,)


# ── Argument refusals ─────────────────────────────────────────────────


class RequestArgumentError(PipelexRequestError):
    """The SDK refused a call's arguments before sending any request: no run source given to `execute()` or
    `start()`, a protocol argument or a reserved one passed through `extra`, run sources or method selectors that
    exclude each other, a method's tree given in two forms or holding no file, a selector that is not a string, a
    suffixed `method_id` beside the method's tree, a selector rule of `validate()`, an artifact selection that is
    empty or names an unknown artifact, a suffixed id given to a method route, a `publish_method()` token that is
    not a string, a `get_method_version()` version that is not a positive integer, a value
    `parse_method_selector()` refuses, an `idempotency_key` that is not 1 to 255 visible ASCII characters,
    or a base URL that is not host-only. Nothing reached the API, so the message says what to change.

    Its `problem` is `client.argument_invalid` naming the argument and why it was refused
    (`argument_invalid_problem`), unless `problem` gives another: the client gives `client.not_configured` naming
    `base_url` for a base URL that is not host-only, since it typically comes from `PIPELEX_BASE_URL`. One built
    from a message alone names the argument `arguments`, for the reason `unspecified`. A refusal the standard's
    own client raises before sending is raised again as this class with the same message and the standard's
    problem, the standard's error as its `__cause__`.
    """

    def __init__(self, message: str, *, problem: Problem | None = None) -> None:
        super().__init__(message, problem=problem or argument_invalid_problem(argument="arguments", reason=_UNSPECIFIED_REASON))


# ── Transport ─────────────────────────────────────────────────────────


class ApiUnreachableError(PipelexRequestError, _MthdsApiTransportError):
    """Raised when the Pipelex API host cannot be reached at all.

    DNS failure, connection refused, TLS handshake failure, a connection lost before an answer came, or a request
    timeout — the HTTP exchange never produced a response. Distinguish from `ApiResponseError`, which represents
    an answer that did come back, a body that arrived and could not be decoded included. Every route of
    `PipelexAPIClient` raises it, the protocol routes it inherits from `mthds` included, because they all send
    through its `_send` override; the httpx exception is the `__cause__`.

    `network_code` names the failure: `ABORT_TIMEOUT` when the request reached the API and its time limit ran out
    while it was sent or answered (httpx's `ReadTimeout` or `WriteTimeout`), otherwise the httpx transport
    exception's class name, `ConnectError`, `ConnectTimeout` and `PoolTimeout` included, none of which sent the
    request.

    Its `problem` is the transport's: `client.timeout` naming the time limit for a request that timed out,
    `client.unreachable` naming the base URL otherwise, both with `retry` `yes`. On a request that may create a run
    (`may_start_run`, which the client sets on `start` and `execute`), it is `client.outcome_unknown` instead, whose
    `retry` is `outcome_unknown`, unless `failure`, the httpx exception the request met, proves the request never
    left: the connection or the TLS handshake failed, or no connection came. A read or write timeout, or a
    connection closed once the request had left, proves nothing, so the run may have started.

    It also subclasses `mthds`'s `ApiTransportError`, the standard client's error for a request that got no
    answer, so a handler written against the standard's client catches it too. `request_url` is the URL
    requested, the base URL when it is not given, and `timeout_seconds` the request's time limit, which the
    problem of a timeout names.
    """

    def __init__(
        self,
        message: str,
        api_url: str,
        network_code: str | None = None,
        *,
        may_start_run: bool = False,
        failure: BaseException | None = None,
        request_url: str | None = None,
        timeout_seconds: float | None = None,
    ) -> None:
        super().__init__(
            message,
            problem=_transport_problem(
                may_start_run=may_start_run, network_code=network_code, failure=failure, api_url=api_url, timeout_seconds=timeout_seconds
            ),
            api_url=api_url,
            request_url=request_url or api_url,
        )
        self.network_code = network_code


def _transport_problem(
    *, may_start_run: bool, network_code: str | None, failure: BaseException | None, api_url: str, timeout_seconds: float | None
) -> Problem:
    """The problem of a request that got no answer, agreeing with whether it may have left."""
    if may_start_run and request_may_have_left(failure):
        return outcome_unknown_problem()
    if timeout_seconds is not None:
        if isinstance(failure, httpx.TransportError):
            return transport_failure_problem(failure, creates_run=False, base_url=api_url, timeout_seconds=timeout_seconds)
        if network_code == ABORT_TIMEOUT_CODE:
            return make_client_problem(CoreCode.CLIENT_TIMEOUT, params={"seconds": timeout_seconds})
    return make_client_problem(CoreCode.CLIENT_UNREACHABLE, params={"base_url": api_url})


class PipelineExecuteTimeoutError(PipelexRequestError):
    """Raised when a blocking `execute()` (`POST /v1/execute`) is killed by the hosted gateway's ~30s
    synchronous-request ceiling.

    The blocking path cannot run methods longer than ~30s behind the hosted gateway — use the durable run
    lifecycle (`start` + `wait_for_result`, or `start_and_wait`) instead, which survives long runs and client
    disconnects. `elapsed_seconds` is how long the request ran before the gateway cut it off.

    Its `problem` is `client.outcome_unknown`: the gateway gave up on the request, and the run it carried may go
    on without its id reaching the caller, so it is looked up in the run history rather than sent again, and the
    next one is started and polled.
    """

    def __init__(self, message: str, elapsed_seconds: float) -> None:
        super().__init__(message, problem=outcome_unknown_problem())
        self.elapsed_seconds = elapsed_seconds


# ── Refusals the API answered ─────────────────────────────────────────


class MethodErrorCode(StrEnum):
    """The registry codes a refusal about a stored method or one of its versions carries, beside the core codes
    every route may answer.

    `problem.code` stays a `str`, since the registry adds codes; this enum names the ones a method caller
    branches on, and being a `StrEnum` each member equals its string (`match exc.problem.code:` with
    `case MethodErrorCode.NOT_PUBLISHED:`). Each has `domain` `input` and `retry` `no`.
    """

    UPDATE_CONFLICT = "pipelex.catalog.update_conflict"
    """`409`: the draft moved since the token a `write_draft` or a `publish_method` sent, so nothing was written
    or published. Read the method again and decide whether to keep its draft or overwrite it with the fresh
    token."""

    BEING_DELETED = "pipelex.catalog.being_deleted"
    """`409`: the method's erasure has started, on every route that addresses it."""

    NOT_PUBLISHED = "pipelex.catalog.not_published"
    """`409`: a bare `method_id` names the latest published version and the method was never published. Publish
    it, or address its draft as `mt_…@draft`."""

    NOT_FOUND = "pipelex.catalog.not_found"
    """`404`: the method is not one of the organization's, or `mt_…@<n>`, or `get_method_version`, names a
    version the method never published."""

    ORGANIZATION_NOT_FOUND = "pipelex.org.not_found"
    """`404`: the destination of a `copy_method` is one the caller does not belong to, one still being set up, or
    one that does not exist, answered alike so the platform never says whether an organization exists. An unknown
    method is `NOT_FOUND` instead."""

    COPY_TOO_LARGE = "pipelex.catalog.copy_too_large"
    """`422`: a `copy_method` past one of the copy's bounds on the stored files it copies, which the problem's
    `limit` member names (`pipelex_sdk.product_models.MethodCopyLimit`, read from `problem.model_extra`)."""


class IdempotencyErrorCode(StrEnum):
    """The registry codes a refusal about a request's `Idempotency-Key` carries.

    `problem.code` stays a `str`; being a `StrEnum` each member equals its string.
    """

    KEY_IN_USE = "request.idempotency_key_in_use"
    """`409`: an earlier request under the same key and the same body is still being handled, so nothing ran for
    this one. Its `retry` is `yes`: wait the problem's `retry_after` seconds and send the same request again under
    the **same** key, which is answered with the earlier request's outcome once it is stored. A new key would run
    it a second time."""

    CONFLICT = "request.idempotency_conflict"
    """`409`: the key was used before with a different body, or is bound to a run that has since been deleted.
    Its `retry` is `no`: the request is sent again under a new key, with the original body for the first."""


class LogoRefusalCode(StrEnum):
    """The reason the platform gives a refused logo when `update_organization_branding` refuses one.

    The refusal is one problem naming both slots' failures at once, one item of its `errors` per broken rule,
    and writes nothing. Being a `StrEnum` each member equals its string (`match item.code:` with
    `case LogoRefusalCode.TOO_SMALL:`).
    """

    NOT_AN_UPLOAD = "logo_not_an_upload"
    """The URI is neither a new upload of the organization nor the `uri` the slot already holds: a run's or a
    method's file, a stale `branding/` copy, or the other slot's logo, since a logo cannot move between slots by
    its URI."""

    NOT_FOUND = "logo_not_found"
    """No such upload in the organization."""

    TOO_LARGE = "logo_too_large"
    """The file is over 1 MiB."""

    TYPE_NOT_ACCEPTED = "logo_type_not_accepted"
    """Its bytes are not a PNG, JPEG, WebP or SVG image, whatever type the upload declared, or they are an animated
    PNG (an APNG) or an animated WebP, since a logo is a still image."""

    UNREADABLE = "logo_unreadable"
    """A raster that is damaged or cut short, its one frame being decoded whole, or that has more than 4096 × 4096
    pixels; or an SVG that is not well-formed, whose shape cannot be read, that declares XML entities or external
    references, or one of whose sides lies outside 0.001 to 1,000,000, in pixels for its `width` and `height` or in
    its own units for its `viewBox`."""

    ACTIVE_CONTENT = "logo_active_content"
    """An SVG that carries a `script` or a `foreignObject` element, any element in the XHTML namespace, an `on…`
    event handler attribute, a `set` or an `animate` that rewrites a link, an `xml-stylesheet` processing
    instruction, or a link that is neither a reference inside the file (`#…`) nor an embedded PNG, JPEG, GIF or
    WebP image (`data:image/…`), whether an `href`, an `xlink:href`, or a CSS `url()` or `src()`. Wherever a
    browser reads CSS, a `<style>` element's text or an attribute such as `style` or `fill`, an `@import`, an
    `image()` or `image-set()` and any CSS escape (a backslash) are refused too. A `<style>` element itself is
    allowed, holding only references inside the file, such as `fill:url(#grad)`."""

    NOT_SQUARE = "logo_not_square"
    """A square logo whose longer side is more than 10% longer than its shorter."""

    TOO_SMALL = "logo_too_small"
    """A raster square logo under 128 px on a side."""

    NOT_WIDE = "logo_not_wide"
    """A wide logo less than one and a half times as wide as it is tall."""

    TOO_SHORT = "logo_too_short"
    """A raster wide logo under 64 px tall."""


def _header(headers: Mapping[str, str], name: str) -> str | None:
    """A header's value, whatever the case of its name, `None` when it is absent or empty."""
    for header_name, value in headers.items():
        if header_name.lower() == name:
            return value or None
    return None


def _answer_request_id(problem: Problem, headers: Mapping[str, str]) -> str | None:
    """The id the runtime knows a request by: the problem's `request_id` member, else the `X-Request-ID` header."""
    member: object = (problem.model_extra or {}).get("request_id")
    if isinstance(member, str) and member:
        return member
    return _header(headers, REQUEST_ID_HEADER)


class ApiResponseError(PipelexRequestError, _MthdsApiResponseError):
    """A response that DID come back from the API and that the SDK cannot hand back as a result: a non-2xx
    refusal, a body that arrived and could not be decoded, or a 2xx answer the SDK could not read — a body that is
    not UTF-8 or not JSON, an empty one where the route answers JSON, JSON that is not the answer the route
    returns, or one asking for blobs the tree being saved does not hold. An answer holding signed links (a
    method's listing, the upload targets of `POST /v1/blobs/missing`) has every link redacted in `response_body`,
    and chains only a copy of a pydantic refusal whose values are redacted the same way, never a failure that
    holds the body.

    Every route of `PipelexAPIClient` raises it: the protocol routes it inherits from `mthds` (`execute`, `start`,
    `validate`, `models`, `version`), the run status and results reads, the product routes and `health`. It is
    `mthds`'s own `ApiResponseError` refined for this SDK, so a handler written against the standard's client
    (`except mthds.runners.api.exceptions.ApiResponseError`) catches it too.

    Its `problem` is the answer read as a problem (`pipelex_sdk.answer_reading.read_hosted_answer`): the body
    itself when it is a problem document, as the hosted API answers every refusal, its `pipelex.*` code and any
    member the standard does not name kept on `problem.model_extra`; and otherwise the reading of the edge's bare
    answers by their status, `client.outcome_unknown` among them for a start or an execute the gateway cut off.
    Branch on `problem.code`, never on the HTTP status or the wording of a message. `problem.retry_after` is filled
    from the `Retry-After` header when the problem invites a retry and gives none. `request_id` is the problem's
    `request_id` member, else the answer's `X-Request-ID` header, the id to hand to support.

    `str(exc)` names the request and the status and gives the problem's `detail` when the body was a problem
    document, the body as it came otherwise; for an answer the SDK could not read, it is
    `API <method> <path> answered <status> with <what>`. `status` is the answer's HTTP status whatever the
    problem's own `status` says, `status_text` its reason phrase, `response_body` its raw text, `headers` its
    headers (lower-case names), `request_url` the URL requested and `api_url` the configured base URL.
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
        problem: Problem | None = None,
        may_start_run: bool = False,
    ) -> None:
        """Build the error from the answer's facts and its problem.

        Args:
            message: What failed and why, e.g. `API POST /v1/start failed (422): <detail>`.
            api_url: The configured base URL of the API that answered.
            status: The HTTP status code of the answer.
            status_text: The HTTP reason phrase of the answer.
            response_body: The answer's body, as text.
            headers: The answer's headers, names in lower case.
            request_url: The URL the request was sent to.
            problem: The answer read as its problem. The client passes the one it read; left out, it is read here
                the same way (`read_hosted_answer`), so an error a caller builds by hand carries the problem the
                client would give it.
            may_start_run: The request was a `start` or an `execute`, which creates a run, so an answer that is no
                problem document is read for whether the run may exist. The client sets it on those two routes
                alone; it only matters when `problem` is left out.
        """
        answer_headers = headers or {}
        reading = problem or read_hosted_answer(status=status, headers=answer_headers, body=response_body, creates_run=may_start_run).problem
        super().__init__(
            message,
            problem=reading,
            api_url=api_url,
            status=status,
            status_text=status_text,
            response_body=response_body,
            headers=answer_headers,
            request_url=request_url,
            request_id=_answer_request_id(reading, answer_headers),
        )


# ── The run lifecycle ─────────────────────────────────────────────────


def run_failed_problem(*, run_id: str, status: RunStatus, run_error: Problem | None = None) -> Problem:
    """The problem of a run that ended without success, `run.failed`, naming the run and its terminal status, with
    the run's own problem nested as `run_error` when there is one.

    Args:
        run_id: The run.
        status: The run's terminal status.
        run_error: The run's own problem, when it ended with one.

    Returns:
        `run.failed`.
    """
    problem = make_client_problem(CoreCode.RUN_FAILED, params={"pipeline_run_id": run_id, "run_status": status}, pipeline_run_id=run_id)
    if run_error is None:
        return problem
    return problem.with_members(run_error=run_error.as_wire())


def nested_run_error(problem: Problem) -> Problem | None:
    """The run's own problem a `run.failed` nests as `run_error`, when it is a problem document.

    Args:
        problem: The problem of the failed run.

    Returns:
        The nested problem, or `None` when the member is absent or no problem document.
    """
    nested: object = (problem.model_extra or {}).get("run_error")
    if isinstance(nested, Problem):
        return nested
    if not isinstance(nested, dict):
        return None
    try:
        return Problem.model_validate(nested)
    except ValidationError:
        return None


class RunFailedError(PipelexRequestError):
    """Raised when a run reaches a terminal state that is not `COMPLETED` (`FAILED`, `CANCELLED`, `TERMINATED`,
    `TIMED_OUT`) — by `wait_for_result`, `start_and_wait` and `download_artifacts` when the platform answers the
    results read with HTTP 409. (`get_run_result` returns the same facts as its `failed` arm instead of raising.)

    - `problem` is `run.failed`, the results read's own problem document as the platform answered it, or the one
      the SDK builds for a failed run it learned of otherwise. Its `retry` is `no`: the run is over, and starting
      it again spends credit.
    - `run_error` is the run's own problem, which `run.failed` nests as `run_error`: why the run did not succeed,
      under its own code (`run.cancelled`, `run.timed_out`, a model's or a method's code), with its own `domain`,
      `retry` and `next_step`. Branch on it to tell a run worth starting again from one whose method or inputs
      must change. `None` when the run ended with no problem stored.
    - `status` is the run's terminal status, the typed `RunStatus` enum, and `run_id` the run.
    """

    def __init__(self, message: str, run_id: str, status: RunStatus, *, problem: Problem | None = None) -> None:
        super().__init__(message, problem=problem or run_failed_problem(run_id=run_id, status=status))
        self.run_id = run_id
        self.status = status

    @property
    def run_error(self) -> Problem | None:
        """The run's own problem, nested as `run_error`, when the run ended with one."""
        return nested_run_error(self.problem)


def _follow_failed_problem(run_id: str) -> Problem:
    """`client.follow_failed`: the client stopped following a run that may still be going."""
    return make_client_problem(CoreCode.CLIENT_FOLLOW_FAILED, params={"pipeline_run_id": run_id}, pipeline_run_id=run_id)


class RunTimeoutError(PipelexRequestError):
    """Raised when `wait_for_result` exceeds its timeout before the run is terminal.

    The run is NOT cancelled — it keeps executing server-side and can be resumed later by `run_id` (the poll loop
    just stopped waiting).

    Its `problem` is `client.follow_failed`, naming the run: its `retry` is `outcome_unknown` and its step
    `read_run`, since the run goes on and is read by its id, never started again.
    """

    def __init__(self, message: str, run_id: str, timeout_seconds: float) -> None:
        super().__init__(message, problem=_follow_failed_problem(run_id))
        self.run_id = run_id
        self.timeout_seconds = timeout_seconds


class RunStillRunningError(PipelexRequestError, _MthdsRunStillRunningError):
    """Raised when a run asked for its result is still running.

    `execute()` raises it when the server answers `202` instead of a final result: the MTHDS Protocol permits an
    implementation to degrade a synchronous `/execute` into an accepted-async response when it cannot hold the
    connection open. `download_artifacts` raises it for a run read by id that has not completed yet. Either way the
    run keeps executing server-side — resume by `run_id` (the durable run lifecycle on a hosted deployment, or the
    `location` status resource when provided); `retry_after_seconds` is the server's hint, when it gave one.

    It also subclasses `mthds`'s class of the same name, which the protocol `execute()` raises, so a handler
    written against the standard's client catches it too.

    Its `problem` is `client.follow_failed`, naming the run: its `retry` is `outcome_unknown`, since the run exists
    and executing again would pay for a second one, and its step `read_run`.
    """

    def __init__(self, message: str, run_id: str, retry_after_seconds: int | None = None, location: str | None = None) -> None:
        super().__init__(
            message,
            problem=_follow_failed_problem(run_id),
            run_id=run_id,
            retry_after_seconds=retry_after_seconds,
            location=location,
        )


class MissingMainStuffError(PipelexRequestError):
    """Raised when a completed run cannot deliver its main stuff.

    Every completed run delivers a main stuff (the pipelex >= 0.37 wire invariant), so the SDK hands consumers a
    non-null `RunResults.main_stuff`. This surfaces the contract violation when it cannot: the hosted results
    endpoint answered a `200` with a null `main_stuff`, or a blocking `execute` response named a
    `main_stuff_name` whose stuff is absent from the returned working memory. `run_id` locates the run. (A
    falsy-but-present main stuff — an empty list, `0` — is a valid output and does NOT raise; only a genuinely
    absent one does.)

    Its `problem` is `client.response_unreadable` for the `200` that broke it, naming the run: the API broke its
    own contract on a completed run.
    """

    def __init__(self, message: str, run_id: str) -> None:
        super().__init__(message, problem=response_unreadable_problem(status=200, pipeline_run_id=run_id))
        self.run_id = run_id


class RunLifecycleUnavailableError(PipelexRequestError):
    """Raised when the durable run lifecycle (`/v1/runs/*`) is not served by the configured `PIPELEX_BASE_URL`.

    Run polling is a hosted-API extension, not part of the MTHDS Protocol: the open-source `pipelex-api` runner
    executes methods but has no run store, so it 404s those routes; only a deployment that includes the platform
    block (the Pipelex Hosted API) serves status/results. A route the deployment lacks answers a `404` whose body
    is no problem document; a run the platform does not know answers a `404` problem document, `run.not_found`,
    which is an `ApiResponseError`.

    Its `problem` is `runtime.unsupported`, naming the durable run lifecycle as the capability the deployment
    lacks: the base URL points at a bare runner without it.
    """

    def __init__(self, message: str, api_url: str) -> None:
        super().__init__(message, problem=make_client_problem(CoreCode.RUNTIME_UNSUPPORTED, params={"capability": "the durable run lifecycle"}))
        self.api_url = api_url


class PagingNotTerminatingError(PipelexRequestError):
    """Raised when a paged-list iterator refuses to keep following cursors.

    The ceiling sits far beyond any real catalog, so reaching it is a server-side fault — an endpoint minting a
    fresh cursor forever — not a coverage limit the caller can raise. Raising beats returning, because a silently
    truncated list is exactly the bug paging was introduced to remove. Its `problem` is
    `client.response_unreadable` for the `200` pages that never stopped.
    """

    def __init__(self, message: str, page_limit: int) -> None:
        super().__init__(message, problem=response_unreadable_problem(status=200))
        self.page_limit = page_limit


# ── Input preparation ─────────────────────────────────────────────────


class InputPreparationError(PipelexRequestError):
    """Base class for every failure raised by input preparation (`upload_file` / `prepare_inputs`).

    Catch this to handle any preparation failure; catch a subclass to branch on the semantic category. All
    preparation failures are raised BEFORE any run is created — a run never triggers a hidden upload. Mirrors
    `@pipelex/sdk`'s `InputPreparationError` family.

    Its `problem` is the one `problem` gives: the SDK's own subclasses state theirs, a direct raise gives
    `client.argument_invalid` for an argument refused (`argument_invalid_problem`) or the wrapped error's for a
    refusal the API answered, and a consumer's subclass, such as a form reporting a missing input in its own words,
    may give any. One built with none, from a message alone, carries `client.argument_invalid` naming `inputs`,
    for the reason `unspecified`.
    """

    def __init__(self, message: str, *, problem: Problem | None = None) -> None:
        super().__init__(message, problem=problem or argument_invalid_problem(argument="inputs", reason=_UNSPECIFIED_REASON))


class InvalidLocalSourceError(InputPreparationError):
    """A local asset could not be turned into bytes — a missing or unreadable path. `source` is the offending
    path. Its `problem` is `input.file_unreadable`, naming the path.
    """

    def __init__(self, message: str, source: str) -> None:
        problem = make_client_problem(CoreCode.INPUT_FILE_UNREADABLE, params={"input": source, "file_type": "file", "reason": "unreadable"})
        super().__init__(message, problem=problem)
        self.source = source


class InvalidInputValueError(InputPreparationError):
    """A value the caller gave at a file input cannot be turned into a file to upload: a `data:` URL that does not
    decode (no comma, bad base64), or a value of a type no file input takes, neither a path or URL string, nor
    `bytes` or a `Path`, nor `{url}` content. `prepare_inputs` raises it while it reads the inputs, before anything
    is uploaded. As with `InvalidLocalSourceError`, the inputs are what must change, which is how a consumer tells
    it apart from `MethodLoadError`, a method that does not load, raised by the same preparation.

    As on `UploadNotAllowedError`, `input_name` is the input the value belongs to and `input_path` where it sits
    inside that input (`report.attachments[1]`, or the name alone for a top-level file). The message names that
    path and describes the value by its kind, never by its content, since the value is the caller's data. The twin
    of `@pipelex/sdk`'s class of the same name, whose `inputName` and `inputPath` these are. Its `problem` is
    `input.invalid`, naming the input and the path inside it.
    """

    def __init__(self, message: str, *, input_name: str, input_path: str) -> None:
        super().__init__(message, problem=make_client_problem(CoreCode.INPUT_INVALID, params={"input": input_name, "field": input_path}))
        self.input_name = input_name
        self.input_path = input_path


class UploadNotAllowedKind(StrEnum):
    """What a value refused under `allow_uploads=False` is, in a closed vocabulary a caller branches on rather than
    on the message: `local_path` — a string or a `Path` that is neither an `http(s)` URL nor a `pipelex-storage://`
    reference, which preparation would read from disk; `data_url` — a `data:` URL, which it would decode and
    upload; `bytes` — inline `bytes`. The vocabulary is `@pipelex/sdk`'s `UploadNotAllowedKind`, shared so a
    consumer of both SDKs branches on one set.
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
    """`prepare_inputs` was called with `allow_uploads=False`, and a value at a file input would need an upload: a
    local path, a `data:` URL or bytes.

    It is raised before anything is read from disk, decoded or sent to the upload route, so a server preparing
    inputs on a caller's behalf never reads a file of its own because the caller named it. `input_name` is the
    input the value belongs to, `input_path` where it sits inside that input (`report.attachments[1]`, or the name
    alone for a top-level file), and `value_kind` what it is. The value itself is neither in the message nor on the
    error, since it is the caller's data. The twin of `@pipelex/sdk`'s class of the same name. Its `problem` is
    `client.argument_invalid`, naming the input's path and the value's kind as the reason: the caller must pass an
    `http(s)` URL or a `pipelex-storage://` reference instead.
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
    """The pipe I/O answer said the method does not load (`is_valid: false`), so its signature cannot be read and
    no input can be prepared: the method, not the inputs, must change.

    Its `problem` is `method.invalid`, whose `errors` are the answer's problem items, each read member by member
    (`pipelex_sdk.problem_items.read_problem_items`), and absent when there is none; `server_message` is the
    answer's own `message`. The error's message names the first item's `detail`, else the answer's own message.
    The twin of `@pipelex/sdk`'s class of the same name.
    """

    def __init__(self, message: str, *, errors: list[ProblemItem], server_message: str | None = None) -> None:
        problem = make_client_problem(CoreCode.METHOD_INVALID)
        if errors:
            # The items as read, kept whole: one whose code breaks the code pattern is still the fault it names.
            problem = problem.model_copy(update={"errors": list(errors)})
        super().__init__(message, problem=problem)
        self.server_message = server_message


class RejectedAssetReason(StrEnum):
    """Why an asset was refused, in a closed vocabulary a caller branches on rather than on the message.

    The vocabulary is `@pipelex/sdk`'s, shared so a consumer of both SDKs branches on one set. `upload_file`
    raises `too_large`, the upload route's `413` past the service-defined size cap. The others name the refusals of
    storage to an upload made with a grant, which `@pipelex/sdk`'s `uploadWithGrant` performs: `grant_used` — a
    grant asked for without the file's hash already wrote its object (`412`; for a grant that names its bytes, a
    `412` means they are stored, and is no refusal); `grant_expired` — the grant's validity window has passed;
    `signature_mismatch` — the file's size, content type or metadata differ from what the grant signed;
    `unsigned_header` — the request carried a storage header the grant did not sign; `store_refused` — any other
    refusal from storage, such as the `400 BadDigest` of bytes other than the ones whose SHA-256 the grant was
    asked with.
    """

    TOO_LARGE = "too_large"
    GRANT_USED = "grant_used"
    GRANT_EXPIRED = "grant_expired"
    SIGNATURE_MISMATCH = "signature_mismatch"
    UNSIGNED_HEADER = "unsigned_header"
    STORE_REFUSED = "store_refused"


class RejectedAssetError(InputPreparationError):
    """The server refused the asset — most commonly a `413` past the service-defined size cap. The SDK imposes no
    client-side cap; it surfaces the server's rejection. `filename` and `status` locate it, and `reason` says why:
    the SDK sets it on every one it raises, so it is `None` only on one a caller constructs without it. Its
    `problem` is the refusal's as the API answered it, which `upload_file` passes, and otherwise the one the
    standard reads from `status` alone.
    """

    def __init__(
        self, message: str, filename: str, status: int, *, reason: RejectedAssetReason | None = None, problem: Problem | None = None
    ) -> None:
        super().__init__(message, problem=problem or status_problem(status))
        self.filename = filename
        self.status = status
        self.reason = reason


class UnsupportedUploadCapabilityError(InputPreparationError):
    """The configured deployment does not support upload (no `/v1/upload` route, seen as a `404` other than a test
    file's unknown method, which is a `TestFileRefusedError`). Upload is a hosted Pipelex-product capability even
    though the SDK can be pointed at other base URLs. `filename` is the file whose upload met it, as `upload_file`
    sent it; the route's `ApiResponseError` is its `__cause__`. Its `problem` is `runtime.unsupported`, naming file
    upload as the capability the deployment lacks: the base URL must point at a deployment that serves upload.
    """

    def __init__(self, message: str, *, filename: str | None = None) -> None:
        super().__init__(message, problem=make_client_problem(CoreCode.RUNTIME_UNSUPPORTED, params={"capability": "file upload"}))
        self.filename = filename


class UploadAuthenticationError(InputPreparationError):
    """Upload was not authorized — a `401`, or a `403` from the upload route other than a test file's refused role,
    which is a `TestFileRefusedError`. `filename` is the file whose upload was refused, as `upload_file` sent it.

    Its `problem` is the server's own when the wrapped error, which `upload_file` passes as `cause`, answered a
    problem document; pass the same error as `cause` and raise this one `from` it. Otherwise it is
    `auth.invalid_credential` when the request carried a credential and `auth.missing_credential` when it carried
    none, as `credential_sent` says, and the wrapped error's reading of the status when the caller does not say, as
    `upload_file` does not: a bare `401` is then `auth.missing_credential` and a bare `403` `auth.invalid_credential`,
    as `@pipelex/sdk` reads them.
    """

    def __init__(
        self, message: str, status: int, *, filename: str | None = None, credential_sent: bool | None = None, cause: BaseException | None = None
    ) -> None:
        super().__init__(message, problem=_credential_problem(cause=cause, credential_sent=credential_sent))
        self.status = status
        self.filename = filename


class TestFileRefusalReason(StrEnum):
    """Why the upload route refused a test file, in a closed vocabulary a caller branches on rather than on the
    message. A test file is a statement about a method, so the route holds it to what changing that method takes.
    The vocabulary is `@pipelex/sdk`'s, shared so a consumer of both SDKs branches on one set.
    """

    # pytest collects a class whose name starts with `Test` from any test module that imports it; this one is no
    # test. A dunder name is never an enum member.
    __test__ = False

    ROLE_NOT_PERMITTED = "role_not_permitted"
    """The caller's role in the organization may not change methods, as a runner's may not (the route's
    `auth.forbidden`). Upload the file as `uploaded`, or with the credential of a member who may change methods."""

    METHOD_NOT_FOUND = "method_not_found"
    """The method the test file names is not one of the organization's (the route's
    `pipelex.catalog.not_found`)."""

    METHOD_BEING_DELETED = "method_being_deleted"
    """The method the test file names is being erased (the route's `pipelex.catalog.being_deleted`)."""


class TestFileRefusedError(InputPreparationError):
    """The upload route refused a test file (`kind="test"`) for what it claims, never for its bytes: the caller's
    role may not change methods, or the method it names is unknown or being erased.

    `reason` says which: the SDK sets it on every one it raises, so it is `None` only on one a caller constructs
    without it. `status` is the HTTP status, `filename` the file `upload_file` was sending and `method_id` the
    method it named; from `upload_file` the `ApiResponseError` the client raised is its `__cause__`. The twin of
    `@pipelex/sdk`'s class of the same name, whose `methodId` is `method_id` here.

    Its `problem` is the wrapped error's when `cause` carries one, the server's own: `upload_file` passes the error
    the client's `upload()` raised. Pass the same error as `cause` and raise this one `from` it. Otherwise it is
    `auth.forbidden` for `role_not_permitted`, naming a role that may change methods as the requirement, and
    `client.argument_invalid` naming `method_id` for the other two, the reason as the reason.
    """

    # pytest collects a class whose name starts with `Test` from any test module that imports it; this one is no
    # test.
    __test__ = False

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        reason: TestFileRefusalReason | None = None,
        filename: str | None = None,
        method_id: str | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message, problem=_wrapped_problem(cause) or _test_file_refusal_problem(reason))
        self.status = status
        self.reason = reason
        self.filename = filename
        self.method_id = method_id


def _test_file_refusal_problem(reason: TestFileRefusalReason | None) -> Problem | None:
    """The problem of a test file's refusal that wraps no error carrying one; `None` leaves the family's own."""
    match reason:
        case TestFileRefusalReason.ROLE_NOT_PERMITTED:
            return make_client_problem(CoreCode.AUTH_FORBIDDEN, params={"requirement": "a role that may change methods"})
        case TestFileRefusalReason.METHOD_NOT_FOUND | TestFileRefusalReason.METHOD_BEING_DELETED:
            return argument_invalid_problem(argument="method_id", reason=reason)
        case None:
            return None


class UploadTransportReason(StrEnum):
    """Which transport failure an upload met, in a closed vocabulary a caller branches on rather than on the
    message.

    The vocabulary is `@pipelex/sdk`'s, shared so a consumer of both SDKs branches on one set. `upload_file`
    raises `timeout`, `unreachable`, `server_error` and `unexpected`; the others name the failures of an upload to
    storage made with a grant, which `@pipelex/sdk`'s `uploadWithGrant` performs.

    - `timeout` — the SDK's own time limit ran out before an answer came back (the client's request timeout,
      `ApiUnreachableError` with the network code `ABORT_TIMEOUT`). Whether the file was stored is unknown.
    - `unreachable` — no response reached the SDK.
    - `server_error` — a `5xx`. Whether the file was stored is unknown, except after a `501`: the deployment does
      not implement the request it was sent, and stored nothing.
    - `storage_timeout` — storage's `400 RequestTimeout`: it stopped waiting for the file's bytes and stored
      nothing.
    - `conflict` — storage's `409 ConditionalRequestConflict` on every one of `uploadWithGrant`'s few attempts:
      another write of the same object was in flight.
    - `redirected` — storage redirected the write, and the redirect was refused.
    - `invalid_grant_url` — the grant is not stored and its `url` is not an absolute `http(s)` URL free of user
      info, so nothing was sent.
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
    """A network or server fault reaching the upload route (unreachable host, `5xx`), or any other status the route
    answered. `status` is the HTTP status when an answer produced it and `None` when none came back; `filename` is
    the file it was sending; `reason` says which failure it was: the SDK sets it on every one it raises, so it is
    `None` only on one a caller constructs without it. From `upload_file` the `ApiResponseError` or
    `ApiUnreachableError` the client raised is its `__cause__`.

    Its `problem` is `problem` when given, else the wrapped error's when `cause` carries one: `upload_file` passes
    the error the client's `upload()` raised. Pass the same error as `cause` and raise this one `from` it. Otherwise
    `reason` decides (`upload_transport_problem`).
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        filename: str | None = None,
        reason: UploadTransportReason | None = None,
        cause: BaseException | None = None,
        problem: Problem | None = None,
    ) -> None:
        super().__init__(message, problem=problem or _wrapped_problem(cause) or upload_transport_problem(reason=reason, status=status))
        self.status = status
        self.filename = filename
        self.reason = reason


def upload_transport_problem(*, reason: UploadTransportReason | None, status: int | None) -> Problem:
    """The problem of an upload transport failure that wraps no error carrying one, by its reason and the status
    storage answered.

    Args:
        reason: The failure's reason, `None` when none was given.
        status: The status storage answered, `None` when no answer came back.

    Returns:
        - `runtime.unavailable` for `timeout`, `unreachable`, `storage_timeout` and `conflict`: storage, a service
          the upload depends on, did not take the file, and a later attempt can (the SDK's own raise sites give
          `client.timeout` and `client.unreachable` instead, naming the limit and the host);
        - `storage_status_problem`'s reading of the status for `server_error`, `unexpected` and no reason at all:
          `runtime.unavailable` for a `408`, a `429` or a `5xx` other than `501`, `runtime.unsupported` for a `501`,
          `client.response_unreadable` for any other status; a `server_error` with no status is
          `runtime.unavailable`, and the others `runtime.unexpected`;
        - `runtime.misconfigured` for `redirected`: storage redirecting a signed upload is a fault of the deployment;
        - `client.response_unreadable` for `invalid_grant_url`: the grant the API answered is unusable.
    """
    match reason:
        case (
            UploadTransportReason.TIMEOUT | UploadTransportReason.UNREACHABLE | UploadTransportReason.STORAGE_TIMEOUT | UploadTransportReason.CONFLICT
        ):
            return make_client_problem(CoreCode.RUNTIME_UNAVAILABLE)
        case UploadTransportReason.SERVER_ERROR:
            return make_client_problem(CoreCode.RUNTIME_UNAVAILABLE) if status is None else storage_status_problem(status)
        case UploadTransportReason.UNEXPECTED | None:
            return make_client_problem(CoreCode.RUNTIME_UNEXPECTED) if status is None else storage_status_problem(status)
        case UploadTransportReason.REDIRECTED:
            return make_client_problem(CoreCode.RUNTIME_MISCONFIGURED)
        case UploadTransportReason.INVALID_GRANT_URL:
            return response_unreadable_problem(status=200)


# ── A saved method's files ─────────────────────────────────────────────


class MethodFileTransferOperation(StrEnum):
    """Which way a file of a method's tree was moving when its transfer failed — `MethodFileTransferError.operation`."""

    UPLOAD = "upload"
    """A blob the platform lacked, sent to the upload target `POST /v1/blobs/missing` named, before a save."""

    DOWNLOAD = "download"
    """A file of a saved tree, read through the link `get_method` or `get_method_version` served."""


class MethodFileTransferReason(StrEnum):
    """Why a file of a method's tree could not be moved — `MethodFileTransferError.reason`, the same vocabulary as
    `@pipelex/sdk`'s.

    - `UNREACHABLE`: storage gave no answer, the connection failing or the time limit running out.
    - `STORAGE_ERROR`: storage timed out or throttled the request (`408`, `429`), or failed (a `5xx` other than
      `501`).
    - `REFUSED`: storage refused the request: any other status, an expired link among them.
    - `MISMATCH`: a download's bytes are not the file the listing names, another size or another SHA-256.
    """

    UNREACHABLE = "unreachable"
    STORAGE_ERROR = "storage_error"
    REFUSED = "refused"
    MISMATCH = "mismatch"


class MethodFileTransferError(PipelexRequestError):
    """A file of a method's tree that could not be moved between this machine and the platform's storage.

    Raised by `create_method` and `write_draft` when a blob the platform lacks could not be uploaded to the target
    `POST /v1/blobs/missing` named, so the method was not saved, by `resolve`, `codegen`, `pipe_io` and
    `prepare_inputs` for the same failure, so the request was not sent, and by `write_method_tree` when a saved file
    could not be downloaded through its link, or its bytes are not the file the listing names. `operation` says
    which way the file was moving, `reason` why it failed, `sha256` which bytes (`None` when the failure names no
    blob), `path` the tree path when one is known, and `status` storage's HTTP status when it answered. Neither the
    message, nor any member, nor a cause or a context carries the link, whose query is a bearer credential: httpx's
    error, which holds the request, is never chained.

    Its `problem` is `problem` when given, the one the standard's client stated for an upload that got no answer;
    otherwise it follows `reason` (`method_file_transfer_problem`). A problem document storage answered with is
    never kept, since it can quote the signed request.
    """

    def __init__(
        self,
        message: str,
        *,
        operation: MethodFileTransferOperation,
        reason: MethodFileTransferReason,
        sha256: str | None,
        path: str | None = None,
        status: int | None = None,
        problem: Problem | None = None,
    ) -> None:
        super().__init__(message, problem=problem or method_file_transfer_problem(reason=reason, status=status))
        self.operation = operation
        self.reason = reason
        self.sha256 = sha256
        self.path = path
        self.status = status


def method_file_transfer_problem(*, reason: MethodFileTransferReason, status: int | None) -> Problem:
    """The problem of a failed transfer of a method's file, by its reason and storage's status.

    Args:
        reason: Why the transfer failed.
        status: The status storage answered, `None` when no answer came back.

    Returns:
        `runtime.unavailable` for `unreachable` and `storage_error`, since the same transfer can succeed later;
        `storage_status_problem`'s reading of storage's status for `refused` (`client.response_unreadable` naming
        it, or `runtime.unsupported` for a `501`), `runtime.unexpected` when it gave none, a download refused for
        an expired link succeeding once the method is read again, which serves fresh links; and
        `client.response_unreadable` for `mismatch`.
    """
    match reason:
        case MethodFileTransferReason.UNREACHABLE | MethodFileTransferReason.STORAGE_ERROR:
            return make_client_problem(CoreCode.RUNTIME_UNAVAILABLE)
        case MethodFileTransferReason.REFUSED:
            return make_client_problem(CoreCode.RUNTIME_UNEXPECTED) if status is None else storage_status_problem(status)
        case MethodFileTransferReason.MISMATCH:
            return response_unreadable_problem(status=200)


def method_file_transfer_reason_of_status(status: int) -> MethodFileTransferReason:
    """The reason of a transfer storage answered with a non-2xx `status`: `storage_error` for a transient one
    (`is_transient_storage_status`), else `refused`.
    """
    return MethodFileTransferReason.STORAGE_ERROR if is_transient_storage_status(status) else MethodFileTransferReason.REFUSED


# ── Codegen trees ─────────────────────────────────────────────────────

#: The name of the lock a codegen tree carries.
CODEGEN_LOCK_FILENAME = "codegen.lock"


def lock_unreadable_problem(reason: str) -> Problem:
    """`client.file_unreadable` for the codegen lock, `reason` saying why in one identifier.

    Args:
        reason: Why the lock cannot be read (`malformed`, `unreadable`, `unsafe_artifact_path`).

    Returns:
        `client.file_unreadable` naming `codegen.lock`.
    """
    return make_client_problem(CoreCode.CLIENT_FILE_UNREADABLE, params={"path": CODEGEN_LOCK_FILENAME, "reason": reason})


class CodegenError(Exception):
    """A codegen tree this SDK refuses to write or read.

    Raised before the first byte is written when a `/v1/codegen` response, or the directory it is headed for, is
    unsafe: a `lock_filename` other than `codegen.lock`, an artifact path that could leave the output root or name
    a file type codegen never emits (absolute or drive-prefixed, a `..` or empty component, a backslash, a control
    character, an unstampable suffix, a duplicate), a lock that cannot be read or does not track exactly the
    artifacts, a symbolic link or a regular file on the way to a destination, a symbolic link on the way to a
    previously tracked path about to be pruned, a destination or such a path that is not a regular file, or a file
    already at an artifact's path that codegen does not own.

    Nothing was requested over the wire, so it derives from `Exception` rather than from the protocol base, and
    carries its `problem` all the same, stated by each raise site for its own cause:

    - `client.response_unreadable` for the `200` of a codegen response that is unsafe as it stands (an unsafe
      artifact path, a lock that cannot be read or that does not track exactly the artifacts);
    - `client.tool_outdated`, naming this SDK and its version, for a response whose lock is named otherwise than
      this SDK reads;
    - `client.file_unreadable` naming `codegen.lock`, for the reason `unsafe_artifact_path`, for a lock on disk that
      tracks an unsafe path;
    - `client.write_failed` naming the destination, for the reason `unsafe_destination`, for a directory in the way
      of a write (a symbolic link, a regular file where a directory must be, a destination that is not a regular
      file, a path escaping the output root);
    - `client.target_exists` naming the destination for a file codegen does not own.

    One built from a message alone carries `client.argument_invalid` naming `artifact_path`, for the reason
    `unsafe_artifact_path`.
    """

    def __init__(self, message: str, *, problem: Problem | None = None) -> None:
        super().__init__(message)
        self.problem = problem or argument_invalid_problem(argument="artifact_path", reason="unsafe_artifact_path")


class CodegenLockError(CodegenError):
    """A `codegen.lock` that cannot be read: malformed TOML, a shape the format does not define, bytes that are not
    UTF-8, or a `lock_version` this SDK does not know.

    It is also the offline check's one no-verdict class, raised where that check can reach no verdict at all
    rather than find a drift — including a file or directory under the output root the process cannot read, so a
    CI caller has a single thing to catch.

    An unsafe artifact path inside an otherwise well-formed lock is deliberately NOT this error but a plain
    `CodegenError`: it is a containment violation, not corrupt state a writer may recover from by replacing the
    lock.

    Its `problem`, as `@pipelex/sdk`'s `CodegenLockError` states it: `client.file_unreadable` naming `codegen.lock`
    for a lock that is malformed (the reason `malformed`, the default) or that cannot be read (the reason
    `unreadable`), the lock being the caller's own file; `client.tool_outdated`, naming this SDK and its version,
    for a lock that declares a newer `lock_version` than this SDK reads; and `client.file_unreadable` naming the
    path for a file or directory under the output root the check cannot read.
    """

    def __init__(self, message: str, *, problem: Problem | None = None) -> None:
        super().__init__(message, problem=problem or lock_unreadable_problem("malformed"))


# ── Artifact operations ───────────────────────────────────────────────


class ArtifactOperationError(PipelexRequestError):
    """Base class for the failures the artifact operations raise on their own (`fetch_artifact` /
    `download_artifacts`) — the download twin of `InputPreparationError`.

    Catch this to handle any artifact failure; catch a subclass to branch on the category. A per-reference failure
    inside a `download_artifacts` verdict is a **value on the item**, never one of these: the operation throws only
    when it can produce no verdict at all. The transport failures of the resolve route (`ApiResponseError`,
    `ApiUnreachableError`) and the run-lifecycle errors propagate unchanged, so they are not subclasses. Mirrors
    `@pipelex/sdk`'s `ArtifactOperationError` family.

    Its `problem` is `problem`, else `runtime.unexpected`: the SDK gives `client.argument_invalid` where it refuses
    an argument (a `scope`, a bound, a location, both selectors or neither), `client.write_failed` for a directory
    that cannot be created, and `client.response_unreadable` for an answer the operation cannot use.
    """

    def __init__(self, message: str, *, problem: Problem | None = None) -> None:
        super().__init__(message, problem=problem or make_client_problem(CoreCode.RUNTIME_UNEXPECTED))


class ScopeUnavailableError(ArtifactOperationError):
    """The scope `download_artifacts` was asked to walk is `None` on the run's results.

    The key WAS relayed — it is in `results.model_fields_set` — and its value is `None`, which is the platform
    saying it has no such artifact for this run. Distinct from a key the results read never carried, which is
    `FieldNotIncludedError`, and from an empty walk over a present scope, which is a produced verdict with no
    artifacts. `scope` names the scope, `run_id` the run. Its `problem` is `client.response_unreadable` for the
    `200` that relayed it, naming the run.
    """

    def __init__(self, scope: ArtifactScope, run_id: str) -> None:
        msg = f'Run "{run_id}" carries no "{scope}" artifact to walk for produced files — the results relayed it as null.'
        super().__init__(msg, problem=response_unreadable_problem(status=200, pipeline_run_id=run_id))
        self.scope = scope
        self.run_id = run_id


class ArtifactFetchError(ArtifactOperationError):
    """One reference could not be turned into a bounded stream by `fetch_artifact`.

    `reason` says why, in a closed vocabulary the download verdict shares for its per-item errors: the resolve
    route's own per-reference reasons (`invalid_storage_uri`, `forbidden`), then the fetch boundary's —
    `unsupported_url`, `plain_http_refused`, `redirect_refused`, `store_refused` (a 401/403 from the object store),
    `not_found` (404/410), `store_error` (any other non-2xx), `too_large`, `timeout`, `network`, and `unknown` for a
    failure the SDK cannot place. `status` is the store's HTTP status when one was received. `download_artifacts`
    never lets this escape: it becomes the item's `error`.

    Its `problem` is `problem` when given, else follows `reason` and `status` (`artifact_fetch_problem`). The SDK gives
    `client.download_limit_exceeded` naming the cap for `too_large`, `client.timeout` naming the budget for
    `timeout`, and `client.unreachable` naming the store's origin for a `network` failure that is one of a
    transport.
    """

    def __init__(self, message: str, uri: str, reason: str, status: int | None = None, *, problem: Problem | None = None) -> None:
        super().__init__(message, problem=problem or artifact_fetch_problem(reason=reason, uri=uri, status=status))
        self.uri = uri
        self.reason = reason
        self.status = status


def artifact_fetch_problem(*, reason: str, uri: str, status: int | None = None) -> Problem:
    """The problem of one reference's fetch failure that its raise site states none for.

    Args:
        reason: Why the fetch failed, in the download verdict's vocabulary.
        uri: The reference.
        status: The store's HTTP status, when one was received.

    Returns:
        `input.reference_not_found` naming the reference for `invalid_storage_uri`, `forbidden` and `not_found`;
        `client.link_refused` for `unsupported_url`, `plain_http_refused` and `redirect_refused`; for `store_error`
        and `store_refused`, the object store failing or refusing a link the platform has just signed,
        `storage_status_problem`'s reading of the store's status (`runtime.unavailable` for a `408`, a `429` or a
        `5xx` other than `501`, `runtime.unsupported` for a `501`, and `client.response_unreadable` naming any other
        status, a `401` or a `403` included), and `runtime.unavailable` when no status is known;
        `runtime.unavailable` for `timeout` and `network`; and `runtime.unexpected` otherwise, `unknown` and a reason
        this version does not know included.
    """
    match reason:
        case "invalid_storage_uri" | "forbidden" | "not_found":
            return make_client_problem(CoreCode.INPUT_REFERENCE_NOT_FOUND, params={"input": uri})
        case "unsupported_url":
            return make_client_problem(CoreCode.CLIENT_LINK_REFUSED, params={"reason": "unsupported_scheme"})
        case "plain_http_refused":
            return make_client_problem(CoreCode.CLIENT_LINK_REFUSED, params={"reason": "plain_http"})
        case "redirect_refused":
            return make_client_problem(CoreCode.CLIENT_LINK_REFUSED, params={"reason": "redirect"})
        case "store_error" | "store_refused":
            return make_client_problem(CoreCode.RUNTIME_UNAVAILABLE) if status is None else storage_status_problem(status)
        case "timeout" | "network":
            return make_client_problem(CoreCode.RUNTIME_UNAVAILABLE)
        case _:
            return make_client_problem(CoreCode.RUNTIME_UNEXPECTED)


class ArtifactAuthenticationError(ArtifactOperationError):
    """The resolve route refused the caller's credential (`401` / `403`) during a download.

    No further reference can be resolved with it, so the download stops — but the files already saved are real,
    and `verdict` carries the result as it stood: every item saved before the refusal, and the rest marked
    `aborted`. `status` is the route's status; the wrapped `ApiResponseError` is reachable through `__cause__`.
    (`verdict` is the download's result, not the error's own problem.) Its `problem` is the server's own when the
    wrapped error answered a problem document; otherwise `auth.invalid_credential`, or `auth.missing_credential`
    when `credential_sent` says the request carried no credential, and the wrapped error's reading of the status
    when the caller does not say, as `download_artifacts` does not: a bare `401` is then `auth.missing_credential`
    and a bare `403` `auth.invalid_credential`, as `@pipelex/sdk` reads them.
    """

    def __init__(
        self, message: str, status: int, verdict: DownloadArtifactsResult, *, credential_sent: bool | None = None, cause: BaseException | None = None
    ) -> None:
        super().__init__(message, problem=_credential_problem(cause=cause, credential_sent=credential_sent))
        self.status = status
        self.verdict = verdict


class FieldNotIncludedError(PipelexRequestError):
    """A `RunResults` field this operation needs was not carried by the results body it was read from.

    Raised when the field is absent from `results.model_fields_set` — the body did not carry the key — as opposed
    to relayed as `None`, which is a value. Carries the field's name in `field_name`.

    Its `problem` is `client.argument_invalid`, naming the results the caller handed over, which were read without
    the field, unless `problem` gives another: `download_artifacts` gives `client.response_unreadable` for the
    `200` that left the field out when it read the results itself, asking for the field.
    """

    def __init__(self, field_name: str, *, problem: Problem | None = None) -> None:
        msg = f"RunResults field `{field_name}` was not in the results body: the read did not carry it"
        super().__init__(msg, problem=problem or argument_invalid_problem(argument="results", reason="field_not_included"))
        self.field_name = field_name


# ── The caller-webhook receiver's errors ─────────────────────────────


class WebhookRefusal(StrEnum):
    """Why `verify_webhook` refused a call, named as the contract's verification procedure names its steps, in the
    order it takes them.

    - `missing_header`: `webhook-id`, `webhook-timestamp` or `webhook-signature` is absent or empty;
    - `timestamp`: `webhook-timestamp` is not a whole number of Unix seconds, or is more than five minutes from the
      receiver's clock, either way;
    - `signature`: no `v1` signature in `webhook-signature` is the call's under any secret given.
    """

    MISSING_HEADER = "missing_header"
    TIMESTAMP = "timestamp"
    SIGNATURE = "signature"

    @property
    def problem(self) -> Problem:
        """The problem a refusal carries: the call's credential absent, or refused."""
        match self:
            case WebhookRefusal.MISSING_HEADER:
                return make_client_problem(CoreCode.AUTH_MISSING_CREDENTIAL)
            case WebhookRefusal.TIMESTAMP | WebhookRefusal.SIGNATURE:
                return make_client_problem(CoreCode.AUTH_INVALID_CREDENTIAL)


class WebhookVerificationError(Exception):
    """A call `verify_webhook` refused: it does not come from the runtime holding the secret, or not within the last
    five minutes, so its body must not be acted on. Answer it with a status outside `2xx`, such as `401`, which the
    sender counts as a failed attempt and retries.

    Branch on `refusal` (a `WebhookRefusal`). Its `problem` treats the signature as the call's credential:
    `auth.missing_credential` for a missing header, `auth.invalid_credential` for a timestamp or a signature refused.
    Nothing was requested, so it derives from `Exception`, as `@pipelex/sdk`'s twin is no `PipelexRequestError`.
    """

    def __init__(self, message: str, *, refusal: WebhookRefusal) -> None:
        super().__init__(message)
        self.refusal = refusal
        self.problem = refusal.problem


class WebhookEventUnreadableError(Exception):
    """A verified call whose body is not a webhook event this SDK can read: bytes that are not UTF-8, text that is
    not JSON, JSON that is not an object with a string `type`, or a `run.finished` event missing a member the contract
    gives it or carrying one of the wrong type. The call does come from the runtime holding the secret, so this is
    that runtime's fault, never the receiver's.

    Its `problem` is `request.malformed`, whose `reason` is `not_utf8` or `not_json`, for a body that does not parse,
    and `request.invalid`, whose `field` names the member as a dotted path (`type`, `attempt`, `data.status`), for
    one that parses but is no event.
    """

    def __init__(self, message: str, *, problem: Problem) -> None:
        super().__init__(message)
        self.problem = problem
