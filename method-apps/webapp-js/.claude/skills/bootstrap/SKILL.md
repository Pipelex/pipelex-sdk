---
name: bootstrap
description: Bootstrap this pipelex-method-webapp-js template into a real project — names the package, writes the app's title and description into src/site.ts, renders the project's own README, sets author, repo URL and license, resets the version and changelog, removes what only the template needs (the make create gesture), then syncs package-lock.json and runs the checks. Use this right after copying the template into a new project, or whenever the user says "bootstrap", "set up this template", "rename the project", "initialize the project", "replace the placeholders", "give this project a name", or "make this my own".
---

# Bootstrap Workflow

This directory is a **template**, copied out of the `webapp-js/` directory of the `pipelex-method-apps` mono-repo. A fresh copy still carries the template's identity: the npm package name `pipelex-method-webapp-js` (in `package.json`, `package-lock.json`, and the headings of `CLAUDE.md` and `AGENTS.md`), the display title `Pipelex Method App` and the template's description (in `src/site.ts`, which the page heading, the browser title and the meta description all read), a README about the template, a changelog pointing at the family's, the template's MIT license, and the `make create` gesture. This skill turns all of that into the user's project identity in one reviewable pass, then proves the result still passes CI's gates. It adds no method; `make add-method` does that afterwards.

The mechanical part is done by a bundled script, `scripts/bootstrap.mjs`. It is deterministic, needs nothing beyond Node and the repo's own Prettier, and supports `--dry-run`, so you can show the plan before touching anything. **Your job in this skill is to collect good inputs, preview, run the script, and verify.** Walk the user through it; confirm before the steps that change files.

**`make create` runs this same workflow with no conversation at all.** `make create METHOD=<method>` derives the package name, title and description from the method, adds the method, runs this script with those values and `--clean` (a `--dry-run` first, to check them), writes `.env.local`, re-syncs `package-lock.json`, runs `make all`, and removes this skill once the checks are green — Steps 3 to 6 below, in one command that refuses rather than asks. [`docs/create.md`](../../../docs/create.md) is its reference. When the user already has the method and wants the app, point them to it, or run it for them. This skill is the path for naming the project first and adding a method afterwards, or for choosing each value with the user.

## Step 1 — Preflight

Confirm this is an un-bootstrapped template and the tree is clean enough to work in:

1. Read the `"name"` field at the top of `package.json`.
   - If it is `"pipelex-method-webapp-js"`: this is a fresh template — continue.
   - If it is anything else: it looks **already bootstrapped**, and the script refuses to run unless `--force` is passed. Tell the user and ask whether to proceed; only add `--force` to the commands below after they explicitly confirm. Warn them what a re-run means: the README and the changelog are rendered again from scratch, and a license **type** change does not restore the LICENSE wording the first run already replaced.
2. Run `git status --short`. If the tree is dirty, mention it — bootstrap leaves its edits **unstaged** for the user's own review, so a noisy starting point is worth flagging.
3. Check that `node_modules/` exists; if not, run `make install` first. The script formats what it writes with the repo's Prettier, and Step 5's `make all` needs the whole toolchain.

## Step 2 — Collect the project details

Ask the user for the following in one consolidated message. Lead with the package name (everything else derives from it) and offer sensible defaults so they can just confirm. If the user already provided all the details up front, don't re-ask — show the derived values and move on.

**Required:**

- **Package name** — the npm name, e.g. `invoice-extractor` (or scoped, `@acme/invoice-extractor`). Lowercase letters/digits/`-`/`.`/`_` only — the script validates it. This becomes `package.json`'s `name` and the heading of `CLAUDE.md` and `AGENTS.md`.
- **Display title** — e.g. `Invoice Extractor`. Default: the package name title-cased (scope stripped). It becomes the page heading, the browser title and the README heading. Any characters are safe: the script writes it into `src/site.ts` as a string literal, never into markup.
- **Description** — a one-liner. Lands in `package.json`, the README, `CLAUDE.md`, and `src/site.ts`, which the page subtitle and the meta description read.

**Optional** (let them skip any):

