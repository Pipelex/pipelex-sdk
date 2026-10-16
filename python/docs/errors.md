# Errors — the verdict every error carries

Every error `pipelex-sdk` raises says what a program needs to know before anything else: whether asking again can succeed, and who can fix the failure. That is the **verdict**, and this page describes it: what it means, how to read it, each class's, and the table a refused request falls back to. The verdicts are `@pipelex/sdk`'s, class for class, and a case file the two packages share holds them to it. What a failed run's report carries is described in [`run-results.md`](run-results.md) and on `RunFailedError`, and what a refused request's problem document carries in [`architecture.md`](architecture.md), "Error regimes".

## The verdict every error carries

Every error class `pipelex_sdk.errors` defines carries `retryable`, a `bool`, and `error_domain`, an `ErrorDomain`, and neither is ever `None`: the SDK knows the API, so it decides, and no consumer has to choose its own default. The domains say who can fix the failure:

| `error_domain` | Who fixes it | Examples |
|---|---|---|
| `input` | The caller, by changing the request: the inputs, the method, a reference, an argument. | A malformed bundle, a missing input, a stored method that does not exist. |
| `config` | Someone changing the environment: the base URL, the credential, the plan, the deployment. | An invalid API key, a plan without credit, a base URL pointing at a bare runner. |
| `runtime` | Nobody beforehand: a fault during execution or in the service. | A provider outage, a gateway timeout, a run still going when the wait ran out. |

`ErrorDomain` is a `StrEnum`, and `ErrorVerdict` the frozen pair, both in `pipelex_sdk.error_verdicts`. Read the pair with `error_verdict_of`, which takes anything an `except` holds:

```python
from mthds.protocol.exceptions import PipelineRequestError

from pipelex_sdk.error_verdicts import ErrorDomain, error_verdict_of

try:
    results = await client.start_and_wait(method_id="mt_abc123", inputs=inputs)
except PipelineRequestError as exc:
    verdict = error_verdict_of(exc)
    if verdict is None:
        raise  # an error of the standard's own client, which carries no verdict
    if verdict.retryable:
        return schedule_retry()
    match verdict.error_domain:
        case ErrorDomain.INPUT:
            return ask_the_user_to_fix(exc)
        case ErrorDomain.CONFIG | ErrorDomain.RUNTIME:
            return report_to_operator(exc)
```

`error_verdict_of` checks the shape rather than the class: it returns the pair from any exception carrying a boolean `retryable` and a known `error_domain`, and `None` otherwise. So it reads an error of a subclass of your own. An error of the standard's own client, `mthds`, carries its verdict on its problem instead, as `domain` and `retry` in the standard's vocabulary, and `error_verdict_of` reads it as that problem's verdict in this SDK's vocabulary, whatever the runner's body held beside it. `problem_verdict` does the translation for any problem of the standard: the standard's domain maps onto this SDK's by who acts — `input` and `method` read as `input`, `account` and `operator` as `config`, `runtime` as `runtime` — and only a `retry` of `yes` is retryable, since an outcome that is unknown may already have taken effect. A domain or a retry verdict the standard's reader does not know reads by its own fallbacks (`effective_domain`, `effective_retry`), and `@pipelex/sdk` applies the same mapping. Every class also exposes both members directly. The errors raised over a request derive from `PipelexRequestError`, itself the standard's `PipelineRequestError`, so `except PipelineRequestError` still catches all of them; it is the base of the family, never raised itself. The codegen tree errors, `CodegenError` and its `CodegenLockError`, are raised over bytes and a directory rather than over a request, so they derive from `Exception` and declare the two members themselves.

