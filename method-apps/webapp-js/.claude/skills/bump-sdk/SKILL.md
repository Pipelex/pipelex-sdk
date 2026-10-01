---
name: bump-sdk
description: Bump the @pipelex/sdk dependency in this app to a newer published version. Reads the SDK's CHANGELOG.md for the versions in between, calls out breaking changes, applies mechanical renames (e.g. an env var or option renamed X → Y) to this repo's own code, updates package.json/package-lock.json, runs the checks, and prepares a commit. Use when the user says "bump the sdk", "bump @pipelex/sdk", "update pipelex sdk", "upgrade the pipelex sdk", "is there a new sdk version", or asks to pull in a newer @pipelex/sdk release.
---

# Bump @pipelex/sdk

`@pipelex/sdk` is pre-1.0, so its `^0.x.y` range in `package.json` only auto-resolves patch bumps (npm treats the leading `0` as the major for caret purposes) — a new minor like `0.1.5 → 0.2.0` needs this repo's `package.json` edited by hand. This skill does that deliberately: read what changed, apply what can be applied mechanically, verify, then hand the user a reviewable commit.

This repo is a **reference template** — treat it as if the sibling `../pipelex-sdk-js` checkout this workspace happens to have might not exist for whoever runs this skill. Always have a working fallback that only needs the published npm package and the public GitHub repo.

Guides the user through 8 steps. Every step that changes files or runs `npm install` should be visible to the user before moving on — with staged confirmations, and never a push or a commit without explicit approval — but the interesting judgment calls here are in reading the changelog and deciding what's safe to auto-fix, so lean on explaining rather than just executing.

## Step 1 — Gather State

Show the user:

1. The current range in `package.json`: `node -p "require('./package.json').dependencies['@pipelex/sdk']"`
2. What's actually installed: `node -p "require('./node_modules/@pipelex/sdk/package.json').version"`
3. The latest published version: `npm view @pipelex/sdk version`
4. Working tree status (`git status --short`)
5. Whether either package is a local tarball: `make local-status` (see this repo's `CLAUDE.md` § "Local package development"). The installed version cannot answer this, because a local build carries the version it will be published as.

**If `make local-status` reports `local`**, a bump should target the _published_ package, not whatever's on disk from local SDK development — tell the user and offer `make use-published` first. It restores both `@pipelex/sdk` and `@pipelex/mthds-form` at the versions the lockfile pins and rewrites nothing, so the baseline it gives is the one this bump moves from.

If the working tree is dirty, don't stop — this repo's checks (`make all`) don't require a clean tree — but note it, since the diff you produce at the end will sit alongside whatever else is already staged/unstaged. Ask before touching `package.json`/`package-lock.json` if either is already dirty, since your edit will land on top of unrelated in-flight changes to the same files.

## Step 2 — Determine Target Version

If current already equals latest, tell the user there's nothing to bump and stop (unless they name a newer version, published but not yet indexed).

Otherwise use `AskUserQuestion` to confirm the target:

- **Latest (`{npm view version}`)** — the default, recommended path.
- **A specific version** — let the user type one (e.g. pinning to a version between current and latest, or ahead of latest if they published something not yet indexed).

Store the result as `TARGET_VERSION` (no `v` prefix, e.g. `0.2.0`). If it is below what's installed, stop: a downgrade is not a bump. Undoing a release means reading its changelog backwards and reversing its migrations, which no step here does, so a rollback is the user's to plan by hand.

## Step 3 — Read What Changed

You need the SDK's `CHANGELOG.md` entries for every version strictly after the current one, up to and including `TARGET_VERSION`. Get it from whichever source is available, in this order:

1. **Local sibling checkout**, if this workspace has one: `../pipelex-sdk-js/CHANGELOG.md`, or the same file under the directory `make use-local`'s `SIBLINGS_DIR` names when the checkouts are elsewhere. Fast, no network, and it's the canonical source when present.
2. **GitHub raw**, otherwise: fetch `https://raw.githubusercontent.com/Pipelex/pipelex-sdk-js/main/CHANGELOG.md` (the repo is `Pipelex/pipelex-sdk-js`, confirmed via `npm view @pipelex/sdk repository.url`). The published npm tarball does **not** ship a `CHANGELOG.md`, so this is the only network-only fallback — don't assume `node_modules/@pipelex/sdk/` has it.

Extract the entries between `## [v{CURRENT}]` (exclusive) and `## [v{TARGET_VERSION}]` (inclusive) and present them to the user, grouped by version, newest first.

**Call out every bullet whose bold title ends in `(Breaking)`** (this changelog's only marker for a breaking change). These are the ones that can actually affect this repo's code. Everything else (CI changes, internal refactors, non-breaking additions) is FYI only — mention briefly, don't dwell.

## Step 4 — Apply What's Mechanical

Many breaking bullets in this changelog follow a rename pattern: an identifier or env var written as `` `oldName` `` renamed/changed to `` `newName` `` (e.g. "constructor option renamed `apiToken` → `apiKey`", "env var renamed `PIPELEX_API_URL` → `PIPELEX_BASE_URL`"). For each one:

1. Grep the **whole repo** for the old name — don't scope this to `src/` only. An env var name in particular tends to leak everywhere: `.env.example`, `README.md`, `CLAUDE.md`, `docs/*.md`, `e2e/*.spec.ts` comments and fallback reads, test assertions, not just the runtime code path. A rerun of this skill against the gallery this template was extracted from found the old name in over a dozen files across several kinds of file, so treat the file-scope list in this repo's own `CLAUDE.md` as a starting point, not a ceiling. The one place to leave alone is `CHANGELOG.md`'s **already-dated release entries** (`## [vX.Y.Z] - YYYY-MM-DD`) — those are a historical record of what was true at that release and shouldn't be rewritten; Step 7 is where this repo's changelog gets a new entry for _this_ change.
2. **If found**: this repo needs the migration. Apply it with `Edit` (rename the identifier / env var everywhere it appears), then show the diff. This matches the workspace's "no backward-compatibility shims — just change it" principle; there's no reason to keep the old name around once the SDK drops it.
3. **If not found**: say so and move on — this repo is already using the new name (or never used the old surface), nothing to do.
4. **Run `make format` right after any rename**, before moving on. A literal find-and-replace changes string lengths, and this repo's Prettier config re-flows Markdown tables to keep columns aligned — a raw rename of an env var name inside a `README.md` table will fail `make format-check` (and therefore `make all`) purely on column padding, which reads as a confusing false alarm if you hit it without knowing the rename is what caused it.

Not every breaking change is a mechanical rename — some are behavior changes (a different default, a removed method, a changed error shape) that need human judgment to migrate correctly. **Never guess at those.** List them clearly as a "needs manual review" checklist and let the user decide how (or whether) to adapt this repo's code before continuing. If any of these are unresolved and would break `make all`, say so explicitly — better to surface that now than have step 6 fail with a confusing error.

## Step 5 — Apply the Version Bump

1. Run `npm install @pipelex/sdk@{TARGET_VERSION}`. It rewrites the `"@pipelex/sdk"` line in `package.json` to `"^{TARGET_VERSION}"`, keeping the caret-pin style, and locks `TARGET_VERSION` itself. Editing the range by hand and running a bare `npm install` would lock the highest release that range admits instead, which is later than `TARGET_VERSION` whenever a patch release followed it — and Step 3 read the changelog only as far as `TARGET_VERSION`. Don't add `--package-lock-only`: this needs the actual new package contents in `node_modules` (not just a manifest edit).
2. Confirm it landed: `node -p "require('./node_modules/@pipelex/sdk/package.json').version"` should now read `TARGET_VERSION`.

## Step 6 — Run Checks

Run `make all` (lint + format-check + typecheck + unit tests + build, per this repo's `CLAUDE.md`).

- **On success**: report and continue.
- **On failure**: show the errors. If they trace back to one of the "needs manual review" items from Step 4, connect the dots for the user rather than just dumping the error. Ask how to proceed (fix, skip, abort) — don't guess at a fix for a behavior change you flagged as needing human judgment.

A `@pipelex/sdk` bump always touches the SDK call path by definition, so **always** offer `make test-e2e` here (it exercises the real API against the new SDK version, which `make all`'s mocked unit tests can't). It costs an LLM call per run and needs `PIPELEX_API_KEY` set, so only run it with explicit user approval.

**If the SDK changelog entries mention codegen, crates, locks, or `runCodegenCheck`, also offer `make codegen-verify`** (needs a key and a base URL serving `/v1/codegen`, but no LLM call). `make all` already re-runs the offline check after the bump; `codegen-verify` additionally asks the live engine whether the committed generated trees are still semantically current under the new SDK, which is exactly the surface such a release could have moved.

## Step 7 — Update This Repo's CHANGELOG.md

This repo keeps an `## [Unreleased]` section at the top of `CHANGELOG.md` (see existing entries for the format) — or in the changelog that file points to, when it only points elsewhere. Add or extend a `### Changed` bullet under it, e.g.:

```markdown
- Bumped `@pipelex/sdk` to `{TARGET_VERSION}` (was `{OLD_VERSION}`).
```

If Step 4 applied any migrations that are themselves user-visible for this repo (e.g. a renamed env var consumers need to update in their own `.env.local`), add a bullet describing it in this repo's own terms, with `(Breaking)` at the end of its bold title. Don't just copy the SDK's changelog wording verbatim; restate it for someone reading _this_ repo's changelog who has never looked at the SDK's.

## Step 8 — Review & Commit

Present a full summary:

- `@pipelex/sdk`: `{OLD_VERSION} → {TARGET_VERSION}`
- Files changed: `package.json`, `package-lock.json`, `CHANGELOG.md`, plus any files touched by Step 4's migrations
- Any unresolved "needs manual review" items from Step 4

Ask the user to confirm. On confirmation:

1. Stage only the files actually touched by this bump — never `git add .` or `git add -A`. If the working tree already had unrelated changes to one of these files (flagged in Step 1), stage hunks carefully or ask the user how to separate them rather than bundling unrelated work into this commit.
2. Commit with message: `Bump @pipelex/sdk to {TARGET_VERSION}` (add a short body line if Step 4 applied migrations, naming them).
3. Show the commit result.

Then offer (but do not automatically execute) pushing and opening a PR — target branch `dev` per this repo's `CLAUDE.md`. Wait for explicit approval before either.

## Rules

- Never use `git add .` or `git add -A` — stage only the files this bump actually touches.
- Never push or create PRs without explicit user approval.
- Never guess at a fix for a non-mechanical breaking change (behavior changes, removed APIs) — flag it and let the user decide.
- Don't assume the sibling `../pipelex-sdk-js` checkout exists — always have the GitHub-raw fallback ready.
- If any step fails or the user wants to abort, stop immediately — do not continue the workflow.
