---
name: bump-mthds-form
description: Bump the @pipelex/mthds-form dependency in this app to a newer published version. Reads the form kernel's CHANGELOG.md for the versions in between, checks the changes against the seams this repo consumes (the gate, readiness, the wire format, the React controls, the Tailwind token mirror), applies mechanical renames, updates package.json/package-lock.json, runs the checks, and prepares a commit. Use when the user says "bump mthds-form", "bump the form kernel", "update @pipelex/mthds-form", "upgrade the form package", "is there a new mthds-form version", or asks to pull in a newer @pipelex/mthds-form release.
---

# Bump @pipelex/mthds-form

`@pipelex/mthds-form` is pre-1.0, so its `^0.x.y` range in `package.json` only auto-resolves patch bumps (npm treats the leading `0` as the major for caret purposes) — a new minor like `0.2.0 → 0.3.0` needs this repo's `package.json` edited by hand. This skill does that deliberately: read what changed, apply what can be applied mechanically, verify, then hand the user a reviewable commit.

This repo is a **reference template** — treat it as if the sibling `../mthds-form` checkout this workspace happens to have might not exist for whoever runs this skill. Always have a working fallback that only needs the published npm package and the public GitHub repo.

This is the sibling of the `bump-sdk` skill, with the same shape and the same staged-confirmation style: every step that changes files or runs `npm install` should be visible to the user before moving on, and the interesting judgment calls are in reading the changelog and deciding what's safe to auto-fix — lean on explaining rather than just executing. What differs is the surface: the form kernel touches this repo through more seams than the SDK does (both package entry points, a CSS import, a Tailwind token mirror, and the generated `contracts.ts` trees), and its changelog flags impact differently.

## Step 1 — Gather State

Show the user:

