---
name: bump-mthds-form
description: Move pipelex-method-apps onto a newer published @pipelex/mthds-form — every template that depends on the form kernel, together, from the root of the family. Reads the kernel's changelog for the versions in between, weighs each entry against the seams each template's own bump-mthds-form skill lists, applies mechanical renames, raises the range and refreshes each template's install and lock, runs the root gate (and the live `make create` proof when the release reaches a created project), writes the entry in the root CHANGELOG.md, and carries the work through its ledger item, its worktree, a /rev pass and a pull request to dev. Use when, in pipelex-method-apps or one of its worktrees, someone says "bump mthds-form", "bump the form kernel", "update @pipelex/mthds-form", "move the templates onto mthds-form 0.10", "the form kernel just released", "is there a new mthds-form", or picks up a ledger item asking this repo to move onto a new kernel version. Not for a project created from a template, whose own bump-mthds-form skill is the one to use.
---

# Bump @pipelex/mthds-form across the family

`@pipelex/mthds-form` sits in a template's `package.json` as a pre-1.0 caret range, and npm reads the leading `0` of `^0.9.0` as the major, so a new minor never arrives on its own: somebody raises the range. This skill does that for the whole family, from its root.

**Two skills share this name, and they divide the work.** Each template carries its own `bump-mthds-form` under `<template>/.claude/skills/`. That one travels into every project made from the template, and it is the authority on the template's seams: which files import which kernel exports, and which check catches which kind of change. This skill does not restate them. What it owns is what only the family has — moving every template that depends on the kernel in one change, the root gate, the root changelog, and the workspace's path from a ledger item to a merged pull request. Where the two skills differ on those, follow this one: a template's skill is written for a project that has no family, no ledger and no worktrees, so its commit and changelog steps do not apply here.

## Step 1 — Read the state

Reading is free in the main checkout, so this step and the next two run wherever the session stands.

The templates are the names in `TEMPLATES` in the root `Makefile` (`sed -n 's/^TEMPLATES := //p' Makefile`), and the ones this skill moves are those whose `package.json` lists `@pipelex/mthds-form` — a template in another language never will. For each of them, show the range, what is installed, and where it was installed from:

```bash
node -p "require('./<template>/package.json').dependencies['@pipelex/mthds-form']"
node -p "require('./<template>/node_modules/@pipelex/mthds-form/package.json').version"
```

`make local-status` at the root covers the last of these for every template at once.

Then, once, the latest published version: `npm view @pipelex/mthds-form version`.

- **`make local-status` reports a package as `local`**: the template is running a tarball packed from a workspace checkout, which a bump must not be measured against — and the version cannot show it, since a local build carries the published version string. `make use-published-form` at the root restores the kernel the lockfile pins in every template, and refuses while the SDK is local too, in which case `make use-published` restores both. Neither rewrites a manifest, so the baseline they give is the one this bump moves from.
- **The templates are on different versions**: they move to one version together here, and the lowest of them sets where the changelog reading in Step 3 starts.
- **Every template is already on the latest**: say so and stop, unless the user named another version.

## Step 2 — Pick the target

The target is the latest published version unless the invocation named another, so do not ask when there is no choice to make. A named version may be ahead of what `npm view` reports (published but not yet indexed) or behind it, as long as no template has already installed something newer. A version below what a template has installed is a downgrade, and a downgrade is not a bump: say so and stop. Undoing a release means reading its changelog backwards and reversing its migrations, which none of these steps does, so a rollback is planned by a person. Call it `TARGET`, without a `v`.

## Step 3 — Read what changed, against each template's seams

Read the kernel's `CHANGELOG.md` from the workspace's checkout, `../mthds-form/CHANGELOG.md` — the same relative path from a worktree, since worktrees sit flat at the workspace root. A checkout with no `## [v<TARGET>]` heading is behind: pull it, or read `https://raw.githubusercontent.com/Pipelex/mthds-form/main/CHANGELOG.md`. Take every version after the installed one, up to and including `TARGET`. Versions are headed `## [vX.Y.Z] - YYYY-MM-DD`, and a section heading may carry a subtitle (`### Changed - the fixture harness runs pipes on the hosted API`). Skip `## [Unreleased]`: nothing in it is published.

