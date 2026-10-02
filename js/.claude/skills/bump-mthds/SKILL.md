---
name: bump-mthds
description: >
  Bump the minimum required version of the upstream dependency this SDK rests
  on — the `mthds` package, which provides the MTHDS protocol wire types via its
  `mthds/protocol` subpath. Use when the user says "bump mthds", "bump the mthds
  version", "bump min mthds version", "raise the mthds floor", "bump required
  versions", "update required versions", "set min mthds to X.Y.Z", or any
  variation of changing the SDK's upstream version floor.
---

# Bump mthds

`@pipelex/sdk` has one upstream version floor that matters: the **`mthds`** package, which it imports the MTHDS protocol wire types from (via the `mthds/protocol` subpath). Because the SDK re-implements the official protocol routes using `mthds/protocol` *types*, its route shapes are pinned to a specific `mthds` surface — bumping the floor is how the SDK adopts a newer protocol surface.

This floor is the `mthds` entry in `package.json` (`dependencies` while dev-linked via a git/branch ref; a semver range once `mthds` is published). It is the single source of truth.

## Workflow

### 1. Read the current value

Show the current `mthds` dependency from `package.json`:

```bash
node -p "require('./package.json').dependencies?.mthds ?? '(not yet a dependency)'"
```

Until the client phase lands, `mthds` may not be a dependency yet — in that case there is nothing to bump; tell the user and stop.

Then ask the ledger what it already knows, before anything is edited: the items open for this package, the Python SDK's own `bump-mthds` filing its parity items here among others, and the items open for its twin. A parity item usually names the symbol and the version, which is what step 2 needs. `--owner` takes the repository's key alone, and `pipelex-sdk/js` matches nothing there, so both select the member with `jq`:

```bash
ledger list --owner pipelex-sdk --status open --json | jq -r '.[] | select(.owner == "pipelex-sdk/js") | "\(.id)  \(.title)"'
ledger list --owner pipelex-sdk --status open --json | jq -r '.[] | select(.owner == "pipelex-sdk/python") | "\(.id)  \(.title)"'
```

Claim (`ledger claim <id>`) any item of the first list that describes the bump you are about to make.

### 2. Confirm the target

Ask for the new version/range if the user didn't specify it. For a published `mthds`, the format is a semver range (`">=X.Y.Z"`); while dev-linked, it is a git/branch ref (e.g. `github:mthds-ai/mthds-js#<branch>`). Verify the new floor is not a downgrade unless the user explicitly intends one.

### 3. Apply the edit

Edit the `mthds` line in `package.json`. If pinning a published version, keep it a single `">=X.Y.Z"` range.

### 4. Verify

Run `make check && make test`. The build (`tsc`) resolves `mthds/protocol` against the new floor, so a green run confirms the SDK still type-checks against it.

### 5. Report and remind

Summarise `OLD → NEW`, then remind the user to:

- **Add a CHANGELOG.md entry** describing the bump and why (e.g., a protocol surface the SDK now relies on).
- **Coordinate consumer floors** if downstream repos pin a minimum `@pipelex/sdk` — that is the job of the equivalent floor-bump skill in those repos, not here.

Do not commit or create a release — leave that to the user (or the repository root's `/release` skill).

### 6. Square the ledger

Close the items you claimed at step 1 once the change lands, with evidence. **File the parity item** when the bump adopted a protocol model the Python SDK mirrors. `pipelex-sdk`, in this repository's `python/` (ledger member `pipelex-sdk/python`), is this package's twin and consumes the `mthds` PyPI package, so when a protocol model moves it usually moves in both languages. Its move waits on the matching `mthds` release on PyPI and runs `python/`'s own gate and changelog, so it is a change of its own rather than part of this one. Note the symbol and the version on an open item of step 1's second list that already covers the move, since `ledger new` files a duplicate without refusing it; otherwise file it (`ledger new --owner pipelex-sdk/python …`) naming both. Then `ledger validate` and `ledger commit`, which commit the ledger and nothing in this repository.
