.DEFAULT_GOAL := help
.PHONY: help install hooks agent-check agent-test workflows check-workflows check-versions check-release-versions release-selection test-scripts

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
TEMPLATES := starter-js starter-python method-apps/webapp-js

# The release units, each held at or below VERSION by scripts/versions.mjs. A unit is a
# directory with its own manifest, or `dir:sub1,sub2` for one whose manifests ship as one
# and carry one version: the method apps' template and the initializer that packs it.
UNITS := js python starter-js starter-python method-apps:webapp-js,initializers/js

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

check-versions: ## Check that every unit's manifests carry one version, at or below VERSION
	@node scripts/versions.mjs $(UNITS)

check-release-versions: ## Check versions as a release pull request must: a unit ships at VERSION, with its changelog entry
	@node scripts/versions.mjs --release $(UNITS)

# The units a release proposes, and the hold-backs it refuses (docs/release-model.md). The root
# /release skill runs it with the open sprints' reading on stdin:
#
#     ledger sprint status --remote --json | make release-selection SPRINTS=- HOLD="starter-js"
release-selection: ## Propose the units a release ships; SPRINTS=<file, or - for stdin> from `ledger sprint status --remote --json`, HOLD="<unit>..." to hold units back
	@node scripts/release-selection.mjs $(if $(SPRINTS),--sprints $(SPRINTS)) $(foreach unit,$(HOLD),--hold $(unit)) $(UNITS)

test-scripts: ## Run the tests of the root's scripts, silent on success
	@OUTPUT=$$(node --test scripts/*.test.mjs 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi

agent-check: ## Run every package directory's agent-check, installing a directory first when it was never installed, then check the versions and the workflow twins
	$(call each,agent-check)
	@$(MAKE) --no-print-directory check-workflows check-versions

agent-test: ## Run every package directory's agent-test, installing a directory first when it was never installed, then the root scripts' tests, all silent on success
	$(call each,agent-test)
	@$(MAKE) --no-print-directory test-scripts

# ── This tree's SDK in the JavaScript templates ─────────────────────────────────────────────
# A template's own `make use-local` serves the project made from it: it installs the
# `pipelex-sdk` and `mthds-form` checkouts beside that project, the SDK being the `js/`
# directory of a `Pipelex/pipelex-sdk` checkout. Inside this repository that path names
# nothing. The SDK a maintainer means is this tree's own `js/`, in whichever worktree the work
# is, and a template, which looks for the SDK under a directory named `pipelex-sdk`, cannot
# name a worktree's. So the maintainers' switch is the root's (docs/layout.md, "This tree's
# SDK in the templates"):
#
# - `use-local` builds and packs `js/` and the workspace's `mthds-form` checkout, which sits
#   beside this repository's root whether that root is the main checkout or a worktree, and
#   installs both tarballs into each JavaScript template in ONE `npm install --no-save`, as
#   the templates' own targets do: a second `--no-save` install re-reconciles node_modules
#   against the lockfile and silently puts the first tarball back on its registry version.
#   The pack steps pass `--ignore-scripts` because each package's `prepare` would rebuild it,
#   which the build just before has done.
# - `use-published` puts back the versions each template's lockfile pins, `--no-save`, so
#   leaving local mode never rewrites a manifest or a lockfile: moving a range is the bump
#   skills' work.
# - `local-status` says, template by template, whether each package is a local tarball or
#   npm's, read from npm's hidden lockfile: the version cannot tell, since a local build
#   carries the version it will be published as.
#
# MTHDS_FORM_DIR=<dir> takes the form kernel from another checkout, such as a worktree of
# `mthds-form`, and IN=<dir> narrows both targets to the templates at or under that
# directory, as the method-app family's own `use-local` does with IN=method-apps.
.PHONY: use-local use-published local-status
# The templates that install `@pipelex/sdk` and `@pipelex/mthds-form` from npm.
JS_TEMPLATES := starter-js method-apps/webapp-js
MTHDS_FORM_DIR := ../mthds-form
LOCAL_PACKAGES := @pipelex/sdk @pipelex/mthds-form
in_dir = $(patsubst %/,%,$(IN))
switched = $(if $(in_dir),$(filter $(in_dir) $(in_dir)/%,$(JS_TEMPLATES)),$(JS_TEMPLATES))
refuse_empty_switch = @$(if $(switched),:,echo "ERROR: IN=$(IN) names none of the JavaScript templates: $(JS_TEMPLATES)."; exit 2)
# Where node_modules got each named package: `local` for a tarball, `npm` for the registry,
# `missing` when it is not installed. The method-app template's own `local-status` reads it
# the same way.
SOURCE_OF = node -e 'let p = {}; try { p = require("./node_modules/.package-lock.json").packages; } catch {} for (const n of process.argv.slice(1)) { const e = p["node_modules/" + n]; const r = e?.resolved; console.log(n, !r ? "missing" : r.startsWith("file:") ? "local" : "npm", e?.version ?? ""); }'

use-local: ## Install this tree's js/ and the workspace's mthds-form checkout into every JavaScript template (MTHDS_FORM_DIR=<dir>, IN=<dir> to change)
	$(refuse_empty_switch)
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

use-published: ## Put every JavaScript template back on the @pipelex/sdk and @pipelex/mthds-form versions its lockfile pins (IN=<dir> to narrow)
	$(refuse_empty_switch)
	@set -e; for t in $(switched); do \
		if [ ! -d "$$t/node_modules" ]; then echo "── $$t: not installed, nothing to restore"; continue; fi; \
		echo "── $$t: restoring the locked $(LOCAL_PACKAGES)"; \
		(cd "$$t" && \
		specs=$$(node -p 'const p = require("./package-lock.json").packages; process.argv.slice(1).map((n) => n + "@" + p["node_modules/" + n].version).join(" ")' $(LOCAL_PACKAGES)) && \
		for n in $(LOCAL_PACKAGES); do rm -rf "node_modules/$$n"; done && \
		npm install $$specs --no-save --silent); \
	done

local-status: ## Say, for every JavaScript template, whether @pipelex/sdk and @pipelex/mthds-form are local tarballs or npm's (IN=<dir> to narrow)
	$(refuse_empty_switch)
	@for t in $(switched); do echo "── $$t"; (cd "$$t" && $(SOURCE_OF) $(LOCAL_PACKAGES)); done
