# Errors — the problem every error carries

Every error `pipelex-sdk` raises carries its failure as one **problem document**, the RFC 9457 document the MTHDS standard defines, under a registered code, typed as the standard's `Problem` (`mthds.protocol.problem.models`). A refusal the hosted API answers is read as the problem document it sends, a failed run as the problem the platform stored for it, and a failure the SDK detects itself (an argument it refuses, a request that got no answer, an answer it cannot read, a run that may have started without its id reaching the caller) as a problem the SDK builds under a `client.*` code or another core code. A program branches on the problem, never on a class, an HTTP status or the wording of a message. `@pipelex/sdk` throws the same code for every failure, and a case file the two packages share holds them to it ([below](#the-case-file-both-sdks-run)). What a failed run's results carry is described in [`run-results.md`](run-results.md).

## The problem every error carries

Every error raised over a request derives from `PipelexRequestError`, itself the standard's `PipelineRequestError` (`mthds.protocol.exceptions`), so `except PipelineRequestError` catches all of them, and every one carries `problem`, never `None`. The codegen tree errors, `CodegenError` and its `CodegenLockError`, are raised over bytes and a directory rather than over a request, so they derive from `Exception`, and carry `problem` all the same.

| Member of `exc.problem` | What it says |
|---|---|
| `code` | The registered code a program branches on: a core code (`client.unreachable`, `auth.invalid_credential`, `request.invalid`, `run.failed`, `method.invalid`, `model.unavailable`, …) or a Pipelex one (`pipelex.catalog.not_found`, `pipelex.billing.plan_limit`, …). |
| `effective_domain` | Who must act: `input` (the caller changes the request), `method` (the method's author changes the method), `account` (the account's owner changes a credential, a plan or a role), `operator` (whoever runs the deployment changes its configuration) or `runtime` (nobody beforehand: a fault in the service). `domain` is the member as received; `effective_domain` reads one this version does not know by its code's family. |
| `effective_retry` | Whether sending the same request again can succeed: `yes`, `no`, or `outcome_unknown` when the request may have taken effect and its outcome must be read before anything is sent again ([below](#a-run-that-may-have-started--outcome_unknown)). A verdict this version does not know reads as `no`. |
| `retry_after` | The seconds to wait before a repeat, when the problem gives them. |
| `next_step` | What to do, as a `kind` a program branches on and a `detail` a person reads. |
| `params`, `location`, `errors`, `pipeline_run_id` | What the code's registry entry names (read with `params.as_wire()`), where the fault is, the problem items of a fault with several parts, and the run it concerns. |
| `model_extra` | Every member the standard does not name, as received: the `request_id` to hand to support, and a Pipelex refusal's own members, such as a copy's `limit`. |

The message, `str(exc)`, stays the SDK's own sentence, as it always was: the standard's errors append the problem's next step to their message, and the SDK's do not, since `problem.detail` and `problem.next_step.detail` are there for whoever renders them.

```python
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.models import ProblemDomain, RetryVerdict

try:
    results = await client.start_and_wait(method_id="mt_abc123", inputs=inputs)
except PipelineRequestError as exc:
    problem = exc.problem
    match problem.effective_retry:
        case RetryVerdict.OUTCOME_UNKNOWN:
            return look_up_the_run_before_starting_again(problem)
        case RetryVerdict.YES:
            return schedule_retry(problem.retry_after)
        case RetryVerdict.NO:
            pass
    match problem.effective_domain:
        case ProblemDomain.INPUT | ProblemDomain.METHOD:
            return ask_the_user_to_fix(problem)
        case ProblemDomain.ACCOUNT | ProblemDomain.OPERATOR | ProblemDomain.RUNTIME:
            return report_to_operator(problem)
```

**What carries no problem.** The `ValueError`, `TypeError` or pydantic `ValidationError` an argument of the wrong shape meets before any request is sent (a malformed `app_info`, options that do not validate, an artifact selection that is a bare `str`) names a bug in the calling code; the caller's own cancellation, `asyncio.CancelledError`, is let through untouched; and the per-reference errors inside a `download_artifacts` result are values with a `code`, not raised errors. An argument the client refuses for what it asks, such as two method selectors that exclude each other, is a `RequestArgumentError`, which does carry one.

### A run that may have started — `outcome_unknown`

A request that may create a run is a `start` or a blocking `execute`, and inside `start_and_wait` the start and the blocking execute it falls back to against a bare runner. When one of them fails in a way that may have started a run whose id never reached the caller, its problem is `client.outcome_unknown`, whose `retry` is `outcome_unknown`: sending the start again could start a second paid run, so the caller looks the run up in the run history (`list_runs`) first, or sends it again under the same idempotency key ([below](#a-starts-idempotency-key--idempotency_key)). The problem names the run as its `pipeline_run_id` when the answer named one.

| Failure of a start or an execute | Its problem |
|---|---|
| A problem document from the hosted API, whatever its status | As received: the platform's own `retry` says whether a run may exist, so a `503` it answers before dispatching the run says `yes`, and one it answers once a run may exist says `outcome_unknown`. |
| An `ApiUnreachableError` that proves nothing was sent | `client.unreachable`, `retry` `yes`. What proves it is a failure of the connection's set-up, which no request follows: an httpx `ConnectError` (an unknown host, a refused connection, no route, a server certificate the TLS handshake refused), a `ConnectTimeout`, a `PoolTimeout` and an `UnsupportedProtocol`. A `ConnectError` raised from any other failure of the TLS handshake, or from a connection dropped during it, does not prove it, since `@pipelex/sdk`'s fetch reports those as failures that can come once the request has left. |
| Any other `ApiUnreachableError`: a read or write timeout, a connection closed or reset | `client.outcome_unknown`. |
| A body that arrived and httpx could not decode | No `ApiUnreachableError`, since an answer came back: an `ApiResponseError` read by its status with an empty body, as the rows below read an answer, so a `2xx` is `client.outcome_unknown`. |
| A `2xx` the SDK could not read, a start acknowledgement or an execute `202` naming no run included | `client.outcome_unknown`: the server accepted the request. |
| A `408`, or a `5xx` other than `501`, whose body is no problem document | `client.outcome_unknown`, whatever the time it took: a proxy or the gateway answered for a request it may have forwarded. |
| A `501` whose body is no problem document | `client.response_unreadable`: the deployment does not serve the route. |
| Any other status whose body is no problem document | The edge's reading of that status ([below](#an-answer-that-is-no-problem-document)). |
| `PipelineExecuteTimeoutError` | `client.outcome_unknown`: the gateway cut the execute off, and the run goes on. |
| `RunLifecycleUnavailableError`, `RequestArgumentError`, an input preparation error | Its own problem, never `outcome_unknown`: nothing that starts a run was sent. |

Once `on_started` has been called the run exists and the caller holds its id, so an error while `start_and_wait` waits started nothing: its `retry` is about waiting again on that id, never about calling the composite again. `RunStillRunningError`, the `202` a blocking execute answers for a run still going, names its run, so it is `client.follow_failed`, whose `retry` is `outcome_unknown` too and whose next step is `read_run`: the run exists, and the caller reads it by the id the problem names rather than start it again.

**A request the gateway cut off: `is_gateway_cut_off`.** The hosted gateway gives up on a request it waits on at about 30 seconds and answers `503` or `504`, while the server may still be handling it. `is_gateway_cut_off(exc, elapsed_seconds)` in `pipelex_sdk.client` tells such a failure from a refusal: it is `True` when, at least ~28 seconds after the request was sent, the failure is a `503` or `504` answer whose body is no problem document, or the client's own time limit on a request that had reached the API (the `ApiUnreachableError` whose `network_code` is `ABORT_TIMEOUT`, httpx's read or write timeout), and `False` before then and for any other failure. The blocking `execute` applies it to raise `PipelineExecuteTimeoutError`. A caller no longer needs it to learn whether a failed start may have created a run, since the problem says so whatever the timing. `@pipelex/sdk`'s `isGatewayCutOff` is the same rule.

### A start's idempotency key — `idempotency_key`

`start`, and so `start_and_wait`, takes an optional `idempotency_key`, which the SDK sends as the `Idempotency-Key` header of `POST /v1/start`; without one it sends no header. The hosted API binds the key to the run before it dispatches it, so the same start sent again under the same key is answered with that run and starts nothing, however the first attempt ended. A caller that sent a key therefore answers a failure whose `retry` is `outcome_unknown` by sending the same start again, with the same key and the same arguments, and gets the run back instead of paying for a second one. The problem does not say so itself: it stays `outcome_unknown` with a key, since the SDK cannot know that the server honours the key (a bare runner ignores it), and a retry under a new key, or with other arguments, would start a second run.

Generate one key per run you mean to start (a `str(uuid.uuid4())` is a good one), and keep it with the arguments across that start's retries. A key is 1 to 255 visible ASCII characters, `!` to `~`; anything else, an empty string included, is a `RequestArgumentError` naming `idempotency_key` before anything is sent, since a start sent without the key its caller gave would lose the protection without a word.

```python
import uuid

from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.models import RetryVerdict

# One key per run, kept with the arguments, unchanged, across the start's retries.
idempotency_key = str(uuid.uuid4())
try:
    started = await client.start(method_id="mt_abc123", inputs=inputs, idempotency_key=idempotency_key)
except PipelineRequestError as exc:
    if exc.problem.effective_retry == RetryVerdict.NO:
        raise
    # Under the same key, a start that may have started a run is answered with that run.
    started = await client.start(method_id="mt_abc123", inputs=inputs, idempotency_key=idempotency_key)
```

What the hosted API answers a start sent under a key:

| The start | The answer |
|---|---|
| The first under the key | The run starts, the key bound to it before it is dispatched. |
| The same arguments under the same key, once the first was answered or bound to its run | The first start's acknowledgement, the run's state as it stands, and nothing starts. A first start refused for its content is refused again; one refused for its timing, such as a `429` in front of the runner, freed the key, and the retry is handled afresh. |
| The same arguments under the same key, while the first is still being handled | After a short wait, the first start's answer; failing that, a `409` `request.idempotency_key_in_use`, `retry` `yes`, whose `retry_after` says how long to wait. Nothing ran for it: send it again under the same key, never under a new one, which would start a second run. |
| Other arguments under the same key | A `409` `request.idempotency_conflict`, `retry` `no`: a key reused for another request is a bug in the caller. Send the new request under a new key. |
| The same arguments under a key bound to a run since deleted | A `409` `request.idempotency_conflict` too: send it under a new key to start a new run. |

`IdempotencyErrorCode` in `pipelex_sdk.errors` names both codes. The hosted API keeps a key for 24 hours, scoped to the caller and the organization, so a start sent again after that starts a new run.

**Keep the body identical.** The hosted API compares the request's bytes, so the retry must carry the same arguments in the same form. The SDK builds the same body from the same arguments, but inputs prepared twice are not the same arguments: `prepare_inputs` uploads a local file again and returns a new storage reference each time, so prepare the inputs once and reuse what it returned for every attempt.

**A bare runner ignores the key.** It has no idempotency to honour, so a key sent to one protects nothing, and `start_and_wait`'s blocking execute against one sends none.

**A copy takes a key too.** `copy_method` sends an `idempotency_key` the same way, held to the same rule, and the hosted API keeps it for the same 24 hours, scoped to the caller and the method's organization. A copy binds no run, so its answers under a key differ from a start's: [method-copy.md](./method-copy.md#retrying-a-copy--idempotency_key) gives them, with the copy's own codes, `MethodErrorCode.ORGANIZATION_NOT_FOUND` and `MethodErrorCode.COPY_TOO_LARGE`.

**So do a secret rotation and a delivery replay.** `rotate_webhook_secret` and `replay_run_webhook_delivery` send an `idempotency_key` the same way, held to the same rule. A rotation's answer carries a secret, so the platform never replays it, while a replay's stored answer is given again: [webhooks.md](./webhooks.md) gives both.

## Each class's problem

The classes remain, so an `except` can still tell an argument refusal from a refused request or a failed run, but every one carries its failure as its problem, and the code is what a program branches on.

| Class | Its problem |
|---|---|
| `ApiResponseError` | The answer read as its problem: the body when it is a problem document, otherwise the edge's reading of its status ([below](#a-refused-request--apiresponseerror)). |
| `RequestArgumentError` | `client.argument_invalid`, naming the argument and why it was refused: no run source given to `execute` or `start`, a protocol or reserved argument in `extra`, run sources or method selectors that exclude each other, a method's tree given in two forms or holding no file, a selector that is not a string, a suffixed `method_id` beside the method's tree, a selector rule of `validate`, an artifact selection that is empty or names an unknown artifact, a suffixed id given to a method route, a `publish_method` token that is not a string, a `get_method_version` version that is not a positive integer, an id a route puts in its path that is empty, `.` or `..`, is not a `str` or holds a lone surrogate, an example write missing what it needs, a value `parse_method_selector` refuses, a `write_method_tree` listing or destination it refuses, a `copy_method` argument of the wrong type, or an `idempotency_key` outside its rule. A base URL that is not host-only is `client.not_configured` naming `base_url` instead, since it typically comes from `PIPELEX_BASE_URL`. One built from a message alone names the argument `arguments`, for the reason `unspecified`. |
| `ApiUnreachableError` | `client.unreachable`, naming the base URL; `client.timeout`, naming the time limit, when the client's own limit ran out; and `client.outcome_unknown` on a start or an execute that may have left ([above](#a-run-that-may-have-started--outcome_unknown)). `network_code` is `ABORT_TIMEOUT` for httpx's read or write timeout, and the httpx exception's class name otherwise. It is the standard's `ApiTransportError` too, so `except ApiTransportError` catches it. |
| `PipelineExecuteTimeoutError` | `client.outcome_unknown`: the gateway cut the blocking execute off and the run goes on; start the next one and poll instead. |
| `RunFailedError` | `run.failed`, naming the run and its status, with the run's own problem nested as `run_error` ([below](#a-failed-run--runfailederror)). |
| `RunTimeoutError`, `RunStillRunningError` | `client.follow_failed`, naming the run, with `retry` `outcome_unknown` and the step `read_run`: the run keeps going, and is read again by its id, never started again. |
| `RunLifecycleUnavailableError` | `runtime.unsupported`, naming the run lifecycle: the base URL points at a bare runner without it, or, for `get_run_progress`, at a hosted API older than the progress route. |
| `MissingMainStuffError`, `PagingNotTerminatingError` | `client.response_unreadable`: the API broke its own contract on a completed run, or minted cursors forever (`page_limit` is the ceiling the iterator stopped at). |
| `InputPreparationError` | `client.argument_invalid` naming `inputs` when built from a message alone; the SDK passes the precise problem wherever it raises one, and `prepare_inputs` gives `client.response_unreadable` for an answer that does not describe the pipe it selected. |
| `InvalidLocalSourceError`, `InvalidInputValueError` | `input.file_unreadable` for a local file the inputs name that cannot be read, and `input.invalid` for a value at a file input that is no file. |
| `UploadNotAllowedError` | `client.argument_invalid`: a value that would be uploaded while uploads are off. |
| `MethodLoadError` | `method.invalid`, whose `errors` are the pipe I/O answer's problem items ([below](#a-verdicts-problem-items)); `server_message` is the answer's own `message`. |
| `RejectedAssetError` | The refusal as the API answered it, which `upload_file` passes, and otherwise the reading of storage's status. `reason` says why. |
| `UnsupportedUploadCapabilityError` | `runtime.unsupported`, naming file upload: the deployment does not serve `/v1/upload`. |
| `UploadAuthenticationError`, `ArtifactAuthenticationError` | The credential refusal, read in this order: the server's own problem when the wrapped `ApiResponseError` answered a problem document; then what the caller knows of its own request, `auth.missing_credential` when `credential_sent` is `False` and `auth.invalid_credential` when it is `True`, since the edge's bare `401` or `403` does not say; then the wrapped error's reading of the status; and otherwise `auth.invalid_credential`. The SDK raises them without `credential_sent`, so a bare `401` reads as `auth.missing_credential` and a bare `403` as `auth.invalid_credential`, by their status, as `@pipelex/sdk` reads them. `ArtifactAuthenticationError`'s `verdict` member is the download's result so far, not the error's problem. |
| `TestFileRefusedError` | The problem of the platform's refusal it wraps, which is how the SDK raises it. Built without a cause, `auth.forbidden` for `role_not_permitted`, and `client.argument_invalid` naming `method_id` for `method_not_found` and `method_being_deleted` ([files.md](files.md#uploading-a-test-file)). |
| `UploadTransportError` | The wrapped error's problem, when its cause carries one. Otherwise by `reason`: `timeout`, `unreachable`, `storage_timeout` and `conflict` are `runtime.unavailable`; `server_error`, `unexpected` and no reason read storage's status (`runtime.unavailable` for a `408`, a `429` or a `5xx` other than `501`, `runtime.unsupported` for a `501`, `client.response_unreadable` for any other), a `server_error` with no status being `runtime.unavailable` and the others `runtime.unexpected`; `redirected` is `runtime.misconfigured`; `invalid_grant_url` is `client.response_unreadable`. |
| `MethodFileTransferError` | By `reason`: `unreachable` and `storage_error` are `runtime.unavailable`; `refused` reads storage's status, as above, `runtime.unexpected` with none; `mismatch`, downloaded bytes that are not the file listed, is `client.response_unreadable`. Neither its message nor any member carries the link ([method-trees.md](method-trees.md#when-a-transfer-fails)). |
| `ArtifactOperationError` | `runtime.unexpected` when built without a problem; the SDK gives `client.argument_invalid` where it refuses an argument (a `scope`, a bound, a location, both selectors or neither), `client.write_failed` for a directory that cannot be created, and `client.response_unreadable` for an answer the operation cannot use. |
| `ScopeUnavailableError` | `client.response_unreadable`: the run's results carry no artifact in the scope asked for. |
| `ArtifactFetchError` | The SDK gives `client.download_limit_exceeded` naming the cap for a file over it (`too_large`), `client.timeout` naming the budget for a download that ran out of time, and `client.unreachable` naming the store's origin for one that failed on the network. Otherwise by `reason` and `status`: `input.reference_not_found` naming the reference for `invalid_storage_uri`, `forbidden` and `not_found`; `client.link_refused` for `unsupported_url`, `plain_http_refused` and `redirect_refused`; for `store_error` and `store_refused`, the reading of the store's status as for any storage answer (`runtime.unavailable` for a `408`, a `429` or a `5xx` other than `501`, `runtime.unsupported` for a `501`, `client.response_unreadable` naming any other status, a `401` or a `403` included), and `runtime.unavailable` when no status is known; `runtime.unavailable` for `timeout` and `network`; and `runtime.unexpected` otherwise. |
| `FieldNotIncludedError` | `client.argument_invalid` for the `results` argument, which was read without the field; `download_artifacts` gives `client.response_unreadable` when it read the results itself and the API left the field out. |
| `CodegenError`, `CodegenLockError` | Stated by each raise site: `client.response_unreadable` for a codegen response unsafe as it stands, `client.tool_outdated` naming this SDK for a lock it cannot read, `client.file_unreadable` naming `codegen.lock` for a lock that is malformed or tracks an unsafe path, `client.write_failed` for a directory in the way of a write, and `client.target_exists` for a file codegen does not own. |

`RejectedAssetError`, `TestFileRefusedError`, `UploadTransportError`, `ArtifactFetchError` and `MethodFileTransferError` keep a `reason` from a closed vocabulary (`RejectedAssetReason`, `TestFileRefusalReason`, `UploadTransportReason`, `MethodFileTransferReason`), the same as `@pipelex/sdk`'s, which says what the SDK saw beside the problem's code.

## A refused request — `ApiResponseError`

An `ApiResponseError` is an answer that came back and that the SDK cannot hand back as a result: a non-2xx refusal, a body that arrived and could not be decoded, or a `2xx` the SDK could not read. Every route raises this one class for it: the protocol routes inherited from `mthds`, the run reads and `wait_for_result`, `start_and_wait` on either path, `health`, and every product route. It is `mthds`'s own `ApiResponseError` refined for this SDK, so a handler written against the standard's client catches it too.

| Member | What it is |
|---|---|
| `problem` | The answer read as its problem (`read_hosted_answer` in `pipelex_sdk.answer_reading`): the body itself when it is a problem document, as the hosted API answers every refusal, its `pipelex.*` code and every member the standard does not name kept on `problem.model_extra`; otherwise the edge's reading of the status ([below](#an-answer-that-is-no-problem-document)). `problem.retry_after` is filled from the `Retry-After` header when the problem invites a retry and gives none. |
| `request_id` | The problem's `request_id` member, else the answer's `X-Request-ID` header: the id to hand to support. |
| `status`, `status_text` | The answer's HTTP status, whatever the problem's own `status` says, and its reason phrase. |
| `response_body`, `headers` | The raw text, and the headers with lower-case names, so a member this SDK does not name stays reachable without re-reading the body. An answer holding signed links has every link redacted in `response_body`. |
| `request_url`, `api_url` | The URL requested and the configured base URL. |

An `ApiResponseError` built by hand takes the same keyword arguments the client passes: `problem`, the answer read as its problem, and `may_start_run`, saying the request was a start or an execute. Left without `problem`, it reads the answer itself, as the client would. The JavaScript twin names the same option `problem`.

A refusal locates its fault in the problem: `location.field` names the request field a `request.invalid` refused, its `errors` list one problem item per fault, each with its own `location`, and `params` carries what the code's registry entry names. A Pipelex refusal adds the members its code documents, such as `limit` for a copy past its bounds or an archive past its cap, read from `problem.model_extra` and typed by its model (`MethodCopyLimit.model_validate((exc.problem.model_extra or {})["limit"])`).

### An answer that is no problem document

The hosted API answers every refusal with a problem document. A body that is not one comes from the hosted edge, a gateway or a proxy, which nobody configures, and reads by its status. These rules stay written in the SDK until the registry records them and every client generates them:

| Status | Its problem |
|---|---|
| `401` | `auth.missing_credential`: the edge answers it before the platform when the request carries no credential. |
| `403` | `auth.invalid_credential`: the edge's authorizer refused the credential, or the route is outside what it may call. |
| `404` | `request.not_found`: no route matches. |
| `405` | `request.method_not_allowed`. |
| `408`, `429` | `runtime.unavailable`, with the `Retry-After` the answer gives: a proxy timed the request out, or the edge throttled it. The core registry's `account.rate_limited` names the limit and its window, which an edge throttle does not say, so a client cannot state it. |
| `500` | `runtime.unexpected`. |
| `502`, `503`, `504` | `runtime.unavailable`, with the `Retry-After` the answer gives. |
| A `2xx` the SDK could not read, and any other status | `client.response_unreadable`, naming the status. |

On a start or an execute, a `2xx` the SDK could not read, a `408` and a `5xx` other than `501` are `client.outcome_unknown` instead ([above](#a-run-that-may-have-started--outcome_unknown)).

**A missing route is a `404` that names no code of its own, or names `request.not_found`.** The run lifecycle's start and reads, the progress route among them, tell a deployment that does not serve them by that rule. A `404` whose body is a JSON object naming a non-empty string `code` is a route naming something that does not exist, such as `run.not_found`, a runner's `method.not_found`, or the `run_not_found` and `not_found` of a native body the platform still answers, and it is an `ApiResponseError` even when the rest of the document has a defect. A `404` whose body names no such code, such as a bare runner's framework default `{"detail": "Not Found"}` or an empty or non-JSON body, and a `request.not_found` problem document, which a runner answers for a path no route serves from pipelex-api 0.90 on, are a route the deployment lacks, raised as `RunLifecycleUnavailableError`. So a start that a hosted API refuses with a `404` for a method that does not exist stays that refusal, and never sends the run to the blocking execute.

**An answer the SDK could not read.** A `2xx` whose body is not UTF-8 or not JSON, such as a gateway's HTML page or an empty body where the route answers one, is no result the SDK can hand back, and JSON the protocol refuses is not JSON here: every body is decoded by the rules `mthds` reads a problem body by (`decode_json` in `mthds.protocol.problem.answers`), its numbers kept as written, as `@pipelex/sdk` reads it, so a body nested deeper than the protocol's limit or holding `NaN`, `Infinity` or a number past the range of a double is a body that is not JSON. A `2xx` whose body is JSON but not what the route answers is no result either: `null` or a list where an object is due, an object missing a member the route's model requires or carrying one of the wrong type, a publish result naming no known `outcome`, an `upload` answer with no non-empty `uri`. Every route raises an `ApiResponseError` for it rather than letting the `json.JSONDecodeError`, `UnicodeDecodeError` or pydantic `ValidationError` of the parse escape. Its message is `API <METHOD> <path> answered <status> with <what>`, `what` naming the failure (`a body that is not JSON`, `a body that is not UTF-8`, `an empty body where JSON was expected`, `a body that is not an object`, or `a body that is not the answer the route returns`), `__cause__` is the parse failure, and its problem is `client.response_unreadable`, or `client.outcome_unknown` on `start`, `execute` and the start of `start_and_wait`. `upload_file` and `prepare_inputs` wrap it, as they wrap every upload failure, in an `UploadTransportError` whose reason is `unexpected`, since whether and where the file was stored is unknown. A product route that answers a `2xx` with no body at all, such as `revoke_pipelex_api_key`, still returns `None`.

### The method codes

A refusal about a saved method, one of its versions or a copy of it carries one of the codes `MethodErrorCode` in `pipelex_sdk.errors` names, a `StrEnum` whose members equal their strings, so `match exc.problem.code:` takes `case MethodErrorCode.NOT_PUBLISHED:`. `problem.code` stays a `str`, since the registry adds codes; every one of these has `domain` `input` and `retry` `no`.

| Member | `code` | Status | When |
|---|---|---|---|
| `UPDATE_CONFLICT` | `pipelex.catalog.update_conflict` | `409` | The draft moved since the token a `write_draft` or a `publish_method` sent; nothing was written or published. `location.field` names the request field that carried the token. |
| `BEING_DELETED` | `pipelex.catalog.being_deleted` | `409` | The method's erasure has started, on every route that addresses it. |
| `NOT_PUBLISHED` | `pipelex.catalog.not_published` | `409` | A bare `method_id`, which names the latest published version, for a method never published. Publish it, or address its draft as `mt_…@draft`. |
| `NOT_FOUND` | `pipelex.catalog.not_found` | `404` | The method is not one of the organization's, or `mt_…@<n>`, or `get_method_version`, names a version the method never published. |
| `ORGANIZATION_NOT_FOUND` | `pipelex.org.not_found` | `404` | A `copy_method` destination the caller does not belong to, still being set up or that does not exist, all answered alike. |
| `COPY_TOO_LARGE` | `pipelex.catalog.copy_too_large` | `422` | A `copy_method` past one of the copy's bounds on its stored files, which the problem's `limit` member names (`MethodCopyLimit`). |

A malformed version suffix (`@0`, `@03`, `@Draft`, two suffixes) is a `422` `request.invalid` whose `location.field` is `method_id`; `parse_method_selector` refuses the same selectors locally with a `RequestArgumentError`, before anything is sent.

### The branding and files codes

A refused branding write (`update_organization_branding`) is one problem naming each logo or colour it refused as an item of its `errors`: the item's `location.field` is the logo's slot, `square_logo` or `wide_logo`, or the colour's dotted key, such as `colors.action`, and its `detail` the sentence a settings screen shows under that control; a logo the platform read and refused carries one item per broken rule, each item's code one `LogoRefusalCode` names ([organization-branding.md](organization-branding.md)). A zip asked for past a cap (`request_file_archive`) carries a `limit` member, typed by `FileArchiveLimit.model_validate((exc.problem.model_extra or {})["limit"])`: the cap's `name` (`max_files` or `max_total_bytes`), its `value` and what the selection `reached`. A file link refused for one file is not an error at all but that item's `error` in a `200` answer. [files.md](./files.md) gives every refusal of each files route.

## A failed run — `RunFailedError`

A run that ended without success is `run.failed`, naming the run as its `pipeline_run_id` and its terminal status as the `run_status` parameter, with `retry` `no`: the run is over, and starting it again spends credit. Why it did not succeed is the **run's own problem**, which `run.failed` nests as `run_error`: a problem under its own code (`run.cancelled`, `run.timed_out`, a model's code such as `model.unavailable`, a method's such as `method.invalid` with its items), with its own `domain`, `retry` and `next_step`. Branch on it to tell a run worth starting again from one whose method or inputs must change.

The SDK reads a failed run in each of these places, and the run's own problem is the same object in each:

| Where | What it carries |
|---|---|
| `RunFailedError`, raised by `wait_for_result`, `start_and_wait` and `download_artifacts` when the results read answers `409` | `problem` is the results read's `run.failed` document as the platform answered it, or the one the SDK builds for a failed run it learned of otherwise (`run_failed_problem`); `run_error` is the nested run problem, `None` when the run ended with none stored; `status` is the terminal `RunStatus` and `run_id` the run. |
| `get_run_result`'s `RunResultFailed` arm | `state`, `pipeline_run_id`, `status`, `message`, `problem` and `error`: `problem` is the `run.failed` document, `status` the status its `run_status` names (`FAILED` when it names none the SDK knows), `message` its `detail`, and `error` the nested run problem, `None` when there is none. |
| `get_run_status`'s `RunRead.error`, and a run row's `error` in `list_runs` | The run's own problem, as the status read serves it; `None` while the run has none, and when the platform serves something that is no problem document (`LenientProblem`). |

The results read's `409` is read for `run.failed` and for `run.not_finished` alone; any other `409` is an `ApiResponseError`. `nested_run_error(problem)` in `pipelex_sdk.errors` reads the nested problem off any `run.failed`.

```python
from mthds.protocol.problem.models import RetryVerdict

from pipelex_sdk.errors import RunFailedError

try:
    results = await client.wait_for_result(run_id)
except RunFailedError as exc:
    why = exc.run_error
    if why is not None and why.effective_retry == RetryVerdict.YES:
        return start_again()
    return show_the_failure(why.detail if why is not None else exc.problem.detail)
```

**A model the deployment does not serve.** A run refused because no backend serves the model a pipe asks for nests `model.unavailable`, `domain` `operator` and `retry` `no`, whose `params` name the `model`, its `model_type` and the `reason`, and whose `next_step` is `fix_configuration`: the deployment's operator configures a backend for the model, or the method's author picks one the deployment serves.

## A verdict's problem items

A method refused for what it says, rather than for how its run went, comes back as a list of the standard's problem items, `ProblemItem` from `mthds.protocol.problem.models`. They ride the `/v1/validate` verdict (its invalid arm's `errors`, `PipelexInvalidReport`, and the advisory `warnings` of its valid arm), the crate routes' invalid verdict (`CrateInvalidReport.errors`), each a `200` because an invalid bundle is a produced verdict; the pipe I/O answer that does not load, as `MethodLoadError`'s `problem.errors`; the `errors` of a refusal's problem, such as the `422` a run route answers when the runner refuses the method; and a failed run's `run_error.errors`.

| Member | Meaning |
|---|---|
| `code` | The fault's registered code, such as `method.concept_unresolved`, `method.pipe_unresolved` or `model.unknown`. |
| `detail` | What is wrong, in words. |
| `params` | What the code's registry entry names: the concept or pipe a reference names, the model reference exactly as the author wrote it, and the like. |
| `location` | Where the fault is: its `file` (the tree path in the tree the request sent), `pipe`, `field`, `input`, `path`, `line` and `column`, each present when the runner knows it. |
| `suggestions` | The close matches, each spelled as a value the field accepts. |
| `suggested_fix` | The runner's deterministic correction, when it has one: the standard's `SuggestedFix`, with a `fix_code`, a `description` in words, a `safety` (`safe` to apply without asking, or `unsafe`), the `file` the ops apply to, and `ops` that patch the `.mthds` document by table and key rather than by text, each one of the standard's fix operations (`SetKeyOp`, `EnsureTableOp`, `DeleteKeyOp`, `DeleteTableOp`, `RenameTableKeyOp`, `MoveKeyOp`, `RemapValueOp`), an operation of a kind this version does not know read as `UnknownFixOp`. |

```python
report = await client.validate(directory="methods/receipts")
if not report.is_valid:
    for item in report.errors:
        where = item.location.file if item.location is not None else "?"
        print(f"{where}: {item.detail}")
        if item.suggestions:
            print(f"Did you mean: {', '.join(item.suggestions)}")
        if item.suggested_fix is not None:
            print(f"Fix: {item.suggested_fix.description}")
```

**A verdict's items and the pipe I/O answer's are read member by member.** One malformed member never costs the caller the fault it belongs to: an entry that is no object, or whose `code` or `detail` is not a string, names no fault and is skipped, and each optional member the standard declares (`params`, `location`, `suggestions`, `suggested_fix`) is kept only when the standard's own model accepts it, and left out of its item otherwise. A member the standard does not declare is kept as received, and an item a verdict built in code is given as a `ProblemItem` is kept as it is. `pipelex_sdk.problem_items` is that reader, and `@pipelex/sdk`'s `readProblemItems` reads them the same way. A refusal's problem and a run's `run_error` are not read this way: the standard's reader checks each whole, items included, so one malformed item makes a refusal's body no problem document, which the SDK then reads by its status, and makes a `run_error` no problem, so the run's own problem reads as `None`.

## The case file both SDKs run

**The problems are a contract with `@pipelex/sdk`.** `tests/fixtures/sdk-problems.json` pins each failure both SDKs detect to its problem code: the answers the hosted API, its edge or a proxy can give (a problem document read as received, each bare status, each start or execute whose run may exist), the readings of a storage answer's status and of each transfer failure's reason, and each error class built from the arguments it takes, with the code and the members its problem must carry. Its source is `js/tests/fixtures/sdk-problems.json`; `make shared-files` at the repository's root writes this package's byte for byte identical copy, and `make check-shared-files` fails on a stale one, so a change to a problem is made in the source, copied, and then made in both packages. `tests/unit/test_sdk_problems.py` drives this package's code through every case.