**"Retryable" means a retry can succeed, and never one that could start a second paid run.** The verdict says whether asking again can plausibly succeed, and on most routes it says nothing about whether the first attempt had an effect. A request that may create a run, a `start` or a blocking `execute`, is the exception: when it failed in a way that may have started a run anyway, the error's `run_may_have_started` is `True` and its `retryable` is `False`, whatever the server sent and whatever the status says, since asking again could start the run twice. [A failed run start](#a-failed-run-start--run_may_have_started) says when that is and what to tell a person. A gateway cut-off is told from a refusal by `is_gateway_cut_off`, the twin of `@pipelex/sdk`'s `isGatewayCutOff`, which the blocking `execute` applies to raise `PipelineExecuteTimeoutError`; a caller no longer needs it to learn whether a failed start may have created a run.

**What carries no verdict.** `error_verdict_of` returns `None` for what is not an SDK failure: the `ValueError`, `TypeError` or pydantic `ValidationError` an argument of the wrong shape meets before any request is sent (a malformed `app_info`, options that do not validate, an artifact selection that is a bare `str`), which names a bug in the calling code; the caller's own cancellation, `asyncio.CancelledError`, which the client lets through untouched; and the per-reference errors inside a `download_artifacts` result, which are values with a `code`, not raised errors. An argument the client refuses for what it asks, such as two method selectors that exclude each other, is a `RequestArgumentError`, which does carry one.

**An answer the SDK could not read is an `ApiResponseError` too.** A `2xx` whose body is not UTF-8 or not JSON, such as a gateway's HTML page or an empty body where the route answers one, is no result the SDK can hand back, and JSON the protocol refuses is not JSON here: every body is decoded by the rules `mthds`'s own client decodes it by (`decode_json` in `mthds.protocol.problem.answers`), as `@pipelex/sdk` reads it, so a body nested deeper than the protocol's limit or holding `NaN`, `Infinity` or a number past the range of a double is a body that is not JSON, and a refusal whose body is such JSON carries no hosted member and no `problem_document`. A `2xx` whose body is JSON but not what the route answers is no result to hand back either: `null` or a list where an object is due, an object missing a member the route's model requires or carrying one of the wrong type, a publish result naming no known `outcome`, an `upload` answer with no non-empty `uri`, run results whose artifacts carry a member the pinned `mthds` does not define. Every route raises an `ApiResponseError` for it, as `@pipelex/sdk` throws one, rather than letting the `json.JSONDecodeError`, `UnicodeDecodeError` or pydantic `ValidationError` of the parse escape: the protocol routes inherited from `mthds`, the run reads and `wait_for_result`, `start_and_wait` on either path, `health`, and every product route. Its message is `API <METHOD> <path> answered <status> with <what>`, `what` naming the failure (`a body that is not JSON`, `a body that is not UTF-8`, `an empty body where JSON was expected`, `a body that is not an object` for JSON that is not an object where the route answers one, worded as `@pipelex/sdk` words it, and `a body that is not the answer the route returns` for anything else the route does not answer, such as an object of the wrong shape, or anything but a list where the route answers a list); its `status` is the `2xx`, `response_body` the raw text, `request_id` the `X-Request-ID` header, `__cause__` the parse failure, `problem_document` and the hosted problem members are `None`, `problem` is the standard's reading of such an answer ([below](#the-standards-problem-on-every-error)), and its verdict is the fallback's for a status no refusal carries: `runtime`, not retryable, since no change to the call fixes it. On `start`, `execute` and the start of `start_and_wait`, its `run_may_have_started` is `True`, since the server accepted the request; that includes an `execute` `202` whose body is not JSON or names no run, which `execute` reads against the protocol's acknowledgement, `RunResultStart`, rather than raising a `RunStillRunningError` without an id. `upload_file` and `prepare_inputs` wrap it, as they wrap every upload failure, in an `UploadTransportError` with the code `unexpected`, since whether and where the file was stored is unknown. A product route that answers a `2xx` with no body at all, such as `revoke_pipelex_api_key`, still returns `None`.

### Each class's verdict

