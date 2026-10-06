# Lineage: what this template took from the Python starter

This template was extracted from the Python starter, `starter-python/` in the `Pipelex/pipelex-sdk` repository (published as the template repository `Pipelex/pipelex-starter-python`), at commit `a9d3648110a5f797d91af515576b78da7e6513bd` of `pipelex-sdk`, where the starter's directory is the tree `b02b6a4c53d05f9b8bd089b69dc536431f8a3321` and carries version 0.29.1. The starter is a gallery: one `widget` command with three demo methods, each repeated in three command groups, one per execution mode. This template is the opposite shape, one method and one command whose flags choose the mode, so it took the starter's SDK plumbing and wrote the command around it.

## The rule that came out of it

**This template leads the code it shares with the starter.** A fix to a module listed under "Carried" below lands here first, and is filed in the workspace ledger as a twin task against `starter-python`, since nothing ports it for you. The reverse holds too: a fix found in the starter is checked against the module here before it is called done.

## Carried

Each of these came across with its behaviour and its tests, moved under `src/pipelex_method_cli_python/lib/`, and adapted where the one-command shape or the `src/` layout needed it.

- **`widget/errors.py` became `lib/errors.py`.** The reading of the SDK's errors is the starter's: the problem document's reason, the validation items that say more than it, the next step and the retry advice; a failed run's stored report; the hints for a missing key, an unreachable API and the upload and artifact errors. Adapted: every hint now names this command's flags rather than the starter's command groups (`--blocking` for a server with no run store or a synchronous-only orchestration, dropping `--blocking` for the gateway's cut-off, `--resume <run-id>` for a run still going); `present_error` takes the run's mode, so a gateway status is only read as the blocking cut-off on the blocking path, and a server with no run store tells a `--resume` that there is nothing to resume; and it also presents the CLI's own `AppError`.
- **`widget/usage.py` became `lib/usage.py`**, the cost report rendered from the SDK's `summarize_usage`. Adapted: results whose body did not carry `tokens_usages` print a one-line note instead of raising `FieldNotIncludedError` after the result was already printed, since the report must never fail a run that succeeded.
- **`widget/artifacts.py` became `lib/artifacts.py`.** Adapted: it takes the client the run already opened instead of building its own, and a run's files go to `outputs/<run-id>/` by default, refusing a run id that is not one path segment, with `--out` and `--no-download` choosing otherwise.
- **`widget/manifest.py` became `lib/manifest.py`**, the one reader of `method.json`. Adapted: it reads the manifest's text rather than a path, because the run reads it through `importlib.resources`, and its error is an `AppError`.
- **`widget/outputs.py`'s `list_items` became part of `lib/output.py`**, unchanged: the workaround for the two wire shapes of a plural output. Around it, whether the output is plural is now the binding's to declare (`OUTPUT_IS_LIST`) rather than each demo command's.
- **The tool configuration**: the starter's pyright strict rule set, unchanged; ruff, adapted to the `src/` layout and to exclude the generated tree; pytest with pytest-asyncio.
- **`.env` loading**, adapted: the starter's `load_dotenv()` searches upward from the module's own file, which for an installed command is the environment's `site-packages`, so the command now searches from the directory it runs in (`find_dotenv(usecwd=True)`), still without overriding the shell.

## Added

- **`cli.py`**, one Typer command with no subcommands, whose options are assembled from a list of `inspect.Parameter`s so that a later version adds one option per declared input without rewriting the command; the empty state, which says to run `make create`; the one `asyncio.run` and the one error boundary.
- **`lib/run.py`**, the lifecycle as one module: attended by default, `--blocking`, `--detach` and `--resume`, with Ctrl-C leaving a run going and printing its `--resume` command. The starter's three mode groups each spelled the lifecycle out per demo command, on purpose, to teach the difference; here the person chooses the mode with a flag, so the three became one plan run over one client.
- **`lib/binding.py`, `lib/method_source.py`, `lib/inputs.py`, `lib/client.py` and `lib/app.py`**: the seam to the one method, the method read as package data, `--inputs FILE`, the one place a client is built (which is what the tests replace), and what every module shares.
- **The Makefile**, rewritten on the method-app family's shape: the `given`, `opt`, `flag`, `require` and `shq` helpers of the web app template, every tool run from `.venv/bin/`, `use-local` and `use-published` over editable installs, and the `create` target forwarding the family's contract.
- **`scripts/create.py`**, the family's argument contract with the gesture still to write, and **`scripts/local_status.py`**.
- **The workflows**, one lint job and one test job over the oldest and newest Python the project supports, installing with `uv sync` under `UV_LOCKED=1`.

## Left behind

- **The demos**: the three demo methods under `widget/methods/`, their generated models under `widget/generated/`, `samples/`, and the tests that exercise them, the live `pipelex_api` and `inference` tests included.
- **The mode groups**, `widget/blocking/`, `widget/attended/` and `widget/detached/`, and `test_mode_symmetry.py`, which held the three to one shape.
- **`widget/inputs.py`**: its text, file and sample inputs were the demos', and its upload of a local file as a `Document` input returns when the command derives an option per declared input from the method's input form. The upload errors' presentation stays in `lib/errors.py` for that day.
- **`make add-method`** and `scripts/add_method.py`, since a CLI holds one method for good, and the starter's `scripts/codegen.py` and `scripts/codegen_check.py`, which the codegen kit ported from the web app template replaces.
- **The bootstrap skill**, which a later version of this template rewrites for its own rename.
- **mypy, `plxt` and the `.vscode/` settings**: pyright strict is the one type checker, and the template carries no `.mthds` file to format.
