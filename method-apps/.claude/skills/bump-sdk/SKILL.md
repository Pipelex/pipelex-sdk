---
name: bump-sdk
description: Move pipelex-method-apps onto a newer published @pipelex/sdk — every template that calls the Pipelex API, together, from the root of the family. Reads the SDK's changelog for the versions in between, weighs each entry against the three seams the SDK reaches in a template, applies mechanical renames to the app code and to the code the scaffold emits, raises the range and refreshes each template's install and lock, runs the root gate and the live proofs a bump of the API client earns, writes the entry in the root CHANGELOG.md, and carries the work through its ledger item, its worktree, a /rev pass and a pull request to dev. Use when, in pipelex-method-apps or one of its worktrees, someone says "bump the sdk", "bump @pipelex/sdk", "update the pipelex sdk", "upgrade the sdk", "move the templates onto sdk 0.19", "the sdk just released", "is there a new sdk version", or picks up a ledger item asking this repo to move onto a new SDK version. Not for a project created from a template, whose own bump-sdk skill is the one to use, and not for the form kernel, which is /bump-mthds-form.
---

# Bump @pipelex/sdk across the family

`@pipelex/sdk` sits in a template's `package.json` as a pre-1.0 caret range, and npm reads the leading `0` of `^0.18.0` as the major, so a new minor never arrives on its own: somebody raises the range. This skill does that for the whole family, from its root.

**Two skills share this name, and they divide the work.** Each template carries its own `bump-sdk` under `<template>/.claude/skills/`. That one travels into every project made from the template, and it is written for a repository that has one app, one changelog and no family. This skill owns what only the family has: moving every template that calls the SDK in one change, the seam that exists here and nowhere downstream — the scaffold, which is code as text — the root gate, the root changelog, and the workspace's path from a ledger item to a merged pull request. Where the two differ on those, follow this one.

The sibling skill for the form kernel is `/bump-mthds-form`, and the two read the same way on purpose. When both packages need to move, do it in one change: their shared `mthds` dependency is why (Step 5).

## Step 1 — Read the state

Reading is free in the main checkout, so this step and the next two run wherever the session stands.

The templates are the names in `TEMPLATES` in the root `Makefile` (`sed -n 's/^TEMPLATES := //p' Makefile`), and the ones this skill moves are those whose `package.json` lists `@pipelex/sdk` — a template in another language never will. For each of them, show the range, what is installed, and where it was installed from:

```bash
node -p "require('./<template>/package.json').dependencies['@pipelex/sdk']"
node -p "require('./<template>/node_modules/@pipelex/sdk/package.json').version"
```

`make local-status` at the root covers the last of these for every template at once.

Then, once, the latest published version: `npm view @pipelex/sdk version`.

- **`make local-status` reports a package as `local`**: the template is running a tarball packed from the workspace's `pipelex-sdk-js` checkout, which a bump must not be measured against — and the version cannot show it, since a local build carries the version string it will be published as. `make use-published` at the root restores both `@pipelex` packages at the versions each lockfile pins, and rewrites no manifest, so the baseline it gives is the one this bump moves from.
- **The templates are on different versions**: they move to one version together here, and the lowest of them sets where the changelog reading in Step 3 starts.
- **Every template is already on the latest**: say so and stop, unless the user named another version.

## Step 2 — Pick the target

The target is the latest published version unless the invocation named another, so do not ask when there is no choice to make. A named version may be ahead of what `npm view` reports (published but not yet indexed) or behind it, as long as no template has already installed something newer. A version below what a template has installed is a downgrade, and a downgrade is not a bump: say so and stop. Undoing a release means reading its changelog backwards and reversing its migrations, which none of these steps does, so a rollback is planned by a person. Call it `TARGET`, without a `v`.

## Step 3 — Read what changed, against the three seams

