# Changelog

## [v0.5.7] - 2026-10-01

### Security

- **Next.js 16.3.8**: the web app template requires `next` and `eslint-config-next` at `^16.3.8` and locks 16.3.8, past the critical remote-code-execution advisory in `next/og`'s `ImageResponse` that affects Next.js 16.2.0 through 16.3.5 (GHSA-vcvr-r3jv-pc5j). The template does not import `next/og`, but a project made from it inherits the lock and could. The lock also takes the patched `brace-expansion` and `fast-uri`, so `npm audit` reports nothing.

## [v0.5.6] - 2026-09-27

### Changed

- **The web app template runs on `@pipelex/sdk` 0.26.0**: the SDK's `RunFailedError` now carries a failed run's stored error report and its `ApiResponseError` a refused request's problem document, which the template's failure display reads. A project made from an earlier template keeps its own SDK range, and moving it onto 0.26.0 is a minor step whose breaking changes the SDK's changelog lists.

### Fixed

- **A failed durable run says why**: the web app template's failure display now reads a failed run's stored error report and shows the runtime's reason with the failing pipe, its advice as the next step, whether running it again can help, and a line to quote to support with the run id, the error type and when the run ended, where it used to show only "Run finished with status FAILED; no result available". A model provider's raw error text is kept out of everything the person can read, and a run that ended with no stored report keeps the old sentence.
- **A refused run says what to do**: when the runner refuses to run a method, at the start of a durable run or on a blocking run, the web app template's failure display now shows the runtime's next step in place of a generic hint, says whether running it again can help when the runtime says so, and lists the method's validation items under the technical details, with an unknown model's reference and the model deck's suggestions. An answer that carries none of this keeps its old wording.

## [v0.5.5] - 2026-09-25

### Fixed

- **`make serve` where `ps` may not run**: in a sandbox that refuses `ps`, as Codex's `workspace-write` sandbox does on macOS, the web app template's `make serve` now refuses with `refused: no-ps` before starting anything, where it used to start the server, stop it again and report `failed: exited` as if it had exited at once.
- **`make stop` keeps the record of a server it cannot identify**: while the recorded server's first process runs where `ps` may not, or its group runs where `lsof` sees none of its processes, `make stop` now refuses and keeps `.serve/state.json`, where it used to take the server for another process or for one that had ended, drop its record and report `not-running` while it still listened. The record of a server that has ended is still cleared.
- **`failed: still-running`**: a server that `make serve` or `make stop` meant to stop and could not, because the system refused the signal or it outlived `SIGKILL`, is now reported as `failed: still-running` with its record kept, where it used to be reported as stopped and its record dropped.
- **`make all` where `ps` may not run**: a project's tests now skip the cases that start a server where `ps` may not run, so its `make all` passes in such a sandbox instead of failing.

## [v0.5.4] - 2026-09-25

### Changed

- **The web app template runs on `@pipelex/sdk` 0.25.1**: the SDK no longer offers the Pipelex Gateway key calls (`createGatewayApiKey`, `getGatewayApiKey`), which neither the template nor any action the scaffold writes ever made, so nothing changes for a project. The app keeps calling the hosted API with a Pipelex API key, which this release leaves untouched.

### Fixed

- **`create-method-app` at a path another repository ignores**: a destination inside another repository's work tree that the repository ignores, such as a `tmp/` its `.gitignore` lists or anywhere under a home directory kept as a repository that ignores `*`, now gets a repository of its own on `main` with the pristine commit, and the `git:` line names the repository that ignores it. The initializer used to report such a project as new files in the enclosing repository and make no repository, which left it under no version control at all; a project made that way earlier can be given one with `git init` and a first commit. A directory the repository does not ignore still gets no repository even when every file in it is ignored, as under `*` followed by `!*/`, and the `git:` line now says the project is under no version control instead of calling it new files of that repository. A destination that is a symlink is judged by the repository its target is in, not the one the link sits in.

## [v0.5.3] - 2026-09-24

### Changed

