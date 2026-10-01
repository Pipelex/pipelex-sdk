# Continuous integration

Two workflows run on every pull request, and neither needs a key or a network beyond the package registry.

| Workflow                            | Runs                            | What it proves                                                                                                               |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/lint-check.yml`  | `make check`                    | ESLint, Prettier, `tsc` over the app, the e2e specs and the scripts, and the offline codegen check over every generated tree |
| `.github/workflows/tests-check.yml` | `make agent-test`, `make build` | The unit tests, and a production build                                                                                       |

## What the unit tests prove about `make add-method`

The scaffold writes code into files nobody reviews line by line, so what it writes is proven twice inside `make test`:

- **`scripts/lib/add-method.test.mts`** pins every decision the scaffold takes — the argument, the bundle it reads, the names, the pipe, the output binding, the files it renders — and the order of its two halves: every refusal before the first write, and a failed write that removes what it wrote.
- **`scripts/lib/scaffold-tree.test.mts`** copies the whole tree to a temporary directory, runs the real `add-method` there once for each source kind — a published address, a catalog id, and a bundle copied in — against complete API responses recorded under `scripts/lib/fixtures/recorded/`, then runs `tsc` over the copy, ESLint over the emitted files, the offline codegen check over each new generated tree, and vitest over each emitted action test. A change to the shared code that breaks what the scaffold emits fails here rather than in the next project. The slices it writes are named `fixture-…`, so the test runs unchanged in a project that has methods of its own.

The recorded responses are real: they were returned by `api-dev.pipelex.com` for `github.com/Pipelex/methods/text_stats@v0.1.1` and for the bundle in `scripts/lib/fixtures/bundles/receipt-review/`, and kept verbatim for the fields the scripts read, stamps included. Re-record them when a change to the API's responses matters to the scaffold, with the two requests `fetchGenerated` sends:

- `validate` (or `validateFiles` for the bundle) with `views: ["input_form", "output_form"]`, keeping `is_valid`, `pipe_io_contracts`, `input_form`, `output_form`, `default_pipe_ref`, and from `bundle_blueprint` its `domain`, `description`, `main_pipe` and each pipe's `description`, into `<name>.validate.json`;
- `codegen` with `kind: "types"` and `target: "ts-zod"`, keeping `is_valid`, `kind`, `target`, `crate_fingerprint`, `engine_version`, `artifacts`, `lock` and `lock_filename`, into `<name>.codegen.json`.

<!-- template-only:begin -->

## Where these workflows run (template only)

This template is developed as the `webapp-js/` directory of the `pipelex-method-apps` mono-repo, and GitHub reads a repository's workflows only at its root, so the workflow files above never run from there. The root carries a twin of each, rendered from them by the root's `make workflows`: the same jobs and steps, run with `working-directory: webapp-js`, with the npm cache keyed on this directory's lock file and the directory's name added to the workflow and job names. The root's `make check` fails when a twin no longer matches its source, so a change to a workflow here is carried to the root by re-rendering it in the same commit. A project copied out of the mono-repo runs these files as they are.

## The live half of the proof for `make create` (template only)

No workflow runs `make create` against the live API, because no workflow is given a Pipelex API key. The fixture test above proves what the gesture writes; that it still works against the API is proven by hand, with a local run, before a release that touches the gesture, the scaffold or the shared code an emitted file imports.

Run it twice against the default base URL, `https://api.pipelex.com`, each time in a fresh copy of this directory with its own `git init`, with a key in the shell:

- once with the bundle fixture, `make create METHOD=scripts/lib/fixtures/bundles/receipt-review`;
- once with a published address, `make create METHOD=github.com/Pipelex/methods/text_stats@v0.1.1`.

The gesture runs `make all` itself, so a red check fails the run. Then check that each copy is what the gesture promised:

- `package.json` no longer carries the template's name;
- the bootstrap skill, `scripts/create.mts` and `docs/create.md` are gone;
- `.env.local` holds exactly one `PIPELEX_BASE_URL` line, the one the run used;
- `make dev` serves a page titled after the method, showing its form, which `npx playwright test e2e/home.spec.ts` also checks.

The run executes no method, so it spends no model call. The copies are discarded afterwards.

<!-- template-only:end -->
