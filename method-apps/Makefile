.PHONY: help install hooks check check-family check-versions check-workflows workflows lint format format-check typecheck test test-family agent-test build all lock clean use-local use-local-form use-published use-published-form local-status ul un

# The family's root gate. Each template is a directory with its own Makefile,
# copied out whole into the projects created from it, so every target here
# either belongs to the family — its one version, the root twins of the
# templates' workflows, the formatting of the root's own files — or runs the
# same target in every template directory, stopping at the first failure.
#
# A new template joins the family by being named here. docs/family.md says what
# else it needs.
TEMPLATES := webapp-js

# The templates that depend on the form kernel, @pipelex/mthds-form, and so
# answer the targets that switch it alone. Each is also named in TEMPLATES.
FORM_TEMPLATES := webapp-js
$(if $(filter-out $(TEMPLATES),$(FORM_TEMPLATES)),$(error FORM_TEMPLATES names $(filter-out $(TEMPLATES),$(FORM_TEMPLATES)), which TEMPLATES does not))

# The family's initializers, each a package that writes the templates of its
# ecosystem into a new project (docs/family.md, "The initializers"). They are
# not templates: no project is a copy of one, so no template target runs in
# them, but each carries the family's version and its tests run with the
# root's.
INITIALIZERS := initializers/js

# The root's own tooling borrows the first template's installed Prettier and
# Husky, so the root needs no package manager of its own.
TOOLS := webapp-js/node_modules/.bin

# The root's own Markdown, scripts and JSON, with every template left out: a
# template formats its own files, with its own configuration and exclusions.
# The exclusions are patterns here rather than a root .prettierignore, which an
# editor opened at the root would apply to the templates' files too.
ROOT_FORMATTED := "**/*.{md,mjs,json}" $(foreach t,$(TEMPLATES),"!$(t)/**")

# Run `make <target>` in each of the templates listed, naming each one as it
# starts. The leading `+` marks the line as a recursive make, which `$(MAKE)`
# inside a variable does not: without it, `make -n` would print the loop instead
# of descending, and the sub-makes would get no share of `-j`.
each_of = +@set -e; for t in $(1); do echo "── $$t: make $(2)"; $(MAKE) --no-print-directory -C "$$t" $(2); done
# Run `make <target>` in every template.
each = $(call each_of,$(TEMPLATES),$(1))

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install every template's dependencies, then wire the pre-commit hook
	$(call each,install)
	@$(MAKE) --no-print-directory hooks

# Husky, run from the root, points git at .husky/_ here — the same hooks path a
# template sets when it is a repository of its own, so the setting agrees with
# every checkout of this repository. The root's .husky/pre-commit runs each
# template's own hook from inside that template.
hooks: ## Wire the root pre-commit hook, which runs each template's own
	@[ -x $(TOOLS)/husky ] || { echo "Husky is not installed: run make install first."; exit 1; }
	$(TOOLS)/husky

check: check-family ## Check the family, then run every template's check (lint, format, typecheck, codegen)
	$(call each,check)

check-family: check-versions check-workflows ## Check what belongs to the family: its version, the workflow twins, the root's formatting (initializers included)
	@[ -x $(TOOLS)/prettier ] || { echo "Prettier is not installed: run make install first."; exit 1; }
	$(TOOLS)/prettier --check $(ROOT_FORMATTED)

check-versions: ## Check that every template and initializer carries the version in VERSION
	@node scripts/versions.mjs $(TEMPLATES) $(INITIALIZERS)

check-workflows: ## Check that the root twin of every template workflow is current
	@node scripts/workflows.mjs --check $(TEMPLATES)

workflows: ## Render the root twin of every template workflow into .github/workflows/
	@node scripts/workflows.mjs $(TEMPLATES)

lint: ## Run every template's linter
	$(call each,lint)

format: ## Format the root's own files, then every template's
	$(TOOLS)/prettier --write $(ROOT_FORMATTED)
	$(call each,format)

format-check: ## Check the formatting of the root's own files, then every template's
	$(TOOLS)/prettier --check $(ROOT_FORMATTED)
	$(call each,format-check)

typecheck: ## Run every template's type checks
	$(call each,typecheck)

# The root's scripts and every initializer, each suite in its own test file.
FAMILY_TESTS := "scripts/*.test.mjs" $(foreach i,$(INITIALIZERS),"$(i)/test/*.test.mjs")

test-family: ## Run the tests of the root's own scripts and of every initializer
	node --test $(FAMILY_TESTS)

test: test-family ## Run the family's tests, then every template's
	$(call each,test)

agent-test: ## Run every test, silent on success (for agents)
	@OUTPUT=$$(node --test $(FAMILY_TESTS) 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi
	$(call each,agent-test)

build: ## Build every template
	$(call each,build)

all: check test build ## Full validation: the family's checks and tests, then every template's check, test and build

lock: ## Regenerate every template's lock file without installing
	$(call each,lock)

clean: ## Remove every template's build artifacts and caches
	$(call each,clean)

# The sibling packages sit in the workspace this repository is checked out in,
# two levels above a template's directory. A template's own `make use-local`
# takes SIBLINGS_DIR for exactly this; to use siblings anywhere else, run the
# target inside the template directory with SIBLINGS_DIR set there. The names
# are the family's, whatever registry a template's packages come from.
use-local: ## Install each template's Pipelex packages from the workspace's checkouts
	$(call each,use-local SIBLINGS_DIR=../..)

use-local-form: ## Install the workspace's mthds-form checkout alone into every template that uses the form kernel
	$(call each_of,$(FORM_TEMPLATES),use-local-form SIBLINGS_DIR=../..)

use-published: ## Restore the Pipelex packages each template's lock file pins
	$(call each,use-published)

use-published-form: ## Restore the @pipelex/mthds-form version the lock file pins, in every template that uses the form kernel
	$(call each_of,$(FORM_TEMPLATES),use-published-form)

local-status: ## Say, for every template, whether each Pipelex package comes from a sibling checkout or from its registry
	$(call each,local-status)

ul: use-local ## Alias for use-local
un: use-published ## Alias for use-published