- **Scaffolded runs name their pipe by its qualified ref**: every action `make add-method` and `make create` write in the web app template sends `pipe_code` as `<domain>.<pipe_code>` (`text_stats.analyze_text`) instead of the bare code, and the test scaffolded beside it pins that ref. The runtime looks a qualified ref up exactly, where it searches every domain of the method for a bare code and refuses one that two domains declare, so a run keeps working after its method gains a second domain. An action scaffolded by an earlier template keeps sending the bare code, and setting its `pipe_code` to the qualified ref gives it the same guarantee.

## [v0.5.2] - 2026-09-24

### Changed

- **The web app template runs on `@pipelex/sdk` 0.24.0**: the SDK now ends a stalled upload by itself, after the limit the template used to set (a minute, plus a second per started 128 KiB of the file), so `useFileInputs` no longer passes a signal and `uploadTimeoutMs` is gone. A failed upload now names its cause from the SDK's code — too slow, storage out of reach, or storage failing — where every such failure used to read as storage being out of reach. A project made from an earlier template keeps working on its own timeout.
- **The keyed gestures run against the production API**: `make create`, `make add-method`, `npm run codegen` and `npm run codegen:verify` no longer need `PIPELEX_BASE_URL=https://api-dev.pipelex.com`, because `api.pipelex.com` now serves the form views codegen needs and resolves both catalog ids and package addresses. The quickstarts drop that export, so a new project's `.env.local` points at the default base URL; a project that set it can remove the line.

### Removed

- **The result view's own URL policy**: the web app template no longer runs a result through `scrubResultUrls` before the form kernel renders it, nor shows the note naming the file references that policy removed, because the kernel's own URL gate has refused what it was written to refuse since 0.9.0. A file URL the policy removed and the kernel accepts now reaches the page: a cleartext `http:` URL, at which a previewable document is framed as well as linked; a GIF or AVIF `data:` URL, painted and linked; a PDF `data:` URL, linked but never framed; a `blob:` URL, painted and linked but never framed; and a same-origin path named in the payload, painted and linked but never framed. A file the kernel refuses is named by the kernel's own file card, and `docs/result-view.md` now tells a view of the method's own to judge a URL with the kernel's `viewableUrl`. A project made from an earlier template can delete its `src/lib/resultUrls.ts` the same way only once it runs `@pipelex/mthds-form` 0.9.0 or later: the 0.8 kernel frames a payload's `data:text/html` document in an unsandboxed frame, where its script runs and draws its own interface inside the app's page, though from an opaque origin that cannot read the app's cookies or DOM.

## [v0.5.1] - 2026-09-24

### Changed

- **The web app template runs on `@pipelex/mthds-form` 0.10.0**: an enum value in a method's form and result reads as words rather than as its code, a table of records keeps five columns chosen by rank, the record's name first, and opens a row to the whole record, a long name wraps instead of widening the table, and a list of dates shows one date per line. An attached file's card no longer prints a stored file's `pipelex-storage://` address under its name, the "paste a URL instead" input's placeholder reads `https://…`, and the card of a file with no name reads "Attached file".
- **A created app no longer carries the template's chrome lineage**: the bootstrap that `make create` runs removes `docs/chrome-lineage.md`, which describes the web app template's relation to the gallery it was extracted from and would have sent a project's agent to file tasks against a repository the project has nothing to do with. It also drops `docs/input-form.md`'s paragraph about the template's own live tile spec, which a project does not have.

### Fixed

- **A file input offers only the media types its upload action grants**: a document input used to accept a PNG or a JPEG that the method's upload action then refused. The scaffolded form now narrows each file input to the method's `ALLOWED_MIMES` through the kernel's `narrowFileFormats`, so the input's hint, its file picker and its own check name the list the action checks, and `make add-method` writes that list to `src/types/<camel>Uploads.ts`, which the action and the form both import.
- **`make format-check` passes beside a gstack cache**: the web app template's `.prettierignore` lists `.gstack/`, which a global gitignore can hide from git but not from Prettier, so the tool's local cache no longer fails the check on an otherwise clean tree.

## [v0.5.0] - 2026-09-24

### Highlights

**The app is for the person running the method.** The web app template's page no longer offers a choice of execution mode, which is now the deployment's, and a finished run keeps its id under the result with its cost folded away. **A dropped file goes straight from the browser to Pipelex storage**, so a form takes as many files as its method does and a run carries only references. The template also moves to `@pipelex/sdk` 0.23.0.