Then, for each template, read the seams its own `bump-mthds-form` skill lists and hold every entry against them.

- **`(Breaking)` at the end of a bold entry title is the kernel's breaking marker**, the workspace's changelog convention. Every such entry needs a verdict for each template: where it reaches the template, or why it does not, with the search that showed it. The 0.9.0 bump is the model: `FieldStrings` gained two members, and a search of `src/` and `scripts/` showed that the template supplies no `FieldStrings` object at all, so the change reached nothing.
- **An entry without the marker can still reach a seam.** A new `ValidationMessageKey`, a token the Tailwind mirror lacks and a rendering change a test selector depends on are all non-breaking for the kernel and still land here, so the marker narrows the reading without replacing it.

Present the entries newest first with the verdicts beside them. List every behavior change — a gate that prunes differently, a wire shape, a control that renders differently — as needing review by the user, because nobody should migrate one by guessing.

## Step 4 — Find the ledger item and make the worktree

Every change here lands through a ledger item and a worktree: the ledger's guard refuses edits in the main checkout, and `/ledger-land` refuses to land a topic branch that names no item.

1. **Look before filing**: `ledger similar "bump mthds-form <TARGET>" --repo pipelex-method-apps`. The kernel's release files its consumers' bumps by hand, beside its own release item, so one is often waiting — titled like "Move the web app template onto @pipelex/mthds-form 0.9.0".
2. **If there is none, file one**: `ledger new --owner pipelex-method-apps --type task --complexity trivial --topic bump-mthds-form-<TARGET without dots> --title "Move the templates onto @pipelex/mthds-form <TARGET>" --gist "bump mthds-form to <TARGET>"`. Raise the complexity when Step 3 found migrations.
3. **Make the worktree**: `wt add --for <id>` creates `_pipelex-method-apps--<topic>` on `feature/<Topic>` and runs `make install` there, so its `node_modules` hold the published packages. Move into it and run `ledger claim <id> --renew`. A session already in that worktree only renews the claim.

Everything from here on runs in the worktree.

## Step 5 — Move each template

In each template this skill moves:

1. **Apply the mechanical renames first.** For an entry that renames an identifier or an entry point (`` `old` `` → `` `new` ``), search the whole template for the old name, not only `src/`. Kernel names also appear in docs, tests, comments, and in code the scaffold emits, which lives as text under `scripts/lib/`. In `webapp-js`, `renderContracts` in `scripts/lib/shared.mts` writes the kernel import at the top of every generated `contracts.ts`, and the recorded contracts under `src/test/fixtures/contracts/` carry the same line. Leave the dated entries of any `CHANGELOG.md` alone. Afterwards, run `make format` in the template, because a rename inside a Markdown table changes its column padding.
2. **Install the target exactly, inside the template**: `npm install @pipelex/mthds-form@<TARGET>`. It raises the range to `"^<TARGET>"`, keeping the caret, and locks `TARGET` itself. Raising the range by hand and running a bare `npm install` would lock the highest release the range admits instead, which is later than `TARGET` whenever a patch release followed it, and Step 3 read the changelog only as far as `TARGET`. Nor is `make lock` enough: the stylesheet's `@source` line and the CSS imports read the installed `dist/`, so the gate needs the package itself and not only the lock. Confirm that the second `node -p` line from Step 1 now reads `TARGET`.
3. **When the minor moved, run `npm ls mthds`** and confirm it still shows one deduplicated copy. Two copies mean the kernel and `@pipelex/sdk` now ask for `mthds` minors that do not overlap, which splits the protocol types they share. The cure is raising `@pipelex/sdk` in the same change, as the template's `bump-sdk` skill describes, never a cast.

A migration applied to a file the template shares with the gallery it was extracted from, `pipelex-starter-js`, is owed there too, as `webapp-js/docs/chrome-lineage.md` describes. Check whether the kernel's release already filed the gallery's own bump, and file a twin item against `pipelex-starter-js` when it did not.

## Step 6 — Run the gates

At the root of the worktree, run `make all`: the family's own checks, then each template's `check` (lint, format check, type check, offline codegen check), `test` and `build`. When iterating on a failure, `make agent-test` runs the tests alone and stays quiet on success. In `webapp-js`, the tests that a kernel bump most often turns red are these:

