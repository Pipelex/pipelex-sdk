# Errors — the verdict every error carries, a failed run's report and a refused request's problem

Every error the SDK throws says two things a program needs before anything else: whether asking again can succeed, and who can fix the failure. That is the **verdict**, and the [first section](#the-verdict-every-error-carries) describes it. Beyond it, two things can go wrong when you call the hosted API, and the SDK hands each one back whole. A **run can fail** after it started: the runner stores why, as its error report, and the SDK gives you that report on the failed run. A **request can be refused**: the server answers a non-2xx RFC 9457 problem document, and the SDK throws an `ApiResponseError` carrying every member of it. This page covers both: which fields each carries, which ones a program branches on, which ones a person reads, and which one support asks for. Either can carry validation items, the structured account of a method refused for what it says, which the [last section](#a-validation-item--validationerroritem) describes.

## The verdict every error carries

Every error class the SDK exports carries `retryable`, a boolean, and `errorDomain`, one of three values, and neither is ever `undefined`: the SDK knows the API, so it decides, and no consumer has to choose its own default. The three domains say who can fix the failure:

| `errorDomain` | Who fixes it | Examples |
|---|---|---|
| `input` | The caller, by changing the request: the inputs, the method, a reference, an argument. | A malformed bundle, a missing input, a stored method that does not exist. |
| `config` | Someone changing the environment: the base URL, the credential, the plan, the deployment. | An invalid API key, a plan without credit, a base URL pointing at a bare runner. |
| `runtime` | Nobody beforehand: a fault during execution or in the service. | A provider outage, a gateway timeout, a run still going when the wait ran out. |

Read the pair with `errorVerdictOf`, which takes anything a `catch` holds:

```ts
import { errorVerdictOf } from "@pipelex/sdk";

try {
  await client.startAndWaitForResult({ method_id: "mt_abc123", inputs });
} catch (err) {
  const verdict = errorVerdictOf(err);
  if (verdict === undefined) throw err; // not an SDK error: a bug, or the caller's own abort
  if (verdict.retryable) return scheduleRetry();
  if (verdict.errorDomain === "input") return askTheUserToFix(err);
  return reportToOperator(err);
}
```

`errorVerdictOf` checks the shape rather than the class: it returns the pair from any `Error` carrying a boolean `retryable` and a known `errorDomain`, and `undefined` otherwise. So it reads an error raised by another copy of the SDK installed beside yours and a subclass of your own. An error of the standard's own client, `mthds`, carries its verdict on its problem instead, as `domain` and `retry` in the standard's vocabulary, and `errorVerdictOf` reads it as that problem's verdict in this SDK's vocabulary, whatever the runner's body held beside it. `problemVerdict` does the translation for any problem of the standard: the standard's domain maps onto this SDK's by who acts — `input` and `method` read as `input`, `account` and `operator` as `config`, `runtime` as `runtime` — and only a `retry` of `yes` is retryable, since an outcome that is unknown may already have taken effect. A domain or a retry verdict the standard's reader does not know reads by its own fallbacks (`problemDomain`, `problemRetry`), and the Python SDK applies the same mapping. Every class also exposes the two members directly, and they derive from the abstract `PipelexRequestError`, itself a `PipelineRequestError`, so `instanceof PipelineRequestError` still matches all of them.

**"Retryable" means a retry can succeed, and never one that could start a second paid run.** The verdict says whether asking again can plausibly succeed, and on most routes it says nothing about whether the first attempt had an effect. A request that may create a run, a `start` or a blocking `execute`, is the exception: when it failed in a way that may have started a run anyway, the error's `runMayHaveStarted` is `true` and its `retryable` is `false`, whatever the server sent and whatever the status says, since asking again could start the run twice. [A failed run start](#a-failed-run-start--runmayhavestarted) says when that is and what to tell a person.

**A request the gateway cut off: `isGatewayCutOff`.** The hosted gateway gives up on a request it waits on at about 30 seconds and answers `503` or `504`, while the server may still be handling it: a blocking `execute`, or a `start` whose server is fetching a `method_ref`'s package. `isGatewayCutOff(error, elapsedMs)` tells such a failure from a refusal: it is `true` when, at least ~28 seconds after the request was sent, the failure is a `503` or `504` answer or the client's own time limit (`ApiUnreachableError` with the code `ABORT_TIMEOUT`), and `false` before then and for any other failure. The blocking `execute` applies it and throws `PipelineExecuteTimeoutError`, timing the request on the monotonic clock `performance.now`, since a change of the system's time moves `Date.now`. A caller no longer needs it to learn whether a failed start may have created a run: the error's `runMayHaveStarted` says so whatever the timing. The fetch API cannot say whether `ABORT_TIMEOUT` ran out before the connection was made, so the rule reads it as the gateway's; with Node's own dispatcher it never does past the threshold, since undici gives up a connection that does not come after ten seconds (`UND_ERR_CONNECT_TIMEOUT`), the TLS handshake included. The Python SDK's `is_gateway_cut_off` is the same rule.

**What carries no verdict.** `errorVerdictOf` returns `undefined` for what is not an SDK failure: the `RangeError` or `TypeError` the SDK raises for an argument of the wrong type or range before any request is sent (a `timeoutMs` out of range, a malformed `appInfo`, an artifact selection that is not an array), which names a bug in the calling code; and the caller's own abort, which the client rethrows untouched. The per-reference errors inside a `downloadArtifacts` verdict are values with a `code`, not thrown errors, and carry none either. An argument the client refuses for what it asks, such as two method selectors given to `validate` or `execute`, or a base URL with a path, is a `RequestArgumentError`, which carries a verdict like every SDK error.

### Each class's verdict

On an error from a request that may have started a run, `retryable` is `false` whatever this table says ([below](#a-failed-run-start--runmayhavestarted)).

| Class | `errorDomain` | `retryable` | Why |
|---|---|---|---|
| `ApiResponseError` | the server's, else the fallback | the server's, else no for a sent `input` or `config` domain, else the fallback | See [below](#a-refused-requests-verdict). |
| `RequestArgumentError` | `input` | no | The client refused a call's arguments before sending any request: no run source given to `execute` or `start`, run sources or method selectors that exclude each other, a selector rule of `validate`, an empty `validateFiles`, a reserved key in `extra`, a `publishMethod` without its token, a `getMethodVersion` version that is not a positive integer, an id a route puts in its path (a method's, an example's, a run's, an organization's or an API key's) that is empty, `.` or `..` or is not a string, since the URL would resolve it into another route's path, or that holds a lone surrogate, which a URL cannot carry, a `createMethodExample` without its `name` or `inputs` or whose `run_id` is given but empty, an `updateMethodExample` naming neither `name` nor `inputs`, a `recordMethodExampleLatestRun` without a run id or a positive integer `input_revision`, a selector `parseMethodSelector` refuses, an artifact selection that is empty or names an unknown artifact, a start's `idempotencyKey` that is not 1 to 255 visible ASCII characters ([below](#a-starts-idempotency-key--idempotencykey)), or a request body JSON cannot carry, such as one holding a cycle, or a `bigint` on a runtime without `JSON.rawJSON` (the body is written with `stringifyExactJson`, which writes a `bigint` as its exact digits; see [exact-integers.md](./exact-integers.md)), with the failure as `cause`. Its options take an optional `verdict`, and the client declares `config` for a base URL that is not host-only, since it typically comes from `PIPELEX_BASE_URL`. That refusal shows the base URL's scheme and host alone and names the other parts it carried (credentials, a path, a query, a fragment) without their text, since those are where a secret travels in a URL; a value that is not an http or https URL is not shown at all. It is a `PipelineRequestError`, as the bare refusal it replaced was, and a refusal the standard's own run-source check raises keeps that original as `cause`. |
| `ApiUnreachableError` | `config` | yes | The address or the network must be checked, and a later attempt can get through. With the code `ABORT_TIMEOUT`, the SDK's own request timeout, it is `runtime`: the API took the request and did not answer in time. |
| `PipelineExecuteTimeoutError` | `input` | no | The blocking `execute` cannot outlast the gateway's limit; start the run and poll instead. The run goes on, so its `runMayHaveStarted` is always `true`. |
| `RunFailedError` | the report's | the report's | See [a failed run](#a-failed-run--runerrorreport). |
| `RunTimeoutError`, `RunStillRunningError` | `runtime` | yes | The run is still going; waiting again, by its id, can succeed. |
| `RunLifecycleUnavailableError` | `config` | no | The base URL points at a bare runner without the run lifecycle. |
| `MissingMainStuffError` | `runtime` | no | The API broke its own contract on a completed run. |
| `PagingNotTerminatingError` | `runtime` | no | A server minting cursors forever; `pageLimit` is the ceiling `iterateMethods`, `iterateRuns` or `iterateMethodExamples` stopped at. |
| `InputPreparationError` and `EmptyMethodSourceError`, `InvalidLocalSourceError`, `InvalidInputValueError`, `UploadNotAllowedError`, `MethodLoadError`, `RejectedAssetError` | `input` | no | The asset, the inputs or the method selector must change. The family's base takes an optional `verdict` in its options, so a subclass of your own can declare another; `prepareInputs` declares `runtime` for a pipe I/O answer that breaks the route's contract: no boolean `is_valid`, an `input_form` that does not describe the pipe it selected, or a descriptor that is malformed or names a kind this SDK does not know. |
| `UnsupportedUploadCapabilityError`, `UploadAuthenticationError` | `config` | no | The deployment or the credential must change. |
| `UploadTransportError` | the cause's, else by `code` | the cause's, else by `code` | `uploadFile` wraps the `ApiResponseError` or `ApiUnreachableError` the client threw, and takes its verdict, so a wrapped `402` is `config` and not retryable. Without such a cause, which is always the case from `uploadWithGrant`: `timeout`, `storage_timeout` and `conflict` are `runtime` and retryable, `conflict` because storage documents its `409 ConditionalRequestConflict` as retryable and the grant is not spent by it (a spent grant is the `412` of a `RejectedAssetError` with code `grant_used`); `server_error` is `runtime`, and retryable when [the fallback table](#a-refused-requests-verdict) would call its `status` retryable, any `5xx` but the `501` storage answers for a request it does not implement, or when it carries no status; `unexpected` is `runtime`, and retryable when that table would call its `status` retryable, which is the `408` or `429` storage answers when it times out or throttles the request rather than refusing the file, and not retryable for any other status or none; `unreachable` is `config` and retryable; `redirected` is `config` and not retryable; `invalid_grant_url` is `runtime` and not retryable. |
| `ArtifactOperationError`, `ScopeUnavailableError` | `runtime` | no | The family's base also takes an optional `verdict`: the SDK declares `input` where it refuses an argument (a `scope`, a bound, a location) and `config` where the environment refuses the download (a runtime with no filesystem, a directory that cannot be created). |
| `ArtifactAuthenticationError` | `config` | no | The credential must change. Its `verdict` member is the download's result so far, not the error's. |
| `ArtifactFetchError` | by `code` | by `code` | `invalid_storage_uri`, `forbidden`, `unsupported_url`, `not_found` and `too_large` are `input` and not retryable; `plain_http_refused` is `config` and not retryable; `redirect_refused` and `store_refused` are `runtime` and not retryable; `timeout` and `network` are `runtime` and retryable; `store_error` is `runtime`, and retryable when [the fallback table](#a-refused-requests-verdict) would call its `status` retryable: a `408`, a `429`, or a `5xx` other than `501`. |
| `CodegenLockError` | `input` | no | The lock is the caller's own file. It extends `Error`, since nothing was requested over the wire, and declares the two members itself. |
| `ExactJsonUnsupportedError` | `config` | no | `parseExactJson` met a number past `Number.MAX_SAFE_INTEGER` on a runtime whose `JSON.parse` hands a reviver no source text, so it could only read it rounded; running on a runtime the package supports fixes it ([exact-integers.md](./exact-integers.md)). It extends `Error`, since nothing was requested, and declares the verdict's members itself. The client reports it as the `ApiResponseError` of an answer it cannot read, with this error as `cause`. |

### A refused request's verdict

An `ApiResponseError` takes each member the server sent validly: `retryable` is the problem document's `retryable` when it is a boolean, and `errorDomain` is its `error_domain` when it is one of the three domains. A member the server did not send, or sent with the wrong type, or (for the domain) outside the three, is absent, and an absent domain takes the fallback's. An absent `retryable` depends on the domain the server sent, since a runner often sends `error_domain` without `retryable`: a sent `input` or `config` domain is not retryable, as a stored report that says nothing is not, because the caller or the environment must change before asking again can succeed; a sent `runtime` domain, or no valid domain at all, takes the fallback's `retryable`. A `retryable` the server sent always wins, whatever the domain.

The fallback reads the HTTP status, the platform's `code`, and whether the body is **named**: it carries a platform `code` or a runner `error_type`. A named `404` is something the caller asked for that does not exist; a bare one is a route the deployment does not serve.

| Status | `errorDomain` | `retryable` | Why |
|---|---|---|---|
| `400`, `413`, `422`, and any `4xx` not listed here | `input` | no | The request itself was refused. |
| `401`, `402`, `403` | `config` | no | The credential, the plan or the access must change. |
| `404`, named | `input` | no | The caller named something that does not exist. |
| `404`, bare | `config` | no | The base URL points at a deployment without the route. |
| `405` | `config` | no | The deployment does not serve this method on the route. |
| `408`, `429` | `runtime` | yes | Refused for its timing, not its content. |
| `409` | `input` | no | The request conflicts with the stored state: a method being deleted, a stale draft token, a method never published addressed by its bare id, a taken label. |
| `409` with code `pipelex_api_key_limit_reached` | `config` | no | The organization holds as many keys as it may; someone removes one. |
| `409` with code `idempotency_key_in_use` | `runtime` | yes | An earlier request under the same idempotency key is still being handled, and the same request sent again under that key is answered with its outcome. |
| `501` | `config` | no | The deployment does not implement it, and asking again will not change that. |
| `500`, `502`, `503`, `504`, and any `5xx` not listed here | `runtime` | yes | A fault in the service, which may pass. |
| Anything else | `runtime` | no | A status no refusal carries, such as the `2xx` of an answer the SDK could not read; nothing says a retry helps. |

The members the server sent are read first, and the fallback answers only for one it did not send: a runner's problem usually carries its own, the platform sends them on the problems it renders itself once its deployment classifies them, and a route that sends neither, as the platform's Lambda-backed routes do not yet, gets the fallback for both. **Nothing on the error says which of the two a value came from**: `problemDocument` keeps the document whole, so a reader that must tell a server-sent verdict from a derived one reads it there, as the live suite `tests/e2e/error-verdicts.e2e.ts` does. A rejected API key always gets the fallback's verdict: the hosted gateway's authorizer refuses it before the platform sees the request, with a bare `403` whose body is `{"message":"Forbidden"}`, which carries no `code`, no `type` and no verdict, so the error reads it as `config` and not retryable from the status alone.

**The verdicts are a contract with the Python SDK.** `pipelex-sdk` must apply the same fallback, declare the same verdict on each class it shares with this package, and read a failed run start the same way. `tests/fixtures/error-verdicts.json` holds every case the two must agree on, the fallback's rows, the server-sent resolution, each class's variants and the answers to a run-creating request (its `run_start` member, each row sent through a real `start` or `execute`), and this package's test suite drives its own code through it. The file is the source: `make shared-files` at the repository's root writes its byte for byte identical copy to `python/tests/fixtures/error-verdicts.json`, `make check-shared-files` fails on a stale copy, and the Python suite drives its own code through the same cases (`python/docs/errors.md`). A class or a variant only one SDK has is marked `only_in` in the file, and the other suite skips it. So a change to a verdict is made in the file here, copied, and then made in both packages.

The shapes are not this SDK's invention. The report is the runner's `ErrorReport` (in `pipelex`), stored by the platform exactly as the runner wrote it and served through the runner's STRICT disclosure, as [below](#what-the-platform-serves-of-a-report), and the problem members are the ones the hosted-envelope spec names, `conformance/specs/pipelex-hosted-envelope.md` in the `conformance` repository, where the cross-repo specs sit beside the tests that verify them. The types live in `src/error-models.ts`; `pipelex-sdk` (Python) carries the same fields under snake_case names.

### A failed run start — `runMayHaveStarted`

Every error the SDK throws carries a third member beside the verdict, `runMayHaveStarted`, a boolean that is never `undefined`. It is `true` when the request that failed may have started a run whose id never reached the caller, and `false` otherwise, which includes every error from a request that cannot start a run. Read it with `runMayHaveStartedOf`, which takes anything a `catch` holds and, like `errorVerdictOf`, checks the shape rather than the class: it is `true` only for an `Error` whose `runMayHaveStarted` is `true`, so it reads an error raised by another copy of the SDK, and an `mthds` error, which never carries the member, reads as `false`.

**The requests that may create a run** are `start` and the blocking `execute`, and inside `startAndWaitForResult` the start and the blocking execute it falls back to against a bare runner. Once `onStarted` has been called the run exists and the caller holds its id, so an error while the composite waits started nothing: its `runMayHaveStarted` is `false`, and its `retryable` is about waiting again on that id, never about calling the composite again. `RunStillRunningError`, the `202` a blocking execute answers for a run still going, names its run, so its member is `false` too; a `202` that names no run is an answer the SDK could not read, which may have started one.

A failure of a request that may create a run may have started one in these cases, and only these:

| Failure | May have started | Why |
|---|---|---|
| `ApiUnreachableError` that proves nothing was sent | no | The connection's set-up failed, so no request followed. |
| Any other `ApiUnreachableError`, a body that could not be decoded included | yes | The request may have left, and the answer was lost or unreadable. |
| `ApiResponseError` with a `2xx` status | yes | The server accepted the request; only its answer could not be read, which includes a `start` acknowledgement or an `execute` `202` without a string `pipeline_run_id`, and an `execute` answer that is not the completed run. |
| `ApiResponseError` with a `408` | yes | A proxy in front of the platform may answer it for a request it forwarded. |
| `ApiResponseError` with a `503` and the code `pipeline_start_unavailable` | no | The platform never reached the runner, and recorded the run as `FAILED`. |
| `ApiResponseError` with a `501` | no | The deployment does not serve the route. |
| `ApiResponseError` with any other `5xx` | yes | The server or a gateway failed while handling the request. |
| `ApiResponseError` with any other status | no | The server refused the request before running anything. |
| `PipelineExecuteTimeoutError` | yes | The gateway cut the execute off, and the run goes on. |
| `RunLifecycleUnavailableError`, `RequestArgumentError`, an input preparation error | no | Nothing that starts a run was sent. |

**The reading errs on the safe side.** A false "may have started" costs a look at the run history; a false "did not start" costs a second paid run. So every `5xx` counts unless the server says otherwise, as the `501` and the coded `503` do. A `503` without that code can follow a run the runner already started, since the platform answers a failure of its own storage with one after it has dispatched the start. Timing plays no part: a `503` or `504` that came back at once reads the same as one at the gateway's limit.

**What proves nothing was sent** is a failure of the connection's set-up, which no request follows: the name lookup or the connect call failing (the system calls `getaddrinfo` and `connect`: an unknown host, a refused connection, no route to the host or the network, the system's connect time limit), undici's own connect time limit, which covers the TLS handshake (`UND_ERR_CONNECT_TIMEOUT`), and a server certificate the TLS handshake refused. Several addresses each failing so, which Node reports together as an `AggregateError`, prove it too. Anything else may have come once the request had left: a reset (`ECONNRESET`), which Node reports alike whether the connection dropped during the TLS handshake or after the request; another TLS failure; the SDK's own time limit (`ABORT_TIMEOUT`), which fetch cannot place before or after the connection was made; and a body that arrived and could not be decoded.

**A run that may have started is never retryable.** When `runMayHaveStarted` is `true`, `retryable` is `false`, whatever the problem document sent and whatever the fallback table says; `errorDomain` is unchanged, and the server's own members stay on `problemDocument`. So a caller that branches on `retryable` alone never offers a retry that could start a second paid run. A caller that reads the member can say more: tell the person the run may exist, and to look it up in the run history (`listRuns`) before starting it again.

```ts
import { errorVerdictOf, runMayHaveStartedOf } from "@pipelex/sdk";

try {
  await client.start({ method_id: "mt_abc123", inputs });
} catch (err) {
  if (runMayHaveStartedOf(err)) {
    return tell("The run may have started. Check the run history before starting it again.");
  }
  if (errorVerdictOf(err)?.retryable) return scheduleRetry();
  throw err;
}
```

**An idempotency key makes the retry safe, and leaves the verdict as it is.** A `start`, and so `startAndWaitForResult`, takes an optional `idempotencyKey`, which the SDK sends as the `Idempotency-Key` header of `POST /v1/start`; without one it sends no header. The hosted API binds the key to the run before it dispatches it, so the same start sent again under the same key is answered with that run and starts nothing, however the first attempt ended. A caller that sent a key therefore answers a failure whose `runMayHaveStarted` is `true` by sending the same start again, with the same key and the same options, and gets the run back instead of paying for a second one ([below](#a-starts-idempotency-key--idempotencykey)). The error does not say so itself: `runMayHaveStarted` stays `true` and `retryable` stays `false` with a key, since the SDK cannot know that the server honours the key (a bare runner ignores it), and a retry under a new key, or with other options, would start a second run. The platform reads its own answer the same way: the `502` with the code `bad_gateway` it answers for a start whose acknowledgement it lost is not retryable whether or not a key was sent, and it names the run that may be running in `problemDocument.pipeline_run_id`.

The Python SDK carries the same member as `run_may_have_started`, with the reader `run_may_have_started_of`, and reads every failure the same way; the `run_start` rows of the shared case file hold the two to the same answer for every status.

### A start's idempotency key — `idempotencyKey`

Generate one key per run you mean to start (a `crypto.randomUUID()` is a good one), and keep it with the options across that start's retries. A key is 1 to 255 visible ASCII characters, `!` to `~`; anything else, an empty string included, is a `RequestArgumentError` before anything is sent, since a start sent without the key its caller gave would lose the protection without a word.

```ts
import { errorVerdictOf, runMayHaveStartedOf } from "@pipelex/sdk";

// One key per run, kept with the options, unchanged, across the start's retries.
const options = { method_id: "mt_abc123", inputs, idempotencyKey: crypto.randomUUID() };
try {
  return await client.start(options);
} catch (err) {
  // Under the same key, a start that may have started a run is answered with that run.
  if (runMayHaveStartedOf(err) || errorVerdictOf(err)?.retryable) return await client.start(options);
  throw err;
}
```

What the hosted API answers a start sent under a key:

| The start | The answer |
|---|---|
| The first under the key | The run starts, the key bound to it before it is dispatched. |
| The same options under the same key, once the first was answered or bound to its run | The first start's acknowledgement, the run's state as it stands, and nothing starts. A first start refused for its content is refused again; one refused for its timing, such as a `429` in front of the runner, freed the key, and the retry is handled afresh. |
| The same options under the same key, while the first is still being handled | After a short wait, the first start's answer; failing that, a `409` with the code `idempotency_key_in_use`, `runtime` and retryable, with a `Retry-After` header that `ApiResponseError` does not expose. Nothing ran for it, so its `runMayHaveStarted` is `false`: send it again under the same key in a few seconds, never under a new one, which would start a second run. |
| Other options under the same key | A `409` with the generic code `conflict`, `input` and not retryable: a key reused for another request is a bug in the caller. Send the new request under a new key. |
| The same options under a key bound to a run since deleted | A `409` `conflict` too: send it under a new key to start a new run. |

`IdempotencyErrorCode` names the code a caller branches on, `idempotency_key_in_use`; the key's other refusals carry the generic `conflict`. The hosted API keeps a key for 24 hours, scoped to the caller and the organization, so a start sent again after that starts a new run.

**Keep the body identical.** The hosted API compares the request's bytes, so the retry must carry the same options in the same form. The SDK builds the same body from the same options, but inputs prepared twice are not the same options: `prepareInputs` uploads a local file again and returns a new storage reference each time, so prepare the inputs once and reuse what it returned for every attempt.

**A bare runner ignores the key.** It has no idempotency to honour, so a key sent to one protects nothing, and `startAndWaitForResult`'s blocking execute against one sends none.

## A failed run — `RunErrorReport`

A run that ends without completing (`FAILED`, `CANCELLED`, `TERMINATED` or `TIMED_OUT`) has no result, and the results read answers `409`. The body of that `409` says why: its `detail` names the status and then the report's message, its `run_status` member holds the status, and its `error` member holds the run's stored error report, or `null` when the run has none. The SDK reads the status from `run_status`, falling back to the status word of the `detail` sentence on a platform that does not send the member yet, and types the report as `RunErrorReport`.

The report reaches you wherever a failed run surfaces, always the same object:

| Where | What you get |
|---|---|
| `getRunResult(runId)` | the `failed` arm: `{ state: "failed", pipeline_run_id, status, message, error }` |
| `waitForResult`, `startAndWaitForResult` on the hosted API, `downloadArtifacts({ run_id })` | a thrown `RunFailedError` with `runId`, `status`, `message` and `error` |
| `getRunStatus(runId)` | `RunRead.error` on the run record |
| `listRuns`, `iterateRuns` | `RunHistoryItem.error` on each history row |
| `getRunDetail` | `PipelineRun.error` on the run record |

**A bare runner has no durable run, so its failure is a refused request.** Against a bare `pipelex-api` runner, `startAndWaitForResult` runs the method with the blocking `execute`, and a run that fails there answers a non-2xx problem document: the call throws an `ApiResponseError`, not a `RunFailedError`, and the same classification rides its members (`errorDomain`, `type`, `retryable`, `userAction`, `errorType`, `model`, …) as described [below](#a-refused-request--apiresponseerror). A caller that must work against both catches both, as the example does.

**`RunFailedError`'s verdict comes from the report.** Its `errorDomain` is the report's `error_domain` when it is one of the three domains, and `runtime` otherwise, including a run with no report. Its `retryable` is true only when the report's `retryable` is `true`: a report that says nothing, and a run with none, read as not retryable, since starting the run again spends credit and nothing says it would succeed. The report keeps its own `retryable` as written, so a consumer that words the unknown differently still can.

```ts
import { ApiResponseError, RunFailedError } from "@pipelex/sdk";

try {
  const result = await client.startAndWaitForResult({ method_id: "mt_abc123", inputs });
  console.log(result.main_stuff);
} catch (err) {
  if (err instanceof RunFailedError) {
    const report = err.error; // RunErrorReport | null
    console.error(err.message); // "Run finished with status FAILED: <the report's message>"
    if (report?.user_action) console.error(`Next step: ${report.user_action.detail}`);
    if (err.retryable) console.error("Running it again can succeed.");
    console.error(`Run id for support: ${err.runId}`);
  } else if (err instanceof ApiResponseError) {
    // A refused request — or, against a bare runner, a run that failed on the blocking path.
    console.error(err.serverMessage, err.userAction?.detail, `request id ${err.requestId}`);
  } else {
    throw err;
  }
}
```

The report's fields, all optional because the runner owns the shape:

| Field | Meaning |
|---|---|
| `message` | What went wrong. For a run failure it is where the failing pipe is named. A hosted read serves the author's copy only when `caller_facing_message` is `true`, and the placeholder `An internal error occurred.` otherwise. |
| `error_domain` | Who can fix it: `input` (the caller — a malformed method, a bad input), `config` (a configuration change — a model the backend does not serve, a missing secret), `runtime` (nobody beforehand — a provider outage). **A branch field.** |
| `type_uri` | The stable URI naming the error class, the same on every occurrence. **A branch field.** |
| `retryable` | Whether running it again can succeed. Absent means unknown, which is not `false`. **A branch field.** |
| `user_action` | The next step, as `{ kind, detail }`: `detail` is the advice in words, `kind` its category (`wait_and_retry`, `check_billing`, `check_credentials`, `change_input`, `change_model`, `contact_support`, `unknown`). A hosted read serves it only beside caller-facing copy. |
| `title` | The stable human label of the error class. |
| `error_type` | The runner's exception class name — an open set, for display and support, never matched against. |
| `error_category` | The finer class of an inference failure: `transient`, `configuration`, `content`, `capacity`, `ambiguous`, `unknown`. |
| `model`, `provider` | The model and provider an inference failure involved. Absent on a hosted read. |
| `provider_metadata` | What the provider's SDK said: `provider`, `sdk_exception_type`, `message`, `status_code`, `request_id` (the provider's own), `retry_after_seconds`, `provider_error_code`. A hosted read keeps only `status_code` and `retry_after_seconds`. |
| `validation_errors` | The structured diagnostics of a method that failed validation, the same [items](#a-validation-item--validationerroritem) the validate report carries. |
| `migration` | A pending configuration migration that explains the failure, present only when the runner's scan found one. Absent on a hosted read. |
| `caller_facing_message` | `true` when `message` was written as caller-facing copy. A hosted read keeps it on a caller-facing report and leaves it out otherwise. |

A field a newer runner adds is reachable through the interface's index signature before this SDK names it.

**The report is checked field by field, never cast.** Every read that hands one back applies the same check: a value that is not an object reads as no report (`null`); each named field is kept when it has the type the table above gives it and is absent otherwise, so a `message` that is a number or a `retryable` of `"no"` never reaches you as typed; `null` is kept wherever the type allows it, and an empty string is kept, since deciding that a blank field says nothing is presentation. `provider_metadata` and `migration` are checked one level down, `validation_errors` keeps only the items that are objects with a string `category` and `message`, and members the SDK does not name, in the report or in a nested object, are relayed as sent. **`user_action` is kept whole or not at all**: an object whose `kind` and `detail` are both strings, which is what its type promises. This is the one place the check differs from the Python SDK's, which keeps a partial action, its stored-report action being a lenient type of its own. On the run records, the check runs only when the record carries the `error` key, so a server that does not serve it still leaves it absent.

**A run the platform ends or settles itself carries the platform's report.** Some endings have no runner to write a report, and the platform writes one instead, in the runner's shape, so it reads like any other:

| `error_type` | When | `error_domain` | `retryable` | `user_action.kind` |
|---|---|---|---|---|
| `WorkflowTaskKeptFailingError` | The run's workflow task kept failing for the whole failure window, and the platform ended the run `FAILED`. While the window runs, the status read says so as a `workflow_task_failing` degradation ([run-results.md](./run-results.md#a-degraded-status--degraded-and-degradation)). | `runtime` | `false` | `contact_support` |
| `RunTimedOutError` | The workflow engine timed the run out, and it ended `TIMED_OUT`. | `runtime` | `false` | `contact_support` |
| `RunWorkflowNotFoundError` | The run's workflow cannot be found: it aged out of the engine's retention, or the run was lost while starting. The run ends `FAILED`. | `runtime` | `true` | `wait_and_retry` |

These reports are caller-facing copy: they quote nothing of the worker's own failure text, their `caller_facing_message` is `true`, and so they keep their message and their next step on a hosted read. The one exception is a `WorkflowTaskKeptFailingError` report rebuilt from a termination an earlier platform recorded, whose message quotes the worker's failure: it is not caller-facing, so it reads as the placeholder.

**A cancelled, terminated or timed-out run holds a report when one was sent.** Its `error` holds the report a completion callback carried, or, on a `TIMED_OUT` run, the `RunTimedOutError` report the platform writes for the timeout. A run the platform ended because its workflow kept failing is `FAILED`, never `TERMINATED`.

**The report is `null` when the run has none**: a completed run, one whose start failed, a blocking `execute` run, whose answer carried its reason, one cancelled, terminated or given its status by hand with no completion callback carrying a report, and one that ended before the platform wrote reports of its own. The status and the `detail` sentence still say what happened, and the absence of a report says nothing about why.

### What the platform serves of a report

**The platform serves the runner's STRICT projection, and the SDK strips nothing further.** The run row keeps the runner's report whole, as the record of the people who operate the platform, but every read that hands it to a caller (the status read, the run records and the results read's `409`) serves it through the rule the hosted runner applies to an error on `execute`:

- `error_type`, `title`, `type_uri`, `error_domain`, `error_category`, `retryable` and `validation_errors` pass through when present;
- `message` and `user_action` pass through only when the report's `caller_facing_message` is `true`, which the served report then keeps; otherwise `message` is the placeholder `An internal error occurred.`, and `user_action` and `caller_facing_message` are absent;
- `provider_metadata` keeps only `status_code` and `retry_after_seconds`, and is absent when neither is present;
- `model`, `provider` and `migration` are absent.

So `caller_facing_message` is how a consumer tells the author's copy from the placeholder, and `message` can be shown as it comes: it never carries the worker's internal text or a provider's raw answer. `RunFailedError.message`, being the `detail`, already contains the served message. Every deployed environment serves the projection; a platform run locally with `ERROR_DISCLOSURE=verbose` serves the report whole, which is why the type still names every member the runner writes. Deciding what a person sees is still the consumer's decision.

**Numbers in `provider_metadata` may arrive as strings.** A report read back from the platform's run store carries `status_code` and `retry_after_seconds` as strings (`"404"`, `"1.5"`), because the store returns its numbers as decimals that the platform serializes as strings; a problem document a runner renders carries them as numbers. Both are in the type, so read them with `Number(...)`.

## A refused request — `ApiResponseError`

Every non-2xx answer from a `/v1` route is a problem document, and the SDK throws an `ApiResponseError` whose fields are its members. Each field is `undefined` when the document did not carry it, and a member of the wrong type (a numeric `type`, a `retryable` of `"no"`, a `user_action` without a `detail`) reads as absent rather than as a wrong value. The nested members are checked one level down, exactly as a [stored report's](#a-failed-run--runerrorreport) are: `providerMetadata` and `migration` keep each named field only when it has its type, `validationErrors` keeps only the items that are objects with a string `category` and `message`, and each item of `errors` keeps its `field`, `code` and `detail` only when they are strings; members the SDK does not name are relayed as sent. The verdict is the exception: `errorDomain` and `retryable` are always decided, the server's value when it sent a valid one and otherwise [as the verdict section says](#a-refused-requests-verdict).

**An answer the SDK could not read is an `ApiResponseError` too.** A `2xx` whose body is not JSON, such as a gateway's HTML page or an empty body where the route answers one, is no result the SDK can hand back, so every route throws an `ApiResponseError` for it instead of letting the runtime's `SyntaxError` escape. Every body is read by the rules the protocol reads a problem body by (`parseJsonBody` in `mthds/protocol`, as `pipelex-sdk` reads it), so JSON nested deeper than `MAX_BODY_NESTING`, or holding a number past the range of a double, such as `1e999` or an integer that long, which `JSON.parse` reads as `Infinity`, is a body that is not JSON too; a refusal whose body is such JSON carries no hosted member and no `problemDocument`. So is a `2xx` read exactly, such as a run's results or a method example, that holds a number past `Number.MAX_SAFE_INTEGER` on a runtime whose `JSON.parse` hands a reviver no source text, which could only read it rounded; its `cause` is the reader's `ExactJsonUnsupportedError` ([exact-integers.md](./exact-integers.md)). So is a `2xx` whose body is JSON but not the object the route answers — `null`, a number, a string, an array — on every protocol, extension and run-lifecycle route, on `health()`, and on the product routes whose answer the SDK or its caller reads before anything else (`listMethods`, `getMethod`, `createMethod`, `writeDraft`, `renameMethod`, `publishMethod`, `listMethodVersions`, `getMethodVersion`, the method example routes, `listRuns`, `getRunDetail`, `upload`, `requestUploadGrant`, `resolveStorageUrls`), instead of the `TypeError` that reading it would raise. So is an object missing the member those reads depend on: a page of `listMethods`, `listMethodVersions`, `listMethodExamples` or `listRuns` whose `items` is not an array or whose `next_cursor` is neither a string nor `null`, which the iterators could not walk or would follow forever; a publish result whose `outcome` is not `published`, `unchanged` or `refused`, or whose `method` is not an object, and a latest-run result whose `outcome` is not `recorded` or `stale`, or whose `example` is not an object, which a caller branching on `outcome` could not read; a method example, as `createMethodExample`, `getMethodExample` and `updateMethodExample` answer it, as a row of `listMethodExamples` and as a latest-run result's `example`, that misses a field the Python SDK's model of an example requires or holds one of another type, its message naming the field; an `upload` answer with no non-empty string `uri`, which names no stored file; and a stored method or a published version whose `mthds` field is neither a string nor absent (a `null` one is still no source, which `getMethodClosure` reports as `EmptyMethodSourceError`) or whose `python` field is not the serialized `[{ name, content }]` list, as `getMethod`, `createMethod`, `writeDraft`, `renameMethod`, `publishMethod` and `getMethodVersion` answer it: that is server data no change to the call fixes, not an argument the caller passed. Its `status` is the `2xx`, `responseBody` the raw text, `cause` what made the answer unreadable (the parse failure, or `mthds`'s refusal of the `python` field; nothing for a body that parsed to something the route does not answer, nor for JSON the protocol refuses), `problemDocument` and the hosted problem members are `undefined`, `problem` is the standard's reading of such an answer (`client.response_unreadable`, or `client.outcome_unknown` on `start` and `execute`), and its verdict is the fallback's for a status no refusal carries: `runtime`, not retryable. On `start` and `execute` its `runMayHaveStarted` is `true`, since the server accepted the request; that includes a start acknowledgement whose `pipeline_run_id` is not a string, and an `execute` `202` that names no run, which leave the caller a run it could not follow, and an `execute` answer that is not the completed run: one whose `pipeline_run_id` is not a string, or whose `pipe_output` carries no string `pipeline_run_id` or no `working_memory` with `root` and `aliases` objects, the members the Python SDK's model of the answer requires. A product route that answers a `2xx` with no body at all, such as `revokePipelexApiKey`, still resolves to `undefined`, and the other product routes hand their decoded body back as it came.

| Field | Wire member | Meaning |
|---|---|---|
| `errorDomain` | `error_domain`, else the fallback | Who can fix it: `input`, `config` or `runtime`. Always decided. **A branch field.** |
| `type` | `type` | The stable URI naming the error class. **A branch field.** |
| `retryable` | `retryable`, else `false` beside a sent `input` or `config` domain, else the fallback | Whether retrying the same request can succeed. Always decided, and `false` whenever `runMayHaveStarted` is `true`. |
| `runMayHaveStarted` | none | Whether a `start` or a blocking `execute` that failed may have started a run anyway ([above](#a-failed-run-start--runmayhavestarted)). Always decided. |
| `userAction` | `user_action` | The next step, `{ kind, detail }`. |
| `requestId` | `request_id`, else the `X-Request-ID` header | The id to hand to support: it finds the server's log lines for the request. |
| `title` | `title` | The stable human label of the error class. |
| `serverMessage` | `detail` (or `message`) | The per-occurrence message. |
| `instance` | `instance` | The occurrence: a request URN (`urn:pipelex:request:<id>`) or a request path. |
| `code` | `code` | The platform's native code, a closed set (`conflict`, `not_found`, `validation_failed`, `pipelex_api_key_limit_reached`, …), one-to-one with `type`; `MethodErrorCode` names the method ones (see [The method codes](#the-method-codes)) and `IdempotencyErrorCode` the idempotency key's ([above](#a-starts-idempotency-key--idempotencykey)). **A branch field for a client of the platform**, absent on a refusal it relays from the runner. |
| `errorType` | `error_type` | The runner's native code, its open exception class name. |
| `errorCategory`, `model`, `provider`, `providerMetadata` | `error_category`, `model`, `provider`, `provider_metadata` | An inference failure's class and origin, as on the run report. |
| `migration` | `migration` | A pending configuration migration that explains the failure. |
| `validationErrors` | `validation_errors` | The structured diagnostics of a bundle that failed validation, as [validation items](#a-validation-item--validationerroritem). |
| `errors` | `errors` | The platform's field-level failures, `{ field, code, detail }` each. |
| `problemDocument` | the whole body | The decoded document, every member named or not; `undefined` when the body was not a JSON object. The record of what the server sent, verdict members included. |
| `status`, `statusText`, `responseBody` | the transport | The HTTP status, its text and the raw body. |
| `problem` | the answer, read by the standard | The same answer as the MTHDS standard reads it, the problem `mthds`'s own `ApiResponseError` carries (see below). |

**Branch on `errorDomain` and `type`, never on the HTTP status or the message.** That is the rule the hosted-envelope spec sets across surfaces: `errorDomain` tells the caller's own mistake from a fault it cannot fix, and `type` names the error class with a URI that stays the same on every occurrence, and both mean the same on the runner and the platform. `code` and `errorType` are each surface's finer native code, and a client of one surface may branch on that surface's code too. On the platform `type` is `https://pipelex.com/errors/<code>`, derived from `code` one to one, so branching on either reads the same answer; the platform may add codes, so a code the caller does not know gets its generic handling. A refusal the platform relays from the runner, such as a run route's refusal to run an invalid method, carries the runner's `type` and `errorType` and no `code`, so a caller branching on `code` reads its absence as a refusal the runner authored and branches on `type` or `errorType` there. Where the platform sends no `error_domain`, as its Lambda-backed routes do not yet, the fallback reads `errorDomain` from the status, so the branch below reads the same whichever decided it:

```ts
import { ApiResponseError } from "@pipelex/sdk";

try {
  await client.createPipelexApiKey({ label: "ci" });
} catch (err) {
  if (!(err instanceof ApiResponseError)) throw err;
  if (err.type === "https://pipelex.com/errors/pipelex_api_key_limit_reached") {
    // revoke a key first
  } else if (err.errorDomain === "input") {
    console.error(err.serverMessage, err.userAction?.detail, err.errors);
  } else {
    console.error(`${err.serverMessage} (request id ${err.requestId ?? "unknown"})`);
  }
}
```

**`problem` is the standard's reading of the same answer.** The MTHDS standard's own client, `mthds`, reads every answer that is not a route's result as one problem under a registry code, and `problem` is that reading, the problem `mthds`'s `ApiResponseError` carries, typed as the standard's `Problem`: the body as received when it is a core problem document, otherwise the problem the standard reads the answer as by its status (`readAnswer` in `mthds/protocol`), and `client.response_unreadable` for a `2xx` the SDK could not read. On `start` and `execute`, `runMayHaveStarted` decides: wherever a run may have started, which is a `2xx` the SDK could not read, a `408` and every `5xx` but a `501` and a `503` carrying `pipeline_start_unavailable`, it is `client.outcome_unknown`, naming the run when the body names one, such as the platform's `bad_gateway` for a start whose acknowledgement it lost, even when the body is a core problem document, since one inviting a retry would contradict `runMayHaveStarted`; wherever none did, it is the reading of an answer to a request that creates no run, `runtime.unavailable` for that `503` and `client.response_unreadable` for that `501`. A caller handling this SDK's errors and the standard client's alike branches on `problem.code`. The hosted plane's problem documents predate the core registry, so for them `problem` says little, and every member of the table above is read from the hosted document as it always was. The two never share a slot: `code` is the platform's code beside the registry's `problem.code`, and `errors` the platform's field-level failures beside the problem items of `problem.errors`. The error itself stays a `PipelineRequestError` rather than the standard's `ProblemError`, whose `code` is the registry's, so that `code` keeps meaning the platform's.

### The method codes

A refusal about a saved method or one of its versions carries one of the platform codes the exported type `MethodErrorCode` names. `code` itself stays a `string`, since the platform adds codes; every one of these is `input` and not retryable by the fallback, since asking again unchanged meets the same answer.

| `code` | Status | When | What the caller does |
|---|---|---|---|
| `method_update_conflict` | `409` | The draft moved since the token a `writeDraft` (`expected_updated_at`) or a `publishMethod` (`expected_draft_updated_at`) sent; nothing was written or published. `errors[0].field` names the request field that carried the token. | Read the method again, and either load its draft or overwrite it by writing again with the fresh token. |
| `method_being_deleted` | `409` | The method's erasure has started, on every route that addresses it; the detail tells an erasure in flight from a failed one. | Stop offering the method; retry the delete when the detail says it failed. |
| `method_not_published` | `409` | A bare `method_id`, which names the latest published version, on a run or tooling route, for a method never published. The detail names `mt_…@draft` and publishing. | Publish the method, or address its draft as `mt_…@draft`. |
| `method_version_not_found` | `404` | `mt_…@<n>`, or `getMethodVersion`, names a version the method never published. An unknown method is `not_found` instead, so the two are told apart by the code. | Pick a version `listMethodVersions` lists. |

A malformed version suffix (`@0`, `@03`, `@Draft`, two suffixes) is a `422` `validation_failed` whose `errors` name the field `method_id`; `parseMethodSelector` refuses the same selectors locally with a `RequestArgumentError`, before anything is sent. So is any suffix on the run routes' linkage form, a `method_id` beside an inline source, which `execute` and `start` refuse locally the same way.

## A validation item — `ValidationErrorItem`

A method refused for what it says, rather than for how its run went, comes back as a list of validation items. They ride the `/v1/validate` verdict (its invalid arm's `validation_errors[]`, and the advisory `warnings[]` of its valid arm) and the crate routes' invalid verdict (`CrateInvalidReport.validation_errors[]`), each a `200` because an invalid bundle is a produced verdict; the `422` a run route answers when the runner refuses the method for its validation errors, as `ApiResponseError.validationErrors`; and a failed run's report, as `validation_errors`. Each item has a `category` and a `message`; the other members locate the error and say what to do next, and each is present only when the runner knows it:

| Member | Meaning |
|---|---|
| `category` | The stage that found the error: `blueprint_validation`, `pipe_factory`, `pipe_validation` or `dry_run`. |
| `message` | What is wrong, in words. |
| `error_type` | The error's code, such as `unknown_model`. |
| `pipe_code`, `concept_code`, `domain_code` | The pipe, concept and domain the error is in. |
| `source`, `field_path`, `field_name` | The file the error is in (the name passed in `mthds_sources`), and the field, as a path such as `pipe.summarize.model` and by name. |
| `missing_concept_code`, `missing_pipe_code`, `declared_concepts` | The concept or pipe a reference names that the bundle does not declare, and the concepts the domain does declare. |
| `variable_names` | The input variables an input error concerns. |
| `model_reference`, `model_type`, `suggestions` | On an `unknown_model` item: the model reference exactly as the author wrote it, the kind of model the field takes (`llm`, `img_gen`, …), and the close matches, each spelled as a reference the field accepts. |
| `template_file`, `template_location` | On a `template_check_warning` item, which rides the valid verdict's `warnings[]`: the template file as the `PipeDocGen` step names it, `null` for a step of the server's own library, and the place in it the template check's finding names, in the engine's own words, `null` when it names none ([`bundle-resources.md`](./bundle-resources.md#the-template-checks-warnings)). |
| `suggested_fix` | The runner's deterministic correction, when it has one: a `description` in words, `ops` that patch the `.mthds` document by table and key rather than by text, `safety` (`safe` to apply without asking, or `unsafe`) and the `source` file the ops apply to. An unknown model with exactly one close match carries a `rename-model` fix that remaps the reference to it. |

```ts
const report = await client.validate(contents, false, sources);
if (!report.is_valid) {
  for (const item of report.validation_errors) {
    console.error(`${item.source ?? "?"} ${item.pipe_code ?? ""}: ${item.message}`);
    if (item.suggestions?.length) console.error(`Did you mean: ${item.suggestions.join(", ")}`);
    if (item.suggested_fix) console.error(`Fix: ${item.suggested_fix.description}`);
  }
}
```

**The shape is the hosted plane's.** It is the item the runner sends today, which predates the standard's problem items: from protocol 2.0.0 a validate verdict lists its faults as problem items under a registry `code`, which the hosted plane does not send yet, so this SDK declares the item it receives, in `src/models.ts`, and it is not the standard's. Its fix shares the standard's operation kinds (`FixOpKind`), safeties (`FixSafety`) and written values (`FixValue`, which this SDK also calls `TomlValue`), and a type-level test pins those to the standard's, so a kind added on one side and not the other fails `make check`. The standard's own `SuggestedFix` names its file `file` rather than `source` and is open to members it does not declare.

**An unset member can be `null`.** The verdict's valid arm, which carries the advisory `warnings[]`, sends an unset member as an explicit `null`, where every other channel leaves the key out, so every optional member is typed `| null`. Read a member with a truthiness check or `??`, never with `=== undefined`.
