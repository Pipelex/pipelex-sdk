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

`errorVerdictOf` checks the shape rather than the class: it returns the pair from any `Error` carrying a boolean `retryable` and a known `errorDomain`, and `undefined` otherwise. So it reads an error raised by another copy of the SDK installed beside yours, a subclass of your own, and an `mthds` `ApiResponseError` whose runner sent both members. Every class also exposes the two members directly, and they derive from the abstract `PipelexRequestError`, itself a `PipelineRequestError`, so `instanceof PipelineRequestError` still matches all of them.

**"Retryable" means a retry can succeed, not that it is safe.** The verdict says whether asking again can plausibly succeed; it says nothing about whether the first attempt had an effect, and it does not depend on the route. A `start` answered with a `500` is retryable by its status, yet it may already have created a run, so a caller that must not start a run twice keeps its own rule for that until the SDK can send an idempotency key.

**What carries no verdict.** `errorVerdictOf` returns `undefined` for what is not an SDK failure: the `RangeError` or `TypeError` the SDK raises for an argument of the wrong type or range before any request is sent (a `timeoutMs` out of range, a malformed `appInfo`, an empty artifact selection), which names a bug in the calling code; and the caller's own abort, which the client rethrows untouched. The per-reference errors inside a `downloadArtifacts` verdict are values with a `code`, not thrown errors, and carry none either. An argument the client refuses for what it asks, such as two method selectors given to `validate` or `execute`, or a base URL with a path, is a `RequestArgumentError`, which carries a verdict like every SDK error.

### Each class's verdict

