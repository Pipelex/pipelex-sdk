# @pipelex/sdk

TypeScript SDK for the **Pipelex hosted API** — execute MTHDS methods, manage runs, and call the product surface (methods catalog, organizations, billing, API keys, storage) from Node.

> Pipelex is the runtime/product. [MTHDS](https://mthds.ai) is the open standard it implements. This SDK speaks to the hosted Pipelex API; the pure protocol wire types it builds on come from the [`mthds`](https://www.npmjs.com/package/mthds) package via its `mthds/protocol` subpath.

## Status

Early. `PipelexApiClient` implements the MTHDS protocol-execution routes (`execute` / `start` / `validate` / `models` / `version`), the crate routes (`resolve` / `codegen` / `pipeIo`), the durable run lifecycle (`start` → poll → result), and the Pipelex product routes (user profile, methods catalog, organizations, billing, API keys, onboarding, storage, runs list/update).

Besides the client, the package exports `runCodegenCheck` — a **pure** offline check that verifies a committed `codegen()` tree still matches its `codegen.lock`. It needs no server, no key, and no client instance, so it fits a CI job. See [`docs/crate-routes.md`](./docs/crate-routes.md#the-offline-check--runcodegencheck).

It also exports `summarizeUsage`, which folds a completed run's usage records into one null-aware summary — total cost, input and output tokens, and a per-pipe rollup — without any I/O. See [`docs/run-usage.md`](./docs/run-usage.md#summarizing-a-run--summarizeusage).

## Install

```bash
npm install @pipelex/sdk
```

## Run a method from the command line

The package publishes one command, `pipelex-sdk`, so a method runs with nothing installed but Node 22.12 or later and a key in `PIPELEX_API_KEY`:

```bash
npx @pipelex/sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs-template > inputs.json
npx @pipelex/sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs inputs.json
```

`--method` takes a published address, a catalog id (`mt_…`, which runs the method's latest published version, `mt_…@<n>` for a fixed version or `mt_…@draft` for its draft) or a local `.mthds` file or bundle directory. The run's main output is printed on stdout as JSON, and the run id, each uploaded file and every error on stderr. `script` writes a method its own command, a shell script pinned to this SDK's version:

```bash
npx @pipelex/sdk script --method github.com/acme/methods/receipt-review@v1.0.0
./receipt-review --inputs inputs.json
```

See [`docs/cli.md`](./docs/cli.md) for every flag, the output, the exit codes and Ctrl-C.

## Usage

```ts
import { PipelexApiClient } from "@pipelex/sdk";

// Base URL + key from PIPELEX_BASE_URL / PIPELEX_API_KEY, or pass them explicitly.
const client = new PipelexApiClient({
  baseUrl: "https://api.pipelex.com",
  apiKey: process.env.PIPELEX_API_KEY,
});

// Validate an MTHDS bundle (a 200-diagnostic verdict, discriminated on `is_valid`).
const report = await client.validate(["domain = 'demo'"]);
if (report.is_valid) {
  // Run it and wait for the result (durable start + poll on the hosted API).
  const result = await client.startAndWaitForResult({ pipe_code: "demo.greet" });
  // Every completed run delivers a resolved `main_stuff`, and every named stuff of
  // the run in `working_memory`.
  console.log(result.main_stuff);
}

// Or run a published method by address — resolved server-side (fetch at tag,
// commit SHA recorded as provenance on the start ack). Requires pipelex-api >= 0.21.0;
// on api.pipelex.com, availability follows the platform deploy that forwards it.
const ack = await client.start({
  method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
  inputs: { document: { url: "https://example.com/report.pdf" } },
});
console.log(ack.method_provenance); // { address, tag, commit_sha }

// Or run a saved method by its catalog id. A bare id runs its latest published version,
// `mt_…@3` version 3 and `mt_…@draft` its draft; the ack says which version runs.
const saved = await client.start({ method_id: "mt_abc123@3", inputs: {} });
console.log(saved.method_version); // 3
```

### Product routes

The hosted management surface (catalog, account, billing) hangs off the same client. Every route maps a non-2xx `problem+json` to a typed `ApiResponseError` (see [Errors](#errors) for how to branch on it):

```ts
import { PipelexApiClient, ApiResponseError, parseMethodSelector } from "@pipelex/sdk";

const client = new PipelexApiClient({ apiKey: process.env.PIPELEX_API_KEY });

const me = await client.getMe(); // GET /v1/me
const page = await client.listMethods(); // GET /v1/methods — one page: { items, nextCursor }
for await (const method of client.iterateMethods()) {
  // follows the cursor for callers that genuinely want the whole catalog
}
const created = await client.createMethod({ name: "Greeter", mthds: "domain = 'demo'" });

// A saved method has a draft, written freely and never validated, and immutable published
// versions. `updated_at` is the draft's token: echo it so no write or publish takes a draft
// you have not seen.
const draft = await client.writeDraft(created.method_id, {
  mthds: "domain = 'demo'\n",
  expected_updated_at: created.updated_at,
});
const published = await client.publishMethod(created.method_id, {
  expected_draft_updated_at: draft.updated_at,
});
if (published.outcome === "refused") console.error(published.message, published.validation);
else console.log(`version ${published.version.version}`); // "published" or "unchanged"
const versions = await client.listMethodVersions(created.method_id); // newest first
const { method_id, version } = parseMethodSelector("mt_abc123@3"); // the method routes take a bare id

try {
  const { portal_url } = await client.getBillingPortal();
  // open portal_url ...
} catch (err) {
  if (err instanceof ApiResponseError && err.type === "https://pipelex.com/errors/conflict") {
    // no subscription yet — start one via createCheckout(...)
  }
}
```

### Errors

Every error the SDK throws carries a verdict: `retryable`, whether asking again can succeed, and `errorDomain`, who can fix the failure (`input` for the caller, `config` for a change to the environment such as the credential, the plan or the base URL, `runtime` for nobody beforehand). Both are always decided, and `errorVerdictOf` reads them from anything a `catch` holds, returning `undefined` for what is not an SDK error, such as a bug in the calling code or your own abort. "Retryable" means a retry can succeed, not that it is safe: a start answered with a `500` may already have created a run.

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

A refused request throws an `ApiResponseError` carrying every member of the server's RFC 9457 problem document. **Branch on `errorDomain` and `type`**, as the hosted-envelope spec says, never on the HTTP status or the message: `errorDomain` is the verdict's domain and `type` is the stable URI of the error class, the same on every occurrence. The verdict is the server's when it sent a valid one, and otherwise the SDK's fallback, read from the status, except that an `input` or `config` domain the server sent without `retryable` is not retryable; `problemDocument` keeps what the server sent. `userAction` gives the next step, and `requestId` — from the body, or the `X-Request-ID` header — is the id to hand to support. `code` (the platform's native code, one-to-one with `type`) and `errorType` (the runner's exception class name) stay available as each surface's finer code, and `errors` carries the platform's field-level failures.

On the hosted API, a run that ends without completing throws a `RunFailedError` from `waitForResult`, `startAndWaitForResult` and `downloadArtifacts`, and comes back as the `failed` arm of `getRunResult`. (Against a bare `pipelex-api` runner, `startAndWaitForResult` runs the method with the blocking `execute`, so a failed run there throws the runner's `ApiResponseError`, whose problem members carry the same classification.) Its `status` is the run's terminal status and its `error` is the run's stored error report, checked field by field and typed as `RunErrorReport`: the reason in `message`, `error_domain`, `type_uri` and `retryable` to branch on, `user_action` as the next step, and the inference details. It is `null` when the run ended without a report, and the error's own verdict comes from it: the report's domain, and retryable only when the report says so. The report is the runner's VERBOSE one, provider text included, so what a person sees is your presentation:

```ts
import { RunFailedError } from "@pipelex/sdk";

try {
  await client.waitForResult(runId);
} catch (err) {
  if (err instanceof RunFailedError) {
    console.error(err.message); // "Run finished with status FAILED: <the reason>"
    console.error(err.error?.user_action?.detail ?? "No next step was given.");
  }
}
```

[`docs/errors.md`](./docs/errors.md) gives each class's verdict, the fallback table, and every field of both.

### Client identification

Every request to the API carries a `User-Agent` such as `pipelex-sdk-js/0.21.0 node/22.4.0 (darwin; arm64)`, which the hosted platform reads to attribute traffic to a client surface in its analytics. A program built on the SDK can put its own name in front with `appInfo`, shaped like Stripe's option of that name; an invalid field is refused at construction with a `TypeError`. In a browser the SDK sets no `User-Agent`. A program that also calls the API with its own `fetch` gets the same value from the exported `buildUserAgent(appInfo)`. The convention is the spec `conformance/specs/client-identification.md`, in the `conformance` repository, where the cross-repo specs sit beside the tests that verify them, and [`docs/client-identification.md`](./docs/client-identification.md) describes this SDK's side of it.

```ts
const client = new PipelexApiClient({ appInfo: { name: "acme-invoicer", version: "1.4.0" } });
// User-Agent: acme-invoicer/1.4.0 pipelex-sdk-js/<version> node/<version> (<os>; <arch>)
```

### Uploading from a browser

A browser page that holds a file but not the API key can still store it: the server that holds the key asks for an upload grant, and the page sends the file straight to storage with it. The file never crosses your server or the API gateway, so it can be as large as the service's own limit. The page imports `@pipelex/sdk/upload`, the browser-safe entry, which bundles with no Node builtin to mark external; the main `@pipelex/sdk` entry is Node-first.

```ts
// On the server, which holds the key:
const grant = await client.requestUploadGrant({
  filename: "report.pdf",
  content_type: "application/pdf",
  size: 48213,
});

// In the page, which holds the file:
import { uploadWithGrant } from "@pipelex/sdk/upload";
const { uri } = await uploadWithGrant(grant, file); // pipelex-storage://…
```

The full client surface is documented in [`docs/architecture.md`](./docs/architecture.md).

## Documentation

These pages ship inside the published package, so a reader who has only installed it opens them under `node_modules/@pipelex/sdk/docs/` — at the version being called, rather than whatever the repository's default branch says today. They are also browsable at [`Pipelex/pipelex-sdk/tree/main/js/docs`](https://github.com/Pipelex/pipelex-sdk/tree/main/js/docs), which is the address to give someone who has not installed the package.

| Page | What it covers |
| --- | --- |
| [`docs/architecture.md`](./docs/architecture.md) | The whole client surface: the request pipeline, every route, the typed errors |
| [`docs/cli.md`](./docs/cli.md) | The `pipelex-sdk` command: `run` and `script`, the environment it reads, what it prints, its exit codes, how it reads a bundle, and the case table it shares with the Python SDK |
| [`docs/run-results.md`](./docs/run-results.md) | Every field of `RunResults` — the run id as a durable handle, `main_stuff`, `working_memory`, `graph_spec`, the usage pair, produced files |
| [`docs/run-usage.md`](./docs/run-usage.md) | What a run consumed, record by record, and `summarizeUsage` which folds them into one reading |
| [`docs/artifact-download.md`](./docs/artifact-download.md) | Turning the `pipelex-storage://` references a run produced back into bytes: `locateArtifacts`, `collectArtifacts`, `resolveArtifacts`, `fetchArtifact`, `downloadArtifacts`, and how a saved file is named after the field it fills |
| [`docs/input-preparation.md`](./docs/input-preparation.md) | The other direction — `uploadFile` and `prepareInputs`, which turn local files into references a run can take, and the upload grant a browser page sends a file with |
| [`docs/crate-routes.md`](./docs/crate-routes.md) | `resolve`, `codegen` and `pipeIo` — the normalized crate, the stamped types, and a method's I/O artifacts without a validation — and the offline `runCodegenCheck` that guards a committed tree |
| [`docs/client-identification.md`](./docs/client-identification.md) | The `User-Agent` every API request carries, and `appInfo`, the option that puts your program's name in front of it |
| [`docs/errors.md`](./docs/errors.md) | The verdict every error carries (`retryable`, `errorDomain`, `errorVerdictOf`), a failed run's stored error report on `RunFailedError` and `RunRead`, and every member of a refused request's `ApiResponseError`, with the fields to branch on |

## Develop

```bash
make install    # Install dependencies
make check      # Lint + format check + typecheck + build + depcruise (alias: make c)
make test       # Run the test suite (alias: make t)
make all        # Clean, check, and test
```

Always run `make check` before committing.

## License

[MIT](./LICENSE)
