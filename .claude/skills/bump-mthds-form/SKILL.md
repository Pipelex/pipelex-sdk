---
name: bump-mthds-form
description: Move every template of pipelex-sdk that depends on the form kernel (starter-js and method-apps/webapp-js) onto a newer published @pipelex/mthds-form, together, from the repository root. Reads the kernel's changelog for the versions in between, weighs each entry against the seams each template's own bump-mthds-form skill lists, applies mechanical renames, raises the range and refreshes each template's install and lock, records the command-line template's wire-format table again, runs each moved template's gate (and the live `make create` proof when the release reaches a created project), writes the entry in each moved package's changelog, and carries the work through its ledger item, its worktree, a /rev pass and a pull request to dev. Use when, in pipelex-sdk or one of its worktrees, someone says "bump mthds-form", "bump the form kernel", "update @pipelex/mthds-form", "move the templates onto mthds-form 0.11", "the form kernel just released", "is there a new mthds-form", or picks up a ledger item asking this repository to move onto a new kernel version. Not for a project created from a template, whose own bump-mthds-form skill is the one to use.
---

# Bump @pipelex/mthds-form across every template

`@pipelex/mthds-form` sits in a JavaScript template's `package.json` as a pre-1.0 caret range, and npm reads the leading `0` of `^0.10.0` as the major, so a new minor never arrives on its own: somebody raises the range. This skill does that for every template that depends on the kernel, from the repository root.

**Two skills share this name, and they divide the work.** Each such template carries its own `bump-mthds-form` under `<template>/.claude/skills/`. That one travels into every project made from the template, and it is the authority on the template's seams: which files import which kernel exports, and which check catches which kind of change. This skill does not restate them. What it owns is what only this repository has — moving every template that depends on the kernel in one change, each package's changelog, and the workspace's path from a ledger item to a merged pull request. Where the two skills differ on those, follow this one: a template's skill is written for a project that has no monorepo, no ledger and no worktrees, so its commit and changelog steps do not apply here.

## The templates on the kernel

| Template | Its own seams |
| --- | --- |
| `starter-js/` | `starter-js/.claude/skills/bump-mthds-form/SKILL.md` |
| `method-apps/webapp-js/` | `method-apps/webapp-js/.claude/skills/bump-mthds-form/SKILL.md` |

A template added later joins this table when its `package.json` lists `@pipelex/mthds-form`. `starter-python` never will, and neither will `method-apps/cli-python`, but the kernel still reaches it: its `lib/wire.py` ports the kernel's payload rules, and a wire-format table recorded from the kernel `webapp-js` installs holds it to them, so moving `webapp-js` moves that table too (Step 5).

## Step 1 — Read the state

Reading is free in the main checkout, so this step and the next two run wherever the session stands.

For each template on the kernel, show the range and the version its lockfile pins. Both are read from tracked files, so they answer in a checkout where the template was never installed:

```bash
node -p "require('./<template>/package.json').dependencies['@pipelex/mthds-form']"
node -p "require('./<template>/package-lock.json').packages['node_modules/@pipelex/mthds-form'].version"
```

Then, once, the latest published version: `npm view @pipelex/mthds-form version`.

- **A template that is installed may be running a local build** (`make local-status` at the repository's root says `local`, after the root's `make use-local`, the family's `make use-local-form` or a template's own): a bump must not be measured against it, and the version cannot show it, since a local build carries the published version string. The root's `make use-published` puts every JavaScript template back on exactly what its lockfile pins, for the kernel and the SDK alike, as `npm ci` in one template does; in the family, `make use-published-form` restores the kernel alone and refuses while the SDK is local too. Never reach for `starter-js`'s `make use-npm` here: it installs both packages at `@latest` and saves them, so a kernel bump would carry an SDK bump nobody read the changelog of.
- **The templates are on different versions**: they move to one version together here, and the lowest of them sets where the changelog reading in Step 3 starts.
- **Every template is already on the latest**: say so and stop, unless the user named another version.

## Step 2 — Pick the target

The target is the latest published version unless the invocation named another, so do not ask when there is no choice to make. A named version may be ahead of what `npm view` reports (published but not yet indexed) or behind it, as long as no template's lockfile already pins something newer. A version below what a template pins is a downgrade, and a downgrade is not a bump: say so and stop. Undoing a release means reading its changelog backwards and reversing its migrations, which none of these steps does, so a rollback is planned by a person. Call it `TARGET`, without a `v`.

## Step 3 — Read what changed, against each template's seams

Read the kernel's `CHANGELOG.md` from the workspace's checkout, `../mthds-form/CHANGELOG.md` — the same relative path from a worktree, since worktrees sit flat at the workspace root. A checkout with no `## [v<TARGET>]` heading is behind: pull it, or read `https://raw.githubusercontent.com/Pipelex/mthds-form/main/CHANGELOG.md`. Take every version after the installed one, up to and including `TARGET`. Versions are headed `## [vX.Y.Z] - YYYY-MM-DD`, and a section heading may carry a subtitle. Skip `## [Unreleased]`: nothing in it is published.

