---
name: bootstrap
description: Bootstrap this pipelex-starter-python template into a real project — replaces the placeholder name (widget / Widget) everywhere it appears, the package directory, description, author, repo URL and LICENSE holder, then regenerates the lock file and runs the checks and tests. Use this right after creating a repo from the template, or whenever the user says "bootstrap", "set up this template", "rename the project", "initialize the project", "replace the placeholders", "give this project a name", or "make this my own".
---

# Bootstrap Workflow

This repo is a GitHub **template**. A fresh clone still has the placeholder name everywhere: `widget` — used as the distribution name, the importable package (a directory plus many references), and the CLI command — plus the README title `Widget`. This skill turns that placeholder into the user's real project name in one reviewable pass, then proves the result still passes CI's gates.

The mechanical replacement is done by a bundled script — `scripts/bootstrap.py` — because the single `widget` token has to become **two** different forms depending on context (the dash-form distribution / CLI name in command positions, the underscore-form package name in imports and paths), plus the `Widget` title, plus one filesystem rename of the package directory. The script is deterministic, supports `--dry-run` so you can show the plan before touching anything, and hard-fails if any placeholder token survives the substitution. **Your job in this skill is to collect good inputs, preview, run the script, and verify.** Walk the user through it; confirm before the steps that change files.

## Step 1 — Preflight

Confirm this is an un-bootstrapped template and the tree is clean enough to work in:

1. Read the `name = "..."` line near the top of `pyproject.toml`.
   - If it is `name = "widget"`: this is a fresh template — continue.
   - If it is anything else, or the `widget/` directory is gone: it looks **already bootstrapped**. Tell the user and ask whether to proceed anyway (the script is safe to re-run but most edits will be no-ops).
2. Run `git status --short`. If the tree is dirty, mention it — bootstrap will add edits and renames on top, and the user asked for changes to be left **unstaged** for their own review, so a noisy starting point is worth flagging.

## Step 2 — Collect the project details

Ask the user for the following in one consolidated message. Lead with the package name (everything else derives from it) and offer sensible defaults so they can just confirm.

**Required:**
- **Package name** (importable, underscores) — e.g. `invoice_extractor`. Must be lowercase letters/digits/underscores, starting with a letter. This becomes the package directory and every `import` / `library_dirs` reference.
- **Display title** — e.g. `Invoice Extractor`. Default: the package name title-cased. Goes in the README H1.
- **Description** — a one-liner for `pyproject.toml`. (Currently `"Replace this with your project description"`.)

