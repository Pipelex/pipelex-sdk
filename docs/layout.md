# The layout of this repository

`pipelex-sdk` holds the Pipelex client surface in one repository: the clients of the Pipelex hosted API in TypeScript and Python, the starter templates built on them, and the method-app templates with the initializer that writes them. These packages used to live in five repositories, and they moved here because they already moved as one: a change to the hosted API reached both SDKs and then every template, one release cycle per repository, and a template could not see that the next SDK broke it until that SDK was on the registry.

## The directories

| Directory | What it is | Published as | Ledger member |
| --- | --- | --- | --- |
| `js/` | The TypeScript client of the hosted API | `@pipelex/sdk` on npm | `pipelex-sdk/js` |
| `python/` | The Python client of the hosted API | `pipelex-sdk` on PyPI | `pipelex-sdk/python` |
| `starter-js/` | A Next.js starter app on `@pipelex/sdk`, the gallery of worked examples | the GitHub template repository `Pipelex/pipelex-starter-js` | `pipelex-sdk/starter-js` |
| `starter-python/` | A Python command-line starter on `pipelex-sdk` | the GitHub template repository `Pipelex/pipelex-starter-python` | `pipelex-sdk/starter-python` |
| `method-apps/` | The method-app templates, one per shape and language (`webapp-js/` and `cli-python/`), and `initializers/js/`, the initializer that writes the Node ones | `@pipelex/create-method-app` on npm, which carries the Node templates; `cli-python/` is copied out of a release's tag | `pipelex-sdk/method-apps` |

Each directory documents itself: its `README.md` is for the people who use it, its `CLAUDE.md` guides work inside it, and its `docs/` holds its reference pages. The method apps keep their family root intact inside `method-apps/`, and [`method-apps/docs/family.md`](../method-apps/docs/family.md) describes it.

## Each directory stands on its own

The root declares neither an npm workspace nor a uv workspace. Each directory keeps its own manifest and lockfile and installs from the registries, exactly as its repository did. The reason is the templates: a template has to install on its own, with its own lockfile and the SDK from the registry, because that is what a person copies. An npm workspace keeps a single lockfile at the root and would take the template's away, and a uv workspace would resolve the SDK from the tree. The SDKs share no code and depend on no other package here, so a workspace would buy nothing.

So a template never installs the SDK from this tree, and testing a template against the SDK in the tree is the CI's job: each template is checked once as it ships, extracted on its own and installed from the registry, and once against the SDK built from the same commit.

## Templates and what serves the maintainers

These directories are templates, which a person's project starts as a copy of: `starter-js/`, `starter-python/`, `method-apps/webapp-js/` and `method-apps/cli-python/`. **A template directory holds only what a person's project needs.** Its `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` and `.github/workflows/` speak to that project, not to this repository's maintainers, and nothing in it may reach above its directory: no import, script, configuration file or symlink pointing outside it.

Everything that serves only the maintainers lives at the root instead:

- `Makefile`, the root gate, which runs every directory's own targets;
- `VERSION`, the repository's one version (see [`release-model.md`](release-model.md));
- `LICENSE` and `CLA.md`, the repository's license and the contributor agreement its pull requests are signed under;
- `.githooks/`, the git hooks;
- `.github/workflows/`, the pull-request checks, which [`ci.md`](ci.md) describes, with the rendered twins of each template's own workflows, and the release workflow and the mirrors' scheduled comparison, which [`release-model.md`](release-model.md) and [`export.md`](export.md) describe;
- `scripts/`, which checks every manifest against `VERSION`, renders the twins, selects the packages a release ships, takes the release workflow's decisions and exports the starters;
- `.worktree.toml`, which tells the workspace's `wt` how to publish a sprint prerelease of `@pipelex/sdk`;
- `.claude/skills/`, the maintainers' skills: `release` cuts a release of the repository, and `bump-sdk` and `bump-mthds-form` move every template onto a newer published SDK or form kernel in one change;
- `docs/`, this documentation.

The release skills that each source repository carried, the templates' own included, were removed from the package directories: the repository's release is cut from the root, and a person's project has no use for Pipelex's release procedure. The root `/release` skill replaces them, and the release workflow, `.github/workflows/release.yml`, publishes from the root (see [`release-model.md`](release-model.md)).

## Installing

`make install` at the root wires the git hooks and installs nothing else. Each directory's `agent-check` and `agent-test` run that directory's own `install` first when its `node_modules` or `.venv` is missing, so a worktree pays only for the directories its work touches: installing every directory takes over a gigabyte of disk, while one SDK takes a small fraction of that. The root's `make agent-check` and `make agent-test` run every directory's targets and so install every directory the first time; `make -C <directory> agent-check` checks one.

Each directory installs the way its own `Makefile` says: `npm install` for the JavaScript packages, and a uv virtual environment in the directory's `.venv` for the Python ones.

## This tree's SDK in the templates

A template's `make use-local` serves the project made from it. In `starter-js/` and `method-apps/webapp-js/`, it installs `@pipelex/sdk` and `@pipelex/mthds-form` from checkouts beside that project in place of their npm releases: `../pipelex-sdk/js`, the `js/` directory of a `Pipelex/pipelex-sdk` checkout, and `../mthds-form`, a checkout of `Pipelex/mthds-form`, where the web app template's `SIBLINGS_DIR=<dir>` names another parent directory. In `method-apps/cli-python/`, it installs `pipelex-sdk` and `mthds` as editable packages from `../pipelex-sdk/python` and `../mthds-python`, a checkout of `mthds-ai/mthds-python`, the latter only when it is there; `SIBLINGS_DIR=<dir>` names another parent, and `SDK_DIR=<dir>` and `MTHDS_DIR=<dir>` name either checkout directly. The template's own `README.md` and `CLAUDE.md` describe it that way, as a person sees it in their project.

