# The family layout

`pipelex-method-apps` holds one template per shape and language. A project is a copy of one template directory, and nothing else from this repository ever reaches it. This document describes what the root adds around the templates, and why each piece is shaped the way it is.

## Why one repository

The templates are inputs to a generator gesture, not showcases: a person or a coding agent copies one out and runs its `make create`, and nobody browses a template that ships no method. Keeping them together buys one contract for the scaffold that drives them, one gate that runs all of them, one release with the rest of the repository, and changes that land in every template at once when the codegen contract or the SDK moves. What it costs is described below: workflows that the repository's root has to twin, a family gate that delegates, and an initializer that carries each template's tree, since a project is one directory of the repository rather than a clone of it.

GitHub's **Use this template** button is not the way in. It copies a whole repository, and a copy of a shell with no method in it is not an app anyone wanted.

## The layout

```
Makefile                         the family's gate: its own checks, then each template's targets
CHANGELOG.md                     the family's changelog
scripts/                         the family's own tooling (the create contract) and its tests
initializers/js/                 @pipelex/create-method-app, the npm initializer that writes the Node templates
initializers/cases.json          the cases every initializer's suite executes
webapp-js/                       the Next.js web app template — a complete project on its own
```

The repository's root, one level up, carries what serves every package of `pipelex-sdk`, the family included: the version (`VERSION`), the CI and the twins of the templates' workflows (`.github/workflows/`, described in the root `docs/ci.md`), the scripts that check every manifest against `VERSION` and render those twins (`scripts/`), the git hooks (`.githooks/`), the skills that move every template onto a newer form kernel or SDK (`.claude/skills/bump-mthds-form/`, `.claude/skills/bump-sdk/`), and the release.

Planned directories, not here yet: `cli-js/`, `cli-python/` and `webapp-python/`, and `initializers/python/`, the initializer of the Python templates.

**A template directory is complete on its own.** It has its own `Makefile`, `CLAUDE.md`, `.gitignore`, `.github/workflows/` and checks, and works from inside its directory exactly as it will in a project. What it says about this repository sits in passages its bootstrap removes, or in files its bootstrap replaces, so a project never inherits a sentence about a mono-repo it is not in.

## The family's gate

The family's `Makefile` names the templates once, in `TEMPLATES`, and each of `install`, `check`, `lint`, `format`, `format-check`, `typecheck`, `test`, `agent-test`, `build`, `lock`, `clean`, `use-published` and `local-status` runs the same target in every template, stopping at the first failure; `use-local` is the repository root's, narrowed to the family's templates (see "The sibling packages" below). `use-local-form` and `use-published-form`, which switch the form kernel alone, run only in the templates `FORM_TEMPLATES` names, those that depend on `@pipelex/mthds-form`; make refuses to start when that list names a template `TEMPLATES` does not. `check` and `test` first run what belongs to the family:

- **`check-family`** — Prettier over the family root's own Markdown, scripts and JSON, the initializers' included, with the family's `.prettierrc`. A template's files are formatted by that template, with its own configuration and exclusions, so the family's command leaves out every directory `TEMPLATES` names. The family root has no `.prettierignore` on purpose: an editor opened at the family root reads the ignore file at the workspace folder first, and one listing the templates would stop it formatting any of their files, while without one it finds each template's own.
- **`test-family`** — `node --test` over `scripts/*.test.mjs` and each initializer's `test/*.test.mjs`. It pins the `make create` contract described below, holds every initializer's table to it, and runs the initializers' suites, which pack the templates from the working tree and write them. The initializers are named in the family `Makefile`'s `INITIALIZERS`.

The family root has no package manager of its own. Its Prettier is the first template's installed binary, which is why `make install` comes first.

The repository's root checks the rest. Its `make check-versions` holds the family's manifests, the template's and the initializer's, to one version at or below the root `VERSION`, and its `make check-workflows` fails when a twin of a template's workflow is missing, stale or orphaned. The root's `agent-check` runs both after every directory's, and the root CI runs them, with the family's `check-family` and `test-family`, on every pull request.

