---
name: bootstrap
description: Bootstrap this pipelex-starter-js template into a real project — replaces the template name (pipelex-starter-js / "Pipelex Starter") in package.json, README, CLAUDE.md, the app UI and the release skill, sets description, author, repo URL and license, resets the version and changelog, then syncs package-lock.json and runs the checks. Use this right after creating a repo from the template, or whenever the user says "bootstrap", "set up this template", "rename the project", "initialize the project", "replace the placeholders", "give this project a name", or "make this my own".
---

# Bootstrap Workflow

This repo is a GitHub **template**. A fresh clone still carries the template's identity everywhere: the npm package name `pipelex-starter-js` (package.json, package-lock.json, README H1, CLAUDE.md H1, the release skill), the display title `Pipelex Starter` (the page H1 and the browser `<title>`), the template's own description, version history (CHANGELOG.md chronicling the template's releases), and the Evotis S.A.S. MIT license. This skill turns all of that into the user's real project identity in one reviewable pass, then proves the result still passes CI's gates.

The mechanical replacement is done by a bundled script — `scripts/bootstrap.mjs` — because the same name appears in two spellings across config, docs, UI and skills, and the license choice touches LICENSE, package.json, and the README together. The script is deterministic, dependency-free (plain Node), and supports `--dry-run`, so you can show the plan before touching anything. **Your job in this skill is to collect good inputs, preview, run the script, and verify.** Walk the user through it; confirm before the steps that change files.

## Step 1 — Preflight

Confirm this is an un-bootstrapped template and the tree is clean enough to work in:

1. Read the `"name"` field at the top of `package.json`.
   - If it is `"pipelex-starter-js"`: this is a fresh template — continue.
   - If it is anything else: it looks **already bootstrapped**, and the script will refuse to run unless `--force` is passed. Tell the user and ask whether to proceed; only add `--force` to the commands below after they explicitly confirm. Warn them what a re-run means: the changelog is reset again, a license **type** change does not restore the README/LICENSE wording the first run already replaced, and a new name/title that embeds the previous one gets re-substituted on every run.
2. Run `git status --short`. If the tree is dirty, mention it — bootstrap leaves its edits **unstaged** for the user's own review, so a noisy starting point is worth flagging.
3. Check that `node_modules/` exists; if not, run `make install` first — Step 5's `make all` needs the dev toolchain, and a freshly created repo won't have it yet.

## Step 2 — Collect the project details

Ask the user for the following in one consolidated message. Lead with the package name (everything else derives from it) and offer sensible defaults so they can just confirm. If the user already provided all the details up front, don't re-ask — show the derived values and move on.

**Required:**

- **Package name** — the npm name, e.g. `invoice-extractor` (or scoped, `@acme/invoice-extractor`). Lowercase letters/digits/`-`/`.`/`_` only — the script validates it. This becomes `package.json`'s `name` and replaces `pipelex-starter-js` everywhere.
- **Display title** — e.g. `Invoice Extractor`. Default: the package name title-cased (scope stripped). Goes in the page H1 and the browser `<title>`.
- **Description** — a one-liner. Lands in `package.json`, the README intro, CLAUDE.md, and the app's `<meta name="description">`.

**Optional** (let them skip any):

- **Author** — fills `package.json`'s `author` field. Ask for **both name and email**; if the user offers only one, explicitly ask for the other (an email with no name is a common omission — confirm the name rather than inventing one or silently pulling it from `git config`). The script refuses an email without a name; a name alone is fine.
- **GitHub repository URL** — e.g. `https://github.com/acme/invoice-extractor`. Fills `package.json`'s `repository` field. A good default to _offer_ (never assume silently): `git remote get-url origin`, when it points at the user's own repo rather than the template.
- **License** — the template ships **MIT** (Evotis S.A.S.). Ask which license the user wants, because switching type (not just the holder) touches three places — the `LICENSE` body, the `license` field the script adds to `package.json`, and the README license line — and the script handles all three so you don't have to edit them by hand. Offer:
  - **Keep MIT** (default) — pass `--license-holder` (and optionally `--license-year`) to refresh the copyright line; the MIT body stays. If no holder is given, the copyright line keeps the template's holder (Evotis S.A.S.) and the script warns — so still try to collect the holder even for the default.
  - **Proprietary / all rights reserved** — the script rewrites `LICENSE` to an "all rights reserved" notice and sets `"license": "UNLICENSED"` (npm's convention for closed-source — npm rejects free-text license fields, so the literal `UNLICENSED` is required and the script uses it automatically). Collect the copyright holder.
  - **Other SPDX license** (e.g. `Apache-2.0`) — the script sets the `license` field and README label and writes a `LICENSE` **stub**; warn the user they must paste the full license text in themselves (the script can't author arbitrary license bodies).
  - **Copyright holder + year** — collect the holder for any non-default choice; the year **defaults to the current year** (the script reads the system clock — don't hardcode or assume it) and can be overridden with `--license-year`.

Show the derived values so the user can sanity-check before anything runs:

- package name: as given (e.g. `invoice-extractor`)
- title: as given or derived (e.g. `Invoice Extractor`)
- that the version resets to `0.1.0` and CHANGELOG.md restarts from a single "bootstrapped" entry

If the user gives a title but no package name, slugify the title to dashes for the default package name and confirm it.

## Step 3 — Preview (dry run)

Before changing anything, run the script in dry-run mode and show the user the plan:

```bash
node .claude/skills/bootstrap/scripts/bootstrap.mjs \
  --name "<package-name>" \
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

`--license` defaults to `mit`; pass `proprietary` or an SPDX id when the user chose otherwise. `--license-year` defaults to the current year (read from the system clock) — only pass it to override. Add `--force` only in the confirmed re-run case from Step 1 — without it the script refuses to touch a repo whose `package.json` name is no longer the template's.

Pass `--clean` because the user opted to strip the template-only scaffolding (CLAUDE.md's "this repo is a reference template" charter paragraph — a bootstrapped project is no longer a template, and that paragraph would steer every future Claude session toward template-maintainer behavior; the bootstrap skill itself is removed separately in Step 6). Omit it only if the user changed their mind and wants the template charter kept.

The dry run prints the list of files that would be edited. Present that summary and **get explicit confirmation** before the real run — unless the user already gave you everything and asked to just do it, in which case show the dry-run output and proceed.

## Step 4 — Run the replacement

Re-run the exact same command **without** `--dry-run`. The script:

- substitutes both name spellings across `package.json`, `README.md`, `CLAUDE.md`, `AGENTS.md`, `src/app/layout.tsx`, `src/app/page.tsx`, and the release skill's `SKILL.md`
- softens the template's "the starter ..." / "this starter ..." prose self-references in `src/lib/errors.ts` (user-facing error messages), `CLAUDE.md`, the release skill, the `Makefile`, and the e2e spec comments
- fills in the description (package.json, README intro, CLAUDE.md, layout metadata), and (if given) author and repository URL
- resets `version` to `0.1.0` and rewrites `CHANGELOG.md` to a fresh v0.1.0 entry dated today
- applies the license choice in all three places: the `LICENSE` body, the `license` field in `package.json`, and the README license line
- strips CLAUDE.md's template charter paragraph (with `--clean`)

It deliberately does **not** touch git, run `npm install`, run the checks, or modify `.github/`, `node_modules/`, `package-lock.json`, `methods/`, or the existing `release` skill's logic (only its name references).

**Heads-up — file state changed on disk.** The script rewrites `package.json`, `README.md`, `CLAUDE.md`, and `LICENSE` (and `--clean` shifts CLAUDE.md line numbers). If you find you need a manual `Edit` afterward, **re-read the file first** and re-derive any line numbers — a pre-run `grep` result is stale, and an `Edit` against an unread/old version will fail with "modified since read." In practice the script is meant to cover every placeholder so manual edits shouldn't be needed; if you reach for one, it's worth checking whether the script should handle that case instead.

## Step 5 — Sync the lock file and verify

`package-lock.json` pins the project's `name` and `version` in two places, and CI installs with `npm ci`, which **hard-fails on a mismatch** — so the lock file must be regenerated after the rename. Then run the same gates CI enforces (`lint-check.yml` runs `make check`; `tests-check.yml` runs `make agent-test` + `make build` — all covered by `make all`):

```bash
npm install --package-lock-only   # syncs the renamed name/version into package-lock.json
make all                          # lint + format-check + typecheck + unit tests + build
```

- **On success**: report it and continue.
- **On failure**: show the output and fix the cause — a leftover reference, a stale string, a name that didn't get rewritten, or missing dependencies (if commands like `eslint` or `next` aren't found, `node_modules/` is absent: run `make install`) — then re-run. Don't move on with a red check — the PR's CI will be red too. If `make format-check` is what failed, run `make format` and re-run `make all` rather than hand-editing.

## Step 6 — Clean up the bootstrap scaffolding & hand off

Bootstrap is a one-shot, so it removes itself **last**, only after the checks are green:

```bash
rm -rf .claude/skills/bootstrap
```

Run it from the repo root (the same directory the script ran in), and use a plain `rm` (not `git rm`) so the deletion stays unstaged, like every other change. Note this also removes the script's own test — that test guards the template's anchors and has no job in a bootstrapped project.

Finally, give the user a short summary:

- the package name and title that were applied, and the license that was set
- that the version was reset to `0.1.0` and `CHANGELOG.md` restarted
- that `package-lock.json` was re-synced and `make all` passes
- that **nothing is committed and nothing is staged** — they should review with `git status` and `git diff`, then commit when ready
- a nudge to skim the new `README.md` (it still documents the demo examples — keep them as references, add their own method as a tab with `make add-method METHOD=<path to a .mthds bundle, a catalog id or a published address>` per the "Add a method" section, or strip a demo by following the "Remove an example" checklist right below it), and to update `CLAUDE.md` as their project grows its own conventions. If the user asks to remove the demos now, that checklist is the procedure — offer to walk it with them
- a heads-up that the home page (`src/app/page.tsx`) still shows the template's subtitle and the demo tabs under their new title — accurate while the demos remain, theirs to rewrite when they add their own method

## Rules

- **Never commit; let the user review and commit.** Don't `git commit` or `git add` anything — all changes, including the self-removal (`rm`, not `git rm`), stay unstaged for the user's review.
- **Always dry-run before the real run.** This edits a brand-new repo; the preview is cheap insurance. Get confirmation when working interactively; when the user supplied every input up front and asked to proceed, the dry-run output still gets shown.
- **Re-sync `package-lock.json`.** Renaming the package makes the lock stale; `npm install --package-lock-only` is what keeps CI's `npm ci` green. Don't skip it.
- **Don't stop on a red check.** A failing `make all` here means CI will fail too — fix the root cause and re-run.
- **Don't touch `.github/` workflows or the `release` skill's logic** — they're generic to the template, not placeholders (the script only updates the release skill's name references).
- If any step fails or the user wants to abort, stop immediately and leave the tree in a state they can inspect — don't push forward through errors.
