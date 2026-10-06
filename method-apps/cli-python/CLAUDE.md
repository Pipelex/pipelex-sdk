# pipelex-method-cli-python

A command-line tool that runs one MTHDS method through the [Pipelex](https://pipelex.com) API with [`pipelex-sdk`](https://pypi.org/project/pipelex-sdk/), printing the method's result as JSON on stdout.

<!-- template-only:begin -->

This directory is a **template**. It is the `cli-python/` member of the method-app family, `method-apps/` in the `pipelex-sdk` repository, and it ships the run lifecycle, the error presentation and the result output, and no method at all: `make create` will turn a copy of it into the command for one method, and until that gesture is written it parses the family's arguments and refuses. Keep the template small, generic and high-quality, and when adding anything ask whether every project created from it should inherit it. A worked demonstration of a method belongs in the gallery this template was extracted from, `starter-python/` in the same repository, never here. [`docs/lineage.md`](docs/lineage.md) records that extraction and the rule that came out of it: **this template leads the code it shares with the starter**, so a fix to a module it carries lands here first and is filed in the workspace ledger as a twin task against `starter-python`, which nothing ports for you.

<!-- template-only:end -->

## Tech Stack

- **Python** 3.11 to 3.14, managed by [uv](https://docs.astral.sh/uv/); `.python-version` names the one a fresh `make install` uses
- **CLI**: [Typer](https://typer.tiangolo.com/), one command and no subcommands; [Rich](https://rich.readthedocs.io/) for everything on stderr
- **SDK**: [`pipelex-sdk`](https://pypi.org/project/pipelex-sdk/) (`PipelexAPIClient`, async only), and [`mthds`](https://pypi.org/project/mthds/) for the protocol's error types
- **Environment**: `python-dotenv`, which loads `.env` without overriding the shell
- **Packaging**: hatchling, with the source under `src/`
- **Checks**: ruff (lint and format) and pyright in strict mode, over `src/`, `tests/` and `scripts/`
- **Tests**: pytest with pytest-asyncio, offline: no key and no network

## Project Structure

```
src/pipelex_method_cli_python/
  cli.py              # the command: its options, .env, the one asyncio.run, the one error boundary, main()
  lib/
    app.py            # COMMAND_NAME, RunMode, AppError: what every module shares
    client.py         # make_client(): the one place a PipelexAPIClient is built, and what tests replace
    run.py            # the lifecycle: attended, --blocking, --detach, --resume, and what a finished run prints
    output.py         # the result as JSON on stdout; list_items for the two wire shapes of a plural output
    errors.py         # every SDK error and AppError turned into a message, the details and a hint, on stderr
    usage.py          # the cost report on stderr, rendered from the SDK's usage summary
    artifacts.py      # produced files downloaded under outputs/<run-id>/ or --out
    inputs.py         # --inputs FILE, or - for stdin
    binding.py        # the seam to the one method: binding.py and generated/, found without importing
    method_source.py  # the method's source, read from the package's method/ through importlib.resources
    manifest.py       # method.json, which names a method by catalog id or published address
scripts/
  create.py           # make create: parses the family's contract, then refuses (not written yet)
  local_status.py     # make local-status: a local checkout or PyPI, read from direct_url.json
tests/
  support.py          # the FakeClient, results built the way the SDK builds them, invoke()
  conftest.py         # the fake_client fixture, and no ambient key in any test
  test_*.py           # one file per module, test_cli.py driving the command through Typer's CliRunner
```

The template as shipped holds no method. `make create` will write these inside the package: `method/` (the method's `.mthds` files, or a `method.json`), `generated/` (the method's typed models from the codegen), and `binding.py`, which declares `PIPE_REF`, `OUTPUT_MODEL` and `OUTPUT_IS_LIST`. [`lib/binding.py`](src/pipelex_method_cli_python/lib/binding.py) documents the seam; the CLI finds those files with `importlib.util.find_spec` and imports `binding.py` dynamically, so the template as shipped type-checks with neither.

## Commands

```bash
make install          # uv sync: the project and its development tools into .venv, as uv.lock pins them
make all              # check + test + build: run after any change
make check            # ruff check, ruff format --check, pyright
make test             # pytest, offline
make agent-check      # check, silent on success
make agent-test       # the tests, silent on success
make format           # sort imports and format with ruff
make build            # uv build: wheel and sdist into dist/
make lock             # uv lock, after editing the dependencies
make use-local        # pipelex-sdk and mthds from local checkouts, as editable packages
make use-published    # back to what uv.lock pins
make local-status     # which of the two is installed
```

## The command's contract

- **stdout carries the result and nothing else, always as JSON**: the run's `main_stuff` as the method produced it, never a re-serialization of a model, and a plural output (`OUTPUT_IS_LIST`) as the bare list of its elements whichever wire shape arrived. `--detach` prints the run id alone instead. Progress, the run id of an attended run, files, the cost report, errors and hints go to stderr, through the Rich console the command builds on stderr.
- **The mode is a flag**, never a subcommand: attended by default, `--blocking`, `--detach`, `--resume RUN_ID`. Incompatible flags are refused with exit code 2 before anything is sent. [`docs/run-lifecycle.md`](docs/run-lifecycle.md) describes each mode, Ctrl-C and the exit codes.
- **No silent downgrade.** A durable start against a server that serves only blocking runs is an error naming `--blocking`. Never call the SDK's `start_and_wait`, which picks the mode by itself.
- **One `asyncio.run`**, in `cli.py`. Everything under `lib/run.py` is a coroutine taking the client `execute_plan` opened.
- **One error boundary**, in `cli.py`: every `PipelineRequestError` and `AppError` is presented by `lib/errors.py`. A failure the CLI detects itself is an `AppError` subclass with a message and a hint, never a bare exception and never a `print`.

## Where the SDK reaches

These are the files a release of `pipelex-sdk` or `mthds` can reach, which the repository's `/bump-sdk` reads: `lib/client.py` constructs the client and reads `AppInfo`; `lib/run.py` calls `start`, `execute`, `wait_for_result` and `results_from_execute`; `lib/artifacts.py` calls `collect_artifacts` and `download_artifacts`; `lib/usage.py` reads `summarize_usage` and `FieldNotIncludedError`; `lib/errors.py` matches the SDK's error classes and reads `RunErrorReport` and the problem document's fields; `lib/output.py` reads `RunResults`; and `cli.py` catches `mthds.protocol.exceptions.PipelineRequestError`. In the tests, `tests/support.py` and `tests/conftest.py` build the SDK's own result and error types the way the SDK builds them.

## Rules

- **After any change, run `make all`**, or `make agent-check agent-test` for a quiet run. Do not declare a task done until it passes. If formatting fails, run `make format`.
- **Run every tool from `.venv/bin/`, through the Makefile, never with `uv run`**: `uv run` re-syncs the environment against `uv.lock` first, which silently undoes `make use-local`.
- **Tests replace `lib/client.py`'s `make_client`, never the `pipelex_sdk` package.** The `fake_client` fixture hands back a `FakeClient` whose answers are the SDK's own types, so every code path runs as it does for real down to the client's methods. Keep stdout and stderr apart in every assertion: `invoke()` returns them separately.
- **Every module that talks to the API calls `api.make_client()` through the module** (`from pipelex_method_cli_python.lib import client as api`), never by importing the function, or the fixture cannot replace it.
- **Print server text with `rich.markup.escape`** wherever it reaches the Rich console: a bracketed span in a run's error would otherwise be read as markup.
- **Never edit anything under `src/pipelex_method_cli_python/generated/`** once a project has one: the codegen writes it verbatim and stamps it. Ruff excludes it on purpose.
- **The dependencies a module imports are declared in `pyproject.toml`**, even those that arrive transitively, and `uv.lock` moves with them (`make lock`). Moving the `pipelex-sdk` floor is a reviewed change with the SDK's changelog read, never a side effect of local mode.

<!-- template-only:begin -->

## In the pipelex-sdk repository

This passage describes the repository the template lives in, and leaves with the gesture when the template becomes a project.

- **The template works on its own.** Nothing in this directory may reach above it: no import, script, configuration file or symlink. It installs `pipelex-sdk` from PyPI with its own `uv.lock`, never from the repository's `python/`.
- **This tree's SDK is installed with the repository root's `make use-local`**, which runs this template's `use-local` with `SDK_DIR` naming the tree's `python/` and `MTHDS_DIR` the workspace's `mthds-python` checkout; the root's `make use-published` switches back. This template's own `use-local`, run here, looks for `../pipelex-sdk/python`, which names nothing.
- **A workflow is edited in `.github/workflows/` here, then re-rendered** with `make workflows` at the repository's root, which writes its standalone and next-SDK twins into the root `.github/workflows/`; commit them together. The workflows install with `make install` under `UV_LOCKED=1`, so a `uv.lock` that `pyproject.toml` has moved away from fails CI rather than being rewritten, and the next-SDK twin installs the SDK built from the same commit over the locked one right after that step.
- **The version is the family's.** `pyproject.toml`'s `[project] version` carries the version the family last shipped as, at or below the root `VERSION`, and only a release moves it, with `uv.lock`. Changelog entries go in the family's `method-apps/CHANGELOG.md`; this directory's `CHANGELOG.md` only points there.
- **There is no git hook.** The repository's pre-commit hook runs a template's `.husky/pre-commit`, and this template has none: `make check` and CI hold it to ruff and pyright.
- **Pull requests target `dev`.** `make all` here, and `make check-workflows check-versions` at the repository's root after changing a workflow or a version.

<!-- template-only:end -->