Then, for each template, read the seams its own `bump-mthds-form` skill lists and hold every entry against them.

- **`(Breaking)` at the end of a bold entry title is the kernel's breaking marker**, the workspace's changelog convention. Every such entry needs a verdict for each template: where it reaches the template, or why it does not, with the search that showed it. The 0.9.0 bump is the model: `FieldStrings` gained two members, and a search of `src/` and `scripts/` showed that the template supplies no `FieldStrings` object at all, so the change reached nothing.
- **An entry without the marker can still reach a seam.** A new `ValidationMessageKey`, a token the Tailwind mirror lacks and a rendering change a test selector depends on are all non-breaking for the kernel and still land here, so the marker narrows the reading without replacing it.

Present the entries newest first with the verdicts beside them. List every behavior change — a gate that prunes differently, a wire shape, a control that renders differently — as needing review by the user, because nobody should migrate one by guessing.

## Step 4 — Find the ledger item and make the worktree

Every change here lands through a ledger item and a worktree: the ledger's guard refuses edits in the main checkout, and `/ledger-land` refuses to land a topic branch that names no item.

1. **Look before filing**: `ledger similar "bump mthds-form <TARGET>" --repo pipelex-sdk`. The kernel's release files a consumer's bump only when that consumer is known to need something the release fixes or adds, with `--after-release mthds-form@<TARGET>`, which makes it ready once the kernel's tag lands, so one is rarely waiting.
2. **If there is none, file one**: `ledger new --owner pipelex-sdk --type task --complexity trivial --topic bump-mthds-form-<TARGET without dots> --title "Move the templates onto @pipelex/mthds-form <TARGET>" --gist "bump mthds-form to <TARGET>"`. Own it by a member (`pipelex-sdk/starter-js` or `pipelex-sdk/method-apps`) when one template alone moves, and raise the complexity when Step 3 found migrations.
3. **Make the worktree**: `wt add --for <id>` creates `_pipelex-sdk--<topic>` on `feature/<Topic>`. Its provisioning installs nothing heavy: each template installs itself the first time its checks run. Move into it and run `ledger claim <id> --renew`. A session already in that worktree only renews the claim.

Everything from here on runs in the worktree.

## Step 5 — Move each template

In each template this skill moves:

1. **Apply the mechanical renames first.** For an entry that renames an identifier or an entry point (`` `old` `` → `` `new` ``), search the whole template for the old name, not only `src/`. Kernel names also appear in docs, tests, comments, and in code the scaffold emits, which lives as text under `scripts/`. In `method-apps/webapp-js`, `renderContracts` in `scripts/lib/shared.mts` writes the kernel import at the top of every generated `contracts.ts`, and the recorded contracts under `src/test/fixtures/contracts/` carry the same line. Leave the dated entries of any `CHANGELOG.md` alone. Afterwards, run `make format` in the template, because a rename inside a Markdown table changes its column padding.
2. **Install the target exactly, inside the template**: `npm install @pipelex/mthds-form@<TARGET>`. It raises the range to `"^<TARGET>"`, keeping the caret, and locks `TARGET` itself. Raising the range by hand and running a bare `npm install` would lock the highest release the range admits instead, which is later than `TARGET` whenever a patch release followed it, and Step 3 read the changelog only as far as `TARGET`. Nor is `make lock` enough: the stylesheet's `@source` line and the CSS imports read the installed `dist/`, so the gate needs the package itself and not only the lock. Confirm that the second `node -p` line from Step 1 now reads `TARGET`.
3. **When the minor moved, run `npm ls mthds`** and read how many copies it shows: one deduplicated copy is the goal. Two copies mean the kernel and `@pipelex/sdk` ask for `mthds` minors that do not overlap, which splits the protocol types they share. The cure is moving whichever package lags in the same change, never a cast: raising `@pipelex/sdk` through `/bump-sdk` when the kernel moved past it, or choosing a later kernel when the SDK is the one ahead. When no published release of the lagging package covers the other's range yet (`npm view @pipelex/mthds-form dependencies.mthds` and `npm view @pipelex/sdk dependencies.mthds`), the two copies stay until it does: the bump goes ahead, the gate's type check is what shows whether the types the app passes between the two copies still agree, and each moved package's changelog entry says that `npm ls mthds` lists two copies.
4. **When `method-apps/webapp-js` moved, record the wire-format table again**, from `method-apps/`: `node scripts/record-wire-table.mjs`, with `--experimental-strip-types` on a Node 22 before 22.18. It runs the kernel `webapp-js` now installs over the contract fixtures and rewrites `cli-python/tests/fixtures/wire/`, whose `table.json` names the kernel's version, so the family's `scripts/record-wire-table.test.mjs`, which compares the committed table with the recorder's output byte for byte, keeps `make -C method-apps all` red until the table is recorded again. The re-recorded fixtures are committed with the bump (Step 8); read their diff first. A diff of the kernel's version alone means the kernel sends what it sent. A case whose verdict changed, the inputs it sends or the inputs it reports missing, means the kernel now puts something else on the wire for that value: make `method-apps/cli-python/src/pipelex_method_cli_python/lib/wire.py` agree with it, which `make -C method-apps/cli-python agent-test` checks by replaying the table in `tests/test_wire_table.py`, and say in the changelog entry (Step 7) what the command now sends for that kind of input. The deliberate disagreements `cli-python/docs/cli-kernel.md` lists stay, unless the kernel's change removed their reason.

