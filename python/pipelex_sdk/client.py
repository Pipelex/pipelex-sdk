"""`PipelexAPIClient` — the Python client for the Pipelex hosted API.

Built by inheritance on `mthds`'s protocol base (`MthdsAPIClient`): the protocol
routes (`models` / `version` reused as-is; `execute` / `start` / `validate` overridden),
the transport (`_send`, wrapped; `_url`), and the request-body builders are reused; this
client adds the Pipelex branding (env resolution, optional token, host-only base-URL
validation), the richer transport/error layer, the durable run lifecycle, the product
surface, and `health`.

This module holds construction, the `_send` override that every route sends through, which
maps a request that got no answer to `ApiUnreachableError`, the product-route helper
(`_request_product`), the `_raise_api_response_error` override that every `/v1` route raises
through, the `execute` override (hosted gateway-timeout translation),
the `start` override (bare-runner 404 translation), the durable run lifecycle, the
`validate` override (markdown-render injection + `validate_files`), the Pipelex product
surface (methods, organizations, billing, API keys, onboarding, storage, run records),
the model reference check, and the origin-level `health` probe.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Any, Literal, NoReturn, Protocol, TypeVar, cast
from urllib.parse import quote, urlencode, urlparse, urlsplit

import httpx
from mthds.method_tree.digest import sha256_hex
from mthds.method_tree.lister import list_method_tree
from mthds.method_tree.models import MethodTree, TreeLimits
from mthds.method_tree.tree_path import path_collisions, tree_path_violation
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.models import MissingBlobsRequest, MissingBlobsResult, RunResultStart
from mthds.runners.api.client import MthdsAPIClient
from mthds.runners.api.exceptions import BlobUploadError as _MthdsBlobUploadError
from mthds.runners.api.exceptions import RunStillRunningError as _MthdsRunStillRunningError
from mthds.runners.api.problem import ProblemDocument
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from pydantic_core import InitErrorDetails, to_json
from typing_extensions import override

from pipelex_sdk.artifact_models import (
    BulkResolvedStorageUrls,
    DownloadArtifactsOptions,
    DownloadArtifactsResult,
    FetchArtifactOptions,
    ResolvedArtifact,
)
from pipelex_sdk.artifacts import ArtifactStream
from pipelex_sdk.artifacts import download_artifacts as _download_artifacts_impl
from pipelex_sdk.artifacts import fetch_artifact as _fetch_artifact_impl
from pipelex_sdk.artifacts import resolve_artifacts as _resolve_artifacts_impl
from pipelex_sdk.crate_models import (
    CodegenRequest,
    CodegenResponse,
    CodegenResponseAdapter,
    CrateToolingRequest,
    PipeIORequest,
    PipeIOResponse,
    PipeIOResponseAdapter,
    ResolveRequest,
    ResolveResponse,
    ResolveResponseAdapter,
)
from pipelex_sdk.error_models import FieldError
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict
from pipelex_sdk.errors import (
    ABORT_TIMEOUT_CODE,
    ApiResponseError,
    ApiUnreachableError,
    MethodFileTransferCode,
    MethodFileTransferError,
    MethodFileTransferOperation,
    MissingMainStuffError,
    PagingNotTerminatingError,
    PipelexRequestError,
    PipelineExecuteTimeoutError,
    RequestArgumentError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunStillRunningError,
    RunTimeoutError,
    method_file_transfer_code_of_status,
)
from pipelex_sdk.execute_result import PipelexExecuteResult, results_from_execute
from pipelex_sdk.model_reference_models import ModelCheckCategory, ModelReferenceVerdict, ModelReferenceVerdictAdapter
from pipelex_sdk.prepare_inputs import PreparedInputs
from pipelex_sdk.prepare_inputs import prepare_inputs as _prepare_inputs_impl
from pipelex_sdk.product_models import (
    BillingPortalResponse,
    ChangePlanResponse,
    CheckoutResponse,
    InvoiceView,
    Membership,
    MembershipsResponse,
    MethodData,
    MethodDeletionAccepted,
    MethodDetail,
    MethodExample,
    MethodExampleLatestRunResultAdapter,
    MethodExamplePage,
    MethodPage,
    MethodPublishResultAdapter,
    MethodSummary,
    MethodVersion,
    MethodVersionPage,
    PipelexApiKeyCreated,
    PipelexApiKeyList,
    PlanView,
    ResolvedStorageUrl,
    RunDetail,
    RunHistoryItem,
    RunPage,
    SavedMethodFile,
    SubscriptionResponse,
    UploadedFile,
    UserProfile,
)
from pipelex_sdk.runs import (
    PipelexRunResultStart,
    PollInfo,
    RunArtifact,
    RunProgress,
    RunRead,
    RunResultCompleted,
    RunResultFailed,
    RunResultRunning,
    RunResults,
    RunStatus,
    WaitForResultOptions,
    is_fresher_run_progress,
)
from pipelex_sdk.upload import UploadRecord, UploadSource
from pipelex_sdk.upload import upload_file as _upload_file_impl
from pipelex_sdk.user_agent import AppInfo, build_user_agent
from pipelex_sdk.validation_models import PipelexValidationResultAdapter, ValidationErrorItem

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable, Generator, Sequence
    from contextlib import AbstractAsyncContextManager

    from mthds.method_tree.file_entry import FileEntry, MethodFiles
    from mthds.method_tree.models import TreeFile
    from mthds.protocol.models import BlobRef, MissingBlob, ModelCategory, ModelDeck, ValidationDiagnostic, VersionInfo
    from mthds.protocol.pipe_output import VariableMultiplicity
    from mthds.protocol.pipeline_inputs import PipelineInputs
    from mthds.protocol.stuff import StuffType
    from mthds.protocol.working_memory import WorkingMemoryAbstract

    from pipelex_sdk.product_models import (
        MethodDraftInput,
        MethodExampleLatestRunResult,
        MethodPublishResult,
        MethodWriteInput,
        OnboardingSubmission,
        UpdateRunInput,
        UploadInput,
    )
    from pipelex_sdk.runs import RunResultState
    from pipelex_sdk.validation_models import PipelexValidationResult

# The client composes every endpoint from one origin (PIPELEX_BASE_URL): `{base}/v1/{endpoint}`.
# The same paths are served by the Pipelex Hosted API (api.pipelex.com) and by a bare
# OSS pipelex-api runner (localhost:8081) — the protocol surface is identical; only the
# hosted extensions (e.g. run polling) differ, detectable via GET /v1/version.
_API_PREFIX = "v1"
_RUNS = "runs"

#: Hosted default — the client composes every endpoint as `{base}/v1/{endpoint}`.
DEFAULT_API_BASE_URL = "https://api.pipelex.com"

_POLL_REQUEST_TIMEOUT_SECONDS = 30.0  # single status/result/product GETs; the hosted gateway caps responses at ~30s.

# A runaway backstop for every paged-list iterator, set far beyond any real catalog — never a
# coverage cap. Reaching it means the server kept minting cursors, which is a fault to raise on,
# not a limit to truncate at. It is what bounds a cursor that CYCLES (`c1 -> c2 -> c1`) over
# non-empty pages: no iterator's adjacent-cursor check sees a non-adjacent repeat.
_MAX_LIST_PAGES: int = 10_000
_DEFAULT_DEGRADED_RETRY_SECONDS = 5  # matches the platform's `_DEGRADE_RETRY_AFTER_SECONDS`.

# How much of a body that is no problem document an error's message quotes; `response_body` keeps it
# whole. The same limit as the `mthds` base, so a refusal reads the same from either client.
_REASON_BODY_LIMIT = 500

# The hosted gateway caps synchronous requests at ~30s. A failure at/after this elapsed threshold
# is the gateway's cut-off, not a transient outage — the threshold guards against mislabeling a fast
# 503 (runner genuinely down) as a timeout. The one source of the threshold in this SDK:
# `is_gateway_cut_off` reads it.
_GATEWAY_TIMEOUT_THRESHOLD_SECONDS = 28.0

# The time limit of the one request an inherited route sends, when this client's override of that route
# gives it another than the base's blocking-execute ceiling (`version`, `start`). The base builds and
# sends the request itself, through `_send`, which reads this; a context variable keeps the choice to
# the task that made it, so two calls in flight on one client never see each other's.
_REQUEST_TIMEOUT_OVERRIDE: ContextVar[float | None] = ContextVar("_REQUEST_TIMEOUT_OVERRIDE", default=None)

# Whether the request in flight may create a run: `start`, `execute` and the blocking path's lift of an
# execute set it (`_creating_run`), and `_send`, `_api_response_error` and `_unreadable_answer` read it when
# they build an error, so that the error says whether the run may have started (`run_may_have_started`).
# The inherited routes build their requests and their errors deep inside the base, which is why the choice
# travels as a context variable, kept to the task that made it as the time limit above is.
_MAY_START_RUN: ContextVar[bool] = ContextVar("_MAY_START_RUN", default=False)

# The idempotency key of the `start` in flight, which `_send` sends as the `Idempotency-Key` header. The base
# builds the start's request deep inside its own `start`, so the key travels as a context variable, kept to
# the task that set it as the time limit above is, and set only around the one request `start` sends.
_IDEMPOTENCY_KEY: ContextVar[str | None] = ContextVar("_IDEMPOTENCY_KEY", default=None)

# The request header the hosted API reads a run start's idempotency key from.
_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"

# The longest idempotency key a start sends. It is room for any generated key, and keeps the hosted API's
# stored record of the key far inside its store's limit, which a longer key could exceed, so that the start
# would run without the protection the key was sent for. `@pipelex/sdk` holds keys to the same limit.
_MAX_IDEMPOTENCY_KEY_LENGTH = 255

# Visible ASCII, `!` to `~`: what a header value carries unchanged through every proxy and both SDKs'
# transports, where httpx refuses a character outside ASCII, fetch a line break, and a space at either end is
# trimmed on the way.
_VISIBLE_ASCII = re.compile(r"[\x21-\x7e]+")


@contextmanager
def _creating_run() -> Generator[None, None, None]:
    """Mark the requests sent in this block as ones that may create a run, for the errors they meet."""
    token = _MAY_START_RUN.set(True)
    try:
        yield
    finally:
        _MAY_START_RUN.reset(token)


class _ExecuteAcceptance(RunResultStart):
    """What an `execute` `202` must carry to be a run the caller can follow: the protocol's acknowledgement
    with a run id that is not empty. Its extensions are not read, since the `RunStillRunningError` it becomes
    carries only the id, so a malformed one never turns a run that is going into an answer the SDK cannot
    read; `@pipelex/sdk`'s `throwIfExecuteDegraded` checks the same member and no other.
    """

    pipeline_run_id: str = Field(min_length=1)


class _AnswerSeen:
    """The answer `_send` last received while an inherited protocol route ran, which that route then parses."""

    __slots__ = ("response",)

    def __init__(self) -> None:
        self.response: httpx.Response | None = None


# Where `_send` records the answer an inherited route (`execute`, `start`, `models`, `version`) receives:
# the base parses that answer itself, so this client keeps it to report one the base cannot read
# (`_reading_inherited_answer`). A context variable keeps the record to the task that asked, as above.
_INHERITED_ANSWER: ContextVar[_AnswerSeen | None] = ContextVar("_INHERITED_ANSWER", default=None)

# Where the `missing_blobs` override records the answer of `POST /v1/blobs/missing` while the base prepares a
# tree (`_prepare_files`), so the `_upload_missing` override can report an answer asking for blobs the tree
# does not hold as an answer the SDK cannot read, carrying that answer's status and headers.
_MISSING_BLOBS_ANSWER: ContextVar[_AnswerSeen | None] = ContextVar("_MISSING_BLOBS_ANSWER", default=None)

# The `read_scope` of the crate request whose tree the base is preparing, which the `missing_blobs` override
# asks `POST /v1/blobs/missing` under, so the blobs are uploaded into the store the request's hash entries
# are read from. A context variable, as above, because the base asks the route with no scope of its own.
_TREE_READ_SCOPE: ContextVar[str | None] = ContextVar("_TREE_READ_SCOPE", default=None)

# What a failed upload of a tree's file prevented, as its error says it: a save's, and a crate request's.
_METHOD_NOT_SAVED = "the method was not saved"
_REQUEST_NOT_SENT = "the request was not sent"

# What stands in for a signed link in an error: its query is a bearer credential, valid until it expires.
_REDACTED = "[redacted]"

# The query of a link in text that is not JSON, or in a member other than `url`: everything from `?` to the
# next space or quote, dropped with its signature, as `@pipelex/sdk`'s `redactSignedLinks` drops it.
_LINK_QUERY = re.compile(r"(\bhttps?://[^\s\"'<>?#]*)\?[^\s\"'<>]*", re.IGNORECASE)

# What reads a 2xx answer into the type a route returns: a model's `model_validate`, an adapter's
# `validate_python`, or a function of the route's own.
_AnswerT = TypeVar("_AnswerT")

# The response header the platform and its gateway set to correlate a request with their logs, read for
# an answer the SDK cannot read, which carries no problem document to read it from.
_REQUEST_ID_HEADER = "x-request-id"

# The answers this client reads that are not objects of a model of its own: the liveness probe's
# free-form object, and the plans and invoices the billing routes list.
_HEALTH_ANSWER_ADAPTER: TypeAdapter[dict[str, Any]] = TypeAdapter(dict[str, Any])
_PLAN_LIST_ADAPTER: TypeAdapter[list[PlanView]] = TypeAdapter(list[PlanView])
_INVOICE_LIST_ADAPTER: TypeAdapter[list[InvoiceView]] = TypeAdapter(list[InvoiceView])

# The pydantic error types with which a reader refuses, at the root of the body, JSON that is not an object
# where its route answers one: a model's `model_type`, the liveness probe's free-form object's `dict_type`, and
# a discriminated union's `model_attributes_type` (`validate`, `pipe_io`, `publish_method` and the like). A
# list route's root refusal, `list_type`, is not among them, since an object is no more its answer than `null`.
_NOT_AN_OBJECT_ERROR_TYPES = frozenset({"model_type", "dict_type", "model_attributes_type"})


def _no_answer(_answer: object) -> None:
    """Take the JSON body of a route that answers no content, which nothing reads: decoding it is the check."""


def _refuses_a_non_object(failure: ValidationError) -> bool:
    """Whether a reader refused the body at its root for not being an object, where its route answers one.

    Such a refusal is an error located at the root, `loc == ()`, of one of `_NOT_AN_OBJECT_ERROR_TYPES`.
    An object of the wrong shape is refused below the root, or at it with another type (a discriminated
    union's `union_tag_not_found`), so it is not one.
    """
    return any(error["loc"] == () and error["type"] in _NOT_AN_OBJECT_ERROR_TYPES for error in failure.errors(include_url=False))


def _unreadable_what(failure: json.JSONDecodeError | UnicodeDecodeError | ValidationError, response: httpx.Response) -> str:
    """What a 2xx answer that failed to parse is, as `_unreadable_answer`'s message names it.

    A body that is not UTF-8, a body that is not JSON, an empty body where JSON was expected, a body
    that is not an object where the route answers one (`null`, a number, a string, a list), worded as
    `@pipelex/sdk` words it, or a body that is not the answer the route returns: an object of the wrong
    shape, or anything but a list where the route answers a list.
    """
    what: str
    match failure:
        case UnicodeDecodeError():
            what = "a body that is not UTF-8"
        case json.JSONDecodeError():
            what = "a body that is not JSON" if response.content else "an empty body where JSON was expected"
        case ValidationError():
            what = "a body that is not an object" if _refuses_a_non_object(failure) else "a body that is not the answer the route returns"
    return what


def _raise_with_cause_alone(error: BaseException, *, cause: BaseException | None) -> NoReturn:
    """Raise `error` with `cause` as its cause and no context, so nothing else it replaces travels with it.

    Raised while another exception is handled, an exception takes that one as its `__context__`, even
    `from None`, which only hides it from a traceback. An answer carrying signed links fails to parse
    with errors that hold it (a pydantic `ValidationError` holds and prints the values it refused, a
    `JSONDecodeError` the whole document), so the error raised in its stead reaches none of them: the
    context is cleared as it propagates, and the cause is only ever a redacted copy.
    """
    error.__cause__ = cause
    try:
        raise error
    finally:
        error.__context__ = None


def _validation_error_without_links(failure: json.JSONDecodeError | UnicodeDecodeError | ValidationError) -> ValidationError | None:
    """A copy of a pydantic refusal of an answer carrying signed links, every link in its values redacted, to chain in its stead.

    The copy keeps each error's type, location and context, so a caller reading which member was
    refused reads it as before, while each refused value has its `url` members and its links' queries
    redacted. A body that is not UTF-8 or not JSON has no such copy: its failure holds the raw body.
    Neither has a refusal that holds a validator's own exception, whose message may quote anything, or
    one of a validator's own error types, which pydantic cannot rebuild by name.
    """
    if not isinstance(failure, ValidationError):
        return None
    details: list[InitErrorDetails] = []
    for error in failure.errors(include_url=False):
        context = error.get("ctx")
        if context is not None and "error" in context:
            return None
        detail: InitErrorDetails = {"type": error["type"], "loc": error["loc"], "input": _with_links_redacted(error["input"])}
        if context is not None:
            detail["ctx"] = context
        details.append(detail)
    try:
        return ValidationError.from_exception_data(failure.title, details)
    except KeyError:
        # "Invalid error type": a validator's own `PydanticCustomError`, known by no name pydantic holds.
        return None


def _redact_signed_links(text: str) -> str:
    """`text` with every signed link redacted, `@pipelex/sdk`'s `redactSignedLinks`.

    A JSON body has every `url` member replaced, at any depth, and is written back compactly; then, in
    any text, the query of every `http(s)` link is replaced, which catches a link in another member or
    in a body that is not JSON. A link's query is a bearer credential, so no error carries one.
    """
    redacted = text
    with suppress(json.JSONDecodeError, RecursionError):
        # Not JSON, or nested too deep to walk: the link pattern below still finds every query.
        redacted = json.dumps(_with_links_redacted(json.loads(text)), separators=(",", ":"), ensure_ascii=False)
    return _LINK_QUERY.sub(rf"\1?{_REDACTED}", redacted)


def _with_links_redacted(value: object) -> object:
    """A decoded JSON value with every `url` member of every object in it replaced, and every link's query in every string."""
    if isinstance(value, dict):
        members = cast("dict[str, object]", value)
        return {key: _REDACTED if key == "url" else _with_links_redacted(member) for key, member in members.items()}
    if isinstance(value, list):
        return [_with_links_redacted(item) for item in cast("list[object]", value)]
    if isinstance(value, str):
        return _LINK_QUERY.sub(rf"\1?{_REDACTED}", value)
    return value


_PIPELEX_API_KEY_ENV = "PIPELEX_API_KEY"
_PIPELEX_BASE_URL_ENV = "PIPELEX_BASE_URL"

# `VersionInfo.implementation` of the bare open-source runner (no run store). Anything
# else — the hosted implementation first — is assumed to serve the durable run-lifecycle
# extension; a wrong guess still fails with a clear `RunLifecycleUnavailableError` on the
# first poll (or self-heals through `start_and_wait`'s blocking-execute fallback).
_BARE_RUNNER_IMPLEMENTATION = "pipelex-api"

# `validate` always asks the Pipelex API for the Markdown view so both a valid result and a
# produced validation-error verdict carry `rendered_markdown`; callers may add more tokens.
_VALIDATE_MARKDOWN_RENDER_FORMAT = "markdown"

# The PIPELEX API's own run args — the layer-2 extensions the RUNNER reads itself: `method_ref`,
# a run source in its own right, and `mthds_contents`, the inline bundles the protocol carried
# before it sent a method as its `files` tree, which the Pipelex API still reads. Named
# parameters here, travelling to the base client through its generic `extra` passthrough exactly
# like the hosted args below. Reserved on `extra` for the same reason: a smuggled copy would
# arrive by a second path with different validation and bypass the selector-exclusivity checks.
_PIPELEX_API_RUN_ARGS: frozenset[str] = frozenset({"method_ref", "mthds_contents"})

# The HOSTED API's own run args — the layer-3 extensions this client names itself, on top of
# the MTHDS Protocol's basic run args. They are named parameters here and travel to the base
# client through its generic `extra` passthrough, which is exactly the layering: the protocol
# client merges them into the body without knowing what they mean.
#
# Reserved on `extra` for the same reason the protocol args are: one argument must not arrive
# by two paths with different validation. The guard is deliberately PER LAYER — it lives here
# and must never be pushed down into `mthds`, because a protocol client talking to another
# vendor's server has no business rejecting that vendor's arguments. This is the layered
# extension policy: a hosted client types its own platform's arguments and guards them per layer.
_HOSTED_RUN_ARGS: frozenset[str] = frozenset({"method_id"})

# Every request arg this client names itself and therefore guards on `extra` — the union of
# the layer-2 and layer-3 sets above.
_RESERVED_RUN_ARGS: frozenset[str] = _PIPELEX_API_RUN_ARGS | _HOSTED_RUN_ARGS

# `method_ref` resolution can make the server CLONE a repository before it answers, and the
# server-side clone timeout runs well past the 30s management budget on a cold cache — an
# abort there would report a healthy, still-cloning server as unreachable. So a
# `method_ref`-carrying crate request gets this internal fetch-sized budget instead of
# `_POLL_REQUEST_TIMEOUT_SECONDS` (no new caller-facing parameter, and inert behind the
# hosted gateway's own cap). The run routes and `validate` need no such override: the
# blocking `execute`, `validate` and a `method_ref` start take the whole
# `request_timeout_seconds` (20 min by default), which clears any clone. Mirrors the JS SDK's `METHOD_REF_FETCH_TIMEOUT_MS`.
_METHOD_REF_FETCH_TIMEOUT_SECONDS = 180.0


class MthdsFile(BaseModel):
    """One MTHDS file submitted to `validate_files` — content plus an optional provenance URI.

    The URI is threaded into validation diagnostics so cross-file errors name the owning
    file; an absent URI yields `source: null` for that content (unless any sibling file
    carries one, in which case a deterministic `inline://` label is synthesized).
    """

    #: File contents to validate.
    content: str
    #: Optional provenance URI threaded into validation diagnostics.
    uri: str | None = None


class PipelexAPIClient(MthdsAPIClient):
    """Client for the Pipelex hosted API — and any MTHDS-compliant runner.

    One base URL (`PIPELEX_BASE_URL`); every endpoint is `<base>/v1/<endpoint>`:
    - **protocol** (`execute` / `start` / `validate` / `models` / `version`) — inherited
      from `MthdsAPIClient`; works against any MTHDS-compliant runner, hosted or bare.
    - **run lifecycle** (`get_run_status` / `get_run_progress` / `get_run_result` /
      `wait_for_result`) — the durable polling extension (added in Phase 2).
    - **product** (`/v1/me`, `/v1/methods`, `/v1/billing/*`, …) — the hosted product
      surface (added in Phase 3), reached through `_request_product` so callers branch
      on the structured `ApiResponseError.code`, not the HTTP status. The two list routes
      are paged: `list_methods` / `list_runs` answer one `{items, next_cursor}` page, and
      `iterate_methods` / `iterate_runs` follow the cursors for the whole catalog.

    Every `/v1` route — protocol, lifecycle and product — raises this SDK's `ApiResponseError`
    on a non-2xx answer, its message and members carrying the problem document's reason, the
    next step the server advises and, for a refused run, the diagnostics naming the failing pipe.
    Every route, `health` included, raises `ApiUnreachableError` when no answer came back at all
    (a DNS failure, a refused connection, a TLS failure, a timeout), never httpx's own exception.

    Construction is Pipelex-only — it never reads the `mthds` resolver (`MTHDS_API_KEY` /
    `MTHDS_BASE_URL`, `~/.mthds/config`), whose values are a credential pair for whatever
    runner the vendor-neutral `mthds` tooling targets, not for this client. The API key
    resolves from the `api_key` argument, then `PIPELEX_API_KEY`, then anonymous; the token
    is optional — anonymous access works against the protocol routes, while product routes
    return `401`. The base URL resolves from the `base_url` argument, then
    `PIPELEX_BASE_URL`, then the hosted default (`https://api.pipelex.com`). Both chains
    match the JS SDK exactly. The base URL is validated host-only (no
    path/query/fragment/credentials; http/https only). `request_timeout_seconds` (default 20 min)
    is the time limit of the routes that can take long: the blocking `execute`, `validate`,
    `models`, and a `start` carrying a bundle (`mthds_contents`, `files` or `bundle_b64`) or a
    `method_ref`. `version` and any other `start` answer fast, so they take it capped at the
    30-second poll budget, the hosted gateway's own cut-off.
    `app_info` (an `AppInfo`) puts the integrator's own name before this SDK's tokens in the
    `User-Agent` every request carries (see `pipelex_sdk.user_agent`).
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        request_timeout_seconds: float | None = None,
        app_info: AppInfo | None = None,
    ) -> None:
        # Pipelex-only resolution — this SDK never reads the mthds resolver (`MTHDS_*`
        # env vars, `~/.mthds/config`). That config stores a (base_url, api_key) pair for
        # whatever runner the vendor-neutral mthds tooling targets; borrowing its key while
        # ignoring its URL would send a credential configured for another runner to
        # api.pipelex.com. So the api_key resolves arg > `PIPELEX_API_KEY` > anonymous,
        # matching the JS SDK's `options.apiKey ?? process.env.PIPELEX_API_KEY`.
        #
        # DO NOT collapse the argument layer into `api_key or os.environ.get(...)`:
        # `or` treats "" as falsy and would fall through, silently discarding an explicit
        # anonymous request (`api_key=""`) and reaching for a configured env key instead.
        # We test `is not None` (presence, not truthiness) precisely to honor the empty
        # string, matching the JS SDK's `??` chain. The env layer needs no such care —
        # its fallthrough target IS anonymous ("").
        self.api_key: str
        if api_key is not None:
            self.api_key = api_key
        else:
            self.api_key = os.environ.get(_PIPELEX_API_KEY_ENV, "")

        # The base_url chain is presence-semantics too (`is not None` at the argument AND
        # env layers), matching the JS SDK's `??` chain: an explicit empty string — an
        # `base_url=""` argument or a set-but-empty `PIPELEX_BASE_URL` (e.g. an unfilled CI
        # secret) — must reach the host-only validator below and fail fast, NOT silently
        # fall through to the hosted default and send the configured API key there.
        resolved_base_url: str
        if base_url is not None:
            resolved_base_url = base_url
        else:
            env_base_url = os.environ.get(_PIPELEX_BASE_URL_ENV)
            resolved_base_url = env_base_url if env_base_url is not None else DEFAULT_API_BASE_URL
        normalized_base_url = resolved_base_url.rstrip("/")
        # The base URL must be host-only: a path-prefixed value (e.g. `.../v1`) would
        # compose as `/v1/v1/...` and fail with a misleading endpoint error instead of a
        # clear base-URL one. Trailing slashes are stripped first; any remaining
        # path/query/fragment/credentials is rejected. The refusal never quotes the value whole:
        # what the rule refuses is where a secret travels (a password, a token in a query), so it
        # names those parts without their text, word for word as `@pipelex/sdk` does. Its verdict is
        # `config`: the value typically comes from PIPELEX_BASE_URL, the environment.
        if not _is_valid_base_url(normalized_base_url):
            msg = (
                f"Invalid API base URL {_describe_refused_base_url(normalized_base_url)}: it must be host-only "
                "(http/https, no path, query, fragment, or credentials). "
                "Endpoints compose as {base}/v1/{endpoint}."
            )
            raise RequestArgumentError(msg, verdict=ErrorVerdict(error_domain=ErrorDomain.CONFIG, retryable=False))
        self.base_url: str = normalized_base_url
        #: Origin root derived from the base URL — `/health` lives here, not under `/v1`.
        self.origin_url: str = _origin_of(normalized_base_url)
        #: The time limit of the routes that can take long: the blocking `execute`, `validate`,
        #: `models`, and a `start` carrying a bundle or a `method_ref`. `version` and any other
        #: `start` take it capped at `_POLL_REQUEST_TIMEOUT_SECONDS`. The default is the base's
        #: `_DEFAULT_REQUEST_TIMEOUT_SECONDS` ClassVar (20 min, the runner's blocking-execute
        #: ceiling — part of the documented protected extension surface). The SDK's own poll and
        #: product GETs pass `_POLL_REQUEST_TIMEOUT_SECONDS` instead.
        self.request_timeout_seconds: float = (
            request_timeout_seconds if request_timeout_seconds is not None else self._DEFAULT_REQUEST_TIMEOUT_SECONDS
        )
        #: The integrator's own name, placed before this SDK's tokens in the `User-Agent`.
        # Since `mthds` 0.16.0 the base declares `app_info` as its own `AppInfo`, which it only ever
        # writes (in `init_user_agent`, never called here). This SDK keeps its own model and builder
        # until it adopts the base's `user_agent_sdk_tokens` seam, so the narrow ignore covers that one divergence.
        self.app_info: AppInfo | None = app_info  # type: ignore[assignment]
        #: The `User-Agent` sent on every request (spec: `conformance/specs/client-identification.md`,
        #: in the `conformance` repository), built once here so an over-long header fails at
        #: construction, not on the first call.
        self.user_agent: str = build_user_agent(app_info)
        self.client: httpx.AsyncClient | None = None
        #: Cached `/v1/version` handshake outcome — whether the durable lifecycle is served.
        self._lifecycle_available: bool | None = None

    @override
    def start_client(self) -> PipelexAPIClient:
        """Initialize the HTTP client. The Authorization header is sent only when a key
        is configured — anonymous access (empty key) omits it, matching the JS SDK. The
        `User-Agent` is a default header of this one client, so every API request carries it;
        the object-store client of `artifacts` is separate and keeps httpx's own.
        """
        headers = {"User-Agent": self.user_agent}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        self.client = httpx.AsyncClient(headers=headers)
        return self

    # ── Transport (the inherited `_send`, mapped) and its extensions ──────

    @override
    async def _send(self, method: str, url: str, *, content: bytes | None, request_timeout: float) -> httpx.Response:
        """Issue one request through the base's `_send`, mapping a request that got no answer to `ApiUnreachableError`.

        Overrides the protected transport seam of the `mthds` base, which every route sends through: the
        inherited protocol routes (`execute`, `start`, `validate`, `models`, `version`) as well as this
        client's run reads, product routes and `health`. So a DNS failure, a refused connection, a TLS
        failure or a timeout raises the same `ApiUnreachableError` whichever route met it, never httpx's own
        exception. Non-2xx interpretation stays the caller's: an answer is returned raw, whatever its status.

        Raises:
            ApiUnreachableError: No answer came back. `code` is `ABORT_TIMEOUT` when the request reached
                the server and the time limit ran out while it was sent or answered (`ReadTimeout`,
                `WriteTimeout`), which is what the `execute` override reads to tell the hosted gateway's
                cut-off. Any other failure carries the httpx exception's class name (`ConnectError`, …),
                a `ConnectTimeout` or a `PoolTimeout` included: neither sent the request, so neither can be
                the gateway's cut-off however long it took. A body httpx cannot decode, such as a broken
                gzip stream, is `DecodingError`.

        Inside `_reading_inherited_answer` it also records the answer, which the inherited route then
        parses, so that an answer that route cannot read is reported as every other route reports it. Inside
        `_creating_run`, the error says whether the run the request may create may have started. While `start`
        holds an idempotency key (`_IDEMPOTENCY_KEY`), the request carries it as the `Idempotency-Key` header
        (`_send_with_idempotency_key`).
        """
        timeout = _REQUEST_TIMEOUT_OVERRIDE.get()
        effective_timeout = request_timeout if timeout is None else timeout
        idempotency_key = _IDEMPOTENCY_KEY.get()
        try:
            if idempotency_key is None:
                response = await super()._send(method, url, content=content, request_timeout=effective_timeout)
            else:
                response = await self._send_with_idempotency_key(
                    method, url, content=content, request_timeout=effective_timeout, idempotency_key=idempotency_key
                )
        except (httpx.ReadTimeout, httpx.WriteTimeout) as exc:
            msg = f"Could not reach Pipelex API at {self.base_url} (timeout)"
            raise ApiUnreachableError(msg, api_url=self.base_url, code=ABORT_TIMEOUT_CODE, may_start_run=_MAY_START_RUN.get(), failure=exc) from exc
        except (httpx.TransportError, httpx.DecodingError) as exc:
            # A body httpx cannot decode, a broken gzip stream for one, is lost on the way as surely as a
            # dropped connection, and `@pipelex/sdk` reports it the same way (`Z_DATA_ERROR`).
            code = type(exc).__name__
            msg = f"Could not reach Pipelex API at {self.base_url} ({code})"
            raise ApiUnreachableError(msg, api_url=self.base_url, code=code, may_start_run=_MAY_START_RUN.get(), failure=exc) from exc
        seen = _INHERITED_ANSWER.get()
        if seen is not None:
            seen.response = response
        return response

    async def _send_with_idempotency_key(
        self, method: str, url: str, *, content: bytes | None, request_timeout: float, idempotency_key: str
    ) -> httpx.Response:
        """Send one request as the base's `_send` sends it, plus the `Idempotency-Key` header.

        The base's `_send` builds its headers itself and takes none from its caller, so the one request that
        carries a key, `start`'s, is sent here with the headers the base sets (`Accept`, `User-Agent`, and
        `Content-Type` beside a body) and the key, through the same client. A unit test holds a keyed start to
        the headers of an unkeyed one plus the key, so a header the base adds later fails that test rather than
        going missing from a keyed start. The `_send` override maps this request's failures as it maps the
        base's.
        """
        if self.client is None:
            self.start_client()
        # `start_client` opens the client, as the base's `_send` relies on.
        http_client = cast("httpx.AsyncClient", self.client)
        headers = {"Accept": "application/json", "User-Agent": self.user_agent, _IDEMPOTENCY_KEY_HEADER: idempotency_key}
        if content is not None:
            headers["Content-Type"] = "application/json"
        return await http_client.request(method, url, content=content, headers=headers, timeout=request_timeout)

    async def _request_product(
        self,
        method: str,
        endpoint: str,
        *,
        read: Callable[[Any], _AnswerT],
        body: object | None = None,
        request_timeout: float | None = None,
        carries_links: bool = False,
    ) -> _AnswerT:
        """Issue a Pipelex-product request (`/v1/me`, `/v1/methods`, `/v1/billing/*`, …)
        and read its JSON body with `read`, mapping a non-2xx response to the typed `ApiResponseError`
        so callers branch on the structured `code` discriminant, not the HTTP status.

        A 2xx answer `read` cannot take — a body that is not JSON, an empty one included, or not the
        object the route returns — raises the `ApiResponseError` `_unreadable_answer` builds (see
        `_read_answer`). Uses the management-call timeout, not the blocking ceiling;
        `request_timeout` overrides it for the crate calls whose `method_ref` closure
        the server may have to fetch first (see `_METHOD_REF_FETCH_TIMEOUT_SECONDS`).
        `carries_links` marks an answer holding signed links, which an error reports redacted.
        """
        response = await self._product_answer(method, endpoint, body=body, request_timeout=request_timeout)
        return self._read_v1_answer(read, method=method, endpoint=endpoint, response=response, carries_links=carries_links)

    async def _request_product_without_answer(self, method: str, endpoint: str, *, body: object | None = None) -> None:
        """Issue a Pipelex-product request whose route answers no content (`DELETE` of a key,
        onboarding, a run update), mapping a non-2xx response to the typed `ApiResponseError`.

        A 2xx with no body is the answer. A body the route does send must still be JSON, as
        `@pipelex/sdk` reads it: one that is not raises the `ApiResponseError` of an answer the SDK
        cannot read.
        """
        response = await self._product_answer(method, endpoint, body=body, request_timeout=None)
        if response.content:
            self._read_v1_answer(_no_answer, method=method, endpoint=endpoint, response=response)

    async def _product_answer(self, method: str, endpoint: str, *, body: object | None, request_timeout: float | None) -> httpx.Response:
        """Send a Pipelex-product request and return its 2xx answer, a non-2xx one raised as `ApiResponseError`."""
        content = to_json(body) if body is not None else None
        effective_timeout = request_timeout if request_timeout is not None else _POLL_REQUEST_TIMEOUT_SECONDS
        response = await self._send(method, self._url(endpoint), content=content, request_timeout=effective_timeout)
        if not 200 <= response.status_code < 300:
            self._raise_api_response_error(method=method, endpoint=endpoint, response=response)
        return response

    def _read_v1_answer(
        self, read: Callable[[Any], _AnswerT], *, method: str, endpoint: str, response: httpx.Response, carries_links: bool = False
    ) -> _AnswerT:
        """Read a `/v1` route's 2xx answer, `endpoint` being the endpoint below `/v1`, query included; see `_read_answer`."""
        return self._read_answer(
            read, method=method, path=f"/{_API_PREFIX}/{endpoint}", request_url=self._url(endpoint), response=response, carries_links=carries_links
        )

    def _read_answer(
        self,
        read: Callable[[Any], _AnswerT],
        *,
        method: str,
        path: str,
        request_url: str,
        response: httpx.Response,
        carries_links: bool = False,
    ) -> _AnswerT:
        """Read a 2xx answer's JSON body into the type its route returns — the one place a success body is
        parsed, but for the inherited protocol routes, which parse their own (`_reading_inherited_answer`).

        `read` is what takes the decoded body: a model's `model_validate`, an adapter's
        `validate_python`, or a function of the route's own, which may raise an error of its own that
        passes through. A body that is not UTF-8 or not JSON, an empty one included, and JSON that `read`
        refuses with a pydantic `ValidationError`, are an answer the SDK cannot read, raised as the
        `ApiResponseError` `_unreadable_answer` builds, the parse failure as its `__cause__`.

        An answer that `carries_links` (a method's listing, whose every file holds a signed link) is
        reported with its links redacted, and the parse failure itself is chained neither as the cause
        nor as the context, since a pydantic `ValidationError` holds and prints the values it refused, a
        link among them, a `JSONDecodeError` holds the whole document, and a traceback prints the chain:
        the cause is a copy of a `ValidationError` with every link in its values redacted, and nothing
        for the other failures.

        Args:
            read: What turns the decoded body into the route's answer.
            method: The HTTP method of the request, for the message (`GET`).
            path: The path the message names (`/v1/me`, or `/health` at the origin).
            request_url: The URL the request was sent to.
            response: The API's 2xx answer.
            carries_links: Whether the answer holds signed links, which no error may carry.

        Raises:
            ApiResponseError: The answer cannot be read; its verdict is `runtime`, not retryable.
        """
        try:
            return read(response.json())
        except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
            error = self._unreadable_answer(
                method=method,
                path=path,
                request_url=request_url,
                response=response,
                what=_unreadable_what(exc, response),
                carries_links=carries_links,
            )
            if carries_links:
                _raise_with_cause_alone(error, cause=_validation_error_without_links(exc))
            raise error from exc

    @contextmanager
    def _reading_inherited_answer(self, *, method: str, endpoint: str, carries_links: bool = False) -> Generator[_AnswerSeen, None, None]:
        """Run an inherited protocol route so that a 2xx answer it cannot read raises this SDK's
        `ApiResponseError`, as every other route's does.

        The base's `execute`, `start`, `models`, `version` and `missing_blobs` parse the answer `_send`
        handed them themselves, with `response.json()` and a pydantic model, so a body that is not UTF-8,
        not JSON or not the route's object raises a bare `UnicodeDecodeError`, `json.JSONDecodeError` or
        `ValidationError` there. Inside this block `_send` records the answer it receives, and such a
        failure met after a 2xx answer is raised again as the error `_unreadable_answer` builds, the
        parse failure as its `__cause__`. One met before any answer, while the base built the request
        from the caller's arguments, is the caller's and passes through untouched, as does one met after
        a non-2xx answer. A block nested in another shares its record, so a block around a route and
        the parse of its result that follows, as `_execute_blocking` lifts `execute`'s, reports a
        failure of either. A test that replaces `_send` with a mock records nothing, so it meets the
        bare failure: drive such a test through an `httpx.MockTransport` instead.

        Args:
            method: The HTTP method of the route's request, for the message (`POST`).
            endpoint: The endpoint below `/v1`, query included, exactly as the base sends it.
            carries_links: Whether the answer holds signed links (`blobs/missing`'s upload targets): its
                links are redacted, and the parse failure is chained redacted or not at all, as
                `_read_answer` does.

        Yields:
            The record of the answer the block receives, which holds it once the route has sent.
        """
        seen = _INHERITED_ANSWER.get() or _AnswerSeen()
        token = _INHERITED_ANSWER.set(seen)
        try:
            yield seen
        except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
            response = seen.response
            if response is None or not response.is_success:
                raise
            error = self._unreadable_answer(
                method=method,
                path=f"/{_API_PREFIX}/{endpoint}",
                request_url=self._url(endpoint),
                response=response,
                what=_unreadable_what(exc, response),
                carries_links=carries_links,
            )
            if carries_links:
                _raise_with_cause_alone(error, cause=_validation_error_without_links(exc))
            raise error from exc
        finally:
            _INHERITED_ANSWER.reset(token)

    def _unreadable_answer(
        self, *, method: str, path: str, request_url: str, response: httpx.Response, what: str, carries_links: bool = False
    ) -> ApiResponseError:
        """The `ApiResponseError` of a 2xx answer the SDK cannot read, `@pipelex/sdk`'s `unreadableAnswer`.

        Its message is `API <method> <path> answered <status> with <what>`, `what` naming why the answer
        cannot be read: the parse failure as `_unreadable_what` words it, or a fault of the answer's
        meaning, such as `blobs/missing` asking for blobs the tree does not hold. It carries the answer's
        status, its raw text as `response_body`, its links redacted when it `carries_links`, its headers,
        and the `X-Request-ID` header as `request_id`, but no problem member, since a success body is no
        problem document; its verdict is the fallback's for a status no refusal carries, `runtime` and
        not retryable, since no change to the call fixes the answer. Inside `_creating_run`, the run may
        have started: the server accepted the request. The caller raises it `from` the failure, which
        becomes its `__cause__`, or, for an answer that carries links, with a redacted copy of it or none.
        """
        request_id = response.headers.get(_REQUEST_ID_HEADER)
        return ApiResponseError(
            f"API {method} {path} answered {response.status_code} with {what}",
            api_url=self.base_url,
            status=response.status_code,
            status_text=response.reason_phrase,
            response_body=_redact_signed_links(response.text) if carries_links else response.text,
            headers=dict(response.headers),
            request_url=request_url,
            request_id=request_id or None,
            may_start_run=_MAY_START_RUN.get(),
        )

    @override
    def _raise_if_execute_degraded(self, response: httpx.Response) -> None:
        """Map the protocol's optional `202` execute degrade to `RunStillRunningError`, once the answer names its run.

        The base raises `RunStillRunningError` for any `202`, with an empty run id when the body names
        none. Such an answer leaves the caller a run it cannot follow, as a start acknowledgement without
        its id does, so it is read here against `_ExecuteAcceptance`: a body that is not JSON, or that names
        no run or an empty one, fails the read, and the `_reading_inherited_answer` block around `execute`
        raises it as an answer the SDK cannot read, which inside `_creating_run` may have started a run.
        `@pipelex/sdk`'s `throwIfExecuteDegraded` reads the same answers the same way.
        """
        if response.status_code == 202:
            _ExecuteAcceptance.model_validate(response.json())
        super()._raise_if_execute_degraded(response)

    @override
    def _raise_api_response_error(self, *, method: str, endpoint: str, response: httpx.Response) -> NoReturn:
        """Raise this SDK's `ApiResponseError` for a non-2xx answer to a `/v1` route.

        Overrides the protected seam of the `mthds` base, so every inherited protocol route
        (`execute`, `start`, `validate`, `models`, `version`) raises this SDK's subclass, as do the
        run status and results reads and the product routes, which call it directly. The error is
        built by `_api_response_error`, which `health` shares.

        Args:
            method: The HTTP method of the request, for the message (`POST`).
            endpoint: The endpoint below `/v1`, query included, exactly as the route sent it: it
                names the request in the message and gives `request_url`.
            response: The API's non-2xx answer.

        Raises:
            ApiResponseError: Always.
        """
        raise self._api_response_error(method=method, path=f"/{_API_PREFIX}/{endpoint}", request_url=self._url(endpoint), response=response)

    def _api_response_error(self, *, method: str, path: str, request_url: str, response: httpx.Response) -> ApiResponseError:
        """Build this SDK's `ApiResponseError` for a non-2xx answer — the one place an answer becomes an error.

        The members both clients share are read through the base's own parse (`ProblemDocument`), so
        they read the same from either client; this adds the Pipelex members the standard's client
        leaves out — the platform's `code`, the runner's `error_category` and the platform's field-level
        `errors[]` — and narrows `validation_errors` to `ValidationErrorItem`. The error decides its
        verdict from what the server sent and the fallback table, and, inside `_creating_run`, whether the
        run the request may create may have started.

        Args:
            method: The HTTP method of the request, for the message (`POST`).
            path: The path the message names (`/v1/start`, or `/health` at the origin).
            request_url: The URL the request was sent to.
            response: The API's non-2xx answer.

        Returns:
            The error, for the caller to raise.
        """
        document = ProblemDocument.make_from_response(response)
        members = document.members or {}
        msg = f"API {method} {path} failed ({response.status_code}): {_failure_reason(document, response)}"
        return ApiResponseError(
            msg,
            api_url=self.base_url,
            status=response.status_code,
            status_text=response.reason_phrase,
            response_body=response.text,
            headers=dict(response.headers),
            request_url=request_url,
            error_type=document.error_type,
            server_message=document.server_message,
            validation_errors=_narrowed_validation_errors(document.validation_errors),
            type_uri=document.type_uri,
            title=document.title,
            instance=document.instance,
            request_id=document.request_id,
            error_domain=document.error_domain,
            retryable=document.retryable,
            user_action=document.user_action,
            problem=document.members,
            code=_non_empty_string_member(members, "code"),
            error_category=_non_empty_string_member(members, "error_category"),
            errors=_field_errors_of(members.get("errors")),
            may_start_run=_MAY_START_RUN.get(),
        )

    def _raise_if_lifecycle_unavailable(
        self, *, status: int, body: str, url: str, explanation: str = "PIPELEX_BASE_URL points at a bare runner that does not serve it."
    ) -> None:
        """Translate a "route absent" 404 (a bare pipelex-api with no platform block) into a clear
        `RunLifecycleUnavailableError`. A 404 the platform or the runner answered on purpose — a run not
        found, a `method_ref` with no package — carries a problem document (`code` or `error_type`) and is
        left for normal handling as `ApiResponseError`. `explanation` replaces the sentence saying why the
        route is missing, for a route a hosted API may also lack.
        """
        if status != 404:
            return
        if _is_missing_route_404(body):
            msg = (
                f"The durable run lifecycle is not available: {url} returned 404. Run polling is a "
                f"hosted-API extension (/{_API_PREFIX}/{_RUNS}/*), not part of the MTHDS Protocol; "
                f"{explanation}"
            )
            raise RunLifecycleUnavailableError(msg, api_url=self.base_url)

    # ── Protocol surface: `execute` override (gateway-timeout translation) ──

    @override
    async def execute(
        self,
        pipe_code: str | None = None,
        files: MethodFiles | None = None,
        inputs: PipelineInputs | WorkingMemoryAbstract[StuffType] | None = None,
        output_name: str | None = None,
        output_multiplicity: VariableMultiplicity | None = None,
        dynamic_output_concept_ref: str | None = None,
        extra: dict[str, Any] | None = None,
        *,
        mthds_contents: list[str] | None = None,
        method_ref: str | None = None,
        method_id: str | None = None,
    ) -> PipelexExecuteResult:
        """Execute a method synchronously and wait for its completion — `POST /v1/execute`.

        Returns a `PipelexExecuteResult` — the protocol's raw execute response enriched with a
        resolved `.main_stuff` accessor, so a blocking result reads its output the same way as a
        durable one (`result.main_stuff`) instead of digging through `pipe_output`. A
        `method_ref` run's result additionally carries `method_provenance` — the address, the
        tag, and the commit SHA that was actually fetched.

        Identical to the inherited protocol `execute`, except for four things. First,
        `method_ref` — the Pipelex API's own run source, resolved by the RUNNER (see below).
        Second, `method_id` — the hosted platform's own run arg (see below). Third,
        `mthds_contents` — the inline bundles the Pipelex API still reads beside the protocol's
        `files`. Fourth, a failure
        consistent with the hosted gateway's ~30s synchronous ceiling — a gateway `503`/`504`,
        or a client-side request timeout, after at least ~28s have elapsed — is translated into
        a clear `PipelineExecuteTimeoutError` pointing at the durable start+poll path, matching
        the JS SDK. The protocol's optional 202 async-degrade raises this SDK's
        `RunStillRunningError`, a subclass of the one the inherited `execute` raises, and every other
        non-2xx raises `ApiResponseError`, whose message and members carry the server's reason, the
        next step it advises and, for a method it refuses to run, the diagnostics naming the failing
        pipe.

        Args:
            pipe_code: The code identifying the pipe to execute. Beside a `method_ref` it
                overrides the fetched manifest's `main_pipe`.
            files: The method to load as its whole tree, the protocol's own run source: a map
                from tree path to file entry, holding at least one file, sent as given.
                `prepare_files` (inherited from `mthds`) builds it from a listed tree, uploading
                the blobs the platform lacks.
            inputs: Inputs passed to the method.
            output_name: Name of the output slot to write to.
            output_multiplicity: Output multiplicity setting.
            dynamic_output_concept_ref: Override for the dynamic output concept ref.
            extra: Server-specific extension args this client does not know about, merged into
                the request body as top-level properties. Protocol args and this client's own
                named args (`mthds_contents`, `method_ref`, `method_id`) must be passed as named
                parameters, not through `extra` (raises `RequestArgumentError`).
            mthds_contents: List of MTHDS bundle contents to load, the Pipelex API's inline
                source beside `files`.
            method_ref: A published method's address —
                `github.com/<owner>/<repo>[/<selector>][@<tag>]` (e.g.
                `github.com/Pipelex/methods/documents@v0.1.0`) — a layer-2 Pipelex-API
                extension the RUNNER resolves (git fetch at the tag, package located by
                manifest identity; pipelex-api >= 0.21.0). A complete run source of its own,
                so it pairs with NOTHING: exclusive with an inline source (`files` or
                `mthds_contents`) and with `method_id` (an address run has its own provenance
                and needs no linkage id) —
                the illegal pairings are rejected client-side, mirroring the server's 422s.
                `pipe_code` beside it is fine. An empty string is treated as absent.
            method_id: A stored method's hosted catalog id (`mt_…`) — a pure PASS-THROUGH the
                platform resolves against the org's catalog; nothing is expanded client-side,
                and it is meaningless off-platform (an open-source runner answers a `422`
                naming the key). Alone, the platform resolves and runs the stored method's
                source: a bare `mt_…` runs its latest published version (a `409`
                `method_not_published` for a method never published), `mt_…@<n>` the fixed
                version `n` (a `404` `method_version_not_found` for one never published) and
                `mt_…@draft` its draft, the suffix riding the string untouched; the answer's
                `method_version` says which ran. Alongside an inline source (`files` or
                `mthds_contents`), the inline source is what RUNS (precedence) and the id is recorded as run-history linkage on the Run
                row — the index key `GET /v1/runs?method_id=` queries, so a run started without it
                is absent from its method's history permanently. The id must be bare there: the
                inline source is what runs, so a suffix would claim a version that did not, and a
                suffixed id is refused client-side, mirroring the platform's `422`. An empty
                string is treated as absent.

        Raises:
            PipelineExecuteTimeoutError: The blocking request hit the hosted gateway's ~30s
                synchronous ceiling — use `start_and_wait` (or `start` + `wait_for_result`).
            RequestArgumentError: Nothing to run was named, `files` holds no file, `extra`
                carries a protocol arg or a reserved named arg, a selector is present and is not
                a string, `method_ref` is combined with an inline source or with `method_id`, or a
                suffixed `method_id` is combined with an inline source.
            RunStillRunningError: The server answered 202 (the protocol's optional async
                degrade) — the run continues server-side; resume by `pipeline_run_id`.
            ApiResponseError: Any other non-2xx answer — a refusal to run an invalid method (a
                `422`, its diagnostics on `validation_errors`), a failed run, auth, a server fault.
            ApiUnreachableError: No answer came back (DNS / connect / TLS), or a client-side
                timeout came before the ~28s the gateway translation waits for.
        """
        merged_extra = _merge_run_extensions(extra, method_ref=method_ref, method_id=method_id, mthds_contents=mthds_contents)
        has_inline_source = files is not None or bool(mthds_contents)
        _assert_run_source_named(
            pipe_code=pipe_code, has_inline_source=has_inline_source, mthds_contents=mthds_contents, merged_extra=merged_extra, route="execute"
        )
        _assert_method_ref_pairs_with_nothing(mthds_contents=mthds_contents, carries_files=files is not None, merged_extra=merged_extra)
        _assert_linkage_method_id_is_bare(has_inline_source=has_inline_source, merged_extra=merged_extra)
        started_at = monotonic()
        with _creating_run(), self._reading_inherited_answer(method="POST", endpoint="execute"):
            try:
                result = await super().execute(
                    pipe_code=pipe_code,
                    files=files,
                    inputs=inputs,
                    output_name=output_name,
                    output_multiplicity=output_multiplicity,
                    dynamic_output_concept_ref=dynamic_output_concept_ref,
                    extra=merged_extra,
                )
            except (ApiResponseError, ApiUnreachableError) as exc:
                # A client-side read or write timeout arrives as the `ApiUnreachableError` the `_send` override maps it to,
                # with the `code` `ABORT_TIMEOUT` that `is_gateway_cut_off` reads.
                elapsed_seconds = monotonic() - started_at
                if is_gateway_cut_off(exc, elapsed_seconds):
                    raise PipelineExecuteTimeoutError(_execute_timeout_message(elapsed_seconds), elapsed_seconds=elapsed_seconds) from exc
                raise
            except PipelineRequestError as exc:
                refined = _with_verdict(exc)
                if refined is exc:
                    raise
                raise refined from exc
            # Re-validate the base result into the enriched subclass (adds the `.main_stuff` accessor;
            # the `main_stuff_name` extension + working memory ride `model_extra`/`pipe_output`). Inside
            # the block, so an answer the subclass cannot read is reported as one the base cannot.
            return PipelexExecuteResult.model_validate(result.model_dump())

    # ── Protocol surface: `start` override (bare-runner 404 → typed error) ──

    @override
    async def start(
        self,
        pipe_code: str | None = None,
        files: MethodFiles | None = None,
        inputs: PipelineInputs | WorkingMemoryAbstract[StuffType] | None = None,
        output_name: str | None = None,
        output_multiplicity: VariableMultiplicity | None = None,
        dynamic_output_concept_ref: str | None = None,
        extra: dict[str, Any] | None = None,
        *,
        mthds_contents: list[str] | None = None,
        method_ref: str | None = None,
        method_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> PipelexRunResultStart:
        """Start a method asynchronously — `POST /v1/start` (202: `pipeline_run_id` only).

        Identical to the inherited protocol `start`, except for the two method selectors —
        `method_ref` (the Pipelex API's own run source, resolved by the runner) and
        `method_id` (the hosted platform's own run arg), both documented on `execute` and
        carrying the same semantics and exclusivity here — the inline `mthds_contents` the
        Pipelex API still reads beside `files`, the `idempotency_key` the request
        carries as a header, and that a bare-runner
        missing-route 404 (no run store) is translated into a clear
        `RunLifecycleUnavailableError`, matching the JS SDK and letting `start_and_wait`
        self-heal to the blocking-execute fallback. Every other non-2xx — the platform's
        structured 404s included — raises `ApiResponseError`.

        Args:
            pipe_code: The code identifying the pipe to run, as on `execute`.
            files: The method to load as its whole tree, as on `execute`.
            inputs: Inputs passed to the method.
            output_name: Name of the output slot to write to.
            output_multiplicity: Output multiplicity setting.
            dynamic_output_concept_ref: Override for the dynamic output concept ref.
            extra: Server-specific extension args this client does not know about, as on `execute`.
            mthds_contents: List of MTHDS bundle contents to load, as on `execute`.
            method_ref: A published method's address, as on `execute`.
            method_id: A stored method's hosted catalog id, as on `execute`.
            idempotency_key: The start's idempotency key, sent as the `Idempotency-Key` header, and not
                sent at all when `None`. Generate one per run the caller means to start (a
                `str(uuid.uuid4())` is a good key), and keep it, with every other argument unchanged,
                across that start's retries. The hosted API binds the key to the run the first request
                starts, before it dispatches it, so the same start sent again under the same key is
                answered with that run's acknowledgement and starts nothing, whatever became of the first
                attempt, for 24 hours: a failed start whose `run_may_have_started` is `True` can be sent
                again unchanged, and recovers the run instead of paying for a second one. The same key with
                a different body is refused (`409` `conflict`), as is a key whose earlier request is still
                being handled (`409` `idempotency_key_in_use`, retryable: send it again under the same key
                in a few seconds); see `docs/errors.md`. A bare runner ignores the header. A key is 1 to
                255 visible ASCII characters (`!` to `~`, so no space); anything else, an empty string
                included, is refused before any request is sent, since a start sent without the key the
                caller asked for would lose the protection silently.

        Returns:
            The 202 ack as `PipelexRunResultStart` — the authoritative `pipeline_run_id`,
            plus `method_provenance` (`{address, tag, commit_sha}`) for a `method_ref` run
            (the server fetches the package before the ack, so provenance rides the 202);
            `None` otherwise.

        Raises:
            RequestArgumentError: Nothing to run was named, `files` holds no file, `extra`
                carries a protocol arg or a reserved named arg, a selector is present and is not
                a string, `method_ref` is combined with an inline source or with `method_id`, a
                suffixed `method_id` is combined with an inline source, or `idempotency_key` is not
                1 to 255 visible ASCII characters.
            RunLifecycleUnavailableError: The configured server has no run store.
            ApiResponseError: Any other non-2xx answer — a refusal to run an invalid method (a
                `422`, its diagnostics on `validation_errors`), auth, a server fault, a key an earlier
                start still holds (`idempotency_key_in_use`) or one used with another body (`conflict`).
            ApiUnreachableError: No answer came back (DNS / connect / TLS / timeout).
        """
        checked_idempotency_key = _idempotency_key_of(idempotency_key)
        merged_extra = _merge_run_extensions(extra, method_ref=method_ref, method_id=method_id, mthds_contents=mthds_contents)
        has_inline_source = files is not None or bool(mthds_contents)
        _assert_run_source_named(
            pipe_code=pipe_code, has_inline_source=has_inline_source, mthds_contents=mthds_contents, merged_extra=merged_extra, route="start"
        )
        _assert_method_ref_pairs_with_nothing(mthds_contents=mthds_contents, carries_files=files is not None, merged_extra=merged_extra)
        _assert_linkage_method_id_is_bare(has_inline_source=has_inline_source, merged_extra=merged_extra)
        token = _REQUEST_TIMEOUT_OVERRIDE.set(
            _start_request_timeout_seconds(self.request_timeout_seconds, merged_extra, has_inline_source=has_inline_source)
        )
        key_token = _IDEMPOTENCY_KEY.set(checked_idempotency_key)
        try:
            with _creating_run(), self._reading_inherited_answer(method="POST", endpoint="start"):
                try:
                    result = await super().start(
                        pipe_code=pipe_code,
                        files=files,
                        inputs=inputs,
                        output_name=output_name,
                        output_multiplicity=output_multiplicity,
                        dynamic_output_concept_ref=dynamic_output_concept_ref,
                        extra=merged_extra,
                    )
                except ApiResponseError as exc:
                    # The inherited route raised through `_raise_api_response_error`; the error keeps the
                    # status, the body and the URL, which is all the missing-route test reads.
                    self._raise_if_lifecycle_unavailable(status=exc.status, body=exc.response_body, url=exc.request_url or self._url("start"))
                    raise
                except PipelineRequestError as exc:
                    refined = _with_verdict(exc)
                    if refined is exc:
                        raise
                    raise refined from exc
                # Re-validate the base ack into the Pipelex-branded subtype (types `method_provenance`;
                # any other implementation extra keeps riding `model_extra`). Inside the block, so an
                # answer the subtype cannot read is reported as one the base cannot.
                return PipelexRunResultStart.model_validate(result.model_dump())
        finally:
            _IDEMPOTENCY_KEY.reset(key_token)
            _REQUEST_TIMEOUT_OVERRIDE.reset(token)

    @override
    async def validate(  # type: ignore[override]
        self,
        mthds_contents: list[str] | None = None,
        allow_signatures: bool = False,
        mthds_sources: list[str] | None = None,
        render: list[str] | None = None,
        views: list[str] | None = None,
        *,
        method_ref: str | None = None,
        method_id: str | None = None,
    ) -> PipelexValidationResult:
        """Parse, validate, and dry-run an MTHDS bundle — `POST /v1/validate`.

        `/validate` is 200-diagnostic: a produced verdict — valid or invalid — rides a 200
        body discriminated on `is_valid`, returned verbatim as the `PipelexValidationResult`
        union (an invalid bundle is NOT raised; the caller match/cases `is_valid`). A non-2xx
        means no verdict could be produced (request shape, auth, server fault) and surfaces as
        `ApiResponseError`, like every other route. A selector-resolution
        failure — a fetch failure, no package at the address, an unknown or foreign-org id —
        is a non-2xx too, never an `is_valid: false` verdict, which is reserved for actual
        MTHDS content.

        WHAT is validated arrives in exactly one of three forms — the tooling routes' strict
        three-way XOR (the routes are stateless, so there is no linkage exception; a second
        selector is rejected client-side, mirroring the server's request-shape `422`):

        - **inline `mthds_contents`** — the protocol's own envelope;
        - **`method_ref`** — a published method's address, resolved by the server
          (pipelex-api >= 0.21.0) through the same fetch path as a `method_ref` run, the
          package's real file names feeding the diagnostics' source labels;
        - **`method_id`** — a stored method's catalog id, hosted-only: the platform resolves
          the version it names and injects that version's `.mthds` files before the runner sees
          the request (a bare runner rejects the request as carrying no source it understands).
          A bare id validates the latest published version, `mt_…@<n>` a fixed one and
          `mt_…@draft` the draft.

        This override differs from the inherited protocol `validate` in these Pipelex-API ways:
        it always injects `render: ["markdown"]` (so both valid and invalid verdicts carry
        `rendered_markdown`), it accepts `mthds_sources` as a named parameter, it carries the
        `views` opt-in for the server's structured views, and it takes the two method
        selectors.

        Args:
            mthds_contents: MTHDS contents to load (always a list, even for one file).
                Exactly one of `mthds_contents` / `method_ref` / `method_id`.
            allow_signatures: Tolerate unimplemented pipe signatures (strict by default).
            mthds_sources: Optional per-content source names, parallel to `mthds_contents`,
                threaded onto each diagnostic's `source` (an unnamed content yields
                `source: null`). The server 422s a length mismatch. An inline-contents
                companion only: a `method_ref` / `method_id` validation gets its source labels
                from the package's (or the stored method's) real file names, so supplying it
                beside a selector is rejected client-side.
            render: Optional Pipelex-API presentation hints; `"markdown"` is always added.
                Unknown tokens are server-side lenient-ignored (never a 422).
            views: Optional opt-in for the server's structured views. `input_form` — named by
                `VALIDATION_VIEW_INPUT_FORM` — is the only token today; unknown tokens are
                server-side lenient-ignored (never a 422). Unlike `render`, the list is sent
                **verbatim**: nothing is injected and nothing is de-duplicated, and an explicit
                `[]` is sent as `[]`. Left at `None` the key is not sent at all, which is what
                keeps the default response byte-identical for consumers that discard views.
            method_ref: A published method's address —
                `github.com/<owner>/<repo>[/<selector>][@<tag>]` — runner-resolved. An empty
                string is treated as absent.
            method_id: A stored method's hosted catalog id (`mt_…`, `mt_…@<n>` or `mt_…@draft`),
                platform-resolved. An unknown or foreign-org id is a `404` (indistinguishable by
                design); a bare id of a method never published is a `409` `method_not_published`;
                a version never published is a `404` `method_version_not_found`; a malformed suffix
                or a stored method with no MTHDS source is a `422`. An empty string is treated as
                absent.

        Returns:
            The 200-diagnostic union: `PipelexValidationReport` (`is_valid: true`) or
            `PipelexInvalidReport` (`is_valid: false`, with `validation_errors`), each
            carrying `rendered_markdown`. A valid report also carries `warnings` and
            `liftable_pipes`, plus `input_form` when `views` asked for it. `input_form` and
            `pipe_io_contracts` are typed by the standard's own models (`mthds.protocol`),
            so a field descriptor narrows on its `kind` and a slot's presence and multiplicity
            read as enums; import the per-kind types from `mthds.protocol.input_form`.

        Raises:
            RequestArgumentError: Zero or several selectors were supplied, a selector is not a
                string, or `mthds_sources` was supplied beside a selector.
            ApiResponseError: No verdict could be produced — a request-shape `422`, a selector
                that did not resolve, auth, a server fault.
            ApiUnreachableError: No answer came back (DNS / connect / TLS / timeout).
        """
        selected_method_ref = _normalized_selector(name="method_ref", value=method_ref)
        selected_method_id = _normalized_selector(name="method_id", value=method_id)
        selector_count = sum(1 for present in (bool(mthds_contents), selected_method_ref is not None, selected_method_id is not None) if present)
        if selector_count != 1:
            msg = "validate() takes exactly one method selector: inline mthds_contents, method_ref, or method_id."
            raise RequestArgumentError(msg)
        if mthds_sources is not None and not mthds_contents:
            msg = (
                "mthds_sources labels inline mthds_contents; a method_ref / method_id validation gets "
                "its source labels from the package's (or the stored method's) real file names."
            )
            raise RequestArgumentError(msg)

        # The body is built here, on the inherited `_send` transport seam, rather than through the
        # base's `_post_validate`, which sends a method as its `files` tree: `mthds_contents` is the
        # Pipelex API's own inline source. A selector validation must NOT carry the `mthds_contents`
        # key at all (the server XORs on presence, and an empty list is a request-shape 422).
        body: dict[str, Any] = {"allow_signatures": allow_signatures, "render": _with_validate_markdown_render(render)}
        if mthds_contents:
            body["mthds_contents"] = mthds_contents
        if mthds_sources is not None:
            body["mthds_sources"] = mthds_sources
        if views is not None:
            body["views"] = views
        if selected_method_ref is not None:
            body["method_ref"] = selected_method_ref
        if selected_method_id is not None:
            body["method_id"] = selected_method_id
        response = await self._send("POST", self._url("validate"), content=to_json(body), request_timeout=self.request_timeout_seconds)
        if not response.is_success:
            self._raise_api_response_error(method="POST", endpoint="validate", response=response)
        return self._read_v1_answer(PipelexValidationResultAdapter.validate_python, method="POST", endpoint="validate", response=response)

    async def validate_files(
        self,
        files: list[MthdsFile],
        allow_signatures: bool = False,
        render: list[str] | None = None,
        views: list[str] | None = None,
    ) -> PipelexValidationResult:
        """Validate paired MTHDS files while preserving URI attribution for diagnostics.

        Decomposes the files into the low-level `validate(...)` payload. When any file carries
        a URI, every content gets a parallel source label (a deterministic `inline://` label
        for the ones without), so the server never sees a length-mismatched `mthds_sources`.

        Args:
            files: The MTHDS files to validate, each content plus an optional provenance URI.
            allow_signatures: Tolerate unimplemented pipe signatures (strict by default).
            render: Optional Pipelex-API presentation hints, threaded to `validate`.
            views: Optional structured-view opt-in, threaded to `validate` unchanged — see
                `validate` for the semantics.

        Raises:
            RequestArgumentError: If `files` is empty.
        """
        if not files:
            msg = "At least one MTHDS file must be provided to validate_files()."
            raise RequestArgumentError(msg)

        mthds_contents = [mthds_file.content for mthds_file in files]
        has_any_uri = any(mthds_file.uri is not None for mthds_file in files)
        mthds_sources: list[str] | None
        if has_any_uri:
            mthds_sources = [
                mthds_file.uri if mthds_file.uri is not None else f"inline://file-{index + 1}.mthds" for index, mthds_file in enumerate(files)
            ]
        else:
            mthds_sources = None

        return await self.validate(mthds_contents, allow_signatures, mthds_sources, render, views)

    # ── Hosted extension: durable run lifecycle (NOT part of the protocol) ──
    #
    # These methods are OWNED by this SDK and return this package's own `runs`
    # types (a Pipelex-branded surface). The protocol base `MthdsAPIClient` is
    # protocol-only — it declares no run lifecycle — so these are plain methods, not
    # overrides (no `@override`, no override suppressions).

    async def get_run_status(self, run_id: str) -> RunRead:
        """Fetch a run's status by bare id — `GET /v1/runs/{run_id}/status`.

        Self-healing: a finished-but-unrecorded run resolves to its true terminal status on read.
        `degraded=True` means the read is not a plain fresh reading, and `degradation.reason` says why
        (see `DegradationReason`): `status_unavailable` when the platform could not reach the workflow
        engine and `status` is the last one recorded, `workflow_task_failing` when `status` is live and
        the run is stuck, its workflow task failing until the platform ends it at
        `degradation.ends_at`. `retry_after_seconds` carries the server's `Retry-After` hint when
        present, and `request_id` the id to quote to support. A failed run's stored report, `error`,
        and the `degradation` are each read leniently, so neither ever fails the read.

        Raises:
            RunLifecycleUnavailableError: If the lifecycle routes are absent (a bare runner).
            ApiUnreachableError: If the host cannot be reached (DNS / connect / TLS / timeout).
            ApiResponseError: For a genuine run-not-found 404 or any other non-2xx response, or a 2xx
                that is not a run.
        """
        endpoint = f"{_RUNS}/{_id_path_segment(run_id, call='get_run_status', what=_RUN_ID_ARGUMENT)}/status"
        url = self._url(endpoint)
        response = await self._send("GET", url, content=None, request_timeout=_POLL_REQUEST_TIMEOUT_SECONDS)
        self._raise_if_lifecycle_unavailable(status=response.status_code, body=response.text, url=url)
        if not response.is_success:
            self._raise_api_response_error(method="GET", endpoint=endpoint, response=response)
        run = self._read_v1_answer(RunRead.model_validate, method="GET", endpoint=endpoint, response=response)
        retry_after = _parse_retry_after(response.headers)
        if retry_after is not None:
            run = run.model_copy(update={"retry_after_seconds": retry_after})
        return run

    async def get_run_progress(self, run_id: str) -> RunProgress:
        """Read a run's progress snapshot by bare id — `GET /v1/runs/{run_id}/progress`.

        The platform projects the snapshot at each read from the run's live progress events, through the
        status read's self-healing path: which invocations of which pipes have started, ended or been
        skipped, how far each batch has got, which outcome each condition took, where the run is retrying
        or stuck, and a one-line `summary`. A pending run, and a run that has written no progress event,
        answer with no invocation. When the workflow engine cannot be reached the read still answers, its
        `degradation` reading `status_unavailable` and its `status` the last one recorded. Two reads can
        answer out of order: keep the fresher by `is_fresher_run_progress`, as
        `WaitForResultOptions.on_progress` does.

        The members the freshness rule and a timeline lean on are read strictly (see `RunProgress`), and
        the snapshot's `degradation` and each invocation's are read leniently, as the status read's, so
        neither fails the read.

        Raises:
            RequestArgumentError: If `run_id` is not a non-empty string, or is one the URL would resolve.
            RunLifecycleUnavailableError: If the route is absent: a bare runner, or a hosted API older
                than the progress route.
            ApiUnreachableError: If the host cannot be reached (DNS / connect / TLS / timeout).
            ApiResponseError: For the platform's `404` of a run that does not exist or is another
                organization's, any other non-2xx response, or a 2xx that is not a snapshot.
        """
        endpoint = f"{_RUNS}/{_id_path_segment(run_id, call='get_run_progress', what=_RUN_ID_ARGUMENT)}/progress"
        url = self._url(endpoint)
        response = await self._send("GET", url, content=None, request_timeout=_POLL_REQUEST_TIMEOUT_SECONDS)
        self._raise_if_lifecycle_unavailable(
            status=response.status_code,
            body=response.text,
            url=url,
            explanation="the server is a bare runner, or a hosted API older than the progress route.",
        )
        if not response.is_success:
            self._raise_api_response_error(method="GET", endpoint=endpoint, response=response)
        return self._read_v1_answer(RunProgress.model_validate, method="GET", endpoint=endpoint, response=response)

    async def get_run_result(self, run_id: str, *, artifacts: Sequence[RunArtifact] | None = None) -> RunResultState:
        """Single-shot result lookup — `GET /v1/runs/{run_id}/results`.

        Maps the platform's poll semantics to a discriminated union:
        - HTTP 202 → `running` (in-flight, with the `Retry-After` hint)
        - HTTP 503 → `running` (DynamoDB/Temporal degraded — retry, never fail a poller)
        - HTTP 200 → `completed` (with the result artifacts)
        - HTTP 409 → `failed` (terminal non-`COMPLETED`), carrying the problem's `detail` as `message`,
          its `run_status` member as `status` and its `error` member, the run's stored report, typed

        Args:
            run_id: The run to read.
            artifacts: Which result artifacts to read, sent as one comma-separated `?artifacts=`
                parameter. `None` (the default) reads them all. With a selection the platform
                reads, re-signs and returns only those: an artifact left out is absent from the
                result (`RunResults.carries` answers `False`), one asked for but never written is
                `None`. A history row that shows a run's output asks for `[RunArtifact.MAIN_STUFF]`
                alone instead of paying for the graph and the forms. The main-stuff check below
                applies only when `main_stuff` was asked for.

        Raises:
            RequestArgumentError: If `artifacts` is an empty selection, which names nothing to read,
                or names an artifact that is no `RunArtifact`.
            MissingMainStuffError: If a completed run asked for its main stuff delivers none.
            RunLifecycleUnavailableError: If the lifecycle routes are absent (a bare runner).
            ApiUnreachableError: If the host cannot be reached (DNS / connect / TLS / timeout).
            ApiResponseError: For a genuine run-not-found 404 or any other non-2xx response, or a
                `200` that is not the run's results.
        """
        selection = _artifact_selection(artifacts)
        endpoint = f"{_RUNS}/{_id_path_segment(run_id, call='get_run_result', what=_RUN_ID_ARGUMENT)}/results"
        if selection is not None:
            endpoint = f"{endpoint}?{urlencode({'artifacts': ','.join(selection)}, safe=',')}"
        url = self._url(endpoint)
        response = await self._send("GET", url, content=None, request_timeout=_POLL_REQUEST_TIMEOUT_SECONDS)
        status_code = response.status_code

        if status_code in {202, 503}:
            retry_after = _parse_retry_after(response.headers)
            return RunResultRunning(
                pipeline_run_id=run_id,
                retry_after_seconds=retry_after if retry_after is not None else _DEFAULT_DEGRADED_RETRY_SECONDS,
            )
        if status_code == 409:
            return _run_result_failed(run_id, response)

        self._raise_if_lifecycle_unavailable(status=response.status_code, body=response.text, url=url)
        if not response.is_success:
            self._raise_api_response_error(method="GET", endpoint=endpoint, response=response)
        wants_main_stuff = selection is None or RunArtifact.MAIN_STUFF in selection

        def read_results(payload: Any) -> RunResults:
            # A completed run asked for its main stuff must deliver one. `.get(...) is None` covers both the
            # missing-key and explicit-null cases for the same un-deliverable-output condition (a
            # present-but-falsy main stuff — `[]`, `0` — stays). A selection that left `main_stuff` out
            # asked for none, so its absence there is the answer, not a fault. A payload that is no
            # object is no results at all, which `RunResults` refuses.
            if wants_main_stuff and isinstance(payload, dict) and cast("dict[str, Any]", payload).get("main_stuff") is None:
                msg = f"Completed run '{run_id}' returned no main stuff — a completed run always delivers a main stuff."
                raise MissingMainStuffError(msg, run_id=run_id)
            return RunResults.model_validate(payload)

        result = self._read_v1_answer(read_results, method="GET", endpoint=endpoint, response=response)
        return RunResultCompleted(pipeline_run_id=run_id, result=result)

    async def wait_for_result(
        self,
        run_id: str,
        options: WaitForResultOptions | None = None,
        *,
        artifacts: Sequence[RunArtifact] | None = None,
    ) -> RunResults:
        """Poll a run to a terminal state and return its result.

        Resolves on `COMPLETED`, raises `RunFailedError` on any other terminal status — carrying the
        run's status and its stored error report, typed, as `error` — and raises
        `RunTimeoutError` if `timeout_seconds` elapses first (the run keeps executing server-side —
        resume later by `run_id`). Honors the server's `Retry-After`. A poll that gets no answer
        raises `ApiUnreachableError` at once, the loop not retrying it. Async-native: cancelling the
        awaiting task raises `asyncio.CancelledError` out of this loop, leaving the run resumable,
        on every supported Python version, even when the cancellation lands in the step a poll answers.
        `artifacts` narrows every results read of the loop, exactly as on `get_run_result`.

        With `options.on_progress`, each poll that finds the run still running also reads
        `get_run_progress` and hands the callback every snapshot fresher than the last it delivered
        (`is_fresher_run_progress`). That read is bounded by the time the wait has left, so it never holds
        the wait past `timeout_seconds`; a progress read that fails otherwise only skips that poll's
        snapshot, and a server answering that it has no progress route is not asked again during the wait
        (see `WaitForResultOptions.on_progress`).
        """
        # Refused before the first poll, so an empty selection never waits out a timeout to fail.
        _artifact_selection(artifacts)
        opts = options or WaitForResultOptions()
        started_at = monotonic()
        attempt = 0
        # No progress request at all unless the caller asked for progress; `None` again once the server has
        # answered that it serves no progress route.
        on_progress = opts.on_progress
        delivered: RunProgress | None = None

        while True:
            elapsed = monotonic() - started_at
            remaining = opts.timeout_seconds - elapsed
            if remaining <= 0:
                raise RunTimeoutError(_timeout_message(run_id, opts.timeout_seconds), run_id=run_id, timeout_seconds=opts.timeout_seconds)

            # `asyncio.timeout`, never `asyncio.wait_for`: on Python 3.11, `wait_for` returns a poll that
            # finished in the same loop step as a cancellation of the awaiting task, swallowing it.
            try:
                async with asyncio.timeout(remaining):
                    state = await self.get_run_result(run_id, artifacts=artifacts)
            except TimeoutError as exc:
                raise RunTimeoutError(_timeout_message(run_id, opts.timeout_seconds), run_id=run_id, timeout_seconds=opts.timeout_seconds) from exc

            if isinstance(state, RunResultCompleted):
                return state.result
            if isinstance(state, RunResultFailed):
                msg = state.message
                raise RunFailedError(msg, run_id=run_id, status=state.status, error=state.error)

            # state is RunResultRunning — report its progress when asked, then decide whether to keep waiting.
            if on_progress is not None:
                # The deadline is checked again before the progress read and bounds it, and the elapsed time
                # below is taken after it, so a slow progress read never holds the wait past its timeout.
                remaining = opts.timeout_seconds - (monotonic() - started_at)
                if remaining <= 0:
                    raise RunTimeoutError(_timeout_message(run_id, opts.timeout_seconds), run_id=run_id, timeout_seconds=opts.timeout_seconds)
                try:
                    progress = await self._read_progress_while_waiting(run_id, time_left_seconds=remaining)
                except TimeoutError as exc:
                    raise RunTimeoutError(
                        _timeout_message(run_id, opts.timeout_seconds), run_id=run_id, timeout_seconds=opts.timeout_seconds
                    ) from exc
                except RunLifecycleUnavailableError:
                    # A server without the route answers every read with the same 404: stop asking.
                    on_progress = None
                else:
                    if progress is not None and is_fresher_run_progress(progress, delivered):
                        delivered = progress
                        on_progress(progress)

            attempt += 1
            elapsed = monotonic() - started_at
            if elapsed >= opts.timeout_seconds:
                raise RunTimeoutError(_timeout_message(run_id, opts.timeout_seconds), run_id=run_id, timeout_seconds=opts.timeout_seconds)
            if opts.on_poll is not None:
                opts.on_poll(PollInfo(attempt=attempt, elapsed_seconds=elapsed))

            retry_seconds = state.retry_after_seconds if state.retry_after_seconds is not None else 0
            wait_seconds = min(max(opts.interval_seconds, retry_seconds), opts.timeout_seconds - elapsed)
            await asyncio.sleep(wait_seconds)

    async def _read_progress_while_waiting(self, run_id: str, *, time_left_seconds: float) -> RunProgress | None:
        """One progress read of `wait_for_result`'s loop, best effort: the snapshot, or `None` when the read failed.

        The results read, not the progress, is the truth about the run, so a read that got no answer
        (`ApiUnreachableError`) or an answer that is no snapshot (`ApiResponseError`: a `503` while the
        platform cannot read the run's events, a body the SDK cannot read) skips that poll's snapshot.
        `asyncio.timeout`, as around the results read, bounds the read by the time the wait has left.

        Raises:
            TimeoutError: The wait's time ran out during the read, which the loop raises as its `RunTimeoutError`.
            RunLifecycleUnavailableError: The server serves no progress route, which the loop stops asking.
        """
        try:
            async with asyncio.timeout(time_left_seconds):
                return await self.get_run_progress(run_id)
        except (ApiUnreachableError, ApiResponseError):
            return None

    @override
    async def version(self) -> VersionInfo:
        """Protocol + runner versions — `GET /v1/version` (public), the handshake for feature detection.

        Identical to the inherited route, except for its time limit: the answer is small and the
        hosted gateway caps responses at ~30s, so it gets `request_timeout_seconds` capped at the poll
        budget rather than the whole blocking-execute ceiling, as `@pipelex/sdk`'s `version` gets the
        poll budget. `start_and_wait` asks it
        first, and a host that accepts the connection and never answers must not hold the run for
        twenty minutes before the start is even sent.

        Raises:
            ApiResponseError: If the server answers non-2xx, or a 2xx that is not a version.
            ApiUnreachableError: No answer came back.
        """
        token = _REQUEST_TIMEOUT_OVERRIDE.set(_quick_request_timeout_seconds(self.request_timeout_seconds))
        try:
            with self._reading_inherited_answer(method="GET", endpoint="version"):
                return await super().version()
        finally:
            _REQUEST_TIMEOUT_OVERRIDE.reset(token)

    @override
    async def models(self, category: ModelCategory | None = None) -> ModelDeck:
        """The model deck the runner can route to — `GET /v1/models[?type=]`, the inherited route.

        Overridden only so that a 2xx answer that is not a deck raises this SDK's `ApiResponseError`, as
        every route's does (`_reading_inherited_answer`).

        Args:
            category: Optional filter (`llm`, `extract`, `img_gen`, `search`, `judgment`).

        Raises:
            ApiResponseError: If the server answers non-2xx, or a 2xx that is not a model deck.
            ApiUnreachableError: No answer came back.
        """
        endpoint = f"models?type={quote(category, safe='')}" if category is not None else "models"
        with self._reading_inherited_answer(method="GET", endpoint=endpoint):
            return await super().models(category)

    async def _supports_run_lifecycle(self) -> bool:
        """Whether the configured server serves the durable run lifecycle, decided via the
        `GET /v1/version` handshake and cached for the client's lifetime. A bare `pipelex-api`
        runner has no run store; anything else is assumed hosted.

        The rule, the one `@pipelex/sdk` follows: an answer that is not a usable version means assume
        hosted (the SDK default), and let the start surface the real error; no answer at all propagates,
        uncached. An answer is anything the server sent back: a non-2xx status, a body that is not JSON,
        not UTF-8 or no version, and a body that arrived but could not be decoded, such as a broken gzip
        stream, which the `_send` override reports as the `ApiUnreachableError` whose cause is httpx's
        `DecodingError`.

        Raises:
            ApiUnreachableError: The handshake got no answer. Nothing is cached, so the next call asks
                again, and no start is sent to a host that did not answer: sending it would wait a
                second time for the same silence.
        """
        if self._lifecycle_available is None:
            try:
                info = await self.version()
            # The server answered with something that is no version: a non-2xx status, a body that is not
            # JSON or not UTF-8, or JSON that does not validate as one, each an `ApiResponseError`. Assume hosted.
            except ApiResponseError:
                self._lifecycle_available = True
            except ApiUnreachableError as exc:
                # A body that arrived and could not be decoded is an answer too, so assume hosted. Any
                # other unreachable host got no answer at all: it propagates, uncached.
                if not isinstance(exc.__cause__, httpx.DecodingError):
                    raise
                self._lifecycle_available = True
            else:
                implementation = (info.model_extra or {}).get("implementation")
                self._lifecycle_available = not (isinstance(implementation, str) and implementation == _BARE_RUNNER_IMPLEMENTATION)
        return self._lifecycle_available

    async def start_and_wait(
        self,
        pipe_code: str | None = None,
        *,
        files: MethodFiles | None = None,
        mthds_contents: list[str] | None = None,
        inputs: PipelineInputs | WorkingMemoryAbstract[StuffType] | None = None,
        output_name: str | None = None,
        output_multiplicity: VariableMultiplicity | None = None,
        dynamic_output_concept_ref: str | None = None,
        extra: dict[str, Any] | None = None,
        wait_options: WaitForResultOptions | None = None,
        method_ref: str | None = None,
        method_id: str | None = None,
        artifacts: Sequence[RunArtifact] | None = None,
        on_started: Callable[[PipelexRunResultStart], None] | None = None,
        on_starting: Callable[[], None] | None = None,
        idempotency_key: str | None = None,
    ) -> RunResults:
        """Start a run and wait for its result — the whole lifecycle in one call, self-healing
        across hosted and bare runners.

        - **Hosted** (per the `/v1/version` handshake): durable `start` + poll, the path that
          survives the gateway's ~30s synchronous ceiling and client disconnects.
        - **Bare runner** (no run store): the blocking `POST /v1/execute`, which has no gateway
          cap off-platform and returns the native `pipe_output`.

        A runner can look hosted yet lack the durable routes (`implementation` is an extension
        field a compliant bare runner may omit). Such a runner raises `RunLifecycleUnavailableError`
        from `start`, BEFORE any run is created, so the blocking fallback cannot double-run; the
        negative is cached so later calls skip the durable attempt.

        Every argument but `pipe_code` is keyword-only, the run sources (`files`, `mthds_contents`,
        `method_ref`, `method_id`) among them, so no positional call reads one source as another.

        The method's `files` tree and the method selectors — `method_ref` and `method_id`,
        documented on `execute` — are forwarded on BOTH paths: a `method_ref` run must run the same fetched package on the
        blocking fallback, and dropping `method_id` there would turn a server-side 422 that
        names the key into a silently different run.

        `artifacts` narrows the hosted results read, as on `get_run_result`. The blocking path
        ignores it: the execute response already holds every artifact, so there is nothing to save
        by narrowing it, and the result it returns answers for every field. `wait_options` tunes the
        hosted wait, its `on_progress` included, which the blocking path, having no run to read,
        never calls.

        `on_started` is called once with the start acknowledgement as soon as the durable run
        exists and before the first poll, so a caller that waits through this method holds the
        run's id while it waits: to show it, to log it, or to resume the run by it with
        `wait_for_result` after cancelling the wait, which leaves the run going on the server. It
        is never called on the blocking path, a bare runner's `POST /v1/execute` or the fallback to
        it, which has no run id to give before it answers. The callback runs synchronously and its
        return value is ignored; an exception it raises propagates out of this method before
        anything is polled, and the run it was told about keeps going.

        `on_starting` is called right before each request that may create a run is sent: the
        `POST /v1/start`, and the blocking `POST /v1/execute` of a bare runner or of the fallback to
        it. Until it is called no run exists, and none will once the task is cancelled, since a
        cancellation that landed during the version handshake stops this method before the start;
        so a caller that stops waiting before then can say no run was started. From then on, a run
        may exist before the API says so. It runs synchronously and its return value is ignored; an
        exception it raises propagates before the request is sent.

        An error from the start, or from the blocking execute, says whether that request may still have
        started a run whose id never reached the caller (`run_may_have_started`); when it may have, it is
        not retryable, since calling this method again could pay for the run twice: look the run up in the
        run history first. An error from the wait, once `on_started` has named the run, started nothing,
        so its `run_may_have_started` is `False`, and its `retryable` is about waiting again on that id
        with `wait_for_result`, never about calling this method again.

        `idempotency_key` rides the durable start, as on `start`, so a call that failed while its start may
        have created a run can be made again with the same arguments and the same key: the hosted API
        answers the start with the run the first call started, and the wait follows it. The blocking execute
        of a bare runner carries no key, a bare runner having no idempotency to honour it. A malformed key is
        refused before the version handshake.

        Raises:
            RunFailedError: If the run reaches a terminal status other than COMPLETED.
            RunTimeoutError: If the poll budget elapses (the run keeps executing — resume by id).
            ApiUnreachableError: If no answer came back from the start, the blocking execute or
                a poll (DNS / connect / TLS / timeout).
        """
        # Refused before anything starts, so an empty selection never costs a run.
        _artifact_selection(artifacts)
        # Before the handshake too: a key the start would refuse is the caller's to fix, whatever runs.
        _idempotency_key_of(idempotency_key)
        if await self._supports_run_lifecycle():
            # A cancellation that landed while the handshake's answer was read stops here, before
            # the start is sent, rather than at the start's own first wait.
            await asyncio.sleep(0)
            try:
                if on_starting is not None:
                    on_starting()
                started = await self.start(
                    pipe_code=pipe_code,
                    files=files,
                    mthds_contents=mthds_contents,
                    inputs=inputs,
                    output_name=output_name,
                    output_multiplicity=output_multiplicity,
                    dynamic_output_concept_ref=dynamic_output_concept_ref,
                    extra=extra,
                    method_ref=method_ref,
                    method_id=method_id,
                    idempotency_key=idempotency_key,
                )
            except RunLifecycleUnavailableError:
                self._lifecycle_available = False
                await asyncio.sleep(0)
                if on_starting is not None:
                    on_starting()
                return await self._execute_blocking(
                    pipe_code=pipe_code,
                    files=files,
                    mthds_contents=mthds_contents,
                    inputs=inputs,
                    output_name=output_name,
                    output_multiplicity=output_multiplicity,
                    dynamic_output_concept_ref=dynamic_output_concept_ref,
                    extra=extra,
                    method_ref=method_ref,
                    method_id=method_id,
                )
            if on_started is not None:
                on_started(started)
            return await self.wait_for_result(started.pipeline_run_id, options=wait_options, artifacts=artifacts)

        await asyncio.sleep(0)
        if on_starting is not None:
            on_starting()
        return await self._execute_blocking(
            pipe_code=pipe_code,
            files=files,
            mthds_contents=mthds_contents,
            inputs=inputs,
            output_name=output_name,
            output_multiplicity=output_multiplicity,
            dynamic_output_concept_ref=dynamic_output_concept_ref,
            extra=extra,
            method_ref=method_ref,
            method_id=method_id,
        )

    async def _execute_blocking(
        self,
        *,
        pipe_code: str | None,
        files: MethodFiles | None,
        mthds_contents: list[str] | None,
        inputs: PipelineInputs | WorkingMemoryAbstract[StuffType] | None,
        output_name: str | None,
        output_multiplicity: VariableMultiplicity | None,
        dynamic_output_concept_ref: str | None,
        extra: dict[str, Any] | None,
        method_ref: str | None = None,
        method_id: str | None = None,
    ) -> RunResults:
        """Blocking `POST /v1/execute` adapted onto `RunResults` — the bare-runner path.

        Forwards every protocol field PLUS every extension surface: the runner-resolved
        `method_ref`, the hosted `method_id`, and the generic `extra` passthrough. An
        extension-only call (`{extra}` with no pipe_code) or a vendor selector riding `extra`
        must survive this path, not just the durable one — a `method_ref` run must run the
        same fetched package here, and a hosted `method_id` must reach the server too, so a
        runner that cannot resolve it says so instead of the client silently dropping it.

        The lift onto `RunResults` parses the run's artifacts strictly, so an answer `execute` took
        can still be one this path cannot read; it raises the same `ApiResponseError` as an answer
        `execute` itself cannot read (`_reading_inherited_answer`).
        """
        with _creating_run(), self._reading_inherited_answer(method="POST", endpoint="execute"):
            result = await self.execute(
                pipe_code=pipe_code,
                files=files,
                mthds_contents=mthds_contents,
                inputs=inputs,
                output_name=output_name,
                output_multiplicity=output_multiplicity,
                dynamic_output_concept_ref=dynamic_output_concept_ref,
                extra=extra,
                method_ref=method_ref,
                method_id=method_id,
            )
            return results_from_execute(result)

    # ── Pipelex product surface (hosted management routes) ─────────────────
    #
    # The hosted catalog/account routes the webapp drives. Every one rides the same
    # `{base}/v1/*` surface, `Authorization: Bearer`, org-from-JWT contract as the protocol
    # routes, and goes through `_request_product`, which maps a non-2xx `problem+json` to a
    # typed `ApiResponseError` — branch on `.code`, never the HTTP status.

    async def get_me(self) -> UserProfile:
        """The authenticated user's profile — `GET /v1/me`."""
        return await self._request_product("GET", "me", read=UserProfile.model_validate)

    async def list_methods(
        self,
        *,
        q: str | None = None,
        published: bool | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> MethodPage:
        """List one page of the caller's saved methods — `GET /v1/methods`.

        Args:
            q: Server-side case-insensitive substring match over name and description,
                applied across the whole catalog rather than within the returned page.
            published: `True` lists only the methods with a published version, `False` only those
                never published, sent as `published=true` or `published=false`; `None` lists both.
                It combines with `q`.
            limit: Page size. The API supplies the default and caps the maximum.
            cursor: The `next_cursor` of the previous page, passed back opaquely.

        Returns:
            A `MethodPage` of `MethodSummary` rows, ordered by creation, newest first, each carrying
            the method's publish state (`latest_version`, `latest_published`, `draft_digest`).
            `next_cursor` is `None` on the last page. `q` and `published` filter after the index
            read, so a page can come back empty and still carry a `next_cursor`: keep following it.
            For the whole catalog, prefer `iterate_methods`, which follows the cursors and cannot
            truncate.
        """
        query = _product_query({"q": q, "published": _query_flag(published), "limit": limit, "cursor": cursor})
        return await self._request_product("GET", f"methods{query}", read=MethodPage.model_validate)

    async def iterate_methods(
        self,
        *,
        q: str | None = None,
        published: bool | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[MethodSummary]:
        """Yield every saved method, following the cursors — `GET /v1/methods`.

        There is deliberately no `list_all_methods()`: an all-at-once helper needs a cap, and
        a cap is the silent truncation paging was introduced to remove.

        The loop keeps going **through an empty page that carries a live cursor**, because `q`
        and `published` are post-read filters over a bounded index slice per request, so
        `{items: [], next_cursor: "…"}` means "keep going", not "done". It stops when `next_cursor`
        is `None`, and also when the server hands back the cursor it was just sent — checked
        *before* yielding, so a stuck cursor never double-counts a page.

        Raises:
            PagingNotTerminatingError: If the server never stops handing out cursors.
        """
        async for method_summary in _follow_cursor(
            "Method",
            lambda cursor: self.list_methods(q=q, published=published, limit=limit, cursor=cursor),
        ):
            yield method_summary

    async def get_method(self, method_id: str) -> MethodDetail:
        """Read one method with its draft's files — `GET /v1/methods/{id}`.

        Its identity, its draft (`files`, `input_data`) with the draft's token (`updated_at`) and
        digest (`draft_digest`), and its latest published version's summary (`latest_version`,
        `latest_published`), whatever the publish state: a method never published reads with both
        `None`, never as an error. `files` lists the draft's tree in tree path order, each file with
        its SHA-256, its size and a link to its bytes valid for about fifteen minutes, and is empty for
        an empty draft; `write_method_tree` brings the tree to disk.

        Takes a bare catalog id: the method routes address the method itself, never a version of
        it. A caller holding `mt_…@3` strips the suffix with
        `pipelex_sdk.method_selector.parse_method_selector` and reads that version with
        `get_method_version`. Every method route raises `RequestArgumentError` for a suffixed id,
        before any request, rather than read back the `404` the platform would answer, and for an
        id that is empty, `.` or `..`, which the URL would resolve into another route's path, or
        that holds a lone surrogate, which a URL cannot carry.

        Raises:
            ApiResponseError: `404` `not_found` for an unknown or foreign-org method; `409`
                `method_being_deleted` while its erasure runs; a `409` whose verdict is `runtime` for a
                method whose draft names a tree the platform holds no record of; a `200` the SDK cannot
                read, a listing whose `sha256` is not 64 lowercase hex digits among them, reported with
                every link redacted.
        """
        return await self._request_product("GET", _method_path(method_id, call="get_method"), read=MethodDetail.model_validate, carries_links=True)

    async def create_method(self, write_input: MethodWriteInput) -> MethodData:
        """Create a method — `POST /v1/methods`.

        The new method holds its tree as its draft and has no published version, so its bare id
        answers `409 method_not_published` on the run and tooling routes until its first
        `publish_method`; its draft runs as `mt_…@draft` at once.

        The tree is `write_input.files`, sent as given, or `tree` or `contents`, which the client
        sends inline when its inline map weighs 256 KiB or less, or when the platform keeps no blob
        store, and otherwise every file by hash, after asking `POST /v1/blobs/missing` which files the
        organization lacks and uploading those (`mthds`'s `prepare_files`): a file uploaded once is
        never uploaded again. With none of the three, the draft is empty.

        Raises:
            RequestArgumentError: Two forms of the tree were given, or `contents` holds no file.
            MethodFileTransferError: A file the organization lacks could not be uploaded.
            TreeSourceError: A file of `tree` cannot be read, or changed since it was listed
                (`mthds.method_tree.exceptions`).
            ApiResponseError: `422` `invalid_method_files` for a map the standard refuses, with its
                `tree_refusal`; `422` `method_tree_too_large` for a tree past one of the deployment's
                limits, named in its `limit`; `422` `blob_mismatch` for a hash stated at another size
                than the one held; `422` `missing_blobs` for a hash entry whose bytes the organization
                does not hold; `413` `payload_too_large` for a method that would leave no room for a
                publish.
        """
        files = await self._method_tree_files(
            call="create_method",
            files=write_input.files,
            files_given="files" in write_input.model_fields_set,
            tree=write_input.tree,
            contents=write_input.contents,
            unsent=_METHOD_NOT_SAVED,
        )
        body: dict[str, Any] = {"name": write_input.name}
        if files is not None:
            body["files"] = files
        if write_input.input_data is not None:
            body["input_data"] = write_input.input_data
        return await self._request_product("POST", "methods", body=body, read=MethodData.model_validate)

    async def write_draft(self, method_id: str, draft: MethodDraftInput) -> MethodData:
        """Replace a method's draft — `PUT /v1/methods/{id}/draft`.

        The draft is never validated on write, and writing it changes nothing for the callers of the
        method's bare id, who run the latest published version until the next `publish_method`.
        The write replaces the draft's whole tree, given in exactly one form: `files`, sent as given,
        an explicit `files=None` emptying the draft, or `tree` or `contents`, sent inline or by hash as
        `create_method` sends them. `input_data` left unset keeps the stored form inputs, and an
        explicit `input_data=None` clears them (see `MethodDraftInput`). With `expected_updated_at`,
        the write is a compare-and-swap on the draft token: a draft that moved since is refused, and
        nothing is written. Without it, last writer wins.

        Args:
            method_id: The method's bare catalog id.
            draft: The draft to write.

        Returns:
            The method, with the draft's new token (`updated_at`) and digest (`draft_digest`).

        Raises:
            RequestArgumentError: The draft gives its tree in no form or in two, or `contents` holds
                no file.
            MethodFileTransferError: A file the organization lacks could not be uploaded.
            TreeSourceError: A file of `tree` cannot be read, or changed since it was listed.
            ApiResponseError: `409` `method_update_conflict` for a draft that moved since the token;
                `404` `not_found` for an unknown or foreign-org method; `409` `method_being_deleted`
                while its erasure runs; the `422` refusals of a tree `create_method` lists; `413`
                `payload_too_large` for a draft that would grow the method past the room a publish
                needs; `403` for a read-only key; a `503` that wrote nothing, safe to retry, when the
                method kept changing under the write.
        """
        endpoint = f"{_method_path(method_id, call='write_draft')}/draft"
        files_given = "files" in draft.model_fields_set
        if not files_given and draft.tree is None and draft.contents is None:
            msg = "write_draft() replaces the draft's whole tree: give it as files (files=None empties the draft), tree or contents."
            raise RequestArgumentError(msg)
        files = await self._method_tree_files(
            call="write_draft", files=draft.files, files_given=files_given, tree=draft.tree, contents=draft.contents, unsent=_METHOD_NOT_SAVED
        )
        body: dict[str, Any] = {"files": files}
        if "input_data" in draft.model_fields_set:
            body["input_data"] = draft.input_data
        if "expected_updated_at" in draft.model_fields_set:
            body["expected_updated_at"] = draft.expected_updated_at
        return await self._request_product("PUT", endpoint, body=body, read=MethodData.model_validate)

    async def _method_tree_files(
        self,
        *,
        call: str,
        files: dict[str, FileEntry] | None,
        files_given: bool,
        tree: MethodTree | None,
        contents: dict[str, bytes | str] | None,
        unsent: str,
        read_scope: str | None = None,
    ) -> dict[str, FileEntry] | None:
        """The `files` a save or a crate request sends: `files` as given, or `tree` or `contents` prepared, uploading what the organization lacks.

        `unsent` says, in an upload's failure, what did not happen because of it: `the method was not
        saved` for a save, `the request was not sent` for a crate request. `read_scope`, a crate
        request's, is the scope `POST /v1/blobs/missing` is asked under (see `missing_blobs`).

        Raises:
            RequestArgumentError: Two forms were given, `tree` holds no file, or `contents` holds no
                file or a text no UTF-8 encoder takes.
            MethodFileTransferError: A file the organization lacks could not be uploaded.
        """
        given = [name for name, present in (("files", files_given), ("tree", tree is not None), ("contents", contents is not None)) if present]
        if len(given) > 1:
            msg = f"{call}() takes the method's tree in one form, files, tree or contents; got {' and '.join(given)}."
            raise RequestArgumentError(msg)
        if tree is not None and not tree.files:
            remedy = "; give files=None for an empty draft" if unsent == _METHOD_NOT_SAVED else ""
            msg = f"{call}() got a tree holding no file, and a method tree holds at least one{remedy}."
            raise RequestArgumentError(msg)
        token = _TREE_READ_SCOPE.set(read_scope or None)
        try:
            if tree is not None:
                listed_tree = tree
                return await self._prepared_tree_files(lambda: self.prepare_files(listed_tree), unsent=unsent)
            if contents is not None:
                data = _contents_as_bytes(contents, call=call)
                return await self._prepared_tree_files(lambda: self.prepare_files_from_contents(data), unsent=unsent)
            return files
        finally:
            _TREE_READ_SCOPE.reset(token)

    async def _prepared_tree_files(self, prepare: Callable[[], Awaitable[dict[str, FileEntry]]], *, unsent: str) -> dict[str, FileEntry]:
        """Run `mthds`'s tree preparation, its failures raised as this SDK's errors, each carrying a verdict.

        An upload target's refusal becomes a `MethodFileTransferError` whose message and members name
        the blob and the status, never the target's link or storage's error body, which can echo the
        signed request: so neither the standard's error, which quotes that body, nor httpx's, which holds
        the request, is kept as the cause or the context. The API's own refusals and failures already
        carry a verdict, and the standard client's bare refusals become a `RequestArgumentError`.
        """
        transfer_error: MethodFileTransferError
        try:
            return await prepare()
        except _MthdsBlobUploadError as exc:
            upload_host = urlsplit(exc.upload_url).hostname or "storage"
            status_line = f"{exc.status} {exc.status_text}".rstrip()
            msg = f"Uploading the file with SHA-256 {exc.sha256} to {upload_host} failed ({status_line}), so {unsent}."
            transfer_error = MethodFileTransferError(
                msg,
                operation=MethodFileTransferOperation.UPLOAD,
                code=method_file_transfer_code_of_status(exc.status),
                sha256=exc.sha256,
                status=exc.status,
            )
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            # The API's own requests go through `_send`, which raises `ApiUnreachableError`, so an httpx
            # failure reaching here is an upload's, sent straight to storage: no answer, or one whose body
            # could not be decoded. httpx's error holds the request, whose URL is the signed target, so
            # only its class name travels.
            msg = f"A file the organization lacks could not be uploaded to storage: no answer came back ({type(exc).__name__}), so {unsent}."
            transfer_error = MethodFileTransferError(
                msg, operation=MethodFileTransferOperation.UPLOAD, code=MethodFileTransferCode.UNREACHABLE, sha256=None
            )
        except PipelineRequestError as exc:
            refined = _with_verdict(exc)
            if refined is exc:
                raise
            raise refined from exc
        # Raised outside the handler, so the failure it replaces is not even its context.
        raise transfer_error

    @override
    async def _prepare_files(
        self, *, tree_files: list[TreeFile], digest: str, read: Callable[[TreeFile], bytes], inline_max_bytes: int
    ) -> dict[str, FileEntry]:
        """Prepare a tree's files as the base does, keeping the answer of `POST /v1/blobs/missing` for `_upload_missing`.

        The base's `prepare_files` and `prepare_files_from_contents` both prepare through here, so a
        caller of either reads an answer asking for blobs the tree does not hold as every save does.
        """
        token = _MISSING_BLOBS_ANSWER.set(_AnswerSeen())
        try:
            return await super()._prepare_files(tree_files=tree_files, digest=digest, read=read, inline_max_bytes=inline_max_bytes)
        finally:
            _MISSING_BLOBS_ANSWER.reset(token)

    @override
    async def missing_blobs(self, blobs: Sequence[BlobRef], digest: str | None = None) -> MissingBlobsResult:
        """Which of these blobs the platform lacks, and where to upload each — `POST /v1/blobs/missing`.

        The base's route, so that a `200` whose body is not JSON or not the route's answer raises this
        SDK's `ApiResponseError` of an answer it cannot read, as every other route's does: its upload
        targets are signed links, so the error carries the body redacted and no parse failure.

        While a crate request carrying a `read_scope` prepares its tree, the route is asked under that
        scope, as its `read_scope` query, the Pipelex API's extension naming the blob store asked, so
        the blobs are uploaded into the store the request's hash entries are read from; each upload
        target the runner answers is signed for that scope. The hosted platform's own route reads the
        caller's organization and ignores the query, as it ignores the request's `read_scope`.

        Raises:
            ApiResponseError: The platform answers non-2xx, or a 2xx this SDK cannot read.
            ApiUnreachableError: No answer came back.
        """
        endpoint = _missing_blobs_endpoint()
        with self._reading_inherited_answer(method="POST", endpoint=endpoint, carries_links=True) as seen:
            if endpoint == _MISSING_BLOBS:
                answer = await super().missing_blobs(blobs, digest=digest)
            else:
                # The base's request, at the scoped endpoint: the base takes no query of its own.
                content = MissingBlobsRequest(blobs=list(blobs), digest=digest).model_dump_json(exclude_none=True).encode("utf-8")
                response = await self._send("POST", self._url(endpoint), content=content, request_timeout=self.request_timeout_seconds)
                if not response.is_success:
                    self._raise_api_response_error(method="POST", endpoint=endpoint, response=response)
                answer = MissingBlobsResult.model_validate(response.json())
        preparing = _MISSING_BLOBS_ANSWER.get()
        if preparing is not None:
            preparing.response = seen.response
        return answer

    @override
    async def _upload_missing(self, missing: list[MissingBlob], *, file_of_blob: dict[str, TreeFile], read: Callable[[TreeFile], bytes]) -> None:
        """Upload what `missing_blobs` asked for as the base does, once its answer asks only for blobs the tree holds.

        A blob is named by its hash and its size, so one the tree holds under the same hash at another
        size is a blob the tree does not hold. An answer asking for one is the platform's fault, not the
        caller's: it is raised as an answer this SDK cannot read, carrying that answer redacted, rather
        than the base's bare refusal, and nothing is uploaded.

        Raises:
            ApiResponseError: The answer asks for a blob the tree does not hold; its verdict is `runtime`.
        """
        strangers: set[str] = set()
        for blob in missing:
            tree_file = file_of_blob.get(blob.sha256)
            if tree_file is None or tree_file.size != blob.size:
                strangers.add(blob.sha256)
        preparing = _MISSING_BLOBS_ANSWER.get()
        response = preparing.response if preparing is not None else None
        if strangers and response is not None:
            raise self._unreadable_answer(
                method="POST",
                path=f"/{_API_PREFIX}/{_MISSING_BLOBS}",
                request_url=self._url(_missing_blobs_endpoint()),
                response=response,
                what=f"a body asking for blobs this tree does not hold: {', '.join(sorted(strangers))}",
                carries_links=True,
            )
        await super()._upload_missing(missing, file_of_blob=file_of_blob, read=read)

    async def method_tree_limits(self) -> TreeLimits:
        """The limits the deployment holds a method's tree to, as `mthds`'s lister takes them — `GET /v1/version`.

        The hosted platform announces them under `limits.method_tree` of its public version handshake:
        how many files, how large one file, how large all of them together. A limit the server does not
        announce is left unset, so a bare runner, which announces none, yields no limit, and none is ever
        assumed. A value that is not a positive integer is left out rather than trusted.

        Raises:
            ApiResponseError: The server answers non-2xx, or a 2xx that is not a version.
            ApiUnreachableError: No answer came back.
        """
        return _announced_tree_limits(await self.version())

    async def list_method_tree(self, path: Path) -> MethodTree:
        """List the method tree of a directory or of a `.mthds` file, under the limits the deployment announces.

        `mthds`'s lister (`mthds.method_tree.lister.list_method_tree`) finds the method's root by
        Manifest Discovery, applies the standard's membership rule and hashes every file, stopping at
        the first limit `method_tree_limits` reports before hashing anything, so a tree the platform
        would refuse is refused here, naming the limit. The listing runs off the event loop. The tree is
        what `MethodWriteInput.tree` and `MethodDraftInput.tree` take.

        Args:
            path: The directory, or the `.mthds` file, to list.

        Raises:
            TreeLimitError: The tree passes one of the deployment's limits (`mthds.method_tree.exceptions`).
            MethodTreeRefusedError: The tree breaks the standard's rules, or holds no file.
            TreeSourceError: The path is missing or a file cannot be read.
            ApiResponseError: The version handshake answered non-2xx.
            ApiUnreachableError: The version handshake got no answer.
        """
        limits = await self.method_tree_limits()
        return await asyncio.to_thread(list_method_tree, path, limits=limits)

    async def write_method_tree(self, files: Sequence[SavedMethodFile], *, destination: Path) -> None:
        """Write a saved method's tree to disk: each file of a listing `get_method` or `get_method_version` served, at its tree path.

        Each file is downloaded through its link, with no credential of this client, and checked
        against the listing: its size and its SHA-256 must be the ones listed, so what lands on disk is
        the tree the method's digest names. The files are written into a fresh hidden directory beside
        `destination`, which takes the name `destination` only once every file is written: an
        interrupted, failed or cancelled write never leaves a partial tree under that name, and its
        hidden directory is removed. `destination` is made absolute and normalized first, without
        following a symbolic link, so a relative name, `Path(".")` included, names the directory it
        means; it must not exist, or be an empty directory, and a directory already holding files is
        refused rather than written into or replaced. An empty listing writes an empty directory.

        A bounded number of files move at a time, each holding its turn until its bytes are on disk, and
        the first failure stops the write: the downloads still running are cancelled. The checks on
        disk, the directories, the move into place and the cleanup run off the event loop.

        The links expire about fifteen minutes after the read that served them: write the tree soon
        after reading the method, and read it again for fresh links when a download is refused.

        Args:
            files: The listing, as `MethodDetail.files` or `MethodVersion.files` carries it.
            destination: The directory the tree is written as.

        Raises:
            RequestArgumentError: `destination` exists and is not an empty directory, or is the root of
                a filesystem, or the listing holds a path that is not a tree path, the same path twice,
                or paths that collide once case-folded or where one names a directory of another;
                nothing is downloaded.
            MethodFileTransferError: A file could not be downloaded, or its bytes are not the file
                listed; nothing is left under `destination`.
        """
        _refuse_unwritable_listing(files)
        target = Path(os.path.normpath(destination.absolute()))
        if not target.name:
            msg = f"Cannot write a method tree at '{destination}': it is the root of a filesystem, and a tree is written as a directory of its own."
            raise RequestArgumentError(msg)
        staging = await asyncio.to_thread(_make_staging_directory, target)
        is_in_place = False
        try:
            async with self._make_download_client() as download_client:
                await self._download_tree_into(download_client, files=files, staging=staging)
            await _run_to_end_in_thread(_move_into_place, staging, target)
            is_in_place = True
        finally:
            if not is_in_place:
                # Shielded, so a cancellation arriving now still leaves no hidden directory behind.
                await asyncio.shield(asyncio.to_thread(shutil.rmtree, staging, ignore_errors=True))

    async def _download_tree_into(self, download_client: httpx.AsyncClient, *, files: Sequence[SavedMethodFile], staging: Path) -> None:
        """Download every file of a listing into `staging`, a bounded number at a time, stopping at the first failure.

        A file holds its slot from its request until its bytes are written, so no more than
        `_MAX_CONCURRENT_DOWNLOADS` files are ever held in memory. At the first failure the downloads
        still running are cancelled and awaited, a write in progress running to its end, so nothing
        writes into `staging` once this returns; the first failure in listing order among those met is
        then raised.
        """
        slots = asyncio.Semaphore(_MAX_CONCURRENT_DOWNLOADS)

        async def download_one(saved_file: SavedMethodFile) -> None:
            async with slots:
                data = await self._download_method_file(download_client, saved_file=saved_file)
                await _run_to_end_in_thread(_write_new_file, staging.joinpath(*saved_file.path.split("/")), data)

        tasks = [asyncio.create_task(download_one(saved_file)) for saved_file in files]
        if not tasks:
            return
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        for task in tasks:
            failure = None if task.cancelled() else task.exception()
            if failure is not None:
                raise failure

    def _make_download_client(self) -> httpx.AsyncClient:
        """The HTTP client a saved method's files are downloaded through, apart from the API client: no default header, no auth, no event hook.

        A link is presigned storage, another server than the API, so neither the API key nor this
        client's headers go with it. Redirects are not followed: a presigned link names its object.
        """
        return httpx.AsyncClient()

    async def _download_method_file(self, download_client: httpx.AsyncClient, *, saved_file: SavedMethodFile) -> bytes:
        """Download one file of a listing and check its bytes against it, reading no more than its listed size and one byte.

        The whole exchange, its body included, is bounded by `request_timeout_seconds`, as each of
        httpx's phases is: a body that stalls after its headers arrived times out as surely as a
        server that never answers.

        Raises:
            MethodFileTransferError: Storage gave no answer in time, refused the request, or sent a body
                httpx cannot decode, or the bytes are not the file listed. Neither the message, nor a
                member, nor a cause or context carries the link.
        """
        host = urlsplit(saved_file.url).hostname or "storage"
        failure_name: str | None = None
        received = bytearray()
        try:
            async with asyncio.timeout(self.request_timeout_seconds):
                received = await self._received_bytes(download_client, saved_file=saved_file, host=host)
        except TimeoutError:
            failure_name = "TimeoutError"
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            # httpx's error holds the request, whose URL is the signed link, so only its class name travels.
            failure_name = type(exc).__name__
        if failure_name is not None:
            # Raised outside the handler, so httpx's error is not even its context.
            msg = f"Downloading '{saved_file.path}' from {host} failed: no answer came back ({failure_name})."
            raise MethodFileTransferError(
                msg,
                operation=MethodFileTransferOperation.DOWNLOAD,
                code=MethodFileTransferCode.UNREACHABLE,
                sha256=saved_file.sha256,
                path=saved_file.path,
            )
        data = bytes(received)
        data_sha256 = await asyncio.to_thread(sha256_hex, data)
        if len(data) != saved_file.size or data_sha256 != saved_file.sha256:
            msg = (
                f"The bytes downloaded for '{saved_file.path}' are not the file listed: the listing names {saved_file.size} bytes "
                f"hashing to {saved_file.sha256}, and {'more than that' if len(data) > saved_file.size else f'{len(data)} bytes'} came back"
                + ("." if len(data) > saved_file.size else f", hashing to {data_sha256}.")
            )
            raise MethodFileTransferError(
                msg,
                operation=MethodFileTransferOperation.DOWNLOAD,
                code=MethodFileTransferCode.MISMATCH,
                sha256=saved_file.sha256,
                path=saved_file.path,
            )
        return data

    async def _received_bytes(self, download_client: httpx.AsyncClient, *, saved_file: SavedMethodFile, host: str) -> bytearray:
        """Send one file's download and read its body, stopping once it passes the listed size.

        Raises:
            MethodFileTransferError: Storage refused the request; a refused link may have expired.
        """
        async with download_client.stream("GET", saved_file.url, timeout=self.request_timeout_seconds) as response:
            if not response.is_success:
                status_line = f"{response.status_code} {response.reason_phrase}".rstrip()
                msg = (
                    f"Downloading '{saved_file.path}' from {host} failed ({status_line}). A refused link may have expired: "
                    "read the method again for fresh links."
                )
                raise MethodFileTransferError(
                    msg,
                    operation=MethodFileTransferOperation.DOWNLOAD,
                    code=method_file_transfer_code_of_status(response.status_code),
                    sha256=saved_file.sha256,
                    path=saved_file.path,
                    status=response.status_code,
                )
            received = bytearray()
            async for chunk in response.aiter_bytes():
                received.extend(chunk)
                if len(received) > saved_file.size:
                    break
        return received

    async def rename_method(self, method_id: str, name: str) -> MethodData:
        """Rename a method — `PATCH /v1/methods/{id}`.

        The name belongs to the method, not to a version: a rename changes nothing else, moves no
        token and never commits the draft, so the `updated_at` a caller holds stays valid for its
        next `write_draft` or `publish_method`.

        Args:
            method_id: The method's bare catalog id.
            name: The new name.

        Raises:
            ApiResponseError: `404` `not_found`; `409` `method_being_deleted`; `403` for a read-only
                key; `422` for an empty name or one holding a lone surrogate; `413`
                `payload_too_large` for a name so long it would leave the method too large to
                publish; a `503` that wrote nothing, safe to retry, when draft writes kept landing
                under the rename.
        """
        return await self._request_product(
            "PATCH", _method_path(method_id, call="rename_method"), body={"name": name}, read=MethodData.model_validate
        )

    async def publish_method(self, method_id: str, *, expected_draft_updated_at: str) -> MethodPublishResult:
        """Publish a method's draft as its next version — `POST /v1/methods/{id}/publish`.

        `expected_draft_updated_at` is the draft token the caller last saw (`MethodData.updated_at`),
        and it is required: a publish never takes a draft its caller has not seen. The platform
        checks the token, answers `unchanged` without asking the runner when the draft's digest
        equals the latest version's, and otherwise validates the draft and, when it validates and
        runs, writes version N+1. A publish moves no token.

        Only a draft that differs from the latest version reaches the runner, and a runner that cannot
        be reached, answers unusably or does not finish within the platform's deadline is a `502` or a
        `503` with nothing written, so a retry is safe; a runner that refuses the request itself is
        relayed under its own status. A retry of a publish that landed while its answer was lost, as
        on a client timeout, answers `unchanged` with the version it wrote.

        Args:
            method_id: The method's bare catalog id.
            expected_draft_updated_at: The draft token the caller last saw, echoed verbatim.

        Returns:
            A `MethodPublishResult` discriminated on `outcome` — branch on it: `MethodPublished` with
            the new `version`; `MethodPublishUnchanged` with the existing latest `version`;
            `MethodPublishRefused` with a `reason` (`invalid`, or `not_runnable` for a draft that
            validates with pending signatures), a `message` and the runner's `validation` verdict.
            Every arm carries the `method`.

        Raises:
            RequestArgumentError: `expected_draft_updated_at` is not a `str` — `None` included; nothing
                is sent.
            ApiResponseError: When no verdict was produced: `409` `method_update_conflict` for a draft
                that moved since the token; `409` `method_being_deleted`; `404` `not_found`; `422`
                for a draft with no `.mthds` file or whose file names a run could not assemble (one
                name used by a `.mthds` and a Python file); `413` `payload_too_large` for a draft too
                large to publish; `403` for a read-only key; `502` or `503` from the runner, as above.
        """
        # Checked as an `object`, as `get_method_version` checks its version: a caller forwarding an
        # optional `updated_at` would otherwise send a null token and read the platform's `422`.
        token = cast("object", expected_draft_updated_at)
        if not isinstance(token, str):
            msg = (
                "publish_method() needs expected_draft_updated_at: the draft token (the method's updated_at) the caller "
                f"last saw, so a publish never takes a draft it has not seen; got {type(token).__name__}."
            )
            raise RequestArgumentError(msg)
        body = {"expected_draft_updated_at": token}
        endpoint = f"{_method_path(method_id, call='publish_method')}/publish"
        return await self._request_product("POST", endpoint, body=body, read=MethodPublishResultAdapter.validate_python)

    async def list_method_versions(self, method_id: str, *, limit: int | None = None, cursor: str | None = None) -> MethodVersionPage:
        """List one page of a method's published versions, newest first — `GET /v1/methods/{id}/versions`.

        Args:
            method_id: The method's bare catalog id.
            limit: Page size, from 1 to 100; the API defaults to 20 and refuses a `limit` outside
                that range with a `422`.
            cursor: The `next_cursor` of the previous page, passed back opaquely.

        Returns:
            A `MethodVersionPage` of `MethodVersionSummary` rows, without their files. `next_cursor`
            is `None` on the last page; a page may be short while it is set, because the platform
            reads versions whole. A method never published answers an empty page.

        Raises:
            ApiResponseError: `404` `not_found` for an unknown method; `409` `method_being_deleted`;
                `400` `malformed_request` for a cursor the listing did not issue for this method;
                `422` for a `limit` outside 1 to 100.
        """
        query = _product_query({"limit": limit, "cursor": cursor})
        endpoint = f"{_method_path(method_id, call='list_method_versions')}/versions{query}"
        return await self._request_product("GET", endpoint, read=MethodVersionPage.model_validate)

    async def get_method_version(self, method_id: str, version: int) -> MethodVersion:
        """Read one published version of a method, with its files — `GET /v1/methods/{id}/versions/{n}`.

        `files` lists the version's tree in tree path order, each file with a link to its bytes valid
        for about fifteen minutes; `write_method_tree` brings the tree to disk.

        Args:
            method_id: The method's bare catalog id.
            version: The version number, a positive integer.

        Raises:
            RequestArgumentError: `version` is not a positive integer — a `bool`, a `float` such as
                `2.0`, a numeric string and anything else that is not an `int` included; nothing is sent.
            ApiResponseError: `404` `method_version_not_found` for a version the method never
                published; `404` `not_found` for an unknown method; `409` `method_being_deleted`; a
                `409` `conflict` for a version stored before methods were trees that the platform has
                not rewritten as one (its `tree_digest` is `None`); a `200` the SDK cannot read,
                reported with every link redacted.
        """
        # Checked as an `object`: the annotation is a promise to the type checker, not to a caller
        # forwarding a float or a CLI argument, and only an `int` puts a version number in the path.
        candidate = cast("object", version)
        if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < 1:
            msg = f"get_method_version() takes a version number, a positive integer; got {version!r}."
            raise RequestArgumentError(msg)
        endpoint = f"{_method_path(method_id, call='get_method_version')}/versions/{version}"
        return await self._request_product("GET", endpoint, read=MethodVersion.model_validate, carries_links=True)

    async def delete_method(self, method_id: str) -> MethodDeletionAccepted:
        """Erase a method and everything it produced — `DELETE /v1/methods/{id}`.

        **Asynchronous, and the return value says so.** The platform answers `202` the moment it
        has claimed the method and terminated its in-flight workflows; the rest of the cascade
        (runs, events, S3 objects) is enqueued. So a returned `MethodDeletionAccepted` means
        "accepted", never "gone" — completion is the method's row disappearing from
        `list_methods`, not any field of the acceptance body. Until then the row stays listed
        with a `deletion_state`, which is what lets a UI render it as "Deleting…", while
        `get_method` refuses it with a `409`.

        A double-clicked delete is safe: the claim is a conditional write, so the second call is
        an `ApiResponseError` (`409 method_being_deleted`) rather than a second cascade over the same
        runs. An unknown or foreign-org id is a `404`. The erasure deletes the method's published
        versions with the rest.

        Args:
            method_id: The method's bare catalog id: the whole method is erased, never one of its
                versions.

        Returns:
            The platform's acceptance — `method_id`, the `deletion_state` the cascade started
            in, and the `deletion_job_id` a caller can log or correlate.
        """
        return await self._request_product("DELETE", _method_path(method_id, call="delete_method"), read=MethodDeletionAccepted.model_validate)

    # ----- method examples (`/v1/methods/{id}/examples`) -----------------------------------------
    #
    # Every example route takes a bare catalog id, as `get_method` does, and answers `404` `not_found`
    # for an unknown method or example and `409` `method_being_deleted` while the method's erasure runs.
    # The writes are `403` to a read-only key, which may still read.

    async def create_method_example(
        self,
        method_id: str,
        *,
        name: str,
        inputs: dict[str, Any],
        run_id: str | None = None,
    ) -> MethodExample:
        """Save an example on a method — `POST /v1/methods/{id}/examples`.

        An example is a named set of inputs, and with `run_id`, a run of this method that used exactly
        those inputs, recorded as its latest run. The body is `name`, `inputs` and, when given, `run_id`.

        Args:
            method_id: The method's bare catalog id.
            name: The example's name, 1 to 200 characters and not blank.
            inputs: The inputs a run of the example sends, a JSON object.
            run_id: A run of this method that used exactly these inputs, recorded as the example's
                latest run at revision 1; `None` sends no run.

        Returns:
            The example as stored, at `input_revision` 1.

        Raises:
            RequestArgumentError: `name` or `inputs` is `None`, or `run_id` is given but is empty or not a
                `str`; nothing is sent.
            ApiResponseError: `404` `run_not_found` for a `run_id` that is not one of this method's runs
                in the caller's organization, with nothing written; `413` `payload_too_large` for an
                example larger than one stored item holds; `422` for a name that is empty, blank or over
                200 characters, or inputs that are not a JSON object; and the codes every example route
                answers.
        """
        endpoint = f"{_method_path(method_id, call='create_method_example')}/examples"
        # Checked as `object`s: the annotations are promises to the type checker, not to a caller forwarding
        # an optional value, which would be sent as `null` for the platform to refuse.
        name_missing = cast("object", name) is None
        inputs_missing = cast("object", inputs) is None
        got: str | None = None
        if name_missing and inputs_missing:
            got = "neither"
        elif name_missing:
            got = "no name"
        elif inputs_missing:
            got = "no inputs"
        if got is not None:
            msg = f"create_method_example() needs the example's name and its inputs; got {got}."
            raise RequestArgumentError(msg)
        body: dict[str, Any] = {"name": name, "inputs": inputs}
        if run_id is not None:
            # Checked as an `object`, as the latest-run write checks its run id: the annotation is a
            # promise to the type checker, not to a caller forwarding an id it read elsewhere.
            body["run_id"] = _require_non_empty_id(run_id, call="create_method_example", what=_CREATE_RUN_ID_ARGUMENT)
        return await self._request_product("POST", endpoint, body=body, read=MethodExample.model_validate)

    async def list_method_examples(self, method_id: str, *, limit: int | None = None, cursor: str | None = None) -> MethodExamplePage:
        """List one page of a method's examples, oldest first, inputs included — `GET /v1/methods/{id}/examples`.

        Args:
            method_id: The method's bare catalog id.
            limit: Page size, from 1 to 100; the API defaults to 50 and refuses a `limit` outside that
                range with a `422`.
            cursor: The `next_cursor` of the previous page, passed back opaquely.

        Returns:
            A `MethodExamplePage` of `MethodExample` rows. `next_cursor` is `None` on the last page; a page
            may be short while it is set, because the platform reads examples whole and stops a read at
            1 MB. For every example, prefer `iterate_method_examples`, which follows the cursors.

        Raises:
            ApiResponseError: `400` `malformed_request` for a cursor the listing did not issue for this
                method; `422` for a `limit` outside 1 to 100; and the codes every example route answers.
        """
        query = _product_query({"limit": limit, "cursor": cursor})
        endpoint = f"{_method_path(method_id, call='list_method_examples')}/examples{query}"
        return await self._request_product("GET", endpoint, read=MethodExamplePage.model_validate)

    def iterate_method_examples(self, method_id: str, *, limit: int | None = None) -> AsyncIterator[MethodExample]:
        """Yield every example of a method, oldest first, following the cursors — `GET /v1/methods/{id}/examples`.

        An iterator rather than an all-at-once list, for the reason `iterate_methods` is one: a helper
        returning a list needs a cap, and a cap is a silent truncation. It runs the loop `iterate_methods`
        and `iterate_runs` share, so it keeps going through a short or empty page that carries a cursor,
        stops on a `None` cursor or on a cursor the server failed to advance, and raises at the same page
        ceiling.

        Raises:
            RequestArgumentError: At the call, before the iterator is iterated or anything is sent, for a
                `method_id` that `list_method_examples` refuses: a suffixed one, or one that is not a `str`,
                is empty, `.` or `..`, or holds a lone surrogate.
            PagingNotTerminatingError: If the server never stops handing out cursors.
        """
        # Checked here rather than in an async generator's body, which runs only once it is iterated and
        # would refuse the id at the first `__anext__`, away from the call that passed it.
        _method_path(method_id, call="iterate_method_examples")
        return _follow_cursor("Method example", lambda cursor: self.list_method_examples(method_id, limit=limit, cursor=cursor))

    async def get_method_example(self, method_id: str, example_id: str) -> MethodExample:
        """Read one example of a method — `GET /v1/methods/{id}/examples/{example_id}`.

        The read is consistent, so an example saved a moment ago is found.

        Args:
            method_id: The method's bare catalog id.
            example_id: The example's `example_id`.

        Raises:
            RequestArgumentError: `example_id` is empty, `.` or `..`, holds a lone surrogate, or is not a `str`; nothing is sent.
            ApiResponseError: `422` for an example id longer than one can be (64 characters), and the
                codes every example route answers.
        """
        endpoint = _method_example_path(method_id, example_id, call="get_method_example")
        return await self._request_product("GET", endpoint, read=MethodExample.model_validate)

    async def update_method_example(
        self,
        method_id: str,
        example_id: str,
        *,
        name: str | None = None,
        inputs: dict[str, Any] | None = None,
    ) -> MethodExample:
        """Rename an example, give it new inputs, or both — `PATCH /v1/methods/{id}/examples/{example_id}`.

        **New inputs raise `input_revision` by one and clear `latest_run_id`**, since the run no longer
        shows what the inputs produce; inputs that are the same as the stored ones, their keys in another
        order included, change nothing, while `3` becoming `3.0` is a change. A rename alone keeps both.
        The edit takes no revision or token: the latest-run write is what the revision guards. The body
        is the fields given; `None` sends nothing and keeps the stored value.

        Args:
            method_id: The method's bare catalog id.
            example_id: The example's `example_id`.
            name: The example's new name, 1 to 200 characters and not blank.
            inputs: The example's new inputs, a JSON object.

        Returns:
            The example as it now stands.

        Raises:
            RequestArgumentError: `example_id` is empty, `.` or `..`, holds a lone surrogate, or is not a `str`, or neither `name` nor
                `inputs` is given; nothing is sent.
            ApiResponseError: `413` `payload_too_large` for inputs larger than one stored item holds;
                `422` for a name that is empty, blank or over 200 characters, or inputs that are not a JSON
                object; a `503` that wrote nothing, safe to retry, when concurrent edits kept landing under
                the write; and the codes every example route answers.
        """
        endpoint = _method_example_path(method_id, example_id, call="update_method_example")
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if inputs is not None:
            body["inputs"] = inputs
        if not body:
            msg = "update_method_example() needs a new name, new inputs, or both; got neither."
            raise RequestArgumentError(msg)
        return await self._request_product("PATCH", endpoint, body=body, read=MethodExample.model_validate)

    async def record_method_example_latest_run(
        self,
        method_id: str,
        example_id: str,
        *,
        run_id: str,
        input_revision: int,
    ) -> MethodExampleLatestRunResult:
        """Record a run as an example's latest — `PUT /v1/methods/{id}/examples/{example_id}/latest-run`.

        **The run is recorded only while the example still holds the revision whose inputs it used.**
        `input_revision` is the example's `input_revision` the caller read when it started the run with
        the example's inputs; the platform trusts it and does not compare the run's own inputs.

        Args:
            method_id: The method's bare catalog id.
            example_id: The example's `example_id`.
            run_id: A run of this method that used the example's inputs.
            input_revision: The example's revision whose inputs the run used, a positive integer.

        Returns:
            A `MethodExampleLatestRunResult` discriminated on `outcome` — branch on it:
            `MethodExampleLatestRunRecorded`, the run is now the example's latest;
            `MethodExampleLatestRunStale`, the example's inputs were edited since and nothing was written.
            A stale run is the expected end of a run that outlasted an edit, so it is answered, never
            raised. Both arms carry the `example` as it stands.

        Raises:
            RequestArgumentError: `example_id` is empty, `.` or `..`, holds a lone surrogate, or is not a `str`, `run_id` is not a
                non-empty `str`, or `input_revision` is not a positive integer (a `bool`, a `float` and a numeric string
                included); nothing is sent.
            ApiResponseError: When no verdict was produced: `404` `not_found` for an example deleted since;
                `404` `run_not_found` for a run that is not one of this method's, with nothing written; and
                the codes every example route answers. An answer off the union is one the SDK cannot read,
                raised as an `ApiResponseError` too.
        """
        call = "record_method_example_latest_run"
        # The arguments are checked in the order the Raises section names them, each before anything is sent.
        endpoint = f"{_method_example_path(method_id, example_id, call=call)}/latest-run"
        # Checked as `object`s, as `get_method_version` checks its version: the annotations are promises
        # to the type checker, not to a caller forwarding an optional id or a CLI argument.
        checked_run_id = _require_non_empty_id(run_id, call=call, what=_RECORD_RUN_ID_ARGUMENT)
        candidate_revision = cast("object", input_revision)
        if isinstance(candidate_revision, bool) or not isinstance(candidate_revision, int) or candidate_revision < 1:
            what = "an input_revision, the example's revision whose inputs the run used, a positive integer"
            raise _argument_refusal(call, what, repr(input_revision))
        body = {"run_id": checked_run_id, "input_revision": candidate_revision}
        return await self._request_product("PUT", endpoint, body=body, read=MethodExampleLatestRunResultAdapter.validate_python)

    async def delete_method_example(self, method_id: str, example_id: str) -> None:
        """Delete an example — `DELETE /v1/methods/{id}/examples/{example_id}`.

        The platform answers `204`. Deleting the example leaves its latest run in the method's history.

        Args:
            method_id: The method's bare catalog id.
            example_id: The example's `example_id`.

        Raises:
            RequestArgumentError: `example_id` is empty, `.` or `..`, holds a lone surrogate, or is not a `str`; nothing is sent: `..`
                would address the method, and its erasure would answer the delete.
            ApiResponseError: `404` `not_found` when there is no such example, one already deleted
                included, and the codes every example route answers.
        """
        endpoint = _method_example_path(method_id, example_id, call="delete_method_example")
        await self._request_product_without_answer("DELETE", endpoint)

    async def list_memberships(self) -> MembershipsResponse:
        """The caller's org memberships + active-org feature flags — `GET /v1/organizations/memberships`."""
        return await self._request_product("GET", "organizations/memberships", read=MembershipsResponse.model_validate)

    async def create_organization(self, name: str) -> Membership:
        """Create an organization — `POST /v1/organizations`."""
        return await self._request_product("POST", "organizations", body={"name": name}, read=Membership.model_validate)

    async def rename_organization(self, org_id: str, name: str) -> Membership:
        """Rename an organization — `PATCH /v1/organizations/{org_id}`."""
        endpoint = f"organizations/{_id_path_segment(org_id, call='rename_organization', what=_ORG_ID_ARGUMENT)}"
        return await self._request_product("PATCH", endpoint, body={"name": name}, read=Membership.model_validate)

    async def get_subscription(self) -> SubscriptionResponse:
        """The active org's subscription state — `GET /v1/billing/subscription`."""
        return await self._request_product("GET", "billing/subscription", read=SubscriptionResponse.model_validate)

    async def list_plans(self) -> list[PlanView]:
        """Available plans (with `is_current`) — `GET /v1/billing/plans`."""
        return await self._request_product("GET", "billing/plans", read=_PLAN_LIST_ADAPTER.validate_python)

    async def list_invoices(self) -> list[InvoiceView]:
        """Past invoices — `GET /v1/billing/invoices`."""
        return await self._request_product("GET", "billing/invoices", read=_INVOICE_LIST_ADAPTER.validate_python)

    async def create_checkout(self, plan: str) -> CheckoutResponse:
        """Open a Stripe checkout for a plan — `POST /v1/billing/checkout`."""
        return await self._request_product("POST", "billing/checkout", body={"plan": plan}, read=CheckoutResponse.model_validate)

    async def change_plan(self, plan: str) -> ChangePlanResponse:
        """Switch the existing subscription's plan — `POST /v1/billing/change-plan`.

        A 409 `conflict` (`ApiResponseError.code`) means there is no subscription to change —
        start one via `create_checkout` first.
        """
        return await self._request_product("POST", "billing/change-plan", body={"plan": plan}, read=ChangePlanResponse.model_validate)

    async def get_billing_portal(self) -> BillingPortalResponse:
        """A Stripe billing-portal session URL — `GET /v1/billing/portal`.

        A 409 `conflict` (`ApiResponseError.code`) means there is no subscription yet.
        """
        return await self._request_product("GET", "billing/portal", read=BillingPortalResponse.model_validate)

    async def list_pipelex_api_keys(self) -> PipelexApiKeyList:
        """List the caller's Pipelex API keys — `GET /v1/pipelex-api-keys`."""
        return await self._request_product("GET", "pipelex-api-keys", read=PipelexApiKeyList.model_validate)

    async def create_pipelex_api_key(self, label: str) -> PipelexApiKeyCreated:
        """Mint a Pipelex API key — `POST /v1/pipelex-api-keys`.

        The plaintext `api_key` is returned ONCE. A 409 `pipelex_api_key_limit_reached`
        (`ApiResponseError.code`) means the per-account key limit is hit.
        """
        return await self._request_product("POST", "pipelex-api-keys", body={"label": label}, read=PipelexApiKeyCreated.model_validate)

    async def revoke_pipelex_api_key(self, key_id: str) -> None:
        """Revoke a Pipelex API key — `DELETE /v1/pipelex-api-keys/{id}` (empty body)."""
        segment = _id_path_segment(key_id, call="revoke_pipelex_api_key", what=_API_KEY_ID_ARGUMENT)
        await self._request_product_without_answer("DELETE", f"pipelex-api-keys/{segment}")

    async def rotate_pipelex_api_key(self, key_id: str) -> PipelexApiKeyCreated:
        """Rotate a Pipelex API key — `POST /v1/pipelex-api-keys/{id}/rotate` (no body).

        Returns the new plaintext `api_key` once; the old key stops working.
        """
        segment = _id_path_segment(key_id, call="rotate_pipelex_api_key", what=_API_KEY_ID_ARGUMENT)
        return await self._request_product("POST", f"pipelex-api-keys/{segment}/rotate", read=PipelexApiKeyCreated.model_validate)

    async def submit_onboarding(self, submission: OnboardingSubmission) -> None:
        """Submit the onboarding questionnaire — `POST /v1/onboarding/submit` (empty body)."""
        body = submission.model_dump(mode="json", exclude_none=True)
        await self._request_product_without_answer("POST", "onboarding/submit", body=body)

    async def resolve_storage_url(self, uri: str) -> ResolvedStorageUrl:
        """Resolve a storage URI to a presigned URL — `POST /v1/resolve-storage-url`."""
        return await self._request_product("POST", "resolve-storage-url", body={"uri": uri}, read=ResolvedStorageUrl.model_validate)

    async def resolve_storage_urls_bulk(self, uris: list[str]) -> BulkResolvedStorageUrls:
        """Resolve a list of storage URIs in one request — `POST /v1/resolve-storage-url/bulk`.

        The single route applied to a list. One item per reference, in request order, duplicates
        included; a refused reference is a value on its item (`error`), and the request is a `200`
        whenever every reference got a verdict. At most `BULK_RESOLVE_MAX_URIS` references per call
        (a longer list is a `422`) — `resolve_artifacts` chunks a longer set. Served by the hosted
        platform only: a deployment without the route answers a `404` `ApiResponseError`.
        """
        return await self._request_product("POST", "resolve-storage-url/bulk", body={"uris": uris}, read=BulkResolvedStorageUrls.model_validate)

    async def resolve_artifacts(self, uris: list[str]) -> list[ResolvedArtifact]:
        """Resolve a whole list of `pipelex-storage://` references through the bulk route, chunked at
        its bound, answering one `ResolvedArtifact` per reference in request order with per-reference
        failure as a value. The reading layer of the artifact stack: pair it with `collect_artifacts`
        (or `locate_artifacts`, which also says where each reference sits) to mint fresh links for
        everything a run produced. See `docs/artifact-download.md`.
        """
        return await _resolve_artifacts_impl(self, uris)

    def fetch_artifact(self, uri: str, options: FetchArtifactOptions | None = None) -> AbstractAsyncContextManager[ArtifactStream]:
        """A bounded stream for one `pipelex-storage://` reference, as an async context manager:
        resolved fresh, a timeout, redirects refused, the byte cap enforced mid-stream, no credentials
        forwarded, the store's headers neutral. What `download_artifacts` and a same-origin proxy
        share. See `docs/artifact-download.md`.
        """
        return _fetch_artifact_impl(self, uri, options)

    async def download_artifacts(
        self,
        *,
        dir_path: str | Path,
        run_id: str | None = None,
        results: RunResults | None = None,
        options: DownloadArtifactsOptions | None = None,
    ) -> DownloadArtifactsResult:
        """Save a run's produced files under a directory — the download twin of `prepare_inputs`.

        Keyed on a `run_id` (the results are re-read, so it works days after the run) or a `RunResults`
        in hand; walks the `main_stuff` scope by default, `working_memory` on request; resolves every
        link fresh (never the embedded `public_url`); names each file after the field it fills; and
        returns a produced verdict, one entry per reference with the paths it sits at, errors as
        values. See `docs/artifact-download.md`.
        """
        return await _download_artifacts_impl(self, dir_path=dir_path, run_id=run_id, results=results, options=options)

    async def upload(self, upload_input: UploadInput) -> UploadedFile:
        """Upload a base64 file — `POST /v1/upload`."""
        body = upload_input.model_dump(mode="json", exclude_none=True)
        return await self._request_product("POST", "upload", body=body, read=UploadedFile.model_validate)

    # ── Crate extensions (Pipelex API — `/v1/resolve`, `/v1/codegen`, `/v1/pipe-io`) ─────
    #
    # The second crate-family surface, mirroring the JS SDK: `/v1/resolve` emits the
    # normalized library crate, `/v1/codegen` projects that crate into stamped typed
    # artifacts plus their lock, and `/v1/pipe-io` returns a method's three I/O artifacts
    # with no dry run. Same 200-verdict discipline as `validate`, the method given as its
    # tree (the protocol's `files` map, sent as a save sends it), a `method_ref` or the
    # hosted `method_id`, under the tooling routes' strict three-way XOR (see `crate_models`).

    async def resolve(self, request: ResolveRequest) -> ResolveResponse:
        """Resolve a closure into its normalized library crate — `POST /v1/resolve`.

        The closure is loaded and statically validated, then emitted as the normalized
        library crate (fully qualified refs, refinement flattened, natives materialized,
        fingerprint set) — the MTHDS standard's Library Crate Format. It runs NO dry-run
        sweep, so a valid verdict here says the library resolves, never that it runs; that
        is `validate`'s vocabulary.

        The method arrives in exactly one of three forms — its tree, an address-form
        `method_ref` (server-resolved; registry form `501`), or a hosted `method_id`
        (platform-resolved) — enforced at request construction and by the server alike. The
        tree is the protocol's `files` map: `files` is sent as given, and a `tree` or `contents`
        inline when small and by hash otherwise, after uploading the files the API lacks, as
        `create_method` sends it.

        Returns a 200 verdict: branch on `is_valid` before reading the arm. A no-verdict
        condition (a tree the runner cannot read — `InvalidMethodFiles`, `MissingBlobs`,
        `MethodTreeTooLarge`, `InvalidBundle` — a malformed selector, a selector-resolution
        failure — fetch failure, no package at the address, an unknown or foreign-org id — auth, a
        server fault) raises `ApiResponseError`, never an `is_valid: false` verdict.

        Raises:
            RequestArgumentError: `tree` holds no file, or `contents` holds a text no UTF-8 encoder
                takes, refused before any request.
            MethodFileTransferError: A file of a `tree` or `contents` the API lacks could not be uploaded.
            TreeSourceError: A file of `tree` cannot be read, or changed since it was listed.
            ApiResponseError: No verdict could be produced.
            ApiUnreachableError: No answer came back.
        """
        return await self._request_product(
            "POST",
            "resolve",
            body=await self._crate_body(request, call="resolve"),
            read=ResolveResponseAdapter.validate_python,
            request_timeout=_crate_request_timeout_seconds(request.method_ref),
        )

    async def codegen(self, request: CodegenRequest) -> CodegenResponse:
        """Project a closure's crate into stamped typed artifacts — `POST /v1/codegen`.

        Resolves the closure exactly like `resolve`, then projects the crate through the two
        explicit axes — `kind` (`types` today) x `target` (`python-pydantic` for Python
        consumers, `python-structures`, `ts-zod`) — and returns the artifact set plus its
        `codegen.lock`. Write both verbatim and the tree is byte-identical to a local
        `pipelex codegen types` run, so the offline `pipelex codegen check` passes on it;
        `pipelex_sdk.codegen_writer.write_codegen_tree` does exactly that.

        Same 200-verdict discipline, same three-form method selector and same tree sending as
        `resolve`. A no-verdict condition (an unknown `kind`/`target`, a `pipe_ref` on the
        concept-set-wide `types` kind, a tree the runner cannot read, a malformed selector, a
        selector-resolution failure) raises `ApiResponseError`; a registry-form `method_ref` is a
        `501`.

        Raises:
            RequestArgumentError: `tree` holds no file, or `contents` holds a text no UTF-8 encoder
                takes, refused before any request.
            MethodFileTransferError: A file of a `tree` or `contents` the API lacks could not be uploaded.
            TreeSourceError: A file of `tree` cannot be read, or changed since it was listed.
            ApiResponseError: No verdict could be produced.
            ApiUnreachableError: No answer came back.
        """
        return await self._request_product(
            "POST",
            "codegen",
            body=await self._crate_body(request, call="codegen"),
            read=CodegenResponseAdapter.validate_python,
            request_timeout=_crate_request_timeout_seconds(request.method_ref),
        )

    async def pipe_io(self, request: PipeIORequest) -> PipeIOResponse:
        """Read a method's I/O artifacts without validating it — `POST /v1/pipe-io`.

        The closure resolves through the same static core as `resolve`, one pipe is selected,
        and the valid arm carries that pipe's `pipe_io_contracts`, `input_form` and
        `output_form` (the standard's artifacts, typed from `mthds.protocol`), beside the
        resolved qualified `pipe_ref`, the method's own `default_pipe_ref`, its
        `pending_signatures` and `is_runnable`. `all_pipes=True` keys the three maps by every
        pipe the closure loads instead; `include_files=True` echoes the text of the method's own
        `.mthds` bundles, keyed by tree path. It runs NO dry-run sweep, so it costs one load where
        `validate` dry-runs every pipe, and a valid verdict never says the method runs.

        Same three-form method selector and same tree sending as `resolve`, enforced at request
        construction and by the server alike. The pipe is selected by the request's `pipe_ref`,
        else the `main_pipe` of the `METHODS.toml` at the tree's root, sent or fetched, else the
        closure's single `main_pipe` declaration.

        Returns a 200 verdict: branch on `is_valid` before reading the arm. A no-verdict
        condition raises `ApiResponseError`: a refused selection (an unknown ref, or no
        `pipe_ref` and a chain that finds no entry pipe or several, without `all_pipes`) is a
        `422` whose `error_type` is `EntryPipeNotFoundError` or `EntryPipeAmbiguousError`
        (pipelex-api >= 0.33.1); a malformed request is a request-shape `422`; a tree the runner
        cannot read, the `method_ref` fetch failures and the `method_id` resolution failures are
        those of `resolve`; an artifact the server cannot derive is a `500`.

        Raises:
            RequestArgumentError: `tree` holds no file, or `contents` holds a text no UTF-8 encoder
                takes, refused before any request.
            MethodFileTransferError: A file of a `tree` or `contents` the API lacks could not be uploaded.
            TreeSourceError: A file of `tree` cannot be read, or changed since it was listed.
            ApiResponseError: No verdict could be produced.
            ApiUnreachableError: No answer came back.
        """
        # `all_pipes` and `include_files` default to False on the server too, so a flag left at its
        # default is not sent, as `@pipelex/sdk` leaves it off. The two bodies still differ by one member:
        # `@pipelex/sdk` carries `resources`, which this SDK's crate requests refuse until L-261012-992a34.
        return await self._request_product(
            "POST",
            "pipe-io",
            body=await self._crate_body(request, call="pipe_io", exclude_defaults=True),
            read=PipeIOResponseAdapter.validate_python,
            request_timeout=_crate_request_timeout_seconds(request.method_ref),
        )

    async def _crate_body(self, request: CrateToolingRequest, *, call: str, exclude_defaults: bool = False) -> dict[str, Any]:
        """The body a crate request posts: its members as given, its tree as the `files` map a save would send.

        A `tree` or `contents` is prepared here, inline when small and by hash otherwise, uploading the
        files the API lacks first, through the helper `create_method` and `write_draft` send a tree
        with, so the three routes and a save send one tree the same way, the blob route asked under the
        request's `read_scope`. `files` and `dependencies` travel as given; a member left unset, or an
        empty map, is not sent.
        """
        body = request.model_dump(
            mode="json", exclude_none=True, exclude_defaults=exclude_defaults, exclude={"files", "tree", "contents", "dependencies"}
        )
        files = await self._method_tree_files(
            call=call,
            files=request.files,
            files_given=request.files is not None,
            tree=request.tree,
            contents=request.contents,
            unsent=_REQUEST_NOT_SENT,
            read_scope=request.read_scope,
        )
        if files is not None:
            body["files"] = files
        if request.dependencies is not None:
            body["dependencies"] = request.dependencies
        return body

    # ── Model reference check (Pipelex API — `/v1/models/check`) ────────────
    #
    # Served by any `pipelex-api` runner from pipelex 0.78.0 and on the hosted API. Static and
    # inference-free, so it rides `_request_product` and its management-call budget, as
    # `@pipelex/sdk`'s `checkModelReference` rides the poll budget.

    async def check_model_reference(self, reference: str, *, category: ModelCheckCategory | None = None) -> ModelReferenceVerdict:
        """Check one model reference — `GET /v1/models/check?reference=<ref>[&type=<category>]`.

        Answers whether `reference` resolves on the runner, as what kind and to which model, from the
        parser and the deck lookups a validation runs. `reference` is written as a method's `model`
        field writes it — `$preset`, `@alias`, `~waterfall`, a bare handle, or a spelled-out namespace
        (`handle:gpt-4o`) — and is sent percent-encoded. `category` checks in that category alone;
        without it, the check covers every one.

        Returns a 200 verdict whatever the resolution: a reference that resolves nowhere is a verdict
        whose `resolution` is `NOT_FOUND`, carrying the names it may have meant, never a raised error.
        The verdict is one arm per reference kind, discriminated on the wire's `kind`
        (`PresetReferenceVerdict`, `AliasReferenceVerdict`, `WaterfallReferenceVerdict`,
        `HandleReferenceVerdict`), so narrowing the verdict narrows its `matches`.

        Args:
            reference: The model reference to check, as given; the runner trims it.
            category: The category to check in, or `None` for every category the check covers.

        Raises:
            ApiResponseError: When the runner cannot produce a verdict, a `422` whose `error_type`
                says why: `InvalidModelReference` (a blank reference, a sigil or a namespace alone,
                or one past the runner's length limit), `InvalidModelCategory` (an unknown `type`) or
                `ValidationError`. None of that is checked here, so the runner's rule is the only one.
            ApiUnreachableError: No answer came back.
        """
        query: dict[str, str] = {"reference": reference}
        if category is not None:
            query["type"] = category
        return await self._request_product("GET", f"models/check?{urlencode(query)}", read=ModelReferenceVerdictAdapter.validate_python)

    async def upload_file(
        self,
        source: UploadSource,
        *,
        filename: str | None = None,
        content_type: str | None = None,
    ) -> UploadRecord:
        """Upload one local asset and return its `UploadRecord` — the single-asset convenience
        over `upload`. `source` is a filesystem path (`str`/`Path`) or raw `bytes`. The record
        guarantees `uri`, `content_type`, `size`, and `filename`. Transport failures surface as
        the semantic input-preparation errors (rejected asset, auth, unsupported capability,
        transport). See `docs/input-preparation.md`.
        """
        return await _upload_file_impl(self, source, filename=filename, content_type=content_type)

    async def prepare_inputs(
        self,
        *,
        files: dict[str, FileEntry] | None = None,
        tree: MethodTree | None = None,
        contents: dict[str, bytes | str] | None = None,
        dependencies: dict[str, dict[str, FileEntry]] | None = None,
        method_ref: str | None = None,
        method_id: str | None = None,
        pipe_ref: str | None = None,
        inputs: dict[str, Any],
        allow_uploads: bool = True,
    ) -> PreparedInputs:
        """Prepare a pipe's inputs — resolve the declared signature, upload the file-bearing
        assets, and return copy-on-write rewritten inputs (canonical content carrying
        `pipelex-storage://` in `url`) plus one upload record per prepared asset. HTTP(S) URLs
        and existing `pipelex-storage://` URIs pass through unchanged; all failures are raised
        before any run is created.

        The method is named exactly one of three ways — its tree, a `method_ref` address
        (runner-resolved) or a stored `method_id` (platform-resolved) — all server-resolved,
        with nothing expanded client-side. The tree is given as `pipe_io` takes it, in one of
        `files`, `tree` or `contents`, with the `dependencies` it calls beside it. An empty
        selector is treated as absent. The signature comes from one `POST /v1/pipe-io` (see
        `pipe_io`), which selects the pipe and returns its input-form descriptor, so the walk is
        guided by each input's DECLARED kind rather than by the shape of its value.

        `pipe_ref` is qualified-only (`domain.pipe_code`); omit it and the server selects the
        method's entry pipe. A refused selection raises `InputPreparationError` with the
        server's reason. See `docs/input-preparation.md`.

        A value at a file input that cannot be a file, such as a number or a `data:` URL that does
        not decode, raises `InvalidInputValueError`, naming the input. With `allow_uploads=False` it
        uploads nothing and reads no file: a value that would need an upload raises
        `UploadNotAllowedError`, naming the input too.
        """
        return await _prepare_inputs_impl(
            self,
            files=files,
            tree=tree,
            contents=contents,
            dependencies=dependencies,
            method_ref=method_ref,
            method_id=method_id,
            pipe_ref=pipe_ref,
            inputs=inputs,
            allow_uploads=allow_uploads,
        )

    async def list_runs(
        self,
        method_id: str,
        *,
        created_from: str | None = None,
        created_to: str | None = None,
        created_by: Literal["me"] | None = None,
        status: Sequence[RunStatus] | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> RunPage:
        """List one page of a method's runs — `GET /v1/runs?method_id={methodId}`.

        Args:
            method_id: The bare catalog id of the method whose runs to list. The history files the runs
                of every version and of the draft together under it, so `mt_…@3` names no history of
                its own and the platform refuses it with a `400`; strip a suffix with
                `parse_method_selector`, and read which version a run ran from its `method_version`.
            created_from: Inclusive lower bound on creation, an **instant**: ISO-8601 with a
                UTC offset. These are index key conditions rather than filters, so a bare date
                or a naive timestamp is a platform `400` surfaced as `ApiResponseError`.
            created_to: Inclusive upper bound, same instant-only rule.
            created_by: `"me"` lists only the runs the caller started, resolved by the platform from
                the authenticated identity, sent as `created_by=me`; `None` lists every member's
                runs. It takes no other value: the list never narrows to another member.
            status: Only runs in one of these statuses, sent as one repeated `status=` parameter per
                status, deduplicated into `RunStatus` order; `None` lists every status. The caller's
                own latest unfinished run is `created_by="me"`, `status=[RunStatus.PENDING,
                RunStatus.STARTED, RunStatus.RUNNING]`, `limit=1`.
            limit: Page size. The API supplies the default and caps the maximum.
            cursor: The `next_cursor` of the previous page, passed back opaquely.

        Returns:
            A `RunPage` of `RunHistoryItem` rows — what a history row shows, nothing more. Open
            one run with `get_run_detail` for the whole record. `created_by` and `status` filter
            after the index read, so a filtered page can hold fewer runs than `limit`, or none, and
            still carry a `next_cursor`: an empty page is not the end, a `None` cursor is. For the
            whole history, prefer `iterate_runs`.

        Raises:
            TypeError: `status` is a bare `str`, which read as a sequence would name its characters.
            RequestArgumentError: `status` is empty or names a status that is no `RunStatus`, raised
                before any request rather than sent as a query that lists every status.
            ApiResponseError: On any non-2xx. Note that every `/v1/runs*` product route sits
                behind the platform's surface-access gate, which for API-key auth demands the
                `ff_api_keys` feature flag and fails closed — so a `403` here means "flag", not
                "wrong key".
        """
        query = _product_query(
            {
                "method_id": method_id,
                "created_from": created_from,
                "created_to": created_to,
                "created_by": created_by,
                "status": _status_filter(status),
                "limit": limit,
                "cursor": cursor,
            }
        )
        return await self._request_product("GET", f"{_RUNS}{query}", read=RunPage.model_validate)

    async def iterate_runs(
        self,
        method_id: str,
        *,
        created_from: str | None = None,
        created_to: str | None = None,
        created_by: Literal["me"] | None = None,
        status: Sequence[RunStatus] | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[RunHistoryItem]:
        """Yield every run of a method, following the cursors — `GET /v1/runs`.

        The same loop as `iterate_methods`: it keeps going **through an empty page that carries a
        live cursor**, because `created_by` and `status` are post-read filters, so a filtered page
        can hold no run and still not be the end. It stops when `next_cursor` is `None`, and when
        the server hands back the cursor it was just sent — checked *before* yielding, so a stuck
        cursor never double-counts a page.

        The page ceiling bounds the rest: a server minting fresh cursors forever, and a cursor
        that cycles across two or more values (`c1 → c2 → c1`), which the adjacent-cursor check
        does not see. Tracking every cursor seen would cost unbounded memory for the same
        protection.

        Takes a bare catalog id, as `list_runs` does.

        Raises:
            PagingNotTerminatingError: If the server never stops handing out cursors.
        """
        async for pipeline_run in _follow_cursor(
            "Run",
            lambda cursor: self.list_runs(
                method_id,
                created_from=created_from,
                created_to=created_to,
                created_by=created_by,
                status=status,
                limit=limit,
                cursor=cursor,
            ),
        ):
            yield pipeline_run

    async def get_run_detail(self, run_id: str) -> RunDetail:
        """Fetch one run record with what it executed — `GET /v1/runs/{id}`.

        Distinct from the two lifecycle reads: `get_run_status` polls `/status`, `get_run_result`
        fetches `/results`. This is the catalog-style record, and the only read that carries
        `mthds_contents` and `inputs`.
        """
        endpoint = f"{_RUNS}/{_id_path_segment(run_id, call='get_run_detail', what=_RUN_ID_ARGUMENT)}"
        return await self._request_product("GET", endpoint, read=RunDetail.model_validate)

    async def update_run(self, run_id: str, update_input: UpdateRunInput) -> None:
        """Patch a run's status (admin/manual) — `PUT /v1/runs/{id}` (empty body)."""
        body = update_input.model_dump(mode="json", exclude_none=True)
        endpoint = f"{_RUNS}/{_id_path_segment(run_id, call='update_run', what=_RUN_ID_ARGUMENT)}"
        await self._request_product_without_answer("PUT", endpoint, body=body)

    # ── Health ─────────────────────────────────────────────────────────────
    #
    # The origin-level liveness probe. `/health` is served at the origin, NOT under the
    # `/v1` prefix, and is out-of-protocol — the MTHDS Protocol defines no health route.
    # It rides the same transport and the same error as every route, as `@pipelex/sdk`'s does.

    async def health(self) -> dict[str, Any]:
        """Origin-level liveness probe — `GET {origin}/health` (NOT under the `/v1` prefix).

        Raises:
            ApiResponseError: The origin answered non-2xx, or a 2xx whose body is not a JSON object; the
                message names `/health`, and the verdict is the fallback's reading of the status, since
                the probe answers no problem document.
            ApiUnreachableError: No answer came back (DNS / connect / TLS / timeout).
        """
        url = f"{self.origin_url}/health"
        response = await self._send("GET", url, content=None, request_timeout=_POLL_REQUEST_TIMEOUT_SECONDS)
        if not response.is_success:
            raise self._api_response_error(method="GET", path="/health", request_url=url, response=response)
        return self._read_answer(_HEALTH_ANSWER_ADAPTER.validate_python, method="GET", path="/health", request_url=url, response=response)


# ── Module helpers ──────────────────────────────────────────────────────


_KNOWN_RUN_STATUS_NAMES: frozenset[str] = frozenset(RunStatus.__members__)

# The artifacts a results read can be narrowed to; a plain string equal to one's value is in it too.
_RUN_ARTIFACTS: frozenset[RunArtifact] = frozenset(RunArtifact)

# The statuses a run-history filter can name; a plain string equal to one's value is in it too.
_RUN_STATUSES: frozenset[RunStatus] = frozenset(RunStatus)


def _with_verdict(exc: PipelineRequestError) -> PipelineRequestError:
    """The error the inherited `execute` or `start` raised, as this SDK's class carrying a verdict.

    The base client raises errors of the standard's own classes, which carry none: a bare
    `PipelineRequestError` refusing the arguments before any request (nothing to run was named, or
    `extra` carries a protocol arg), answered here with a `RequestArgumentError` of the same message, and
    `mthds`'s `RunStillRunningError` on the protocol's 202 degrade, answered with this SDK's subclass of it,
    the same members carried over. An error that already carries a verdict, such as the
    `ApiUnreachableError` the `_send` override raises, is returned as it is.
    """
    if isinstance(exc, PipelexRequestError):
        return exc
    if isinstance(exc, _MthdsRunStillRunningError):
        return RunStillRunningError(str(exc), run_id=exc.run_id, retry_after_seconds=exc.retry_after_seconds, location=exc.location)
    return RequestArgumentError(str(exc))


def _normalized_selector(*, name: str, value: object) -> str | None:
    """Normalize one method-selector argument at the client boundary.

    A **non-string** value is refused rather than dropped or forwarded. A published client
    validates its request-option types at its own boundary, so that one wrong value gets one
    answer: a bare truthiness check would silently drop the falsy wrong types (`0`, `[]`) and
    forward the truthy ones (`123`, `["mt_1"]`) to a server `422` — a different partition of
    wrong values than the JS client makes for the same argument on the same wire. Typed
    `object` rather than `str | None` deliberately — this helper *is* the runtime boundary,
    and the callers it guards against are the untyped ones a type checker never sees.

    An absent or **empty** value normalizes to `None`: an empty selector selects nothing, so
    it is not sent and does not satisfy the base client's "something to run" precondition.

    Raises:
        RequestArgumentError: If the value is present and is not a string.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        msg = f"{name} must be a string, received {type(value).__name__}."
        raise RequestArgumentError(msg)
    return value or None


def _merge_run_extensions(
    extra: dict[str, Any] | None, *, method_ref: object, method_id: object, mthds_contents: list[str] | None = None
) -> dict[str, Any] | None:
    """Fold this client's own named run args into the generic `extra` passthrough handed to
    the base client.

    This is the layering seam: `method_ref` and `mthds_contents` (layer 2 — the Pipelex API's
    run sources, read by the runner) and `method_id` (layer 3 — the hosted platform's run arg)
    are named parameters on this client because it is the client that types its own stack's
    arguments, and each reaches the wire as a top-level body property through the protocol
    client's extension mechanism — which merges it without knowing what it means. See
    `_PIPELEX_API_RUN_ARGS` / `_HOSTED_RUN_ARGS`.

    Both selectors go through `_normalized_selector`: a non-string is refused, an absent or
    empty value contributes nothing. `mthds_contents` is sent only when it holds a bundle: an
    empty list names nothing to run, the one test every run-source check of this client makes
    (`has_inline_source`, `_assert_method_ref_pairs_with_nothing`), so it never reaches the wire
    beside a source that does. `None` is returned for an empty result, leaving the base's own
    handling of an absent `extra` untouched.

    Args:
        extra: Server-specific extension args from the caller, or None.
        method_ref: The published method's address, or None.
        method_id: The hosted catalog id, or None.
        mthds_contents: The inline bundles, or None.

    Returns:
        The merged extension mapping to hand to the base client, or None if there is nothing.

    Raises:
        RequestArgumentError: If `extra` carries a named arg this client reserves, or if a
            selector is present and is not a string.
    """
    extensions: dict[str, Any] = dict(extra or {})
    reserved_overlap = extensions.keys() & _RESERVED_RUN_ARGS
    if reserved_overlap:
        msg = f"extra carries reserved request args {sorted(reserved_overlap)} — pass them as named parameters instead."
        raise RequestArgumentError(msg)
    selected_method_ref = _normalized_selector(name="method_ref", value=method_ref)
    if selected_method_ref is not None:
        extensions["method_ref"] = selected_method_ref
    selected_method_id = _normalized_selector(name="method_id", value=method_id)
    if selected_method_id is not None:
        extensions["method_id"] = selected_method_id
    if mthds_contents:
        extensions["mthds_contents"] = mthds_contents
    return extensions or None


def _assert_run_source_named(
    *,
    pipe_code: str | None,
    has_inline_source: bool,
    mthds_contents: list[str] | None,
    merged_extra: dict[str, Any] | None,
    route: Literal["execute", "start"],
) -> None:
    """Refuse a run whose only source is an empty `mthds_contents`, before any request is sent.

    The base client refuses a run that names nothing. An empty `mthds_contents` names nothing either,
    and `_merge_run_extensions` leaves it out of the extensions, so the base would refuse such a run
    without naming the argument the caller gave: this words that refusal as the protocol client
    worded it when it took `mthds_contents` itself, and leaves every other case to the base.

    Raises:
        RequestArgumentError: The only source given is an empty `mthds_contents`.
    """
    if mthds_contents is None or pipe_code or has_inline_source or merged_extra:
        return
    msg = f"Either pipe_code, files, mthds_contents or a server-specific extension arg (extra) must be provided to the API {route}."
    raise RequestArgumentError(msg)


def _idempotency_key_of(value: object) -> str | None:
    """The idempotency key a start sends, or `None` when the caller gave none.

    A key that is not a string of 1 to 255 visible ASCII characters is refused rather than dropped, an empty
    one included, since a start sent without the key its caller gave would lose the protection the caller
    asked for without a word. Typed `object`, as `_normalized_selector` is, because this is the runtime
    boundary an untyped caller reaches. The characters are checked before the length, which then counts ASCII
    characters alone, so this message and `@pipelex/sdk`'s, which counts a character outside ASCII
    differently, read alike for every key; neither quotes the key, which a caller may derive from something
    private.

    Raises:
        RequestArgumentError: The key is present and is not 1 to 255 visible ASCII characters.
    """
    if value is None:
        return None
    fault = _idempotency_key_fault(value)
    if fault is None and isinstance(value, str):
        return value
    msg = (
        f"The idempotency key must be 1 to {_MAX_IDEMPOTENCY_KEY_LENGTH} visible ASCII characters (`!` to `~`), "
        f"and this one {fault or 'is not a string'}. Leave it out to start the run without one."
    )
    raise RequestArgumentError(msg)


def _idempotency_key_fault(value: object) -> str | None:
    """What is wrong with an idempotency key, or `None` when it is a valid one."""
    if not isinstance(value, str):
        return "is not a string"
    if not value:
        return "is empty"
    if not _VISIBLE_ASCII.fullmatch(value):
        return "holds a character outside visible ASCII"
    if len(value) > _MAX_IDEMPOTENCY_KEY_LENGTH:
        return f"is {len(value)} characters long"
    return None


def _assert_method_ref_pairs_with_nothing(*, mthds_contents: list[str] | None, carries_files: bool, merged_extra: dict[str, Any] | None) -> None:
    """Enforce the run routes' `method_ref` exclusivity, mirroring the server's own 422s so an
    illegal pairing fails before anything hits the wire.

    A `method_ref` is a complete run source (the fetched package carries its `.mthds` and its
    entry pipe), so it pairs with NOTHING: not with an inline source (`files` or `mthds_contents`)
    and not with the hosted `method_id` — an address run has its own provenance and needs no
    linkage id. Reads the MERGED extensions, so the presence semantics are the normalized ones (an
    empty selector was already dropped).

    The one documented run-route exception is deliberately NOT here: inline source +
    `method_id` stays legal (the inline source runs; the id demotes to run-history linkage), its
    one condition, a bare id, held by `_assert_linkage_method_id_is_bare` below.
    `pipe_code` beside a `method_ref` is legal too — it overrides the manifest's `main_pipe`.
    This SDK does not name the `bundle_b64` encoding, so its arm of the server's exclusivity has no
    client-side twin here; the server still enforces it.
    """
    if merged_extra is None or "method_ref" not in merged_extra:
        return
    if mthds_contents:
        msg = "method_ref and inline mthds_contents are mutually exclusive; send one or the other."
        raise RequestArgumentError(msg)
    if carries_files:
        msg = "method_ref and a method bundle (bundle_b64 / files) are mutually exclusive; send one or the other."
        raise RequestArgumentError(msg)
    if "method_id" in merged_extra:
        msg = (
            "method_ref and method_id are mutually exclusive: an address run carries its own provenance "
            "and takes no run-history linkage id. Send exactly one method selector."
        )
        raise RequestArgumentError(msg)


def _assert_linkage_method_id_is_bare(*, has_inline_source: bool, merged_extra: dict[str, Any] | None) -> None:
    """Enforce the run routes' linkage clause, mirroring the platform's own `422` so a suffixed
    linkage id fails before anything hits the wire.

    Beside an inline source (`files` or `mthds_contents`) the `method_id` is run-history linkage and
    must be a bare catalog id: the inline source is what runs, so a version suffix (`mt_…@3`,
    `mt_…@draft`) would claim a version that did not. A `method_id` alone keeps its suffix, which
    names the version to run. Reads the MERGED extensions, so an empty id was already dropped, and
    checks the suffix alone, by its `@`, since the catalog id's alphabet has none: the id itself
    stays a pass-through the platform resolves. As in `_assert_method_ref_pairs_with_nothing`, the
    `bundle_b64` encoding this SDK does not name has no client-side twin; the platform still refuses
    a suffixed id beside it.

    Raises:
        RequestArgumentError: A `method_id` carrying a version suffix rides beside an inline source.
    """
    if not has_inline_source or merged_extra is None:
        return
    method_id = merged_extra.get("method_id")
    if not isinstance(method_id, str) or "@" not in method_id:
        return
    msg = (
        f'method_id "{method_id}" beside an inline source is run-history linkage and must be a bare catalog id: the '
        "inline source is what runs, so a version suffix would claim a version that did not. Send the bare id "
        "(parse_method_selector(...).method_id), or drop the inline source to run the version the selector names."
    )
    raise RequestArgumentError(msg)


def _quick_request_timeout_seconds(request_timeout_seconds: float) -> float:
    """The time limit of a request that answers fast (`version`, a plain `start`): the caller's
    `request_timeout_seconds`, capped at the poll budget, since the hosted gateway cuts a response off
    at ~30s anyway.
    """
    return min(request_timeout_seconds, _POLL_REQUEST_TIMEOUT_SECONDS)


def _start_request_timeout_seconds(request_timeout_seconds: float, merged_extra: dict[str, Any] | None, *, has_inline_source: bool) -> float:
    """The time limit of `POST /v1/start`, by `@pipelex/sdk`'s rule.

    The start answers its `202` fast, so it normally gets the time limit of a quick request (see
    `_quick_request_timeout_seconds`), with exceptions that get the caller's whole
    `request_timeout_seconds`, the blocking-execute ceiling by default. A method sent inline, as its `files` tree, as `mthds_contents`
    or riding the `bundle_b64` extension, can make the request body multi-megabyte, and its upload is charged
    against the limit: the same payload must not time out on the durable path yet succeed on the
    blocking fallback. And a `method_ref` start makes the server fetch the package before the
    acknowledgement, which can run well past 30s on a cold cache; cutting it off would blame the
    network for a server still fetching.
    """
    extension = merged_extra or {}
    carries_bundle = has_inline_source or bool(extension.get("bundle_b64"))
    fetches_package = bool(extension.get("method_ref"))
    if carries_bundle or fetches_package:
        return request_timeout_seconds
    return _quick_request_timeout_seconds(request_timeout_seconds)


def _crate_request_timeout_seconds(method_ref: str | None) -> float:
    """The request budget for a call carrying a crate closure (`/v1/resolve`, `/v1/codegen`, `/v1/pipe-io`):
    the management default, unless the closure is a `method_ref` the server may have to fetch
    first — see `_METHOD_REF_FETCH_TIMEOUT_SECONDS`.
    """
    return _METHOD_REF_FETCH_TIMEOUT_SECONDS if method_ref else _POLL_REQUEST_TIMEOUT_SECONDS


def _with_validate_markdown_render(render: list[str] | None) -> list[str]:
    """Ensure `"markdown"` rides the `/validate` render list, preserving order and de-duplicating.

    Mirrors the JS `withValidateMarkdownRender` (a `Set`): the caller's tokens come first, then
    `"markdown"` if not already present, so both valid results and produced validation-error
    verdicts carry `rendered_markdown`.
    """
    return list(dict.fromkeys([*(render or []), _VALIDATE_MARKDOWN_RENDER_FORMAT]))


def _timeout_message(run_id: str, timeout_seconds: float) -> str:
    """The shared `RunTimeoutError` message — the run survives and is resumable by id."""
    return f"Run {run_id} did not reach a terminal state within {timeout_seconds}s; it is still executing server-side and can be resumed by id."


def _product_query(params: dict[str, str | int | Sequence[str] | None]) -> str:
    """Build the query string of a product list route, keeping entries on **presence**.

    Presence (`is not None`), never truthiness: an explicit empty `q` or cursor is bad input
    the API should reject, not something to silently drop into an unfiltered query that reads
    as working. A sequence of strings, such as the run list's statuses, is sent as one repeated
    parameter per value. A boolean goes through `_query_flag` first, since `str(True)` is not the
    wire's `true`. Returns `""` for no parameters, otherwise a leading `?`.
    """
    kept = {key: value for key, value in params.items() if value is not None}
    if not kept:
        return ""
    return "?" + urlencode(kept, doseq=True)


def _query_flag(value: bool | None) -> str | None:
    """A boolean query parameter as the wire spells it, `true` or `false`; `None` stays absent."""
    if value is None:
        return None
    return "true" if value else "false"


_PageItemT = TypeVar("_PageItemT")
_PageItemT_co = TypeVar("_PageItemT_co", covariant=True)


class _CursorPage(Protocol[_PageItemT_co]):
    """What `_follow_cursor` reads of a page: its rows and its opaque cursor."""

    @property
    def items(self) -> Sequence[_PageItemT_co]: ...

    @property
    def next_cursor(self) -> str | None: ...


async def _follow_cursor(noun: str, read_page: Callable[[str | None], Awaitable[_CursorPage[_PageItemT]]]) -> AsyncIterator[_PageItemT]:
    """Follow a paged list's cursor until the server says there is no more, yielding every row.

    The one loop behind `iterate_methods`, `iterate_runs` and `iterate_method_examples`, so they cannot drift apart. It
    keeps going through an empty page that carries a cursor, since a filtered page can hold no
    row and still not be the end. It stops when `next_cursor` is `None`, and when the server hands
    back the cursor it was just sent, checked before yielding so a stuck cursor never re-yields a
    page. Past `_MAX_LIST_PAGES` pages it raises rather than return a truncated list.

    Raises:
        PagingNotTerminatingError: If the server never stops handing out cursors.
    """
    cursor: str | None = None
    pages_seen = 0
    while True:
        page = await read_page(cursor)
        if cursor is not None and page.next_cursor == cursor:
            # The server did not advance. Stop before yielding, or this page is counted twice.
            return
        for item in page.items:
            yield item
        if page.next_cursor is None:
            return
        pages_seen += 1
        if pages_seen >= _MAX_LIST_PAGES:
            msg = f"{noun} paging did not terminate after {_MAX_LIST_PAGES} pages; this is a server-side fault, not a coverage limit."
            raise PagingNotTerminatingError(msg, _MAX_LIST_PAGES)
        cursor = page.next_cursor


def _status_filter(status: Sequence[RunStatus] | None) -> tuple[RunStatus, ...] | None:
    """Normalise a run-history status filter: `None` lists every status, anything else is
    deduplicated into the enum's declaration order, so the same filter always builds the same
    query, as `@pipelex/sdk` builds it.

    An empty filter names no status, and sending it as no `status=` parameter at all would list
    every status, a different question from the one asked. A name that is no `RunStatus`, which a
    caller passing plain strings can send, is one the platform refuses with a `422`. Both are
    refused here first, before any request, with `RequestArgumentError`.

    A bare `str`, a single `RunStatus` member included since a `StrEnum` member is one, is no
    filter: read as a sequence it would name its characters. It raises `TypeError`, a bug in the
    calling code that carries no verdict.

    Raises:
        TypeError: `status` is a bare `str`.
        RequestArgumentError: The filter is empty or names a status that is no `RunStatus`.
    """
    if status is None:
        return None
    if isinstance(status, str):
        msg = f'"status" must be a list or tuple naming one or more of {", ".join(RunStatus)}.'
        raise TypeError(msg)
    requested = set(status)
    if not requested:
        msg = f'"status" must name one or more of {", ".join(RunStatus)}; pass status=None to list every status.'
        raise RequestArgumentError(msg)
    unknown = sorted(f"{name}" for name in requested if name not in _RUN_STATUSES)
    if unknown:
        msg = f"Unknown run status(es) {', '.join(unknown)}; valid statuses are: {', '.join(RunStatus)}."
        raise RequestArgumentError(msg)
    return tuple(run_status for run_status in RunStatus if run_status in requested)


#: What each id a route puts in its path is, as a refusal of it names it.
_METHOD_ID_ARGUMENT = "a method id, the method's non-empty bare catalog id"
_EXAMPLE_ID_ARGUMENT = "an example id, the example's non-empty `example_id`"
_RUN_ID_ARGUMENT = "a run id, the run's non-empty `pipeline_run_id`"
_ORG_ID_ARGUMENT = "an organization id, the organization's non-empty `org_id`"
_API_KEY_ID_ARGUMENT = "an API key id, the key's non-empty `id`"

#: What the run id of each example write is, as a refusal of it names it.
_CREATE_RUN_ID_ARGUMENT = "a run_id naming a run of this method that used these inputs, a non-empty string, or none"
_RECORD_RUN_ID_ARGUMENT = "a run_id naming a run of this method that used the example's inputs, a non-empty string"

#: The ids that are dot segments, which the URL resolves before the request leaves.
_DOT_SEGMENTS = frozenset({".", ".."})


def _argument_refusal(call: str, what: str, got: str) -> RequestArgumentError:
    """The refusal of an argument a call cannot take, worded as every such refusal is: `<call>() takes <what>; got <got>.`"""
    msg = f"{call}() takes {what}; got {got}."
    return RequestArgumentError(msg)


def _require_non_empty_id(value: object, *, call: str, what: str) -> str:
    """A caller's id, checked to be a non-empty `str`: the one check every id a call takes goes through.

    Whether the id enters a path (`_id_path_segment`) or a body (a run id an example write records),
    anything else is refused before anything is sent, `call` naming the method in the message and `what`
    the id it takes. The refusal names what it got: an empty string, `None`, or the type of any other value.

    Raises:
        RequestArgumentError: `value` is not a `str`, or is empty.
    """
    if isinstance(value, str) and value:
        return value
    got: str
    if isinstance(value, str):
        got = "an empty string"
    elif value is None:
        got = "None"
    else:
        got = type(value).__name__
    raise _argument_refusal(call, what, got)


def _id_path_segment(value: object, *, call: str, what: str) -> str:
    """A caller's id as one segment of a route's path, percent-encoded: the one place an id enters a path.

    `quote(safe='')` escapes every character a path gives meaning to but the dot, so an id of `.` or `..`
    would reach the URL as a dot segment, which httpx resolves before the request leaves:
    `methods/mt_x/examples/..` is sent as `methods/mt_x`, and deleting that "example" would erase the
    method. An empty id addresses the route above it the same way, `runs/` for a run. So a value that is
    not a non-empty `str` (`_require_non_empty_id`) and a dot segment are each refused before anything is
    sent, and so is a string holding a lone surrogate, which has no UTF-8 spelling and so no
    percent-encoding: `quote` raises a `UnicodeEncodeError` for it. `call` names the method in the message
    and `what` the id it takes. An id spelling a dot in percent-encoding (`%2e`) is no dot segment once its
    `%` is escaped.

    Raises:
        RequestArgumentError: `value` is not a `str`, is empty, `.` or `..`, or holds a lone surrogate.
    """
    id_value = _require_non_empty_id(value, call=call, what=what)
    if id_value in _DOT_SEGMENTS:
        raise _argument_refusal(call, what, f'"{id_value}", a dot segment, which the URL would resolve into another route\'s path')
    try:
        return quote(id_value, safe="")
    except UnicodeEncodeError as exc:
        raise _argument_refusal(call, what, "a string holding a lone surrogate, which a URL cannot carry") from exc


# How many files of a saved tree `write_method_tree` downloads at once, as many as `mthds` uploads at once.
_MAX_CONCURRENT_DOWNLOADS = 8


_MISSING_BLOBS = "blobs/missing"


def _missing_blobs_endpoint() -> str:
    """`POST /v1/blobs/missing`'s endpoint below `/v1`, under the read scope of the tree being prepared when there is one."""
    read_scope = _TREE_READ_SCOPE.get()
    if read_scope is None:
        return _MISSING_BLOBS
    return f"{_MISSING_BLOBS}?{urlencode({'read_scope': read_scope})}"


def _contents_as_bytes(contents: dict[str, bytes | str], *, call: str) -> dict[str, bytes]:
    """A save's `contents` as each file's bytes, a text encoded in UTF-8.

    Raises:
        RequestArgumentError: `contents` holds no file, or a text no UTF-8 encoder takes, one holding a
            lone surrogate.
    """
    if not contents:
        msg = f"{call}() got contents holding no file, and a method tree holds at least one; give files=None for an empty draft."
        raise RequestArgumentError(msg)
    data: dict[str, bytes] = {}
    for tree_path, content in contents.items():
        if isinstance(content, bytes):
            data[tree_path] = content
            continue
        try:
            data[tree_path] = content.encode("utf-8")
        except UnicodeEncodeError as exc:
            msg = f"{call}() got contents['{tree_path}'] holding a lone surrogate, which is no text a file can hold: give its bytes instead."
            raise RequestArgumentError(msg) from exc
    return data


def _announced_tree_limits(version_info: VersionInfo) -> TreeLimits:
    """The tree limits a version handshake announces under `limits.method_tree`, each one a positive integer or left unset."""
    limits = (version_info.model_extra or {}).get("limits")
    announced = cast("dict[str, object]", limits).get("method_tree") if isinstance(limits, dict) else None
    if not isinstance(announced, dict):
        return TreeLimits()
    method_tree = cast("dict[str, object]", announced)

    def read(name: str) -> int | None:
        value = method_tree.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            return None
        return value

    return TreeLimits(max_files=read("max_files"), max_file_bytes=read("max_file_bytes"), max_total_bytes=read("max_total_bytes"))


def _refuse_unwritable_listing(files: Sequence[SavedMethodFile]) -> None:
    """Refuse a listing whose paths could not be written as a tree, before anything is downloaded.

    A platform's listing holds tree paths that never collide; the check guards the disk against any
    other listing a caller hands over, such as one built by hand, since a path such as `../x` would be
    written outside the destination.

    Raises:
        RequestArgumentError: A path is not a tree path, appears twice, or collides with another.
    """
    seen: set[str] = set()
    for saved_file in files:
        violation = tree_path_violation(saved_file.path)
        if violation is not None:
            msg = f"The listing holds '{saved_file.path}', which is not a tree path ({violation}), so the tree cannot be written."
            raise RequestArgumentError(msg)
        if saved_file.path in seen:
            msg = f"The listing holds '{saved_file.path}' twice, so the tree cannot be written."
            raise RequestArgumentError(msg)
        seen.add(saved_file.path)
    colliding = path_collisions(seen)
    if colliding:
        msg = f"The listing holds paths that collide once case-folded, or where one names a directory of another: {', '.join(colliding)}."
        raise RequestArgumentError(msg)


def _refuse_occupied_destination(destination: Path) -> None:
    """Refuse a destination that exists and is not an empty directory, as `mthds`'s `write_tree` does.

    Raises:
        RequestArgumentError: `destination` exists and is not an empty directory.
    """
    if not destination.exists() and not destination.is_symlink():
        return
    if destination.is_dir() and not destination.is_symlink() and not any(destination.iterdir()):
        return
    msg = (
        f"Cannot write a method tree at '{destination}': it already exists and is not an empty directory, "
        "and a written tree holds nothing but its files."
    )
    raise RequestArgumentError(msg)


def _write_new_file(target: Path, data: bytes) -> None:
    """Write a file that must not exist yet, its directories created first, so no file of the tree is ever written over."""
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as new_file:
        new_file.write(data)


def _make_staging_directory(target: Path) -> Path:
    """Refuse an occupied `target`, then make the fresh hidden directory beside it that a tree is written into before it takes `target`'s name.

    Raises:
        RequestArgumentError: `target` exists and is not an empty directory.
    """
    _refuse_occupied_destination(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / f".{target.name}.{secrets.token_hex(8)}.writing"
    staging.mkdir()
    return staging


def _move_into_place(staging: Path, target: Path) -> None:
    """Give a written tree its name: `target`, an empty directory left there removed first.

    `rmdir` removes only an empty directory, so a file written at `target` meanwhile is never lost: the
    move fails instead.
    """
    if target.is_dir():
        target.rmdir()
    staging.rename(target)


async def _run_to_end_in_thread(func: Callable[..., None], /, *args: object) -> None:
    """Run `func(*args)` in a worker thread, and when the awaiting task is cancelled, let the thread end before the cancellation goes on.

    A thread cannot be stopped, so a task cancelled while it waits would leave the thread running on,
    writing into a directory its caller is about to remove. Awaiting its end first keeps the order.
    """
    running = asyncio.ensure_future(asyncio.to_thread(func, *args))
    try:
        await asyncio.shield(running)
    except asyncio.CancelledError:
        # The thread's own failure no longer matters once the caller is cancelled; its end does.
        await asyncio.wait({running})
        raise


def _method_path(method_id: str, *, call: str) -> str:
    """The path of a method route, `methods/{id}`, for a bare catalog id, its segment refused as `_id_path_segment` refuses one.

    The method routes address the method itself, never one of its versions, and the platform does
    not parse a suffix there: `mt_x@3` would be looked up as an id of its own and answer
    `404 not_found`, which reads as a method that does not exist. So a suffixed id is refused
    before anything is sent, saying how to read what it names. Stripping it instead would answer
    the draft for a caller that named a version. `call` names the method in the message.

    Raises:
        RequestArgumentError: `method_id` is not a `str`, is empty, `.` or `..`, holds a lone surrogate, or carries a version suffix.
    """
    segment = _id_path_segment(method_id, call=call, what=_METHOD_ID_ARGUMENT)
    if "@" in method_id:
        msg = (
            f'"{method_id}" carries a version suffix, and the method routes take a bare catalog id: they address the method '
            "itself, never one of its versions. Strip the suffix with parse_method_selector, and read a published version "
            "with get_method_version."
        )
        raise RequestArgumentError(msg)
    return f"methods/{segment}"


def _method_example_path(method_id: str, example_id: str, *, call: str) -> str:
    """The path of one saved example, `methods/{id}/examples/{example_id}`, for a bare catalog id and an example id.

    Each is refused as `_method_path` and `_id_path_segment` refuse one: an empty example id would address
    the examples list rather than an example, and `..` the method itself. `call` names the method in the
    message.

    Raises:
        RequestArgumentError: `method_id` is refused as `_method_path` refuses it, or `example_id` is not a
            `str`, or is empty, `.` or `..`, or holds a lone surrogate.
    """
    path = _method_path(method_id, call=call)
    return f"{path}/examples/{_id_path_segment(example_id, call=call, what=_EXAMPLE_ID_ARGUMENT)}"


def _artifact_selection(artifacts: Sequence[RunArtifact] | None) -> tuple[RunArtifact, ...] | None:
    """Normalise a results-read selection: `None` reads everything, anything else is deduplicated
    into the enum's declaration order, so the same selection always builds the same query.

    An empty selection names nothing to read, and a name that is no `RunArtifact`, which a caller
    passing plain strings can send, names an artifact the platform does not know; it refuses either
    with a `400`, and both are refused here first, before any request, with `RequestArgumentError`,
    as `@pipelex/sdk` refuses them. Dropping an unknown name instead would send a narrower selection
    than the caller asked for, or an empty one.

    A bare `str`, a single `RunArtifact` member included since a `StrEnum` member is one, is no
    selection: read as a sequence it would name its characters. It raises `TypeError`, a bug in the
    calling code that carries no verdict, as `@pipelex/sdk` throws one for a value that is not an array.

    Raises:
        TypeError: `artifacts` is a bare `str`.
        RequestArgumentError: The selection is empty or names an artifact that is no `RunArtifact`.
    """
    if artifacts is None:
        return None
    if isinstance(artifacts, str):
        msg = f'"artifacts" must be a list or tuple naming one or more of {", ".join(RunArtifact)}.'
        raise TypeError(msg)
    requested = set(artifacts)
    if not requested:
        msg = "An artifact selection must name at least one RunArtifact; pass artifacts=None to read them all."
        raise RequestArgumentError(msg)
    unknown = sorted(f"{name}" for name in requested if name not in _RUN_ARTIFACTS)
    if unknown:
        msg = f"Unknown result artifact(s) {', '.join(unknown)}; valid artifacts are: {', '.join(RunArtifact)}."
        raise RequestArgumentError(msg)
    return tuple(artifact for artifact in RunArtifact if artifact in requested)


def is_gateway_cut_off(exc: BaseException, elapsed_seconds: float) -> bool:
    """Whether a request that failed `elapsed_seconds` after it was sent was cut off by the hosted
    gateway's ~30-second limit on a request it waits on, rather than refused.

    It is when, after at least ~28 seconds, the failure is a `503` or `504` answer (`ApiResponseError`),
    or the client's own time limit on a request that had reached the API (the `ApiUnreachableError` whose
    `code` is `ABORT_TIMEOUT`, httpx's read or write timeout). A fast `503` is the API saying the request
    was not handled, and any other unreachable host, a connect or pool timeout included, never sent the
    request, so it is never the gateway's cut-off, however long it took. Any other exception is not either.
    `@pipelex/sdk`'s `isGatewayCutOff` reads the same failures.

    The blocking `execute` turns such a failure into a `PipelineExecuteTimeoutError`. Whether a failed
    `start` or `execute` may have started a run needs no timing: the error says it as
    `run_may_have_started`, which reads every `503` but the platform's coded one as a run that may have
    started, however quickly it came back.
    """
    if elapsed_seconds < _GATEWAY_TIMEOUT_THRESHOLD_SECONDS:
        return False
    if isinstance(exc, ApiUnreachableError):
        return exc.code == ABORT_TIMEOUT_CODE
    if isinstance(exc, ApiResponseError):
        return exc.status in {503, 504}
    return False


def _execute_timeout_message(elapsed_seconds: float) -> str:
    """The `PipelineExecuteTimeoutError` message — point the caller at the durable start+poll path."""
    seconds = round(elapsed_seconds)
    return (
        f"The Pipelex Hosted API times out synchronous requests after ~30s — this run took {seconds}s. "
        "The blocking execute path can't run methods longer than 30s behind the gateway. "
        "Start the run and poll for its result instead: `start()` then `wait_for_result(run_id)` (or `start_and_wait`)."
    )


# The members that make a 404 an answer rather than an absent route: every problem the platform renders
# carries its `code`, and every problem the runner renders carries its `error_type` — the runner's own
# refusals, relayed by the platform unchanged (a `method_ref` with no package behind it is a 404 of the
# runner's). The same test the platform's relay applies to a runner body.
_ANSWERED_404_MEMBERS: frozenset[str] = frozenset({"code", "error_type"})


def _is_missing_route_404(body: str) -> bool:
    """Whether a 404's body is an unmatched-route 404 (no run store deployed) rather than a 404 the
    platform or the runner answered on purpose.

    The platform renders its 404s (a run not found) as problem documents carrying a stable `code`, and
    the runner renders its own (a `method_ref` whose package does not exist) carrying its `error_type`;
    a bare runner's unmatched route answers Starlette's default `{"detail": "Not Found"}`, which carries
    neither. An empty, non-JSON or non-object body is no answer either. `type` is deliberately not read:
    a generic RFC 9457 renderer puts `type: "about:blank"` on an unmatched route too.
    """
    members = ProblemDocument.make_from_body(body).members
    return members is None or _ANSWERED_404_MEMBERS.isdisjoint(members)


def _parse_retry_after(headers: httpx.Headers) -> int | None:
    """Parse the `Retry-After` header (integer-seconds form, which the platform uses)."""
    raw = headers.get("retry-after")
    if not raw:
        return None
    try:
        seconds = int(raw)
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def _run_result_failed(run_id: str, response: httpx.Response) -> RunResultFailed:
    """Build the failed arm from the results read's `409` problem document.

    The platform's document carries `detail` (`Run finished with status <STATUS>: <message>`, or
    `...; no result available` when the run has no report) and two extension members: `run_status`,
    the run's terminal status — named so because a problem's own `status` is the HTTP status — and
    `error`, the run's stored error report or `null`. The status is read from `run_status`, never
    parsed back out of the sentence. A `409` without that member (the one this route answers for a
    stored result it refuses to read, or one from a platform that predates the member) or with a
    status this SDK does not know reads as `FAILED`, and its `detail` still says what happened.
    """
    document = ProblemDocument.make_from_body(response.text)
    body = document.members or {}
    message = document.server_message or "Run finished without a result."
    raw_status = body.get("run_status")
    status = RunStatus(raw_status) if isinstance(raw_status, str) and raw_status in _KNOWN_RUN_STATUS_NAMES else RunStatus.FAILED
    # `error` is validated by the field's own lenient type (`LenientRunErrorReport`): a report whose
    # known fields do not fit keeps the ones that do, and one that is not a report reads as `None`.
    return RunResultFailed.model_validate({"pipeline_run_id": run_id, "status": status, "message": message, "error": body.get("error")})


def _is_valid_base_url(value: str) -> bool:
    """Whether a base URL is host-only — http/https, no path, query, fragment, or
    embedded credentials (auth travels in the Authorization header, never the URL).
    Endpoints compose as `{base}/v1/{endpoint}`, so a path-prefixed base would double
    the prefix.
    """
    # `urlsplit`, never `urlparse`: `urlparse` moves `;params` out of the path, so
    # `https://api.example.com/;token=…` would pass as host-only and send its token in every request
    # line. Split, the `;…` stays in the path, which the rule refuses, as WHATWG's parser reads it.
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if not parsed.netloc:
        return False
    if parsed.path not in {"", "/"}:
        return False
    if parsed.username or parsed.password:
        return False
    return not parsed.query and not parsed.fragment


# The default port of each scheme a base URL may carry, which a URL shown in a refusal leaves out,
# as the WHATWG URL parser `@pipelex/sdk` reads the value with does.
_DEFAULT_PORTS: dict[str, int] = {"http": 80, "https": 443}


def _describe_refused_base_url(value: str) -> str:
    """A refused base URL as its refusal may show it: the scheme and the host, then the names of the
    parts beyond them that the URL carried, never their text.

    Credentials, a query and a path are exactly where a secret travels in a URL, and the refusal
    reaches logs and, through an app that relays an error's message, a browser. A value that is not
    an http or https URL is not shown at all, since nothing says which of its characters are a
    secret: `localhost:8081`, with no scheme, parses as a URL whose scheme is `localhost`. The
    wording is `@pipelex/sdk`'s `describeRefusedBaseUrl`, word for word, so a refusal reads the same
    from either SDK.
    """
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return "(not shown: it is not an absolute URL)"
    if not parsed.scheme:
        return "(not shown: it is not an absolute URL)"
    if parsed.scheme not in _DEFAULT_PORTS:
        return "(not shown: it is not an http or https URL)"
    if not hostname:
        return "(not shown: it is not an absolute URL)"
    host = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None and port != _DEFAULT_PORTS[parsed.scheme]:
        host = f"{host}:{port}"
    parts: list[str] = []
    if parsed.username or parsed.password:
        parts.append("credentials")
    if parsed.path not in {"", "/"}:
        parts.append("a path")
    if parsed.query:
        parts.append("a query")
    if parsed.fragment:
        parts.append("a fragment")
    shown = f'"{parsed.scheme}://{host}"'
    if not parts:
        return shown
    named = parts[0] if len(parts) == 1 else f"{', '.join(parts[:-1])} and {parts[-1]}"
    return f"{shown} with {named} (not shown)"


def _origin_of(base_url: str) -> str:
    """Derive the origin (`scheme://host[:port]`) from a validated host-only base URL.

    `/health` is served at the origin, not under the `/v1` prefix.
    """
    parsed = urlparse(base_url)
    return f"{parsed.scheme}://{parsed.netloc}"


def _failure_reason(document: ProblemDocument, response: httpx.Response) -> str:
    """The reason a non-2xx answer gives, in the order a person is best served by.

    The problem's `detail`, else its `title`, else the raw body (cut short, since a gateway's HTML
    page can be long), else the status text — the order the `mthds` base client's own message uses,
    kept identical so a refusal reads the same whichever client raised it.
    """
    for candidate in (document.server_message, document.title):
        if candidate and candidate.strip():
            return candidate
    body = response.text.strip()
    if body:
        return body if len(body) <= _REASON_BODY_LIMIT else f"{body[:_REASON_BODY_LIMIT]}…"
    return response.reason_phrase or "no reason given"


# The Pipelex members below are read leniently, like the shared ones `ProblemDocument` reads: an odd
# shape reads as `None` and never masks the underlying failure, which `server_message` and the raw
# `problem` still carry. `validation_errors` items are a closed shape, so the list is narrowed whole; a
# `FieldError` reads each field leniently, so only a non-object item sets `errors` to `None`.
_VALIDATION_ERRORS_ADAPTER: TypeAdapter[list[ValidationErrorItem]] = TypeAdapter(list[ValidationErrorItem])
_FIELD_ERRORS_ADAPTER: TypeAdapter[list[FieldError]] = TypeAdapter(list[FieldError])


def _narrowed_validation_errors(diagnostics: list[ValidationDiagnostic] | None) -> list[ValidationErrorItem] | None:
    """Narrow the protocol's neutral diagnostics to this SDK's `ValidationErrorItem`, or `None`.

    `ProblemDocument` keeps the list only when every item is a diagnostic, and carries the runner's
    locators (`pipe_code`, `field_path`, …) on each item's extras; the narrowing types them. A list
    whose items do not all fit — a category this SDK does not know — reads as `None`, the raw list
    staying on the error's `problem`.
    """
    if diagnostics is None:
        return None
    try:
        return _VALIDATION_ERRORS_ADAPTER.validate_python([diagnostic.model_dump() for diagnostic in diagnostics])
    except ValidationError:
        return None


def _field_errors_of(value: Any) -> list[FieldError] | None:
    """The platform's field-level `errors[]`, or `None` when it is absent or not a list of objects."""
    if not isinstance(value, list):
        return None
    try:
        return _FIELD_ERRORS_ADAPTER.validate_python(value)
    except ValidationError:
        return None


def _non_empty_string_member(members: dict[str, Any], key: str) -> str | None:
    """A non-empty string member of a decoded body, or `None` when it is absent, empty or not a string."""
    value = members.get(key)
    return value if isinstance(value, str) and value else None