- **Author** — fills `package.json`'s `author` field. Ask for **both name and email**; if the user offers only one, explicitly ask for the other (confirm the name rather than inventing one or silently pulling it from `git config`). The script refuses an email without a name; a name alone is fine.
- **GitHub repository URL** — e.g. `https://github.com/acme/invoice-extractor`. Fills `package.json`'s `repository` field. A good default to _offer_ (never assume silently): `git remote get-url origin`, when it points at the user's own repo rather than the template.
- **License** — the template ships **MIT** (Evotis S.A.S.). Ask which license the user wants, because switching type touches three places — the `LICENSE` body, the `license` field in `package.json`, and the README's license line — and the script handles all three. Offer:
  - **Keep MIT** (default) — pass `--license-holder` (and optionally `--license-year`) to refresh the copyright line; the MIT body stays. If no holder is given, the copyright line keeps the template's holder and the script warns — so still try to collect the holder.
  - **Proprietary / all rights reserved** — the script rewrites `LICENSE` to an "all rights reserved" notice and sets `"license": "UNLICENSED"` (npm's convention for closed source). Collect the copyright holder.
  - **Other SPDX license** (e.g. `Apache-2.0`) — the script sets the `license` field and README label and writes a `LICENSE` **stub**; warn the user they must paste the full license text in themselves.
  - **Copyright holder + year** — collect the holder for any non-default choice; the year **defaults to the current year** (the script reads the system clock — don't assume it) and can be overridden with `--license-year`.

Show the derived values so the user can sanity-check before anything runs:

- package name: as given (e.g. `invoice-extractor`)
- title: as given or derived (e.g. `Invoice Extractor`)
- that the version resets to `0.1.0` and `CHANGELOG.md` restarts from a single entry
- that `README.md` is replaced by a short README about their project, which names the template once as its origin

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

`--license` defaults to `mit`. `--license-year` defaults to the current year — only pass it to override. Add `--force` only in the confirmed re-run case from Step 1.

Pass `--clean` so the script strips `CLAUDE.md`'s template charter paragraph: a bootstrapped project is no longer a template, and that paragraph would steer every future agent session toward template-maintainer behavior. Omit it only if the user explicitly wants the charter kept.

The dry run prints the files it would edit and the template-only paths it would remove. Present that summary and **get explicit confirmation** before the real run — unless the user already gave you everything and asked to just do it, in which case show the dry-run output and proceed.

## Step 4 — Run the replacement

Re-run the exact same command **without** `--dry-run`. The script:

- sets `package.json`'s name, description, license, and (if given) author and repository, and resets its version to `0.1.0`
- renders a new `README.md` for the project: its title, its description, how to run it and work on it, the docs, and its license
- replaces `CLAUDE.md`'s description line and, with `--clean`, strips the charter paragraph; the template's name, which appears only in the headings of `CLAUDE.md` and `AGENTS.md`, becomes the package name
- writes the title and description into `src/site.ts`
- applies the license choice to `LICENSE`
- rewrites `CHANGELOG.md` to a fresh `v0.1.0` entry dated today
- removes what only the template needs — the `make create` gesture (`scripts/create.mts`, `scripts/lib/create.mts` and its test, and `docs/create.md`), the tile e2e with its fixture (`e2e/resultTile.spec.ts` and `e2e/fixtures/generate-image/`), and `docs/chrome-lineage.md`, which governs the template's relation to the gallery it was extracted from — and drops the `create` script from `package.json`
- strips the template-only passages, which describe what it removes, from the `Makefile`, `CLAUDE.md`, `AGENTS.md`, `docs/ci.md` and `docs/input-form.md`: each passage sits between a `template-only:begin` line and a `template-only:end` line, and goes with both of them
- formats every file it writes with the repo's Prettier

It deliberately does **not** touch git, run `npm install`, run the checks, add a method, or modify `node_modules/`, `package-lock.json`, `methods/`, `src/generated/` or anything in `.github/`. It also does not remove this skill; Step 6 does.

**Heads-up — file state changed on disk.** If you need a manual `Edit` afterward, **re-read the file first** — a pre-run read is stale, and an `Edit` against it fails with "modified since read." The script is meant to cover every placeholder, so a manual edit is a sign the script should handle that case instead.

## Step 5 — Sync the lock file and verify

`package-lock.json` pins the project's `name` and `version`, and CI installs with `npm ci`, which **hard-fails on a mismatch** — so the lock must be regenerated after the rename. Then run the same gates CI enforces:

```bash
npm install --package-lock-only   # syncs the renamed name/version into package-lock.json
make all                          # lint + format-check + typecheck + codegen-check + unit tests + build
```

- **On success**: report it and continue.
- **On failure**: show the output and fix the cause, then re-run. If `eslint` or `next` isn't found, `node_modules/` is absent: run `make install`. If `make format-check` is what failed, run `make format` and re-run `make all` rather than hand-editing. Don't move on with a red check — the project's first pull request would be red too.

## Step 6 — Clean up the bootstrap scaffolding & hand off

Bootstrap is a one-shot, so it removes itself **last**, only after the checks are green:

```bash
rm -rf .claude/skills/bootstrap
```

Run it from the repo root, and use a plain `rm` (not `git rm`) so the deletion stays unstaged, like every other change. This also removes the script's own test, which guards the template's files and has no job in a project.

Finally, give the user a short summary:

- the package name and title that were applied, and the license that was set
- that the version was reset to `0.1.0`, `CHANGELOG.md` restarted and `README.md` rewritten for the project
- that `package-lock.json` was re-synced and `make all` passes
- that **nothing is committed and nothing is staged** — they should review with `git status` and `git diff`, then commit when ready
- that the app has no method yet, and the page says so: the next step is `make add-method METHOD=<method>`, where the method is a path to a `.mthds` file or to a directory of them (copied into `methods/<name>/`), a catalog id from [app.pipelex.com](https://app.pipelex.com), or a published package address. It needs `PIPELEX_API_KEY` in `.env.local`. [`docs/add-method.md`](../../../docs/add-method.md) is the reference. Offer to run it with them.

## Rules

- **Never commit; let the user review and commit.** Don't `git commit` or `git add` anything — all changes, including the self-removal (`rm`, not `git rm`), stay unstaged for the user's review.
- **Always dry-run before the real run.** When the user supplied every input up front and asked to proceed, the dry-run output still gets shown.
- **Re-sync `package-lock.json`.** Renaming the package makes the lock stale; `npm install --package-lock-only` is what keeps CI's `npm ci` green.
- **Don't stop on a red check.** A failing `make all` here means CI will fail too — fix the root cause and re-run.
- **Don't edit `.github/` workflows.** They are generic to any project created from the template, and the script leaves them alone.
- If any step fails or the user wants to abort, stop immediately and leave the tree in a state they can inspect — don't push forward through errors.