### Added

- **A hydration signal for a script driving the app**: the web app template sets `html[data-hydrated]` once React has hydrated the page, and its `CLAUDE.md` tells a browser script to wait for it before its first screenshot, `fill` or `setInputFiles`. A Playwright screenshot taken earlier hides the caret by rewriting every input's inline style, which `next dev` then reports as a hydration mismatch with a "1 Issue" badge, and a file set earlier never reaches the handler that uploads it. The guidance says how to recognise that diff as the script's rather than the app's, and the offline e2e spec now waits for the signal and fails on any hydration error.
- **A guide to writing a result view of the method's own**: the web app template's `docs/result-view.md` says where a bespoke view goes, why it takes the typed output rather than the payload, how to label enum values, format numbers and render Markdown, and how files keep the app's URL policy. The form `make add-method` writes points at it.

### Changed

- **The execution mode is the deployment's, and the page no longer offers it (Breaking)**: the web app template's Blocking and Durable switch is gone from every method's form, and `ModeToggle` with it. A person using the app had no reason to know the difference, and one who picked Blocking saw any method running past the hosted gateway's ~30-second cap fail. The mode is `NEXT_PUBLIC_EXECUTION_MODE`, read as `EXECUTION_MODE` from `src/config.ts` (renamed from `DEFAULT_EXECUTION_MODE`), still Durable by default; set it to `blocking` for a deployment that does not serve the durable run lifecycle. A run that outlasts the blocking cap now tells whoever runs the app to set that variable, rather than telling the user to use a switch that is gone. A project made from an earlier template keeps its switch until it removes it.
- **A dropped file goes straight to storage, so a list of files no longer overflows the request (Breaking)**: the web app template used to encode every file of the form as base64 and send them all to the run's Server Action in one request, which a list of phone photos pushed past the 12 MB body limit, failing with an opaque "Could not reach the server". Now each file is stored the moment it is dropped: the page asks the method's new `request<Name>Upload` Server Action for an upload grant, sending the file's name, type and size, and sends the file itself from the browser to Pipelex storage with the SDK's `uploadWithGrant`. The form holds the `pipelex-storage://` reference, and a run carries references only, whatever the number of files. The limit on one file becomes the platform's, 50 MiB, and the Server Action body limit is back to Next's default of 1 MB, which now bounds only a run's text and other typed values: a set of inputs past it is refused before it is sent, with its size and the limit, instead of failing as an unreachable server. An empty or nameless file is refused as one that can't be uploaded rather than as a wrong type. The run action now refuses a file sent inline as a `data:` URL. `src/lib/fileEncoding.ts` becomes `src/lib/fileInputs.ts`, `src/lib/clientFile.ts` is gone, and `useFileInputs` takes the grant action and returns `uploadingIds`. **The grant route, `POST /v1/upload/grant`, is served by a deployment that has it**: against one that does not, a dropped file is refused with an error naming the route and `PIPELEX_BASE_URL`.
- **No development badge**: the web app template sets `devIndicators: false`, so `next dev` no longer draws its badge on the page a developer shows people. Compile and runtime errors still surface.
- **A finished run keeps its id**: once a run of the web app template has finished, its id stays under the result, selectable in a click and with a Copy button, in Durable mode and now in Blocking mode too, where no id was ever shown. The server logs a blocking run's id when it finishes, as it logs a durable run's when it starts, and a blocking run that finished but whose result could not be read now shows its id beside the error, as a durable one already did. The token-and-cost table moves under it, into a "Usage and cost" disclosure that starts closed, since it names models and pipes a person using the app has no use for. `useRun`'s `done` state carries the `runId`, and so does a blocking outcome.
- **The web app template runs on `@pipelex/sdk` 0.23.0**: a blocking run's response is lifted onto the run's results by the SDK's own `resultsFromExecute`, the mapping it applies to a durable run, so a blocking result now carries the run's working memory as a durable one does and a narrower reads an intermediate stuff the same way in both modes. The SDK's `artifactFilename` now names a file after the result field it fills, which the assets route cannot know, so the route names the file it serves with its own `assetFilename`, from the storage key as before: nothing changes on screen or in the name a browser offers. A project made from an earlier template that moves to 0.23.0 makes the same change in its `src/app/api/assets/[...path]/route.ts`, whose call to `artifactFilename` no longer compiles.

