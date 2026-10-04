---
name: bump-sdk
description: Move every template of pipelex-sdk onto a newer published SDK, together, from the repository root — the JavaScript templates (starter-js, method-apps/webapp-js) onto @pipelex/sdk and the Python template (starter-python) onto pipelex-sdk. Reads the SDK changelogs in js/ and python/ for the versions in between, weighs each entry against the seams the SDK reaches in each template, applies mechanical renames to the app code and to the code the scaffolds emit, raises each requirement and refreshes each template's install and lock, runs each moved template's gate and the live proofs a bump of the API client earns, writes the entry in each moved package's changelog, and carries the work through its ledger item, its worktree, a /rev pass and a pull request to dev. Use when, in pipelex-sdk or one of its worktrees, someone says "bump the sdk", "bump @pipelex/sdk", "bump pipelex-sdk", "move the templates onto the new sdk", "the sdk just released", "is there a new sdk version", or picks up the follow-up a release files after it shipped a breaking SDK change. Not for a project created from a template, whose own bump-sdk skill is the one to use, and not for the form kernel, which is /bump-mthds-form.
---

# Bump the SDK across every template

A template pins the SDK it calls from the registry, never from this tree: `@pipelex/sdk` sits in a JavaScript template's `package.json` as a pre-1.0 caret range, which npm never resolves across a minor because it reads the leading `0` of `^0.28.0` as the major, and `pipelex-sdk` sits in the Python template's `pyproject.toml` as a floor that its `uv.lock` resolves to one version. A template's lockfile must name a version the registry already serves, so a template meets a new SDK only after that SDK is published, and somebody moves it there. This skill does that for every template at once, from the repository root. It is also the follow-up a release files after shipping a breaking SDK change: the release ships the SDK while the templates stay on the SDK they pin, and this skill moves every template onto it for the next release (`docs/release-model.md`).

**Two skills share this name, and they divide the work.** A JavaScript template carries its own `bump-sdk` under `<template>/.claude/skills/`. That one travels into every project made from the template, and it is written for a repository that has one app, one changelog and no monorepo. This skill owns what only this repository has: moving every template in one change, the seam no project has (the code a scaffold emits, which is text here and code only in a created project), each package's changelog, and the workspace's path from a ledger item to a merged pull request. Where the two differ on those, follow this one. A template's own skill is still the reference for which of its files the SDK reaches.

The sibling skill for the form kernel is `/bump-mthds-form`, and the two read the same way on purpose. When both packages need to move in a JavaScript template, do it in one change: their shared `mthds` dependency is why (Step 5).

## The templates and their SDK

| Template | SDK | Manifest | Its own seams |
| --- | --- | --- | --- |
| `starter-js/` | `@pipelex/sdk`, built from `js/` | `package.json` | `starter-js/.claude/skills/bump-sdk/SKILL.md` and its `CLAUDE.md` |
| `method-apps/webapp-js/` | `@pipelex/sdk`, built from `js/` | `package.json` | `method-apps/webapp-js/.claude/skills/bump-sdk/SKILL.md` and its `CLAUDE.md` |
| `starter-python/` | `pipelex-sdk`, built from `python/` | `pyproject.toml` | its `CLAUDE.md`, sections "Architecture" and "Project Structure" |

A template added later joins this table when its manifest lists one of the SDKs.

## Step 1 — Read the state

Reading is free in the main checkout, so this step and the next two run wherever the session stands.

For each JavaScript template, show the range and the version its lockfile pins. Both are read from tracked files, so they answer in a checkout where the template was never installed:

```bash
node -p "require('./<template>/package.json').dependencies['@pipelex/sdk']"
node -p "require('./<template>/package-lock.json').packages['node_modules/@pipelex/sdk'].version"
```

For the Python template, show the floor and the version the lock resolves:

```bash
grep -n '"pipelex-sdk' starter-python/pyproject.toml
grep -A1 '^name = "pipelex-sdk"$' starter-python/uv.lock
```

Then, once per SDK, the latest published version: `npm view @pipelex/sdk version` and `curl -s https://pypi.org/pypi/pipelex-sdk/json | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["version"])'`.

