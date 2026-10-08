# Errors — the verdict every error carries

Every error `pipelex-sdk` raises says two things a program needs before anything else: whether asking again can succeed, and who can fix the failure. That is the **verdict**, and this page describes it: what it means, how to read it, each class's, and the table a refused request falls back to. The verdicts are `@pipelex/sdk`'s, class for class, and a case file the two packages share holds them to it. What a failed run's report carries is described in [`run-results.md`](run-results.md) and on `RunFailedError`, and what a refused request's problem document carries in [`architecture.md`](architecture.md), "Error regimes".

## The verdict every error carries

Every error class `pipelex_sdk.errors` defines carries `retryable`, a `bool`, and `error_domain`, an `ErrorDomain`, and neither is ever `None`: the SDK knows the API, so it decides, and no consumer has to choose its own default. The three domains say who can fix the failure:

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

`error_verdict_of` checks the shape rather than the class: it returns the pair from any exception carrying a boolean `retryable` and a known `error_domain`, and `None` otherwise. So it reads an error of a subclass of your own, and an `mthds` `ApiResponseError` whose runner sent both members. Every class also exposes the two members directly. The errors raised over a request derive from `PipelexRequestError`, itself the standard's `PipelineRequestError`, so `except PipelineRequestError` still catches all of them; it is the base of the family, never raised itself. The codegen tree errors, `CodegenError` and its `CodegenLockError`, are raised over bytes and a directory rather than over a request, so they derive from `Exception` and declare the two members themselves.

**"Retryable" means a retry can succeed, not that it is safe.** The verdict says whether asking again can plausibly succeed; it says nothing about whether the first attempt had an effect, and it does not depend on the route. A `start` answered with a `500` is retryable by its status, yet it may already have created a run, so a caller that must not start a run twice keeps its own rule for that until the SDK can send an idempotency key. A gateway cut-off is told from a refusal by `is_gateway_cut_off`, the twin of `@pipelex/sdk`'s `isGatewayCutOff`.

**What carries no verdict.** `error_verdict_of` returns `None` for what is not an SDK failure: the `ValueError` or pydantic `ValidationError` an argument of the wrong shape meets before any request is sent (a malformed `app_info`, options that do not validate), which names a bug in the calling code; the caller's own cancellation, `asyncio.CancelledError`, which the client lets through untouched; and the per-reference errors inside a `download_artifacts` result, which are values with a `code`, not raised errors. An argument the client refuses for what it asks, such as two method selectors that exclude each other, is a `RequestArgumentError`, which does carry one.

**An answer the SDK could not read is an `ApiResponseError` too.** A `2xx` whose body is not UTF-8 or not JSON, such as a gateway's HTML page or an empty body where the route answers one, is no result the SDK can hand back, and neither is a `2xx` whose body is JSON but not what the route answers: `null` or a list where an object is due, an object missing a member the route's model requires or carrying one of the wrong type, a publish result naming no known `outcome`, an `upload` answer with no non-empty `uri`, run results whose artifacts carry a member the pinned `mthds` does not define. Every route raises an `ApiResponseError` for it, as `@pipelex/sdk` throws one, rather than letting the `json.JSONDecodeError`, `UnicodeDecodeError` or pydantic `ValidationError` of the parse escape: the protocol routes inherited from `mthds`, the run reads and `wait_for_result`, `start_and_wait` on either path, `health`, and every product route. Its message is `API <METHOD> <path> answered <status> with <what>`, `what` naming the failure (`a body that is not JSON`, `a body that is not UTF-8`, `an empty body where JSON was expected`, `a body that is not the answer the route returns`); its `status` is the `2xx`, `response_body` the raw text, `request_id` the `X-Request-ID` header, `__cause__` the parse failure, the problem members and `problem` are `None`, and its verdict is the fallback's for a status no refusal carries: `runtime`, not retryable, since no change to the call fixes it. `upload_file` and `prepare_inputs` wrap it, as they wrap every upload failure, in an `UploadTransportError` with the code `unexpected`, since whether and where the file was stored is unknown. A product route that answers a `2xx` with no body at all, such as `revoke_pipelex_api_key`, still returns `None`.

