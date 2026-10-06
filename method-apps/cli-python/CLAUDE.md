# pipelex-method-cli-python

A command-line tool that runs one MTHDS method through the [Pipelex](https://pipelex.com) API with [`pipelex-sdk`](https://pypi.org/project/pipelex-sdk/), printing the method's result as JSON on stdout.

This directory is a **template**. It ships the run lifecycle, the error presentation, the result output, the options derived from a method's input form and the codegen kit, and no method at all, and every project created from it inherits what it carries. Keep it small, generic and high-quality, and when adding anything ask whether every project created from it should inherit it.

<!-- template-only:begin -->

It is the `cli-python/` member of the method-app family, `method-apps/` in the `pipelex-sdk` repository. `make create` turns a copy of it into the command for one method: it writes the method into the package, names the project after it with the bootstrap, and leaves `make all` green ([`docs/create.md`](docs/create.md)). A worked demonstration of a method belongs in the gallery this template was extracted from, `starter-python/` in the same repository, never here. The family's `docs/cli-python-lineage.md`, beside this directory, records that extraction and the rule that came out of it: **this template leads the code it shares with the starter**, so a fix to a module it carries lands here first and owes the starter a port, which nothing makes for you. The bootstrap rewrites this file by exact match, so these stay as they are: the description line under the H1 is byte-identical to `CLAUDE_DESCRIPTION` in `.claude/skills/bootstrap/scripts/bootstrap.py`, the paragraph above opens with the sentence the script looks for and ends at the first blank line, and the template's name appears only in the H1 and in paths; `tests/test_bootstrap.py` checks them.

<!-- template-only:end -->

## Tech Stack

- **Python** 3.11 to 3.14, managed by [uv](https://docs.astral.sh/uv/); `.python-version` names the one a fresh `make install` uses
- **CLI**: [Typer](https://typer.tiangolo.com/), one command and no subcommands; [Rich](https://rich.readthedocs.io/) for everything on stderr
- **SDK**: [`pipelex-sdk`](https://pypi.org/project/pipelex-sdk/) (`PipelexAPIClient`, async only, and the codegen writer and check), and [`mthds`](https://pypi.org/project/mthds/) for the protocol's error types, input-form descriptors and IO contracts
- **Environment**: `python-dotenv`, which loads `.env` without overriding the shell
- **Packaging**: hatchling, with the source under `src/`
- **Checks**: ruff (lint and format) and pyright in strict mode, over `src/`, `tests/` and `scripts/`
- **Tests**: pytest with pytest-asyncio, offline: no key and no network

## Project Structure

```
src/pipelex_method_cli_python/
  cli.py              # the command: its own options (LifecycleFlags), the derived ones, .env, the one asyncio.run, the error boundary
  lib/
    app.py            # COMMAND_NAME, command_name(), RunMode, AppError: what every module shares
    client.py         # make_client(): the one place a PipelexAPIClient is built, and what tests replace
    run.py            # the lifecycle: uploads, attended, --blocking, --detach, --resume, and what a finished run prints
    output.py         # the result as JSON on stdout; list_items for the two wire shapes of a plural output
    narrow.py         # the result checked against OUTPUT_MODEL before it is printed
    errors.py         # every SDK error and AppError turned into a message, the details and a hint, on stderr
    usage.py          # the cost report on stderr, rendered from the SDK's usage summary
    artifacts.py      # produced files downloaded under outputs/<run-id>/ or --out, with a manifest of a finished download
    inputs.py         # one option per declared input, derived from the input form; --inputs FILE; --inputs-template
    wire.py           # the form kernel's payload rules, ported: what each option's value puts on the wire
    contracts.py      # generated/contracts.json read and checked, and what the generated tree must hold
    binding.py        # the seam to the one method: binding.py and generated/, found without importing
    method_source.py  # the method's source, read from the package's method/ through importlib.resources
    manifest.py       # method.json, which names a method by catalog id or published address
scripts/
  codegen.py          # make codegen: the typed models and contracts.json, from POST /v1/codegen and /v1/pipe-io
  codegen_check.py    # make codegen-check: offline, whether generated/ is current with method/
  codegen_verify.py   # make codegen-verify: keyed, whether the committed tree is what the method resolves to
  codegen_shared.py   # what the codegen gestures share: the layout, the bundle reader, the sidecar and the policies
  codegen_api.py      # the selector handshake and the failures in words
  local_status.py     # make local-status: a local checkout or PyPI, read from direct_url.json
  # template-only:begin
  create.py           # make create: the gesture's two halves, the env file and the steps after the bootstrap
  create_plan.py      # what make create decides about the method before writing: the argument, the bundle, the pipe, binding.py
  # template-only:end
tests/
  support.py          # the FakeClient, results built the way the SDK builds them, contracts and bindings, invoke()
  conftest.py         # the fake_client fixture, and no ambient key in any test
  fixtures/           # the wire-format table and its contracts, and the recorded codegen of a method
  test_*.py           # one file per module; test_cli.py drives the command through Typer's CliRunner,
                      # test_wire_table.py replays the table, test_codegen.py runs the codegen gestures
  # template-only:begin
  test_create*.py     # the gesture: its arguments and halves, its planning, and test_create_tree.py's created copies
  test_bootstrap.py   # the bootstrap, and that nothing a project keeps names the template or the gesture
  support_create.py   # the client that answers from fixtures/recorded/, the API's answers for fixtures/bundles/
.claude/skills/bootstrap/  # the bootstrap, which names the project; make create runs it, then removes it
  # template-only:end
```

The method lives inside the package: `method/` (the method's `.mthds` files, or a `method.json`), `generated/` (what `make codegen` writes: the method's typed models, `codegen.lock`, `contracts.json`, `__init__.py` and `sources.json`), and `binding.py`, which declares `PIPE_REF`, `OUTPUT_MODEL` and `OUTPUT_IS_LIST`. [`lib/binding.py`](src/pipelex_method_cli_python/lib/binding.py) documents the seam; the CLI finds those files through `importlib.resources` and imports `binding.py` dynamically, so the package type-checks without them. [`docs/codegen.md`](docs/codegen.md) describes the generated tree and its checks, and [`docs/cli-kernel.md`](docs/cli-kernel.md) the options derived from it.

<!-- template-only:begin -->

The template as shipped holds none of them: `make create` writes them, then the bootstrap renames the package after the method. The CLI then says it holds no method, and `make check` is green on the template as on a project.

<!-- template-only:end -->

## Commands

```bash
make install          # uv sync: the project and its development tools into .venv, as uv.lock pins them
make all              # check + test + build: run after any change
make check            # ruff check, ruff format --check, pyright, codegen-check
make codegen          # regenerate generated/ from method/ (needs PIPELEX_API_KEY)
make codegen-check    # offline: is generated/ current with method/? 0 current, 1 drift, 2 no verdict
make codegen-verify   # keyed: is the committed tree what the method resolves to today? writes nothing
make test             # pytest, offline
make agent-check      # check, silent on success
make agent-test       # the tests, silent on success
make format           # sort imports and format with ruff
make build            # uv build: wheel and sdist into dist/
make lock             # uv lock, after editing the dependencies
make use-local        # pipelex-sdk and mthds from local checkouts, as editable packages
make use-published    # back to what uv.lock pins
make local-status     # which of the two is installed
# template-only:begin
make create METHOD=…  # one-shot: turn this template into the command for one method (docs/create.md)
# template-only:end
```

## The command's contract

- **stdout carries the result and nothing else, always as JSON**: the run's `main_stuff` as the method produced it, never a re-serialization of a model, a plural output (`OUTPUT_IS_LIST`) as the bare list of its elements whichever wire shape arrived, and `null` for an output the contract declares optional that a successful run left absent. `--detach` prints the run id alone instead. Progress, the run id of an attended run, files, the cost report, errors and hints go to stderr, through the Rich console the command builds on stderr.
- **The method's inputs are options derived at run time** from the committed input form, one per declared input, in authored order, with nothing written per method: `lib/inputs.py` builds them and `lib/wire.py` builds what each value puts on the wire, which is what the web app template's form kernel sends for the same value. A required input given neither by its option nor by `--inputs FILE` is refused with exit code 2 before anything is sent. [`docs/cli-kernel.md`](docs/cli-kernel.md) has the mapping and the deliberate disagreements with the kernel.
- **The result is checked, never filtered**: `lib/narrow.py` validates it against `OUTPUT_MODEL` before it is printed, strictly and as the JSON it arrived as, so no value is coerced into a field's type, and prints the payload as the method produced it. A result the model refuses is not printed, and the hint says to run `make codegen`.
- **The mode is a flag**, never a subcommand: attended by default, `--blocking`, `--detach`, `--resume RUN_ID`. Incompatible flags are refused with exit code 2 before anything is sent. [`docs/run-lifecycle.md`](docs/run-lifecycle.md) describes each mode, Ctrl-C and the exit codes.
- **No silent downgrade.** A durable start against a server that serves only blocking runs is an error naming `--blocking`. Never call the SDK's `start_and_wait`, which picks the mode by itself.
- **One `asyncio.run`**, in `cli.py`. Everything under `lib/run.py` is a coroutine taking the client `execute_plan` opened.
- **One error boundary**, in `cli.py`: every `PipelineRequestError` and `AppError` is presented by `lib/errors.py`. A failure the CLI detects itself is an `AppError` subclass with a message and a hint, never a bare exception and never a `print`.

## Where the SDK reaches

These are the files a release of `pipelex-sdk` or `mthds` can reach, which the repository's `/bump-sdk` reads: `lib/client.py` constructs the client and reads `AppInfo`; `lib/run.py` calls `prepare_inputs`, `start`, `execute`, `wait_for_result` and `results_from_execute`; `lib/contracts.py` reads `mthds.protocol`'s `PipeIOContracts`, `InputForm` and `OutputForm`; `lib/inputs.py` reads the `mthds.protocol.input_form` models and `render_inputs_template`; `lib/wire.py` reads `PipeInputContract`; `scripts/codegen.py`, `scripts/codegen_check.py` and `scripts/codegen_verify.py` call the client's `codegen`, `pipe_io` and `version`, the SDK's `write_codegen_tree` and `run_codegen_check`, and read its `CodegenRequest`, `PipeIORequest` and their reports; `lib/artifacts.py` calls `collect_artifacts` and `download_artifacts`; `lib/usage.py` reads `summarize_usage` and `FieldNotIncludedError`; `lib/errors.py` matches the SDK's error classes and reads `RunErrorReport` and the problem document's fields; `lib/output.py` reads `RunResults`; and `cli.py` catches `mthds.protocol.exceptions.PipelineRequestError`. In the tests, `tests/support.py`, `tests/conftest.py` and `tests/test_codegen.py` build the SDK's own result, report and error types the way the SDK builds them, and the fake client's `prepare_inputs` runs the SDK's own.

<!-- template-only:begin -->

In the template, `scripts/create_plan.py` also calls the client's `get_method` and reads its `MethodData`, and asks `pipe_io` for a named method's files (`include_files`), whose prose names the project; `tests/support_create.py` answers those calls from the recorded fixtures.

<!-- template-only:end -->

## Rules

- **After any change, run `make all`**, or `make agent-check agent-test` for a quiet run. Do not declare a task done until it passes. If formatting fails, run `make format`. CI runs the same gates on the oldest and the newest supported Python, with a locked install ([`docs/ci.md`](docs/ci.md)).
- **Run every tool from `.venv/bin/`, through the Makefile, never with `uv run`**: `uv run` re-syncs the environment against `uv.lock` first, which silently undoes `make use-local`.
- **Tests replace `lib/client.py`'s `make_client`, never the `pipelex_sdk` package.** The `fake_client` fixture hands back a `FakeClient` whose answers are the SDK's own types, so every code path runs as it does for real down to the client's methods. Keep stdout and stderr apart in every assertion: `invoke()` returns them separately.
- **Every module that talks to the API calls `api.make_client()` through the module** (`from pipelex_method_cli_python.lib import client as api`), never by importing the function, or the fixture cannot replace it.
- **Print server text with `rich.markup.escape`** wherever it reaches the Rich console: a bracketed span in a run's error would otherwise be read as markup.
- **Never edit anything under `src/pipelex_method_cli_python/generated/`** once a project has one: the codegen writes it verbatim and stamps it, and `make codegen-check` reports a hand edit to `contracts.json` as drift. Ruff excludes the directory on purpose. After changing the method, run `make codegen` and commit the tree with it.
- **No input is named in the CLI's code.** A change to how an input is taken belongs in `lib/inputs.py` and `lib/wire.py` for every method at once, and a change to what goes on the wire must keep `tests/test_wire_table.py` green, never by editing `tests/fixtures/wire/`, which records what the form kernel sends.
- **Tests that need a method build it from fixtures**, a contracts document and a binding from `tests/support.py`, or a package of their own under `tmp_path` for the codegen gestures, never by writing into the package's own `src/` tree.
- **The dependencies a module imports are declared in `pyproject.toml`**, even those that arrive transitively, and `uv.lock` moves with them (`make lock`). Moving the `pipelex-sdk` floor is a reviewed change with the SDK's changelog read, never a side effect of local mode.

<!-- template-only:begin -->

## In the pipelex-sdk repository

This passage describes the repository the template lives in, and leaves with the gesture when the template becomes a project.

- **The template works on its own.** Nothing in this directory may reach above it: no import, script, configuration file or symlink. It installs `pipelex-sdk` from PyPI with its own `uv.lock`, never from the repository's `python/`.
- **This tree's SDK is installed with the repository root's `make use-local`**, which runs this template's `use-local` with `SDK_DIR` naming the tree's `python/` and `MTHDS_DIR` the workspace's `mthds-python` checkout; the root's `make use-published` switches back. This template's own `use-local`, run here, looks for `../pipelex-sdk/python`, which names nothing.
- **A workflow is edited in `.github/workflows/` here, then re-rendered** with `make workflows` at the repository's root, which writes its standalone and next-SDK twins into the root `.github/workflows/`; commit them together. The workflows install with `make install` under `UV_LOCKED=1`, so a `uv.lock` that `pyproject.toml` has moved away from fails CI rather than being rewritten, and the next-SDK twin installs the SDK built from the same commit over the locked one right after that step.
- **The version is the family's.** `pyproject.toml`'s `[project] version` carries the version the family last shipped as, at or below the root `VERSION`, and only a release moves it, with `uv.lock`. Changelog entries go in the family's `method-apps/CHANGELOG.md`; this directory's `CHANGELOG.md` only points there.
- **The wire-format table is the family's.** `tests/fixtures/wire/` is recorded by `method-apps/scripts/record-wire-table.mjs` from the form kernel `webapp-js` installs; never edit it by hand. After a kernel upgrade, rerun the recorder in `method-apps/`, commit the table, and make `lib/wire.py` agree with it.
- **What a project inherits is decided here.** `make create` ends in the bootstrap, `.claude/skills/bootstrap/scripts/bootstrap.py`, which renames the project and removes what only the template needs: whole files, listed in its `REMOVALS` (the gesture, its planning code, its tests and their fixtures, and `docs/create.md`), and passages of the files a project keeps, each between two marker lines, the words `template-only` followed by `:begin`, then by `:end`, in whatever comment the file uses, Python and the Makefile included. Keep each marker on a line of its own, and never spell one out anywhere else. `tests/test_bootstrap.py` fails when a file a project keeps still names the template, the gesture or the wire-table recorder outside such a passage, and `tests/test_create_tree.py` creates a project from recorded answers once per kind of method and runs ruff, pyright, the tests, the offline codegen check and its `--help` over it.
- **The live proof of `make create` is taken by hand**, against the hosted API, before a release that touches the gesture, the bootstrap or the code a created project runs: [`docs/ci.md`](docs/ci.md) has the procedure.
- **There is no git hook.** The repository's pre-commit hook runs a template's `.husky/pre-commit`, and this template has none: `make check` and CI hold it to ruff, pyright and the offline codegen check.
- **Pull requests target `dev`.** `make all` here, and `make check-workflows check-versions` at the repository's root after changing a workflow or a version.

<!-- template-only:end -->