- **A JavaScript template that is installed may be running a local build** (`make local-status` at the repository's root says `local`, after the root's `make use-local` or a template's own): a bump must not be measured against it, and the version cannot show it, since a local build carries the version string it will be published as. The root's `make use-published` puts every JavaScript template back on exactly what its lockfile pins, for the SDK and the form kernel alike, as `npm ci` in one template does. Never reach for `starter-js`'s `make use-npm` here: it installs both `@pipelex/sdk` and `@pipelex/mthds-form` at `@latest` and saves them, so an SDK bump would carry a form-kernel bump nobody read the changelog of.
- **The templates of one SDK are on different versions**: they move to one version together here, and the lowest of them sets where the changelog reading in Step 3 starts.
- **Every template is already on the latest**: say so and stop, unless the user named another version.

## Step 2 — Pick the targets

Each SDK's target is its latest published version unless the invocation named another, so do not ask when there is no choice to make. Both SDKs carry the same number when one release ships them together, but a release may hold one back, so the two targets are read separately. A named version may be ahead of what the registry index reports (published but not yet indexed) or behind it, as long as no template's lockfile already pins something newer. A version below what a template pins is a downgrade, and a downgrade is not a bump: say so and stop. An unpublished version is not a target either, since no lockfile can name it. Call them `JS_TARGET` and `PY_TARGET`, without a `v`.

## Step 3 — Read what changed, against each template's seams

The SDKs' changelogs are in this repository, `js/CHANGELOG.md` and `python/CHANGELOG.md`, and the copy on `dev` holds every version either SDK ever published, those released from its old repository before the move included. Read each one there and take every version after the one the templates pin, up to and including the target; versions are headed `## [vX.Y.Z] - YYYY-MM-DD`, and a version's section does not change once it has shipped. Skip `## [Unreleased]`: nothing in it is published.

**`(Breaking)` at the end of a bold entry title is the SDK's breaking marker**, the workspace's changelog convention. Every such entry needs a verdict for each template on that SDK: where it reaches, or why it does not, with the search that showed it. But the marker narrows the reading rather than replacing it, because the SDK reaches a template three ways and only the first fails a check.

1. **The app's own call path.** Each template's `CLAUDE.md` names the modules that construct the client, wrap its calls, match its error classes and read its results; in a JavaScript template, the list sits beside `make test-e2e`, among the files whose changes earn a live run. Start from those lists rather than from a bare grep, then grep to confirm.
2. **The code a scaffold emits, which is text here and code only in a created project.** Each template has one: `scripts/lib/add-method.mts` in `method-apps/webapp-js` and `scripts/add-method.mts` with its `scripts/lib/` in `starter-js` write a method's Server Action with its `@pipelex/sdk` imports, and `scripts/add_method.py` in `starter-python` writes a Typer command against `pipelex_sdk`. A renamed export reaches those string literals and the recorded fixtures beside them, and type-checking the template alone never sees it, because the emitted text is not compiled here. The scaffold tests that write into a copy and type-check what they wrote are what see it, `scripts/lib/scaffold-tree.test.mts` in `method-apps/webapp-js` among them.
3. **What the docs state about the SDK's surface.** A non-breaking addition can make a sentence false without failing anything, so read the added and changed entries too, against what each template tells a reader it cannot do: grep each template once for `Limitation`, `would need`, `not yet` and `upstream`, and hold each claim against the surface now installed.

Present the entries newest first with the verdicts beside them. List every behavior change — a different default, a changed error shape, a removed method — as needing review by the user, because nobody should migrate one by guessing.

## Step 4 — Find the ledger item and make the worktree

Every change here lands through a ledger item and a worktree: the ledger's guard refuses edits in the main checkout, and `/ledger-land` refuses to land a topic branch that names no item.

1. **Look before filing**: `ledger similar "move the templates onto the sdk <TARGET>" --repo pipelex-sdk`. A release that shipped a breaking SDK change files this follow-up itself, so one is often waiting.
2. **If there is none, file one**: `ledger new --owner pipelex-sdk --type task --complexity trivial --topic bump-sdk-<TARGET without dots> --title "Move the templates onto the SDK <TARGET>" --gist "templates onto sdk <TARGET>"`. Own it by a member (`pipelex-sdk/starter-js` and so on) when one template alone moves, and raise the complexity when Step 3 found migrations.
3. **Make the worktree**: `wt add --for <id>` creates `_pipelex-sdk--<topic>` on `feature/<Topic>`. Its provisioning installs nothing heavy: each template installs itself the first time its checks run. Move into it and run `ledger claim <id> --renew`. A session already in that worktree only renews the claim.

Everything from here on runs in the worktree.

## Step 5 — Move each template

In each template this skill moves:

1. **Apply the mechanical renames first.** For an entry that renames an identifier or an entry point (`` `old` `` → `` `new` ``), search the whole template, not only its sources: the three seams of Step 3 are three different kinds of file, and the second and third are string literals and prose. Leave the dated entries of any `CHANGELOG.md` alone; Step 7 is where this change gets its entry. In a JavaScript template, run `make format` afterwards, because a rename inside a Markdown table changes its column padding and fails `format-check` on alignment alone.
2. **Install the target exactly, inside the template.** In a JavaScript template, `npm install @pipelex/sdk@<JS_TARGET>` raises the range to `"^<JS_TARGET>"`, keeping the caret, and locks the target itself; raising the range by hand and running a bare `npm install` would lock the highest release the range admits instead, which is later than the target whenever a patch release followed it. In `starter-python`, raise the floor in `pyproject.toml` to `"pipelex-sdk>=<PY_TARGET>"`, keeping the comment above it true, then run `uv lock --upgrade-package pipelex-sdk==<PY_TARGET>` and `make install`. The exact pin on the command line matters for the same reason: a bare `--upgrade-package pipelex-sdk` locks the newest release the floor admits, which is later than the target whenever the target is not the latest. Confirm that Step 1's readings now name the target.
3. **In a JavaScript template, when the minor moved, run `npm ls mthds`** and read how many copies it shows: one deduplicated copy is the goal. `@pipelex/sdk` and `@pipelex/mthds-form` both depend on `mthds` for the protocol types they exchange, and two copies mean their ranges no longer overlap, which type-checks as two structurally identical but unrelated types in the one place the app hands a kernel value to the client. The cure is raising the kernel in the same change, through `/bump-mthds-form`, never a cast. When no published kernel covers the SDK's new range yet (`npm view @pipelex/mthds-form dependencies.mthds`), the two copies stay until the kernel's own release: the bump goes ahead, the gate's type check is what shows whether the types the app passes between the two copies still agree, and each moved package's changelog entry says that `npm ls mthds` lists two copies.

`method-apps/webapp-js` and `starter-js` share chrome, as `method-apps/webapp-js/docs/chrome-lineage.md` describes, and both live in this repository, so a migration applied to a carried file lands in both in this change.

## Step 6 — Run the gates

Run each moved package's gate from the worktree: `make -C starter-js all`, which runs the template's `check` (lint, format check, type check, offline codegen check), `test` and `build`; `make -C method-apps all`, which runs the family's own checks first, the formatting of `method-apps/CHANGELOG.md` that Step 7 edits among them, then the same three for every template in the family; and `make -C starter-python agent-check agent-test` for the Python template. When iterating on a failure, `make -C <template> agent-test` runs one template's tests alone and stays quiet on success. On a red gate, connect the failure to the Step 3 entry that caused it before proposing a fix.

In both JavaScript templates, the tests an SDK bump most often turns red are these, at the same paths in each:

- `src/lib/errors.test.ts`, the classification table over the SDK's error classes, where a renamed, removed or re-shaped error surfaces;
- `src/lib/usageReport.test.ts`, the projection of `summarizeUsage`, where the report's own shape surfaces;
- `src/lib/blockingRun.test.ts`, `src/lib/durableRun.test.ts` and `src/lib/wireOutput.test.ts`, the two call paths and the `main_stuff` reading, mocked at `@/lib/pipelexClient` rather than at the package, so a renamed client method surfaces as a type error rather than a green test over a mock that no longer matches anything;
- `scripts/lib/scaffold-tree.test.mts`, which scaffolds a method of each source kind into a copy of the template from recorded API responses and type-checks what was emitted, the only check that sees the second seam of Step 3.

The pull request's CI then runs each moved template's standalone check, which installs the template from the registry with its own lockfile in a folder of its own, exactly as a project made from it would.

**The unit tests mock the client, so no gate can see a change in what the API answers.** The live proofs can, and a bump of the API client is exactly the change that earns them. All need `PIPELEX_API_KEY`; say which ran and which were skipped for want of one.

- **`make test-e2e` inside a JavaScript template** runs the real call path end to end against the configured API. It costs a model call, so ask before running it. Its spend gate reads a terminal, so pass `CONFIRM=1`, and it refuses to reuse a dev server another checkout is holding, so pass the free port its refusal asks for: `CONFIRM=1 APP_PORT=4301 make test-e2e`.
- **The live `make create` proof** in `method-apps/webapp-js` runs its scaffold against today's engine through the SDK and spends no model call. Run it when Step 3 found an entry reaching the scaffold, the codegen kit or the generated tree, following `method-apps/webapp-js/docs/ci.md`, section "The live half of the proof for `make create`".
- **`make codegen-verify`** in each JavaScript template, when the entries mention codegen, locks, crates or the generated tree: the gate re-runs the offline check, while this asks the live engine whether the committed generated trees are still current under the new SDK.
- **The Python template's live tests**, the `pipelex_api` and `inference` markers its `CLAUDE.md` describes, when Step 3 found an entry reaching the Python call path. The `inference` ones cost model calls, so ask first.

## Step 7 — Write each changelog entry

Each package keeps its own changelog: `starter-js/CHANGELOG.md`, `starter-python/CHANGELOG.md`, and `method-apps/CHANGELOG.md` for the family's templates, whose own `CHANGELOG.md` only points there. In each moved package's changelog, under `## [Unreleased]`, in `### Changed`, add one bullet in the workspace's shape: a bold title naming the surface, `(Breaking)` at its end only when someone making an app from the template has to act, then what that person now sees. Create either heading when it is missing. Restate the SDK's entries in that template's terms instead of copying them, and leave out whatever reaches no template — a reader of a template's changelog is making an app, and has never opened the SDK's.

```markdown
- **The web app template runs on `@pipelex/sdk` 0.19.0**: `prepareInputs` now refuses when the API states that it determined no entry pipe, instead of falling back to the closure's `main_pipe`. Nothing changes for a project, because every action the scaffold writes already names its pipe.
```

When `[Unreleased]` already says a template runs on an earlier SDK version that was never released, edit that bullet so it names the target and describes the combined change, instead of adding a second bullet. A changelog entry never carries a ledger id.

This skill does not touch the root `VERSION` or any manifest's `version` field: those move only in a release of the repository.

## Step 8 — Commit, review, and open the pull request

1. **Commit in the worktree, staging by name**: each moved package's changelog, each moved template's manifest and lockfile, and whatever the migrations and `make format` touched. The root pre-commit hook runs each touched JavaScript template's own hook, which formats that template's staged files; never pass `--no-verify`. A message such as `Move the templates onto the SDK <TARGET>` is enough, since the pull request's title is what survives the squash.
2. **Record the readings on the item** with `ledger note <id> "…"`: what each gate reported, each `(Breaking)` verdict, and which live proofs ran. Whoever lands the branch has none of this session's context.
3. **Run `/rev`.** It derives the review depth from the diff and the item, and no topic branch merges into `dev` without a recorded pass. A range and lock move with no migration usually resolves to the lightest profile.
4. **Ask before pushing and opening the pull request**, since both are visible to others. The pull request targets `dev`. Its title is `<branch> · L-<id>`, adding ` — <gist>` only when the gist says something the branch name does not. Its body is two or three sentences on what moved and the `(Breaking)` verdicts, then `Closes L-<id>`.
5. **After the merge**, `/ledger-land` closes the item. This skill never merges.

## Rules

- Stage files by name; never `git add .` or `git add -A`.
- Never push, open a pull request or merge without the user's explicit yes.
- Flag a behavior change for the user rather than migrating it by guess.
- Measure the gates against the published package, never against a local build of `js/` or `python/`.
- Never point a template's manifest or lockfile at the SDK in this tree: a template installs from the registry, which is what a project made from it gets, and the root's `make use-local` is a `--no-save` trial that a bump is never measured against. The pull request's next-SDK checks already test every template against the SDK built from the same commit.
- Stop as soon as a step fails or the user wants to abort, and say where the work was left: the worktree, the item and its claim.
