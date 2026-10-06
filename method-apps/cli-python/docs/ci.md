# Continuous integration

The workflows below run on every pull request, on the oldest and the newest Python the project supports, and none needs a key or a network beyond the package index. Each installs with `make install` under `UV_LOCKED=1`, so a `uv.lock` that `pyproject.toml` has moved away from fails the run rather than being rewritten: after changing the dependencies, run `make lock` and commit the lock with them.

| Workflow | Runs | What it proves |
| --- | --- | --- |
| `.github/workflows/lint-check.yml` | `make check` | ruff's lint and format check, pyright in strict mode, and the offline codegen check over the generated tree |
| `.github/workflows/tests-check.yml` | `make test`, `make build` | The tests, which replace the API client with a fake and need no key, and the wheel, which must carry the method and its contracts |

`make all` runs the same gates locally, and is what to run before pushing.

<!-- template-only:begin -->

## What the tests prove about `make create` (template only)

The template ships no method, and the gesture writes code and data into a package nobody reviews line by line, so what it writes is proven inside `make test`, in tests the bootstrap removes from a project with the gesture:

- **`tests/test_create_plan.py`** pins every decision the planning takes: the argument, the bundle it reads and the refusals, what of a methods repository it never enters, the labels it sends the bundle's files under, the names, the pipe, the output binding, a concept code two domains share among its refusals, `binding.py` as rendered, and the write half, which claims each part before writing into it and removes what it created, and nothing else, when a write fails.
- **`tests/test_create.py`** pins the gesture itself: the Makefile's forwarding with `make -n`, the argument parsing, the identity, every `.env` rule, the order of the two halves, a rehearsal that writes nothing and checks the `binding.py` it will write, a derived name the bootstrap's rules refuse, refused as derived, and the commands a failure or a Ctrl-C after the method is written names, `--force` included once the bootstrap has written `pyproject.toml`, a Ctrl-C sent as a real signal to `main` among them. Its `TestWithTheRealBootstrap` runs the real bootstrap over copies of the template, and runs the command a failure names to prove that it finishes the job.
- **`tests/test_bootstrap.py`** runs the bootstrap over a copy of the template and fails when any file a project keeps still names the template, the gesture or the wire-table recorder outside a removed passage, or still carries a marker. It also pins the rename, `.gitattributes` included, the manifest, the license choices, a confirmed re-run's `pyproject.toml`, the refusals, a name `uv.lock` pins and the import name of an installed distribution among them, `binding.py`'s `PIPE_REF` kept as the method names it, and a run that fails part-way, which truncates nothing and which the same command, run again, finishes.
- **`tests/test_create_tree.py`** copies the template to a temporary directory once per source kind, a bundle, a catalog id and a published address, and runs the real gesture there, the real bootstrap included, against complete API responses recorded under `tests/fixtures/recorded/`. Only `uv sync` and `make all` are skipped: each copy is linked to the template's environment, and the test runs ruff, pyright, the project's own tests, the offline codegen check and the created command's `--help` over each copy itself. A change to the template that breaks what the gesture writes or what the bootstrap leaves fails here rather than in the next person's project.

The recorded responses are real: they were returned by `api.pipelex.com` on 2026-10-06, for the bundle in `tests/fixtures/bundles/receipt-review/` and for `github.com/Pipelex/methods/text_stats@v0.1.1`, and are kept whole, stamps included. A catalog id is answered with the published method's responses and a catalog entry made up in `tests/support_create.py`, since a stored method belongs to one organization and this repository is public. Both methods avoid `native.Date`, whose generated models cannot be imported until the hosted engine ships the fix. Re-record them when a change to the API's responses matters to the gesture, with the requests `fetch_generated` sends:

- `codegen` with `kind: "types"` and `target: "python-pydantic"`, into `<name>.codegen.json`;
- `pipe_io` with `all_pipes: true`, and `include_files: true` for the address, into `<name>.pipe-io.json`;
- `version`, into `version.json`.

The bundle is sent with each file's `source` as `method/<file>`, the label the gesture's tree records and the one the gesture itself sends, as `make codegen` does for that tree; `tests/test_create_plan.py` pins it.

No workflow runs the gesture against the live API, because none is given an API key, so its live half is taken by hand before a release, as a check of the repository's rather than of this directory: the `pipelex-sdk` repository's root `docs/live-create-proofs.md` describes it.

## Where these workflows run (template only)

This template is developed as the `method-apps/cli-python/` directory of the `pipelex-sdk` mono-repo, and GitHub reads a repository's workflows only at its root, so the workflow files above never run from there. The repository's root carries twins of each, rendered from them by its `make workflows`. The standalone twin extracts this directory into a folder outside the checkout, gives it a repository of its own and runs the same jobs there, installed from PyPI with this directory's own `uv.lock`, exactly as a project made from it would be. The next-SDK twin runs them again with `pipelex-sdk` built from the same commit installed over the locked one, and is reported, not required. The root's `make check-workflows` fails when a twin no longer matches its source, so a change to a workflow here is carried to the root by re-rendering it in the same commit. A project copied out of the mono-repo runs these files as they are.

<!-- template-only:end -->