### Fixed

- **The release publishes with npm 11**: the release job installed the latest npm, whose 12.x changed the report `npm pack --json` prints and failed the initializer's package test before anything was published. It now installs npm 11, the npm the pull request checks also run, and the package test lists the packed tarball itself rather than reading npm's report.
- **The initializer's verdict is read from standard output**: under `npm create`, a run that exits 1 is followed by npm's own `npm error` lines on standard error, so the verdict is the last line of standard output rather than of everything printed. The initializer's README now says so, and names `npm create --loglevel=silent`, which removes npm's lines.

## [v0.4.0] - 2026-09-23

### Highlights

**A project starts with one command.** `npm create @pipelex/method-app` writes the web app template into a new directory and creates the app for the method it is given, and `make serve` then starts that app and proves that it answers. **This is the first release that publishes anything**: the initializer goes to npm, carrying the templates exactly as they stand at its version. The web app template also moves to `@pipelex/sdk` 0.19.0, and its `use-npm` targets are renamed `use-published`.

### Added

- **`npm create @pipelex/method-app`, the family's initializer**: `@pipelex/create-method-app` writes the web app template into a directory that is missing, empty or holds only `.git`, commits it as it came where nothing of the user's is at stake, and runs the copy's `make create` with the method and every other create value it was given, each option named after its make variable. It carries the template packed from the family's repository at the commit it was published from, so `@X.Y.Z` writes exactly the X.Y.Z template, with no dependency and nothing fetched from GitHub. Every file is created exclusively, and an interruption or a failure removes exactly what it created. It makes a repository only outside any work tree, adds the pristine commit to a repository only when it has no commit and nothing staged yet, refuses one with history, one with a staged file and a template's own checkout, and inside another repository's work tree makes no repository at all. It never prompts, and ends with one verdict line — `created`, `copied`, `refused:` or `failed:` — after the gesture's warnings and the git outcome; `--quiet` sends `make create`'s output to a log. It is the acquisition and create steps the scaffold skill carries as shell today, moved into the family, and the READMEs' copy-out recipe becomes `npm create @pipelex/method-app@latest my-app -- --method …` followed by `make -C my-app serve`.
- **The release publishes**: a push to `main` that moves the version publishes the initializer to npm through trusted publishing, with provenance, after asserting the changelog entry, packing the templates from a clean tree and running the family's tests, and tags the commit `vX.Y.Z`. The initializer's manifest carries the family's version, which `make check-versions` holds to `VERSION`. The first release is published by hand, because npm configures trusted publishing only on a package that already exists; the release skill carries the commands. The templates themselves stay private.
- **One initializer per template, and a shared table of cases**: a root test fails when a template of the family is served by no initializer or by more than one, or when an initializer's flags are not the `make create` contract's variables, now kept in `scripts/create-contract.mjs`. `initializers/cases.json` holds the destinations, git states and flags every initializer must answer with the same verdict, for the Python initializer to come.
- **`make serve` and `make stop` in the web app template**: `make serve` starts the dev server in the background, detached from the terminal and bound to loopback, waits for its port, checks that the listener is the server it started and that it listens on this machine alone, requests the page, and ends with one verdict line — `serving` with the URL and the page's title, `already-serving` when it runs already, or a `refused:` or `failed:` line naming the cause. It takes `APP_PORT` when the command line or the shell gives one, and otherwise the first port from 4300 to 4309 that no other directory holds; it never stops a server it did not start, and it stops everything it started that it could not prove. `make stop` stops that server, and only while it is provably the one `make serve` started, so a stale record whose process id was reused is never signalled. Two runs in one checkout take turns rather than racing. Projects keep both targets. They are the serve-and-prove step the scaffold skill carries as shell today, moved into the template it checks.
- **Workflow twins run setup-uv in the template**: the root's workflow renderer sets a setup-uv step's `working-directory` to the template, so the twin reads the template's uv version, Python and settings and caches against its files, as the template's own workflow does in a project; setup-uv defaults to the repository root, where it would read none of them and cache against every template's lock. A template that installs with uv can now join the family.
- **The `make create` contract is pinned**: a root test runs `make -n create` in every template and fails when one of them forwards a variable the scaffold skill passes differently from the others, alters its value, or forwards one left blank or only exported by the shell.

