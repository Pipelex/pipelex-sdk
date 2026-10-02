# The release model

The repository has one version, and a release ships the packages that changed since they last shipped. This page describes the model and the workflow that carries it out, `.github/workflows/release.yml`, which publishes on the merge of a release into `main` and, on a manual dispatch, publishes a sprint prerelease of `@pipelex/sdk`. The root `/release` skill (`.claude/skills/release/`) cuts a release in the shape of the workspace's release play, and `scripts/release-selection.mjs` computes which packages it ships. The publish workflows of the source repositories were disabled when their trees were copied here, so nothing publishes these packages from there.

## One version, in `VERSION`

The root `VERSION` file holds the repository's version, one line. A release bumps it together with the manifests of the packages it ships, and every reader takes the release's version from it rather than from the manifests, which disagree once a package is held back. Every manifest stays at or below it: a manifest carries the version its package last shipped as, which is never above the repository's.

`VERSION` starts at `0.28.1`, the lowest value at or above every manifest as the packages arrived here: `@pipelex/sdk` 0.28.1, `pipelex-sdk` 0.16.0, the JavaScript starter 0.6.3, the Python starter 0.2.1 and the method apps 0.5.7. It is also the latest version any of these packages has shipped, so it names a release that exists rather than inventing one.

## A release ships the packages that changed

A release is one `release/vX.Y.Z` branch, one pull request into `main` and one `vX.Y.Z` tag, the shape of the workspace's release play. It ships each package whose directory differs from the one at `v<the version its own manifest carries>`, the release it last shipped in, and leaves the others at the version they last shipped. Comparing with each package's own tag rather than the previous release's keeps a package that was held back proposed until it ships, and a package with no such tag in this repository, which is every package before the first release, is always proposed.

The packages a release selects from are the directories: `js/`, `python/`, `starter-js/`, `starter-python/`, and `method-apps/` as one. The method apps count as one package because the initializer packs its templates from the tree as it stands and refuses a version other than the repository's (`method-apps/initializers/js/scripts/pack-templates.mjs`), so the initializer and its templates always ship together, compared over the whole `method-apps/` directory.

The person cutting a release may hold a proposed package back, for instance a template waiting for production to serve a route its new SDK calls, with one exception: a package an open sprint waits on is never held back, because the sprint machinery reads the whole repository as shipped once its release item closes.

`make release-selection` computes the proposal and checks each hold-back. It reads the committed tree at `HEAD`, so an uncommitted change proposes nothing, and it is fed the open sprints' reading, the JSON of `ledger sprint status --remote --json`, on stdin (`SPRINTS=-`), so the script itself asks nothing of the ledger or the network. A sprint waits on a package when a member of the sprint owned by that package's ledger member (`pipelex-sdk/js` and so on) has landed and has not shipped: it is merged and not yet closed, or it is closed and no release of this repository in the same sprint closed after it did, which is how the ledger's own sprint completion reads a member. A landed, unshipped member owned by the repository's root names no directory, so while one stands no package is held back. The first release holds nothing back either, since it starts every package on the shared line. `HOLD="<unit> ..."` names the packages to hold back. The script refuses a hold-back in each of these cases, and of a package that is not proposed, naming the reason, and it refuses a selection of nothing as well.

## What each package's history looks like

Each package keeps its own `CHANGELOG.md`, whose headings are the versions it shipped, so the changelog links on npm and PyPI keep pointing at a history of that package; the family's changelog, `method-apps/CHANGELOG.md`, is the method apps'. There is no root changelog.

The first release ships every package at the shared number, the next minor above the highest version any of them has shipped, so each package starts the shared line at the same version and its changelog entry says why it jumped. After that, a package's own sequence of versions has gaps. When both SDKs ship in one release they carry the same number, which states that they cover the same API.

## Every artifact comes from one commit

The release workflow tags the release's merge commit `vX.Y.Z` before publishing anything, then builds every publish and the starter export from that tag. Each publish is guarded on the registry not already having the version, so a re-run after a partial failure publishes whatever the tagged version still lacks, from the same source, and a fix that needs new code takes a new version.

What a release publishes, for each package whose manifest carries the release's version:

- `@pipelex/sdk` and `@pipelex/create-method-app` on npm, with provenance;
- `pipelex-sdk` on PyPI;
- `starter-js/` and `starter-python/` exported to their template repositories (see [`export.md`](export.md)).

## The release workflow

A push to `main` is a release: the branch flow lets only a `release/vX.Y.Z` pull request merge there, and its `Release version` check has already required `VERSION` to move. `release.yml` runs its jobs in this order, each one deciding through `scripts/publish.mjs` or `scripts/export.mjs`, whose tests are `scripts/publish.test.mjs` and `scripts/export.test.mjs`:

