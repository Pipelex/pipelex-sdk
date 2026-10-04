# Changelog

## [Unreleased]

### Changed

- **`@pipelex/sdk` 0.30.0, whose file preparation reads `POST /v1/pipe-io` (Breaking)**: bumped from 0.26.0. The PDF example's run actions, and every action `make add-method` writes for a method that takes a file, prepare their inputs with the SDK's `prepareInputs`, which now reads the method's inputs from `POST /v1/pipe-io` instead of validating the method, so preparing a file no longer dry-runs it. `api.pipelex.com` serves that route, and so does `pipelex-api` from v0.33.1; a project whose `PIPELEX_BASE_URL` names an older runner moves it forward, or its file-taking methods are refused before the run. Each action already names its pipe by its qualified reference, so the route selects the same pipe, and a pipe it cannot select is reported as an input-preparation failure carrying the server's reason. The SDK's other breaking changes in between, the `/v1/build/*` wrappers removed, slimmer run-history rows, an optional `main_stuff` and model decks carrying `judgment` models, reach nothing the app calls.
- **Two copies of `mthds`**: through the SDK the app now installs `mthds` 0.30 beside the 0.25 that `@pipelex/mthds-form` asks for, so `npm ls mthds` lists both until the form kernel moves to `mthds` 0.30. The protocol types the app passes from one to the other are still declared identically, so the app type-checks, and the template's `bump-mthds-form` skill now says that two copies can check clean instead of claiming the two packages always share one.

## [v0.29.1] - 2026-10-02

### Fixed

- **Exported to the template repository**: 0.29.0 was released in `Pipelex/pipelex-sdk` but never exported to `Pipelex/pipelex-starter-js`, because that release stopped before its export, so 0.29.1, which carries the same template, is the first version the template repository receives from `Pipelex/pipelex-sdk`.

## [v0.29.0] - 2026-10-02

### Changed

- **Version 0.29.0, shared with the SDKs**: the template is now developed in the `starter-js/` directory of `Pipelex/pipelex-sdk` and exported to `Pipelex/pipelex-starter-js` at each release that ships it, under the one version number it shares with `@pipelex/sdk`, `pipelex-sdk`, the Python starter and `@pipelex/create-method-app`, so its number jumped from 0.6.3 to 0.29.0 for that reason alone, and its later versions may skip numbers.
- **`/bump-sdk` reads the SDK's changelog from `Pipelex/pipelex-sdk`**: without a local checkout, the skill now fetches `@pipelex/sdk`'s changelog from the `js/` directory of `Pipelex/pipelex-sdk`, where the SDK is developed, and the documents that point at the method-app template link to its directory there.
- **`make use-local` takes the SDK from a `pipelex-sdk` checkout**: the target now builds `@pipelex/sdk` from `../pipelex-sdk/js`, the `js/` directory of a `Pipelex/pipelex-sdk` checkout beside the project, where it looked for a `../pipelex-sdk-js` checkout, and `/bump-sdk` reads a local changelog from the same place. The form kernel is still `../mthds-form`.
- **The workflows run on Node 24 actions**: `.github/workflows/lint-check.yml` and `tests-check.yml` use `actions/checkout@v5` and `actions/setup-node@v5` instead of `actions/checkout@v4` and `actions/setup-node@v4`, whose Node 20 runtime GitHub Actions has retired, so a project made from the template no longer starts with a deprecation warning on every job; a project made earlier makes the same changes in those two files.

## [v0.6.3] - 2026-10-01

### Removed

- **The `/wip/` ignore rule**: the template's `.gitignore` no longer ignores a `wip/` directory, and the `/bump-sdk` skill's rename check no longer names `wip/` notes. A project that keeps untracked notes in `wip/` adds the line back to its own `.gitignore`.

### Security

- **Next.js `^16.3.8`**: `next` and `eslint-config-next` move past the critical remote-code-execution advisory GHSA-vcvr-r3jv-pc5j in `next/og`'s `ImageResponse`, which the template does not import but a project made from it could, and the re-lock also fixes the transitive `brace-expansion` and `fast-uri` advisories, leaving `npm audit` clean.

## [v0.6.2] - 2026-09-27

### Changed

- **`@pipelex/sdk` 0.26.0**: bumped from 0.24.0, which carries a failed run's stored error report on `RunFailedError` and the whole problem document of a refused request on `ApiResponseError`, the two things the fixes below read. The other breaking change in between removes the gateway key surface, which this app does not use.

### Fixed