### Changed

- **`make use-published` and `make use-published-form` (Breaking)**: the web app template's `use-npm` and `use-npm-form` take the family's names, which every template answers whatever registry its packages come from, and `make un` now runs `use-published`. The same renames apply at the root, where the targets that switch the form kernel alone run only in the templates that depend on it.
- **The web app template runs on `@pipelex/sdk` 0.19.0**: `prepareInputs` now refuses when the API states that it determined no entry pipe, where it used to fall back to the closure's `main_pipe`. Nothing changes for a project made from the template, because every action `make add-method` writes already names the pipe it runs — the scaffold resolves that ref when it writes the action, so a method the API states no default for still runs.

### Fixed

- **The web app template's guide no longer calls an intermediate stuff unreachable**: it said `RunResults` surfaces only the main output and that reading a named stuff would need an addition to the SDK, which `@pipelex/sdk` 0.18.0 had already made untrue by carrying the run's `working_memory`. The guide now says where each run path has it, and which one line an app adds to read it on both.

## [v0.3.0] - 2026-09-20

### Highlights

**A run's files reach the browser through the app, not through the store.** The web app template mounts the form kernel's result environment and serves every `pipelex-storage://` reference from a route handler of its own, under header bounds it sets on each response, so the store's presigned link stays in the run's receipt and nothing paints from it. **The cost panel stops calling a partial sum a total**, naming a lower bound when priced and unrated calls are mixed. The template runs on form kernel 0.9.0, shows a durable run's id while it goes, and hardens `make add-method` against a concurrent run, a symlinked path and a platform-dependent bundle order.

### Added

- **A run's files display through the app's own origin**: the web app template mounts the form kernel's result environment in its root layout, so a `pipelex-storage://` reference a run returns is painted from `/api/assets/…`, a route handler that streams the object through the SDK's `fetchArtifact` on the server under bounds of its own — nosniffed, framed same-origin and no further on every response it sends, sandboxed when the type can act as a document, inline only for what the kernel previews, privately cached, and capped in bytes and in time for a browser rather than for a disk — so the store's signed link is never what the browser fetches — it stays in the run's JSON receipt for a reader who opens that view, and nothing paints from it. The result view's copy-URL control mints a fresh presigned link per click through a Server Action over the SDK's `resolveStorageUrl`, since a same-origin path is useless pasted elsewhere. The API key stays on the server.
- **A live tile e2e**: `e2e/resultTile.spec.ts` creates an app from the web app template for an image-producing method, runs it against the configured API, checks that the picture paints through the assets route with the route's header rules on the response and that the cost panel labels a partial cost as partial, and saves a screenshot of the tile and of the cost panel. It proves the template itself, so the bootstrap removes it with its fixture from every project created from one.
- **`make use-local-form`, `make use-npm-form` and `make local-status`**: the web app template switches the form kernel alone to the workspace's `mthds-form` checkout and back, and says package by package whether `node_modules` holds a local build or the published release, which the version cannot tell apart. A switch of the kernel alone refuses while the SDK is local, since its install would silently put the SDK back on npm; `make use-local` and `make use-npm` still switch both. The root runs each target in every template.
- **A durable run shows its id**: the web app template's status card prints the run id while a run is going and its error display prints it when one fails, each selectable in a click, and the server logs it once when the run starts, on every server and not only in development. A run started from a bundle in the project has no catalog id, so the id is the only way to look it up afterwards — in the back office, through the API, or in the workshop.

### Changed