On an error from a request that may have started a run, `retryable` is `False` whatever this table says ([below](#a-failed-run-start--run_may_have_started)).

| Class | `error_domain` | `retryable` | Why |
|---|---|---|---|
| `ApiResponseError` | the server's, else the fallback | the server's, else no for a sent `input` or `config` domain, else the fallback | See [below](#a-refused-requests-verdict). |
| `RequestArgumentError` | `input` | no | The client refused a call's arguments before sending any request: no run source given to `execute` or `start`, a protocol or reserved arg in `extra`, run sources or method selectors that exclude each other, a selector that is not a string, a suffixed `method_id` beside inline `mthds_contents`, a selector rule of `validate`, an empty `validate_files`, an artifact selection that is empty or names an unknown artifact, a suffixed id given to a method route, a `publish_method` token that is not a string, a `get_method_version` version that is not a positive integer, an id a route puts in its path (a method's, an example's, a run's, an organization's or an API key's) that is empty, `.` or `..` or is not a `str`, since the URL would resolve it into another route's path, or that holds a lone surrogate, which a URL cannot carry, a `create_method_example` whose `name` or `inputs` is `None` or whose `run_id` is given but empty or not a `str`, an `update_method_example` naming neither `name` nor `inputs`, a `record_method_example_latest_run` without a run id or a positive integer `input_revision`, a value `parse_method_selector` refuses, a start's `idempotency_key` that is not 1 to 255 visible ASCII characters ([below](#a-starts-idempotency-key--idempotency_key)). It takes an optional `verdict`, and the client declares `config` for a base URL that is not host-only, since it typically comes from `PIPELEX_BASE_URL`. |
| `ApiUnreachableError` | `config` | yes | The address or the network must be checked, and a later attempt can get through. With the code `ABORT_TIMEOUT`, the SDK's own request timeout, it is `runtime`: the API took the request and did not answer in time. |
| `PipelineExecuteTimeoutError` | `input` | no | The blocking `execute` cannot outlast the gateway's limit; start the run and poll instead. The run goes on, so its `run_may_have_started` is always `True`. |
| `RunFailedError` | the report's | the report's | The report's `error_domain` when it is a known domain, else `runtime`; retryable only when the report's `retryable` is `True`, so a report that says nothing, and a run with no report, are not retryable: starting the run again spends credit and nothing says it would succeed. The report keeps its own members as written. |
| `RunTimeoutError`, `RunStillRunningError` | `runtime` | yes | The run is still going; waiting again, by its id, can succeed. |
| `RunLifecycleUnavailableError` | `config` | no | The base URL points at a bare runner without the run lifecycle, or, for `get_run_progress`, at a hosted API older than the progress route. |
| `MissingMainStuffError` | `runtime` | no | The API broke its own contract on a completed run. |
| `PagingNotTerminatingError` | `runtime` | no | A server minting cursors forever; `page_limit` is the ceiling the iterator stopped at. |
| `InputPreparationError` and `InvalidLocalSourceError`, `InvalidInputValueError`, `UploadNotAllowedError`, `MethodLoadError`, `RejectedAssetError` | `input` | no | The asset, the inputs or the method selector must change. The family's base takes an optional `verdict`, so a subclass of your own can declare another; `prepare_inputs` declares `runtime` for an answer that does not describe the pipe it selected. |
| `UnsupportedUploadCapabilityError`, `UploadAuthenticationError` | `config` | no | The deployment or the credential must change. |
| `UploadTransportError` | the cause's, else by `code` | the cause's, else by `code` | `upload_file` wraps the `ApiResponseError` or `ApiUnreachableError` the client raised, passed as `cause` and kept as `__cause__`, and takes its verdict, so a wrapped `402` is `config` and not retryable. Without such a cause: `timeout`, `storage_timeout` and `conflict` are `runtime` and retryable; `server_error` is `runtime`, and retryable unless its `status` is a `501`; `unexpected` is `runtime`, and retryable only for a `408` or a `429`; `unreachable` is `config` and retryable; `redirected` is `config` and not retryable; `invalid_grant_url`, and no code, are `runtime` and not retryable. |
| `ArtifactOperationError`, `ScopeUnavailableError` | `runtime` | no | The family's base also takes an optional `verdict`: the SDK declares `input` where it refuses an argument (a `scope`, a bound, a location, both selectors or neither) and `config` where the environment refuses the download (a directory that cannot be created). |
| `ArtifactAuthenticationError` | `config` | no | The credential must change. Its `verdict` member is the download's result so far, not the error's. |
| `ArtifactFetchError` | by `code` | by `code` | `invalid_storage_uri`, `forbidden`, `unsupported_url`, `not_found` and `too_large` are `input` and not retryable; `plain_http_refused` is `config` and not retryable; `redirect_refused` and `store_refused` are `runtime` and not retryable; `timeout` and `network` are `runtime` and retryable; `store_error` is `runtime`, and retryable when [the fallback table](#a-refused-requests-verdict) would call its `status` retryable: a `408`, a `429`, or a `5xx` other than `501`. A code this version does not know is `runtime` and not retryable. |
| `FieldNotIncludedError` | `input` | no | The results handed over were read without the field, so the caller reads them again asking for it. It takes an optional `verdict`, and `download_artifacts` declares `runtime` when it read the results itself, by `run_id`, and the API left the field out. |
| `CodegenError`, `CodegenLockError` | `input` | no | The output directory, its files or the lock are the caller's own, and writing the same tree again meets the same refusal. |

`RejectedAssetError` and `UploadTransportError` carry a `code` from a closed vocabulary, `RejectedAssetCode` and `UploadTransportCode`, the same as `@pipelex/sdk`'s, so a consumer of both SDKs branches on one set. `upload_file` sets `too_large` on a `413`, and `timeout`, `unreachable`, `server_error` or `unexpected` on a transport failure; the other codes name the refusals and failures of an upload made with a grant, which only `@pipelex/sdk`'s `uploadWithGrant` performs.

### A refused request's verdict

An `ApiResponseError` takes each member the server sent validly: `retryable` is the problem document's `retryable` when it is a boolean, and `error_domain` is its `error_domain` when it is a known domain. A member the server did not send, or sent with the wrong type, or (for the domain) not a known domain, is absent, and an absent domain takes the fallback's. An absent `retryable` depends on the domain the server sent, since a runner often sends `error_domain` without `retryable`: a sent `input` or `config` domain is not retryable, as a stored report that says nothing is not, because the caller or the environment must change and asking again unchanged meets the same answer; a sent `runtime` domain, and no domain at all, take the fallback's `retryable`.

The fallback, `fallback_verdict` in `pipelex_sdk.error_verdicts`, reads the HTTP status, the platform's `code`, and whether the body is **named**: it carries a platform `code` or a runner `error_type`. A named `404` is something the caller asked for that does not exist; a bare one is a route the deployment does not serve.

| Status | `error_domain` | `retryable` | Why |
|---|---|---|---|
| `400`, `413`, `422`, and any `4xx` not listed here | `input` | no | The request itself was refused. |
| `401`, `402`, `403` | `config` | no | The credential, the plan or the access must change. |
| `404`, named | `input` | no | The caller named something that does not exist. |
| `404`, bare | `config` | no | The base URL points at a deployment without the route. |
| `405` | `config` | no | The deployment does not serve this method on the route. |
| `408`, `429` | `runtime` | yes | Refused for its timing, not its content. |
| `409` | `input` | no | The request conflicts with the stored state: a method being deleted, a stale update, a taken label. |
| `409` with code `pipelex_api_key_limit_reached` | `config` | no | The organization holds as many keys as it may; someone removes one. |
| `409` with code `idempotency_key_in_use` | `runtime` | yes | An earlier request under the same idempotency key is still being handled, and the same request sent again under that key is answered with its outcome. |
| `501` | `config` | no | The deployment does not implement it, and asking again will not change that. |
| `500`, `502`, `503`, `504`, and any `5xx` not listed here | `runtime` | yes | A fault in the service, which may pass. |
| Anything else | `runtime` | no | A status no refusal carries, such as the `2xx` of an answer the SDK could not read; nothing says a retry helps. |

The members the server sent are read first, and the fallback answers only for one it did not send: a runner's problem usually carries its own, the platform sends them on the problems it renders itself once its deployment classifies them, and a route that sends neither, as the platform's Lambda-backed routes do not yet, gets the fallback for both. **Nothing on the error says which of the two a value came from**: `problem_document` keeps the document whole, so a reader that must tell a server-sent verdict from a derived one reads it there, as the live leg `tests/e2e/test_error_verdicts_e2e.py` (run by `make e2e-test`) does. A rejected API key always gets the fallback's verdict: the hosted gateway's authorizer refuses it before the platform sees the request, with a bare `403` whose body is `{"message":"Forbidden"}`, which carries no `code`, no `type` and no verdict, so the error reads it as `config` and not retryable from the status alone. An `ApiResponseError` built by hand gets the verdict the client would give it, the arguments `error_domain` and `retryable` being what the server sent.

### A failed run start — `run_may_have_started`

Every error class `pipelex_sdk.errors` defines over a request carries a third member beside the verdict, `run_may_have_started`, a `bool` that is never `None`. It is `True` when the request that failed may have started a run whose id never reached the caller, and `False` otherwise, which includes every error from a request that cannot start a run. Read it with `run_may_have_started_of` from `pipelex_sdk.error_verdicts`, which takes anything an `except` holds and, like `error_verdict_of`, checks the shape rather than the class: it is `True` only for an exception whose `run_may_have_started` is `True`, so an `mthds` error, which never carries the member, reads as `False`.

**The requests that may create a run** are `start` and the blocking `execute`, and inside `start_and_wait` the start and the blocking execute it falls back to against a bare runner. Once `on_started` has been called the run exists and the caller holds its id, so an error while the composite waits started nothing: its `run_may_have_started` is `False`, and its `retryable` is about waiting again on that id, never about calling the composite again. `RunStillRunningError`, the `202` a blocking execute answers for a run still going, names its run, so its member is `False` too; a `202` that names no run is an answer the SDK could not read, which may have started one.

A failure of a request that may create a run may have started one in these cases, and only these:

| Failure | May have started | Why |
|---|---|---|
| `ApiUnreachableError` that proves nothing was sent | no | The connection's set-up failed, so no request followed. |
| Any other `ApiUnreachableError`, a body that could not be decoded included | yes | The request may have left, and the answer was lost or unreadable. |
| `ApiResponseError` with a `2xx` status | yes | The server accepted the request; only its answer could not be read, which includes a `start` acknowledgement or an `execute` `202` without a string `pipeline_run_id`. |
| `ApiResponseError` with a `408` | yes | A proxy in front of the platform may answer it for a request it forwarded. |
| `ApiResponseError` with a `503` and the code `pipeline_start_unavailable` | no | The platform never reached the runner, and recorded the run as `FAILED`. |
| `ApiResponseError` with a `501` | no | The deployment does not serve the route. |
| `ApiResponseError` with any other `5xx` | yes | The server or a gateway failed while handling the request. |
| `ApiResponseError` with any other status | no | The server refused the request before running anything. |
| `PipelineExecuteTimeoutError` | yes | The gateway cut the execute off, and the run goes on. |
| `RunLifecycleUnavailableError`, `RequestArgumentError`, an input preparation error | no | Nothing that starts a run was sent. |

**The reading errs on the safe side.** A false "may have started" costs a look at the run history; a false "did not start" costs a second paid run. So every `5xx` counts unless the server says otherwise, as the `501` and the coded `503` do. A `503` without that code can follow a run the runner already started, since the platform answers a failure of its own storage with one after it has dispatched the start. Timing plays no part: a `503` or `504` that came back at once reads the same as one at the gateway's limit.

**What proves nothing was sent** is a failure of the connection's set-up, which no request follows: an httpx `ConnectError` (an unknown host, a refused connection, no route to the host or the network, the system giving up connecting, a server certificate the TLS handshake refused), a `ConnectTimeout`, which covers the TCP connect and the TLS handshake, a `PoolTimeout`, met while the request waited for a connection, and an `UnsupportedProtocol`. A `ConnectError` raised from any other failure of the TLS handshake, or from a connection dropped during it, does not prove it, since `@pipelex/sdk`'s fetch reports those as failures that can come once the request has left, and both SDKs must read them alike. Anything else may have come once the request had left: a read or write timeout, a connection that closed or was reset, and a body httpx could not decode.

**A run that may have started is never retryable.** When `run_may_have_started` is `True`, `retryable` is `False`, whatever the problem document sent and whatever the fallback table says; `error_domain` is unchanged, and the server's own members stay on `problem_document`. So a caller that branches on `retryable` alone never offers a retry that could start a second paid run. A caller that reads the member can say more: tell the person the run may exist, and to look it up in the run history (`list_runs`) before starting it again.

```python
from mthds.protocol.exceptions import PipelineRequestError

from pipelex_sdk.error_verdicts import error_verdict_of, run_may_have_started_of

try:
    started = await client.start(method_id="mt_abc123", inputs=inputs)
except PipelineRequestError as exc:
    if run_may_have_started_of(exc):
        return tell("The run may have started. Check the run history before starting it again.")
    verdict = error_verdict_of(exc)
    if verdict is not None and verdict.retryable:
        return schedule_retry()
    raise
```

**An idempotency key makes the retry safe, and leaves the verdict as it is.** `start`, and so `start_and_wait`, takes an optional `idempotency_key`, which the SDK sends as the `Idempotency-Key` header of `POST /v1/start`; without one it sends no header. The hosted API binds the key to the run before it dispatches it, so the same start sent again under the same key is answered with that run and starts nothing, however the first attempt ended. A caller that sent a key therefore answers a failure whose `run_may_have_started` is `True` by sending the same start again, with the same key and the same arguments, and gets the run back instead of paying for a second one ([below](#a-starts-idempotency-key--idempotency_key)). The error does not say so itself: `run_may_have_started` stays `True` and `retryable` stays `False` with a key, since the SDK cannot know that the server honours the key (a bare runner ignores it), and a retry under a new key, or with other arguments, would start a second run. The platform reads its own answer the same way: the `502` with the code `bad_gateway` it answers for a start whose acknowledgement it lost is not retryable whether or not a key was sent, and it names the run that may be running in `problem_document["pipeline_run_id"]`.

`@pipelex/sdk` carries the same member as `runMayHaveStarted`, with the reader `runMayHaveStartedOf`, and reads every failure the same way; the `run_start` rows of the shared case file hold the two to the same answer for every status.

### A start's idempotency key — `idempotency_key`

Generate one key per run you mean to start (a `str(uuid.uuid4())` is a good one), and keep it with the arguments across that start's retries. A key is 1 to 255 visible ASCII characters, `!` to `~`; anything else, an empty string included, is a `RequestArgumentError` before anything is sent, since a start sent without the key its caller gave would lose the protection without a word.

```python
import uuid

from mthds.protocol.exceptions import PipelineRequestError

from pipelex_sdk.error_verdicts import error_verdict_of, run_may_have_started_of

# One key per run, kept with the arguments, unchanged, across the start's retries.
idempotency_key = str(uuid.uuid4())
try:
    started = await client.start(method_id="mt_abc123", inputs=inputs, idempotency_key=idempotency_key)
except PipelineRequestError as exc:
    verdict = error_verdict_of(exc)
    if not run_may_have_started_of(exc) and not (verdict is not None and verdict.retryable):
        raise
    # Under the same key, a start that may have started a run is answered with that run.
    started = await client.start(method_id="mt_abc123", inputs=inputs, idempotency_key=idempotency_key)
```

What the hosted API answers a start sent under a key:

| The start | The answer |
|---|---|
| The first under the key | The run starts, the key bound to it before it is dispatched. |
| The same arguments under the same key, once the first was answered or bound to its run | The first start's acknowledgement, the run's state as it stands, and nothing starts. A first start refused for its content is refused again; one refused for its timing, such as a `429` in front of the runner, freed the key, and the retry is handled afresh. |
| The same arguments under the same key, while the first is still being handled | After a short wait, the first start's answer; failing that, a `409` with the code `idempotency_key_in_use`, `runtime` and retryable, with a `Retry-After` the error keeps in `headers["retry-after"]`. Nothing ran for it, so its `run_may_have_started` is `False`: send it again under the same key in a few seconds, never under a new one, which would start a second run. |
| Other arguments under the same key | A `409` with the generic code `conflict`, `input` and not retryable: a key reused for another request is a bug in the caller. Send the new request under a new key. |
| The same arguments under a key bound to a run since deleted | A `409` `conflict` too: send it under a new key to start a new run. |

`IdempotencyErrorCode` in `pipelex_sdk.errors` names the code a caller branches on, `idempotency_key_in_use`; the key's other refusals carry the generic `conflict`. The hosted API keeps a key for 24 hours, scoped to the caller and the organization, so a start sent again after that starts a new run.

**Keep the body identical.** The hosted API compares the request's bytes, so the retry must carry the same arguments in the same form. The SDK builds the same body from the same arguments, but inputs prepared twice are not the same arguments: `prepare_inputs` uploads a local file again and returns a new storage reference each time, so prepare the inputs once and reuse what it returned for every attempt.

**A bare runner ignores the key.** It has no idempotency to honour, so a key sent to one protects nothing, and `start_and_wait`'s blocking execute against one sends none.

## The standard's problem on every error

**Every error raised over a request also carries `problem`, the failure as the MTHDS standard reads it.** The standard's own client, `mthds`, reads every failure as one problem under a registry code, typed as the standard's `Problem` (`mthds.protocol.problem.models`), and the errors this SDK raises over a request carry one too, so a caller handling this SDK's errors and the standard client's alike branches on `problem.code`. The verdict above stays the SDK's own: `problem` carries the standard's `domain` and `retry`, read from the same failure, and neither replaces `error_domain` or `retryable`, which keep their meaning and their case file. The message is the one this SDK has always given: the standard's errors append the problem's next step on its own line, and this SDK's do not, an `ApiResponseError` keeping the `Next step:` line it reads off the hosted `user_action`.

| The error | Its `problem` |
|---|---|
| `ApiResponseError` for a refusal | The answer as the standard reads it (`read_answer` in `mthds.protocol.problem.answers`), the problem `mthds`'s own `ApiResponseError` carries for the same answer: the body when it is a core problem document, otherwise the problem the standard reads the status as. On a request that may create a run it agrees with `run_may_have_started`: `client.outcome_unknown`, naming the run when the body names one, wherever a run may have started (a `408` and every `5xx` but a `501` and a `503` carrying `pipeline_start_unavailable`), and the reading of an answer to a request that creates no run wherever none did, `runtime.unavailable` for that `503` and `client.response_unreadable` for that `501`. |
| `ApiResponseError` for a `2xx` the SDK could not read | `client.response_unreadable`, or `client.outcome_unknown` on `start`, `execute` and the start of `start_and_wait`. |
| `ApiUnreachableError` | The standard's reading of a request that got no answer: `client.unreachable` when no request left, `client.timeout` when no answer came in time, and `client.outcome_unknown` when a request that may create a run may have left. It is the standard's `ApiTransportError` too, so `except ApiTransportError` catches it. |
| `RequestArgumentError`, `UploadNotAllowedError`, and an `InputPreparationError` or `ArtifactOperationError` refusing an argument | `client.argument_invalid`, naming the argument and the reason it was refused, or the standard's own problem when the standard's client refused the argument first. |
| `PipelineExecuteTimeoutError` | `client.outcome_unknown`. |
| `RunFailedError` | `run.failed`, naming the run and its status. |
| `RunTimeoutError`, `RunStillRunningError` | `run.not_finished`, naming the run; a `RunStillRunningError` that `execute()` raises for a `202` keeps the problem the protocol `execute()` gave it, `client.follow_failed` naming the run. |
| `MissingMainStuffError`, `PagingNotTerminatingError`, `ScopeUnavailableError`, and an `InputPreparationError`, `ArtifactOperationError` or `FieldNotIncludedError` reading an answer the SDK could not use | `client.response_unreadable` for a `200`. |
| `RunLifecycleUnavailableError`, `UnsupportedUploadCapabilityError` | `runtime.unsupported`, naming the capability. |
| `UploadAuthenticationError`, `ArtifactAuthenticationError` | `auth.invalid_credential`. |
| `InvalidLocalSourceError`, `InvalidInputValueError`, `MethodLoadError` | `input.file_unreadable`, `input.invalid` and `method.invalid`. |
| `ArtifactFetchError` | `input.reference_not_found` for a reference that names nothing, `client.link_refused` for a link the SDK will not follow, `client.download_limit_exceeded` for a file over the cap, `client.timeout` for a download that ran out of time, `client.unreachable` naming the store's origin for a download that failed on the network, the status's reading for a store's refusal, and `runtime.unexpected` otherwise. |
| `ArtifactOperationError` for a directory it could not write | `client.write_failed`, naming the path. |
| `FieldNotIncludedError` | `client.argument_invalid` for the `results` argument, which did not ask for the field. |
| An error wrapping another (`UploadTransportError`, `RejectedAssetError`, the input-preparation family) | The problem of the failure it wraps, else the reading of the status it carries, else `runtime.unexpected`. |

**The hosted plane's problem documents predate the standard's**, so for an answer from the hosted plane `problem` mostly says that its body is no problem document the standard can read (`client.response_unreadable`), and every hosted member is read from the hosted document as it always was. The two never share a slot: `code` is the platform's code beside the registry's `problem.code`, `errors` the platform's field-level failures beside the problem items of `problem.errors`, and `problem_document` the decoded hosted document whole. The codegen tree errors, raised over bytes rather than over a request, carry no problem.

## The case file both SDKs run

**The verdicts are a contract with `@pipelex/sdk`.** `tests/fixtures/error-verdicts.json` holds every case the two must agree on: the fallback's rows, the server-sent resolution, each class's variants and the answers to a run-creating request (its `run_start` member). Its source is `js/tests/fixtures/error-verdicts.json`; `make shared-files` at the repository's root writes this package's byte for byte identical copy, and `make check-shared-files` fails on a stale one, so a change to a verdict is made in the source, copied, and then made in both packages. `tests/unit/test_error_verdicts.py` drives this package's code through every case: the fallback table directly and through a hand-built `ApiResponseError`, each server-sent body through a real client call, each `run_start` row through a real `start` or `execute` over a mocked transport, and each class through a builder keyed by its name. A class the file lists for this SDK with no builder fails the suite, as does a field the suite does not know, and a completeness test fails on an error class `pipelex_sdk.errors` defines that the file does not list. A class or a variant only one SDK has is marked `only_in`, and the other suite skips it: `CodegenError` and `FieldNotIncludedError` are Python's alone, and `EmptyMethodSourceError`, raised by `getMethodClosure`, is JavaScript's.
