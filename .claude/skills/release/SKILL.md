---
name: release
description: >
  Cut a release of pipelex-sdk, the repository that ships @pipelex/sdk and
  @pipelex/create-method-app on npm, pipelex-sdk on PyPI and the two starter
  template repositories under one version: the package selection, a tested
  script fed the open sprints' reading, then the release/vX.Y.Z worktree, the
  bump of the root VERSION and of each selected package's manifest and
  lockfile, one changelog entry per shipped package, the gates, one commit,
  and a pull request to main. Use when the user says "release", "cut a
  release", "bump version", "prepare a release", "make a release", "ship it",
  "create release branch", "promote dev to main", "publish the SDK", "release
  the starters", "which packages ship", or any variation of shipping a new
  version of the SDKs, the starters or the method apps. Changelog content
  passed inline ("/release Added a typed run source to the JS SDK") becomes
  the entry of the package it names. The merge is landed by /ledger-land,
  never by this skill.
---

# Releasing pipelex-sdk

The procedure is the workspace release play, [`docs/workspace/releasing.md`](../../../../docs/workspace/releasing.md) at the workspace root — `../docs/workspace/releasing.md` from this repo's own root, which resolves the same from the main checkout and from any worktree. Read it first, then run it with what follows. The repo key is `pipelex-sdk`, the base is `dev`, and the pull request targets `main`: `ci.yml`'s `Branch flow` job refuses any head into `main` but this repository's `release/vX.Y.Z`. The release worktree is `_pipelex-sdk--release`, made with `wt add pipelex-sdk release --branch release/vX.Y.Z`. Its `make install` wires the git hooks and installs no package: each package directory installs itself the first time one of its gates runs.

**Before the pre-flight, check that the release can publish at all.** `git -C <main> cat-file -e origin/dev:.github/workflows/release.yml` must succeed: while the release workflow is not on `dev`, a merge into `main` publishes nothing and cuts no tag, and the next selection, finding no tag, would treat the following release as the first again. The first release also needs the owner's set-up, which no file shows: npm's trusted publishers for both packages registered for `Pipelex/pipelex-sdk`, `release.yml` and the environment `npm`, PyPI's registered for the same repository and workflow with the environment `pypi`, the three environments on the repository with their branch policies (`npm` allowing `main` and `dev`, `pypi` and `mirrors` allowing `main`), and the App that pushes to the mirrors, its id in the repository variable `MIRROR_EXPORT_APP_ID` and its private key in the `mirrors` environment's secret `MIRROR_EXPORT_APP_PRIVATE_KEY`, never a repository secret. Read the environments with `gh api repos/Pipelex/pipelex-sdk/environments/<name>/deployment-branch-policies`, the variable with `gh api repos/Pipelex/pipelex-sdk/actions/variables --jq '.variables[].name'` and the key by its name alone with `gh api repos/Pipelex/pipelex-sdk/environments/mirrors/secrets --jq '.secrets[].name'`, which never prints a value. The key must also be absent from `gh api repos/Pipelex/pipelex-sdk/actions/secrets --jq '.secrets[].name'` and `gh api repos/Pipelex/pipelex-sdk/actions/organization-secrets --jq '.secrets[].name'`: a repository or organization copy reaches a workflow pushed on any branch, while the environment's copy would still make the export work, so nothing else would notice it. The registries' settings only their owner can read. When any of it is missing, stop and say which; it is not the release's to work around.

The repository has one version, the root `VERSION`, and a release ships the packages that changed since they last shipped, at that version, while the others keep the version they last shipped ([`docs/release-model.md`](../../../docs/release-model.md)). The packages are the release units of the root `Makefile`'s `UNITS`: `js`, `python`, `starter-js`, `starter-python`, and `method-apps` as one unit, since the initializer packs the templates as they stand. Which of them ship is computed, not chosen by feel: see **Which packages ship** below, which belongs to the play's step 1.

## What ships