1. The current range in `package.json`: `node -p "require('./package.json').dependencies['@pipelex/mthds-form']"`
2. What's actually installed: `node -p "require('./node_modules/@pipelex/mthds-form/package.json').version"`
3. The latest published version: `npm view @pipelex/mthds-form version`
4. Working tree status (`git status --short`)
5. Whether either package is a local tarball: `make local-status` (see this repo's `CLAUDE.md` § "Local package development"). The installed version cannot answer this, because a local build carries the version it will be published as.

**If `make local-status` reports `local`**, a bump should target the _published_ package, not whatever's on disk from local development — tell the user and offer `make use-published-form` first (or `make use-published` when the SDK is local too, since the kernel-only target refuses then). Both restore the version the lockfile pins and rewrite nothing, so the baseline they give is the one this bump moves from.

If the working tree is dirty, don't stop — this repo's checks (`make all`) don't require a clean tree — but note it, since the diff you produce at the end will sit alongside whatever else is already staged/unstaged. Ask before touching `package.json`/`package-lock.json` if either is already dirty, since your edit will land on top of unrelated in-flight changes to the same files.

## Step 2 — Determine Target Version

If current already equals latest, tell the user there's nothing to bump and stop (unless they name a newer version, published but not yet indexed).

Otherwise use `AskUserQuestion` to confirm the target:

- **Latest (`{npm view version}`)** — the default, recommended path.
- **A specific version** — let the user type one (e.g. pinning to a version between current and latest, or ahead of latest if they published something not yet indexed).

Store the result as `TARGET_VERSION` (no `v` prefix, e.g. `0.3.0`). If it is below what's installed, stop: a downgrade is not a bump. Undoing a release means reading its changelog backwards and reversing its migrations, which no step here does, so a rollback is the user's to plan by hand.

## Step 3 — Read What Changed

You need the kernel's `CHANGELOG.md` entries for every version strictly after the current one, up to and including `TARGET_VERSION`. Get it from whichever source is available, in this order:

1. **Local sibling checkout**, if this workspace has one: `../mthds-form/CHANGELOG.md`, or the same file under the directory `make use-local`'s `SIBLINGS_DIR` names when the checkouts are elsewhere. Fast, no network, and it's the canonical source when present.
2. **GitHub raw**, otherwise: fetch `https://raw.githubusercontent.com/Pipelex/mthds-form/main/CHANGELOG.md` (the repo is `Pipelex/mthds-form`, confirmed via `npm view @pipelex/mthds-form repository.url`). Don't assume the npm tarball ships a `CHANGELOG.md`.

Extract the entries between `## [v{CURRENT}]` (exclusive) and `## [v{TARGET_VERSION}]` (inclusive) and present them to the user, grouped by version, newest first.

**This changelog marks a breaking change with `(Breaking)` at the end of a bullet's bold title**, and flags other impact in prose — "visible on the wire", a changed default. Every `(Breaking)` bullet needs a verdict here: where it reaches this repo, or the search that shows it does not. The marker narrows the reading without replacing it, because a change that breaks no kernel API can still reach one of this repo's seams — so read each bullet against the seams this repo actually consumes, and call out every bullet that touches one:

- **The gate and readiness** — the two halves of one rule set, and the seam this repo leans on hardest. The server half is `src/lib/runInputs.ts`, which imports `gateRunInputs`, `getPipeIOContract`, `getPipeInputForm` and `describeValidationError`, plus the types `PipeIOContract`, `PipeIOContracts`, `InputForm`, `PipeInputFormDescriptor`, `RunInputsGateResult`, `Translate` and `ValidationMessageKey`; `requireContract` and `requireInputForm` are this repo's own throw-on-miss wrappers over the two lookups, not kernel exports. The browser half is `src/hooks/useRunInputs.ts`, which imports `fieldsForContract`, `computeReadiness` and `rjsfDataFromRunValues`. A semantics change on either side is what the browser/server invariant test (`src/lib/runInputs.test.ts`) exists to catch.

  Two things about this seam are worth knowing before you read the changelog against it. **`gateRunInputs` is a single call on purpose** — this repo must never re-assemble it from the kernel's lower-level steps, because the emptiness step is where such assemblies go wrong (`inputMustBeFilled` + `isFilled` agrees on every field kind the committed methods produce and diverges on a structured concept); if a release splits or renames it, that is a "needs manual review" item, never a mechanical rewiring. And **`ValidationMessageKey` fails loudly by design**: `VALIDATION_MESSAGES` in `runInputs.ts` is typed `Record<ValidationMessageKey, …>`, so a release that adds a message key breaks `make typecheck` here rather than rendering `undefined`. That is the seam working — the fix is to add this repo's English wording for the new key, not to loosen the type.

- **The wire format** — anything the changelog marks "visible on the wire" changes what the Server Action sends to the API. Unit tests mock the SDK, so only e2e sees this (Step 6).
- **The React controls** — `src/components/RunInputsForm.tsx` is the one composition: `isFilled` and the `RunField` type from the core entry, and `FieldRenderer`, `FieldPresentationProvider`, `OptionalToggle` and the `FieldEnv` type from `@pipelex/mthds-form/react`. The file seam is `src/hooks/useFileInputs.ts` (`setValueAtPath`), which every form with a file input composes. Rendering changes can also break test selectors: labels come from `humanizeFieldName`, and this repo's tests query by role plus name.

  One cross-package detail worth knowing before a minor bump: `src/lib/fileInputs.ts` takes its `PipeInputFormDescriptor` and `InputFormItem` types from **`@pipelex/sdk`**, while `src/lib/runInputs.ts` takes `PipeInputFormDescriptor` from the kernel. That is not two descriptions of one artifact — both packages `export * from "mthds/protocol"`, and both declare the same `mthds` range, so npm dedupes to one copy and the two imports resolve to the _same_ type. The hazard is that dedupe failing: if a kernel release moves to an `mthds` minor the installed SDK's range does not cover (npm treats a leading `0` as the major, so `^0.25.0` and `^0.26.0` do not overlap), npm installs two copies and the same-named type becomes two incompatible types. `make typecheck` then fails where `fileInputs.ts` is handed a descriptor derived on the kernel side, with a message that names the type twice and explains nothing. `npm ls mthds` is the one-line diagnosis, and the cure is bumping `@pipelex/sdk` in the same commit.

- **Theming and Tailwind** — `src/app/layout.tsx` imports `@pipelex/mthds-form/theme.css`, and `src/app/globals.css` (Tailwind v4 is configured in CSS; there is no `tailwind.config.ts`) keeps a **mirror of the kernel's own `src/styles/tailwind-entry.css` token block** as an `@theme inline` mapping (the shadcn semantic colors and radii) plus `@source "../../node_modules/@pipelex/mthds-form/dist"`. A release that adds tokens, changes the form a token value takes, or moves the CSS entry points needs that mirror re-synced by hand — nothing automated catches it. A release that moves the kernel's own Tailwind major is the loudest case: 0.8.0 did, and a host on the previous major compiles the renamed utilities to nothing rather than failing.
- **The generated contracts types** — every `src/generated/*/contracts.ts` imports `InputForm`, `OutputForm` and `PipeIOContracts` from the kernel. That import line is written by this repo's own generator, `renderContracts` in `scripts/lib/shared.mts`, around the payload the engine returns, and the recorded contracts under `src/test/fixtures/contracts/` carry the same line. So a release that renames one of those types is a mechanical migration of `renderContracts` and the recorded copies (Step 4), followed by `npm run codegen` to rewrite `src/generated/`, which is **never hand-edited** (see "Generated types" in this repo's `CLAUDE.md`). A release that reshapes what a type describes is different: the payload comes from the engine, so that is a "needs manual review" item. `scripts/lib/scaffold-tree.test.mts` type-checks freshly emitted trees against the installed kernel, so `make test` surfaces either case.

