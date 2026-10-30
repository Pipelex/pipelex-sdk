# Errors — the problem every error carries

Every error `@pipelex/sdk` throws carries its failure as one **problem document**, the RFC 9457 document the MTHDS standard defines, under a registered code. A refusal the hosted API answers is read as the problem document it sends, a failed run as the problem the platform stored for it, and a failure the SDK detects itself (an argument it refuses, a request that got no answer, an answer it cannot read, a run that may have started without its id reaching the caller) as a problem the SDK builds under a `client.*` code or another core code. A program branches on the problem, never on a class, an HTTP status or the wording of a message. The Python SDK, `pipelex-sdk`, raises the same code for every failure, and a case file the two packages share holds them to it ([below](#the-case-file-both-sdks-run)).

## The problem every error carries

Every error class the SDK exports derives from the standard's `ProblemError` (from `mthds/protocol`), and every one thrown over a request from the abstract `PipelexRequestError`, itself the standard's `PipelineRequestError`. So `instanceof ProblemError`, `instanceof PipelineRequestError` and the standard's `isProblemError` match every SDK error, and every getter that reads the problem is on each of them:

| Member | What it says |
|---|---|
| `problem` | The problem document whole, typed as the standard's `Problem`. A member the standard does not name, such as a Pipelex refusal's `limit`, rides it as received (`problem.limit`). |
| `code` | The registered code a program branches on: a core code (`client.unreachable`, `auth.invalid_credential`, `request.invalid`, `run.failed`, `method.invalid`, `model.unavailable`, …) or a Pipelex one (`pipelex.catalog.not_found`, `pipelex.billing.plan_limit`, …). |
| `domain` | Who must act: `input` (the caller changes the request), `method` (the method's author changes the method), `account` (the account's owner changes a credential, a plan or a role), `operator` (whoever runs the deployment changes its configuration) or `runtime` (nobody beforehand: a fault in the service). |
| `retry` | Whether sending the same request again can succeed: `yes`, `no`, or `outcome_unknown` when the request may have taken effect and its outcome must be read before anything is sent again ([below](#a-run-that-may-have-started--outcome_unknown)). |
| `retryAfter` | The seconds to wait before a repeat, when the problem gives them. |
| `nextStep` | What to do, as a `kind` a program branches on and a `detail` a person reads. |
| `requestId` | The id to hand to support, when the answer carried one. |

The rest of the problem, `params`, `location`, `errors` and `pipeline_run_id`, is read off `problem`. The message stays the SDK's own sentence, as it always was: the standard's errors append the problem's next step to their message, and the SDK's do not, since `problem.detail` and `problem.next_step.detail` are there for whoever renders them.

```ts
import { isProblemError } from "mthds/protocol";

try {
  await client.startAndWaitForResult({ method_id: "mt_abc123", inputs });
} catch (err) {
  if (!isProblemError(err)) throw err; // not an SDK failure: a bug, or the caller's own abort
  if (err.retry === "outcome_unknown") return lookUpTheRunBeforeStartingAgain(err);
  if (err.retry === "yes") return scheduleRetry(err.retryAfter);
  switch (err.domain) {
    case "input":
    case "method":
      return askTheUserToFix(err.problem);
    default:
      return reportToOperator(err.problem);
  }
}
```

**What carries no problem.** The `RangeError` or `TypeError` the SDK raises for an argument of the wrong type or range before any request is sent (a `timeoutMs` out of range, a malformed `appInfo`, an artifact selection that is not an array) names a bug in the calling code, and the caller's own abort is rethrown untouched. The per-reference errors inside a `downloadArtifacts` verdict are values with a `code`, not thrown errors. An argument the client refuses for what it asks, such as two method selectors given to `validate` or `execute`, or a base URL with a path, is a `RequestArgumentError`, which carries a problem like every SDK error.

### A run that may have started — `outcome_unknown`

A request that may create a run is a `start` or a blocking `execute`, and inside `startAndWaitForResult` the start and the blocking execute it falls back to against a bare runner. When one of them fails in a way that may have started a run whose id never reached the caller, its problem is `client.outcome_unknown`, whose `retry` is `outcome_unknown`: sending the start again could start a second paid run, so the caller looks the run up in the run history (`listRuns`) first, or sends it again under the same idempotency key ([below](#a-starts-idempotency-key--idempotencykey)). The problem names the run as its `pipeline_run_id` when the answer named one.

| Failure of a start or an execute | Its problem |
|---|---|
| A problem document from the hosted API, whatever its status | As received: the platform's own `retry` says whether a run may exist, so a `503` it answers before dispatching the run says `yes`, and one it answers once a run may exist says `outcome_unknown`. |
| An `ApiUnreachableError` that proves nothing was sent: the name lookup, the connection or the TLS handshake failed | `client.unreachable`, `retry` `yes`. |
| Any other `ApiUnreachableError`: a reset, a time limit | `client.outcome_unknown`. |
| A body that arrived and could not be decoded | No `ApiUnreachableError`, since an answer came back: an `ApiResponseError` read by its status with an empty body, as the rows below read an answer, so a `2xx` is `client.outcome_unknown`. |
| A `2xx` the SDK could not read, a start acknowledgement or an execute `202` naming no run included | `client.outcome_unknown`: the server accepted the request. |
| A `408`, or a `5xx` other than `501`, whose body is no problem document | `client.outcome_unknown`, whatever the time it took: a proxy or the gateway answered for a request it may have forwarded. |
| A `501` whose body is no problem document | `client.response_unreadable`: the deployment does not serve the route. |
| Any other status whose body is no problem document | The edge's reading of that status ([below](#an-answer-that-is-no-problem-document)). |
| `PipelineExecuteTimeoutError` | `client.outcome_unknown`: the gateway cut the execute off, and the run goes on. |
| `RunLifecycleUnavailableError`, `RequestArgumentError`, an input preparation error | Its own problem, never `outcome_unknown`: nothing that starts a run was sent. |

Once `onStarted` has been called the run exists and the caller holds its id, so an error while `startAndWaitForResult` waits started nothing: its `retry` is about waiting again on that id, never about calling the composite again. `RunStillRunningError`, the `202` a blocking execute answers for a run still going, names its run, so it is `client.follow_failed`, whose `retry` is `outcome_unknown` too and whose next step is `read_run`: the run exists, and the caller reads it by the id the problem names rather than start it again.

**A request the gateway cut off: `isGatewayCutOff`.** The hosted gateway gives up on a request it waits on at about 30 seconds and answers `503` or `504`, while the server may still be handling it. `isGatewayCutOff(error, elapsedMs)` tells such a failure from a refusal: it is `true` when, at least ~28 seconds after the request was sent, the failure is a `503` or `504` answer whose body is no problem document, or the client's own time limit (`ApiUnreachableError` whose `networkCode` is `ABORT_TIMEOUT`), and `false` before then and for any other failure, a problem document being the API's own answer however long it took. The blocking `execute` applies it and throws `PipelineExecuteTimeoutError`, timing the request on the monotonic clock `performance.now`. A caller no longer needs it to learn whether a failed start may have created a run, since the problem says so whatever the timing. The fetch API cannot say whether `ABORT_TIMEOUT` ran out before the connection was made, so the rule reads it as the gateway's; with Node's own dispatcher it never does past the threshold, since undici gives up a connection that does not come after ten seconds (`UND_ERR_CONNECT_TIMEOUT`), the TLS handshake included. The Python SDK's `is_gateway_cut_off` is the same rule.

### A start's idempotency key — `idempotencyKey`

`start`, and so `startAndWaitForResult`, takes an optional `idempotencyKey`, which the SDK sends as the `Idempotency-Key` header of `POST /v1/start`; without one it sends no header. The hosted API binds the key to the run before it dispatches it, so the same start sent again under the same key is answered with that run and starts nothing, however the first attempt ended. A caller that sent a key therefore answers a failure whose `retry` is `outcome_unknown` by sending the same start again, with the same key and the same options, and gets the run back instead of paying for a second one. The problem does not say so itself: it stays `outcome_unknown` with a key, since the SDK cannot know that the server honours the key (a bare runner ignores it), and a retry under a new key, or with other options, would start a second run.

Generate one key per run you mean to start (a `crypto.randomUUID()` is a good one), and keep it with the options across that start's retries. A key is 1 to 255 visible ASCII characters, `!` to `~`; anything else, an empty string included, is a `RequestArgumentError` naming `idempotency_key` before anything is sent, since a start sent without the key its caller gave would lose the protection without a word.

```ts
// One key per run, kept with the options, unchanged, across the start's retries.
const options = { method_id: "mt_abc123", inputs, idempotencyKey: crypto.randomUUID() };
try {
  return await client.start(options);
} catch (err) {
  // Under the same key, a start that may have started a run is answered with that run.
  if (isProblemError(err) && err.retry !== "no") return await client.start(options);
  throw err;
}
```

What the hosted API answers a start sent under a key:

| The start | The answer |
|---|---|
| The first under the key | The run starts, the key bound to it before it is dispatched. |
| The same options under the same key, once the first was answered or bound to its run | The first start's acknowledgement, the run's state as it stands, and nothing starts. A first start refused for its content is refused again; one refused for its timing, such as a `429` in front of the runner, freed the key, and the retry is handled afresh. |
| The same options under the same key, while the first is still being handled | After a short wait, the first start's answer; failing that, a `409` `request.idempotency_key_in_use`, `retry` `yes`, whose `retryAfter` says how long to wait. Nothing ran for it: send it again under the same key, never under a new one, which would start a second run. |
| Other options under the same key | A `409` `request.idempotency_conflict`, `retry` `no`: a key reused for another request is a bug in the caller. Send the new request under a new key. |
| The same options under a key bound to a run since deleted | A `409` `request.idempotency_conflict` too: send it under a new key to start a new run. |

`IdempotencyErrorCode` names both codes. The hosted API keeps a key for 24 hours, scoped to the caller and the organization, so a start sent again after that starts a new run.

**Keep the body identical.** The hosted API compares the request's bytes, so the retry must carry the same options in the same form. The SDK builds the same body from the same options, but inputs prepared twice are not the same options: `prepareInputs` uploads a local file again and returns a new storage reference each time, so prepare the inputs once and reuse what it returned for every attempt.

**A bare runner ignores the key.** It has no idempotency to honour, so a key sent to one protects nothing, and `startAndWaitForResult`'s blocking execute against one sends none.

**A copy takes a key too.** `copyMethod` sends an `idempotencyKey` the same way, held to the same rule, and the hosted API keeps it for the same 24 hours, scoped to the caller and the method's organization. A copy binds no run, so its answers under a key differ from a start's: [method-copy.md](./method-copy.md#retrying-a-copy--idempotencykey) gives them.

**So do a secret rotation and a delivery replay.** `rotateWebhookSecret` and `replayRunWebhookDelivery` send an `idempotencyKey` the same way, held to the same rule. A rotation's answer carries a secret, so the platform never replays it, while a replay's stored answer is given again: [webhooks.md](./webhooks.md) gives both.

## Each class's problem

The classes remain, so a `catch` can still tell an argument refusal from a refused request or a failed run, but every one carries its failure as its problem, and the code is what a program branches on.

| Class | Its problem |
|---|---|
| `ApiResponseError` | The answer read as its problem: the body when it is a problem document, otherwise the edge's reading of its status ([below](#a-refused-request--apiresponseerror)). |
| `RequestArgumentError` | `client.argument_invalid`, naming the argument and why it was refused: no run source given to `execute` or `start`, run sources or method selectors that exclude each other, a selector rule of `validate`, the method's tree given in two forms, holding no file, or in a directory the standard's lister refuses, a tree past the inline limit of an API that keeps no blob store, a reserved key in `extra`, a `publishMethod` without its token, a `getMethodVersion` version that is not a positive integer, an id a route puts in its path that is empty, `.` or `..`, is not a string or holds a lone surrogate, an example write missing what it needs, a selector `parseMethodSelector` refuses, an artifact selection that is empty or names an unknown artifact, a `copyMethod` argument of the wrong type, an `idempotencyKey` outside its rule, or a request body JSON cannot carry. A base URL that is not host-only is `client.not_configured` naming `base_url` instead, since it typically comes from `PIPELEX_BASE_URL`; that refusal shows the base URL's scheme and host alone. One built from a message alone names the argument `arguments`, for the reason `unspecified`. |
| `ApiUnreachableError` | `client.unreachable`, naming the base URL; `client.timeout`, naming the time limit, when the client's own limit ran out (`networkCode` `ABORT_TIMEOUT`); and `client.outcome_unknown` on a start or an execute that may have left ([above](#a-run-that-may-have-started--outcome_unknown)). `networkCode` is the underlying network error code when there is one. |
| `PipelineExecuteTimeoutError` | `client.outcome_unknown`: the gateway cut the blocking execute off and the run goes on; start the next one and poll instead. |
| `RunFailedError` | `run.failed`, naming the run and its status, with the run's own problem nested as `run_error` ([below](#a-failed-run--runfailederror)). |
| `RunTimeoutError`, `RunStillRunningError` | `client.follow_failed`, naming the run, with `retry` `outcome_unknown` and the step `read_run`: the run keeps going, and is read again by its id, never started again. |
| `RunLifecycleUnavailableError` | `runtime.unsupported`, naming the run lifecycle: the base URL points at a bare runner without it, or, for `getRunProgress`, at a hosted API older than the progress route. |
| `MissingMainStuffError`, `PagingNotTerminatingError` | `client.response_unreadable`: the API broke its own contract on a completed run, or minted cursors forever (`pageLimit` is the ceiling the iterator stopped at). |
| `InputPreparationError` | `client.argument_invalid` naming `inputs` when built from a message alone; the SDK passes the precise problem wherever it throws one, and `prepareInputs` gives `client.response_unreadable` for a pipe I/O answer that breaks the route's contract. |
| `InvalidLocalSourceError`, `InvalidInputValueError` | `input.file_unreadable` for a local file the inputs name that cannot be read, and `input.invalid` for a value at a file input that is no file. |
| `UploadNotAllowedError` | `client.argument_invalid`: a value that would be uploaded while uploads are off. |
| `MethodLoadError` | `method.invalid`, whose `errors` are the pipe I/O answer's problem items ([below](#a-verdicts-problem-items)); `serverMessage` is the answer's own `message`. |
| `RejectedAssetError` | The refusal as the API answered it, which `uploadFile` passes, and otherwise the reading of storage's status. `reason` (`too_large`, `grant_used`, `grant_expired`, `signature_mismatch`, `unsigned_header`, `store_refused`) says why. |
| `UnsupportedUploadCapabilityError` | `runtime.unsupported`, naming file upload: the deployment does not serve `/v1/upload`. |
| `UploadAuthenticationError`, `ArtifactAuthenticationError` | The credential refusal, read in this order: the server's own problem when the wrapped `ApiResponseError` answered a problem document; then what the caller knows of its own request, `auth.missing_credential` when `options.credentialSent` says it carried no credential and `auth.invalid_credential` when it says it did, since the edge's bare `401` or `403` does not say; then the wrapped error's reading of the status; and otherwise `auth.invalid_credential`. The SDK throws them without `credentialSent`, so a bare `401` reads as `auth.missing_credential` and a bare `403` as `auth.invalid_credential`, by their status, as the Python twin reads them. `ArtifactAuthenticationError`'s `verdict` member is the download's result so far, not the error's problem. |
| `TestFileRefusedError` | The problem of the platform's refusal it wraps, which is how the SDK throws it. Built without a cause, `auth.forbidden` for `role_not_permitted`, and `client.argument_invalid` naming `method_id` for `method_not_found` and `method_being_deleted` ([files.md](./files.md#uploading-a-test-file)). |
| `UploadTransportError` | The wrapped error's problem, when `cause` carries one. Otherwise by `reason`: `timeout`, `unreachable`, `storage_timeout` and `conflict` are `runtime.unavailable`; `server_error`, `unexpected` and no reason read storage's status (`runtime.unavailable` for a `408`, a `429` or a `5xx` other than `501`, `runtime.unsupported` for a `501`, `client.response_unreadable` for any other), a `server_error` with no status being `runtime.unavailable` and the others `runtime.unexpected`; `redirected` is `runtime.misconfigured`; `invalid_grant_url` is `client.response_unreadable`. |
| `MethodFileTransferError` | By `reason`: `unreachable` and `storage_error` are `runtime.unavailable`; `refused` reads storage's status, as above, `runtime.unexpected` with none; `mismatch`, downloaded bytes that are not the file listed, is `client.response_unreadable`. It carries `operation`, `reason`, `sha256`, `path` and `status`, and neither the link, nor storage's error body, nor a cause ([method-trees.md](./method-trees.md#when-a-transfer-fails)). |
| `ArtifactOperationError` | `runtime.unexpected` when built without a problem; the SDK gives `client.argument_invalid` where it refuses an argument (a `scope`, a bound, a location), `runtime.unsupported` for a runtime with no filesystem, `client.write_failed` for a directory that cannot be created, and `client.response_unreadable` for a resolution that answered the wrong count of items. |
| `ScopeUnavailableError` | `client.response_unreadable`: the run's results carry no artifact in the scope asked for. |
| `ArtifactFetchError` | The SDK gives `client.download_limit_exceeded` naming the cap for a file over it (`too_large`), `client.timeout` naming the budget for a download that ran out of time, and `client.unreachable` naming the store's origin for one that failed on the network. Otherwise by `reason` and `status`: `input.reference_not_found` naming the reference for `invalid_storage_uri`, `forbidden` and `not_found`; `client.link_refused` for `unsupported_url`, `plain_http_refused` and `redirect_refused`; for `store_error` and `store_refused`, the reading of the store's status as for any storage answer (`runtime.unavailable` for a `408`, a `429` or a `5xx` other than `501`, `runtime.unsupported` for a `501`, `client.response_unreadable` naming any other status, a `401` or a `403` included), and `runtime.unavailable` when no status is known; `runtime.unavailable` for `timeout` and `network`; and `runtime.unexpected` otherwise. |
| `CodegenLockError` | `client.file_unreadable` naming `codegen.lock` for a lock that is malformed or tracks an unsafe path, `client.tool_outdated` naming this SDK for a lock newer than it reads, and `client.argument_invalid` naming `files` for a supplied tree holding an unsafe or duplicate path. It extends `ProblemError` rather than `PipelexRequestError`, since nothing was requested. |
| `ExactJsonUnsupportedError` | `client.tool_outdated`, naming the JavaScript runtime: `parseExactJson` met a number past `Number.MAX_SAFE_INTEGER` on a runtime whose `JSON.parse` hands a reviver no source text ([exact-integers.md](./exact-integers.md)). It extends `ProblemError`; the client reports it as the `ApiResponseError` of an answer it cannot read, with this error as `cause`. |

`RejectedAssetError`, `TestFileRefusedError`, `UploadTransportError`, `ArtifactFetchError` and `MethodFileTransferError` keep a `reason` from a closed vocabulary (`RejectedAssetReason`, `TestFileRefusalReason`, `UploadTransportReason`, `MethodFileTransferReason`), the same as the Python SDK's, which says what the SDK saw beside the problem's code.

## A refused request — `ApiResponseError`

An `ApiResponseError` is an answer that came back and that the SDK cannot hand back as a result: a non-2xx refusal, a body that arrived and could not be decoded, or a `2xx` the SDK could not read (a body that is not JSON, JSON that is not the object the route answers, a stored method whose `python` field is not the serialized file list). Every route throws this one class for it: the protocol routes, the run lifecycle and every product route.

| Member | What it is |
|---|---|
| `problem` | The answer read as its problem (`readHostedAnswer`): the body itself when it is a problem document, as the hosted API answers every refusal, its `pipelex.*` code and every member the standard does not name kept; otherwise the edge's reading of the status ([below](#an-answer-that-is-no-problem-document)). |
| `code`, `domain`, `retry`, `nextStep` | The problem's, as on every error. |
| `retryAfter` | The problem's `retry_after`, which the `Retry-After` header fills when the problem invites a retry and gives none. |
| `requestId` | The problem's `request_id`, else the answer's `X-Request-ID` header: the id to hand to support. |
| `status`, `statusText` | The answer's HTTP status, whatever the problem's own `status` says, and its reason phrase. |
| `responseBody` | The raw text, so a member this SDK does not name stays reachable without re-reading the body. |
| `apiUrl` | The base URL the request went to. |

`ApiResponseErrorOptions` is `{ cause, problem, headers, mayStartRun }`: the client passes the `problem` it read and the answer's `headers`, and an error built by hand without them reads the answer itself, as the client would, `mayStartRun` saying the request was a start or an execute. The Python twin names the same option `problem`.

A refusal locates its fault in the problem: `location.field` names the request field a `request.invalid` refused, its `errors` list one problem item per fault, each with its own `location`, and `params` carries what the code's registry entry names (a model, a limit, a status). A Pipelex refusal adds the members its code documents, such as `limit` for a copy past its bounds or an archive past its cap, read from `problem` as received.

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

**A missing route is a `404` that names no code of its own, or names `request.not_found`.** The run lifecycle's start and reads, the progress route among them, tell a deployment that does not serve them by that rule. A `404` whose body is a JSON object naming a non-empty string `code` is a route naming something that does not exist, such as `run.not_found`, a runner's `method.not_found`, or the `run_not_found` and `not_found` of a native body the platform still answers, and it is an `ApiResponseError` even when the rest of the document has a defect. A `404` whose body names no such code, such as a bare runner's framework default `{"detail": "Not Found"}` or an empty or non-JSON body, and a `request.not_found` problem document, which a runner answers for a path no route serves from pipelex-api 0.90 on, are a route the deployment lacks, thrown as `RunLifecycleUnavailableError`. So a start that a hosted API refuses with a `404` for a method that does not exist stays that refusal, and never sends the run to the blocking execute.

**An answer the SDK could not read.** Every body is decoded by the rules `mthds` reads a problem body by, its numbers kept as written, so a body nested deeper than the protocol's limit or holding `NaN`, `Infinity` or a number past the range of a double is a body that is not JSON. Its message is `API <METHOD> <path> answered <status> with <what>`, `what` naming the failure (`a body that is not JSON`, `a body that is not UTF-8`, `an empty body where JSON was expected`, `a body that is not an object`, or `a body that is not the answer the route returns`), the parse failure is its `cause`, and its problem is `client.response_unreadable`, or `client.outcome_unknown` on a start or an execute. `uploadFile` and `prepareInputs` wrap it, as they wrap every upload failure, in an `UploadTransportError` whose reason is `unexpected`, since whether and where the file was stored is unknown.

### The method codes

A refusal about a saved method, one of its versions or a copy of it carries one of the codes the exported type `MethodErrorCode` names. `code` itself stays a `string`, since the registry adds codes; every one of these has `domain` `input` and `retry` `no`, since asking again unchanged meets the same answer.

| `code` | Status | When | What the caller does |
|---|---|---|---|
| `pipelex.catalog.update_conflict` | `409` | The draft moved since the token a `writeDraft` (`expected_updated_at`) or a `publishMethod` (`expected_draft_updated_at`) sent; nothing was written or published. `location.field` names the request field that carried the token. | Read the method again, and either load its draft or overwrite it by writing again with the fresh token. |
| `pipelex.catalog.being_deleted` | `409` | The method's erasure has started, on every route that addresses it; the detail tells an erasure in flight from a failed one. | Stop offering the method; retry the delete when the detail says it failed. |
| `pipelex.catalog.not_published` | `409` | A bare `method_id`, which names the latest published version, on a run or tooling route, for a method never published. | Publish the method, or address its draft as `mt_…@draft`. |
| `pipelex.catalog.not_found` | `404` | The method is not one of the organization's, or `mt_…@<n>`, or `getMethodVersion`, names a version the method never published. | Pick a method `listMethods` lists, or a version `listMethodVersions` lists. |
| `pipelex.org.not_found` | `404` | A `copyMethod` destination the caller does not belong to, whose invitation they have not accepted, that is still being set up or that does not exist, all answered alike, so the platform never says whether an organization exists. | Copy into an organization `listMemberships` lists, where the caller's role changes methods. |
| `pipelex.catalog.copy_too_large` | `422` | A `copyMethod` whose stored files pass one of the copy's bounds; the problem's `limit` member, typed `MethodCopyLimit`, names the bound (`max_stored_files` or `max_stored_bytes`), its `value` and what the copy `reached`. | Remove examples, or the files their inputs name, from the original, then copy again. |

A malformed version suffix (`@0`, `@03`, `@Draft`, two suffixes) is a `422` `request.invalid` whose `location.field` is `method_id`; `parseMethodSelector` refuses the same selectors locally with a `RequestArgumentError`, before anything is sent. So is any suffix on the run routes' linkage form, a `method_id` beside an inline source, which `execute` and `start` refuse locally the same way.

### The branding codes

A refused branding write (`updateOrganizationBranding`) is one problem naming each logo or colour it refused as an item of its `errors`: the item's `location.field` is the logo's slot, `square_logo` or `wide_logo`, or the colour's dotted key, such as `colors.action`, and its `detail` the sentence a settings screen shows under that control. A logo the platform read and refused carries one item per broken rule, both slots at once, each item's code one the exported type `LogoRefusalCode` names (`logo_too_large`, `logo_not_square`, `logo_too_small`, …). [organization-branding.md](./organization-branding.md#when-a-write-is-refused) lists every code with a sentence of each.

### The files codes

A zip asked for past a cap (`requestFileArchive`) carries a `limit` member beside the others, typed `FileArchiveLimit`: the cap's `name` (`max_files` or `max_total_bytes`), its `value` and what the selection `reached`, so a client can say how far over the selection is and split it. A file link refused for one file is not an error at all but that item's `error` in a `200` answer. [files.md](./files.md) gives every refusal of each files route.

## A failed run — `RunFailedError`

A run that ended without success is `run.failed`, naming the run as its `pipeline_run_id` and its terminal status as the `run_status` parameter, with `retry` `no`: the run is over, and starting it again spends credit. Why it did not succeed is the **run's own problem**, which `run.failed` nests as `run_error`: a problem under its own code (`run.cancelled`, `run.timed_out`, a model's code such as `model.unavailable`, a method's such as `method.invalid` with its items), with its own `domain`, `retry` and `next_step`. Branch on it to tell a run worth starting again from one whose method or inputs must change.

The SDK reads a failed run in each of these places, and the run's own problem is the same object in each:

| Where | What it carries |
|---|---|
| `RunFailedError`, thrown by `waitForResult`, `startAndWaitForResult` and the artifact download when the results read answers `409` | `problem` is the results read's `run.failed` document as the platform answered it, or the one the SDK builds for a failed run it learned of otherwise (`runFailedProblem`); `runError` is the nested run problem, `undefined` when the run ended with none stored; `status` is the terminal status and `runId` the run. |
| `getRunResult`'s `failed` arm | `{ state: "failed", pipeline_run_id, status, message, problem, error }`: `problem` is the `run.failed` document, `status` the status its `run_status` names (`FAILED` when it names none the SDK knows), `message` its `detail`, and `error` the nested run problem, `null` when there is none. |
| `getRunStatus`'s `error`, and a run row's `error` in `listRuns` | The run's own problem, as the status read serves it; `null` while the run has none, and when the platform serves something that is no problem document. |

The results read's `409` is read for `run.failed` and for `run.not_finished` alone; any other `409` is an `ApiResponseError`.

```ts
try {
  await client.waitForResult(runId);
} catch (err) {
  if (err instanceof RunFailedError) {
    const why = err.runError;
    if (why?.retry === "yes") return startAgain();
    return showTheFailure(why?.detail ?? err.problem.detail, why?.next_step.detail);
  }
  throw err;
}
```

**A model the deployment does not serve.** A run refused because no backend serves the model a pipe asks for nests `model.unavailable`, `domain` `operator` and `retry` `no`, whose `params` name the `model`, its `model_type` and the `reason`, and whose `next_step` is `fix_configuration`: the deployment's operator configures a backend for the model, or the method's author picks one the deployment serves.

## A verdict's problem items

A method refused for what it says, rather than for how its run went, comes back as a list of the standard's problem items. They ride the `/v1/validate` verdict (its invalid arm's `errors`, `PipelexInvalidReport`, and the advisory `warnings` of its valid arm), the crate routes' invalid verdict (`CrateInvalidReport.errors`), each a `200` because an invalid bundle is a produced verdict; the pipe I/O answer that does not load, as `MethodLoadError.problem.errors`; the `errors` of a refusal's problem, such as the `422` a run route answers when the runner refuses the method; and a failed run's `run_error.errors`. Each item is the standard's `ProblemItem`:

| Member | Meaning |
|---|---|
| `code` | The fault's registered code, such as `method.concept_unresolved`, `method.pipe_unresolved` or `model.unknown`. |
| `detail` | What is wrong, in words. |
| `params` | What the code's registry entry names: the concept or pipe a reference names, the model reference exactly as the author wrote it, and the like. |
| `location` | Where the fault is: its `file` (the tree path in the tree the request sent), `pipe`, `field`, `input`, `path`, `line` and `column`, each present when the runner knows it. |
| `suggestions` | The close matches, each spelled as a value the field accepts. |
| `suggested_fix` | The runner's deterministic correction, when it has one: the standard's `SuggestedFix`, with a `fix_code`, a `description` in words, a `safety` (`safe` to apply without asking, or `unsafe`), the `file` the ops apply to, and `ops` that patch the `.mthds` document by table and key rather than by text, each a `FixOp` of the standard's kinds. |

```ts
const report = await client.validate({ directory: "methods/receipts" });
if (!report.is_valid) {
  for (const item of report.errors) {
    console.error(`${item.location?.file ?? "?"} ${item.location?.pipe ?? ""}: ${item.detail}`);
    if (item.suggestions?.length) console.error(`Did you mean: ${item.suggestions.join(", ")}`);
    if (item.suggested_fix) console.error(`Fix: ${item.suggested_fix.description}`);
  }
}
```

**A verdict's items and the pipe I/O answer's are read member by member.** One malformed member never costs the caller the fault it belongs to: an entry that is no object, or whose `code` or `detail` is not a string, names no fault and is skipped, and each optional member the standard declares (`params`, `location`, `suggestions`, `suggested_fix`) is kept only when the standard's own check accepts it, and left out of its item otherwise. A member the standard does not declare is kept as received. `readProblemItems` in `src/problem-items.ts` is that reader, and the Python twin's `pipelex_sdk.problem_items` reads them the same way. A refusal's problem and a run's `run_error` are not read this way: the standard's reader checks each whole, items included, so one malformed item makes a refusal's body no problem document, which the SDK then reads by its status, and makes a `run_error` no problem, so the run's own problem reads as absent (`null` on the failed arm, `undefined` as `runError`).

## The case file both SDKs run

**The problems are a contract with `pipelex-sdk`.** `tests/fixtures/sdk-problems.json` pins each failure both SDKs detect to its problem code: the answers the hosted API, its edge or a proxy can give (a problem document read as received, each bare status, each start or execute whose run may exist), the readings of a storage answer's status and of each transfer failure's reason, and each error class built from the arguments it takes, with the code and the members its problem must carry. It is the source: `make shared-files` at the repository's root writes the Python package's byte for byte identical copy, and `make check-shared-files` fails on a stale one, so a change to a problem is made here, copied, and then made in both packages. `tests/sdk-problems.test.ts` drives this package's code through every case, and the Python suite's `tests/unit/test_sdk_problems.py` drives the twin's.