- **A failed durable run says why**: an example whose durable run fails now shows the runtime's reason with the failing pipe, its advice as the next step, whether running it again can help, and a line to quote to support with the run id, the error type and when the run ended, all read from the run's stored error report, where it used to show only "Run finished with status FAILED; no result available". A model provider's raw error text is kept out of everything the person can read, and a run that ended with no stored report keeps the old sentence.
- **A refused run says what to do**: when the runner refuses to run a method, at the start of a durable run or on a blocking run, an example's failure display now shows the runtime's next step in place of a generic hint, says whether running it again can help when the runtime says so, and lists the method's validation items under the technical details, with an unknown model's reference and the model deck's suggestions. An answer that carries none of this keeps its old wording.

## [v0.6.1] - 2026-09-24

### Changed

- **Runs name their pipe by its qualified ref**: every action, and every action `make add-method` scaffolds, sends `pipe_code` as `<domain>.<pipe_code>` (`extract_entities.extract_entities`) instead of the bare code. The runtime looks a qualified ref up exactly, where it searches every domain of the method for a bare code and refuses one that two domains declare, so a run keeps working after its method gains a second domain.
- **The keyed scripts run against the production API**: `npm run codegen`, `npm run codegen:verify` and `make add-method` no longer need `PIPELEX_BASE_URL=https://api-dev.pipelex.com`, because `api.pipelex.com` now serves the form views codegen needs and resolves both catalog ids and package addresses. A `.env.local` or shell that set it for them can drop the line.

## [v0.6.0] - 2026-09-24

### Highlights

- **A dropped file goes from the browser straight to Pipelex storage**, through an upload grant, so a run carries a reference and never the file's bytes, and `make add-method` writes the same seam for any method with a file input.
- **Every finished run keeps its id**, shown under each tab's result with a Copy button in both modes, beside a closed usage-and-cost disclosure.

### Added

- **A finished run keeps its id**: under every tab's result, `<RunDetails>` shows the run's id, selectable with a Copy button, in Blocking mode too, and folds the token-and-cost table into a closed "Usage and cost" disclosure. `useRun`'s `done` state and `BlockingOutcome` carry `runId`, a blocking run that finished but could not be read keeps its id on the error, and the server logs `[pipelex] run finished: <id>` for every blocking run.
- **`html[data-hydrated]`, a hydration signal for browser scripts**: the root layout sets it once React has hydrated the page, so a script waits for it before clicking, dropping a file or taking a screenshot. The new offline `home` e2e spec waits for it and fails on a hydration error.

### Changed

- **`@pipelex/sdk` 0.24.0**: bumped from 0.20.1, which brings the upload grant (`requestUploadGrant`), the browser-safe `@pipelex/sdk/upload` entry, and an `uploadWithGrant` that bounds each upload by a time limit growing with the file's size. A failed upload is named by the SDK's own error `code`, so a refusal from storage, storage out of reach, and storage failing or giving up on the bytes each read as what they are. The other breaking changes in between are confined to the artifact-download helpers, which this app does not use.
- **`@pipelex/mthds-form` 0.10.1**: bumped from 0.8.0. An enum value reads as words in a form and a result ("Legal") while its code still travels on the wire, a table of records keeps five columns chosen by rank and opens a row to the whole record, a nested record in a cell is named by its first text field, and a stored file's card no longer prints its `pipelex-storage://` address, the "paste a URL instead" input reading `https://…` and "Attached file" titling a file with no name. The kernel now judges every URL it paints, a resolver's answer included, and shows an image in a text result's Markdown as a link rather than loading it, so the PDF example's preview of a stored reference settles on the kernel's placeholder where it used to show "Preview unavailable". It gets there with no resolver: `PdfForm` no longer passes the one that handed a storage reference straight back, which 0.10.0 still needed to keep that preview from spinning forever.
- **File inputs offer only what their upload action grants, and `useRunInputs` takes an options object (Breaking)**: the PDF example's dropzone used to accept a PNG or a JPEG that its action then refused, and `useRunInputs(CONTRACT, DESCRIPTOR, { allowedMimes, initialValues })` now narrows each file input to the method's `ALLOWED_MIMES` through the kernel's `narrowFileFormats`, the seed values moving from the third argument to `initialValues`. The list moves out of the action into `src/types/<camel>Uploads.ts` (`summarizePdfUploads.ts` for the PDF example), which the action and the form both import, and `make add-method` writes it for any method with a file input.
- **A dropped file goes straight to Pipelex storage (Breaking)**: the PDF example asks its new `requestSummarizePdfUpload` Server Action for an upload grant and sends the file from the browser with `uploadWithGrant`, so a run carries a `pipelex-storage://` reference and never the file's bytes, and `make add-method` emits the same grant action for any method with a file input. `src/lib/fileEncoding.ts` becomes `src/lib/fileInputs.ts`, whose `checkFileInputs` now refuses a `data:` URL; `MAX_PDF_BYTES` becomes `MAX_FILE_BYTES`, the platform's 50 MiB; `src/lib/clientFile.ts` is removed and `next.config.js` no longer raises the Server Action body limit. The upload needs an API that serves `POST /v1/upload/grant`, and against one that does not the page says so beside the field as `upload_unavailable`.
- **Inputs too large to send are refused with their size**: `useRun` measures a run's inputs before calling its action and refuses a set past `MAX_RUN_INPUT_BYTES` as `inputs_too_large`, where Next's body limit used to surface as "Could not reach the server".
- **The Next.js development badge is off**: `next.config.js` sets `devIndicators: false`; compile and runtime errors still surface.