Read the SDK's `CHANGELOG.md` from the workspace's checkout, `../pipelex-sdk-js/CHANGELOG.md` — the same relative path from a worktree, since worktrees sit flat at the workspace root. A checkout with no `## [v<TARGET>]` heading is behind: pull it, or read `https://raw.githubusercontent.com/Pipelex/pipelex-sdk-js/main/CHANGELOG.md`. The published tarball ships `docs/` but no changelog, so `node_modules/@pipelex/sdk/` is not a source for this. Take every version after the installed one, up to and including `TARGET`; versions are headed `## [vX.Y.Z] - YYYY-MM-DD`. Skip `## [Unreleased]`: nothing in it is published.

**`(Breaking)` at the end of a bold entry title is the SDK's breaking marker**, the workspace's changelog convention. Every such entry needs a verdict for each template: where it reaches, or why it does not, with the search that showed it. But the marker narrows the reading rather than replacing it, because the SDK reaches a template three ways and only the first fails a check.

1. **The app's own call path.** The template's `CLAUDE.md` names it twice: the `src/lib/` paragraph, which says which module constructs the client and which ones wrap `execute` / `start` / `getRunStatus` / `getRunResult`, `instanceof`-match the SDK's error classes, project `summarizeUsage`, read `main_stuff`, stream through `fetchArtifact` and mint a link through `resolveStorageUrl`; and the `make test-e2e` line in its shipping checklist, which is that same surface written as a list of paths. Start from those two lists rather than from a bare grep, then grep to confirm.
2. **The code the scaffold emits, which is text here and code only in a created project.** This is the seam the downstream skill has no reason to know about. `scripts/lib/add-method.mts` writes the Server Action a method gets — its `@pipelex/sdk` imports, its `prepareInputs` call with the qualified `pipe_ref`, the options it builds — and `scripts/lib/api.mts` and `shared.mts` drive `validate` and `codegen` through the SDK. A renamed export reaches those string literals and the recorded fixtures beside them (`scripts/lib/fixtures/`, `src/test/fixtures/`), and type-checking the template alone will never see it, because the emitted text is not compiled here. `scripts/lib/scaffold-tree.test.mts` is what sees it, by scaffolding into a copy and type-checking what was written.
3. **What the docs state about the SDK's surface.** A non-breaking addition can make a sentence false without failing anything. 0.18.0 added `RunResults.working_memory`, which turned the template's `CLAUDE.md` "**Limitation:** `RunResults` surfaces only the main output … would need an SDK addition upstream" into a statement about a limitation that had just been lifted. So read the added and changed entries too, against what the template tells a reader it cannot do. And the release that made a sentence false may sit further back than the range in hand — that one survived a whole bump — so grep the template once for what it claims it cannot do (`Limitation`, `would need`, `not yet`, `upstream`) and hold each claim against the surface now installed. The package's own `docs/` pages ship in the tarball since 0.18.2, so `node_modules/@pipelex/sdk/docs/` reads at exactly the version being installed.

Present the entries newest first with the verdicts beside them. The 0.19.0 bump is the model of a verdict that lands on nothing: `prepareInputs` stopped falling back to the closure's `main_pipe` when a validation report states `default_pipe_ref: null`, and `grep -n "pipe_ref" scripts/lib/add-method.mts` showed the scaffold already states the qualified ref on every action it emits, so the change reached neither the template nor any project made from it. List every behavior change — a different default, a changed error shape, a removed method — as needing review by the user, because nobody should migrate one by guessing.

## Step 4 — Find the ledger item and make the worktree

Every change here lands through a ledger item and a worktree: the ledger's guard refuses edits in the main checkout, and `/ledger-land` refuses to land a topic branch that names no item.