- **The cost panel no longer labels a partial sum "Total" (Breaking)**: the web app template's usage report is a projection of the SDK's `summarizeUsage`. Its `state` takes the SDK's `no_inference` spelling, a run that did no inference costs `0` rather than `null`, and the report carries `costPartial`; `hasCost` is gone, since it only mirrored `totalCostUsd !== null`. When priced and unrated calls are mixed, the footer reads "Priced calls only" and a note says the sum is a lower bound.
- **`make use-npm` restores the versions the lockfile pins (Breaking)**: switching the web app template back from local packages installs the `@pipelex/sdk` and `@pipelex/mthds-form` versions `package-lock.json` pins, and no longer installs `@latest` and rewrites `package.json` and the lockfile. A release published while you worked locally arrives through the `bump-sdk` and `bump-mthds-form` skills, which read its changelog first.
- **The web app template runs on `@pipelex/mthds-form` 0.9.0**: a nested record in a result table is named by its first text field instead of printing its JSON, a value that wraps in a record's label-and-value rows aligns left while a one-line value still ends at the right edge, and a file a form holds as a `data:` URL shows its format and size rather than its base64. The kernel's `./generative` entry comes with it.
- **A derived title or label keeps an acronym's capitals**: `make create` and `make add-method` respell a word the method itself spells with an interior capital, so a `cv_screening` method gives "CV Screening" and a Run button reading "Run CV screening" where both said "Cv". A `--title` or a `--label` given on the command line, and a catalog name, are left exactly as written.
- **The web app template leads the run chrome**: `docs/chrome-lineage.md` says so, and says what a session changing a carried file owes the gallery it was extracted from. It described the opposite direction.

### Fixed

- **A created project's `bump-mthds-form` and `bump-sdk` skills recognise a breaking change**: both read the `(Breaking)` marker that the form kernel's and the SDK's changelogs put at the end of an entry's title, where they looked for a `Breaking —` prefix neither writes. `bump-mthds-form` also treats a renamed `InputForm`, `OutputForm` or `PipeIOContracts` as a change to the project's own `renderContracts`, which writes that import into every `contracts.ts`, instead of sending it to the engine.
- **A created project's `bump-mthds-form` and `bump-sdk` skills install the version whose changelog they read**: each installs the chosen release by name, so naming a version that a patch release has since followed locks and tests that version, where raising the range and running `npm install` locked the later patch. Each also stops at a downgrade, which none of their steps can undo, instead of asking to confirm it.
- **The dev server no longer prints uploaded files**: the web app template sets `logging.serverFunctions: false`, because `next dev` logs each Server Function call with its arguments and a file reaches its Server Action as a base64 `data:` URL — so every document dropped into a form was written to the log in full.
- **A created project's docs no longer illustrate themselves with a method it never had**: `CLAUDE.md` names the example it walks through as one, and `docs/codegen.md`'s tree sketch uses placeholders.
- **`loadMethodBundles` refuses a name that starts with a digit**: the web app template's bundle loader holds a method directory name to the rule `make add-method` derives one by, kebab-case with a letter first, so a name such as `3d-model`, which the scaffold refuses, is refused by the loader too.
- **`loadMethodBundles` reads a bundle in codegen's order on Windows**: the loader sorts on each file's path inside the method directory written with `/`, as `npm run codegen` does, so a run sends `mthds_contents` in the order the generated types were projected from on every platform, where it used to put `steps2.mthds` before `steps/score.mthds` on Windows.
- **`make add-method` runs one write at a time**: the write half holds a lock file, `.add-method.lock` at the app's root, and a second run that reaches it meanwhile is refused before writing anything, so a run that fails can no longer remove a generated tree another run has just written. A lock left by a run that was killed is named in the refusal, with whether its pid is still running, and is removed by hand.
- **`make add-method` refuses a symlinked bundle path, `methods/` or `src/generated/`**: a `.mthds` link is no longer read through to its target, as a link inside a bundle directory already was not, and the refusal for either no longer says the rule applies only under `methods/` and `src/generated/`. A symlinked `methods/` or `src/generated/` is refused before anything is fetched, as `npm run codegen` refuses it, instead of having the slice written through the link.

## [v0.2.0] - 2026-09-16

### Highlights

**The repository is now a family of templates.** Each template is a directory of its own, `webapp-js/` first, and a project starts as a copy of that directory. **The web app is safer by default**: it listens on loopback, so it no longer serves methods billed to the developer's API key to every network the machine is on, and it runs on a Next.js release clear of two critical remote-code-execution advisories.

### Changed