### Removed

- **The result view's own URL policy**: `<RunResult>` no longer runs a result through `scrubResultUrls` before the form kernel renders it, nor shows the note naming the file references that policy removed, because the kernel's own URL gate has refused what it was written to refuse since 0.9.0. A file URL the policy removed and the kernel accepts now reaches the page: a cleartext `http:` URL, at which a previewable document is framed as well as linked; a GIF or AVIF `data:` URL, painted and linked; a PDF `data:` URL, linked but never framed; a `blob:` URL; and a same-origin path named in the payload, painted and linked but never framed. A file the kernel refuses is named by the kernel's own file card, and the image example's narrower still fails a run whose image URL it refuses before the result view sees it. A project made from an earlier release can delete its `src/lib/resultUrls.ts` the same way only once it runs `@pipelex/mthds-form` 0.9.0 or later: the 0.8 kernel frames a payload's `data:text/html` document in an unsandboxed frame, where its script runs and draws its own interface inside the app's page, though from an opaque origin that cannot read the app's cookies or DOM.

## [v0.5.0] - 2026-09-22

### Highlights

- **Nothing about a method's IO is hand-written any more.** Each tab's form and result view are rendered by `@pipelex/mthds-form` from the contracts `npm run codegen` commits, and the Server Actions gate their inputs with the same kernel the browser uses.
- **`make add-method` turns a method into a tab in one command** — from a bundle, a catalog id or a published address — and the new "Text stats" tab is its untouched output.

### Added

- **Input forms rendered from each method's contract**: `npm run codegen` asks `POST /v1/validate` for the pipe IO contracts and the `input_form` and `output_form` views and commits them as `src/generated/<method>/contracts.ts`, and every tab derives its fields, labels, controls and required-ness from `INPUT_FORM` through `<RunInputsForm>` and `useRunInputs(CONTRACT, DESCRIPTOR, seed?)`. Add an input to a bundle, regenerate, and it appears with no component edit; `docs/input-form.md` is the reference.
- **Results rendered from each method's output contract**: each tab builds `RESULT_FIELD = requireResultField(OUTPUT_FORM, CONTRACT, …)` and renders `<RunResult>`, the kernel's `<StuffViewer>` inside a labelled section, so nothing inspects a payload to decide how to lay it out.
- **A server-side input gate that shares the browser's rules**: every Server Action opens with `gateRunInputs(CONTRACT, data)` from `src/lib/runInputs.ts`, the kernel's own gate and a strict superset of the readiness rule that lights the Run button, and a test runs both sides over one table of inputs. `requireContract` and `requireInputForm` throw on a missed lookup instead of rendering an empty form with a live Run button.
- **`make add-method`**: `METHOD=<bundle path | mt_… | address>` scaffolds a new tab — the method directory, its generated tree, a narrower, the Server Action trio, an action test, a form and the tab entry — rendering and formatting every file before writing any, refusing rather than overwriting, and holding a lock so two runs cannot interleave. `DRY_RUN=1` prints the plan and `PIPE=`, `NAME=` and `LABEL=` override the derived choices; `docs/add-method.md` is the reference.
- **Selector-sourced methods, `methods/<name>/method.json`**: a method directory holds either `.mthds` bundles or exactly one `method_ref` or `method_id` selector naming a method that lives elsewhere, and codegen, `codegen:check` and `sources.json` treat both kinds alike. The keyed scripts read `GET /v1/version` first and refuse with the base URL and the missing capability named instead of surfacing a bare `403`.
- **Two new examples, "Complex inputs" and "Text stats"**: `methods/complex-form/` takes a required text, an optional structured input and a plural text input, so its form shows a nested card, an enum and a repeater while its component names no input; `methods/text-stats/` names the published `github.com/Pipelex/methods/text_stats@v0.1.1`, and its tab is `make add-method`'s output committed untouched, so every `make all` compiles and tests what the scaffold emits.
- **`wireListOutput` for plural outputs**: the runtime renders a list output as a `{ items }` envelope on the blocking path and as a bare array on the durable path, so a plural narrower parses `z.array(<Code>Schema)` over `wireListOutput(results, <Code>Schema)`, which unwraps the envelope when it sees one. It expires once the runtime settles on one rendering.
- **`useFileInputs`, the file seam**: drop, size early-exit, encode and write-back of a `FileValue` at the field's path, extracted from `PdfForm` so any form with a file input composes it.
- **A drift gate for `contracts.ts`**: the file carries no codegen stamp, so its SHA-256 rides in `sources.json`'s `derived` map for `codegen:check`, and `codegen:verify` re-fetches `/v1/validate` and compares the rendered bytes. `npm run codegen` also refuses a server artifact that would land on a file it writes itself.
- **A durable run shows its id**: the status card and the error display print the run id, selectable in one click, and the server logs it when the run starts, so a run started from a local bundle can be looked up afterwards.

