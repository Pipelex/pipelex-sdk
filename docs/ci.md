# The pull-request checks

GitHub runs workflows only from `.github/workflows/` at the repository root, so every check a package ran in its own repository is a job of the root's `ci.yml` here, and the workflows left inside a package directory are a template's own, which GitHub ignores in this repository and runs in every project made from the template.

## How `ci.yml` is shaped

- **A `Changes` job reads which directories the pull request changes**, and each package's jobs run only when its directory changed, or when the root's own machinery did: `ci.yml`, the root `Makefile`, `VERSION` or `scripts/`. A change to a template's rendered twins counts as a change to that template.
- **Two aggregates are the required checks: `Lint (all)` and `Tests (all)`.** Each always runs, even when every job it waits on was skipped, and fails when one of them failed or was cancelled. A job that only runs for some pull requests cannot be required by itself, since it never posts on a pull request that does not touch its directory, and that pull request would wait for it forever.
- **A template is checked through its standalone twins.** `make workflows` renders, from each of a template's own workflows, a reusable twin at the root that extracts the template with `git archive HEAD:<template>` into a folder outside the checkout, gives it a repository of its own, and runs the template's workflow there unchanged: it installs from the registry with the template's own lockfile, exactly as a project made from it would. `ci.yml` calls each standalone twin inside the aggregates. `make check-workflows`, which the `Root` job runs, fails when a twin is missing, stale or orphaned.
- **Each template is also checked against the next SDK**, by a second twin of each workflow that has an install step: after the template's own install, it installs the SDK built from the same commit (`npm pack` of `js/`, or `uv build` of `python/`) over the registry's copy. It runs when the template's directory or its SDK's directory changes, and it is reported but stays outside the aggregates: a breaking SDK change reaches the templates one release later (see [`release-model.md`](release-model.md)), so the SDK's own pull request is warned without being blocked.
- **The release checks run on a pull request into `main` or a `release/vX.Y.Z` branch**: `VERSION` must be above `main`'s and match the release branch's name, at least one package must carry `VERSION`, and each package that does needs its changelog entry.
- **Two workflows sit beside `ci.yml` and are reported, not required**: `guard-branches.yml`, which holds the branch flow (a topic branch into `dev`, `dev` into `release/vX.Y.Z`, `release/vX.Y.Z` into `main`), and `cla.yml`, which asks a first contribution to sign [`CLA.md`](../CLA.md).

## Each source repository's checks, and where they run now

The source repositories are the five whose trees were copied at the import (see [`layout.md`](layout.md)), and their checks are read at the copied commit.

| Source | Old check | New job | Aggregate | Verified on |
| --- | --- | --- | --- | --- |
| `pipelex-sdk-js` | `quality-checks.yml`: `make install`, then `make all` | `js (make all)` | `Tests (all)` | |
| `pipelex-sdk-js` | `version-check.yml`: the version against `main` and the release branch | `Release version`, reading `VERSION` | `Lint (all)` | |
| `pipelex-sdk-js` | `changelog-check.yml`: the release's changelog entry | `Release version`, `make check-release-versions` | `Lint (all)` | |
| `pipelex-sdk-js` | `guard-branches.yml` | the root `guard-branches.yml` | reported | |
| `pipelex-sdk-js` | `cla.yml` | the root `cla.yml` | reported | |
| `pipelex-sdk-python` | `lint-check.yml`: `TEST_PROFILE=ci make install` and the four merge checks, Python 3.11 to 3.14, then `Lint (all versions)` | `python lint (<version>)` | `Lint (all)` | |
| `pipelex-sdk-python` | `tests-check.yml`: `make install`, then `make gha-tests`, Python 3.11 to 3.14, then `Tests (all)` | `python tests (py<version>)` | `Tests (all)` | |
| `pipelex-sdk-python` | `package-check.yml`: `uv lock --locked` leaves `uv.lock` unchanged | `python package-check` | `Lint (all)` | |
| `pipelex-sdk-python` | `version-check.yml`, `changelog-check.yml` | `Release version` | `Lint (all)` | |
| `pipelex-sdk-python` | `guard-branches.yml`, `cla.yml` | the root `guard-branches.yml` and `cla.yml` | reported | |
| `pipelex-starter-js` | `lint-check.yml`: `npm ci`, then `make check` | `starter-js-lint`, the standalone twin `starter-js-lint-check.yml` | `Lint (all)` | |
| `pipelex-starter-js` | `tests-check.yml`: `npm ci`, `make agent-test`, `make build` | `starter-js-tests`, the standalone twin `starter-js-tests-check.yml` | `Tests (all)` | |
| `pipelex-starter-python` | `lint-check.yml`: `make install` and the four merge checks, Python 3.11 to 3.13 | `starter-python-lint`, the standalone twin `starter-python-lint-check.yml` | `Lint (all)` | |
| `pipelex-starter-python` | `tests-check.yml`: `make install`, then `make gha-tests`, Python 3.11 to 3.13 | `starter-python-tests`, the standalone twin `starter-python-tests-check.yml` | `Tests (all)` | |
| `pipelex-starter-python` | `package-check.yml`: `uv lock --locked` | `starter-python-package`, the standalone twin `starter-python-package-check.yml` | `Lint (all)` | |
| `pipelex-starter-python` | `version-check.yml`, `changelog-check.yml` | `Release version` | `Lint (all)` | |
| `pipelex-starter-python` | `guard-branches.yml`, `cla.yml` | the root `guard-branches.yml` and `cla.yml` | reported | |
| `pipelex-method-apps` | `family-check.yml`: the family's version, the workflow twins, Prettier on the family's files, the root's scripts and the initializers' tests | `method-apps family` for Prettier, the family's scripts and the initializers; `Root` for the versions and the twins, now the repository's | `Tests (all)`, `Lint (all)` | |
| `pipelex-method-apps` | `webapp-js-lint-check.yml`, the twin of `webapp-js`'s `lint-check.yml` | `method-apps-webapp-js-lint`, the standalone twin `method-apps-webapp-js-lint-check.yml` | `Lint (all)` | |
| `pipelex-method-apps` | `webapp-js-tests-check.yml`, the twin of `webapp-js`'s `tests-check.yml` | `method-apps-webapp-js-tests`, the standalone twin `method-apps-webapp-js-tests-check.yml` | `Tests (all)` | |

The source repositories' publish workflows (`publish.yml` in both SDKs, `release.yml` in the method apps, `github-release.yml` in the Python starter) gated no pull request. The repository's release workflow replaces them and is not written yet.

**One difference from the sources is deliberate.** The Python starter's ruleset required its contributor-agreement and branch-guard checks, and here both are reported rather than required, because the rulesets require only the two aggregates. The contributor agreement also cannot pass on this repository until the organization's secrets for it and its GitHub App reach the repository.