## The workflow twins

GitHub reads a repository's workflows only from `.github/workflows/` at its root. A template's own workflows have to stay in its directory, because they travel into every project created from it, so they never run in this repository. The repository's root therefore runs **twins** of them, rendered by its `make workflows`, the root `scripts/workflows.mjs`, from `<template>/.github/workflows/<file>` into the root `.github/workflows/`, each named after the template's path with every `/` made a `-`:

- **The standalone twin**, `method-apps-webapp-js-<file>`, is a reusable workflow that the root CI, `.github/workflows/ci.yml`, calls. It extracts the template with `git archive` into a folder beside the checkout, gives the copy a repository of its own, and runs the template's jobs there, so the template installs from the registry with its own lockfile, exactly as a project made from it would.
- **The next-SDK twin**, `method-apps-webapp-js-next-sdk-<file>`, runs the same jobs on its own pull-request trigger, and installs `@pipelex/sdk` built from the same commit over the registry's copy after the template's install step. It is reported, not required: it warns an SDK pull request that would break the template without blocking it.

The rendering is a text transform rather than a YAML round trip, so a twin keeps the source's comments and layout, and it refuses a source it cannot carry faithfully rather than guessing. What it changes and what it refuses are listed at the head of the root `scripts/workflows.mjs`, and the root `docs/ci.md` describes how the root CI runs the twins.

The root's `make check-workflows` renders every twin in memory and compares it with the file on disk. It reports a twin that is **missing**, one that is **stale** (its source changed, or the twin was edited by hand), and one that is **orphaned** (its source is gone), and `make workflows` fixes each of them. A root workflow that does not open with the rendering's header, such as `ci.yml`, is hand-written and left alone, and a hand-written file that has a twin's name makes both commands refuse rather than overwrite it.

**So a workflow is edited in its template, then re-rendered at the repository's root, in the same commit.**

## The initializers

A project starts from a template through the initializer of the template's ecosystem, which writes the template into a directory, commits it as it came, and runs the copy's own `make create`:

```bash
npm create @pipelex/method-app@latest my-app -- --method ./receipt_review.mthds
make -C my-app serve
```

`initializers/js/` is `@pipelex/create-method-app`, the npm initializer of the Node templates, and its README is its npm page and the reference for its options, its git outcomes and its verdicts. An initializer is not a template: no project is a copy of one, so it is not in `TEMPLATES` and no template target runs in it. It is in `INITIALIZERS` instead, which `test-family` reads, and the repository root's `Makefile` names it in `UNITS` with the template, as one unit whose manifests carry one version.

**It carries the templates it serves.** A template travels in the package as one generated file, `templates/<template>.pack`, built by `initializers/js/scripts/pack-templates.mjs` from `git ls-files <template>`: each tracked file's path, git's mode for it and its contents, behind a header naming the repository's version, the root `VERSION`, and the commit it was packed from, the whole compressed with Node's `zlib`. npm could not ship the tree as a list of files, because `npm pack` never includes `package-lock.json` and applies each directory's `.gitignore` as exclusion rules. The pack refuses a symlink, a submodule and any mode but a plain or executable file. The packs are generated and gitignored: the package's `prepack` makes them with `--publish`, which also refuses a template with uncommitted changes and a repository whose root `VERSION` is not the package's version, and `npm run pack-templates` makes them from the working tree as it stands, naming the source `<sha>-dirty` when the template has uncommitted changes. So `@X.Y.Z` writes exactly the X.Y.Z templates, the pristine commit names that version and the commit, and nothing is fetched from GitHub. The package has no dependency, and is plain `.mjs`, because Node strips no types under `node_modules`.

**Each initializer's table of templates is `templates.json` at its root**, which says which templates it serves, the extras each one's `make create` takes, and the command of the other ecosystem's initializer, named when a person asks one for the other's template (`refused: other-ecosystem`). JSON, so the root reads every initializer's table whatever its language: `scripts/initializers.test.mjs` fails when a template of `TEMPLATES` is served by no initializer or by more than one, and when a table's variables are not the `make create` contract's.

