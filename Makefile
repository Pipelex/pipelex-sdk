.DEFAULT_GOAL := help
.PHONY: help install hooks agent-check agent-test workflows check-workflows check-versions check-release-versions test-scripts

# The root gate. Each package directory is a project of its own, with its own Makefile,
# manifest and lockfile, installed from the registries exactly as its standalone repository
# was (docs/layout.md). So every target here either belongs to the root, such as the git
# hooks, the repository's version and the workflow twins, or runs the same target in every
# package directory, stopping at the first failure.
#
# Nothing here installs a package. A worktree is provisioned with `make install`, which only
# wires the hooks, and each directory's `agent-check` and `agent-test` install that directory
# first when its node_modules or .venv is missing, so a worktree pays only for the
# directories its work touches. The root's own targets need only Node: its scripts have no
# dependency. To check one directory, run its own target:
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

test-scripts: ## Run the tests of the root's scripts, silent on success
	@OUTPUT=$$(node --test scripts/*.test.mjs 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi

agent-check: ## Run every package directory's agent-check, installing a directory first when it was never installed, then check the versions and the workflow twins
	$(call each,agent-check)
	@$(MAKE) --no-print-directory check-workflows check-versions

agent-test: ## Run every package directory's agent-test, installing a directory first when it was never installed, then the root scripts' tests, all silent on success
	$(call each,agent-test)
	@$(MAKE) --no-print-directory test-scripts
