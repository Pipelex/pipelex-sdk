---
name: bootstrap
description: Bootstrap this pipelex-method-cli-python template into a real project — names the distribution, the import package and the console script after one name, writes the description into pyproject.toml and CLAUDE.md, renders the project's own README, sets author, repo URL and license, resets the version and changelog, removes what only the template needs (the make create gesture), then re-syncs uv.lock and runs the checks. Use this to finish a `make create` that stopped after writing the method, or when the method is already in the package and the user says "bootstrap", "rename the project", "initialize the project", "give this project a name", or "make this my own". For a fresh copy with no method, `make create METHOD=<method>` is the path.
---

# Bootstrap Workflow

This directory is a **template**, copied out of the `method-apps/cli-python/` directory of the `pipelex-sdk` mono-repo. A fresh copy still carries the template's identity: the distribution and console script `pipelex-method-cli-python` and the import package `pipelex_method_cli_python` (in `pyproject.toml`, `uv.lock`, the package directory under `src/`, every import, the Makefile, `.gitattributes`, and the headings of `CLAUDE.md` and `AGENTS.md`), a README about the template, a changelog pointing at the family's, the template's MIT license, and the `make create` gesture. This skill turns all of that into the project's identity in one reviewable pass, then proves the result still passes CI's gates.

**`make create` is the usual path, and it runs this workflow with no conversation at all.** `make create METHOD=<method>` writes the method into the package, derives the name, title and description from it, runs this script with those values and `--clean` (a `--dry-run` first, to check them), writes `.env`, re-syncs `uv.lock`, runs `make all`, and removes this skill once the checks are green: Steps 3 to 6 below, in one command that refuses rather than asks. [`docs/create.md`](../../../docs/create.md) is its reference. A CLI made from this template holds exactly one method and has no gesture to add one afterwards, so when the user has the method, point them to `make create`, or run it for them.

Run this skill by hand in two cases only:

- **A `make create` that stopped after writing the method.** Its message lists the commands left, starting with this script and the exact values it planned; follow them in order. Steps 4 to 6 below are those commands.
- **The method is already in the package**, written by hand: its files or a `method.json` in `src/pipelex_method_cli_python/method/`, its tree from `make codegen` in `generated/`, and a `binding.py`. Walk the user through every step.

## Step 1 — Preflight

1. Read the `name` under `[project]` in `pyproject.toml`.
   - If it is `pipelex-method-cli-python`: this is the un-bootstrapped template — continue.
   - If it is anything else: it looks **already bootstrapped**, and the script refuses to run unless `--force` is passed. Tell the user and ask whether to proceed; only add `--force` after they explicitly confirm. Warn them what a re-run means: the README and the changelog are rendered again from scratch, and a license **type** change does not restore the LICENSE wording the first run already replaced.
2. Check that the package holds its method: `src/pipelex_method_cli_python/binding.py` exists and `make codegen-check` reports it current. If there is no method, stop and point the user to `make create`: a project bootstrapped without one has no gesture left to add it.
3. Run `git status --short` if the directory is a repository. Bootstrap leaves its edits **unstaged** for the user's own review, so a noisy starting point is worth flagging.
4. Check that `.venv/` exists; if not, run `make install` first. The script formats what it writes with the project's ruff, and Step 5's `make all` needs the whole toolchain.

## Step 2 — Collect the project details

Ask for the following in one consolidated message, leading with the name, and offer defaults the user can just confirm. If the user already gave everything, don't re-ask: show the derived values and move on.

**Required:**

- **Name** — e.g. `invoice-extractor`. Lowercase letters and digits, starting with a letter, words joined by single dashes or underscores. It becomes the distribution and the console script as given, and the import package with its dashes as underscores (`invoice_extractor`). The script refuses a name whose package would be a Python keyword, shadow a standard-library module, or shadow one of the project's own or its dependencies' import names (`scripts`, `tests`, `typer`, `pydantic`, …).
- **Description** — a one-liner. Lands in `pyproject.toml`, the README and `CLAUDE.md`.

**Optional** (let them skip any):

- **Title** — e.g. `Invoice Extractor`; default: the name, title-cased. It heads the README. Any characters are safe.
- **Author** — fills `pyproject.toml`'s `authors`. Ask for **both name and email**; the script refuses an email without a name, and a name alone is fine. Never invent one or pull it silently from `git config`.
- **Repository URL** — fills `[project.urls]`. Offer `git remote get-url origin` as a default only when it points at the user's own repository rather than the template's.
- **License** — the template ships **MIT** (Evotis S.A.S.). Switching type touches three places — `LICENSE`, `pyproject.toml`'s `license` and the README's license line — and the script handles all three:
  - **Keep MIT** (default): pass `--license-holder` (and optionally `--license-year`) to claim the copyright line. Without a holder the line keeps the template's holder and the script warns, so still try to collect one.
  - **Proprietary / all rights reserved**: the script writes an "all rights reserved" notice and sets `license = "LicenseRef-Proprietary"`, an SPDX expression uv accepts. Collect the holder.
  - **Another SPDX license** (e.g. `Apache-2.0`): the script sets the expression and the README label and writes a `LICENSE` **stub**; tell the user to paste the full text in.
  - The year defaults to the current year, which the script reads from the system clock.