### Changed

- **Server Actions take the method's schema-shaped input dict (Breaking)**: `runExtractEntitiesBlocking("some text")` becomes `runExtractEntitiesBlocking({ text: { text: "some text" } })` and the PDF trio takes `{ document: { url, filename } }`, with inputs travelling as `{concept, content}` envelopes. The hand-written per-input guards are deleted in favour of the gate.
- **One bundle loader, `loadMethodBundles(name)` (Breaking)**: it replaces the per-demo loaders and reads every `.mthds` file of `methods/<name>/` in the order `npm run codegen` projects them, on every platform, so a bundle split across several files runs as it was generated.
- **The committed trees are regenerated on engine `0.56.0` (Breaking)**: `contracts.ts` carries `json_schema` on each output contract, which the `mthds` protocol types now require, and every crate fingerprint is unchanged. Regeneration currently needs `PIPELEX_BASE_URL=https://api-dev.pipelex.com`, because `api.pipelex.com` serves neither form view nor `method_ref`; `codegen:check` stays offline, so `make all` needs no key.
- **Tailwind 4**: the form kernel is written in v4's vocabulary, which a v3 build compiles to nothing. `tailwind.config.ts` is retired for `@source`, `@theme inline` and `tw-animate-css` in `src/app/globals.css`, `@pipelex/mthds-form/theme.css` supplies the stock tokens a host overrides, and `src/app/globals.test.ts` compiles the stylesheet so a lost `@source` or a double-wrapped `hsl(hsl(…))` token fails `make test`.
- **The PDF example uses the kernel's dropzone**, including "paste a URL instead", so a document can be an `https://` or `pipelex-storage://` reference with no upload; the kernel shuts every way into the value while a file encodes.
- **The file gate checks the scheme before the bytes**: `checkFileInputs` accepts only `data:`, `https://` and `pipelex-storage://` — any other string would be read by `prepareInputs` as a server-side file path — and finds every file position by walking the method's wire descriptor, so a plural or nested file input is gated like a top-level one.
- **`blockingRun` and `durableRun` take `PipelexStartOptions`**, so an action can name a method by `method_ref` or `method_id`.
- **`ExampleTabs` is data-driven**: `TABS` carries each example's component, `// add-method:imports` and `// add-method:tabs` mark where `make add-method` inserts, and the tab row wraps on narrow screens.
- **The dev server port is `APP_PORT`, default `4300`**: it moved off `4100`, which the `pipelex-server` local stack holds, and a `port-check` before `run`, `start` and the e2e targets names the checkout already serving the port instead of printing a bare `EADDRINUSE`, and stops e2e from silently reusing another checkout's server.
- **`make use-local` and `make use-npm` cover `@pipelex/mthds-form`** alongside `@pipelex/sdk`, in one install.
- **`@pipelex/sdk` `^0.20.1` (was `^0.13.0`) and `@pipelex/mthds-form` `^0.8.0`**: the blocking path adapts its response through the SDK's `resultsFromExecute`, so every `RunResults` field, `working_memory` included, reads the same in both modes, and the PDF action names the `pipe_ref` that `prepareInputs` now requires.

