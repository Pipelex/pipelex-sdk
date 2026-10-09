.DEFAULT_GOAL := help
.PHONY: help install install-if-missing check check-lock c test t test-e2e te test-pack clean build rebuild dev pack all depcruise agent-check agent-test use-local use-npm ul un

# The workspace's mthds-js checkout, for live mthds development (see use-local / use-npm). It
# sits beside this repository's root, the main checkout or a worktree alike, two levels up.
MTHDS_JS_DIR := ../../mthds-js

# Colors
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m

PACKAGE_NAME := @pipelex/sdk

# Helper function to print titles
define PRINT_TITLE
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo "$(BLUE)$(1)$(NC)"
	@echo "$(BLUE)━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━$(NC)"
	@echo ""
endef

define HELP
Manage $(PACKAGE_NAME) located in $(CURDIR).
Usage:

make install    - Install the dependencies from the lockfile (npm ci, which never rewrites it)
make all        - Clean, check, and test
make check      - Run quality checks, excluding tests
make check-lock - Fail when package-lock.json is not a valid install tree
make test       - Run the test suite
make test-e2e   - Run e2e tests against a live pipelex-api [PIPELEX_E2E_BASE_URL=...]
make test-pack  - Pack the package and run its pipelex-sdk command from the tarball through npx
make agent-check - Run the quality checks, installing first when node_modules is missing
make agent-test - Run the test suite, silent on success, installing first when node_modules is missing
make dev        - Watch mode: auto rebuild on changes

make build      - Build the project
make rebuild    - Clean and rebuild
make clean      - Remove build artifacts
make depcruise  - Check architectural boundaries

make pack       - Create tarball for local npx testing

make use-local  - Switch mthds to the workspace's ../../mthds-js (file link)
make use-npm    - Switch mthds back to npm [VERSION=x.y.z]

make c          - Shorthand -> check
make t          - Shorthand -> test
make te         - Shorthand -> test-e2e
make ul         - Shorthand -> use-local
make un         - Shorthand -> use-npm

endef
export HELP

help:
	@echo "$$HELP"

# `npm ci` installs exactly what the lockfile pins and refuses a lockfile that is out of step
# with package.json, where `npm install` would rewrite it in whichever shape the running npm
# prefers. Changing a dependency is the deliberate `npm install <package>@<range>`, then a
# commit of both files.
install:
	$(call PRINT_TITLE,"Installing Dependencies")
	@npm ci
	@echo "$(GREEN)✓ Installation complete$(NC)"

# The agent targets install the package first when node_modules is missing, so a fresh
# checkout can run them directly.
install-if-missing:
	@[ -d node_modules ] || $(MAKE) --no-print-directory install

build:
	$(call PRINT_TITLE,"Building Project")
	@npm run build
	@echo "$(GREEN)✓ Build complete$(NC)"

test:
	$(call PRINT_TITLE,"Running Tests")
	@npx vitest run
	@echo "$(GREEN)✓ All tests passed$(NC)"

t: test

# Needs a live pipelex-api server (default http://localhost:8081, override with
# PIPELEX_E2E_BASE_URL). Not part of `make test` / `make all` — CI has no server.
#
# The target and its key are resolved ONCE here and exported, so the URL this target
# preflights is the URL the suites call. Precedence follows the dotenv convention: the
# shell environment (or a `make test-e2e PIPELEX_E2E_BASE_URL=...` override) wins, then
# `.env`, then a local runner. `?=` is what enforces it — it only reaches for `.env`
# when the variable is not already set.
DOTENV = set -a; [ -f .env ] && . ./.env; set +a;
test-e2e: export PIPELEX_E2E_BASE_URL ?= $(shell $(DOTENV) printf '%s' "$${PIPELEX_E2E_BASE_URL:-http://localhost:8081}")
test-e2e: export PIPELEX_API_KEY ?= $(shell $(DOTENV) printf '%s' "$$PIPELEX_API_KEY")
# The stored method the hosted `method_id` cases run against; they skip when it is unset or empty.
test-e2e: export PIPELEX_E2E_METHOD_ID ?= $(shell $(DOTENV) printf '%s' "$$PIPELEX_E2E_METHOD_ID")

# Trailing slashes are stripped the way the client normalizes `baseUrl` (`src/client.ts`),
# so a value ending in `/` cannot make the probe `//v1/version` — which a runner does not
# route — and report a live server as unreachable. It is done here, at the point of use,
# rather than on the assignment above: `?=` never fires for a value that arrived from the
# shell environment or the command line, so those two sources would keep their slash.
E2E_TARGET = $$(printf '%s' "$(PIPELEX_E2E_BASE_URL)" | sed 's:/*$$::')

# `/v1/version` is the one route BOTH a bare runner and a hosted origin serve, and it
# needs no auth — origin-level `/health` is runner-only and 404s on the hosted plane.
test-e2e:
	$(call PRINT_TITLE,"Running E2E Tests against live pipelex-api")
	@target="$(E2E_TARGET)"; curl -fs --max-time 5 -o /dev/null "$$target/v1/version" || { \
		echo "$(RED)✗ No pipelex-api reachable at $$target$(NC)"; \
		echo "  Start one with make -C ../../pipelex/api run, the runner in the workspace's pipelex checkout — or point PIPELEX_E2E_BASE_URL (shell or .env) at a running instance."; \
		exit 1; \
	}
	@echo "$(YELLOW)→ target: $(E2E_TARGET)$(NC)\n"
	@npm run test:e2e
	@echo "$(GREEN)✓ All e2e tests passed$(NC)"