- `src/lib/runInputs.test.ts`, the browser/server invariant table over recorded contracts, where a change to readiness or the gate surfaces;
- `src/app/globals.test.ts`, the stylesheet purge check, where a change to the controls' classes or the theme surfaces;
- `scripts/lib/scaffold-tree.test.mts`, which scaffolds a method of each source kind into a copy of the template from recorded API responses and type-checks what was emitted against the kernel now installed, where a renamed export that emitted code imports surfaces.

On a red gate, connect the failure to the Step 3 entry that caused it before proposing a fix. A red type check on `VALIDATION_MESSAGES` is the seam working as designed: a new message key needs this template's English wording, not a looser type.

A template ships no method, so one proof lives outside `make all`. **Run the live `make create` proof** when `PIPELEX_API_KEY` is set and Step 3 found an entry that reaches the controls, the theme or its tokens, the gate, or the contract types. The offline scaffold test type-checks what is emitted, but it renders no form and replays responses recorded from an earlier engine. The live run scaffolds from today's engine, runs `make all` inside the new project, and serves a page with a real form on it. Follow `webapp-js/docs/ci.md`, section "The live half of the proof for `make create`": fresh copies of the template, never the worktree itself, discarded afterwards. It spends no model call. When there is no key, say that the proof was skipped and which entry made it relevant.

`make test-e2e` inside a template proves nothing about a kernel bump: the template's only spec renders a home page that has no form on it.

## Step 7 — Write the root changelog entry

The family has one changelog, `CHANGELOG.md` at the root, and a template's own `CHANGELOG.md` only points at it. Under `## [Unreleased]`, in `### Changed`, add one bullet in the workspace's shape: a bold title naming the surface, `(Breaking)` at its end only when someone making an app from the template has to act, then what that person now sees. Create either heading when it is missing. Restate the kernel's entries in this repo's terms instead of copying them, and leave out whatever reaches no template. The entry for 0.9.0 is the model:

```markdown
- **The web app template runs on `@pipelex/mthds-form` 0.9.0**: a nested record in a result table is named by its first text field instead of printing its JSON, a value that wraps in a record's label-and-value rows aligns left while a one-line value still ends at the right edge, and a file a form holds as a `data:` URL shows its format and size rather than its base64. The kernel's `./generative` entry comes with it.
```

When `[Unreleased]` already says a template runs on an earlier kernel version that this repo never released, edit that bullet so it names `TARGET` and describes the combined change, instead of adding a second bullet. A changelog entry never carries a ledger id.

This skill does not touch `VERSION` or any manifest's `version` field: those move only in a release of the family, which is `/release`.

## Step 8 — Commit, review, and open the pull request

1. **Commit in the worktree, staging by name**: `CHANGELOG.md`, each moved template's `package.json` and `package-lock.json`, and whatever the migrations and `make format` touched. The root pre-commit hook runs each touched template's own hook, which formats that template's staged files; never pass `--no-verify`. A message such as `Bump @pipelex/mthds-form to <TARGET>` is enough, since the pull request's title is what survives the squash.
2. **Record the readings on the item** with `ledger note <id> "…"`: what `make all` reported, each `(Breaking)` verdict, and whether the live proof ran. Whoever lands the branch has none of this session's context.
3. **Run `/rev`.** It derives the review depth from the diff and the item, and no topic branch merges into `dev` without a recorded pass. A range and lock move with no migration usually resolves to the lightest profile.
4. **Ask before pushing and opening the pull request**, since both are visible to others. The pull request targets `dev`. Its title is `<branch> · L-<id>`, adding ` — <gist>` only when the gist says something the branch name does not. Its body is two or three sentences on what moved and the `(Breaking)` verdicts, then `Closes L-<id>`. Pull request #14, which moved the template onto 0.9.0, is the model.
5. **After the merge**, `/ledger-land` closes the item. This skill never merges.

## Rules

- Stage files by name; never `git add .` or `git add -A`.
- Never push, open a pull request or merge without the user's explicit yes.
- Flag a behavior change for the user rather than migrating it by guess.
- Measure the gates against the published package, never against a `make use-local` tarball.
- Stop as soon as a step fails or the user wants to abort, and say where the work was left: the worktree, the item and its claim.
