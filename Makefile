.DEFAULT_GOAL := help
.PHONY: help install hooks agent-check agent-test workflows check-workflows lint-workflows install-linters check-versions check-release-versions release-selection test-scripts

# The root gate. Each package directory is a project of its own, with its own Makefile,
# manifest and lockfile, installed from the registries exactly as its standalone repository
# was (docs/layout.md). So every target here either belongs to the root, such as the git
# hooks, the repository's version and the workflow twins, or runs the same target in every
# package directory, stopping at the first failure.
#
# Nothing here installs a package but `use-local` and `use-published`, which install into the
# templates they switch, `use-local` installing `js/` first when it was never installed. A
# worktree is provisioned with `make install`, which only wires the hooks, and
# each directory's `agent-check` and `agent-test` install that directory first when its
# node_modules or .venv is missing, so a worktree pays only for the directories its work
# touches. The root's own targets need only Node: its scripts have no dependency. To check
# one directory, run its own target:
#
#     make -C js agent-check
PACKAGES := js python starter-js starter-python method-apps

# The templates, each a directory every file of which ships to the projects made from it.
# GitHub never runs a template's own workflows here, so scripts/workflows.mjs renders root
# twins of them into .github/workflows/ (docs/ci.md).
TEMPLATES := starter-js starter-python method-apps/webapp-js method-apps/cli-python

# The release units, each held at or below VERSION by scripts/versions.mjs. A unit is a
# directory with its own manifest, or `dir:sub1,sub2` for one whose manifests ship as one
# and carry one version: the method apps' templates and the initializer that packs them.
UNITS := js python starter-js starter-python method-apps:webapp-js,cli-python,initializers/js

# The READMEs whose copy-out command copies the template beside them out of a release's tag,
# as one does while no initializer serves that template. A release checks the `TAG=` each one
# sets: it must name a release that holds the template, one already tagged or this release
# when the unit holding the README ships in it (docs/release-model.md). A README leaves the
# list when an initializer serves its template.
COPY_OUTS := method-apps/cli-python/README.md

