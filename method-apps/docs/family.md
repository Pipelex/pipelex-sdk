# The family layout

`pipelex-method-apps` holds one template per shape and language. A project is a copy of one template directory, and nothing else from this repository ever reaches it. This document describes what the root adds around the templates, and why each piece is shaped the way it is.

## Why one repository

The templates are inputs to a generator gesture, not showcases: a person or a coding agent copies one out and runs its `make create`, and nobody browses a template that ships no method. Keeping them together buys one contract for the scaffold that drives them, one gate that runs all of them, one version, one release, and changes that land in every template at once when the codegen contract or the SDK moves. What it costs is described below: workflows that the root has to twin, a root gate that delegates, and an initializer that carries each template's tree, since a project is one directory of the repository rather than a clone of it.

GitHub's **Use this template** button is not the way in. It copies a whole repository, and a copy of a shell with no method in it is not an app anyone wanted.

## The layout

```
Makefile                         the root gate: family checks, then each template's targets
VERSION                          the family's version, one line
CHANGELOG.md                     the family's changelog
.claude/skills/release/          the one release skill
.claude/skills/bump-mthds-form/  moves every template onto a newer @pipelex/mthds-form
.claude/skills/bump-sdk/         moves every template onto a newer @pipelex/sdk
.github/workflows/               the root twins of each template's workflows, family-check.yml and release.yml
.husky/pre-commit                runs each touched template's own hook from inside it
scripts/                         the root's own tooling (workflows.mjs, versions.mjs, the create contract) and its tests
initializers/js/                 @pipelex/create-method-app, the npm initializer that writes the Node templates
initializers/cases.json          the cases every initializer's suite executes
webapp-js/                       the Next.js web app template — a complete project on its own
```

Planned directories, not here yet: `cli-js/`, `cli-python/` and `webapp-python/`, and `initializers/python/`, the initializer of the Python templates.

**A template directory is complete on its own.** It has its own `Makefile`, `CLAUDE.md`, `.gitignore`, `.github/workflows/` and checks, and works from inside its directory exactly as it will in a project. What it says about this repository sits in passages its bootstrap removes, or in files its bootstrap replaces, so a project never inherits a sentence about a mono-repo it is not in.

## The root gate

The root `Makefile` names the templates once, in `TEMPLATES`, and each of `install`, `check`, `lint`, `format`, `format-check`, `typecheck`, `test`, `agent-test`, `build`, `lock`, `clean`, `use-local`, `use-published` and `local-status` runs the same target in every template, stopping at the first failure. `use-local-form` and `use-published-form`, which switch the form kernel alone, run only in the templates `FORM_TEMPLATES` names, those that depend on `@pipelex/mthds-form`; make refuses to start when that list names a template `TEMPLATES` does not. `check` and `test` first run what belongs to the family:

- **`check-versions`** — `scripts/versions.mjs`. The family carries one version, in `VERSION`. Each template's manifest carries a version too, because a project keeps that manifest, and so does each initializer's, the version it publishes at; the check fails when any of them disagrees with `VERSION`. It reads a `package.json`, or the `[project]` table of a `pyproject.toml`. The initializers are named in the root `Makefile`'s `INITIALIZERS`.
- **`check-workflows`** — `scripts/workflows.mjs --check`, described in the next section.
- **Prettier over the root's own Markdown, scripts and JSON**, the initializers' included, with the root's `.prettierrc`. A template's files are formatted by that template, with its own configuration and exclusions, so the root's command leaves out every directory `TEMPLATES` names. The root has no `.prettierignore` on purpose: an editor opened at the root reads the ignore file at the workspace folder first, and one listing the templates would stop it formatting any of their files, while without one it finds each template's own.
- **`test-family`** — `node --test` over `scripts/*.test.mjs` and each initializer's `test/*.test.mjs`. It covers the root's scripts, runs each check against this repository itself, pins the `make create` contract described below, and runs the initializers' suites, which pack the templates from the working tree and write them.

The root has no package manager of its own. Its Prettier and Husky are the first template's installed binaries, which is why `make install` comes first.

## The workflow twins

GitHub reads a repository's workflows only from `.github/workflows/` at its root. A template's own workflows have to stay in its directory, because they travel into every project created from it, so they never run in this repository. The root therefore runs a **twin** of each: `.github/workflows/<template>-<file>`, rendered by `make workflows` from `<template>/.github/workflows/<file>`.

A twin is the source with these changes and no others: a header naming the source, the template's name added to the workflow's name and to each job's name, `defaults.run.working-directory` set to the template on every job, `cache-dependency-path` pointing at the template's `package-lock.json` after every npm `cache:` line, and `working-directory` set to the template as the first input of every setup-uv step. setup-uv reads everything from its working directory — the uv version, the Python, where the virtual environment goes, and the files its cache glob matches — and defaults to the repository root, where a twin would read none of the template's settings and cache against every template's lock. The rendering is a text transform rather than a YAML round trip, so the twin keeps the source's comments and layout.