| Class | `errorDomain` | `retryable` | Why |
|---|---|---|---|
| `ApiResponseError` | the server's, else the fallback | the server's, else no for a sent `input` or `config` domain, else the fallback | See [below](#a-refused-requests-verdict). |
| `RequestArgumentError` | `input` | no | The client refused a call's arguments before sending any request: no run source given to `execute` or `start`, run sources or method selectors that exclude each other, a selector rule of `validate`, an empty `validateFiles`, a reserved key in `extra`. Its options take an optional `verdict`, and the client declares `config` for a base URL that is not host-only, since it typically comes from `PIPELEX_BASE_URL`. It is a `PipelineRequestError`, as the bare refusal it replaced was, and a refusal the standard's own run-source check raises keeps that original as `cause`. |
| `ApiUnreachableError` | `config` | yes | The address or the network must be checked, and a later attempt can get through. With the code `ABORT_TIMEOUT`, the SDK's own request timeout, it is `runtime`: the API took the request and did not answer in time. |
| `PipelineExecuteTimeoutError` | `input` | no | The blocking `execute` cannot outlast the gateway's limit; start the run and poll instead. |
| `RunFailedError` | the report's | the report's | See [a failed run](#a-failed-run--runerrorreport). |
| `RunTimeoutError`, `RunStillRunningError` | `runtime` | yes | The run is still going; waiting again, by its id, can succeed. |
| `RunLifecycleUnavailableError` | `config` | no | The base URL points at a bare runner without the run lifecycle. |
| `MissingMainStuffError` | `runtime` | no | The API broke its own contract on a completed run. |
| `PagingNotTerminatingError` | `runtime` | no | A server minting cursors forever; `pageLimit` is the ceiling `iterateMethods` stopped at. |
| `InputPreparationError` and `EmptyMethodSourceError`, `InvalidLocalSourceError`, `RejectedAssetError` | `input` | no | The asset, the inputs or the method selector must change. The family's base takes an optional `verdict` in its options, so a subclass of your own can declare another. |
| `UnsupportedUploadCapabilityError`, `UploadAuthenticationError` | `config` | no | The deployment or the credential must change. |
| `UploadTransportError` | the cause's, else by `code` | the cause's, else by `code` | `uploadFile` wraps the `ApiResponseError` or `ApiUnreachableError` the client threw, and takes its verdict, so a wrapped `402` is `config` and not retryable. Without such a cause, which is always the case from `uploadWithGrant`: `timeout`, `storage_timeout` and `conflict` are `runtime` and retryable, `conflict` because storage documents its `409 ConditionalRequestConflict` as retryable and the grant is not spent by it (a spent grant is the `412` of a `RejectedAssetError` with code `grant_used`); `server_error` is `runtime`, and retryable when [the fallback table](#a-refused-requests-verdict) would call its `status` retryable, any `5xx` but the `501` storage answers for a request it does not implement, or when it carries no status; `unexpected` is `runtime`, and retryable when that table would call its `status` retryable, which is the `408` or `429` storage answers when it times out or throttles the request rather than refusing the file, and not retryable for any other status or none; `unreachable` is `config` and retryable; `redirected` is `config` and not retryable; `invalid_grant_url` is `runtime` and not retryable. |
| `ArtifactOperationError`, `ScopeUnavailableError` | `runtime` | no | The family's base also takes an optional `verdict`: the SDK declares `input` where it refuses an argument (a `scope`, a bound, a location) and `config` where the environment refuses the download (a runtime with no filesystem, a directory that cannot be created). |
| `ArtifactAuthenticationError` | `config` | no | The credential must change. Its `verdict` member is the download's result so far, not the error's. |
| `ArtifactFetchError` | by `code` | by `code` | `invalid_storage_uri`, `forbidden`, `unsupported_url`, `not_found` and `too_large` are `input` and not retryable; `plain_http_refused` is `config` and not retryable; `redirect_refused` and `store_refused` are `runtime` and not retryable; `timeout` and `network` are `runtime` and retryable; `store_error` is `runtime`, and retryable when [the fallback table](#a-refused-requests-verdict) would call its `status` retryable: a `408`, a `429`, or a `5xx` other than `501`. |
| `CodegenLockError` | `input` | no | The lock is the caller's own file. It extends `Error`, since nothing was requested over the wire, and declares the two members itself. |

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
| `409` | `input` | no | The request conflicts with the stored state: a method being deleted, a stale update, a taken label. |
| `409` with code `pipelex_api_key_limit_reached` | `config` | no | The organization holds as many keys as it may; someone removes one. |
| `501` | `config` | no | The deployment does not implement it, and asking again will not change that. |
| `500`, `502`, `503`, `504`, and any `5xx` not listed here | `runtime` | yes | A fault in the service, which may pass. |
| Anything else | `runtime` | no | A status no refusal carries, such as the `2xx` of an answer the SDK could not read; nothing says a retry helps. |

On the platform today the fallback decides both members, since the platform does not send them on its own refusals yet; a runner's problem usually carries its own. **Nothing on the error says which of the two a value came from**: `problemDocument` keeps the document whole, so a reader that must tell a server-sent verdict from a derived one reads it there.

**The verdicts are a contract with the Python SDK.** `pipelex-sdk` must apply the same fallback and declare the same verdict on each class it shares with this package. `tests/fixtures/error-verdicts.json` holds every case the two must agree on, the fallback's rows, the server-sent resolution and each class's variants, and this package's test suite drives its own code through it. The Python package is to keep a byte for byte identical copy of the file and drive its own code through the same cases, with a check at the repository's root holding the two copies identical; until that copy is added, nothing holds the Python SDK to the table yet.

The shapes are not this SDK's invention. The report is the runner's `ErrorReport` (in `pipelex`), stored and served by the platform exactly as the runner wrote it, and the problem members are the ones the hosted-envelope spec names, `conformance/specs/pipelex-hosted-envelope.md` in the `conformance` repository, where the cross-repo specs sit beside the tests that verify them. The types live in `src/error-models.ts`; `pipelex-sdk` (Python) carries the same fields under snake_case names.

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
| `message` | What went wrong, as the runner wrote it. For a run failure it is where the failing pipe is named. |
| `error_domain` | Who can fix it: `input` (the caller — a malformed method, a bad input), `config` (a configuration change — a model the backend does not serve, a missing secret), `runtime` (nobody beforehand — a provider outage). **A branch field.** |
| `type_uri` | The stable URI naming the error class, the same on every occurrence. **A branch field.** |
| `retryable` | Whether running it again can succeed. Absent means unknown, which is not `false`. **A branch field.** |
| `user_action` | The next step, as `{ kind, detail }`: `detail` is the advice in words, `kind` its category (`wait_and_retry`, `check_billing`, `check_credentials`, `change_input`, `change_model`, `contact_support`, `unknown`). |
| `title` | The stable human label of the error class. |
| `error_type` | The runner's exception class name — an open set, for display and support, never matched against. |
| `error_category` | The finer class of an inference failure: `transient`, `configuration`, `content`, `capacity`, `ambiguous`, `unknown`. |
| `model`, `provider` | The model and provider an inference failure involved. |
| `provider_metadata` | What the provider's SDK said: `provider`, `sdk_exception_type`, `message`, `status_code`, `request_id` (the provider's own), `retry_after_seconds`, `provider_error_code`. |
| `validation_errors` | The structured diagnostics of a method that failed validation, the same [items](#a-validation-item--validationerroritem) the validate report carries. |
| `migration` | A pending configuration migration that explains the failure, present only when the runner's scan found one. |
| `caller_facing_message` | `true` when `message` was written as caller-facing copy. |

A field a newer runner adds is reachable through the interface's index signature before this SDK names it.

**The report is checked field by field, never cast.** Every read that hands one back applies the same check: a value that is not an object reads as no report (`null`); each named field is kept when it has the type the table above gives it and is absent otherwise, so a `message` that is a number or a `retryable` of `"no"` never reaches you as typed; `null` is kept wherever the type allows it, and an empty string is kept, since deciding that a blank field says nothing is presentation. `provider_metadata` and `migration` are checked one level down, `validation_errors` keeps only the items that are objects with a string `category` and `message`, and members the SDK does not name, in the report or in a nested object, are relayed as sent. **`user_action` is kept whole or not at all**: an object whose `kind` and `detail` are both strings, which is what its type promises. This is the one place the check differs from the Python SDK's, which keeps a partial action, its stored-report action being a lenient type of its own. On the run records, the check runs only when the record carries the `error` key, so a server that does not serve it still leaves it absent.

**The report is `null` when the run has none.** A run the platform finalized itself carries no report: one whose start failed, and a timeout, a termination or a vanished workflow resolved by the platform. A cancelled run usually has none either. The status and the `detail` sentence still say what happened, and the absence of a report says nothing about why.

**Nothing is stripped, so presentation is yours.** The platform serves the runner's VERBOSE report, so `message` and `provider_metadata.message` can hold a provider's raw text. The SDK types what the platform sends; deciding what a person sees is the consumer's decision. `RunFailedError.message`, being the `detail`, already contains the report's message.

**Numbers in `provider_metadata` may arrive as strings.** A report read back from the platform's run store carries `status_code` and `retry_after_seconds` as strings (`"404"`, `"1.5"`), because the store returns its numbers as decimals that the platform serializes as strings; a problem document a runner renders carries them as numbers. Both are in the type, so read them with `Number(...)`.

## A refused request — `ApiResponseError`

Every non-2xx answer from a `/v1` route is a problem document, and the SDK throws an `ApiResponseError` whose fields are its members. Each field is `undefined` when the document did not carry it, and a member of the wrong type (a numeric `type`, a `retryable` of `"no"`, a `user_action` without a `detail`) reads as absent rather than as a wrong value. The nested members are checked one level down, exactly as a [stored report's](#a-failed-run--runerrorreport) are: `providerMetadata` and `migration` keep each named field only when it has its type, `validationErrors` keeps only the items that are objects with a string `category` and `message`, and each item of `errors` keeps its `field`, `code` and `detail` only when they are strings; members the SDK does not name are relayed as sent. The verdict is the exception: `errorDomain` and `retryable` are always decided, the server's value when it sent a valid one and otherwise [as the verdict section says](#a-refused-requests-verdict).

**An answer the SDK could not read is an `ApiResponseError` too.** A `2xx` whose body is not JSON, such as a gateway's HTML page or an empty body where the route answers one, is no result the SDK can hand back, so every route throws an `ApiResponseError` for it instead of letting the runtime's `SyntaxError` escape. So is a `2xx` whose body is JSON but not the object the route answers — `null`, a number, a string, an array — on every protocol, extension and run-lifecycle route, on `health()`, and on the product routes whose answer the SDK or its caller reads before anything else (`listMethods`, `getMethod`, `createMethod`, `updateMethod`, `listRuns`, `getRunDetail`, `upload`, `requestUploadGrant`, `resolveStorageUrls`), instead of the `TypeError` that reading it would raise. So is an object missing the member those reads depend on: a page of `listMethods` or `listRuns` whose `items` is not an array or whose `next_cursor` is neither a string nor `null`, which `iterateMethods` and `iterateRuns` could not walk or would follow forever; an `upload` answer with no non-empty string `uri`, which names no stored file; and a stored method whose `mthds` field is neither a string nor absent (a `null` one is still no source, which `getMethodClosure` reports as `EmptyMethodSourceError`) or whose `python` field is not the serialized `[{ name, content }]` list, as `getMethod`, `createMethod` and `updateMethod` answer it: that is server data no change to the call fixes, not an argument the caller passed. Its `status` is the `2xx`, `responseBody` the raw text, `cause` what made the answer unreadable (the parse failure, or `mthds`'s refusal of the `python` field; nothing for a body that parsed to something the route does not answer), `problemDocument` and the problem members are `undefined`, and its verdict is the fallback's for a status no refusal carries: `runtime`, not retryable. A product route that answers a `2xx` with no body at all, such as `revokePipelexApiKey`, still resolves to `undefined`, and the other product routes hand their decoded body back as it came.

| Field | Wire member | Meaning |
|---|---|---|
| `errorDomain` | `error_domain`, else the fallback | Who can fix it: `input`, `config` or `runtime`. Always decided. **A branch field.** |
| `type` | `type` | The stable URI naming the error class. **A branch field.** |
| `retryable` | `retryable`, else `false` beside a sent `input` or `config` domain, else the fallback | Whether retrying the same request can succeed. Always decided. |
| `userAction` | `user_action` | The next step, `{ kind, detail }`. |
| `requestId` | `request_id`, else the `X-Request-ID` header | The id to hand to support: it finds the server's log lines for the request. |
| `title` | `title` | The stable human label of the error class. |
| `serverMessage` | `detail` (or `message`) | The per-occurrence message. |
| `instance` | `instance` | The occurrence: a request URN (`urn:pipelex:request:<id>`) or a request path. |
| `code` | `code` | The platform's native code, a closed set (`conflict`, `not_found`, `validation_failed`, `pipelex_api_key_limit_reached`, …), one-to-one with `type`. |
| `errorType` | `error_type` | The runner's native code, its open exception class name. |
| `errorCategory`, `model`, `provider`, `providerMetadata` | `error_category`, `model`, `provider`, `provider_metadata` | An inference failure's class and origin, as on the run report. |
| `migration` | `migration` | A pending configuration migration that explains the failure. |
| `validationErrors` | `validation_errors` | The structured diagnostics of a bundle that failed validation, as [validation items](#a-validation-item--validationerroritem). |
| `errors` | `errors` | The platform's field-level failures, `{ field, code, detail }` each. |
| `problemDocument` | the whole body | The decoded document, every member named or not; `undefined` when the body was not a JSON object. The record of what the server sent, verdict members included. |
| `status`, `statusText`, `responseBody` | the transport | The HTTP status, its text and the raw body. |

**Branch on `errorDomain` and `type`, never on the HTTP status or the message.** That is the rule the hosted-envelope spec sets for every surface: `errorDomain` tells the caller's own mistake from a fault it cannot fix, and `type` names the error class with a URI that stays the same on every occurrence. `code` and `errorType` are each surface's finer native code, and stay available for logs and support. On the platform today `error_domain` is not emitted yet, so the fallback reads `errorDomain` from the status, and `type` is `https://pipelex.com/errors/<code>`, so branching on `type` there is branching on the code:

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

The members `mthds`'s own `ApiResponseError` carries (`type`, `title`, `instance`, `requestId`, `errorDomain`, `retryable`, `userAction`) have the same names here, and the same types except the verdict: the standard's client leaves `errorDomain` an open string and `retryable` optional, where this SDK decides both. A type-level test pins `ProblemDetails`, the members as parsed, to the standard client's declaration, so a consumer reads one vocabulary whichever client raised the error. The rest are the Pipelex members the standard's client leaves to this SDK.

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

**The shape is `mthds`'s.** The standard's client declares the same item and the same fix vocabulary (`SuggestedFix`, `FixOp` and its arms, `FixSafety`, `FixOpKind`, `FixValue`), member for member under the same names, and this SDK exports every one of those names, so a consumer reads one vocabulary whichever client handed it the item. `@pipelex/sdk` imports `mthds` only through `mthds/protocol`, and `mthds` exports these declarations from its package root, so they are restated in `src/models.ts` and a type-level test pins them to the standard's: a member added on one side and not the other fails `make check`.

**An unset member can be `null`.** That is the one way this declaration differs from the standard's. The verdict's valid arm, which carries the advisory `warnings[]`, sends an unset member as an explicit `null`, where every other channel leaves the key out, so every optional member is typed `| null`. Read a member with a truthiness check or `??`, never with `=== undefined`.