1. **Look before filing**: `ledger similar "bump @pipelex/sdk <TARGET>" --repo pipelex-method-apps`. The SDK's release, and the gallery's own bump, file this repo's item by hand, so one is often waiting — titled like "Move pipelex-method-apps/webapp-js's @pipelex/sdk range from ^0.18.0 to ^0.19.0".
2. **If there is none, file one**: `ledger new --owner pipelex-method-apps --type task --complexity trivial --topic bump-sdk-<TARGET without dots> --title "Move the templates onto @pipelex/sdk <TARGET>" --gist "@pipelex/sdk -> ^<TARGET>"`. Raise the complexity when Step 3 found migrations.
3. **Make the worktree**: `wt add --for <id>` creates `_pipelex-method-apps--<topic>` on `feature/<Topic>` and runs `make install` there, so its `node_modules` hold the published packages. Move into it and run `ledger claim <id> --renew`. A session already in that worktree only renews the claim.

Everything from here on runs in the worktree.

## Step 5 — Move each template

In each template this skill moves:

1. **Apply the mechanical renames first.** For an entry that renames an identifier or an entry point (`` `old` `` → `` `new` ``), search the whole template, not only `src/` — the three seams of Step 3 are three different kinds of file, and the second and third are prose and string literals. Leave the dated entries of any `CHANGELOG.md` alone; Step 7 is where this change gets its entry. Afterwards, run `make format` in the template, because a rename inside a Markdown table changes its column padding and fails `format-check` on alignment alone, which reads as a baffling failure if you meet it without knowing the rename caused it.
2. **Install the target exactly, inside the template**: `npm install @pipelex/sdk@<TARGET>`. It raises the range to `"^<TARGET>"`, keeping the caret, and locks `TARGET` itself. Raising the range by hand and running a bare `npm install` would lock the highest release the range admits instead, which is later than `TARGET` whenever a patch release followed it, and Step 3 read the changelog only as far as `TARGET`. `make lock` is not enough either: the gate type-checks against the installed `dist/`, so it needs the package and not only the lock. Confirm that the second `node -p` line from Step 1 now reads `TARGET`.
3. **When the minor moved, run `npm ls mthds`** and confirm it still shows one deduplicated copy. `@pipelex/sdk` and `@pipelex/mthds-form` both depend on `mthds` for the protocol types they exchange, and two copies mean their ranges no longer overlap — which type-checks as two structurally identical but unrelated types, in the one place the app hands a kernel value to the client. The cure is raising the kernel in the same change, through `/bump-mthds-form`, never a cast.

The chrome this template leads is carried by the gallery it was extracted from, `pipelex-starter-js`, as `webapp-js/docs/chrome-lineage.md` describes, so a migration applied to a carried file is owed there too. The SDK's release usually files both bumps at once; check, and file a twin item against the gallery when it did not.

## Step 6 — Run the gates

At the root of the worktree, run `make all`: the family's own checks, then each template's `check` (lint, format check, type check, offline codegen check), `test` and `build`. When iterating on a failure, `make agent-test` runs the tests alone and stays quiet on success. In `webapp-js`, the tests an SDK bump most often turns red are these:

- `src/lib/errors.test.ts`, the classification table over the SDK's error classes, where a renamed, removed or re-shaped error surfaces;
- `src/lib/usageReport.test.ts`, the projection of `summarizeUsage`, where the report's own shape surfaces;
- `src/lib/blockingRun.test.ts`, `src/lib/durableRun.test.ts` and `src/lib/wireOutput.test.ts`, the two call paths and the `main_stuff` reading — mocked at `@/lib/pipelexClient` rather than at the package, so a renamed client method surfaces as a type error rather than a green test over a mock that no longer matches anything;
- `scripts/lib/scaffold-tree.test.mts`, which scaffolds a method of each source kind into a copy of the template from recorded API responses and type-checks what was emitted, the only check that sees seam 2.

On a red gate, connect the failure to the Step 3 entry that caused it before proposing a fix.

**The unit tests mock the client, so `make all` cannot see a change in what the API answers.** Two live proofs can, and a bump of the API client is exactly the change that earns them. Both need `PIPELEX_API_KEY`; say which ran and which were skipped for want of one.