Inside this repository those paths name nothing. The SDK a maintainer wants a template to run is this tree's own `js/` or `python/`, in whichever worktree the work is, and a template, which looks for the SDK under a directory named `pipelex-sdk`, cannot name a worktree's. So the maintainers' switch lives in the root's `Makefile`:

- `make use-local` builds and packs `js/` and the workspace's `mthds-form` checkout, which is `../mthds-form` from the root of the main checkout and of every worktree alike, and installs both tarballs into every JavaScript template in one `npm install --no-save`, so no manifest or lockfile changes. It installs `js/` and each template first when they were never installed, and refuses to run when the `mthds-form` checkout is missing or was never installed. Re-run it after every edit to either package, since a tarball is a snapshot. In every Python template it runs the template's own `use-local` with `SDK_DIR` naming this tree's `python/` and `MTHDS_DIR` the workspace's `mthds-python` checkout, `../mthds-python` from the root, which installs the SDK and, when that checkout exists, `mthds` as editable packages, so an edit takes effect without a re-run, and `uv.lock` does not change; without the checkout, `mthds` stays as the template's `uv.lock` pins it, and the template says so. The SDK pins `mthds` exactly, so uv refuses a checkout at any other version, naming the SDK's pin; `MTHDS_PYTHON_DIR=<dir>` then names one at the pinned version, and `IN=method-apps/cli-python` runs the Python arm alone when the `mthds-form` checkout the JavaScript arm needs first is missing.
- `make use-published` puts each template back on the versions its lockfile pins, `--no-save` in a JavaScript template and through `uv sync` in a Python one. A template's own way back is not for this repository: `starter-js`'s `make use-npm` moves its ranges to the latest releases, which is a bump.
- `make local-status` says, template by template, whether each package is a local build or the registry's, which the version cannot tell since a local build carries the version it will be published as.
- `IN=<dir>` narrows any of the three to the templates at or under a directory (`IN=starter-js`, `IN=method-apps`), `MTHDS_FORM_DIR=<dir>` takes the form kernel from another checkout, such as a worktree of `mthds-form`, and `MTHDS_PYTHON_DIR=<dir>` takes `mthds` from another checkout of `mthds-python`.

The method-app family's `make use-local` is the root's, run with `IN=method-apps`. A JavaScript template joins `JS_TEMPLATES` in the root's `Makefile`, and a Python template whose `use-local` takes `SDK_DIR` and `MTHDS_DIR` joins `PY_TEMPLATES`; `starter-python/` has no `use-local` of its own, so the switch does not reach it.

The other workspace checkouts a package's maintainers reach sit at the same place: the workspace root is the parent of this repository's root, so it is two levels above a package directory, in a worktree as in the main checkout. `js/`'s `make use-local` links `../../mthds-js`, `python/`'s `bump-mthds` skill reads `../../mthds-python/CHANGELOG.md`, and `js/`'s `contract-check` skill reads the workspace's specs in `../../docs/specs/`.

## The hooks

The root's `make install` points git at `.githooks/`. A JavaScript template carries its own Husky pre-commit hook, which travels into every project made from it and wires itself there through the template's `prepare` script; here, Husky finds no `.git` in the template's directory and wires nothing. `method-apps/cli-python/` carries no hook, and the root's hook skips it. So the root's `.githooks/pre-commit` runs each template's own hook from inside that template, for the templates a commit touches, where lint-staged sees only that template's staged files. A template a worktree never installed has no lint-staged to run, and the hook stops the commit and names the install to run rather than installing in the middle of a commit.

## Local files

Each directory keeps its own local env files (`.env`, `.env.local`) and Claude Code settings, all gitignored. The root's `.worktreeinclude` names them at any depth, so `wt` and Claude Code copy them from the main checkout into a new worktree.

## Where the code came from

The repository's first commit, `e64f53500b5ba9c6ed0d5b413039eb8b13a7d49e`, is the import: each directory is the tree of its source repository at a release point, copied with `git archive` and checked tree hash for tree hash against its source.

| Directory | Source repository | Copied at |
| --- | --- | --- |
| `js/` | `Pipelex/pipelex-sdk-js` | `@pipelex/sdk` 0.28.1, `6a4d866d3c72552b6852e1144e89f19fbdc96595` |
| `python/` | `Pipelex/pipelex-sdk-python` | `pipelex-sdk` 0.16.0, `ebde12780230a5540e29ab42f5cf3a04c0325725` |
| `starter-js/` | `Pipelex/pipelex-starter-js` | 0.6.3, `4de042354b457935f5bfdb94ddcc774a8608f666` |
| `starter-python/` | `Pipelex/pipelex-starter-python` | 0.2.1, `5fdb7d6c867986a4f7fe570165ace2d862f1c6d4` |
| `method-apps/` | `Pipelex/pipelex-method-apps` | `@pipelex/create-method-app` 0.5.7, `dac0115eae9e7237d6b261841752801264faf649` |

The histories stay in those repositories. The SDK and method-app repositories are to be archived, and the starter repositories live on as the template mirrors described in [`export.md`](export.md).