Show the derived values so the user can check them: the three names, the title, that the version resets to `0.1.0` with `CHANGELOG.md` restarting from one entry, and that `README.md` is replaced by a short README about their CLI.

## Step 3 — Preview (dry run)

```bash
.venv/bin/python .claude/skills/bootstrap/scripts/bootstrap.py \
  --name "<name>" \
  --description "<description>" \
  [--title "<title>"] \
  [--author-name "<name>" --author-email "<email>"] \
  [--repo-url "<url>"] \
  [--license "mit|proprietary|<spdx-id>"] \
  [--license-holder "<holder>"] \
  [--license-year "<year>"] \
  --clean \
  --dry-run
```

Pass `--clean` so the script strips `CLAUDE.md`'s template charter paragraph: a bootstrapped project is no longer a template, and that paragraph would steer every future agent session toward template-maintainer behavior. Add `--force` only in the confirmed re-run case from Step 1.

The dry run prints the files it would edit, the package directory it would move and the template-only paths it would remove, and refuses without writing anything when a value is invalid or a file it keeps would still name the template. Present the plan and **get explicit confirmation** before the real run, unless the user gave everything and asked to just do it.

## Step 4 — Run the replacement

Re-run the same command **without** `--dry-run`. The script:

- sets `pyproject.toml`'s name, description, license, and (if given) authors and repository URL, renames the console script, and resets the version to `0.1.0`
- moves `src/pipelex_method_cli_python/` to the project's package with a plain filesystem move, and rewrites the template's identifier in every file the project keeps, `.gitattributes`, the Makefile and every import included
- renders a new `README.md` for the project: its title, its description, how to install and run it, how to work on it, and its license
- replaces `CLAUDE.md`'s description line and, with `--clean`, strips the charter paragraph
- applies the license choice to `LICENSE` and restarts `CHANGELOG.md` at a `v0.1.0` entry dated today
- removes what only the template needs, listed in its `REMOVALS`: the `make create` gesture, its planning code, its tests and their fixtures, and `docs/create.md`
- strips every template-only passage, the lines between a `template-only:begin` marker and a `template-only:end` marker together with both markers, from every file that carries one
- formats every Python file it writes with the project's ruff

It deliberately does **not** touch git, re-sync `uv.lock`, run the checks, or modify the method, `generated/`, `binding.py` or anything in `.github/`. It also does not remove this skill; Step 6 does.

**Heads-up — file state changed on disk.** If you need a manual `Edit` afterward, **re-read the file first**: the package has moved, and a pre-run read is stale. The script is meant to cover every placeholder, so a manual edit is a sign the script should handle that case instead.

## Step 5 — Re-sync and verify

`uv.lock` names the project, and CI installs with `UV_LOCKED=1`, which **fails on a stale lock**, so re-sync it after the rename, which also installs the renamed console script into `.venv/`. Then run the gates CI runs:

```bash
uv sync     # re-locks the renamed project and installs its console script
make all    # lint, format check, pyright, the offline codegen check, the tests, and the wheel
```

- **On success**: report it and continue.
- **On failure**: show the output, fix the cause and re-run. If `make format-check` is what failed, run `make format` and re-run `make all` rather than hand-editing. Don't move on with a red check: the project's first pull request would be red too.

## Step 6 — Clean up and hand off

Bootstrap is a one-shot, so it removes itself **last**, only after the checks are green:

```bash
rm -rf .claude/skills/bootstrap
```

Run it from the project's root, and use a plain `rm` (not `git rm`) so the deletion stays unstaged like every other change. Remove `.claude/skills/` and `.claude/` too if they are left empty.

Then give the user a short summary:

- the name, the package and the console script that were applied, and the license that was set
- that the version was reset to `0.1.0`, `CHANGELOG.md` restarted and `README.md` rewritten for the project
- that `uv.lock` was re-synced and `make all` passes
- that **nothing is committed and nothing is staged**: they should review with `git status` and `git diff`, then commit when ready
- how to run the CLI: `.venv/bin/<name> --help` lists the method's inputs, and a run needs `PIPELEX_API_KEY` in the shell or in `.env`

## Rules

- **Never commit; let the user review and commit.** Don't `git commit` or `git add` anything: every change, the self-removal included, stays unstaged.
- **Always dry-run before the real run**, and show its output even when the user supplied every input and asked to proceed.
- **Re-sync `uv.lock`** with `uv sync`: the rename makes the lock stale, and CI's locked install refuses it.
- **Don't stop on a red check.** A failing `make all` here means CI will fail too: fix the root cause and re-run.
- **Don't edit `.github/` workflows.** They are generic to any project created from the template, and the script leaves them alone.
- If any step fails or the user wants to abort, stop and leave the tree in a state they can inspect; don't push forward through errors.
