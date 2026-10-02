# Changelog

## [v0.29.0] - 2026-10-02

### Changed

- **Version 0.29.0, shared with the SDKs**: the template is now developed in the `starter-python/` directory of `Pipelex/pipelex-sdk` and exported to `Pipelex/pipelex-starter-python` at each release that ships it, under the one version number it shares with `pipelex-sdk`, `@pipelex/sdk`, the JavaScript starter and `@pipelex/create-method-app`, so its number jumped from 0.2.1 to 0.29.0 for that reason alone, and its later versions may skip numbers.
- **The tests workflow no longer grants an OIDC token**: `.github/workflows/tests-check.yml` asks for `contents: read` alone, since the tests never use OIDC and run the pull request's own code.
- **The workflows run on Node 24 actions**: `.github/workflows/lint-check.yml`, `tests-check.yml` and `package-check.yml` use `actions/checkout@v5`, `actions/setup-python@v6` and `astral-sh/setup-uv@v7` instead of `actions/checkout@v4`, `actions/setup-python@v4` and `astral-sh/setup-uv@v3`, whose Node runtimes GitHub Actions has retired, so a project made from the template no longer starts with a deprecation warning on every job; a project made earlier makes the same changes in those three files.

## [v0.2.1] - 2026-10-01

### Fixed

- **A project made from the template no longer runs Pipelex's own workflows**: the CLA assistant, the branch-flow guard, the release version and changelog checks and the GitHub Release job run only in `Pipelex/pipelex-starter-python`, so a repository created with "Use this template" no longer fails every pull request for want of the CLA app's secrets or asks its contributors to sign Pipelex's CLA. `/bootstrap` now deletes those workflows and the template's `release` skill, and keeps `lint-check.yml`, `tests-check.yml` and `package-check.yml` as the project's CI; a project made earlier deletes the same files by hand.

## [v0.2.0] - 2026-09-27

### Changed

- **`pipelex-sdk` 0.14.0 and `mthds` 0.17.0 are the floors, and `httpx` is no longer a dependency (Breaking)**: from `pipelex-sdk` 0.14.0 every route, `execute` and `start` among them, raises the typed `ApiResponseError` on a non-2xx answer, so each mode's `_run()` catches `PipelineRequestError` with no second arm for a raw `httpx.HTTPStatusError`, and nothing in the project parses one any more. Code copied from the starter that caught `httpx.HTTPStatusError` catches `ApiResponseError` and reads `exc.status` where it read `exc.response.status_code`.

### Fixed

- **A refused run says why, where and what to do**: a method the API refuses to run, met by `widget blocking …`, `widget attended …` or `widget detached …`, now prints the refusal's reason, the pipe or concept each of its validation errors names, the next step the server advises and whether running it again can succeed, the same lines a failed run prints, instead of the reason alone; a reason that spans lines hangs under its label. Any other refused request reads out its reason the same way, an authentication failure included, beside the API-key hint.
- **`make codegen` and `make add-method` tell a missing route from a 404 the route answered**: a 404 carrying the runner's error class, such as a `method_ref` whose package does not exist, is reported with the server's reason instead of sending you to check `PIPELEX_BASE_URL`, and any other refused request prints the server's next step under its reason.

## [v0.1.1] - 2026-09-27

### Changed

- **The demos name their pipe by its qualified reference**: every demo command, in every mode, sends `pipe_code` as `domain.pipe_code` (`extract_entities.extract_entities`) rather than the bare code, the exact key the runtime resolves. A bare code is searched for across every domain of the bundle and fails as ambiguous once two domains declare it, so code copied from a demo keeps working as its bundle grows; rename a bundle's `domain` and its call sites together.
- **`pipelex-sdk` 0.13.0 and `mthds` 0.16.0 are the floors**: the failed-run presentation reads the SDK's typed error report, which first shipped in `pipelex-sdk` 0.13.0, and `mthds` follows the version that release pins exactly.

### Fixed

- **A failed run says why**: a durable run that ended without a result, whether met by `widget attended …`, `widget detached wait` or `widget detached result`, now prints the reason the runner stored for it (its title and message), the next step it advises and whether running it again can succeed, instead of repeating its status; `widget detached status` prints the same lines under the status. A run that ended with no stored report, such as a cancelled one, says that no reason was recorded, keeps the platform's own sentence and says what is left to do.
- **An error that stops a command prints the server's text as it came**: a bracketed span in the message, its explanation or its hint, and in a failed run's stored report read out by `widget detached status`, such as a provider's `[/x]`, is no longer read as Rich markup, so it neither disappears nor crashes the print.

## [v0.1.0] - 2026-09-22

### Highlights

**A Python starter for the hosted Pipelex API.** The starter runs MTHDS methods with `pipelex-sdk` and never installs the `pipelex` runtime: the `.mthds` bundle is read from disk and sent to the API, which runs the method and returns the output. Copy it with "Use this template", then run `/bootstrap` to make it yours.

### Added

- **Execution modes as command groups**: `widget blocking …` runs a method in one call and dies at the hosted cap, `widget attended …` starts a durable run and waits for it, and `widget detached …` starts one and collects it later with `status`, `result` or `wait`. Each mode is a self-contained file meant to be diffed against the others, and nothing about the run lifecycle is shared.
- **The demos, in every mode**: `extract-entities` takes text, `summarize-pdf` uploads a file to hosted storage and sends its URI, and `generate-image` is the slow case that overruns the blocking cap on purpose. Every demo runs with zero arguments by falling back to a built-in sample.
- **Generated typed clients**: `make codegen` projects each bundle's concepts into `widget/generated/<method>/models.py` through the hosted codegen route, and `make codegen-check` verifies the committed trees against their locks offline. The same check runs in the test suite, so a tree that drifted from its lock fails in CI.
- **`make add-method`, for a method that lives elsewhere**: a catalog id or a published address becomes a `method.json` manifest, a generated tree and one Typer command in the mode you name, with parameters derived from the method's own input form and nothing method-shaped written by hand.
- **Cost reports and produced files**: every result-producing command prints a per-call cost report to stderr and brings the files a run produced down to `downloads/`, with links minted fresh rather than read from the expiring result.
- **Structured errors with hints**: an SDK or HTTP failure is mapped to a message and a hint naming the mode group to use, read from the API's RFC 7807 problem body rather than from a stringified exception.
- **`/bootstrap`**: the Claude Code skill that turns a fresh copy of this template into a named project, renaming the `widget` placeholder everywhere it appears and refusing to hand back a half-renamed tree.
- **`AGENTS.md`**: the damage-causing rules for any coding agent, beside `CLAUDE.md`.