### Fixed

- **A PDF between roughly 3.2 MB and the 8 MB cap crashed the Server Action**: the base64 shape check was a backtracking regex that overflowed V8's stack, which also made `file_too_large` unreachable. The check is now linear, and size is tested before shape.
- **The dev server no longer logs uploaded files**: `next.config.js` sets `logging.serverFunctions: false`, so a file input's base64 `data:` URL is no longer printed with every Server Action call.
- **`make help` lists the e2e targets again**: its pattern allowed no digits, so `test-e2e` and `test-e2e-ui` never matched.
- **The `bump-mthds-form` skill names the seams this template actually imports**, rather than a hand-rolled gate it no longer has.

### Removed

- **The hand-written result components (Breaking)**: `EntityResult`, `PdfSummaryResult` and `ImageResult` are gone, replaced by `<RunResult>`. The narrowers in `src/types/` are untouched, and a bespoke view is still open to an output that earns one.

### Security

- **The app's servers listen on loopback by default (Breaking)**: `make dev`, `make start`, `npm run dev` and `npm run start` bind `127.0.0.1`, because anyone who could reach the server ran methods billed to the developer's `PIPELEX_API_KEY`. `make dev APP_HOST=0.0.0.0` widens it, and the Makefile warns whenever a server starts beyond loopback.
- **Next.js `^16.3.5`**: `next` and `eslint-config-next` move past the critical remote-code-execution advisories GHSA-p293-qw3h-jr36 and GHSA-2xp9-vwfh-vxw4, and the re-lock leaves `npm audit` clean.
- **The result view keeps its own URL policy**: `scrubResultUrls` (`src/lib/resultUrls.ts`) removes any file URL the kernel would paint, link or frame that is not `https:` or a PNG, JPEG or WebP `data:` URL, and `<RunResult>` says what it removed. It is a stopgap until `@pipelex/mthds-form` narrows its own policy, and does not cover Markdown inside a `native.Text` result.

## [v0.4.0] - 2026-08-21

### Added

- **Type generation from the `.mthds` bundles.** `npm run codegen` (`make codegen`) sends every method under `methods/` to the API's `/v1/codegen` route and writes what comes back, byte-for-byte, to `src/generated/<method>/`: zod schemas with their inferred TypeScript types, binders over those schemas, and a `codegen.lock`. The trees are committed, so `git clone && make all` passes without an API key. This replaces the hand-written output shapes the template used to keep in `src/types/`, so the types can no longer drift from the bundles that declare them. One caveat while it lasts: `/v1/codegen` is served by `api-dev.pipelex.com` and `api.pipelex.com` still answers `403` pending its deploy, so regeneration needs `PIPELEX_BASE_URL` pointed at api-dev today.
- **Two staleness gates over the generated trees.** `npm run codegen:check` (`make codegen-check`) is offline and needs no key: it verifies each tree against its own lock and compares a `sources.json` sidecar of source hashes against the `.mthds` files on disk, so editing a bundle without regenerating fails the build instead of shipping types that quietly lie. It is wired into `make check`. `npm run codegen:verify` (`make codegen-verify`) asks the question the offline check cannot — whether the committed tree still comes from the crate the method resolves to today — by comparing live `crate_fingerprint`s against the locks. It needs a key, writes nothing, and stays out of `make all`.
- **Security guards on the codegen scripts.** A plaintext `http:` guard refuses a non-loopback `PIPELEX_BASE_URL`, since the scripts send the API key as a bearer token and write server-supplied TypeScript into the repo. A containment guard checks every path the response names before anything is written, refusing the method whole if one resolves outside its tree.
- **`import "server-only"` in `src/lib/wireOutput.ts`**, so calling a generated narrower from a `"use client"` component fails the Next build instead of silently shipping zod plus every generated schema to the browser.
- **`tsconfig.scripts.json`**, which type-checks `scripts/` under `make typecheck` the way `tsconfig.e2e.json` covers the Playwright specs. The scripts are native-Node TypeScript, so the template gains no `tsx` or `ts-node` dependency.
- **A `docs/` directory, `AGENTS.md`, and a removal checklist.** `docs/codegen.md` is the design reference for the generated-types workflow and `docs/adopt-in-an-existing-project.md` is an executable checklist for transplanting the pattern into an existing app. `AGENTS.md` gives agents other than Claude Code the rules that matter. The README's new "Remove an example" section lists the full vertical slice a demo owns, so stripping one doesn't have to be assembled from compile errors.

