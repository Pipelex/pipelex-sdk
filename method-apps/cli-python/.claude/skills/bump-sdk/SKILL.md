---
name: bump-sdk
description: Bump the pipelex-sdk dependency of this command-line tool to a newer published version, together with the mthds version that release pins exactly. Reads the CHANGELOG.md of pipelex-sdk and of mthds for the versions in between, weighs each entry against the files the SDK reaches here, applies mechanical renames, raises both floors in pyproject.toml and re-locks uv.lock, runs make all, and prepares a commit. Use when the user says "bump the sdk", "bump pipelex-sdk", "update pipelex sdk", "upgrade the pipelex sdk", "is there a new sdk version", or asks to pull in a newer pipelex-sdk or mthds release.
---

# Bump pipelex-sdk

`pipelex-sdk` sits in `pyproject.toml` as a floor, which `uv.lock` resolves to one version, so a newer release arrives only when somebody moves the lock, and before 1.0 a minor release can change what this tool calls. `pipelex-sdk` pins `mthds` exactly, and this tool also imports `mthds.protocol` itself, so the two move together: one lock change, two changelogs to read. This skill does that deliberately: read what changed, apply what can be applied mechanically, verify, then hand the user a reviewable commit.

The checkouts this workspace may have beside the project, `../pipelex-sdk` (whose `python/` directory is the SDK) and `../mthds-python`, are optional: every step has a fallback that needs only PyPI and the public GitHub repositories.

Every step that changes a file or the environment should be visible to the user before moving on, and nothing is committed or pushed without their explicit approval. The judgment is in reading the changelogs against the files below and deciding what is safe to change mechanically, so explain rather than just execute.

<!-- template-only:begin -->

In a copy of the template that has not been through `make create`, the passages about the gesture below apply too; the bootstrap removes them with it. In the `pipelex-sdk` repository this skill is never run: the repository root's `/bump-sdk` moves this template with the others in one change, and reads this skill for the files the SDK reaches here.

<!-- template-only:end -->

## Where the SDK reaches

These are the files to check after a bump, and the tests that catch a change under each. `<package>` is the import package under `src/`, and the section "Where the SDK reaches" of `CLAUDE.md` says which of the SDK's functions and types each file uses.

| Files | What a release can change under them | What catches it |
| --- | --- | --- |
| `src/<package>/lib/client.py` | The client's constructor and `AppInfo` | `tests/test_client.py`, pyright |
| `src/<package>/lib/run.py` | `prepare_inputs`, `start`, `execute`, `results_from_execute`, and `wait_for_result` with its options, its poll information and the `RunTimeoutError` the command waits through | `tests/test_cli.py`, which drives every mode over a fake client answering with the SDK's own types |
| `src/<package>/lib/inputs.py`, `lib/wire.py`, `lib/contracts.py` | `mthds.protocol`'s input-form and output-form models, the IO contracts and `render_inputs_template` | `tests/test_inputs.py`, `tests/test_wire.py`, `tests/test_wire_table.py` and `tests/test_contracts.py`, and the command itself, which parses the committed `contracts.json` into those models when it loads |
| `src/<package>/lib/artifacts.py` | `collect_artifacts`, `download_artifacts` and the result they return | `tests/test_artifacts.py` |
| `src/<package>/lib/narrow.py`, `lib/output.py` | `RunResults` and the shapes its `main_stuff` arrives in | `tests/test_narrow.py`, `tests/test_output.py` |
| `src/<package>/lib/errors.py`, `lib/usage.py`, `cli.py` | The error classes and what each carries, the run's stored error report, the problem document, and `summarize_usage` | `tests/test_errors.py`, `tests/test_usage.py` |
| `scripts/`, `src/<package>/lib/method_source.py` | `codegen`, `pipe_io`, `version`, `write_codegen_tree`, `run_codegen_check`, and the request, report and file models they take and return | `tests/test_codegen.py`, `tests/test_method_source.py`, and `make codegen-check` over the committed tree |

Two more seams are not code:

- **The generated tree.** `make codegen` writes `src/<package>/generated/` through the SDK, and stamps it with the engine's crate fingerprint, so an entry about codegen, locks, crates or the form and contract models can leave the committed tree stale while every offline check stays green. Step 6 asks the API.
- **What the docs say.** A non-breaking addition can make a sentence false without failing anything: grep `README.md`, `CLAUDE.md` and `docs/` for `Limitation`, `would need`, `not yet` and `upstream`, and hold each claim against the surface the bump installs.

<!-- template-only:begin -->

