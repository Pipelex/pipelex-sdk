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

The recorded responses are real: they were returned for `github.com/Pipelex/methods/text_stats@v0.1.1` and for the bundle in `scripts/lib/fixtures/bundles/receipt-review/`, the codegen responses by `api-dev.pipelex.com` and the pipe-io responses by `api.pipelex.com`, and kept verbatim for the fields the scripts read, stamps included. Re-record them when a change to the API's responses matters to the scaffold, with the two requests `fetchGenerated` sends:

- `pipeIo` with the request `pipeIoRequest` builds (`all_pipes: true`, and `include_files: true` for the address), keeping the whole answer, into `<name>.pipe-io.json`;
- `codegen` with `kind: "types"` and `target: "ts-zod"`, keeping `is_valid`, `kind`, `target`, `crate_fingerprint`, `engine_version`, `artifacts`, `lock` and `lock_filename`, into `<name>.codegen.json`.

<!-- template-only:begin -->

## Where these workflows run (template only)

This template is developed as the `method-apps/webapp-js/` directory of the `pipelex-sdk` mono-repo, and GitHub reads a repository's workflows only at its root, so the workflow files above never run from there. The repository's root carries twins of each, rendered from them by its `make workflows`. The standalone twin, which the root CI calls, extracts this directory with `git archive` into a folder outside the checkout, gives it a repository of its own and runs the same jobs and steps there, installed from the registry with this directory's own lockfile, exactly as a project made from it would be. The next-SDK twin runs them again with `@pipelex/sdk` built from the same commit installed after `npm ci`, and is reported, not required. The root's `make check-workflows` fails when a twin no longer matches its source, so a change to a workflow here is carried to the root by re-rendering it in the same commit. A project copied out of the mono-repo runs these files as they are.

## The live proof of `make create` (template only)

No workflow runs `make create` against the live API, because none is given an API key, so it is proven by hand before a release, as a check of the repository's rather than of this directory: the `pipelex-sdk` repository's root `docs/live-create-proofs.md` describes it.

<!-- template-only:end -->