Everything else (internal refactors, non-breaking additions, docs) is FYI only — mention briefly, don't dwell.

## Step 4 — Apply What's Mechanical

For each bullet that renames an identifier written as `` `oldName` `` → `` `newName` `` (an export, an option, a CSS entry point):

1. Grep the **whole repo** for the old name — don't scope this to `src/` only. Kernel names leak into `README.md`, `CLAUDE.md`, `docs/input-form.md`, `docs/adopt-in-an-existing-project.md`, test files, and `src/app/globals.css` comments, not just the runtime import sites. Two places to leave alone: `CHANGELOG.md`'s **already-dated release entries** (`## [vX.Y.Z] - YYYY-MM-DD` — a historical record; Step 7 adds this change's entry), and **anything under `src/generated/`** — if the old name appears there, that tree needs `npm run codegen` after the bump (Step 6), never an edit.
2. **If found**: this repo needs the migration. Apply it with `Edit`, then show the diff. This matches the workspace's "no backward-compatibility shims — just change it" principle.
3. **If not found**: say so and move on — this repo is already using the new name (or never used the old surface), nothing to do.
4. **Run `make format` right after any rename**, before moving on. A literal find-and-replace changes string lengths, and this repo's Prettier config re-flows Markdown tables to keep columns aligned — a raw rename inside a `README.md` table will fail `make format-check` purely on column padding, which reads as a confusing false alarm if you hit it without knowing the rename caused it.

Not every impactful change is a mechanical rename — most of this kernel's changelog is behavior: a gate that prunes differently, a wire shape that changed, a control that renders differently. **Never guess at those.** List them clearly as a "needs manual review" checklist and let the user decide how (or whether) to adapt this repo's code before continuing. If any of these are unresolved and would break `make all`, say so explicitly — better to surface that now than have Step 6 fail with a confusing error.

## Step 5 — Apply the Version Bump

1. Run `npm install @pipelex/mthds-form@{TARGET_VERSION}`. It rewrites the `"@pipelex/mthds-form"` line in `package.json` to `"^{TARGET_VERSION}"`, keeping the caret-pin style, and locks `TARGET_VERSION` itself. Editing the range by hand and running a bare `npm install` would lock the highest release that range admits instead, which is later than `TARGET_VERSION` whenever a patch release followed it — and Step 3 read the changelog only as far as `TARGET_VERSION`. Don't add `--package-lock-only`: this needs the actual new package contents in `node_modules` (the `@source` directive and the CSS imports read the installed `dist/`, not the manifest).
2. Confirm it landed: `node -p "require('./node_modules/@pipelex/mthds-form/package.json').version"` should now read `TARGET_VERSION`.

## Step 6 — Run Checks

Run `make all` (lint + format-check + typecheck + unit tests + build, per this repo's `CLAUDE.md`). The unit suite includes the browser/server invariant table (`src/lib/runInputs.test.ts`) and the form/hook tests over the kernel's real derivation — this is where a readiness or gate semantics change surfaces.

- **On success**: report and continue.
- **On failure**: show the errors. If they trace back to one of the "needs manual review" items from Step 4, connect the dots for the user rather than just dumping the error. Ask how to proceed (fix, skip, abort) — don't guess at a fix for a behavior change you flagged as needing human judgment.

Then, conditionally:

- **If any changelog entry is wire-visible or touches the gate**, offer `make test-e2e`. The wire shape a run submits only travels form → Server Action → live API on the e2e path; unit tests mock the SDK and can pass while the API rejects the new shape. It costs an LLM call per run and needs `PIPELEX_API_KEY`, so only run it with explicit user approval.
- **If any changelog entry touches the controls, `styles.css`/`theme.css`, or Tailwind classes**, the deterministic purge check now runs in `make test` as `src/app/globals.test.ts` (it compiles the stylesheet with and without the `@source` lines and requires the difference; `docs/input-form.md` explains why a class-name grep cannot serve here). Confirm it passed, then offer `make dev` for a visual pass over every method form. A styling regression here is silent: the form still renders, just subtly unstyled.
- **If any changelog entry renames or reshapes a type `contracts.ts` imports** (`InputForm`, `OutputForm`, `PipeIOContracts`), run `npm run codegen` after Step 4 has migrated `renderContracts` (needs `PIPELEX_API_KEY`) and commit the regenerated trees with the bump — never patch `src/generated/` by hand.
- **If the bump changed the kernel's minor, run `npm ls mthds`** and confirm it still reports one deduped copy. Two copies mean the kernel and `@pipelex/sdk` have drifted onto non-overlapping `mthds` ranges, which splits the shared protocol types — see the React-controls bullet in Step 3. Whether or not `make typecheck` has already failed on it, the fix is to bump `@pipelex/sdk` alongside (the `bump-sdk` skill), not to work around the type.

## Step 7 — Update This Repo's CHANGELOG.md

This repo keeps an `## [Unreleased]` section at the top of `CHANGELOG.md` (see existing entries for the format) — or in the changelog that file points to, when it only points elsewhere. Add or extend a `### Changed` bullet under it, e.g.:

```markdown
- Bumped `@pipelex/mthds-form` to `{TARGET_VERSION}` (was `{OLD_VERSION}`).
```

If the bump changes something a consumer of this template would notice — a form control rendering differently, a wire shape their own API logs would show, a token they may have overridden — add a bullet describing it in this repo's own terms. Don't copy the kernel's changelog wording verbatim; restate it for someone reading _this_ repo's changelog who has never looked at the kernel's.

## Step 8 — Review & Commit

Present a full summary:

- `@pipelex/mthds-form`: `{OLD_VERSION} → {TARGET_VERSION}`
- Files changed: `package.json`, `package-lock.json`, `CHANGELOG.md`, plus any files touched by Step 4's migrations, plus any regenerated `src/generated/` trees from Step 6
- Any unresolved "needs manual review" items from Step 4

Ask the user to confirm. On confirmation:

1. Stage only the files actually touched by this bump — never `git add .` or `git add -A`. If the working tree already had unrelated changes to one of these files (flagged in Step 1), stage hunks carefully or ask the user how to separate them rather than bundling unrelated work into this commit.
2. Commit with message: `Bump @pipelex/mthds-form to {TARGET_VERSION}` (add a short body line if Step 4 applied migrations or Step 6 regenerated trees, naming them).
3. Show the commit result.

Then offer (but do not automatically execute) pushing and opening a PR — target branch `dev` per this repo's `CLAUDE.md`. Wait for explicit approval before either.

## Rules

- Never use `git add .` or `git add -A` — stage only the files this bump actually touches.
- Never push or create PRs without explicit user approval.
- Never guess at a fix for a non-mechanical change (gate semantics, wire shapes, rendering) — flag it and let the user decide.
- Never edit `src/generated/` — a kernel change that reaches those trees goes through `npm run codegen`.
- Don't assume the sibling `../mthds-form` checkout exists — always have the GitHub-raw fallback ready.
- If any step fails or the user wants to abort, stop immediately — do not continue the workflow.
