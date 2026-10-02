.DEFAULT_GOAL := help
.PHONY: help install hooks agent-check agent-test

# The root gate. Each package directory is a project of its own, with its own Makefile,
# manifest and lockfile, installed from the registries exactly as its standalone repository
# was (docs/layout.md). So every target here either belongs to the root, such as the git
# hooks, or runs the same target in every package directory, stopping at the first failure.
#
# Nothing here installs a package. A worktree is provisioned with `make install`, which only
# wires the hooks, and each directory's `agent-check` and `agent-test` install that directory
# first when its node_modules or .venv is missing, so a worktree pays only for the
# directories its work touches. To check one directory, run its own target:
#
#     make -C js agent-check
PACKAGES := js python starter-js starter-python method-apps

# Run `make <target>` in each package directory, naming each one as it starts. The leading
# `+` marks the line as a recursive make, so `make -n` descends rather than printing the loop.
each = +@set -e; for d in $(PACKAGES); do echo "── $$d: make $(1)"; $(MAKE) --no-print-directory -C "$$d" $(1); done

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Package directories: $(PACKAGES). Run \`make -C <dir> <target>\` to work in one of them."

install: hooks ## Wire the git hooks; each package directory installs itself the first time its checks run

# Git runs the hooks in .githooks/ for every worktree of this repository. The pre-commit hook
# runs each template's own hook from inside that template, since a template's Husky set-up
# finds no .git in its directory here and wires nothing (docs/layout.md, "The hooks").
hooks: ## Point git at the repository's hooks in .githooks/
	@git config core.hooksPath .githooks
	@echo "git hooks: core.hooksPath is .githooks"

agent-check: ## Run every package directory's agent-check, installing a directory first when it was never installed
	$(call each,agent-check)

agent-test: ## Run every package directory's agent-test, silent on success, installing a directory first when it was never installed
	$(call each,agent-test)