### Changed

- **Breaking: output field names are wire-native snake_case.** `DocumentSummary` is now `{ title, doc_type, key_points }` and the image envelope carries `public_url`, `mime_type`, and `source_prompt`. The names travel unchanged from the bundle to the components, because a hand-maintained camelCase mirror is exactly the duplication this release removes.
- **Breaking: `src/lib/runOutput.ts` is gone**, replaced by `src/lib/wireOutput.ts`. The narrowers in `src/types/` are now thin adapters over the generated binders rather than hand-written shape-checkers; `findOutputContent`'s predicate search is subsumed by the generated schema's own `parse`, which rejects arrays, primitives, and `null` with a message naming the failing field.
- **A schema-guided wire-null normalization step, and it is a workaround with an expiry.** The projection emits a non-required concept field as `.optional()`, which in zod rejects `null`, while the runtime serializes an unset optional field as an explicit `null` — verified against a live image run. `dropWireNulls(value, schema)` strips a null-valued key only where the schema says a `null` there means absence, leaving a `null` inside a `z.record()`, a `.nullable()` field or a `.default()` field exactly as the pipeline sent it. It is deletable once the emitter emits `.nullish()`, and is reported upstream.
- **Bumped `@pipelex/sdk` to `^0.13.0`** (the declared range was `^0.5.1`) and added `zod` as a runtime dependency, since the generated binders validate run output inside Server Actions at request time. No migration was needed here: the intervening breaking changes are on the methods-catalog surface this template never calls, while `0.12.0` and `0.13.0` added the crate routes and the offline drift check the new scripts are built on.
- **`src/generated/` is excluded from Prettier and ESLint, deliberately.** The emitter targets Prettier's defaults while this repo prints at 100 columns, so formatting those files would rewrite their bytes and break every stamp. TypeScript still covers them in full.
- **The codegen scripts are thin CLI entries over a tested `scripts/lib/`.** All three ran their logic at module top level, so importing one executed a whole run and the orchestration could not be tested — including `writeTree`, the only code in the template that deletes files. Each module now owns its whole contract, exit code included.
- **The template assumes the hosted Pipelex API throughout — docs, error copy, comments, and specs.** Self-hosting is no longer offered as a supported path, and the localhost special case is gone: when a request doesn't reach a working Pipelex API, the error now says what the configured URL fails to provide and steers to verifying `PIPELEX_BASE_URL`.
- **The shared-helper tests no longer import any example's adapter.** `blockingRun.test.ts` and `durableRun.test.ts` now use inline fixture narrowers, so removing a demo example never touches the shared layer's tests.

### Fixed

- **Breaking: `parseGeneratedImage` gates a `data:` URL's media type against an allow-list, not just its scheme.** The validated URL feeds `<ImageResult>`'s download link as well as its `<img>`, so a saved payload runs on a `file://` origin once opened — which left `data:image/svg+xml` open as an active-content sink under a media type that passes for an image. Only `image/png`, `image/jpeg`, and `image/webp` are accepted, with a message of its own for a refused SVG. `http:` and `https:` outputs are unchanged, which is every image this template actually receives.
- **The codegen gate could be silently wrong in several ways, each now producing a loud, correct verdict.** Symlinks and special files were invisible to the walk and are now refused by name; lossy UTF-8 decoding let a corrupted artifact hash to its locked value and is now fatal; an empty `methods/` exited before orphan detection ever ran; a tree differing from its method's name in case only now gets a rename remedy rather than a delete one; and a stray `.DS_Store` no longer fails the check with a remedy naming a directory that does not exist.
- **`npm run codegen` deleted hand-written files parked in a generated tree.** Cleanup decided what it could remove with a filename test while the SDK's orphan rule also requires a codegen stamp, so a sibling module the generated header invites consumers to write was reported healthy by the check and destroyed by the next regeneration. Cleanup now defers to the SDK's own verdict, so the two agree by construction.
- **`codegen:check` reported every method stale on a Windows checkout.** Source hashes were taken over raw bytes, so a CRLF checkout disagreed with every committed hash. `hashSource` now normalizes line endings before hashing, the same normalization the SDK already applies to artifacts and locks. Nothing changes on an LF checkout.
- **A renamed lock file could have left the offline check validating the obsolete one.** The writer took whatever `lock_filename` the response named while the check has always opened `codegen.lock`; it now refuses any other name and writes nothing for that method.
- **`dropWireNulls` is depth-capped**, so a self-referential concept can no longer overflow the stack inside a Server Action. Past the cap the value passes through untouched and the generated schema still owns the verdict.
- **An empty-string `public_url` failed an image run that had a perfectly good `url`.** `public_url ?? url` let `""` win over the real URL; both that and `<ImageResult>`'s `alt` text now use `||`.
- **`make use-npm` restored a stale version instead of the current one.** It ran `npm install @pipelex/sdk`, which re-resolves the range already declared rather than fetching the current release — a silent downgrade, since a caret range never crosses a minor pre-1.0. It now installs `@pipelex/sdk@latest` and echoes the version it restored.
- **The README's "File & image inputs" section documented code deleted in v0.3.0.** It now matches the actual flow: validate the data URL server-side, hand it to `client.prepareInputs()`, and run against the `pipelex-storage://` reference it returns.

