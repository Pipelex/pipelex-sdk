# The starter template repositories

`Pipelex/pipelex-starter-js` and `Pipelex/pipelex-starter-python` stay GitHub template repositories, with their names, their "Use this template" button and every link that points at them. Their source is here, in `starter-js/` and `starter-python/`, and each becomes a read-only mirror of its directory: a release that ships a starter adds one commit to its mirror's `main`. The export that does it is the last job of the release workflow, `.github/workflows/release.yml`, and runs `scripts/export.mjs`. Until a release of this repository ships a starter, its mirror's `main` holds the last release made from its own history: the JavaScript starter 0.6.3 and the Python starter 0.2.1.

## How a starter is exported

A repository created from a template copies only the template's default branch and starts from a single commit, so its owner never sees the template's history: the mirror only has to hold the right files on `main`. For one starter, the heart of the export is:

```sh
tree=$(git rev-parse "vX.Y.Z:starter-js")
git fetch https://github.com/Pipelex/pipelex-starter-js.git main
commit=$(git commit-tree "$tree" -p FETCH_HEAD -m "Release vX.Y.Z, from Pipelex/pipelex-sdk@<sha>")
git push --atomic https://github.com/Pipelex/pipelex-starter-js.git "$commit:refs/heads/main" "$commit:refs/tags/vX.Y.Z"
```

The new commit's tree is the directory itself, so the two are identical by construction, and its parent is the mirror's current `main`, so the push is a fast-forward and the mirror's history and tags stay. The invariant is one comparison, the mirror's `main^{tree}` against `vX.Y.Z:starter-js` here, which the export checks after pushing and a scheduled job checks again against `v<the starter's manifest version>:<directory>`, the release the starter last shipped in.

## What the export job does

The release workflow runs the export after every publish has succeeded and the GitHub Release exists, from a checkout of the release's tag, for each starter whose manifest carries the release's version there; a starter held back at the release is left alone. For each starter, in this order:

1. **It reads the mirror's own tags.** When `vX.Y.Z` exists and its tree equals `vX.Y.Z:<directory>`, the mirror was exported already, by an earlier attempt of the same release, and it is skipped. When `vX.Y.Z` exists with another tree, the export fails loudly for that mirror and pushes nothing, since the mirror's tag is not this release's. When the mirror carries a later release's tag, a later release has exported the starter already, and this one, a re-run of an older release's failed export, is superseded: it pushes nothing rather than put the older starter back on top of the newer one.
2. **It refuses a starter whose pinned SDK does not resolve.** It reads the SDK version the starter's lockfile pins, `@pipelex/sdk` in `starter-js/package-lock.json` and `pipelex-sdk` in `starter-python/uv.lock`, which is what a project made from the template installs, and asks npm or PyPI for exactly that version. A version the registry does not serve, or a lockfile taking the SDK from anywhere but the registry, stops that mirror's export with nothing pushed, so a template never points at an SDK that is not published.
3. **It builds the commit and pushes it**: `git commit-tree` of the directory's tree on the mirror's `main`, with the message `Release vX.Y.Z, from Pipelex/pipelex-sdk@<the tagged commit>`, pushed as the mirror's `main` and its `vX.Y.Z` in one atomic push, so the mirror gets both refs or neither.
4. **It reads the mirror back**: both the mirror's `main` and its `vX.Y.Z` must now hold the directory's tree.

Each mirror is exported on its own: a mirror that fails does not stop the other, and the job fails at the end when any did. **A partial failure is finished by re-running the job**, which skips the mirror already exported and exports the other. `scripts/export.test.mjs` runs the export against local bare repositories playing the mirrors, with the registry faked: a fresh export, an export onto an empty mirror, a re-run that skips, a mirror whose tag holds another tree, a re-run superseded by a later release, a pin the registry does not serve, a held-back starter and a failing mirror.

**It pushes with a GitHub App token** that can write to the mirrors alone, because the workflow's own token cannot push to another repository. The job mints it with `actions/create-github-app-token` from the repository variable `MIRROR_EXPORT_APP_ID` and the `mirrors` environment's secret `MIRROR_EXPORT_APP_PRIVATE_KEY`, scoped to `Pipelex/pipelex-starter-js` and `Pipelex/pipelex-starter-python` with write access to their contents and their workflows, since the exported tree carries `.github/workflows/`. Git reads the token through a credential helper that takes it from the environment, so it never appears in a URL, an argument or a file, and the commits are authored by the App's bot user. Each mirror's ruleset lets only that App push to `main`. The mirrors keep no `dev` branch, take no pull requests and have their issues turned off; their About boxes send contributors here. The job mints no token for a release that ships no starter.

**The App's private key is a secret of the `mirrors` environment, never of the repository.** A repository secret reaches every workflow run an event in the repository starts, on any branch, so anyone who could push a branch could push a workflow that reads the key and pushes to the mirrors as the App. The `mirrors` environment allows `main` alone and the export job is the only job that holds it, so only the release's own run reads the key; `scripts/publish.test.mjs` checks that no other job of `release.yml`, and no other workflow, reads it. The App's id stays the repository variable `MIRROR_EXPORT_APP_ID`, since it grants nothing without the key. Ruled in L-261002-2bf7a3; the environment was created on 2026-10-02, and the key and the variable are stored when the App is created. A copy of the key left as a repository or organization secret would undo this, since a workflow on any branch reads those, so the `/release` skill's pre-flight refuses one.

## The scheduled comparison

`.github/workflows/mirrors.yml` runs every day, and on demand, from `main`. For each starter it compares the mirror's `main^{tree}` with `v<the starter's manifest version>:<directory>`, the release the starter last shipped in, so a starter held back at a later release is still compared with the tree it last shipped, and a push made to a mirror by hand fails the run. A starter whose manifest carries a version this repository never tagged has not been exported from here yet, which is the case of both starters until the first release ships them: the run reports that the mirror still holds its own history and does not fail. A run that happens while a release is exporting can see a tagged starter whose mirror is not pushed yet and fail; the next run settles it.

It lives in its own workflow rather than in `release.yml` because `ledger land` verifies a release from the newest run of `release.yml` at the release's merge commit, where a scheduled run on `main` would stand too, and because it only reads public repositories, so it needs neither the publishers' permissions nor the App.

## What a starter carries

Every file in a starter's directory ships to every project made from it, so nothing mirror-specific or maintainer-specific may live there: the contributor agreement, the branch guard, the release checks and the release skill all live at this repository's root. A starter's metadata describes the project a person makes from it, not this repository: its manifest names no Pipelex repository, its `bootstrap` skill fills in the person's own repository URL, and its README sends people to the template repository, whose name is stable, rather than to this one.

The template repositories run no CI of their own on an export, because the starters' workflows trigger on pull requests only. The proof that an exported tree builds is this repository's standalone check of each starter, which installs and tests exactly that directory, extracted on its own and installed from the registry with its own lockfile, as a project made from it would be.
