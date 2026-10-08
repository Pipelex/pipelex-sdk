# pipelex-sdk

The Pipelex client surface in one repository: the TypeScript and Python clients of the hosted API, the starter templates built on them, and the method-app templates with their initializer. [`docs/layout.md`](docs/layout.md) explains the layout and why each directory stands on its own.

## Layout

| Directory | What it is | Ledger member |
| --- | --- | --- |
| `js/` | `@pipelex/sdk`, the TypeScript client (npm) | `pipelex-sdk/js` |
| `python/` | `pipelex-sdk`, the Python client (PyPI) | `pipelex-sdk/python` |
| `starter-js/` | The Next.js starter template, published as `Pipelex/pipelex-starter-js` | `pipelex-sdk/starter-js` |
| `starter-python/` | The Python starter template, published as `Pipelex/pipelex-starter-python` | `pipelex-sdk/starter-python` |
| `method-apps/` | The method-app family: the `webapp-js/` and `cli-python/` templates and the `initializers/js/` initializer, `@pipelex/create-method-app` (npm) | `pipelex-sdk/method-apps` |

**Work inside a directory follows that directory's own `CLAUDE.md`**, and its gate runs from inside it. The root holds only what serves the maintainers: the `Makefile`, `VERSION`, the license and contributor agreement, the git hooks (`.githooks/`), the maintainers' skills (`.claude/skills/`), the CI (`.github/workflows/`, described in [`docs/ci.md`](docs/ci.md)), the scripts that check versions, render the workflow twins, copy the shared case files, select a release's packages and take the release workflow's decisions (`scripts/`) and `docs/`.

## Rules

- **A template's files belong to the person's project, never to this repository.** The templates are `starter-js/`, `starter-python/`, `method-apps/webapp-js/` and `method-apps/cli-python/`, and every file in one ships to every project made from it. Their `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` and `.github/workflows/` speak to that project. **Never run a template's skills here**: its `bootstrap` turns the template into a project, and its own `bump-sdk` and `bump-mthds-form` are a project's. The root's `/bump-sdk` and `/bump-mthds-form` move the templates in this repository. Anything that serves only the maintainers — a contributor agreement, a branch guard, a release check, a release procedure — goes at the root, never in a template.
- **A template works on its own**: nothing in it may reach above its directory, whether an import, a script, a configuration file or a symlink. It installs its SDK from the registry with its own lockfile, never from this tree.
- **Run a template against this tree's SDK with the root's `make use-local`**, never the template's own: a template's `use-local` installs the checkouts beside a person's project (`../pipelex-sdk/js` and `../mthds-form`, or `../pipelex-sdk/python` and `../mthds-python`), which name nothing here. The root's packs this tree's `js/` and the workspace's `mthds-form` checkout into every JavaScript template, and installs this tree's `python/` and the workspace's `mthds-python` checkout as editable packages in `method-apps/cli-python`; `IN=<dir>` narrows it, the root's `make local-status` says which templates run a local build, and the root's `make use-published` switches back ([`docs/layout.md`](docs/layout.md), "This tree's SDK in the templates").
- **Run the gate of every directory a change touches** before pushing: `make -C <directory> agent-check` and `make -C <directory> agent-test`. A directory installs itself the first time its checks run; `make agent-check agent-test` at the root runs every directory.
- **The repository has one version**, the root `VERSION`, and each package's manifest carries the version that package last shipped as, never above it. Only a release moves `VERSION` or a manifest's `version` ([`docs/release-model.md`](docs/release-model.md)).
- **A template's workflow twins at the root are rendered, never edited**: after changing a workflow in a template's `.github/workflows/`, run `make workflows` at the root and commit the twins with it; `make check-workflows`, part of the root's `agent-check` and of CI, fails on a stale twin.
- **A shared case file's copies are copied, never edited**: the case files both SDKs run, such as `js/tests/fixtures/cli-cases.json`, are changed at their source, declared in `scripts/shared-files.mjs`, then `make shared-files` at the root writes the copies, committed with it; `make check-shared-files`, part of the root's `agent-check` and of CI, fails on a stale copy.
- **Changelog entries go in the package's own `CHANGELOG.md`**, under `## [Unreleased]`; the method apps' templates use the family's `method-apps/CHANGELOG.md`. There is no root changelog.
- **Pull requests target `dev`**; a `release/vX.Y.Z` branch targets `main`, and only the root `/release` skill cuts one, its packages selected by `make release-selection`. Its merge publishes: `.github/workflows/release.yml` tags `vX.Y.Z` on the merge commit before anything else, then publishes each shipped package and exports each shipped starter from that tag ([`docs/release-model.md`](docs/release-model.md)). Never push to `main` by other means, and never move a `v*` tag.
