# Pipelex Starter Project

## Commands

### Linting & Type Checking

After making code changes, always run:
```bash
make agent-check
```
This runs: fix-unused-imports, ruff format, ruff lint, plxt format/lint (`.mthds`/`.toml`), pyright, mypy.

Both type checkers cover `widget/`, `tests/` and `scripts/` — `[tool.pyright] include` and `[tool.mypy] packages` in `pyproject.toml` name all three. Keep `scripts/` in both: the codegen script imports the SDK surface the repo depends on, and leaving it out of scope is what once let `make agent-check` pass while it imported a module the lock did not have.

### Running Tests

```bash
make agent-test
```
Silent on success, full output on failure. Excludes inference/LLM markers by default.

Run specific tests (local only): `make tp TEST=test_function_name`

### Other Useful Targets

- `make install` - Create venv + install all deps (uses uv)
- `make li` - Lock + install
- `make cleanderived` - Remove caches/compiled files (useful when linters get confused)
- `make validate` / `make v` - Lint/validate the `.mthds` bundle with plxt (offline)
- `make codegen` - Regenerate the typed clients from the `.mthds` methods through the hosted API (needs `PIPELEX_API_KEY`, no `pipelex` install)
- `make codegen-check` - Verify generated clients are current (offline, pure hashing against each `codegen.lock`, through `pipelex-sdk`'s own check)
- `make add-method METHOD=<mt_… | github.com/owner/repo[/package][@tag]>` - Scaffold a method that lives elsewhere into the CLI (needs `PIPELEX_API_KEY`; see `docs/add-method.md`)
- `make tb` - Quick boot test (constructs the API client, no network)
- `make fui` - Fix unused imports only
- `make plxt-format` - Format `.mthds`/`.toml` files with plxt
- `make plxt-lint` - Lint `.mthds`/`.toml` files with plxt

## Architecture

This starter calls the **hosted Pipelex API** via the `pipelex-sdk` package (`PipelexAPIClient`) — it does **not** run Pipelex as a local library. The `.mthds` bundle is read from disk and sent to the API as content (`mthds_contents`); the API runs the method and returns the output.

- Credentials/endpoint come from `PIPELEX_BASE_URL` / `PIPELEX_API_KEY` (see `.env.example`). `python-dotenv` loads `.env` when running the CLI or tests.
- **The execution mode is the command group, not an option.** There are exactly three, each a self-contained Typer sub-package: `widget blocking …` (`client.execute` — one call, dies at the hosted ~30s cap), `widget attended …` (`client.start` + `client.wait_for_result` — durable, you wait), `widget detached …` (`client.start` only — durable, you collect it later with `widget detached status|result|wait <id>`). Attended and detached start the *same* durable run; the axis they name is who waits. There is no default mode and no `--mode` option: `widget/cli.py` is a thin assembler (`load_dotenv` callback + three `add_typer` calls in reading order) and nothing else.
- **Each mode file is a copy-paste unit; lifecycle code is never shared.** `widget/<mode>/cli.py` holds that mode's whole story: its `typer.Typer`, its consoles (results → stdout, progress → stderr), its one public lifecycle helper (`execute_pipe` / `start_and_wait` / `start_pipe`, plus `attend_run` + the fetchers in detached; every result-producing one returns the SDK's `RunResults`, blocking included, through `results_from_execute`), its demo commands, and a private `_run()` that wraps `asyncio.run` and catches SDK errors once. The **only** shared modules are those orthogonal to execution: `widget/inputs.py` (text-or-file input with a built-in **sample fallback** so every demo runs with zero arguments — `read_text_input` returns `TextInput(text, is_sample)` and the demo prints a stderr notice when the sample was used; plus file → `{"concept": "Document", "content": …}` envelope — `upload_document_input` uploads the file to hosted storage with `client.upload_file` and wraps the returned `pipelex-storage://` URI, `build_document_input(path, uri)` being the pure envelope builder — and the `SAMPLE_*` constants), `widget/errors.py` (SDK error → message + hint, hints naming the mode groups; every route of the SDK raises the typed `ApiResponseError` on a non-2xx answer, and `problem_lines` reads its **problem+json** document out — the reason, the pipe or concept each validation item names, the next step and the retry advice — while the hint branches on the structured `error_type`, e.g. `StartRequiresAsyncOrchestration` → "use `widget blocking`"; it also hints the file-upload error family and the artifact-download one, whose hints never say to rerun because the run was already paid for; a run that ended without a result is presented from its stored error report — `present_failed_run` and `report_lines` read out the reason, the next step and the retry advice, the same lines `widget detached status` and `result` print — and `print_error` escapes the server's text before Rich sees it), `widget/usage.py` (cost report: `print_cost_report` renders `pipelex_sdk.usage.summarize_usage(results)` to **stderr** — the SDK owns the folding rules and this module re-derives none of them), `widget/artifacts.py` (produced files: `collect_artifacts` answers offline whether the output references any, `download_artifacts` saves them under `DEFAULT_DOWNLOAD_DIR` with links minted fresh rather than the expiring `public_url`), and `widget/outputs.py` (`list_items`, the one place a **plural** output's two wire shapes — a bare array or an `items` envelope, which of them you get depends on the execution path rather than on the method — are read as one; the Python twin of `pipelex-starter-js`'s `wireListOutput`, and a workaround with an expiry). Do not introduce a shared runner — the dispatch indirection is exactly what this layout removed. See `docs/cli-architecture.md`.
- **Full demo matrix, guarded.** All three demos exist in all three modes: `extract-entities` (text in), `summarize-pdf` (a *file* in), `generate-image` (prompt in). `generate-image` is the deliberate slow case that overruns the ~30s blocking cap — `widget blocking generate-image` is *expected to fail*, and that is the teaching moment for the durable modes. The near-duplication across mode files is the pedagogy (diff two mode files and only the lifecycle helper differs); `tests/unit/test_mode_symmetry.py` keeps it from drifting. `samples/sample-invoice.pdf` is shipped for `summarize-pdf`.
- The SDK resolves the main output on every result-producing path (`client.execute` returns a `PipelexExecuteResult`, the durable path a `RunResults`, both exposing a resolved `.main_stuff`, typed `Any`; a completed run with no main stuff raises `MissingMainStuffError`). So the result-producing lifecycle helpers (`execute_pipe`, `start_and_wait`, detached's `attend_run`) all return the SDK's `RunResults` — one object carrying the resolved output, what the run consumed and the references to the files it produced. The blocking mode reaches it through `pipelex_sdk.execute_result.results_from_execute`, the SDK's public lift (0.10.2), so no mode reads the runner's raw `pipe_output`. The blocking/attended demo commands narrow `results.main_stuff` inline — e.g. `ExtractedEntities.model_validate(results.main_stuff)` — into the generated model, then hand `results` to the cost report and the download. Detached is the exception by design: `start_pipe` returns only the run id (the demos print it bare, no cost — the run isn't done), and the run-id commands (`wait`/`result`) print the output generically **and** its produced files and cost report — no model narrowing, since at collection time the command doesn't know which method the run executed. There is no per-example wrapper layer.
- The modes spell out lifecycles the SDK could hide: `client.start_and_wait()` is a self-healing one-liner that picks the path for you (the production shortcut). The starter writes them out because teaching the difference is the point.
- **The typed models are generated, never hand-written.** Codegen projects each bundle's concepts into `widget/generated/<method>/models.py` (stamped, locked by a sibling `codegen.lock`); the mode CLIs and the e2e tests import from there. Do NOT edit generated files — edit the bundle, then `make codegen` and `make codegen-check` (offline drift check). `make codegen` is `scripts/codegen.py`: it discovers the methods under `widget/methods/`, posts each to the hosted `POST /v1/codegen` with `pipelex-sdk`, and writes the response verbatim with the SDK's `write_codegen_tree` — so regenerating needs `PIPELEX_API_KEY` and no `pipelex` install, exactly as `pipelex-starter-js` does it. `make codegen-check` is `scripts/codegen_check.py`, which runs the SDK's own `pipelex_sdk.codegen_check.run_codegen_check` over each method's generated tree — so the offline gate needs no `pipelex` install either, and `tests/unit/test_generated_clients.py` runs the same check, so a tree that drifted from its lock — regenerated and only half committed, or hand-edited below its stamp — fails in CI too. Catching a bundle edited and never regenerated is `make codegen`'s job, not the check's. There is deliberately no committed `inputs.template.json`; `docs/codegen.md` says why and where a template comes from instead. `widget/generated` is excluded from ruff (reformatting would trip the drift check) but fully type-checked. See `docs/codegen.md`.
- **A method has two possible sources, and a directory holds one of them.** `widget/methods/<name>/` holds either `.mthds` files (the bundle, sent inline — what the three demos do) or a `method.json` naming exactly one of `method_id` / `method_ref` (a method that lives on the platform or in a published package). `scripts/codegen.py` discovers both and sends the right selector, so `make codegen` is the single regeneration path for both. A directory holding both kinds is refused.
- **`make add-method` writes the whole Python fan-out for a method that lives elsewhere**: the `method.json`, the generated tree, and **one** Typer command in the mode named by `MODE=` (default `attended`). The command reads its selector from that `method.json` every time it runs (`widget/manifest.py`), so the manifest is the one place a method's version lives. Its parameters are derived from the method's input-form descriptor and its narrowing from the output contract — nothing method-shaped is written by hand, and an input kind with no honest command-line spelling (`object`, `list`, `image`, `unknown`) is refused rather than guessed at. It inserts at the `# add-method:imports` and `# add-method:commands` anchors each mode file carries: **do not move or delete those tokens.** One-shot — it never overwrites, and `make codegen` is the refresh. See `docs/add-method.md`.

## Project Structure

- Package: `widget/` (Python 3.11+, target 3.11) — root `cli.py` + one sub-package per execution mode (`blocking/`, `attended/`, `detached/`) + the shared modules (`inputs.py`, `outputs.py`, `errors.py`, `usage.py`, `manifest.py`). Packages are discovered, not listed: `[tool.setuptools.packages.find]` takes everything under `widget/`, and each `codegen.lock` ships through a package-data glob — so a new mode sub-package or a scaffolded method needs no edit to `pyproject.toml`.
- Agent-facing files: `CLAUDE.md` (this file) and `AGENTS.md` (the damage-causing rules, for any agent), plus the template's own `bootstrap` skill under `.claude/skills/`, which deletes itself from a project made from the template once it has run. Every workflow under `.github/workflows/` is the project's own CI: Pipelex's maintenance of the template (its contributor agreement, branch-flow guard and release) lives at the root of the repository the template is developed in, so none of it reaches a project. `AGENTS.md` also carries this repo's decision **not** to ship an `adopt-in-an-existing-project.md`, and what to read instead.
- Tests: `tests/` (unit = offline per-mode CLI tests patching each mode's public lifecycle helper, plus mode-symmetry / error-mapping / generated-client tests; integration = offline boot/bundle checks + API `validate`; e2e = full run via the API, one execution mode per demo so all three get end-to-end coverage)
- Dependency manager: uv (>=0.7.2)
- Pipelex dependency: `pipelex-sdk` package from PyPI (the API client — see pyproject.toml). The `pipelex` runtime is **not** a dependency.
- `.mthds` files: Pipelex method definition files in `widget/methods/<name>/main.mthds` (or a `method.json` naming a method that lives elsewhere)
- Scripts: `scripts/codegen.py` (the generator) and `scripts/add_method.py` (the scaffolder, which imports the first as `scripts.codegen` — `scripts/__init__.py` makes the directory a package, and `make add-method` runs the scaffolder as `python -m scripts.add_method` from the repository root)

## Test markers

- `pipelex_api` — reaches the hosted API (needs a key); excluded from `make agent-test` / `make gha-tests`.
- `inference` — runs real LLM inference via the API; also excluded by default.
- Offline tests (no marker) run everywhere, including CI.