**Optional** (let them skip any):
- **Author** — fills the commented-out `authors = [...]` line in `pyproject.toml`. Ask for **both name and email**; if the user offers only one, explicitly ask for the other (an email with no name is a common omission — confirm the name rather than inventing one or silently pulling it from `git config`).
- **GitHub repository URL** — e.g. `https://github.com/acme/invoice-extractor`. Replaces the `yourusername/widget` Repository URL and the README clone URLs.
- **License** — the template ships **MIT**. Ask which license the user wants, because switching type (not just the holder) touches three places — the `LICENSE` body, `license = "..."` in `pyproject.toml`, and the README license line — and the script handles all three so you don't have to edit them by hand. Offer:
  - **Keep MIT** (default) — pass `--license-holder` (and optionally `--license-year`) to refresh the copyright line; the MIT body stays.
  - **Proprietary / all rights reserved** — the script rewrites `LICENSE` to an "all rights reserved" notice and sets `license = "LicenseRef-Proprietary"`. Proprietary has **no SPDX id**, and `uv lock --locked` (CI) validates that field, so the `LicenseRef-` form is required — the script uses it automatically. Collect the copyright holder.
  - **Other SPDX license** (e.g. `Apache-2.0`) — the script sets the `license =` field and README label and writes a `LICENSE` **stub**; warn the user they must paste the full license text in themselves (the script can't author arbitrary license bodies).
  - **Copyright holder + year** — collect the holder for any non-default choice; the year **defaults to the current year** (the script reads the system clock — don't hardcode or assume it) and can be overridden with `--license-year`.

Derive and show the three name forms so the user can sanity-check before anything runs:
- distribution (dashes): package with `_`→`-` (e.g. `invoice-extractor`) — override-able; this is also the CLI command name
- package (underscores): as given — the importable package and the form used in imports/paths
- title: as given — the README H1

If the user gives a title but no package name, slugify the title to underscores for the default package name and confirm it.

## Step 3 — Preview (dry run)

Before changing anything, run the script in dry-run mode and show the user the plan:

```bash
python .claude/skills/bootstrap/scripts/bootstrap.py \
  --package "<package>" \
  --title "<title>" \
  --description "<description>" \
  [--author-name "<name>" --author-email "<email>"] \
  [--repo-url "<url>"] \
  [--license "mit|proprietary|<spdx-id>"] \
  [--license-holder "<holder>"] \
  [--license-year "<year>"] \
  --clean \
  --dry-run
```

`--license` defaults to `mit`; pass `proprietary` or an SPDX id when the user chose otherwise. `--license-year` defaults to the current year (read from the system clock) — only pass it to override.

Pass `--clean` because the user opted to strip the template-only scaffolding (the README "Use this template / Next steps" block; the bootstrap skill itself is removed separately in Step 6). Omit it only if the user changed their mind and wants the template block kept.

The dry run prints the package-directory rename, the list of files that would be edited and the template's own maintenance files that would be removed. Present that summary and **get explicit confirmation** before the real run. Only pass `--dist` if the user wants a distribution name that isn't just the package with dashes.

## Step 4 — Run the replacement

Re-run the exact same command **without** `--dry-run`. The script:
- renames `widget/` → `<package>/` (via `git mv`, so history follows). The e2e test file is named after its demo (`tests/e2e/test_extract_entities.py`), not the project, so nothing in `tests/` is renamed — only its contents are edited.
- substitutes the name across `pyproject.toml`, `README.md`, `CLAUDE.md`, the `Makefile`, `scripts/*.py` (`scripts/codegen.py` holds the `<package>/methods` and `<package>/generated` paths `make codegen` and `make codegen-check` both discover from), the package's `.py`/`.mthds` files, the tests, and the docs under `docs/` — using context-aware rules: the dash dist form in CLI-command / distribution positions, the underscore package form in imports and paths, the title in prose. `pyproject.toml` is handled with targeted per-key edits (its package-list arrays need the package form in a bare-string position). It then asserts no placeholder token survived, and aborts with the offending locations if one did.
- fills in description, and (if given) author, repo URL
- applies the license choice in all three places: the `LICENSE` body, `license = "..."` in `pyproject.toml`, and the README license line
- strips the README template block
- removes the template's own maintenance, listed in the script's `MAINTAINER_ONLY_PATHS`: the CLA assistant (`cla.yml`), the branch-flow guard (`guard-branches.yml`), the release checks (`version-check.yml`, `changelog-check.yml`), the GitHub Release job (`github-release.yml`) and the `release` skill. They encode Pipelex's contributor agreement and release discipline, not the user's; each of their jobs is guarded to `Pipelex/pipelex-starter-python`, so they were already inert in the new repository, and removing them keeps them out of it altogether. `lint-check.yml`, `tests-check.yml` and `package-check.yml` stay: they are the project's own CI. The removal is a plain delete, unstaged like the edits, and it happens after the survivor check, so an aborted run has removed nothing.

It deliberately does **not** run the lock file, run the checks, commit, or touch `.venv/`, `uv.lock` or the workflows it keeps.

**Heads-up — file state changed on disk.** The script rewrites `pyproject.toml`, `README.md`, and `LICENSE` (and `--clean` shifts README line numbers). If you find you need a manual `Edit` afterward, **re-read the file first** and re-derive any line numbers — a pre-run `grep` result is stale, and an `Edit` against an unread/old version will fail with "modified since read." In practice the script is meant to cover every placeholder so manual edits shouldn't be needed; if you reach for one, it's worth checking whether the script should handle that case instead.

**Heads-up — staging is mixed.** `git mv` *stages* the renames (they show as `R` in `git status`), while the content edits stay unstaged (`M`). That's intentional — staged renames give the cleanest diff for review — but it means the change set is not uniformly unstaged. Nothing is committed. The user reviews everything with `git status` + `git diff` and commits when ready (a single `git add -A && git commit` captures both the staged renames and the unstaged edits).

## Step 5 — Regenerate the lock file and verify

The renamed distribution must be reflected in `uv.lock`, or CI's `package-check.yml` (`uv lock --locked`) fails the PR. Then run the same gates `lint-check.yml` and `tests-check.yml` enforce. All three are quiet on success:

```bash
make li            # uv lock + uv sync — refreshes uv.lock for the new project name
make agent-check   # ruff format/lint, plxt, pyright, mypy
make agent-test    # tests, excludes inference/LLM markers
```

- **On success**: report it and continue.
- **On failure**: show the output and fix the cause (a leftover reference, a stale import, a name that didn't get rewritten), then re-run. Don't move on with a red check — the PR's CI will be red too. `make agent-check` auto-formats, so it may itself modify files; that's expected.

## Step 6 — Clean up the bootstrap scaffolding & hand off

Bootstrap is a one-shot, so it removes itself **last**, only after the checks are green:

```bash
rm -rf .claude/skills/bootstrap tests/unit/test_bootstrap_script.py
```

The test file goes with the script it tests. It loads `bootstrap.py` by path, so it stops importing the moment the skill is gone, and it is the one file the substitution deliberately skips: its fixtures spell the placeholder on purpose, so renaming them would turn passing tests into failing ones rather than carry anything useful into the new project.

Use a plain `rm` (not `git rm`) so the deletion stays unstaged, like the other content changes.

Finally, give the user a short summary:
- the three name forms that were applied, and the license that was set
- that the package directory was renamed, and that the template's own CLA, branch-flow and release workflows and its `release` skill were removed
- that `uv.lock` was regenerated and `make agent-check` / `make agent-test` pass
- that **nothing is committed**; the renames are staged (`R`) and the content edits are unstaged (`M`) — they should review with `git status` and `git diff`, then commit (a single `git add -A && git commit` captures everything)
- a nudge to skim the new `README.md` and write real project content, and to update `CLAUDE.md` if the project's specifics have changed

## Rules

- **Never commit; let the user review and commit.** Don't `git commit` or `git add` content edits. The renames go through `git mv` (so they're staged as clean `R` entries — that's fine and gives the best diff) while everything else, including the self-removal (`rm`, not `git rm`), stays unstaged. Tell the user the staging is mixed so the "review then commit" handoff isn't a surprise.
- **Always dry-run before the real run** and get confirmation. This edits a brand-new repo and renames a directory; the preview is cheap insurance.
- **Regenerate `uv.lock`.** Renaming the distribution name makes the lock stale; `make li` (or `uv lock`) is what keeps `package-check.yml` green. Don't skip it.
- **Don't stop on a red check.** A failing `make agent-check` / `make agent-test` here means CI will fail too — fix the root cause and re-run.
- **Don't edit the workflows the script keeps** (`lint-check.yml`, `tests-check.yml`, `package-check.yml`) — they're the project's own CI and hold no placeholder. Everything else under `.github/workflows/`, and the `release` skill, is the template's own and the script removes it.
- If any step fails or the user wants to abort, stop immediately and leave the tree in a state they can inspect — don't push forward through errors.