- **`make test-e2e` inside the template** runs `e2e/resultTile.spec.ts`, which creates an app from the template for an image-producing method, runs it against the configured API and checks that the result paints — the real call path, end to end. It costs a model call, so ask before running it. Unlike a kernel bump, where the e2e proves nothing, here it is the point. Two things about invoking it from a session: its spend gate reads a terminal, so pass `CONFIRM=1`, and it refuses to reuse a dev server another checkout is holding rather than silently measuring the wrong app, so pass the free port its refusal asks for — `CONFIRM=1 APP_PORT=4301 make test-e2e`.
- **The live `make create` proof** runs the scaffold against today's engine through the SDK's `validate` and `codegen`, and spends no model call. Run it when Step 3 found an entry reaching the scaffold, the codegen kit or the generated tree. Follow `webapp-js/docs/ci.md`, section "The live half of the proof for `make create`": fresh copies of the template, never the worktree itself, discarded afterwards.
- **`make codegen-verify`** when the entries mention codegen, locks, crates or the generated tree: `make all` re-runs the offline check, while this asks the live engine whether the committed generated trees are still semantically current under the new SDK.

## Step 7 — Write the root changelog entry

The family has one changelog, `CHANGELOG.md` at the root, and a template's own `CHANGELOG.md` only points at it. Under `## [Unreleased]`, in `### Changed`, add one bullet in the workspace's shape: a bold title naming the surface, `(Breaking)` at its end only when someone making an app from the template has to act, then what that person now sees. Create either heading when it is missing. Restate the SDK's entries in this repo's terms instead of copying them, and leave out whatever reaches no template — a reader of this changelog is making an app, and has never opened the SDK's.

```markdown
- **The web app template runs on `@pipelex/sdk` 0.19.0**: `prepareInputs` now refuses when the API states that it determined no entry pipe, instead of falling back to the closure's `main_pipe`. Nothing changes for a project, because every action the scaffold writes already names its pipe.
```

When `[Unreleased]` already says a template runs on an earlier SDK version that this repo never released, edit that bullet so it names `TARGET` and describes the combined change, instead of adding a second bullet. A changelog entry never carries a ledger id.

This skill does not touch `VERSION` or any manifest's `version` field: those move only in a release of the family, which is `/release`.

## Step 8 — Commit, review, and open the pull request

1. **Commit in the worktree, staging by name**: `CHANGELOG.md`, each moved template's `package.json` and `package-lock.json`, and whatever the migrations and `make format` touched. The root pre-commit hook runs each touched template's own hook, which formats that template's staged files; never pass `--no-verify`. A message such as `Bump @pipelex/sdk to <TARGET>` is enough, since the pull request's title is what survives the squash.
2. **Record the readings on the item** with `ledger note <id> "…"`: what `make all` reported, each `(Breaking)` verdict, and which live proofs ran. Whoever lands the branch has none of this session's context.
3. **Run `/rev`.** It derives the review depth from the diff and the item, and no topic branch merges into `dev` without a recorded pass. A range and lock move with no migration usually resolves to the lightest profile.
4. **Ask before pushing and opening the pull request**, since both are visible to others. The pull request targets `dev`. Its title is `<branch> · L-<id>`, adding ` — <gist>` only when the gist says something the branch name does not. Its body is two or three sentences on what moved and the `(Breaking)` verdicts, then `Closes L-<id>`.
5. **After the merge**, `/ledger-land` closes the item. This skill never merges.

## Rules

- Stage files by name; never `git add .` or `git add -A`.
- Never push, open a pull request or merge without the user's explicit yes.
- Flag a behavior change for the user rather than migrating it by guess.
- Measure the gates against the published package, never against a `make use-local` tarball.
- Stop as soon as a step fails or the user wants to abort, and say where the work was left: the worktree, the item and its claim.