The merge to `main` publishes, through `.github/workflows/release.yml` on the push, each package whose manifest carries the release's version: `@pipelex/sdk` from `js/` and `@pipelex/create-method-app` from `method-apps/initializers/js/` to npm with provenance, and `pipelex-sdk` from `python/` to PyPI; the same workflow then exports each shipped starter to its template repository. It reads the version from the root `VERSION`, tags the merge commit `vX.Y.Z` before publishing anything, and builds every publish and the export from that tag. Each publish is guarded on the registry not already having the version, so a re-run after a partial failure publishes what the tagged version still lacks, from the same tag, and a fix that needs new code takes a new version. It also creates the GitHub Release.

- **The mirrors.** `starter-js/` is exported to `Pipelex/pipelex-starter-js` and `starter-python/` to `Pipelex/pipelex-starter-python`, each as one commit on the mirror's `main` whose tree is the directory at the tag, with the mirror's own `vX.Y.Z` tag. The export job runs after the publishes, refuses a starter whose pinned SDK does not resolve on its registry, skips a mirror whose tag already holds that tree and fails on one whose tag holds another ([`docs/export.md`](../../../docs/export.md)). `mirrors.yml` compares each mirror on a schedule with `v<the starter's manifest version>:<directory>`, so a held-back starter does not alarm it.
- **No template reaches a registry.** The method-app template ships inside the initializer, and the starters ship only through their mirrors.
- **The trusted publishers name the workflow by its file and an environment.** npm's for both packages name `npm` and PyPI's names `pypi`, all bound to `Pipelex/pipelex-sdk` and `release.yml`, so renaming that file, or a publish job's environment, breaks the publishes that name it ([`docs/release-model.md`](../../../docs/release-model.md), "What the registries and GitHub hold for it").
- **The sprint prerelease is not a release.** A manual dispatch of `release.yml` publishes `@pipelex/sdk` from a chosen commit as `X.Y.Z-sprint.g<full sha>` on the `sprint` dist-tag, cuts no tag, never moves `latest`, and runs from `dev` alone, the branch the `npm` environment allows beside `main`, refusing while `dev` stands on a release tag, where its run would stand beside a release's. The play never runs it.

The landing verifies the publish from the run, the tag, the registries and the mirrors:

```bash
gh run list --workflow=release.yml --branch main --limit 3 --json conclusion,headSha,event,url   # the push run whose headSha is the merge SHA: success
git -C <main> fetch --tags --prune origin && git -C <main> tag --list vX.Y.Z                      # the tag, on the merge commit
npm view @pipelex/sdk@X.Y.Z version                                               # when js shipped: X.Y.Z
npm view @pipelex/create-method-app@X.Y.Z version                                 # when method-apps shipped: X.Y.Z
curl -fsS https://pypi.org/pypi/pipelex-sdk/X.Y.Z/json | jq -r .info.version      # when python shipped: X.Y.Z
gh api repos/Pipelex/pipelex-starter-js/commits/main --jq .commit.tree.sha        # when starter-js shipped: git -C <main> rev-parse vX.Y.Z:starter-js
gh api repos/Pipelex/pipelex-starter-python/commits/main --jq .commit.tree.sha    # when starter-python shipped: git -C <main> rev-parse vX.Y.Z:starter-python
gh release view vX.Y.Z -R Pipelex/pipelex-sdk                                     # the GitHub Release and its notes
```

`ledger land` reads the first two lines as this repository's declaration. The rest are the session's to read, for the packages the release shipped, which the pull request body lists: a held-back package has no X.Y.Z on its registry, by design. A run that succeeded beside a tag is not yet proof that every selected package shipped, since the workflow publishes only the manifests that carry `VERSION` and succeeds without the one the bump missed, so read each shipped package's registry answer and each shipped starter's mirror tree before closing the release item.

## Version files and the lock

### Which packages ship

Run the selection during the play's step 1, once the pre-flight has pulled. It only reads, so it runs from the main checkout before the worktree exists, or from the worktree after; it is fed the open sprints' reading on stdin and reads everything else from the committed tree:

```bash
ledger sprint status --remote --json | make -C <main> release-selection SPRINTS=-
```

`scripts/release-selection.mjs` proposes each unit whose directory differs from the one at `v<the version its own manifest carries>`, the release it last shipped in, and a unit with no such tag in the repository, which at the first release is every unit. Its report is a table of the units, each with the version it last shipped as, whether it is proposed and why, and the landed sprint work it carries that no release has shipped yet. `--remote` lets the reading see a member whose pull request merged before its landing closed it; when GitHub cannot be reached, drop it and say so in the summary. `scripts/release-selection.test.mjs` is its contract.

The person cutting the release may hold a proposed unit back, for instance a template waiting for production to serve a route its new SDK calls. Ask once, after showing the report, unless this is the first release. A hold-back goes back through the script, which refuses it when the unit is not proposed, when this is the first release, or when an open sprint has landed, unshipped work in the unit's directory or at the repository's root, since the sprint machinery reads the whole repository as shipped once the release item closes:

```bash
ledger sprint status --remote --json | make -C <main> release-selection SPRINTS=- HOLD="starter-js"
```

The run that settles the selection ends with "The selection stands." A refusal is not a step to work around: ship the unit, or, for root-owned sprint work, follow the cure the refusal names. Never edit the sprint reading or skip the script. The selected units, the held-back ones and the reason for each hold-back go into the release summary and the pull request body. A selection of nothing is a refusal too, and it ends the release there.

### The number

- **The first release** ships every unit at the number the selection's report prints, the next minor above the highest version any package has shipped: 0.29.0, since `@pipelex/sdk` is at 0.28.1 ([`docs/release-model.md`](../../../docs/release-model.md)). The play's bump question is not asked.
- **Every later release** takes the play's bump question from `VERSION`. A `(Breaking)` entry in the `[Unreleased]` section of any selected package makes it a minor, under the pre-1.0 rule. A held-back package's entries do not count, since they do not ship.

### The files

- **`VERSION`**, one line, no `v`, at every release.
- **`js`**: `js/package.json`'s `version`, and `js/src/version.ts`'s `SDK_VERSION` literal with the same number, which `js/tests/index.test.ts` holds equal to the manifest. The lock is `npm install --package-lock-only` inside `js/`, which rewrites `package-lock.json`'s two version fields without touching `node_modules`.
- **`python`**: `python/pyproject.toml`'s `[project]` `version`, kept the file's first `version = ` line. The lock is `make -C python li`, which re-locks and re-syncs, so that the installed metadata `pipelex_sdk.__version__` reads, and `python/tests/unit/test_version.py` checks, carries the new number.
- **`starter-js`**: `starter-js/package.json`'s `version`. The lock is `make -C starter-js lock`.
- **`starter-python`**: `starter-python/pyproject.toml`'s `[project]` `version`, kept the file's first `version = ` line, since `[tool.uv]`'s `required-version` also contains that text. The lock is `make -C starter-python li`.
- **`method-apps`**: both `method-apps/webapp-js/package.json` and `method-apps/initializers/js/package.json`, at one number, which `make check-versions` and the initializer's `pack-templates.mjs` both require. The lock is `make -C method-apps lock`, which re-locks every template; the initializer has no lockfile.
- **A held-back unit's files are not touched.** Its manifest keeps the version it last shipped, which `make check-versions` accepts below `VERSION`, and `release.yml` publishes only a manifest that carries `VERSION`: a held-back manifest bumped by mistake is published.
- **Also stamped:** nothing else. There is no root changelog and no badge.

## Gates

Run in the worktree, in this order. Each gate of a unit runs only when that unit is selected; a red gate stops the release, and its cure is the code, never a lighter target.