te: test-e2e

# The packed command (docs/cli.md): `npm pack` the package as it would be published, then run
# its `pipelex-sdk` command from the tarball through npx, from a directory outside the package,
# in both ways npx finds a package's command: by naming it, and as the package's only command.
# The tarball is named relative to that directory, `./<file>.tgz`: given an absolute path, npx
# tries to execute the tarball itself.
# npx installs the tarball's dependencies from the registry, so CI's js job runs this target and
# `make test` does not.
test-pack: build
	$(call PRINT_TITLE,"Testing the packed pipelex-sdk command")
	@set -e; \
	expected=$$(node -p 'require("./package.json").version'); \
	dest=$$(mktemp -d); trap 'rm -rf "$$dest"' EXIT; \
	npm pack --silent --ignore-scripts --pack-destination "$$dest" >/dev/null; \
	cd "$$dest"; \
	tarball=./$$(ls *.tgz); \
	npx --yes --package "$$tarball" pipelex-sdk --help | grep -q "pipelex-sdk run --method" \
		|| { echo "$(RED)✗ npx --package <tarball> pipelex-sdk --help did not print the help$(NC)"; exit 1; }; \
	got=$$(npx --yes "$$tarball" --version); \
	[ "$$got" = "$$expected" ] \
		|| { echo "$(RED)✗ npx <tarball> --version printed '$$got', not $$expected$(NC)"; exit 1; }; \
	echo "$(GREEN)✓ The packed pipelex-sdk command answers --help and --version ($$expected)$(NC)"

depcruise:
	$(call PRINT_TITLE,"Checking Architectural Boundaries")
	@npm run depcruise
	@echo "$(GREEN)✓ protocol boundary intact$(NC)"

# npm ls reads only package.json and the lockfile, so it fails on a tree npm itself calls
# invalid whichever npm wrote it, and the grep leaves only the edge at fault on the screen:
# npm's own markers for a wrong version, a dependency the lockfile lacks and one nothing needs,
# never `UNMET OPTIONAL DEPENDENCY`, which a valid tree prints too.
# While `make use-local` links mthds to a checkout, the lockfile cannot see that checkout's own
# dependencies and reads every one of them as unmet, so the check steps aside and says so; a
# committed link would fail CI's `npm ci` anyway, since the checkout is not there.
check-lock:
	@if grep -qE '"(file|link):' package.json; then \
		echo "$(YELLOW)• Lockfile check skipped: package.json links a local checkout (make use-local); run make use-npm before committing$(NC)"; \
	elif ! npm ls --all --package-lock-only > /dev/null 2>&1; then \
		npm ls --all --package-lock-only 2>/dev/null | grep -E "invalid: |UNMET DEPENDENCY|extraneous"; \
		echo "$(RED)package-lock.json is not a valid install tree: fix the dependency above, then run npm install to rewrite the lock$(NC)"; \
		exit 1; \
	fi

check: check-lock
	@npm run check
	@echo "$(GREEN)✓ All checks passed$(NC)"

c: check

agent-check: install-if-missing check-lock
	@npm run check
	@echo "$(GREEN)✓ All checks passed$(NC)"

agent-test: install-if-missing
	@OUTPUT=$$(npx vitest run 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi
	@echo "• All tests passed."

clean:
	$(call PRINT_TITLE,"Cleaning Build Artifacts")
	@rm -rf dist/
	@rm -rf dist-hooks/
	@rm -rf *.tsbuildinfo
	@echo "$(GREEN)✓ Clean complete$(NC)"

rebuild: clean build

all: clean check test
	@echo "$(GREEN)✓ All complete$(NC)"

dev:
	$(call PRINT_TITLE,"Watching for Changes")
	@npx tsc --watch

pack: rebuild
	$(call PRINT_TITLE,"Creating Tarball")
	@npm pack
	@echo ""
	@echo "$(GREEN)✓ Tarball created$(NC)"
	@echo "$(YELLOW)Test with: npx ./$$(npm pack --dry-run --json | node -p \"JSON.parse(require('fs').readFileSync(0,'utf-8'))[0].filename\")$(NC)"

# --- Switch mthds source ---
# use-local:  file link to the workspace's ../../mthds-js for live development
# use-npm:    install from the npm registry (latest by default, or VERSION=x.y.z)

use-local:
	@if [ ! -d $(MTHDS_JS_DIR) ]; then echo "ERROR: $(MTHDS_JS_DIR) not found. Clone mthds-js at the workspace root, beside this repository."; exit 1; fi
	cd $(MTHDS_JS_DIR) && npm ci && npm run build
	npm install mthds@file:$(MTHDS_JS_DIR)
	@echo "Switched to local mthds (file link). Run 'make use-npm' to switch back."

use-npm:
	@VERSION="$${VERSION:-latest}" && \
	echo "Installing mthds@$$VERSION from npm" && \
	npm install mthds@$$VERSION && \
	echo "Switched to npm mthds@$$VERSION. Review the diff, then commit package.json + package-lock.json."

ul: use-local
un: use-npm
