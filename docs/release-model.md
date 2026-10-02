# The release model

The repository has one version, and a release ships the packages that changed since they last shipped. This page describes the model. The machinery that runs it — the release workflow, the root `/release` skill and the dispatch that publishes a sprint prerelease — is the next step of the move into this repository (ledger item L-261001-075fdb) and is not written yet, so nothing in this repository publishes today. The publish workflows of the source repositories were disabled when their trees were copied here, so nothing publishes these packages from there either.

## One version, in `VERSION`

The root `VERSION` file holds the repository's version, one line. A release bumps it together with the manifests of the packages it ships, and every reader takes the release's version from it rather than from the manifests, which disagree once a package is held back. Every manifest stays at or below it: a manifest carries the version its package last shipped as, which is never above the repository's.

`VERSION` starts at `0.28.1`, the lowest value at or above every manifest as the packages arrived here: `@pipelex/sdk` 0.28.1, `pipelex-sdk` 0.16.0, the JavaScript starter 0.6.3, the Python starter 0.2.1 and the method apps 0.5.7. It is also the latest version any of these packages has shipped, so it names a release that exists rather than inventing one.

## A release ships the packages that changed

A release is one `release/vX.Y.Z` branch, one pull request into `main` and one `vX.Y.Z` tag, the shape of the workspace's release play. It ships each package whose directory differs from the one at `v<the version its own manifest carries>`, the release it last shipped in, and leaves the others at the version they last shipped. Comparing with each package's own tag rather than the previous release's keeps a package that was held back proposed until it ships, and a package with no such tag in this repository, which is every package before the first release, is always proposed.

The packages a release selects from are the directories: `js/`, `python/`, `starter-js/`, `starter-python/`, and `method-apps/` as one. The method apps count as one package because the initializer packs its templates from the tree as it stands and refuses a version other than the repository's (`method-apps/initializers/js/scripts/pack-templates.mjs`), so the initializer and its templates always ship together, compared over the whole `method-apps/` directory.

The person cutting a release may hold a proposed package back, for instance a template waiting for production to serve a route its new SDK calls, with one exception: a package an open sprint waits on is never held back, because the sprint machinery reads the whole repository as shipped once its release item closes.

## What each package's history looks like

Each package keeps its own `CHANGELOG.md`, whose headings are the versions it shipped, so the changelog links on npm and PyPI keep pointing at a history of that package; the family's changelog, `method-apps/CHANGELOG.md`, is the method apps'. There is no root changelog.

The first release ships every package at the shared number, the next minor above the highest version any of them has shipped, so each package starts the shared line at the same version and its changelog entry says why it jumped. After that, a package's own sequence of versions has gaps. When both SDKs ship in one release they carry the same number, which states that they cover the same API.

## Every artifact comes from one commit

The release workflow tags the release's merge commit `vX.Y.Z` before publishing anything, then builds every publish and the starter export from that tag. Each publish is guarded on the registry not already having the version, so a re-run after a partial failure publishes whatever the tagged version still lacks, from the same source, and a fix that needs new code takes a new version.

What a release publishes, for each package whose manifest carries the release's version:

- `@pipelex/sdk` and `@pipelex/create-method-app` on npm, with provenance;
- `pipelex-sdk` on PyPI;
- `starter-js/` and `starter-python/` exported to their template repositories (see [`export.md`](export.md)).

## A breaking SDK change reaches the templates one release later

A template's lockfile must name an SDK version the registry already serves: npm refuses an unpublished version and uv cannot resolve one. So a template cannot adopt a breaking SDK change in the pull request that makes it. The SDK change merges and ships while the templates stay on the SDK they pin, and after the release one follow-up pull request moves every template onto the new SDK, through the root `/bump-sdk` skill, for the next release. The pull requests' checks of each template against the SDK built from the same commit are the early warning: they report such a break on the SDK's own pull request without blocking it.

## Sprint prereleases of `@pipelex/sdk`

A sprint pins an unreleased upstream by its commit, and npm cannot point a git source at a subdirectory, so a sprint pins `@pipelex/sdk` through a prerelease instead: a manual dispatch of the release workflow publishes it from a chosen commit as `X.Y.Z-sprint.g<full sha>` on the `sprint` dist-tag, so `latest` never moves. `pipelex-sdk` needs no prerelease, since uv takes a git source with a subdirectory.
