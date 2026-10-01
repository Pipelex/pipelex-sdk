# Chrome lineage: the template leads, and what it took from the gallery

This template was extracted from [`pipelex-starter-js`](https://github.com/Pipelex/pipelex-starter-js), the gallery app that presents several demo methods as tabs. The two share the code every method needs, which this document calls the chrome: the gallery keeps its demos around it, and this template keeps it with no method at all. This document gives the rule for changing the chrome, says what the chrome is, lists where this template's copy differs from the gallery's on purpose, and records the extraction. It concerns this repository's relation to the gallery, so a project created from the template does not carry it.

## The rule

Decided on 2026-09-17, after weighing a published package and a one-way sync gesture against the cost of a new release train: **the chrome stays copied by hand, and this template leads it.** Nothing keeps the two copies in sync by itself, and no tool is coming: the question reopens the day a third app needs the same chrome.

- **A change to the chrome owes the gallery a port**, unless it lies wholly inside one of the deliberate differences listed below. File the port as a ledger item against `pipelex-starter-js` before the change lands, naming the files and what changed, because whoever makes it there will not have this context.
- **A fix the gallery makes first comes back as an item against this repository**, so that the next app created from the template does not ship the defect.
- **Before filing either, compare the two copies and look for an open item.** The port may be owed already, or made already.

The gallery's own [`docs/chrome-lineage.md`](https://github.com/Pipelex/pipelex-starter-js/blob/main/docs/chrome-lineage.md) states the same rule from its side, with its own deliberate differences.

## What the chrome is

- **The run chrome**: everything under `src/hooks/` and `src/lib/`, the components under `src/components/` except `MethodPage` and the forms `make add-method` writes, `src/types/pipelineError.ts` and `src/config.ts`, the assets route under `src/app/api/` and the Server Actions that serve every method rather than one (`src/actions/shareUrl.ts`), what `src/app/layout.tsx` mounts, and `src/app/globals.css`, each with its tests.
- **The codegen kit**: everything under `scripts/`, the `make add-method` scaffold with its tests, fixtures and recordings included, except the gestures that create and serve an app (`create` and `serve`, with their modules in `scripts/lib/` and their tests).
- **The configuration**: the Makefile's gestures and argument handling except `create`, `serve` and `stop`, `next.config.js`, `tsconfig*.json`, `vitest.config.mts` and the Vitest setup files, the ESLint, Prettier, PostCSS and Playwright configurations with `.prettierignore`, the Husky hook, the CI workflows, and the live-API guard `e2e/liveApi.ts`.

Everything else is the template's own: the registry (`src/methods.ts` and `MethodPage`), the app's identity (`src/site.ts`, and the name, description and version in `package.json`) and its page, what `make add-method` writes for a method, the recorded contracts under `src/test/fixtures/contracts/`, the `create`, `serve` and `stop` gestures, the skills under `.claude/skills/`, the offline and tile e2e specs, the documentation and the changelog.

## Where the template differs on purpose

These differences follow from the template shipping no method and serving the people who use one method's app, and a port in either direction keeps them:

- **The registry.** The template registers methods in `src/methods.ts` and renders them with `MethodPage`: an empty state, one method as the whole page, or tabs over several. The gallery's tabs are the `TABS` array in its `ExampleTabs`. The scaffold writes the same entry into either file, importing the form as `@/components/<Name>Form` here and as `./<Name>Form` there, and its messages say "method" here where the gallery's say "tab".
- **The app's identity.** The title and description are string literals in `src/site.ts`, which the layout, the page and the offline spec read. The gallery writes its own into `src/app/page.tsx` and `src/app/layout.tsx`.
- **The execution mode is the deployment's.** The page offers no Blocking and Durable switch: `src/config.ts` exports `EXECUTION_MODE`, read from `NEXT_PUBLIC_EXECUTION_MODE` alone, the scaffolded form passes it to `useRun`, and a run that outlasts the blocking cap tells whoever runs the app to set that variable. The gallery teaches both modes, so it keeps `ModeToggle` in every form, `DEFAULT_EXECUTION_MODE`, the hints that say "Switch this example to Durable mode", and a scaffold that emits the switch.
- **No demo in the errors or the wording.** The template has no `bad_image_output` kind, no `BadImageOutputError` and no classifier for it, which served one of the gallery's demos. Its messages and comments say "this app" and "app-owned" where the gallery's say "the starter" and "starter-owned", and name no demo file or tab.
- **The shared tests run on recorded contracts.** A test that needs real codegen output imports a recorded copy from `src/test/fixtures/contracts/`, where the gallery's imports a demo's generated contract, and a test that names a pipe names a neutral one. The gallery's `loadBundle` test also loads every bundle it ships, which the template has none of.
- **The codegen gate passes with no method.** `discoverMethods` treats a missing `methods/` directory as no method, and `codegen:check` reports an app with no method and no generated tree as current, taking its directories as a parameter so that its test can point it at an empty app. A tree left behind after its method was removed still fails.

Any other difference between the two copies is a port that has not been made yet, in one direction or the other. Compare the two files to find it, look for its ledger item before filing one, and carry the change in the direction the rule gives.

## The history of the extraction

This part is frozen: it records the extraction as it stood on 2026-09-17, when the rule above was decided, and nothing is added to it afterwards. A later change to the chrome is described in the family's `CHANGELOG.md`, at the root of `pipelex-method-apps`, and in a ledger item when it owes the gallery a port. Several differences recorded here have since been carried to the gallery, so this part says nothing about what the gallery holds today; compare the two copies for that.

### The source

The extraction was taken from the gallery at commit `3bf44f0fbd3d967b8e50d171454da2278593ee95`. A file listed below as carried unchanged was byte-identical to the gallery's copy at that commit, and the contract fixtures under `src/test/fixtures/contracts/` were recorded from the gallery's generated `contracts.ts` files there.

### Carried unchanged

- **The run chrome**: `src/hooks/useRun.ts`, `src/hooks/useRunInputs.ts`, `src/lib/blockingRun.ts`, `src/lib/clientFile.ts`, `src/lib/resultField.ts`, `src/lib/runInputs.ts`, `src/lib/serverEnv.ts`, `src/lib/usageReport.ts`, and the components `CostReport`, `ErrorDisplay`, `RunResult` and `RunStatus`, with their tests where the gallery had them (`useRun`, `CostReport`, `ModeToggle`, `RunInputsForm`, `RunStatus`, `globals.css`).
- **The codegen kit**: the CLI entries `scripts/codegen.mts`, `scripts/codegen-check.mts`, `scripts/codegen-verify.mts` and `scripts/add-method.mts`, and `scripts/lib/api.mts` and `scripts/lib/verify.mts`, with the test of `api.mts` and the scaffold's test fixtures (`scripts/lib/fixtures/add-method-fixtures.mts`).
- **The configuration**: the ESLint, Prettier, PostCSS and Playwright configurations, `tsconfig.e2e.json` and `tsconfig.scripts.json`, the Vitest setup files, the Husky hook, the CI workflows, `.gitattributes`, `.worktreeinclude`, `.vscode/settings.json` and `LICENSE`.

### Adapted

- **The page and its registry.** The gallery's `ExampleTabs` hard-wired its demo forms and carried the `add-method:` anchors. The template replaced it with `src/methods.ts`, a registry that started empty and carried the same anchors, and `src/components/MethodPage.tsx`, which rendered an empty state, one method as the whole page, or tabs over several. The scaffold's `insertTab` became `registerMethod` and wrote to `src/methods.ts`.
- **The app's identity.** The title and description moved out of `src/app/page.tsx` and `src/app/layout.tsx` into `src/site.ts`, as string literals both files read.
- **The bundle loader.** The gallery had one loader function per demo. The template had one generic `loadMethodBundles(name)`, which read every `.mthds` file under `methods/<name>/`, in path order, and refused a name `add-method` would not derive: one that was not kebab-case or did not start with a letter.
- **Output reading.** `wireOutput` returned `main_stuff` unchanged and `wireListOutput` only unwrapped the `{ items }` envelope; neither took a schema any more. The gallery's `dropWireNulls` was not carried, because the ts-zod projection had begun to emit `.nullish()` and accepted the runtime's explicit `null`s as they arrived. The adapters `make add-method` writes were updated to match.
- **Errors.** The image-specific `bad_image_output` kind, `BadImageOutputError` and its classifier were removed, because they served one demo's output check. The error messages stopped naming demo files or tabs.
- **File inputs.** `MAX_PDF_BYTES` was renamed `MAX_FILE_BYTES`, since the cap applied to any file a method takes.
- **The codegen gate.** `discoverMethods` treated a missing `methods/` directory as no method, and `codegen:check` reported an app with no method and no generated tree as current, so `make all` passed on the template as shipped. A tree left behind after its method was removed still failed.
- **The shared tests.** Tests that imported a demo's generated contract imported a recorded copy from `src/test/fixtures/contracts/` instead, and tests that named a demo pipe used a neutral one.
- **The bootstrap skill.** The script rendered the project's README whole instead of renaming tokens inside the template's, wrote the title and description into `src/site.ts` through `JSON.stringify`, formatted every file it wrote through the repository's Prettier, and removed what only the template needed: its own `release` skill, the one-shot gesture listed under "New", and the passages of shared files that described that gesture, which sat between marker lines. Its test checked the real template files only while the package still carried the template's name.
- **The documentation.** `README.md`, `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/add-method.md`, `docs/codegen.md` and `docs/input-form.md` were rewritten or trimmed to describe an app with no demo. The comments in the other adapted files lost their references to demos.
- **The scaffold's names and selector.** A slug had to start with a letter, and a scaffolded action imported its selector from `methods/<name>/method.json` through a new `@methods/*` alias in `tsconfig.json` and `vitest.config.mts`. Both fixed defects listed at the end of this document. The scaffold's tests started from the registry emptied of registered methods, and `MethodPage`'s test mocked the registry, so neither depended on which methods a project had added.
- **The scaffold's bundle arm.** The gallery's `add-method` took only a catalog id or a published address. The template's also took a path to a `.mthds` file or to a directory of them, copied the bundle into `methods/<name>/` (or scaffolded a directory already there in place), and wrote an action that named its directory once and read the bundle through `loadMethodBundles`. `scripts/lib/add-method.mts` and its test differed from the gallery's throughout because of it.
- **The scaffold's write half.** The gallery's `runAddMethod` was split into `planAddMethod`, which fetched, derived, rendered and formatted every file without writing anything, and `writeAddMethod`, which wrote only files that did not exist yet and removed what it had created if a write failed. The scaffolded form of a method with a file input waited for every file to finish encoding before it ran, and the emitted action test imported only the actions it called. Each fixed a defect listed at the end of this document.
- **The generator.** `scripts/lib/generate.mts` and its test differed from the gallery's beyond comments: the guard that keeps the server from overwriting a file the generator owns normalized the artifact's path and covered `codegen.lock` and `sources.json` as well as `contracts.ts`, and the fetch also returned the domain's and the pipes' descriptions from the bundle blueprint, which the template read to describe a project.
- **The Makefile.** Besides its comments and help text, which said the keyed targets needed the api-dev base URL for the time being, the `add-method` target read only the non-blank variables given on the `make` command line and passed their values to the script exactly as typed, through the `shq`, `given`, `opt`, `flag` and `require` helpers, which `scripts/lib/makefile.test.mts` pinned. The gallery's target tested `METHOD` inside a shell string, where a value holding `$(…)` was executed. The local-package targets differed too: the template added a switch for the form kernel alone and a status target, packed into a temporary directory, refused a one-package switch while the SDK was local, and switched back to the versions the lockfile pinned, where the gallery re-pinned `@latest`.
- **Comment-only changes.** `.env.example`, `.gitignore`, `next.config.js`, `src/app/globals.css`, `src/components/ModeToggle.tsx`, `src/components/RunInputsForm.tsx`, `src/config.ts`, `src/lib/durableRun.ts`, `src/lib/pipelexClient.ts` and `src/lib/resultUrls.ts` differed from the gallery's in comments only, and `e2e/liveApi.ts` in comments and one skip message.
- **The version.** The template started its own history at `0.1.0`.

### New

- `src/site.ts`, `src/methods.ts`, `src/components/MethodPage.tsx` and its test.
- `src/test/fixtures/contracts/`, recorded from the gallery's generated `contracts.ts` files at the source commit, each under a banner that says so.
- `e2e/home.spec.ts`, an offline spec that checked the page rendered its title and either the empty state or a form.
- `methods/README.md`, `docs/ci.md` and this document.
- `scripts/lib/scaffold-tree.test.mts`, which copied the template to a temporary directory, scaffolded one method of each source kind into the copy from recorded API responses, and ran the type check, ESLint, the offline codegen check and the emitted action tests over it. The recordings were under `scripts/lib/fixtures/recorded/`, and the bundle it copied in was `scripts/lib/fixtures/bundles/receipt-review/`.
- The one-shot gesture that turns a copy of the template into a project, with its test, its document and its CI workflow. The bootstrap removed all of it, so a project created from the template did not carry it.

### Not carried

- **The demos**: everything under `methods/` and `src/generated/`, the demo Server Actions in `src/actions/`, the demo adapters in `src/types/`, the demo forms and `ExampleTabs`, `public/sample-invoice.pdf`, and the demo e2e specs.
- **`e2e/error-display.spec.ts`.** It checked the offline error display by driving a demo form, so it could not be separated from the demo; `home.spec.ts` took its place as the offline spec, and the error display was covered by its unit tests.
- **`docs/adopt-in-an-existing-project.md`**, which used the gallery as its worked example.
- **The gallery's `CHANGELOG.md`**, which chronicled the gallery.

### Defects the gallery shipped at the time

- **The bootstrap test failed in a bootstrapped project.** It read the real template files and expected the template's name, so it failed as soon as the project was renamed. The template's test skipped those checks once the package name had changed.
- **The bootstrap garbled the README and could write the title as markup.** It renamed tokens across a README that described the template, and wrote the title into JSX text. The template's bootstrap rendered a new README and wrote the title only into `src/site.ts`, as a string literal.
- **A schema-guided null strip ran on every output.** `dropWireNulls` had outlived the projection change that made it unnecessary. The template did not carry it.
- **An upgrade by manifest left the run on the old method.** The gallery's scaffold copied the selector into the action as a literal, so editing `method.json` and regenerating moved the contracts and the form to the new version while the run still named the old one, and `make check` stayed green. The template's action read the manifest.
- **A slug starting with a digit produced a slice that could not compile.** `3D model` became `3d-model` and then `3dModelForm`, and the failure came after the manifest and the generated tree were written, so a retry was refused. The template refused such a slug before it fetched the method's generated tree or wrote anything.
- **A failed scaffold left a partial slice that blocked a retry.** The gallery wrote the manifest and the generated tree before it formatted the app files, so a formatting failure left files behind that the next run refused as a collision. The template rendered and formatted every file before its first write, and removed what it had written when a write failed.
- **An optional file input could be submitted while it was still encoding.** The gallery's scaffolded form enabled its Run button as soon as the required inputs were filled, so a run started while an optional file was still being read went without it. The template's form waited until no file was encoding.
- **The emitted action test did not compile for a method that gated on nothing.** It imported the durable start action without calling it, which the type check refused. The template imported it only in the test that used it.
- **The server could overwrite a file the generator owns.** The gallery's guard compared the raw artifact path with `contracts.ts` alone, so an artifact named `nested/../contracts.ts`, `codegen.lock` or `sources.json` would have replaced the app's own file. The template normalized the path and checked all three.
- **The `add-method` target could execute its argument.** The gallery's Makefile tested `METHOD` inside a shell string and took `NAME` and `LABEL` from the environment too. The template's read only command-line variables and passed them literally.