- **The repository is the `pipelex-method-apps` family of templates (Breaking)**: the GitHub repository is renamed from `pipelex-method-app`, whose URLs redirect, and is no longer marked as a template. The web app template moved into `webapp-js/`, and a project now starts as a copy of that directory rather than from GitHub's **Use this template** button — clone the repository shallowly, copy `webapp-js/` into a new directory, run `git init` there, then `make create`. The family carries one version, in the root `VERSION` file, and one changelog, this one, and the root `make all` runs every template's checks, tests and build.
- **The web app template's package is `pipelex-method-webapp-js` (Breaking)**: `make create` and the bootstrap run only while `package.json` carries that name, and a created project's first changelog entry links the template's directory.
- **`make use-local` takes `SIBLINGS_DIR`**: the sibling `pipelex-sdk-js` and `mthds-form` checkouts are built from the directory given, and from the parent directory when none is.

### Fixed

- **`make create` on a busy machine**: the web app template's tests that spawn `make`, or run the bootstrap script, allow a minute each instead of five seconds, so the gesture's closing `make all` no longer fails, and leaves the project half-finished, when the machine is loaded.

### Removed

- **The live `make create` workflow**: no workflow runs the gesture against the API, because none is given an API key. The template's `docs/ci.md` describes the local run that takes its place.

### Security

- **The web app's servers listen on loopback by default (Breaking)**: `make dev`, `make start`, `npm run dev` and `npm run start` bind `127.0.0.1` instead of every network interface, because anyone who could reach the server ran methods billed to the developer's `PIPELEX_API_KEY`. `APP_HOST`, beside `APP_PORT`, widens it — `make dev APP_HOST=0.0.0.0` for a container or another device — and the Makefile warns whenever a server starts beyond loopback.
- **Next.js 16.3.5**: the web app template requires `next` and `eslint-config-next` at `^16.3.5` and locks 16.3.5, past the two critical remote-code-execution advisories that affect every Next.js 16 release before 16.3.3 (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4). The lock also takes the patched `vitest`, `sharp`, `browserslist` and `js-yaml`, so `npm audit` reports nothing.

## [v0.1.0] - 2026-09-16

### Added

- **The template**: a Next.js 16 app that runs MTHDS methods through the Pipelex API and ships no method of its own. With no method it renders an empty state that names `make add-method`; with one it renders that method's form as the page; with several it renders them as tabs.
- **`src/methods.ts`, the method registry**: `METHODS` lists each method's id, label and form component, and carries the two `add-method:` anchors the scaffold inserts at.
- **`src/site.ts`, the app's identity**: the page heading, the browser title and the meta description all read `SITE.title` and `SITE.description`, so renaming the app edits one file.
- **`make create`**: turns a fresh copy of the template into the app for one method in one command (`make create METHOD=<method>`). It derives the project's name, title and description from the method, adds the method, runs the bootstrap, writes `.env.local` from the shell, re-syncs `package-lock.json` and runs `make all`; it asks nothing, refuses a value it cannot derive by naming the flag that supplies it, and is removed from the project once it has run.
- **`make add-method`**: scaffolds a method into the app from a local bundle (`METHOD=path/to/method.mthds` or a directory of them, copied into `methods/<name>/`), from the platform (`METHOD=mt_…`) or from a published package (`METHOD=github.com/owner/repo[/pkg][@tag]`), writing its generated tree, adapter, Server Action trio, action test, form and registry entry. It renders every file before writing any, refuses rather than overwrite a slice that already exists, and removes what it wrote if a write fails. A selector's action reads it from `methods/<name>/method.json`, so moving to another version of the method is editing that file and running `npm run codegen`.
- **Generated types and contracts**: `npm run codegen` projects each method under `methods/` into `src/generated/<name>/`, and `npm run codegen:check` proves the tree current offline, reporting an app with no method as current.
- **`loadMethodBundles(name)`**: reads every `.mthds` file under `methods/<name>/`, in path order, for a method authored in the app.
- **The run chrome**: blocking and durable execution behind one `useRun` hook, input forms and result views rendered by `@pipelex/mthds-form` from each method's contract, a server-side input gate, a file-input gate that checks scheme, type and size, a result URL policy, classified errors and a per-run cost report.
- **The `/bootstrap` skill**: turns a repository created from the template into a named project, rendering its own README, writing its title and description into `src/site.ts`, resetting its version and changelog, applying its license, removing what only the template needs, and formatting every file it writes.