### Removed

- **Internal planning notes (`wip/`) are untracked again**, as v0.1.1 already decided before open-sourcing. The codegen design rationale they held now lives in `docs/codegen.md`.

### Security

- **Bumped `next` to `^16.3.1`** (was `^16.2.9`), clearing every high-severity advisory `npm audit --omit=dev` reported against this template's production tree. All of them came in through Next.js — Server Action denial of service, SSRF via rewrites and on custom servers, cache confusion, Image Optimization denial of service, disclosure of internal Server Function endpoints, a Turbopack middleware bypass — plus its pinned transitives `postcss`, `nanoid`, and `sharp`. `eslint-config-next` was raised alongside it to keep the linter in lockstep.
- **Bumped the `postcss` dev dependency to `^8.5.23`**, resolving arbitrary `.map` file disclosure and XSS through unescaped `</style>` in stringify output, so the full `npm audit` is clean with development dependencies included.

## [v0.3.0] - 2026-07-22

### Added

- **Cost Reports (`tokens_usages`)**: Added token usage and cost tracking for both blocking and durable runs, surfaced via a new `<CostReport>` component (rendered across the Entity, Image, and PDF example forms) that breaks down per-call token usage, model types, and computed USD costs. Backed by new `src/lib/usageReport.ts` utilities that parse and project raw `tokens_usages` and `usage_assembly_error` data into a render-ready format.
- **Upload Error Handling**: Added an `upload_failed` error kind in `src/lib/errors.ts` to classify SDK `InputPreparationError`s (e.g., `UnsupportedUploadCapabilityError`, `RejectedAssetError`, `UploadAuthenticationError`) with actionable, user-friendly UI messages.

### Changed

- **Cleaner File Uploads (Breaking)**: Replaced the hand-rolled base64 `Document` envelope in the PDF summarization pipeline with the SDK's `client.prepareInputs()`. Files now upload directly to Pipelex storage and pass to the run as lightweight `pipelex-storage://` URIs. This removes `buildDocumentInput` and `DocumentInput` from `src/lib/fileEncoding.ts` (pre-flight size and MIME validation remains intact).
- **Improved Polling Status UI**: Refactored the `useRun` hook and `<RunStatus>` component to replace the generic `degraded` boolean with a descriptive `health` state (`"reconnecting"` or `"retrying"`), providing cause-specific copy during transient network blips or server reconnects.
- **Development Port**: Changed the default local development and Playwright testing port from `3000` to `4100` (`package.json`, `README.md`, `playwright.config.ts`).
- **Dependencies**: Bumped `@pipelex/sdk` from `0.3.1` to `^0.5.1` (through `0.4.0` and `0.5.0`). `0.4.0`'s breaking changes are scoped to the `/v1/build/*` and tools routes this repo doesn't call; `0.5.0` delivered the typed `tokens_usages` and `prepareInputs` upload surface the two features above build on.
- **Testing**: Updated action-layer tests to use `toMatchObject` instead of `toEqual` to accommodate the new `usage` sibling property in run outcomes.

### Security

- **SDK Dependency Patch**: The final `0.5.1` hop inherits a patch for a transitive **dev** dependency (`brace-expansion`, CVE-2026-13149) in the SDK's own lockfile. That dependency is never shipped in the SDK's runtime surface, so no code changes were required here.

## [v0.2.1] - 2026-07-10

### Changed