**Before `make create`, the template carries one more seam**, its create gesture's planning, which the bootstrap removes with the gesture. `scripts/create_plan.py` calls the client's `get_method` and reads its `MethodData`, asks `pipe_io` and `codegen` for the method the gesture writes, and reads their reports; `scripts/create.py` catches `CodegenError`. Their tests answer those calls from API responses recorded under `tests/fixtures/recorded/` and parsed into the SDK's report models by `tests/support_create.py`, and `tests/test_create_tree.py` creates a project from them once per kind of method and type-checks it. A release that reshapes those models fails there, and `docs/ci.md` says how to record the responses again when a change to the API's answers matters to the gesture.

<!-- template-only:end -->

## Step 1 — Gather state

Run `make install` first when `.venv` is missing: the steps below read with its Python. Then show the user:

1. **The floors and the locked versions**, read with `tomllib` rather than by eye:

   ```bash
   .venv/bin/python - <<'EOF'
   import re, tomllib
   from pathlib import Path

   names = ("pipelex-sdk", "mthds")
   for requirement in tomllib.loads(Path("pyproject.toml").read_text())["project"]["dependencies"]:
       if re.split(r"[\s\[<>=!~;@]", requirement, maxsplit=1)[0] in names:
           print("floor ", requirement)
   for package in tomllib.loads(Path("uv.lock").read_text())["package"]:
       if package["name"] in names:
           print("locked", package["name"], package["version"])
   EOF
   ```

2. **Where the installed packages come from**: `make local-status`. `local` means `make use-local` installed a checkout over the locked version, and a bump must not be measured against it: tell the user and offer `make use-published` first, which puts back both packages as `uv.lock` pins them and rewrites nothing.
3. **The latest published SDK**: `curl -s https://pypi.org/pypi/pipelex-sdk/json | .venv/bin/python -c 'import json, sys; print(json.load(sys.stdin)["info"]["version"])'`.
4. **The working tree**: `git status --short`. A dirty tree does not stop the bump, since `make all` does not need a clean one, but say so, and ask before touching `pyproject.toml` or `uv.lock` if either is already modified, since the bump would land on top of unrelated work in the same file.

## Step 2 — Determine the target

If the locked `pipelex-sdk` already is the latest, say there is nothing to bump and stop, unless the user names a newer version, published but not yet indexed.

Otherwise, ask the user with `AskUserQuestion`: the latest version, the default, or a version they type, between the locked one and the latest or ahead of it. Call it `TARGET`, without a `v`. A version below the locked one is a downgrade, not a bump: stop, since undoing a release means reading its changelog backwards and reversing its migrations, which no step here does.

Then read the `mthds` version `TARGET` pins exactly, and call it `MTHDS_TARGET`:

```bash
curl -s https://pypi.org/pypi/pipelex-sdk/<TARGET>/json | .venv/bin/python -c 'import json, sys; print(*[r for r in json.load(sys.stdin)["info"]["requires_dist"] if r.startswith("mthds")])'
```

When it is the `mthds` already locked, only the SDK moves.

## Step 3 — Read what changed

Read the changelog entries of every version strictly after the locked one, up to and including the target, for each package that moves. Versions are headed `## [vX.Y.Z] - YYYY-MM-DD`; skip `## [Unreleased]`, which nothing published carries. Neither package's distribution ships its changelog.

1. **`pipelex-sdk`**, from `../pipelex-sdk/python/CHANGELOG.md`, or the same file under the directory `make use-local`'s `SIBLINGS_DIR` names, when that copy has a `## [v<TARGET>]` heading; otherwise, or with no checkout, from `https://raw.githubusercontent.com/Pipelex/pipelex-sdk/main/python/CHANGELOG.md`.
2. **`mthds`**, when `MTHDS_TARGET` differs from the locked version, from `../mthds-python/CHANGELOG.md` when it has a `## [v<MTHDS_TARGET>]` heading, and otherwise from `https://raw.githubusercontent.com/mthds-ai/mthds-python/main/CHANGELOG.md`, the changelog PyPI's page for `mthds` links to.

Present the entries newest first, grouped by package and version. **`(Breaking)` at the end of a bold entry title is both changelogs' breaking marker**, and every such entry needs a verdict here: where it reaches the files of "Where the SDK reaches", or the search that shows it does not. The marker narrows the reading without replacing it: a new error class the error layer does not present yet, a field added to a model this tool validates, or a changed default reaches a seam without breaking any API, so read the added and changed entries against the same table and against what the docs claim. Everything else, CI changes and internal refactors, is for information only.

## Step 4 — Apply what's mechanical

For each entry that renames an identifier, an option or an environment variable written as `` `old` `` → `` `new` ``:

1. **Grep the whole project for the old name**, not only `src/`: names leak into `README.md`, `CLAUDE.md`, `docs/`, `.env.example`, the tests and their fixtures, and comments. Leave two places alone: the dated entries of `CHANGELOG.md`, which record what was true when they shipped, and `src/<package>/generated/`, which `make codegen` writes and stamps and which is never edited by hand; an old name there means the tree needs regenerating, in Step 6.
2. **If found**, apply the rename everywhere it appears and show the diff. There is no reason to keep an old name the SDK dropped.
3. **If not found**, say so and move on.
4. **Run `make format`** after any rename in Python code, since ruff sorts the imports a rename can reorder.

Not every breaking change is a rename. A different default, a removed method or a changed error shape needs a person's judgment to migrate correctly, so never guess at one: list each as needing manual review and let the user decide how to adapt the code before going on, saying which of them would turn `make all` red.

## Step 5 — Apply the version bump

1. **Raise both floors in `pyproject.toml`**: `"pipelex-sdk>=<TARGET>"`, and `"mthds>=<MTHDS_TARGET>"` when `mthds` moves, keeping the comment above the dependencies true. The SDK's exact pin would satisfy a lower `mthds` floor, but the floor records the `mthds` this tool was last read against.
2. **Re-lock to the target exactly**: `uv lock --upgrade-package pipelex-sdk==<TARGET>`. A bare `--upgrade-package pipelex-sdk` would lock the newest release the floor admits, which is later than the target whenever the target is not the latest, and Step 3 read the changelogs only as far as the target. `mthds` moves with it, because the SDK pins it exactly, and uv names both moves.
3. **Install it**: `make install`, which runs `uv sync` and installs exactly what the lock now pins.
4. **Confirm it landed**: Step 1's reading now names `TARGET` and `MTHDS_TARGET` for both floors and both locked versions, and `make local-status` says `pypi` for both packages.

## Step 6 — Run the checks

Run `make all`: ruff, the format check, pyright in strict mode, the offline codegen check, the tests and the build.

- **On success**, report and go on.
- **On failure**, show the errors. When one traces back to an entry Step 4 listed for manual review, connect the two for the user rather than dumping the error, and ask how to proceed: fix, skip or abort. Never guess at a fix for a behavior change.

The tests replace the client with a fake, so no check sees a change in what the API answers. Two live checks can, and both need `PIPELEX_API_KEY`:

- **`make codegen-verify`**, when the entries mention codegen, locks, crates, `write_codegen_tree`, `run_codegen_check`, `pipe_io` or `mthds.protocol`'s form and contract models. It asks the API whether the committed generated tree is still what the method resolves to, makes no model call and writes nothing. When it reports drift, run `make codegen`, then `make all` again, and commit the regenerated tree with the bump.
- **One run of the command**, which every SDK bump earns since it touches the call path, but which costs model calls, so only with the user's approval: `.venv/bin/<command> --inputs-template` prints the inputs to fill in, and a run with them prints its JSON result on stdout, and its run id and cost report on stderr.

## Step 7 — Update the changelog

Under `## [Unreleased]` in `CHANGELOG.md`, add or extend a `### Changed` bullet, creating either heading when it is missing:

```markdown
- Bumped `pipelex-sdk` to `{TARGET}` (was `{OLD_VERSION}`), with `mthds` `{MTHDS_TARGET}` (was `{OLD_MTHDS}`).
```

If Step 4 applied a migration that someone using this tool has to act on, such as a renamed environment variable in their `.env`, add a bullet describing it in this tool's terms, with `(Breaking)` at the end of its bold title. Restate the SDK's wording for a reader who has never opened the SDK's changelog, rather than copying it.

## Step 8 — Review and commit

Present a summary: `pipelex-sdk` and `mthds`, each from its old version to its new one; the files changed (`pyproject.toml`, `uv.lock`, `CHANGELOG.md`, the generated tree when Step 6 regenerated it, and whatever Step 4's migrations touched); and every manual-review item still open.

Ask the user to confirm. On confirmation:

1. Stage only the files this bump touched, by name. If one of them already held unrelated changes (Step 1), stage hunks carefully or ask the user how to separate them.
2. Commit with the message `Bump pipelex-sdk to {TARGET}`, adding a body line naming each migration Step 4 applied.
3. Show the commit.

Then offer, without doing it, to push and open a pull request. Wait for an explicit yes before either.

## Rules

- Stage files by name; never `git add .` or `git add -A`.
- Never push or open a pull request without the user's explicit approval.
- Never guess at a fix for a change that is not a mechanical rename: flag it and let the user decide.
- Never edit `src/<package>/generated/`: regenerate it with `make codegen`.
- Measure the checks against the published packages, never against `make use-local`.
- Do not assume the checkouts beside the project exist: keep the GitHub fallbacks ready.
- If a step fails or the user wants to abort, stop at once and say where the work was left.