1. **`make check-versions check-workflows test-scripts`** at the root. The cure for a stale twin is `make workflows`, whose output joins the release commit.
2. **`make -C <dir> agent-check` and `make -C <dir> agent-test` for each selected unit**, which installs the directory first when it was never installed, then **`make -C <dir> build`** for `starter-js` and `method-apps`, whose `next build` their tests twins run in CI too. `python` and `starter-python`'s `agent-check` **rewrites files** (ruff's fixes and format, and `plxt fmt` in the starter), and whatever it touched joins the release commit. The method apps' targets cover the family's own files, the initializer and every template.
3. **`/contract-check` when `js` is selected and its wire surface moved since it last shipped.** The baseline is the selection's own tag for `js`, `v<js/package.json's version>`, or, while that tag does not exist in this repository, the import commit `e64f53500b5ba9c6ed0d5b413039eb8b13a7d49e`, whose `js/` is `@pipelex/sdk` 0.28.1 verbatim. `git diff --name-only <baseline> HEAD -- js/src/client.ts js/src/models.ts js/src/product-models.ts js/src/errors.ts js/src/error-models.ts js/src/index.ts` says whether the surface moved. When it did, read `js/.claude/skills/contract-check/SKILL.md` and follow it with that baseline named, never its own default, which takes the newest tag of the whole repository and so skips what a release that held `js` back left unshipped, and with those files in place of the directories its Step 2 lists. The specs it compares against are the workspace root's `docs/specs/`, which is `../../docs/specs/` from `js/`. Its verdict is advisory: a finding is put to the user, and nothing it finds is fixed in the release worktree.
4. **The live checks, when `PIPELEX_API_KEY` is set and the release touched what they cover**: `make -C starter-js codegen-verify` when `starter-js/methods/` moved; and, with the user's approval since each costs a model call, a template's `make test-e2e` when the release touched its SDK call path or its page, as that template's `CLAUDE.md` lists them. The key comes from the directory's `.env.local` or `.env`, which `.worktreeinclude` copies into the worktree.
5. **After the bump and the changelog entries**: `make check-versions check-release-versions`, which requires every manifest at or below `VERSION`, at least one unit at `VERSION`, and a `## [vX.Y.Z]` heading in each shipped unit's `CHANGELOG.md`; and `make -C js agent-test` when `js` shipped and `make -C python agent-test` when `python` shipped, whose version tests are what catch a `SDK_VERSION` left behind or a lock that did not re-sync. Then compare `git diff --name-only` with the selection: no file of a held-back unit may be in it.

## The release commit

Staged by name: `VERSION`; for each shipped unit, its manifest or manifests, its lockfile and its `CHANGELOG.md`; `js/src/version.ts` when `js` ships; the twins `make workflows` rewrote; whatever a unit's `agent-check` rewrote; and a template's `AGENTS.md` when `make test-e2e` rewrote its agent-rules block. Nothing of a held-back unit. The pre-commit hook in `.githooks/` runs each touched template's own lint-staged, which sends a template's staged JSON and Markdown through Prettier, so `starter-js/package.json` and `starter-js/CHANGELOG.md` may be committed reformatted; never reach for `--no-verify`.

## CI on the release pull request

A release pull request changes `VERSION`, which runs every package's jobs, so it meets the whole of `ci.yml` ([`docs/ci.md`](../../../docs/ci.md)):

- **`Branch flow`** — only this repository's `release/vX.Y.Z` may merge into `main`.
- **`Release version`** — `VERSION` is above `main`'s and equals the branch's version, and `make check-release-versions` holds: at least one unit carries `VERSION`, each with its `## [vX.Y.Z]` changelog heading.
- **`Root`** — `make check-versions check-workflows lint-workflows test-scripts`: actionlint over every workflow, `release.yml` among them, and the selection's tests among the scripts'.
- **Every package's lint and tests**, the templates' standalone twins included, inside the two required aggregates `Lint (all)` and `Tests (all)`. The next-SDK twins run beside them and are reported, not required.
- **`cla.yml` and `protect-workflows.yml`**, reported, run from `main`'s copy.

`main`'s ruleset is strict and accepts only a merge commit: a release branch cut while `main` had moved must take `main` in first, and the landing merges with a merge commit. Nothing in CI checks that `[Unreleased]` was folded, or that the bump followed the selection: a held-back manifest bumped by mistake passes every check and is published. Both are this skill's to hold.