- Bumped `@pipelex/sdk` to `0.3.1` (was `0.3.0`). A coordination-only bump — the SDK raises its own `mthds` dependency floor to `^0.18.0` (CLI/tooling changes that don't touch the `mthds/protocol` wire types the SDK imports); the SDK's own surface is unchanged, so no code changes were needed in this repo.

## [v0.2.0] - 2026-07-05

### Changed

- Breaking: swapped the Pipelex SDK from `mthds` (`MthdsApiClient`) to `@pipelex/sdk` (`PipelexApiClient`). `PipelexApiClient` reads `PIPELEX_API_KEY` / `PIPELEX_BASE_URL` natively, so the client is constructed bare with no env-var bridging. Error classes are imported from the `@pipelex/sdk` barrel (it has no `/errors` subpath; the barrel is client-bundle-safe).
- Breaking: renamed the env var `PIPELEX_API_URL` to `PIPELEX_BASE_URL` for consistency with the SDK's `baseUrl` naming. There is no read alias — update `.env.local` / your environment.
- `make use-local` / `make use-npm` now target the sibling `../pipelex-sdk-js` repo instead of `../mthds-js`.
- Bumped `@pipelex/sdk` to `0.2.0` (was `0.1.5`). No code changes needed for the `0.2.0` breaking renames (constructor option `apiToken` → `apiKey`, env var `PIPELEX_API_URL` → `PIPELEX_BASE_URL`): this repo constructs `PipelexApiClient` bare and already used `PIPELEX_BASE_URL`.
- Bumped `@pipelex/sdk` to `0.2.1` (was `0.2.0`), which makes the ESM-only SDK loadable from CommonJS (`default` export condition). The e2e specs now import `DEFAULT_API_BASE_URL` from the SDK directly instead of mirroring it as a local constant in `e2e/liveApi.ts`.
- Raised the minimum Node.js to 22.12 (`engines.node: ">=22.12.0"`, was `>=22`), matching the SDK's new floor: Playwright loads the e2e specs via CommonJS `require()`, and `require(esm)` is only unflagged from Node 22.12.
- Bumped `@pipelex/sdk` to `0.3.0` — one resolved output accessor across both execution modes. `RunResults.main_stuff` is now required (non-null), and the blocking `execute()` returns a `PipelexExecuteResult` whose `.main_stuff` the SDK resolves out of the working memory (via the response's `main_stuff_name`). `executeBlockingRun` therefore adapts the blocking response onto `RunResults` as `{ pipeline_run_id, main_stuff }`, and `findOutputContent` reads only `main_stuff` — the `pipe_output` working-memory search arm is gone, so both modes narrow the same resolved field.

### Fixed

- Blocking and durable modes now agree on which output is the "main" one. Previously the blocking path dropped the server's `main_stuff_name` and had `findOutputContent` guess the main output by predicate-shape-matching the first working-memory entry, so a pipeline with an intermediate stuff matching the same narrower predicate could render the wrong result in blocking mode while durable mode read the true `main_stuff` and was correct. With the SDK resolving `.main_stuff` on both paths, the shape-guessing is gone and the two modes can't disagree (closes the latent finding tracked in `wip/durable-runs-review-followups.md` #6).

## [v0.1.1] - 2026-05-21

### Added

- PDF summary example: `summarize-pdf` method, Server Action, and form/result components
- Image generation example: `generate-image` method with `gpt-image-1-mini`
- Sample PDF (`public/sample-invoice.pdf`) so the PDF example works out of the box
- Tabbed UI (`ExampleTabs`) to switch between the three examples
- Structured error handling: `classifyPipelineError`, `PipelineError`, `ErrorDisplay`, tagged `BadPipelineOutputError` subclasses
- Transport-level rejection handling via `classifyTransportError` for client-side `await` failures
- File input pipeline: client-side base64 encoding (`clientFile.ts`) + server-side validation/envelope (`fileEncoding.ts`)

### Changed

- Bumped `mthds` SDK to `0.7.1`
- Server Actions now return discriminated `{ ok: true } | { ok: false, error }` unions instead of throwing across the server→client boundary

### Fixed

- README docs for `make use-local` corrected to match the tarball install (Turbopack does not follow symlinks)

### Repository

- Added MIT `LICENSE` (Evotis S.A.S.) and refreshed the README license section ahead of open-sourcing
- Added CI workflows `lint-check` (runs `make check`) and `tests-check` (runs `make agent-test` + `make build`) on PRs to `main` and `release/vX.Y.Z`
- Removed internal-only planning docs (`TODOS.md`, `wip/`)
- Gitignored `.claude/settings.local.json` so per-user Claude Code settings don't get committed