The working directory reaches only `run:` steps, and GitHub resolves everything else from the repository root, so the rendering refuses a source it cannot carry faithfully rather than guessing: a quoted name, a job that already sets `defaults`, a job without an inline `runs-on` to set the working directory after (a block value, or a call to a reusable workflow), a flow mapping (`with: { … }`), a `cache:` input other than npm's whichever action takes it (setup-python's `pip` among them), a setup-uv step with no `with:` block to set its working directory in, a key named for a path, a file or a directory (`paths-ignore`, `node-version-file` and `working-directory` among them), a local action (`uses: ./…`), and `hashFiles`. An action input that holds a path under any other name is not recognised, so read a new workflow's twin before committing it.

`make check-workflows` renders every twin in memory and compares it with the file on disk. It reports a twin that is **missing**, one that is **stale** (its source changed, or the twin was edited by hand), and one that is **orphaned** (its source is gone), and `make workflows` fixes each of them. A workflow at the root that does not open with the rendering's header, such as `family-check.yml`, is hand-written and left alone, and a hand-written file that has a twin's name makes both commands refuse rather than overwrite it.

**So a workflow is edited in its template, then re-rendered, in the same commit.**

## The initializers

A project starts from a template through the initializer of the template's ecosystem, which writes the template into a directory, commits it as it came, and runs the copy's own `make create`:

```bash
npm create @pipelex/method-app@latest my-app -- --method ./receipt_review.mthds
make -C my-app serve
```

`initializers/js/` is `@pipelex/create-method-app`, the npm initializer of the Node templates, and its README is its npm page and the reference for its options, its git outcomes and its verdicts. An initializer is not a template: no project is a copy of one, so it is not in `TEMPLATES` and no template target runs in it. It is in `INITIALIZERS` instead, which `check-versions` and `test-family` read.

**It carries the templates it serves.** A template travels in the package as one generated file, `templates/<template>.pack`, built by `initializers/js/scripts/pack-templates.mjs` from `git ls-files <template>`: each tracked file's path, git's mode for it and its contents, behind a header naming the family's version and the commit it was packed from, the whole compressed with Node's `zlib`. npm could not ship the tree as a list of files, because `npm pack` never includes `package-lock.json` and applies each directory's `.gitignore` as exclusion rules. The pack refuses a symlink, a submodule and any mode but a plain or executable file. The packs are generated and gitignored: the package's `prepack` makes them with `--publish`, which also refuses a template with uncommitted changes and a `VERSION` that is not the package's, and `npm run pack-templates` makes them from the working tree as it stands, naming the source `<sha>-dirty` when the template has uncommitted changes. So `@X.Y.Z` writes exactly the X.Y.Z templates, the pristine commit names that version and the commit, and nothing is fetched from GitHub. The package has no dependency, and is plain `.mjs`, because Node strips no types under `node_modules`.

**Each initializer's table of templates is `templates.json` at its root**, which says which templates it serves, the extras each one's `make create` takes, and the command of the other ecosystem's initializer, named when a person asks one for the other's template (`refused: other-ecosystem`). JSON, so the root reads every initializer's table whatever its language: `scripts/initializers.test.mjs` fails when a template of `TEMPLATES` is served by no initializer or by more than one, and when a table's variables are not the `make create` contract's.

**`initializers/cases.json` is the table of cases every initializer executes**: destinations (missing, empty, a lone `.git` with and without history, a lone `.git` with a staged file and no commit, a `.DS_Store`, a file of the user's, spelled `.`, a name with a space), git states (none, inside another work tree, under a path that work tree ignores or re-includes, in one that ignores every file but no directory, inside a template's checkout, an identity only the enclosing repository holds, `--no-git`), flags, and the verdict each must print. The npm initializer's suite runs it now, and the Python one will, so the two print the same verdicts for the same situations.

## The version and the release

`VERSION` is the family's version, and the release reads it. The release skill, `.claude/skills/release/SKILL.md`, bumps `VERSION`, every template's manifest and every initializer's together, re-locks each template, writes the entry in the root `CHANGELOG.md`, and runs `make all`.

The merge to `main` publishes the initializer. `.github/workflows/release.yml`, hand-written rather than a twin, runs on the push: it reads the version from `initializers/js/package.json`, does nothing when npm already has it, asserts the changelog's entry, packs the templates with `--publish`, runs `make test-family`, publishes through npm trusted publishing with provenance, and tags the commit `vX.Y.Z`. It publishes with npm 11, the npm `family-check.yml` also installs, so the release never runs an npm the pull request checks have not: a new npm major reaches it only by an edit to both workflows. A later run that finds the version published but untagged backfills the tag on the commit npm recorded as the version's source, its `gitHead`, never on the commit that run stands on, and one run of the workflow goes at a time. npm authenticates the publish as the package's trusted publisher, registered on npmjs.com for `release.yml` by its filename, so renaming the workflow means registering it again; the release skill says how to recognise a publish npm refused and restore the registration. The templates themselves are never published: every template's manifest is private, and a template reaches a project through the initializer.