**`initializers/cases.json` is the table of cases every initializer executes**: destinations (missing, empty, a lone `.git` with and without history, a lone `.git` with a staged file and no commit, a `.DS_Store`, a file of the user's, spelled `.`, a name with a space), git states (none, inside another work tree, under a path that work tree ignores or re-includes, in one that ignores every file but no directory, inside a template's checkout, an identity only the enclosing repository holds, `--no-git`), flags, and the verdict each must print. The npm initializer's suite runs it now, and the Python one will, so the two print the same verdicts for the same situations.

## The version and the release

The family has no version file of its own. The repository's root `VERSION` is the version of its latest release, and the family's manifests, `webapp-js/package.json` and `initializers/js/package.json`, ship as one unit: they carry one version, the one the family last shipped as, at or below `VERSION`, which the root's `make check-versions` holds them to. A release of the family is a release of the whole `pipelex-sdk` repository, cut from its root: when it ships the family, it moves both manifests to the release's version, re-locks the template, writes the entry in the family's `CHANGELOG.md`, the one in this directory, and runs `make all`. The root `docs/release-model.md` describes the model.

A release that ships the family publishes the initializer through the repository's release workflow, the root's `.github/workflows/release.yml`, from the release's tag, as the root `docs/release-model.md` describes. The workflow packs the templates with `initializers/js/scripts/pack-templates.mjs --publish`, which refuses a template with uncommitted changes and a repository `VERSION` other than the initializer's version, runs the family's tests, and then packs the package with `npm pack --ignore-scripts`, so the package's `prepack` does not run there and the packs it carries are the ones the tests read. The templates themselves are never published: every template's manifest is private, and a template reaches a project through the initializer.

A template's own `CHANGELOG.md` only points at the family's. Its bootstrap replaces it with a project's first entry.

## The pre-commit hook

A template wires its hook with Husky's `prepare` script, which needs the repository's `.git` in the directory it runs in. Here, a template's `npm install` prints Husky's `.git can't be found` notice instead, and wires nothing. The repository root's `make install` points git at the root's `.githooks/`, whose `pre-commit` runs, for each template the commit touches, that template's own `.husky/pre-commit` from inside its directory, where lint-staged only sees that template's staged files.

The family root's own files pass through no hook; `make check-family` holds them to Prettier, locally and in the root CI.

## The sibling packages

A template's `make use-local` installs the Pipelex packages it depends on from checkouts beside the project made from it, and `make use-local-form` installs the form kernel alone in a template that has one. For `webapp-js` those are a checkout of `Pipelex/pipelex-sdk`, whose `js/` directory is `@pipelex/sdk`, and one of `Pipelex/mthds-form`, looked for in the template's parent directory unless `SIBLINGS_DIR` says otherwise.

