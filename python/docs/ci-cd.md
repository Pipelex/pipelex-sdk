# CI/CD

This package has no workflows of its own any more: GitHub runs workflows only from the repository root's `.github/workflows/`, so the Python SDK's checks are jobs of the root's `ci.yml`, which run when a pull request changes `python/` or the root's own machinery. The root's [`docs/ci.md`](../../docs/ci.md) maps each check this package ran in its own repository to its job there.

| Root job | What it runs, in `python/` |
| --- | --- |
| `python lint (<version>)` | `PYTHON_VERSION=<version> TEST_PROFILE=ci make install`, then `make merge-check-ruff-format`, `merge-check-ruff-lint`, `merge-check-pyright` and `merge-check-mypy`, across Python 3.11 to 3.14. |
| `python tests (py<version>)` | `PYTHON_VERSION=<version> make install`, then `make gha-tests`, across the same versions. |
| `python package-check` | `uv lock --locked` must leave `uv.lock` unchanged. |

Every matrix leg uses this directory's `Makefile` targets, which honor `PYTHON_VERSION`, so each leg provisions its own interpreter through `uv venv --python <version>`. The root's `Lint (all)` and `Tests (all)` aggregates are the required checks, and the branch guard, the contributor agreement and the version checks are the repository's, described in the root's `docs/ci.md`.

## Publishing

Nothing publishes `pipelex-sdk` from this repository yet. The repository's release workflow, which reads the root `VERSION` and publishes each package whose manifest carries it, is the next step of the move into `pipelex-sdk`, and the root's [`docs/release-model.md`](../../docs/release-model.md) describes the model. Until then the package's last release, 0.16.0, was published from `Pipelex/pipelex-sdk-python`, whose publish workflow is disabled.

Two facts carry over to that workflow:

- **PyPI Trusted Publishing** names a repository, a workflow filename and an environment (`pypi`) for the `pipelex-sdk` project, so the new repository needs its own registration and its own `pypi` environment, and no API token secret.
- **The Actions allowlist** sits at the enterprise level, above the `Pipelex` and `mthds-ai` organizations, and some of its entries key on an exact commit SHA. `sigstore/gh-action-sigstore-python` was allowlisted at `790bc6befb9d733738f18d8f895854b453640ec9` (v3.5.0) for the old publish workflow's signed GitHub Release; any other version of a pinned action needs an enterprise admin to add its SHA first.