### Each class's verdict

| Class | `error_domain` | `retryable` | Why |
|---|---|---|---|
| `ApiResponseError` | the server's, else the fallback | the server's, else no for a sent `input` or `config` domain, else the fallback | See [below](#a-refused-requests-verdict). |
| `RequestArgumentError` | `input` | no | The client refused a call's arguments before sending any request: no run source given to `execute` or `start`, a protocol or reserved arg in `extra`, run sources or method selectors that exclude each other, a selector that is not a string, a suffixed `method_id` beside inline `mthds_contents`, a selector rule of `validate`, an empty `validate_files`, an artifact selection that is empty or names an unknown artifact, a suffixed id given to a method route, a `publish_method` token that is not a string, a `get_method_version` version that is not a positive integer, a value `parse_method_selector` refuses. It takes an optional `verdict`, and the client declares `config` for a base URL that is not host-only, since it typically comes from `PIPELEX_BASE_URL`. |
| `ApiUnreachableError` | `config` | yes | The address or the network must be checked, and a later attempt can get through. With the code `ABORT_TIMEOUT`, the SDK's own request timeout, it is `runtime`: the API took the request and did not answer in time. |
| `PipelineExecuteTimeoutError` | `input` | no | The blocking `execute` cannot outlast the gateway's limit; start the run and poll instead. |
| `RunFailedError` | the report's | the report's | The report's `error_domain` when it is one of the three, else `runtime`; retryable only when the report's `retryable` is `True`, so a report that says nothing, and a run with no report, are not retryable: starting the run again spends credit and nothing says it would succeed. The report keeps its own members as written. |
| `RunTimeoutError`, `RunStillRunningError` | `runtime` | yes | The run is still going; waiting again, by its id, can succeed. |
| `RunLifecycleUnavailableError` | `config` | no | The base URL points at a bare runner without the run lifecycle. |
| `MissingMainStuffError` | `runtime` | no | The API broke its own contract on a completed run. |
| `PagingNotTerminatingError` | `runtime` | no | A server minting cursors forever; `page_limit` is the ceiling the iterator stopped at. |
| `InputPreparationError` and `InvalidLocalSourceError`, `InvalidInputValueError`, `MethodLoadError`, `RejectedAssetError` | `input` | no | The asset, the inputs or the method selector must change. The family's base takes an optional `verdict`, so a subclass of your own can declare another; `prepare_inputs` declares `runtime` for an answer that does not describe the pipe it selected. |
| `UnsupportedUploadCapabilityError`, `UploadAuthenticationError` | `config` | no | The deployment or the credential must change. |
| `UploadTransportError` | the cause's, else by `code` | the cause's, else by `code` | `upload_file` wraps the `ApiResponseError` or `ApiUnreachableError` the client raised, passed as `cause` and kept as `__cause__`, and takes its verdict, so a wrapped `402` is `config` and not retryable. Without such a cause: `timeout`, `storage_timeout` and `conflict` are `runtime` and retryable; `server_error` is `runtime`, and retryable unless its `status` is a `501`; `unexpected` is `runtime`, and retryable only for a `408` or a `429`; `unreachable` is `config` and retryable; `redirected` is `config` and not retryable; `invalid_grant_url`, and no code, are `runtime` and not retryable. |
| `ArtifactOperationError`, `ScopeUnavailableError` | `runtime` | no | The family's base also takes an optional `verdict`: the SDK declares `input` where it refuses an argument (a `scope`, a bound, a location, both selectors or neither) and `config` where the environment refuses the download (a directory that cannot be created). |
| `ArtifactAuthenticationError` | `config` | no | The credential must change. Its `verdict` member is the download's result so far, not the error's. |
| `ArtifactFetchError` | by `code` | by `code` | `invalid_storage_uri`, `forbidden`, `unsupported_url`, `not_found` and `too_large` are `input` and not retryable; `plain_http_refused` is `config` and not retryable; `redirect_refused` and `store_refused` are `runtime` and not retryable; `timeout` and `network` are `runtime` and retryable; `store_error` is `runtime`, and retryable when [the fallback table](#a-refused-requests-verdict) would call its `status` retryable: a `408`, a `429`, or a `5xx` other than `501`. A code this version does not know is `runtime` and not retryable. |
| `FieldNotIncludedError` | `input` | no | The results handed over were read without the field, so the caller reads them again asking for it. It takes an optional `verdict`, and `download_artifacts` declares `runtime` when it read the results itself, by `run_id`, and the API left the field out. |
| `CodegenError`, `CodegenLockError` | `input` | no | The output directory, its files or the lock are the caller's own, and writing the same tree again meets the same refusal. |

`RejectedAssetError` and `UploadTransportError` carry a `code` from a closed vocabulary, `RejectedAssetCode` and `UploadTransportCode`, the same as `@pipelex/sdk`'s, so a consumer of both SDKs branches on one set. `upload_file` sets `too_large` on a `413`, and `timeout`, `unreachable`, `server_error` or `unexpected` on a transport failure; the other codes name the refusals and failures of an upload made with a grant, which only `@pipelex/sdk`'s `uploadWithGrant` performs.

### A refused request's verdict

An `ApiResponseError` takes each member the server sent validly: `retryable` is the problem document's `retryable` when it is a boolean, and `error_domain` is its `error_domain` when it is one of the three domains. A member the server did not send, or sent with the wrong type, or (for the domain) outside the three, is absent, and an absent domain takes the fallback's. An absent `retryable` depends on the domain the server sent, since a runner often sends `error_domain` without `retryable`: a sent `input` or `config` domain is not retryable, as a stored report that says nothing is not, because the caller or the environment must change and asking again unchanged meets the same answer; a sent `runtime` domain, and no domain at all, take the fallback's `retryable`.

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
| `501` | `config` | no | The deployment does not implement it, and asking again will not change that. |
| `500`, `502`, `503`, `504`, and any `5xx` not listed here | `runtime` | yes | A fault in the service, which may pass. |
| Anything else | `runtime` | no | A status no refusal carries, such as the `2xx` of an answer the SDK could not read; nothing says a retry helps. |

On the platform today the fallback decides both members, since the platform does not send them on its own refusals yet; a runner's problem usually carries its own. **Nothing on the error says which of the two a value came from**: `problem` keeps the document whole, so a reader that must tell a server-sent verdict from a derived one reads it there. An `ApiResponseError` built by hand gets the verdict the client would give it, the arguments `error_domain` and `retryable` being what the server sent.

## The case file both SDKs run

**The verdicts are a contract with `@pipelex/sdk`.** `tests/fixtures/error-verdicts.json` holds every case the two must agree on: the fallback's rows, the server-sent resolution and each class's variants. Its source is `js/tests/fixtures/error-verdicts.json`; `make shared-files` at the repository's root writes this package's byte for byte identical copy, and `make check-shared-files` fails on a stale one, so a change to a verdict is made in the source, copied, and then made in both packages. `tests/unit/test_error_verdicts.py` drives this package's code through every case: the fallback table directly and through a hand-built `ApiResponseError`, each server-sent body through a real client call, and each class through a builder keyed by its name. A class the file lists for this SDK with no builder fails the suite, as does a field the suite does not know, and a completeness test fails on an error class `pipelex_sdk.errors` defines that the file does not list. A class or a variant only one SDK has is marked `only_in`, and the other suite skips it: `CodegenError` and `FieldNotIncludedError` are Python's alone, and `EmptyMethodSourceError`, raised by `getMethodClosure`, is JavaScript's.