`method-apps/webapp-js` and `starter-js` share chrome, as `method-apps/webapp-js/docs/chrome-lineage.md` describes, and both live in this repository, so a migration applied to a carried file lands in both in this change.

## Step 6 — Run the gates

Run each moved package's gate from the worktree: `make -C starter-js all`, which runs the template's `check` (lint, format check, type check, offline codegen check), `test` and `build`, and `make -C method-apps all`, which runs the family's own checks first, the formatting of `method-apps/CHANGELOG.md` that Step 7 edits among them, then the same three for every template in the family. When iterating on a failure, `make -C <template> agent-test` runs one template's tests alone and stays quiet on success. Each template's own `bump-mthds-form` skill names the tests a kernel bump most often turns red. On a red gate, connect the failure to the Step 3 entry that caused it before proposing a fix. A red type check on `VALIDATION_MESSAGES` is the seam working as designed: a new message key needs that template's English wording, not a looser type.

`method-apps/webapp-js` ships no method, so one proof lives outside its gate. **Run the live `make create` proof** when `PIPELEX_API_KEY` is set and Step 3 found an entry that reaches the controls, the theme or its tokens, the gate, or the contract types. The offline scaffold test type-checks what is emitted, but it renders no form and replays responses recorded from an earlier engine. The live run scaffolds from today's engine, runs `make all` inside the new project, and serves a page with a real form on it. Follow the section on `webapp-js` in [`docs/live-create-proofs.md`](../../../docs/live-create-proofs.md): fresh copies of the template, never the worktree itself, discarded afterwards. It spends no model call. When there is no key, say that the proof was skipped and which entry made it relevant. In `starter-js`, whose demo methods render real forms, `make test-e2e` is the live proof instead, and it costs a model call, so ask first.

## Step 7 — Write each changelog entry

Each package keeps its own changelog: `starter-js/CHANGELOG.md`, and `method-apps/CHANGELOG.md` for the family's templates, whose own `CHANGELOG.md` only points there. In each moved package's changelog, under `## [Unreleased]`, in `### Changed`, add one bullet in the workspace's shape: a bold title naming the surface, `(Breaking)` at its end only when someone making an app from the template has to act, then what that person now sees. Create either heading when it is missing. Restate the kernel's entries in that template's terms instead of copying them, and leave out whatever reaches no template. When Step 5 changed `cli-python`'s `lib/wire.py`, the family's entry also says what the command-line template now sends for the inputs whose verdict changed. The entry for 0.9.0 is the model:

```markdown
- **The web app template runs on `@pipelex/mthds-form` 0.9.0**: a nested record in a result table is named by its first text field instead of printing its JSON, a value that wraps in a record's label-and-value rows aligns left while a one-line value still ends at the right edge, and a file a form holds as a `data:` URL shows its format and size rather than its base64. The kernel's `./generative` entry comes with it.
```

When `[Unreleased]` already says a template runs on an earlier kernel version that was never released, edit that bullet so it names `TARGET` and describes the combined change, instead of adding a second bullet. A changelog entry never carries a ledger id.

This skill does not touch the root `VERSION` or any manifest's `version` field: those move only in a release of the repository.

## Step 8 — Commit, review, and open the pull request

1. **Commit in the worktree, staging by name**: each moved package's changelog, each moved template's `package.json` and `package-lock.json`, the re-recorded wire-format table and `lib/wire.py` when Step 5 touched them, and whatever the migrations and `make format` touched. The root pre-commit hook runs each touched template's own hook, which formats that template's staged files; never pass `--no-verify`. A message such as `Bump @pipelex/mthds-form to <TARGET>` is enough, since the pull request's title is what survives the squash.
2. **Record the readings on the item** with `ledger note <id> "…"`: what each gate reported, each `(Breaking)` verdict, and whether the live proof ran. Whoever lands the branch has none of this session's context.
3. **Run `/rev`.** It derives the review depth from the diff and the item, and no topic branch merges into `dev` without a recorded pass. A range and lock move with no migration usually resolves to the lightest profile.
4. **Ask before pushing and opening the pull request**, since both are visible to others. The pull request targets `dev`. Its title is `<branch> · L-<id>`, adding ` — <gist>` only when the gist says something the branch name does not. Its body is two or three sentences on what moved and the `(Breaking)` verdicts, then `Closes L-<id>`.
5. **After the merge**, `/ledger-land` closes the item. This skill never merges.

## Rules

- Stage files by name; never `git add .` or `git add -A`.
- Never push, open a pull request or merge without the user's explicit yes.
- Flag a behavior change for the user rather than migrating it by guess.
- Measure the gates against the published package, never against a `make use-local` tarball.
- Stop as soon as a step fails or the user wants to abort, and say where the work was left: the worktree, the item and its claim.
