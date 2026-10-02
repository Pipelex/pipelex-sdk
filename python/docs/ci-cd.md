# CI/CD

This package has no workflows of its own any more: GitHub runs workflows only from the repository root's `.github/workflows/`, so the Python SDK's checks are jobs of the root's `ci.yml`, which run when a pull request changes `python/` or the root's own machinery. The root's [`docs/ci.md`](../../docs/ci.md) maps each check this package ran in its own repository to its job there.

| Root job | What it runs, in `python/` |
| --- | --- |
| `python lint (<version>)` | `PYTHON_VERSION=<version> TEST_PROFILE=ci make install`, then `make merge-check-ruff-format`, `merge-check-ruff-lint`, `merge-check-pyright` and `merge-check-mypy`, across Python 3.11 to 3.14. |
| `python tests (py<version>)` | `PYTHON_VERSION=<version> make install`, then `make gha-tests`, across the same versions. |
| `python package-check` | `uv lock --locked` must leave `uv.lock` unchanged. |

Every matrix leg uses this directory's `Makefile` targets, which honor `PYTHON_VERSION`, so each leg provisions its own interpreter through `uv venv --python <version>`. The root's `Lint (all)` and `Tests (all)` aggregates are the required checks, and the branch guard, the contributor agreement and the version checks are the repository's, described in the root's `docs/ci.md`.

## Publishing

The repository's release workflow, the root's `.github/workflows/release.yml`, publishes `pipelex-sdk` to PyPI when a release that ships it merges into `main`: it reads the root `VERSION`, builds the sdist and the wheel from the release's tag, and uploads them through PyPI's trusted publishing. The root's [`docs/release-model.md`](../../docs/release-model.md) describes the model. Releases up to 0.16.0 were published from `Pipelex/pipelex-sdk-python`, whose publish workflow is disabled.

Two facts about that workflow:

- **PyPI Trusted Publishing** names this repository, the workflow filename `release.yml` and the environment `pypi` for the `pipelex-sdk` project, so the publish job holds that environment, which allows `main` alone, and no API token secret exists.
- **The Actions allowlist** sits at the enterprise level, above the `Pipelex` and `mthds-ai` organizations, and some of its entries key on an exact commit SHA. `sigstore/gh-action-sigstore-python` was allowlisted at `790bc6befb9d733738f18d8f895854b453640ec9` (v3.5.0) for the old publish workflow's signed GitHub Release; any other version of a pinned action needs an enterprise admin to add its SHA first.
