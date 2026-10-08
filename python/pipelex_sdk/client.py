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
from contextvars import ContextVar
from time import monotonic
from typing import TYPE_CHECKING, Any, NoReturn, cast
from urllib.parse import quote, urlencode, urlparse, urlsplit

import httpx
from mthds.protocol.exceptions import PipelineRequestError
from mthds.runners.api.client import MthdsAPIClient
from mthds.runners.api.exceptions import RunStillRunningError as _MthdsRunStillRunningError
from mthds.runners.api.problem import ProblemDocument
from pydantic import BaseModel, TypeAdapter, ValidationError
from pydantic_core import to_json
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
    MthdsFileItem,
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
    MissingMainStuffError,
    PagingNotTerminatingError,
    PipelexRequestError,
    PipelineExecuteTimeoutError,
    RequestArgumentError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunStillRunningError,
    RunTimeoutError,
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
    SubscriptionResponse,
    UploadedFile,
    UserProfile,
)
from pipelex_sdk.runs import (
    PipelexRunResultStart,
    PollInfo,
    RunArtifact,
    RunRead,
    RunResultCompleted,
    RunResultFailed,
    RunResultRunning,
    RunResults,
    RunStatus,
    WaitForResultOptions,
)
from pipelex_sdk.upload import UploadRecord, UploadSource
from pipelex_sdk.upload import upload_file as _upload_file_impl
from pipelex_sdk.user_agent import AppInfo, build_user_agent
from pipelex_sdk.validation_models import PipelexValidationResultAdapter, ValidationErrorItem

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable, Sequence
    from contextlib import AbstractAsyncContextManager
    from pathlib import Path

    from mthds.protocol.models import ValidationDiagnostic, VersionInfo
    from mthds.protocol.pipe_output import VariableMultiplicity
    from mthds.protocol.pipeline_inputs import PipelineInputs
    from mthds.protocol.stuff import StuffType
    from mthds.protocol.working_memory import WorkingMemoryAbstract

    from pipelex_sdk.product_models import (
        MethodDraftInput,
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

# A runaway backstop for both paged-list iterators, set far beyond any real catalog — never a
# coverage cap. Reaching it means the server kept minting cursors, which is a fault to raise on,
# not a limit to truncate at. It is what bounds a cursor that CYCLES (`c1 -> c2 -> c1`) over
# non-empty pages: neither iterator's adjacent-cursor check sees a non-adjacent repeat.
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

# The PIPELEX API's own run args — the layer-2 extension the RUNNER resolves itself
# (`method_ref`, a run source in its own right). A named parameter here, travelling to the
# base client through its generic `extra` passthrough exactly like the hosted args below.
# Reserved on `extra` for the same reason: a smuggled copy would arrive by a second path
# with different validation and bypass the selector-exclusivity checks.
_PIPELEX_API_RUN_ARGS: frozenset[str] = frozenset({"method_ref"})

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
    - **run lifecycle** (`get_run_status` / `get_run_result` / `wait_for_result`) — the
      durable polling extension (added in Phase 2).
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
        """
        timeout = _REQUEST_TIMEOUT_OVERRIDE.get()
        try:
            return await super()._send(method, url, content=content, request_timeout=request_timeout if timeout is None else timeout)
        except (httpx.ReadTimeout, httpx.WriteTimeout) as exc:
            msg = f"Could not reach Pipelex API at {self.base_url} (timeout)"
            raise ApiUnreachableError(msg, api_url=self.base_url, code=ABORT_TIMEOUT_CODE) from exc
        except (httpx.TransportError, httpx.DecodingError) as exc:
            # A body httpx cannot decode, a broken gzip stream for one, is lost on the way as surely as a
            # dropped connection, and `@pipelex/sdk` reports it the same way (`Z_DATA_ERROR`).
            code = type(exc).__name__
            msg = f"Could not reach Pipelex API at {self.base_url} ({code})"
            raise ApiUnreachableError(msg, api_url=self.base_url, code=code) from exc

    async def _request_product(self, method: str, endpoint: str, *, body: object | None = None, request_timeout: float | None = None) -> Any:
        """Issue a Pipelex-product request (`/v1/me`, `/v1/methods`, `/v1/billing/*`, …)
        and parse its JSON body, mapping a non-2xx response to the typed `ApiResponseError`
        so callers branch on the structured `code` discriminant, not the HTTP status.

        Empty-body tolerant — DELETE / onboarding / update routes answer 2xx with no body,
        returned as `None`. Uses the management-call timeout, not the blocking ceiling;
        `request_timeout` overrides it for the crate calls whose `method_ref` closure
        the server may have to fetch first (see `_METHOD_REF_FETCH_TIMEOUT_SECONDS`).
        """
        content = to_json(body) if body is not None else None
        effective_timeout = request_timeout if request_timeout is not None else _POLL_REQUEST_TIMEOUT_SECONDS
        response = await self._send(method, self._url(endpoint), content=content, request_timeout=effective_timeout)
        if not 200 <= response.status_code < 300:
            self._raise_api_response_error(method=method, endpoint=endpoint, response=response)
        if not response.content:
            return None
        return response.json()

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
        verdict from what the server sent and the fallback table.

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
        )

    def _raise_if_lifecycle_unavailable(self, *, status: int, body: str, url: str) -> None:
        """Translate a "route absent" 404 (a bare pipelex-api with no platform block) into a clear
        `RunLifecycleUnavailableError`. A 404 the platform or the runner answered on purpose — a run not
        found, a `method_ref` with no package — carries a problem document (`code` or `error_type`) and is
        left for normal handling as `ApiResponseError`.
        """
        if status != 404:
            return
        if _is_missing_route_404(body):
            msg = (
                f"The durable run lifecycle is not available: {url} returned 404. Run polling is a "
                f"hosted-API extension (/{_API_PREFIX}/{_RUNS}/*), not part of the MTHDS Protocol; "
                "PIPELEX_BASE_URL points at a bare runner that does not serve it."
            )
            raise RunLifecycleUnavailableError(msg, api_url=self.base_url)

    # ── Protocol surface: `execute` override (gateway-timeout translation) ──

    @override
    async def execute(
        self,
        pipe_code: str | None = None,
        mthds_contents: list[str] | None = None,
        inputs: PipelineInputs | WorkingMemoryAbstract[StuffType] | None = None,
        output_name: str | None = None,
        output_multiplicity: VariableMultiplicity | None = None,
        dynamic_output_concept_ref: str | None = None,
        extra: dict[str, Any] | None = None,
        *,
        method_ref: str | None = None,
        method_id: str | None = None,
    ) -> PipelexExecuteResult:
        """Execute a method synchronously and wait for its completion — `POST /v1/execute`.

        Returns a `PipelexExecuteResult` — the protocol's raw execute response enriched with a
        resolved `.main_stuff` accessor, so a blocking result reads its output the same way as a
        durable one (`result.main_stuff`) instead of digging through `pipe_output`. A
        `method_ref` run's result additionally carries `method_provenance` — the address, the
        tag, and the commit SHA that was actually fetched.

        Identical to the inherited protocol `execute`, except for three things. First,
        `method_ref` — the Pipelex API's own run source, resolved by the RUNNER (see below).
        Second, `method_id` — the hosted platform's own run arg (see below). Third, a failure
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
            mthds_contents: List of MTHDS bundle contents to load.
            inputs: Inputs passed to the method.
            output_name: Name of the output slot to write to.
            output_multiplicity: Output multiplicity setting.
            dynamic_output_concept_ref: Override for the dynamic output concept ref.
            extra: Server-specific extension args this client does not know about, merged into
                the request body as top-level properties. Protocol args and this client's own
                named args (`method_ref`, `method_id`) must be passed as named parameters, not
                through `extra` (raises `RequestArgumentError`).
            method_ref: A published method's address —
                `github.com/<owner>/<repo>[/<selector>][@<tag>]` (e.g.
                `github.com/Pipelex/methods/documents@v0.1.0`) — a layer-2 Pipelex-API
                extension the RUNNER resolves (git fetch at the tag, package located by
                manifest identity; pipelex-api >= 0.21.0). A complete run source of its own,
                so it pairs with NOTHING: exclusive with inline `mthds_contents` and with
                `method_id` (an address run has its own provenance and needs no linkage id) —
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
                `method_version` says which ran. Alongside `mthds_contents`, the inline source is
                what RUNS (precedence) and the id is recorded as run-history linkage on the Run
                row — the index key `GET /v1/runs?method_id=` queries, so a run started without it
                is absent from its method's history permanently. The id must be bare there: the
                inline source is what runs, so a suffix would claim a version that did not, and a
                suffixed id is refused client-side, mirroring the platform's `422`. An empty
                string is treated as absent.

        Raises:
            PipelineExecuteTimeoutError: The blocking request hit the hosted gateway's ~30s
                synchronous ceiling — use `start_and_wait` (or `start` + `wait_for_result`).
            RequestArgumentError: Nothing to run was named, `extra` carries a protocol arg or a
                reserved named arg, a selector is present and is not a string, `method_ref` is
                combined with inline `mthds_contents` or with `method_id`, or a suffixed
                `method_id` is combined with inline `mthds_contents`.
            RunStillRunningError: The server answered 202 (the protocol's optional async
                degrade) — the run continues server-side; resume by `pipeline_run_id`.
            ApiResponseError: Any other non-2xx answer — a refusal to run an invalid method (a
                `422`, its diagnostics on `validation_errors`), a failed run, auth, a server fault.
            ApiUnreachableError: No answer came back (DNS / connect / TLS), or a client-side
                timeout came before the ~28s the gateway translation waits for.
        """
        merged_extra = _merge_run_extensions(extra, method_ref=method_ref, method_id=method_id)
        _assert_method_ref_pairs_with_nothing(mthds_contents=mthds_contents, merged_extra=merged_extra)
        _assert_linkage_method_id_is_bare(mthds_contents=mthds_contents, merged_extra=merged_extra)
        started_at = monotonic()
        try:
            result = await super().execute(
                pipe_code=pipe_code,
                mthds_contents=mthds_contents,
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
        # the `main_stuff_name` extension + working memory ride `model_extra`/`pipe_output`).
        return PipelexExecuteResult.model_validate(result.model_dump())

    # ── Protocol surface: `start` override (bare-runner 404 → typed error) ──

    @override
    async def start(
        self,
        pipe_code: str | None = None,
        mthds_contents: list[str] | None = None,
        inputs: PipelineInputs | WorkingMemoryAbstract[StuffType] | None = None,
        output_name: str | None = None,
        output_multiplicity: VariableMultiplicity | None = None,
        dynamic_output_concept_ref: str | None = None,
        extra: dict[str, Any] | None = None,
        *,
        method_ref: str | None = None,
        method_id: str | None = None,
    ) -> PipelexRunResultStart:
        """Start a method asynchronously — `POST /v1/start` (202: `pipeline_run_id` only).

        Identical to the inherited protocol `start`, except for the two method selectors —
        `method_ref` (the Pipelex API's own run source, resolved by the runner) and
        `method_id` (the hosted platform's own run arg), both documented on `execute` and
        carrying the same semantics and exclusivity here — and that a bare-runner
        missing-route 404 (no run store) is translated into a clear
        `RunLifecycleUnavailableError`, matching the JS SDK and letting `start_and_wait`
        self-heal to the blocking-execute fallback. Every other non-2xx — the platform's
        structured 404s included — raises `ApiResponseError`.

        Returns:
            The 202 ack as `PipelexRunResultStart` — the authoritative `pipeline_run_id`,
            plus `method_provenance` (`{address, tag, commit_sha}`) for a `method_ref` run
            (the server fetches the package before the ack, so provenance rides the 202);
            `None` otherwise.

        Raises:
            RequestArgumentError: Nothing to run was named, `extra` carries a protocol arg or a
                reserved named arg, a selector is present and is not a string, `method_ref` is
                combined with inline `mthds_contents` or with `method_id`, or a suffixed
                `method_id` is combined with inline `mthds_contents`.
            RunLifecycleUnavailableError: The configured server has no run store.
            ApiResponseError: Any other non-2xx answer — a refusal to run an invalid method (a
                `422`, its diagnostics on `validation_errors`), auth, a server fault.
            ApiUnreachableError: No answer came back (DNS / connect / TLS / timeout).
        """
        merged_extra = _merge_run_extensions(extra, method_ref=method_ref, method_id=method_id)
        _assert_method_ref_pairs_with_nothing(mthds_contents=mthds_contents, merged_extra=merged_extra)
        _assert_linkage_method_id_is_bare(mthds_contents=mthds_contents, merged_extra=merged_extra)
        token = _REQUEST_TIMEOUT_OVERRIDE.set(_start_request_timeout_seconds(self.request_timeout_seconds, merged_extra, mthds_contents))
        try:
            result = await super().start(
                pipe_code=pipe_code,
                mthds_contents=mthds_contents,
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
        finally:
            _REQUEST_TIMEOUT_OVERRIDE.reset(token)
        # Re-validate the base ack into the Pipelex-branded subtype (types `method_provenance`;
        # any other implementation extra keeps riding `model_extra`).
        return PipelexRunResultStart.model_validate(result.model_dump())

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

        if mthds_contents:
            extra: dict[str, Any] = {"render": _with_validate_markdown_render(render)}
            if mthds_sources is not None:
                extra["mthds_sources"] = mthds_sources
            if views is not None:
                extra["views"] = views
            # Reuse the inherited transport seam (`_post_validate`) for body-building + the wire
            # call, then parse the 200-diagnostic body into this SDK's Pipelex-branded narrowing.
            # The base's own `validate` parses the same body into the neutral `ValidationResult`.
            response = await self._post_validate(mthds_contents, allow_signatures, extra)
            return PipelexValidationResultAdapter.validate_python(response.json())

        # A selector validation must NOT carry the `mthds_contents` key at all (the server XORs
        # on presence, and an empty list is a request-shape 422), so the body is built here
        # rather than through `_post_validate`, on the same inherited `_send` transport seam.
        body: dict[str, Any] = {"allow_signatures": allow_signatures, "render": _with_validate_markdown_render(render)}
        if views is not None:
            body["views"] = views
        if selected_method_ref is not None:
            body["method_ref"] = selected_method_ref
        if selected_method_id is not None:
            body["method_id"] = selected_method_id
        response = await self._send("POST", self._url("validate"), content=to_json(body), request_timeout=self.request_timeout_seconds)
        if not response.is_success:
            self._raise_api_response_error(method="POST", endpoint="validate", response=response)
        return PipelexValidationResultAdapter.validate_python(response.json())

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
    # These four methods are OWNED by this SDK and return this package's own `runs`
    # types (a Pipelex-branded surface). The protocol base `MthdsAPIClient` is
    # protocol-only — it declares no run lifecycle — so these are plain methods, not
    # overrides (no `@override`, no override suppressions).

    async def get_run_status(self, run_id: str) -> RunRead:
        """Fetch a run's status by bare id — `GET /v1/runs/{run_id}/status`.

        Self-healing: a finished-but-unrecorded run resolves to its true terminal status on read.
        `degraded=True` means Temporal was unreachable and `status` is the last-known value;
        `retry_after_seconds` carries the server's `Retry-After` hint when present.

        Raises:
            RunLifecycleUnavailableError: If the lifecycle routes are absent (a bare runner).
            ApiUnreachableError: If the host cannot be reached (DNS / connect / TLS / timeout).
            ApiResponseError: For a genuine run-not-found 404 or any other non-2xx response.
        """
        endpoint = f"{_RUNS}/{quote(run_id, safe='')}/status"
        url = self._url(endpoint)
        response = await self._send("GET", url, content=None, request_timeout=_POLL_REQUEST_TIMEOUT_SECONDS)
        self._raise_if_lifecycle_unavailable(status=response.status_code, body=response.text, url=url)
        if not response.is_success:
            self._raise_api_response_error(method="GET", endpoint=endpoint, response=response)
        run = RunRead.model_validate(response.json())
        retry_after = _parse_retry_after(response.headers)
        if retry_after is not None:
            run = run.model_copy(update={"retry_after_seconds": retry_after})
        return run

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
            RequestArgumentError: If `artifacts` is an empty selection, which names nothing to read.
            MissingMainStuffError: If a completed run asked for its main stuff delivers none.
            RunLifecycleUnavailableError: If the lifecycle routes are absent (a bare runner).
            ApiUnreachableError: If the host cannot be reached (DNS / connect / TLS / timeout).
            ApiResponseError: For a genuine run-not-found 404 or any other non-2xx response
                (an artifact name the platform does not know is its `400`).
        """
        selection = _artifact_selection(artifacts)
        endpoint = f"{_RUNS}/{quote(run_id, safe='')}/results"
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
        # A completed run asked for its main stuff must deliver one. `.get(...) is None` covers both the
        # missing-key and explicit-null cases for the same un-deliverable-output condition (a
        # present-but-falsy main stuff — `[]`, `0` — stays). A selection that left `main_stuff` out
        # asked for none, so its absence there is the answer, not a fault.
        payload = response.json()
        wants_main_stuff = selection is None or RunArtifact.MAIN_STUFF in selection
        if wants_main_stuff and isinstance(payload, dict) and cast("dict[str, Any]", payload).get("main_stuff") is None:
            msg = f"Completed run '{run_id}' returned no main stuff — a completed run always delivers a main stuff."
            raise MissingMainStuffError(msg, run_id=run_id)
        result = RunResults.model_validate(payload)
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
        """
        # Refused before the first poll, so an empty selection never waits out a timeout to fail.
        _artifact_selection(artifacts)
        opts = options or WaitForResultOptions()
        started_at = monotonic()
        attempt = 0

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

            # state is RunResultRunning — decide whether to keep waiting.
            attempt += 1
            elapsed = monotonic() - started_at
            if elapsed >= opts.timeout_seconds:
                raise RunTimeoutError(_timeout_message(run_id, opts.timeout_seconds), run_id=run_id, timeout_seconds=opts.timeout_seconds)
            if opts.on_poll is not None:
                opts.on_poll(PollInfo(attempt=attempt, elapsed_seconds=elapsed))

            retry_seconds = state.retry_after_seconds if state.retry_after_seconds is not None else 0
            wait_seconds = min(max(opts.interval_seconds, retry_seconds), opts.timeout_seconds - elapsed)
            await asyncio.sleep(wait_seconds)

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
            ApiResponseError: If the server answers non-2xx.
            ApiUnreachableError: No answer came back.
        """
        token = _REQUEST_TIMEOUT_OVERRIDE.set(_quick_request_timeout_seconds(self.request_timeout_seconds))
        try:
            return await super().version()
        finally:
            _REQUEST_TIMEOUT_OVERRIDE.reset(token)

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
            # JSON or not UTF-8, or JSON that does not validate as one. Assume hosted.
            except (ApiResponseError, ValidationError, json.JSONDecodeError, UnicodeDecodeError):
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
        mthds_contents: list[str] | None = None,
        inputs: PipelineInputs | WorkingMemoryAbstract[StuffType] | None = None,
        output_name: str | None = None,
        output_multiplicity: VariableMultiplicity | None = None,
        dynamic_output_concept_ref: str | None = None,
        extra: dict[str, Any] | None = None,
        wait_options: WaitForResultOptions | None = None,
        *,
        method_ref: str | None = None,
        method_id: str | None = None,
        artifacts: Sequence[RunArtifact] | None = None,
        on_started: Callable[[PipelexRunResultStart], None] | None = None,
        on_starting: Callable[[], None] | None = None,
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

        The method selectors — `method_ref` and `method_id`, documented on `execute` — are
        forwarded on BOTH paths: a `method_ref` run must run the same fetched package on the
        blocking fallback, and dropping `method_id` there would turn a server-side 422 that
        names the key into a silently different run.

        `artifacts` narrows the hosted results read, as on `get_run_result`. The blocking path
        ignores it: the execute response already holds every artifact, so there is nothing to save
        by narrowing it, and the result it returns answers for every field.

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

        Raises:
            RunFailedError: If the run reaches a terminal status other than COMPLETED.
            RunTimeoutError: If the poll budget elapses (the run keeps executing — resume by id).
            ApiUnreachableError: If no answer came back from the start, the blocking execute or
                a poll (DNS / connect / TLS / timeout).
        """
        # Refused before anything starts, so an empty selection never costs a run.
        _artifact_selection(artifacts)
        if await self._supports_run_lifecycle():
            # A cancellation that landed while the handshake's answer was read stops here, before
            # the start is sent, rather than at the start's own first wait.
            await asyncio.sleep(0)
            try:
                if on_starting is not None:
                    on_starting()
                started = await self.start(
                    pipe_code=pipe_code,
                    mthds_contents=mthds_contents,
                    inputs=inputs,
                    output_name=output_name,
                    output_multiplicity=output_multiplicity,
                    dynamic_output_concept_ref=dynamic_output_concept_ref,
                    extra=extra,
                    method_ref=method_ref,
                    method_id=method_id,
                )
            except RunLifecycleUnavailableError:
                self._lifecycle_available = False
                await asyncio.sleep(0)
                if on_starting is not None:
                    on_starting()
                return await self._execute_blocking(
                    pipe_code=pipe_code,
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
        """
        result = await self.execute(
            pipe_code=pipe_code,
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
        return UserProfile.model_validate(await self._request_product("GET", "me"))

    async def list_methods(self, *, q: str | None = None, limit: int | None = None, cursor: str | None = None) -> MethodPage:
        """List one page of the caller's saved methods — `GET /v1/methods`.

        Args:
            q: Server-side case-insensitive substring match over name and description,
                applied across the whole catalog rather than within the returned page.
            limit: Page size. The API supplies the default and caps the maximum.
            cursor: The `next_cursor` of the previous page, passed back opaquely.

        Returns:
            A `MethodPage` of `MethodSummary` rows, ordered by creation, newest first.
            `next_cursor` is `None` on the last page. For the whole catalog, prefer
            `iterate_methods`, which follows the cursors and cannot truncate.
        """
        query = _product_query({"q": q, "limit": limit, "cursor": cursor})
        return MethodPage.model_validate(await self._request_product("GET", f"methods{query}"))

    async def iterate_methods(self, *, q: str | None = None, limit: int | None = None) -> AsyncIterator[MethodSummary]:
        """Yield every saved method, following the cursors — `GET /v1/methods`.

        There is deliberately no `list_all_methods()`: an all-at-once helper needs a cap, and
        a cap is the silent truncation paging was introduced to remove.

        The loop keeps going **through an empty page that carries a live cursor**, because `q`
        is a post-read filter over a bounded index slice per request, so `{items: [], next_cursor: "…"}`
        means "keep going", not "done". It stops when `next_cursor` is `None`, and also when the
        server hands back the cursor it was just sent — checked *before* yielding, so a stuck
        cursor never double-counts a page.

        Raises:
            PagingNotTerminatingError: If the server never stops handing out cursors.
        """
        cursor: str | None = None
        pages_seen = 0
        while True:
            page = await self.list_methods(q=q, limit=limit, cursor=cursor)
            if cursor is not None and page.next_cursor == cursor:
                # The server did not advance. Stop before yielding, or this page is counted twice.
                return
            for method_summary in page.items:
                yield method_summary
            if page.next_cursor is None:
                return
            pages_seen += 1
            if pages_seen >= _MAX_LIST_PAGES:
                msg = f"Method paging did not terminate after {_MAX_LIST_PAGES} pages; this is a server-side fault, not a coverage limit."
                raise PagingNotTerminatingError(msg, _MAX_LIST_PAGES)
            cursor = page.next_cursor

    async def get_method(self, method_id: str) -> MethodData:
        """Read one method — `GET /v1/methods/{id}`.

        Its identity, its draft (`mthds`, `python`, `input_data`) with the draft's token
        (`updated_at`) and digest (`draft_digest`), and its latest published version's summary
        (`latest_version`, `latest_published`), whatever the publish state: a method never
        published reads with both `None`, never as an error.

        Takes a bare catalog id: the method routes address the method itself, never a version of
        it. A caller holding `mt_…@3` strips the suffix with
        `pipelex_sdk.method_selector.parse_method_selector` and reads that version with
        `get_method_version`. Every method route raises `RequestArgumentError` for a suffixed id,
        before any request, rather than read back the `404` the platform would answer.
        """
        return MethodData.model_validate(await self._request_product("GET", _method_path(method_id)))

    async def create_method(self, write_input: MethodWriteInput) -> MethodData:
        """Create a method — `POST /v1/methods`.

        The new method holds the input as its draft and has no published version, so its bare id
        answers `409 method_not_published` on the run and tooling routes until its first
        `publish_method`; its draft runs as `mt_…@draft` at once.

        Raises:
            ApiResponseError: `413` `payload_too_large` for a method that would leave no room for a
                publish, measured as a draft write is; `422` `validation_failed` for Python files no
                run could import or for text holding a lone surrogate.
        """
        body = write_input.model_dump(mode="json", exclude_none=True)
        return MethodData.model_validate(await self._request_product("POST", "methods", body=body))

    async def write_draft(self, method_id: str, draft: MethodDraftInput) -> MethodData:
        """Replace a method's draft — `PUT /v1/methods/{id}/draft`.

        The draft is never validated on write, and writing it changes nothing for the callers of the
        method's bare id, who run the latest published version until the next `publish_method`.
        The body is the fields `draft` SET, so a field left unset keeps the stored value, and an
        explicit `input_data=None` clears the form inputs (see `MethodDraftInput`). With
        `expected_updated_at`, the write is a compare-and-swap on the draft token: a draft that
        moved since is refused, and nothing is written. Without it, last writer wins.

        Args:
            method_id: The method's bare catalog id.
            draft: The draft to write.

        Returns:
            The method, with the draft's new token (`updated_at`) and digest (`draft_digest`).

        Raises:
            ApiResponseError: `409` `method_update_conflict` for a draft that moved since the token;
                `404` `not_found` for an unknown or foreign-org method; `409` `method_being_deleted`
                while its erasure runs; `413` `payload_too_large` for a draft that would grow the
                method past the room a publish needs, which keeps a draft that saves publishable;
                `422` `validation_failed` for Python files no run could import or for text holding a
                lone surrogate; `403` for a read-only key; a `503` that wrote nothing, safe to retry,
                when the method kept changing under the write.
        """
        body = draft.model_dump(mode="json", exclude_unset=True)
        return MethodData.model_validate(await self._request_product("PUT", f"{_method_path(method_id)}/draft", body=body))

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
        return MethodData.model_validate(await self._request_product("PATCH", _method_path(method_id), body={"name": name}))

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
        answer = await self._request_product("POST", f"{_method_path(method_id)}/publish", body=body)
        return MethodPublishResultAdapter.validate_python(answer)

    async def list_method_versions(self, method_id: str, *, limit: int | None = None, cursor: str | None = None) -> MethodVersionPage:
        """List one page of a method's published versions, newest first — `GET /v1/methods/{id}/versions`.

        Args:
            method_id: The method's bare catalog id.
            limit: Page size, from 1 to 100; the API defaults to 20 and refuses a `limit` outside
                that range with a `422`.
            cursor: The `next_cursor` of the previous page, passed back opaquely.

        Returns:
            A `MethodVersionPage` of `MethodVersionSummary` rows, without their sources. `next_cursor`
            is `None` on the last page; a page may be short while it is set, because the platform
            reads versions whole. A method never published answers an empty page.

        Raises:
            ApiResponseError: `404` `not_found` for an unknown method; `409` `method_being_deleted`;
                `400` `malformed_request` for a cursor the listing did not issue for this method;
                `422` for a `limit` outside 1 to 100.
        """
        query = _product_query({"limit": limit, "cursor": cursor})
        return MethodVersionPage.model_validate(await self._request_product("GET", f"{_method_path(method_id)}/versions{query}"))

    async def get_method_version(self, method_id: str, version: int) -> MethodVersion:
        """Read one published version of a method, with its sources — `GET /v1/methods/{id}/versions/{n}`.

        Its `python` is converted into `MethodFile` entries as a method's is.

        Args:
            method_id: The method's bare catalog id.
            version: The version number, a positive integer.

        Raises:
            RequestArgumentError: `version` is not a positive integer — a `bool`, a `float` such as
                `2.0`, a numeric string and anything else that is not an `int` included; nothing is sent.
            ApiResponseError: `404` `method_version_not_found` for a version the method never
                published; `404` `not_found` for an unknown method; `409` `method_being_deleted`.
        """
        # Checked as an `object`: the annotation is a promise to the type checker, not to a caller
        # forwarding a float or a CLI argument, and only an `int` puts a version number in the path.
        candidate = cast("object", version)
        if isinstance(candidate, bool) or not isinstance(candidate, int) or candidate < 1:
            msg = f"get_method_version() takes a version number, a positive integer; got {version!r}."
            raise RequestArgumentError(msg)
        return MethodVersion.model_validate(await self._request_product("GET", f"{_method_path(method_id)}/versions/{version}"))

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
        return MethodDeletionAccepted.model_validate(await self._request_product("DELETE", _method_path(method_id)))

    async def list_memberships(self) -> MembershipsResponse:
        """The caller's org memberships + active-org feature flags — `GET /v1/organizations/memberships`."""
        return MembershipsResponse.model_validate(await self._request_product("GET", "organizations/memberships"))

    async def create_organization(self, name: str) -> Membership:
        """Create an organization — `POST /v1/organizations`."""
        return Membership.model_validate(await self._request_product("POST", "organizations", body={"name": name}))

    async def rename_organization(self, org_id: str, name: str) -> Membership:
        """Rename an organization — `PATCH /v1/organizations/{org_id}`."""
        return Membership.model_validate(await self._request_product("PATCH", f"organizations/{quote(org_id, safe='')}", body={"name": name}))

    async def get_subscription(self) -> SubscriptionResponse:
        """The active org's subscription state — `GET /v1/billing/subscription`."""
        return SubscriptionResponse.model_validate(await self._request_product("GET", "billing/subscription"))

    async def list_plans(self) -> list[PlanView]:
        """Available plans (with `is_current`) — `GET /v1/billing/plans`."""
        result = await self._request_product("GET", "billing/plans")
        return [PlanView.model_validate(item) for item in result]

    async def list_invoices(self) -> list[InvoiceView]:
        """Past invoices — `GET /v1/billing/invoices`."""
        result = await self._request_product("GET", "billing/invoices")
        return [InvoiceView.model_validate(item) for item in result]

    async def create_checkout(self, plan: str) -> CheckoutResponse:
        """Open a Stripe checkout for a plan — `POST /v1/billing/checkout`."""
        return CheckoutResponse.model_validate(await self._request_product("POST", "billing/checkout", body={"plan": plan}))

    async def change_plan(self, plan: str) -> ChangePlanResponse:
        """Switch the existing subscription's plan — `POST /v1/billing/change-plan`.

        A 409 `conflict` (`ApiResponseError.code`) means there is no subscription to change —
        start one via `create_checkout` first.
        """
        return ChangePlanResponse.model_validate(await self._request_product("POST", "billing/change-plan", body={"plan": plan}))

    async def get_billing_portal(self) -> BillingPortalResponse:
        """A Stripe billing-portal session URL — `GET /v1/billing/portal`.

        A 409 `conflict` (`ApiResponseError.code`) means there is no subscription yet.
        """
        return BillingPortalResponse.model_validate(await self._request_product("GET", "billing/portal"))

    async def list_pipelex_api_keys(self) -> PipelexApiKeyList:
        """List the caller's Pipelex API keys — `GET /v1/pipelex-api-keys`."""
        return PipelexApiKeyList.model_validate(await self._request_product("GET", "pipelex-api-keys"))

    async def create_pipelex_api_key(self, label: str) -> PipelexApiKeyCreated:
        """Mint a Pipelex API key — `POST /v1/pipelex-api-keys`.

        The plaintext `api_key` is returned ONCE. A 409 `pipelex_api_key_limit_reached`
        (`ApiResponseError.code`) means the per-account key limit is hit.
        """
        return PipelexApiKeyCreated.model_validate(await self._request_product("POST", "pipelex-api-keys", body={"label": label}))

    async def revoke_pipelex_api_key(self, key_id: str) -> None:
        """Revoke a Pipelex API key — `DELETE /v1/pipelex-api-keys/{id}` (empty body)."""
        await self._request_product("DELETE", f"pipelex-api-keys/{quote(key_id, safe='')}")

    async def rotate_pipelex_api_key(self, key_id: str) -> PipelexApiKeyCreated:
        """Rotate a Pipelex API key — `POST /v1/pipelex-api-keys/{id}/rotate` (no body).

        Returns the new plaintext `api_key` once; the old key stops working.
        """
        return PipelexApiKeyCreated.model_validate(await self._request_product("POST", f"pipelex-api-keys/{quote(key_id, safe='')}/rotate"))

    async def submit_onboarding(self, submission: OnboardingSubmission) -> None:
        """Submit the onboarding questionnaire — `POST /v1/onboarding/submit` (empty body)."""
        body = submission.model_dump(mode="json", exclude_none=True)
        await self._request_product("POST", "onboarding/submit", body=body)

    async def resolve_storage_url(self, uri: str) -> ResolvedStorageUrl:
        """Resolve a storage URI to a presigned URL — `POST /v1/resolve-storage-url`."""
        return ResolvedStorageUrl.model_validate(await self._request_product("POST", "resolve-storage-url", body={"uri": uri}))

    async def resolve_storage_urls_bulk(self, uris: list[str]) -> BulkResolvedStorageUrls:
        """Resolve a list of storage URIs in one request — `POST /v1/resolve-storage-url/bulk`.

        The single route applied to a list. One item per reference, in request order, duplicates
        included; a refused reference is a value on its item (`error`), and the request is a `200`
        whenever every reference got a verdict. At most `BULK_RESOLVE_MAX_URIS` references per call
        (a longer list is a `422`) — `resolve_artifacts` chunks a longer set. Served by the hosted
        platform only: a deployment without the route answers a `404` `ApiResponseError`.
        """
        return BulkResolvedStorageUrls.model_validate(await self._request_product("POST", "resolve-storage-url/bulk", body={"uris": uris}))

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
        return UploadedFile.model_validate(await self._request_product("POST", "upload", body=body))

    # ── Crate extensions (Pipelex API — `/v1/resolve`, `/v1/codegen`, `/v1/pipe-io`) ─────
    #
    # The second crate-family surface, mirroring the JS SDK: `/v1/resolve` emits the
    # normalized library crate, `/v1/codegen` projects that crate into stamped typed
    # artifacts plus their lock, and `/v1/pipe-io` returns a method's three I/O artifacts
    # with no dry run. Same envelope family and same 200-verdict discipline as the build
    # routes, PLUS the hosted `method_id` selector under the tooling routes' strict
    # three-way XOR (see `crate_models`).

    async def resolve(self, request: ResolveRequest) -> ResolveResponse:
        """Resolve a closure into its normalized library crate — `POST /v1/resolve`.

        The closure is loaded and statically validated, then emitted as the normalized
        library crate (fully qualified refs, refinement flattened, natives materialized,
        fingerprint set) — the MTHDS standard's Library Crate Format. It runs NO dry-run
        sweep, so a valid verdict here says the library resolves, never that it runs; that
        is `validate`'s vocabulary.

        The closure arrives in exactly one of three forms — inline `files`, an address-form
        `method_ref` (server-resolved; registry form `501`), or a hosted `method_id`
        (platform-resolved) — enforced at request construction and by the server alike.

        Returns a 200 verdict: branch on `is_valid` before reading the arm. A no-verdict
        condition (a malformed selector, a selector-resolution failure — fetch failure, no
        package at the address, an unknown or foreign-org id — auth, a server fault) raises
        `ApiResponseError`, never an `is_valid: false` verdict.
        """
        body = request.model_dump(mode="json", exclude_none=True)
        raw = await self._request_product("POST", "resolve", body=body, request_timeout=_crate_request_timeout_seconds(request.method_ref))
        return ResolveResponseAdapter.validate_python(raw)

    async def codegen(self, request: CodegenRequest) -> CodegenResponse:
        """Project a closure's crate into stamped typed artifacts — `POST /v1/codegen`.

        Resolves the closure exactly like `resolve`, then projects the crate through the two
        explicit axes — `kind` (`types` today) x `target` (`python-pydantic` for Python
        consumers, `python-structures`, `ts-zod`) — and returns the artifact set plus its
        `codegen.lock`. Write both verbatim and the tree is byte-identical to a local
        `pipelex codegen types` run, so the offline `pipelex codegen check` passes on it;
        `pipelex_sdk.codegen_writer.write_codegen_tree` does exactly that.

        Same 200-verdict discipline and same three-form closure selector as `resolve`. A
        no-verdict condition (an unknown `kind`/`target`, a `pipe_ref` on the
        concept-set-wide `types` kind, a malformed selector, a selector-resolution failure)
        raises `ApiResponseError`; a registry-form `method_ref` is a `501`.
        """
        body = request.model_dump(mode="json", exclude_none=True)
        raw = await self._request_product("POST", "codegen", body=body, request_timeout=_crate_request_timeout_seconds(request.method_ref))
        return CodegenResponseAdapter.validate_python(raw)

    async def pipe_io(self, request: PipeIORequest) -> PipeIOResponse:
        """Read a method's I/O artifacts without validating it — `POST /v1/pipe-io`.

        The closure resolves through the same static core as `resolve`, one pipe is selected,
        and the valid arm carries that pipe's `pipe_io_contracts`, `input_form` and
        `output_form` (the standard's artifacts, typed from `mthds.protocol`), beside the
        resolved qualified `pipe_ref`, the method's own `default_pipe_ref`, its
        `pending_signatures` and `is_runnable`. `all_pipes=True` keys the three maps by every
        pipe the closure loads instead; `include_files=True` echoes the closure's `.mthds`
        files. It runs NO dry-run sweep, so it costs one load where `validate` dry-runs every
        pipe, and a valid verdict never says the method runs.

        Same three-form closure selector as `resolve`, enforced at request construction and by
        the server alike. The pipe is selected by the request's `pipe_ref`, else a fetched
        package manifest's `main_pipe`, else the closure's single `main_pipe` declaration.

        Returns a 200 verdict: branch on `is_valid` before reading the arm. A no-verdict
        condition raises `ApiResponseError`: a refused selection (an unknown ref, or no
        `pipe_ref` and a chain that finds no entry pipe or several, without `all_pipes`) is a
        `422` whose `error_type` is `EntryPipeNotFoundError` or `EntryPipeAmbiguousError`
        (pipelex-api >= 0.33.1); a malformed request is a request-shape `422`; the
        `method_ref` fetch failures and the `method_id`
        resolution failures are those of `resolve`; an artifact the server cannot derive is a
        `500`.
        """
        # `all_pipes` and `include_files` default to False on the server too, so a flag left at its
        # default is not sent, as `@pipelex/sdk` sends it: the two SDKs put the same body on the wire.
        body = request.model_dump(mode="json", exclude_none=True, exclude_defaults=True)
        raw = await self._request_product("POST", "pipe-io", body=body, request_timeout=_crate_request_timeout_seconds(request.method_ref))
        return PipeIOResponseAdapter.validate_python(raw)

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
        raw = await self._request_product("GET", f"models/check?{urlencode(query)}")
        return ModelReferenceVerdictAdapter.validate_python(raw)

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
        files: list[MthdsFileItem] | None = None,
        method_ref: str | None = None,
        method_id: str | None = None,
        pipe_ref: str | None = None,
        inputs: dict[str, Any],
    ) -> PreparedInputs:
        """Prepare a pipe's inputs — resolve the declared signature, upload the file-bearing
        assets, and return copy-on-write rewritten inputs (canonical content carrying
        `pipelex-storage://` in `url`) plus one upload record per prepared asset. HTTP(S) URLs
        and existing `pipelex-storage://` URIs pass through unchanged; all failures are raised
        before any run is created.

        The method is named exactly one of three ways — inline `files`, a `method_ref` address
        (runner-resolved) or a stored `method_id` (platform-resolved) — all server-resolved,
        with nothing expanded client-side. An empty selector is treated as absent. The
        signature comes from one `POST /v1/pipe-io` (see `pipe_io`), which selects the pipe
        and returns its input-form descriptor, so the walk is guided by each input's DECLARED
        kind rather than by the shape of its value.

        `pipe_ref` is qualified-only (`domain.pipe_code`); omit it and the server selects the
        method's entry pipe. A refused selection raises `InputPreparationError` with the
        server's reason. See `docs/input-preparation.md`.
        """
        return await _prepare_inputs_impl(
            self,
            files=files,
            method_ref=method_ref,
            method_id=method_id,
            pipe_ref=pipe_ref,
            inputs=inputs,
        )

    async def list_runs(
        self,
        method_id: str,
        *,
        created_from: str | None = None,
        created_to: str | None = None,
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
            limit: Page size. The API supplies the default and caps the maximum.
            cursor: The `next_cursor` of the previous page, passed back opaquely.

        Returns:
            A `RunPage` of `RunHistoryItem` rows — what a history row shows, nothing more. Open
            one run with `get_run_detail` for the whole record. For the whole history, prefer
            `iterate_runs`.

        Raises:
            ApiResponseError: On any non-2xx. Note that every `/v1/runs*` product route sits
                behind the platform's surface-access gate, which for API-key auth demands the
                `ff_api_keys` feature flag and fails closed — so a `403` here means "flag", not
                "wrong key".
        """
        query = _product_query({"method_id": method_id, "created_from": created_from, "created_to": created_to, "limit": limit, "cursor": cursor})
        return RunPage.model_validate(await self._request_product("GET", f"{_RUNS}{query}"))

    async def iterate_runs(
        self,
        method_id: str,
        *,
        created_from: str | None = None,
        created_to: str | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[RunHistoryItem]:
        """Yield every run of a method, following the cursors — `GET /v1/runs`.

        The same loop as `iterate_methods` with one deliberate difference: an **empty page ends
        it**. The date bounds are index key conditions rather than a post-read filter, so a run
        page is never empty-with-a-cursor. The difference is in the server, not in the client.

        The page ceiling applies here too. The empty-page stop only catches a server minting
        fresh cursors while returning *nothing*; a cursor that cycles across two or more values
        while every page is non-empty (`c1 → c2 → c1`) trips neither that check nor the
        adjacent-cursor one, and would loop forever re-yielding the same runs. The ceiling is
        the cheap guard against the whole family — tracking every cursor seen would cost
        unbounded memory for the same protection.

        Takes a bare catalog id, as `list_runs` does.

        Raises:
            PagingNotTerminatingError: If the server never stops handing out cursors.
        """
        cursor: str | None = None
        pages_seen = 0
        while True:
            page = await self.list_runs(method_id, created_from=created_from, created_to=created_to, limit=limit, cursor=cursor)
            if cursor is not None and page.next_cursor == cursor:
                # The server did not advance. Stop before yielding, or this page is counted twice.
                return
            if not page.items:
                return
            for pipeline_run in page.items:
                yield pipeline_run
            if page.next_cursor is None:
                return
            pages_seen += 1
            if pages_seen >= _MAX_LIST_PAGES:
                msg = f"Run paging did not terminate after {_MAX_LIST_PAGES} pages; this is a server-side fault, not a coverage limit."
                raise PagingNotTerminatingError(msg, _MAX_LIST_PAGES)
            cursor = page.next_cursor

    async def get_run_detail(self, run_id: str) -> RunDetail:
        """Fetch one run record with what it executed — `GET /v1/runs/{id}`.

        Distinct from the two lifecycle reads: `get_run_status` polls `/status`, `get_run_result`
        fetches `/results`. This is the catalog-style record, and the only read that carries
        `mthds_contents` and `inputs`.
        """
        return RunDetail.model_validate(await self._request_product("GET", f"{_RUNS}/{quote(run_id, safe='')}"))

    async def update_run(self, run_id: str, update_input: UpdateRunInput) -> None:
        """Patch a run's status (admin/manual) — `PUT /v1/runs/{id}` (empty body)."""
        body = update_input.model_dump(mode="json", exclude_none=True)
        await self._request_product("PUT", f"{_RUNS}/{quote(run_id, safe='')}", body=body)

    # ── Health ─────────────────────────────────────────────────────────────
    #
    # The origin-level liveness probe. `/health` is served at the origin, NOT under the
    # `/v1` prefix, and is out-of-protocol — the MTHDS Protocol defines no health route.
    # It rides the same transport and the same error as every route, as `@pipelex/sdk`'s does.

    async def health(self) -> dict[str, Any]:
        """Origin-level liveness probe — `GET {origin}/health` (NOT under the `/v1` prefix).

        Raises:
            ApiResponseError: The origin answered non-2xx; the message names `/health`, and the verdict
                is the fallback's reading of the status, since the probe answers no problem document.
            ApiUnreachableError: No answer came back (DNS / connect / TLS / timeout).
        """
        url = f"{self.origin_url}/health"
        response = await self._send("GET", url, content=None, request_timeout=_POLL_REQUEST_TIMEOUT_SECONDS)
        if not response.is_success:
            raise self._api_response_error(method="GET", path="/health", request_url=url, response=response)
        return cast("dict[str, Any]", response.json())


# ── Module helpers ──────────────────────────────────────────────────────


_KNOWN_RUN_STATUS_NAMES: frozenset[str] = frozenset(RunStatus.__members__)


def _with_verdict(exc: PipelineRequestError) -> PipelineRequestError:
    """The error the inherited `execute` or `start` raised, as this SDK's class carrying a verdict.

    The base client raises two errors of the standard's own classes, which carry none: a bare
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


def _merge_run_extensions(extra: dict[str, Any] | None, *, method_ref: object, method_id: object) -> dict[str, Any] | None:
    """Fold this client's own named run args into the generic `extra` passthrough handed to
    the base client.

    This is the layering seam: `method_ref` (layer 2 — the Pipelex API's run source, resolved
    by the runner) and `method_id` (layer 3 — the hosted platform's run arg) are named
    parameters on this client because it is the client that types its own stack's arguments,
    and each reaches the wire as a top-level body property through the protocol client's
    extension mechanism — which merges it without knowing what it means. See
    `_PIPELEX_API_RUN_ARGS` / `_HOSTED_RUN_ARGS`.

    Both selectors go through `_normalized_selector`: a non-string is refused, an absent or
    empty value contributes nothing. `None` is returned for an empty result, leaving the
    base's own handling of an absent `extra` untouched.

    Args:
        extra: Server-specific extension args from the caller, or None.
        method_ref: The published method's address, or None.
        method_id: The hosted catalog id, or None.

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
    return extensions or None


def _assert_method_ref_pairs_with_nothing(*, mthds_contents: list[str] | None, merged_extra: dict[str, Any] | None) -> None:
    """Enforce the run routes' `method_ref` exclusivity, mirroring the server's own 422s so an
    illegal pairing fails before anything hits the wire.

    A `method_ref` is a complete run source (the fetched package carries its `.mthds` and its
    entry pipe), so it pairs with NOTHING: not with inline `mthds_contents` and not with the
    hosted `method_id` — an address run has its own provenance and needs no linkage id. Reads
    the MERGED extensions, so the presence semantics are the normalized ones (an empty selector
    was already dropped).

    The one documented run-route exception is deliberately NOT here: inline source +
    `method_id` stays legal (the inline source runs; the id demotes to run-history linkage), its
    one condition, a bare id, held by `_assert_linkage_method_id_is_bare` below.
    `pipe_code` beside a `method_ref` is legal too — it overrides the manifest's `main_pipe`.
    This SDK names no bundle encodings (`files` / `bundle_b64`), so their arm of the server's
    exclusivity has no client-side twin here; the server still enforces it.
    """
    if merged_extra is None or "method_ref" not in merged_extra:
        return
    if mthds_contents:
        msg = "method_ref and inline mthds_contents are mutually exclusive; send one or the other."
        raise RequestArgumentError(msg)
    if "method_id" in merged_extra:
        msg = (
            "method_ref and method_id are mutually exclusive: an address run carries its own provenance "
            "and takes no run-history linkage id. Send exactly one method selector."
        )
        raise RequestArgumentError(msg)


def _assert_linkage_method_id_is_bare(*, mthds_contents: list[str] | None, merged_extra: dict[str, Any] | None) -> None:
    """Enforce the run routes' linkage clause, mirroring the platform's own `422` so a suffixed
    linkage id fails before anything hits the wire.

    Beside inline `mthds_contents` the `method_id` is run-history linkage and must be a bare catalog
    id: the inline source is what runs, so a version suffix (`mt_…@3`, `mt_…@draft`) would claim a
    version that did not. A `method_id` alone keeps its suffix, which names the version to run.
    Reads the MERGED extensions, so an empty id was already dropped, and checks the suffix alone, by
    its `@`, since the catalog id's alphabet has none: the id itself stays a pass-through the
    platform resolves. As in `_assert_method_ref_pairs_with_nothing`, the bundle encodings this SDK
    does not name (`files` / `bundle_b64`) have no client-side twin; the platform still refuses a
    suffixed id beside them.

    Raises:
        RequestArgumentError: A `method_id` carrying a version suffix rides beside inline
            `mthds_contents`.
    """
    if not mthds_contents or merged_extra is None:
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


def _start_request_timeout_seconds(request_timeout_seconds: float, merged_extra: dict[str, Any] | None, mthds_contents: list[str] | None) -> float:
    """The time limit of `POST /v1/start`, by `@pipelex/sdk`'s rule.

    The start answers its `202` fast, so it normally gets the time limit of a quick request (see
    `_quick_request_timeout_seconds`), with exceptions that get the caller's whole
    `request_timeout_seconds`, the blocking-execute ceiling by default. A method bundle, inline as `mthds_contents` or riding the `files`
    or `bundle_b64` extension, can make the request body multi-megabyte, and its upload is charged
    against the limit: the same payload must not time out on the durable path yet succeed on the
    blocking fallback. And a `method_ref` start makes the server fetch the package before the
    acknowledgement, which can run well past 30s on a cold cache; cutting it off would blame the
    network for a server still fetching.
    """
    extension = merged_extra or {}
    carries_bundle = bool(mthds_contents) or bool(extension.get("files")) or bool(extension.get("bundle_b64"))
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


def _product_query(params: dict[str, str | int | None]) -> str:
    """Build the query string of a product list route, keeping entries on **presence**.

    Presence (`is not None`), never truthiness: an explicit empty `q` or cursor is bad input
    the API should reject, not something to silently drop into an unfiltered query that reads
    as working. Returns `""` for no parameters, otherwise a leading `?`.
    """
    kept = {key: value for key, value in params.items() if value is not None}
    if not kept:
        return ""
    return "?" + urlencode(kept)


def _method_path(method_id: str) -> str:
    """The path of a method route, `methods/{id}`, for a bare catalog id.

    The method routes address the method itself, never one of its versions, and the platform does
    not parse a suffix there: `mt_x@3` would be looked up as an id of its own and answer
    `404 not_found`, which reads as a method that does not exist. So a suffixed id is refused
    before anything is sent, saying how to read what it names. Stripping it instead would answer
    the draft for a caller that named a version.

    Raises:
        RequestArgumentError: `method_id` carries a version suffix.
    """
    if "@" in method_id:
        msg = (
            f'"{method_id}" carries a version suffix, and the method routes take a bare catalog id: they address the method '
            "itself, never one of its versions. Strip the suffix with parse_method_selector, and read a published version "
            "with get_method_version."
        )
        raise RequestArgumentError(msg)
    return f"methods/{quote(method_id, safe='')}"


def _artifact_selection(artifacts: Sequence[RunArtifact] | None) -> tuple[RunArtifact, ...] | None:
    """Normalise a results-read selection: `None` reads everything, anything else is deduplicated
    into the enum's declaration order, so the same selection always builds the same query.

    An empty selection names nothing to read; the platform refuses it with a `400`, and it is
    refused here first, before any request, with the request-shape error the client already raises
    for an empty `validate_files`.
    """
    if artifacts is None:
        return None
    requested = set(artifacts)
    if not requested:
        msg = "An artifact selection must name at least one RunArtifact; pass artifacts=None to read them all."
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

    The blocking `execute` turns such a failure into a `PipelineExecuteTimeoutError`. A caller timing a
    request that may create a run, such as `start` from `start_and_wait`'s `on_starting`, reads it to know
    the server may still be handling the request the gateway gave up on.
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