## Particulars

- **One entry per shipped package, in that package's own changelog**: `js/CHANGELOG.md`, `python/CHANGELOG.md`, `starter-js/CHANGELOG.md`, `starter-python/CHANGELOG.md`, and the family's `method-apps/CHANGELOG.md`, which covers the initializer and every template; `method-apps/webapp-js/CHANGELOG.md` only points at the family's and is never edited. Each heading is `## [vX.Y.Z] - YYYY-MM-DD`, with the `v`, and each shipped package's `[Unreleased]` is folded into it. There is no root changelog. Changelog content passed inline goes to the package it names; ask when it names none.
- **A held-back package keeps its `[Unreleased]` untouched.** Its entries ship with it at a later release, at that release's number, and fold then.
- **The first release explains the jump.** Every package ships at the shared number, so `pipelex-sdk`, both starters and `@pipelex/create-method-app` jump from the versions they last shipped, while `@pipelex/sdk` takes an ordinary minor. The entry of each package whose number jumps carries a `### Changed` bullet saying that the package now shares one version with the others in `Pipelex/pipelex-sdk`, that its number jumped for that reason alone, and that its later versions may skip numbers; say the same in the pull request body. Later releases need no such note.
- **A breaking SDK change arms one follow-up.** When `js` or `python` ships an entry marked `(Breaking)`, the templates stay on the SDK they pin, since a template's lockfile can name only a published version, and one follow-up moves every template onto the new SDK for the next release, through the root `/bump-sdk` ([`docs/release-model.md`](../../../docs/release-model.md)). File it once the release item exists and the entries are written, blocked by the release item so that the landing readies it, and name it in the release summary:

  ```bash
  ledger new --owner pipelex-sdk --type task --title "Move every template onto the SDK pipelex-sdk vX.Y.Z shipped" --gist "templates onto SDK vX.Y.Z" --blocked-by <release item> --discovered-from <release item>
  ```

  The next-SDK checks on the SDK's pull request already reported what the templates have to change; read their runs into the item's body.
- **Consumers outside this repository move on their own.** A JavaScript consumer pins `@pipelex/sdk` as a pre-1.0 caret range, which npm never resolves across a minor, and a Python consumer pins `pipelex-sdk` as its lock resolved it, so a minor SDK release reaches them only when somebody moves their pin. `ledger.toml` declares no `release_followups` for this repository: when a shipped SDK's changes are ones a consumer needs, file the bump against that consumer, blocked by the release item. From this repository's root, `grep -l '"@pipelex/sdk"' ../*/package.json` and `grep -l 'pipelex-sdk' ../*/pyproject.toml` list them.
- **No pre-release form.** `Branch flow` accepts only `release/vX.Y.Z`, and `release.yml`'s tag job refuses a `VERSION` that is not a plain `X.Y.Z`, publishing nothing. Ship a plain `X.Y.Z`; the sprint prerelease is the dispatch's.
- **The upstream floors are not the release's business.** `js/package.json`'s `mthds` range and `python/pyproject.toml`'s exact `mthds==` pin are moved by each SDK's own `bump-mthds` skill, and the templates' SDK and form-kernel pins by the root's `/bump-sdk` and `/bump-mthds-form`, each landing on `dev` before a release. Read where `python`'s `mthds` pin stands before recommending the bump: it must name a version on PyPI, and `pipelex` pins `mthds` exactly too.
- **Measure the gates against the published packages.** A template's `make use-local` installs a sibling's packed tarball `--no-save`, so a green gate proves only that the sibling works; a worktree freshly provisioned by `wt add` holds the published versions, which is the state to release from.
- **A template's skills are never run here**, its `bootstrap` above all, which turns the template into a person's project.
- **The selection reads only this repository's sprint members.** A member owned by `pipelex-sdk` or one of its members counts; one still owned by a source repository's key, `pipelex-sdk-js` and the like, is another repository to the ledger and does not.