Here the SDK is this repository's own `js/`, in whichever worktree the work is, and a template's layout cannot name a worktree's. So the family's `make use-local` is the repository root's, run with `IN=method-apps`: it builds and packs this tree's `js/` and the workspace's `mthds-form` checkout, which sits beside the repository's root, and installs both into every template of the family (the root's [`docs/layout.md`](../../docs/layout.md) describes it). The family's `make use-local-form` passes `SIBLINGS_DIR=../../..`, the workspace root seen from a template's directory, so it installs the workspace's form kernel alone. Switching back with `make use-published`, or `make use-published-form` for the kernel alone, restores the version each template's lock file pins and rewrites nothing, so a switch never moves a range: that is what the bump skills below are for. `make local-status` says, package by package, whether a template is running a local build or the published release.

The names are the family's and not a registry's, so every template answers the same three targets whatever its packages are installed from. A template adds a target for one package alone only when it has a reason to switch that package separately, as `webapp-js` has for the form kernel.

## Moving the templates onto a newer package

`@pipelex/mthds-form` and `@pipelex/sdk` sit in a template's manifest as pre-1.0 caret ranges, which npm never resolves across a minor, so moving either is a deliberate edit. Each is moved from the repository's root, the kernel by its `.claude/skills/bump-mthds-form/` and the SDK by its `.claude/skills/bump-sdk/`, which move every template of the repository, this family's and the starters alike: a skill moves every template whose manifest lists its package in one change, runs each moved template's gate, and writes the entry in each moved package's changelog, this family's `CHANGELOG.md` for `webapp-js`. Which files of a template a release can reach is the template's own knowledge, so a root skill reads it from that template — the kernel's from its `bump-mthds-form` skill, the SDK's from its `bump-sdk` skill and the call path its `CLAUDE.md` names. Those template skills travel into every project made from one, and are what a project runs. What stays at the root is the seam no project has: the code the scaffold emits, which is text in a template and compiled only once a project has been created from it.

## The create contract

The scaffold skill (`pipelex-scaffold`, in `pipelex-plugins`) and the initializers run a copy's `make create` with the variables they have: `METHOD`, `NAME`, `TITLE`, `DESCRIPTION`, `PIPE`, `AUTHOR_NAME`, `AUTHOR_EMAIL`, `REPO_URL`, `LICENSE`, `LICENSE_HOLDER`, `LICENSE_YEAR` and `DRY_RUN`. It passes them the same way whichever template it copied, so every template forwards each of them to its gesture the same way. `scripts/create-contract.test.mjs` runs `make -n create` in every template of `TEMPLATES` and fails when a template does not forward one of them, forwards it differently from the others, alters the value on its way, or forwards a variable that was left blank or only exported by the shell. A variable only one template's gesture takes, such as `webapp-js`'s `METHOD_NAME` and `LABEL`, is declared as that template's extra, and the test fails on a variable the `create` recipe reads that is declared nowhere. The variables and the extras are one list, in `scripts/create-contract.mjs`; an initializer's flags are named after them, and `scripts/initializers.test.mjs` holds each initializer's table to that list.

## Adding a template

A new template is a directory that works on its own, then joins the family:

1. It carries a `Makefile` with every target the family's gate delegates to every template, a manifest that carries the family's version, a `CLAUDE.md`, and whatever its projects need, including its own `.github/workflows/` and, when it depends on `@pipelex/mthds-form` or on `@pipelex/sdk`, the `bump-mthds-form` and `bump-sdk` skills naming the files a release of each can reach, which the root's skills of those names read.
2. Its name joins `TEMPLATES` in the family's `Makefile`, and `FORM_TEMPLATES` too when it depends on the form kernel, in which case its `Makefile` also answers `use-local-form` and `use-published-form`. In the repository root's `Makefile`, its path joins `TEMPLATES`, which renders its twins, the `method-apps` unit of `UNITS`, which holds its version with the family's, and `JS_TEMPLATES` when it installs `@pipelex/sdk` and `@pipelex/mthds-form` from npm, which the root's `use-local`, and so the family's, switches to this tree's SDK.
3. `make workflows` at the repository's root renders its twins, and the renderer's refusals say what to change in its workflows if it cannot. The renderer points an npm cache at the template's lock file; a template caching through anything else needs the renderer taught its lock file first. The root CI, `.github/workflows/ci.yml`, calls each of its standalone twins.
4. Its `make create` forwards the shared variables as the other templates do, and its extras are declared in `scripts/create-contract.mjs`.
5. It joins the `templates.json` of its ecosystem's initializer, with the same extras, and exactly one initializer serves it; a template of an ecosystem with no initializer yet waits for one. A Node template also needs a plain `engines.node` floor (`">=22.12.0"`), which the initializer's preflight reads.
6. The family's `README.md` lists it.
7. If its hook is not a Husky hook, the repository root's `.githooks/pre-commit` learns to run it.
8. `make all` at the family root is green, and so are `make check-workflows check-versions test-scripts` at the repository's root.