# Run `make <target>` in each package directory, naming each one as it starts. The leading
# `+` marks the line as a recursive make, so `make -n` descends rather than printing the loop.
each = +@set -e; for d in $(PACKAGES); do echo "── $$d: make $(1)"; $(MAKE) --no-print-directory -C "$$d" $(1); done

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Package directories: $(PACKAGES). Run \`make -C <dir> <target>\` to work in one of them."

install: hooks ## Wire the git hooks; each package directory installs itself the first time its checks run

# Git runs the hooks in .githooks/ for every worktree of this repository. The pre-commit hook
# runs each template's own hook from inside that template, since a template's Husky set-up
# finds no .git in its directory here and wires nothing (docs/layout.md, "The hooks").
hooks: ## Point git at the repository's hooks in .githooks/
	@git config core.hooksPath .githooks
	@echo "git hooks: core.hooksPath is .githooks"

workflows: ## Render the root twins of every template's workflows into .github/workflows/
	@node scripts/workflows.mjs $(TEMPLATES)

check-workflows: ## Check that every root twin of a template workflow is current
	@node scripts/workflows.mjs --check $(TEMPLATES)

# actionlint reads every workflow, the root's and each template's own, so a broken expression
# or step in a workflow no pull request runs, such as release.yml or mirrors.yml, is caught on
# the pull request that makes it (docs/ci.md). It runs the shellcheck it finds on the PATH over
# the `run:` scripts. CI runs exactly the versions pinned here, which `install-linters`
# fetches from each project's release and checks against the SHA-256 recorded here, so a new
# runner image cannot change the verdict; a maintainer's own tools are used as they are, and a
# version that differs is named.
ACTIONLINT_VERSION := 1.7.12
ACTIONLINT_LINUX_AMD64_SHA256 := 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
SHELLCHECK_VERSION := 0.11.0
SHELLCHECK_LINUX_AMD64_SHA256 := b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6
WORKFLOW_FILES = $(wildcard .github/workflows/*.yml .github/workflows/*.yaml) $(foreach t,$(TEMPLATES),$(wildcard $(t)/.github/workflows/*.yml $(t)/.github/workflows/*.yaml))

lint-workflows: ## Lint the root's workflows and every template's own with actionlint and shellcheck
	@command -v actionlint >/dev/null 2>&1 || { echo "actionlint is not installed: brew install actionlint shellcheck, or on Linux x86-64 make install-linters LINTERS_DIR=<dir>"; exit 1; }
	@version=$$(actionlint -version | head -n 1); [ "$$version" = "$(ACTIONLINT_VERSION)" ] || echo "note: this is actionlint $$version, and CI runs $(ACTIONLINT_VERSION)"
	@if command -v shellcheck >/dev/null 2>&1; then \
		version=$$(shellcheck --version | sed -n 's/^version: //p'); [ "$$version" = "$(SHELLCHECK_VERSION)" ] || echo "note: this is shellcheck $$version, and CI runs $(SHELLCHECK_VERSION)"; \
	else echo "note: shellcheck is not installed, so the run: scripts are not checked here, and CI checks them"; fi
	@actionlint $(WORKFLOW_FILES)

install-linters: ## Install the actionlint and shellcheck CI runs, for Linux x86-64, into LINTERS_DIR, each checked against its SHA-256
	@test -n "$(LINTERS_DIR)" || { echo "name the directory: make install-linters LINTERS_DIR=<dir>"; exit 1; }
	@mkdir -p "$(LINTERS_DIR)"
	@curl -fsSL -o "$(LINTERS_DIR)/actionlint.tar.gz" "https://github.com/rhysd/actionlint/releases/download/v$(ACTIONLINT_VERSION)/actionlint_$(ACTIONLINT_VERSION)_linux_amd64.tar.gz"
	@echo "$(ACTIONLINT_LINUX_AMD64_SHA256)  $(LINTERS_DIR)/actionlint.tar.gz" | sha256sum --check --quiet -
	@tar -xzf "$(LINTERS_DIR)/actionlint.tar.gz" -C "$(LINTERS_DIR)" actionlint
	@curl -fsSL -o "$(LINTERS_DIR)/shellcheck.tar.gz" "https://github.com/koalaman/shellcheck/releases/download/v$(SHELLCHECK_VERSION)/shellcheck-v$(SHELLCHECK_VERSION).linux.x86_64.tar.gz"
	@echo "$(SHELLCHECK_LINUX_AMD64_SHA256)  $(LINTERS_DIR)/shellcheck.tar.gz" | sha256sum --check --quiet -
	@tar -xzf "$(LINTERS_DIR)/shellcheck.tar.gz" -C "$(LINTERS_DIR)" --strip-components=1 "shellcheck-v$(SHELLCHECK_VERSION)/shellcheck"
	@rm "$(LINTERS_DIR)/actionlint.tar.gz" "$(LINTERS_DIR)/shellcheck.tar.gz"
	@echo "actionlint $$("$(LINTERS_DIR)/actionlint" -version | head -n 1) and shellcheck $$("$(LINTERS_DIR)/shellcheck" --version | sed -n 's/^version: //p') installed in $(LINTERS_DIR)"

check-versions: ## Check that every unit's manifests carry one version, at or below VERSION
	@node scripts/versions.mjs $(UNITS)

check-release-versions: ## Check versions as a release pull request must: a unit ships at VERSION, with its changelog entry, and each copy-out names a release holding its template
	@node scripts/versions.mjs --release $(foreach file,$(COPY_OUTS),--copy-out $(file)) $(UNITS)

# The units a release proposes, and the hold-backs it refuses (docs/release-model.md). The root
# /release skill runs it with the open sprints' reading on stdin:
#
#     ledger sprint status --remote --json | make release-selection SPRINTS=- HOLD="starter-js"
release-selection: ## Propose the units a release ships; SPRINTS=<file, or - for stdin> from `ledger sprint status --remote --json`, HOLD="<unit>..." to hold units back
	@node scripts/release-selection.mjs $(if $(SPRINTS),--sprints $(SPRINTS)) $(foreach unit,$(HOLD),--hold $(unit)) $(UNITS)

test-scripts: ## Run the tests of the root's scripts, silent on success
	@OUTPUT=$$(node --test scripts/*.test.mjs 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi

agent-check: ## Run every package directory's agent-check, installing a directory first when it was never installed, then check the versions, the workflow twins and, when actionlint is installed, the workflows' lint
	$(call each,agent-check)
	@$(MAKE) --no-print-directory check-workflows check-versions
	@if command -v actionlint >/dev/null 2>&1; then $(MAKE) --no-print-directory lint-workflows; else echo "actionlint is not installed, so the workflows were not linted here; CI lints them"; fi

agent-test: ## Run every package directory's agent-test, installing a directory first when it was never installed, then the root scripts' tests, all silent on success
	$(call each,agent-test)
	@$(MAKE) --no-print-directory test-scripts

# ── This tree's SDK in the templates ───────────────────────────────────────────────────────
# A template's own `make use-local` serves the project made from it: it installs the Pipelex
# checkouts beside that project, the SDK being the `js/` or `python/` directory of a
# `Pipelex/pipelex-sdk` checkout. Inside this repository that path names nothing. The SDK a
# maintainer means is this tree's own, in whichever worktree the work is, and a template, which
# looks for the SDK under a directory named `pipelex-sdk`, cannot name a worktree's. So the
# maintainers' switch is the root's (docs/layout.md, "This tree's SDK in the templates"), and it
# has one arm per ecosystem:
#
# - In the JavaScript templates, `use-local` builds and packs `js/` and the workspace's
#   `mthds-form` checkout, which sits beside this repository's root whether that root is the
#   main checkout or a worktree, and installs both tarballs into each template in ONE
#   `npm install --no-save`, as the templates' own targets do: a second `--no-save` install
#   re-reconciles node_modules against the lockfile and silently puts the first tarball back on
#   its registry version. The pack steps pass `--ignore-scripts` because each package's
#   `prepare` would rebuild it, which the build just before has done.
# - In the Python templates, `use-local` runs the template's own target with SDK_DIR naming this
#   tree's `python/` and MTHDS_DIR the workspace's `mthds-python` checkout, which installs both
#   as editable packages in one `uv pip install`, the `mthds` checkout only when it is there.
#   Editable means an edit to either takes effect at once, with no re-run.
# - `use-published` puts back the versions each template's lockfile pins, without rewriting a
#   manifest or a lockfile: moving a range or a floor is the bump skills' work.
# - `local-status` says, template by template, whether each package is a local build or the
#   registry's: the version cannot tell, since a local build carries the version it will be
#   published as.
#
# MTHDS_FORM_DIR=<dir> and MTHDS_PYTHON_DIR=<dir> take the form kernel and `mthds` from another
# checkout, such as a worktree of either, and IN=<dir> narrows the three targets to the
# templates at or under that directory, as the method-app family's own `use-local` does with
# IN=method-apps.
.PHONY: use-local use-published local-status
# The templates that install `@pipelex/sdk` and `@pipelex/mthds-form` from npm.
JS_TEMPLATES := starter-js method-apps/webapp-js
# The templates that install `pipelex-sdk` and `mthds` from PyPI, and whose own `use-local`
# takes SDK_DIR and MTHDS_DIR. `starter-python` has no `use-local` of its own, so it is not here.
PY_TEMPLATES := method-apps/cli-python
MTHDS_FORM_DIR := ../mthds-form
MTHDS_PYTHON_DIR := ../mthds-python
LOCAL_PACKAGES := @pipelex/sdk @pipelex/mthds-form
in_dir = $(patsubst %/,%,$(IN))
narrowed = $(if $(in_dir),$(filter $(in_dir) $(in_dir)/%,$(1)),$(1))
switched = $(call narrowed,$(JS_TEMPLATES))
switched_py = $(call narrowed,$(PY_TEMPLATES))
refuse_empty_switch = @$(if $(switched)$(switched_py),:,echo "ERROR: IN=$(IN) names none of the templates the switch serves: $(JS_TEMPLATES) $(PY_TEMPLATES)."; exit 2)
# Where node_modules got each named package: `local` for a tarball, `npm` for the registry,
# `missing` when it is not installed. The method-app template's own `local-status` reads it
# the same way.
SOURCE_OF = node -e 'let p = {}; try { p = require("./node_modules/.package-lock.json").packages; } catch {} for (const n of process.argv.slice(1)) { const e = p["node_modules/" + n]; const r = e?.resolved; console.log(n, !r ? "missing" : r.startsWith("file:") ? "local" : "npm", e?.version ?? ""); }'

use-local: ## Install this tree's SDK, and the workspace's mthds-form or mthds-python checkout, into every template (MTHDS_FORM_DIR=<dir>, MTHDS_PYTHON_DIR=<dir>, IN=<dir> to change)
	$(refuse_empty_switch)
	@$(if $(switched),$(MAKE) --no-print-directory use-local-js,:)
	@set -e; for t in $(switched_py); do \
		echo "── $$t: installing this tree's python/, and $(MTHDS_PYTHON_DIR) where that checkout exists, as editable packages"; \
		$(MAKE) --no-print-directory -C "$$t" use-local SDK_DIR="$(CURDIR)/python" MTHDS_DIR="$(abspath $(MTHDS_PYTHON_DIR))"; \
	done

.PHONY: use-local-js
use-local-js:
	@[ -d "$(MTHDS_FORM_DIR)/node_modules" ] || { echo "ERROR: $(MTHDS_FORM_DIR) is not an installed mthds-form checkout. Clone Pipelex/mthds-form beside this repository and run 'npm ci' in it, or name another checkout with MTHDS_FORM_DIR=<dir>."; exit 1; }
	@$(MAKE) --no-print-directory -C js install-if-missing
	@set -e; for t in $(switched); do $(MAKE) --no-print-directory -C "$$t" install-if-missing; done
	@DEST=$$(mktemp -d) && trap 'rm -rf "$$DEST"' EXIT && \
	for d in js "$(MTHDS_FORM_DIR)"; do \
		echo "Building and packing $$d..." && (cd "$$d" && npm run build && npm pack --silent --ignore-scripts --pack-destination "$$DEST" >/dev/null) || exit 1; \
	done && \
	for t in $(switched); do \
		echo "── $$t: installing the local $(LOCAL_PACKAGES)" && \
		(cd "$$t" && for n in $(LOCAL_PACKAGES); do rm -rf "node_modules/$$n"; done && npm install "$$DEST"/*.tgz --no-save --silent) || exit 1; \
	done
	@echo "This tree's js/ and $(MTHDS_FORM_DIR) are installed in: $(switched). Re-run after every edit; 'make use-published' switches back."

use-published: ## Put every template back on the Pipelex package versions its lockfile pins (IN=<dir> to narrow)
	$(refuse_empty_switch)
	@set -e; for t in $(switched); do \
		if [ ! -d "$$t/node_modules" ]; then echo "── $$t: not installed, nothing to restore"; continue; fi; \
		echo "── $$t: restoring the locked $(LOCAL_PACKAGES)"; \
		(cd "$$t" && \
		specs=$$(node -p 'const p = require("./package-lock.json").packages; process.argv.slice(1).map((n) => n + "@" + p["node_modules/" + n].version).join(" ")' $(LOCAL_PACKAGES)) && \
		for n in $(LOCAL_PACKAGES); do rm -rf "node_modules/$$n"; done && \
		npm install $$specs --no-save --silent); \
	done
	@set -e; for t in $(switched_py); do echo "── $$t"; $(MAKE) --no-print-directory -C "$$t" use-published; done

local-status: ## Say, for every template, whether its Pipelex packages are local builds or the registry's (IN=<dir> to narrow)
	$(refuse_empty_switch)
	@for t in $(switched); do echo "── $$t"; (cd "$$t" && $(SOURCE_OF) $(LOCAL_PACKAGES)); done
	@for t in $(switched_py); do echo "── $$t"; $(MAKE) --no-print-directory -C "$$t" local-status; done