A template's own `CHANGELOG.md` only points at the root's. Its bootstrap replaces it with a project's first entry.

## The pre-commit hook

A template wires its hook with Husky's `prepare` script, which needs the repository's `.git` in the directory it runs in. Here, a template's `npm install` prints Husky's `.git can't be found` notice instead, and wires nothing. The root's `make install` runs Husky from the root, which sets git's hooks path to `.husky/_`, the same path a template sets when it is a repository of its own. The root's `.husky/pre-commit` then runs, for each template the commit touches, that template's own `.husky/pre-commit` from inside its directory, where lint-staged only sees that template's staged files.

The root's own files pass through no hook; `make check-family` holds them to Prettier, locally and in `family-check.yml`.

## The sibling packages

In the Pipelex workspace, the checkouts of the Pipelex packages a template depends on sit beside this repository, two levels above a template's directory: `pipelex-sdk-js` and `mthds-form` for `webapp-js`. A template's `make use-local` installs them from those checkouts, and `make use-local-form` installs the form kernel alone in a template that has one. Both look in the template's parent directory unless `SIBLINGS_DIR` says otherwise, and the root's targets of those names pass `SIBLINGS_DIR=../..`. Switching back with `make use-published`, or `make use-published-form` for the kernel alone, restores the version each template's lock file pins and rewrites nothing, so a switch never moves a range: that is what the bump skills below are for. `make local-status` says, package by package, whether a template is running a local build or the published release.

The names are the family's and not a registry's, so every template answers the same three targets whatever its packages are installed from. A template adds a target for one package alone only when it has a reason to switch that package separately, as `webapp-js` has for the form kernel.

## Moving the templates onto a newer package

`@pipelex/mthds-form` and `@pipelex/sdk` sit in a template's manifest as pre-1.0 caret ranges, which npm never resolves across a minor, so moving either is a deliberate edit. Each is moved from the root, the kernel by `.claude/skills/bump-mthds-form/` and the SDK by `.claude/skills/bump-sdk/`: a skill moves every template whose manifest lists its package in one change, runs the root gate, and writes the entry in the root changelog. Which files of a template a release can reach is the template's own knowledge, so a root skill reads it from that template — the kernel's from its `bump-mthds-form` skill, the SDK's from its `bump-sdk` skill and the call path its `CLAUDE.md` names. Those template skills travel into every project made from one, and are what a project runs. What stays at the root is the seam no project has: the code the scaffold emits, which is text in a template and compiled only once a project has been created from it.

## The create contract

The scaffold skill (`pipelex-scaffold`, in `pipelex-plugins`) and the initializers run a copy's `make create` with the variables they have: `METHOD`, `NAME`, `TITLE`, `DESCRIPTION`, `PIPE`, `AUTHOR_NAME`, `AUTHOR_EMAIL`, `REPO_URL`, `LICENSE`, `LICENSE_HOLDER`, `LICENSE_YEAR` and `DRY_RUN`. It passes them the same way whichever template it copied, so every template forwards each of them to its gesture the same way. `scripts/create-contract.test.mjs` runs `make -n create` in every template of `TEMPLATES` and fails when a template does not forward one of them, forwards it differently from the others, alters the value on its way, or forwards a variable that was left blank or only exported by the shell. A variable only one template's gesture takes, such as `webapp-js`'s `METHOD_NAME` and `LABEL`, is declared as that template's extra, and the test fails on a variable the `create` recipe reads that is declared nowhere. The variables and the extras are one list, in `scripts/create-contract.mjs`; an initializer's flags are named after them, and `scripts/initializers.test.mjs` holds each initializer's table to that list.

## Adding a template

A new template is a directory that works on its own, then joins the family:

1. It carries a `Makefile` with every target the root delegates to every template, a manifest whose version is the family's, a `CLAUDE.md`, and whatever its projects need, including its own `.github/workflows/` and, when it depends on `@pipelex/mthds-form` or on `@pipelex/sdk`, the `bump-mthds-form` and `bump-sdk` skills naming the files a release of each can reach, which the root's skills of those names read.
2. Its name joins `TEMPLATES` in the root `Makefile`, and `FORM_TEMPLATES` too when it depends on the form kernel, in which case its `Makefile` also answers `use-local-form` and `use-published-form`.
3. `make workflows` renders its twins, and the renderer's refusals say what to change in its workflows if it cannot. The renderer carries an npm cache and a setup-uv step into the template's directory; a template caching through anything else needs the renderer taught its lock file first.
4. Its `make create` forwards the shared variables as the other templates do, and its extras are declared in `scripts/create-contract.mjs`.
5. It joins the `templates.json` of its ecosystem's initializer, with the same extras, and exactly one initializer serves it; a template of an ecosystem with no initializer yet waits for one. A Node template also needs a plain `engines.node` floor (`">=22.12.0"`), which the initializer's preflight reads.
6. The release skill names its manifest under **Version files and the lock**, and the root `README.md` lists it.
7. If its hook is not a Husky hook, `.husky/pre-commit` learns to run it.
8. `make all` at the root is green.