1. **Tag the release.** It reads `VERSION` at the pushed commit and pushes the tag `vX.Y.Z` on that commit. When the tag already names that commit, the run is a re-run and goes on from it. When the tag names another commit, the run fails and publishes nothing: that version was released from that commit, and a push to `main` carrying the same version is not a release, so the workflow never moves a tag and never builds a version from a second commit. A release that failed part-way is finished by re-running its own run, which stands on the tagged commit.
2. **Publish each package, from the tag.** `@pipelex/sdk`, `@pipelex/create-method-app` and `pipelex-sdk` each have a job that checks out `vX.Y.Z`, refuses to go on unless the checkout stands on the tag, and publishes only when the package's manifest carries the release's version, its changelog has the `## [vX.Y.Z]` entry and its registry does not have that version yet. A package held back at the release, or already published by an earlier attempt, makes its job a green no-op. The npm jobs upgrade npm first, since trusted publishing needs npm 11.5.1 or later and `npm ci` in `js/` fails under the npm that Node 22 bundles; the initializer's job packs the templates with `pack-templates.mjs --publish` and runs the family's tests before publishing, as its old workflow did. PyPI is two jobs: one builds the distributions, and the other, the only one holding the `pypi` environment, uploads them.
3. **Create the GitHub Release** `vX.Y.Z`, once no publish job failed, from the changelog entry of each package and starter the release ships, unless it exists already.
4. **Export the starters** that carry the release's version, as [`export.md`](export.md) describes.

The jobs are independent where they can be: the three publishes run side by side, so one failing does not stop the others, and the Release and the export wait for all of them. **A failed run is finished by re-running it**, with "Re-run failed jobs" or "Re-run all jobs": the tag is found where it was put, a package its registry already has is skipped, the GitHub Release is not created twice, and a mirror already exported is skipped. A partial upload to PyPI is completed by re-running the failed upload job, whose upload skips the files PyPI already has. The tests prove the two boundaries a release can stop at: after npm published and PyPI failed, a re-run publishes `pipelex-sdk` alone, from the tagged commit even when `main` has moved on; and after every publish succeeded and the export failed, a re-run publishes nothing and only exports.

`ledger land` verifies a release from the newest run of `release.yml` at the release's merge commit and from the tag on it, which is why nothing else of this workflow may run there: the scheduled comparison of the mirrors lives in its own workflow, `mirrors.yml`, and a sprint prerelease refuses to run from `main`.

### What the registries and GitHub hold for it

- **npm**: `@pipelex/sdk` and `@pipelex/create-method-app` each name this repository and `release.yml` as their trusted publisher, with no environment. Each `package.json` names this repository and its directory, which provenance requires.
- **PyPI**: `pipelex-sdk` names this repository, `release.yml` and the environment `pypi` as its trusted publisher. The environment was created on 2026-10-02 as the old SDK repository's was, with no protection rule and no branch policy.
- **The export App**: its id in the repository variable `MIRROR_EXPORT_APP_ID` and its private key in the secret `MIRROR_EXPORT_APP_PRIVATE_KEY`, installed on both template repositories with write access to their contents and workflows (see [`export.md`](export.md)).

## A breaking SDK change reaches the templates one release later

A template's lockfile must name an SDK version the registry already serves: npm refuses an unpublished version and uv cannot resolve one. So a template cannot adopt a breaking SDK change in the pull request that makes it. The SDK change merges and ships while the templates stay on the SDK they pin, and after the release one follow-up pull request moves every template onto the new SDK, through the root `/bump-sdk` skill, for the next release. The pull requests' checks of each template against the SDK built from the same commit are the early warning: they report such a break on the SDK's own pull request without blocking it.

## Sprint prereleases of `@pipelex/sdk`

A sprint pins an unreleased upstream by its commit, and npm cannot point a git source at a subdirectory, so a sprint pins `@pipelex/sdk` through a prerelease instead (design DB6 of the move into this repository): a manual dispatch of the release workflow publishes it from a chosen commit as `X.Y.Z-sprint.g<full sha>` on the `sprint` dist-tag, so `latest` never moves. `pipelex-sdk` needs no prerelease, since uv takes a git source with a subdirectory, and `@pipelex/create-method-app` needs none, since no project declares it in a manifest.

The dispatch is what the workspace's `wt pin` names when the prerelease it needs is not on npm yet, read from the `prerelease` key of this repository's `.worktree.toml`:

```sh
gh workflow run release.yml --repo Pipelex/pipelex-sdk --ref dev -f sha=<full sha> -f package=@pipelex/sdk -f version=X.Y.Z-sprint.g<full sha>
```

What the dispatch does, in its one job, `sprint-prerelease`:

- **It refuses to run from `main`.** A dispatch from `main` would stand at a release's merge commit beside the release's own run, which is the run `ledger land` reads, so it is dispatched from `dev` or a topic branch. The scripts that decide come from the branch dispatched; the package is built from the commit asked for, checked out beside them.
- **It publishes a pushed commit only**: `sha` must be a full 40-character SHA on a branch of this repository, so a commit only a fork's pull request carries is never published under the package's name.
- **Its version is computed, never chosen**: `X.Y.Z` is the next patch above the version `js/package.json` carries at that commit, refused unless that version is a plain `X.Y.Z`, which is the rule `wt pin` applies to compute the same string. A `version` input other than the one computed is refused, and so is any `package` but `@pipelex/sdk`.
- **It is guarded on the registry**: a prerelease npm already has is not published again, so a second dispatch at the same commit is a green no-op.
- **It publishes without provenance.** An npm provenance attestation names the commit the workflow ran at as the package's source, and a dispatch runs at the head of the branch dispatched, not at the commit it builds, so the attestation would name the wrong source. The version itself names the commit built. The releases keep their provenance.

GitHub dispatches a workflow only once its file is on the default branch, `main`, so the first prerelease can be dispatched once the first release has brought `release.yml` there.
