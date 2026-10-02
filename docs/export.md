# The starter template repositories

`Pipelex/pipelex-starter-js` and `Pipelex/pipelex-starter-python` stay GitHub template repositories, with their names, their "Use this template" button and every link that points at them. Their source is here, in `starter-js/` and `starter-python/`, and each becomes a read-only mirror of its directory: a release that ships a starter adds one commit to its mirror's `main`. The export that does it is the next step of the move into this repository (ledger item L-261001-075fdb) and is not written yet, so until a release of this repository ships a starter, each mirror's `main` holds the last release made from its own history: the JavaScript starter 0.6.3 and the Python starter 0.2.1.

## How a starter is exported

A repository created from a template copies only the template's default branch and starts from a single commit, so its owner never sees the template's history: the mirror only has to hold the right files on `main`. For one starter, the export is:

```sh
tree=$(git rev-parse "vX.Y.Z:starter-js")
git fetch git@github.com:Pipelex/pipelex-starter-js.git main
commit=$(git commit-tree "$tree" -p FETCH_HEAD -m "Release vX.Y.Z, from Pipelex/pipelex-sdk@<sha>")
git push git@github.com:Pipelex/pipelex-starter-js.git "$commit:refs/heads/main" "$commit:refs/tags/vX.Y.Z"
```

The new commit's tree is the directory itself, so the two are identical by construction, and its parent is the mirror's current `main`, so the push is a fast-forward and the mirror's history and tags stay. The invariant is one comparison, the mirror's `main^{tree}` against `vX.Y.Z:starter-js` here, which the export checks after pushing and a scheduled job checks again against `v<the starter's manifest version>:<directory>`, the release the starter last shipped in.

Around it:

- **It is safe to re-run.** A mirror whose `vX.Y.Z` already holds the directory's tree is skipped, and one whose `vX.Y.Z` holds another tree fails loudly.
- **It runs only after the SDK publish of the same release**, and refuses to push a starter whose pinned SDK version does not resolve on npm or PyPI.
- **It pushes with a GitHub App token** that can write to the mirrors alone, and each mirror's ruleset lets only that App push to `main`. The mirrors keep no `dev` branch, take no pull requests and have their issues turned off; their About boxes send contributors here.

## What a starter carries

Every file in a starter's directory ships to every project made from it, so nothing mirror-specific or maintainer-specific may live there: the contributor agreement, the branch guard, the release checks and the release skill all live at this repository's root. A starter's metadata describes the project a person makes from it, not this repository: its manifest names no Pipelex repository, its `bootstrap` skill fills in the person's own repository URL, and its README sends people to the template repository, whose name is stable, rather than to this one.

The template repositories run no CI of their own on an export, because the starters' workflows trigger on pull requests only. The proof that an exported tree builds is this repository's standalone check of each starter, which installs and tests exactly that directory, extracted on its own and installed from the registry with its own lockfile, as a project made from it would be.
