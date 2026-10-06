.DEFAULT_GOAL := help
.PHONY: help install install-if-missing lock lint format format-check typecheck codegen codegen-check codegen-verify check test agent-check agent-test build all clean use-local use-published local-status ul un

# ── Arguments ──────────────────────────────────────────────────────────────
# A target that takes values reads them as make variables (`make use-local
# SDK_DIR=…`). Two rules keep that faithful:
#
#   - Only a value given on the command line counts. A variable of the same name
#     exported by the shell is not a request, so `given` reads a variable's
#     origin before its value. A blank value is not given either: `SDK_DIR=` is
#     how a person clears a value, not how they ask for an empty one.
#   - The value reaches the shell exactly as typed. `shq` wraps it in single
#     quotes, closing and escaping any quote inside, and `$(value …)` keeps a `$`
#     in it from being expanded by make.
#
# tests/test_makefile.py pins the expansions with `make -n`.
shq = '$(subst ','\'',$(1))'
given = $(if $(filter command line,$(origin $(1))),$(strip $(value $(1))))

# ── Tools ──────────────────────────────────────────────────────────────────
# Every tool runs from the virtual environment's own bin/, never through
# `uv run`: `uv run` re-syncs the environment against uv.lock first, which would
# silently undo a package installed over the locked one, as `make use-local`
# does here and as the repository's CI does when it tests this template against
# the next SDK.
VENV_BIN := .venv/bin
PYTHON := $(VENV_BIN)/python
RUFF := $(VENV_BIN)/ruff
PYRIGHT := $(VENV_BIN)/pyright
PYTEST := $(VENV_BIN)/pytest

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# `uv sync` installs the project and its development group into .venv, exactly
# as uv.lock pins them. With UV_LOCKED=1 in the environment, as the CI sets it,
# it refuses a uv.lock that pyproject.toml has moved away from instead of
# rewriting it, which makes the install the lock file's gate.
install: ## Install the project and its development tools into .venv, as uv.lock pins them
	@command -v uv >/dev/null 2>&1 || { echo "uv is not installed: see https://docs.astral.sh/uv/getting-started/installation/"; exit 1; }
	uv sync

# The agent targets install the project first when it was never installed, so a
# fresh copy can run them directly. The test reads a tool rather than the
# virtual environment, because an interrupted sync leaves an empty one.
install-if-missing:
	@[ -x $(PYTEST) ] || $(MAKE) --no-print-directory install

lock: ## Regenerate uv.lock without installing
	uv lock

lint: ## Lint with ruff
	$(RUFF) check .

format: ## Sort the imports and format the code with ruff
	$(RUFF) check --select I --fix .
	$(RUFF) format .

format-check: ## Check the formatting with ruff
	$(RUFF) format --check .

typecheck: ## Type-check with pyright, in strict mode
	$(PYRIGHT)

# ── Codegen ────────────────────────────────────────────────────────────────
# The package's generated/ tree is derived from its method/ through the hosted
# API: the typed models and their codegen.lock from POST /v1/codegen, and
# contracts.json, the input and output forms the CLI derives its options from,
# from POST /v1/pipe-io. `make codegen` needs PIPELEX_API_KEY and rewrites the
# tree; `make codegen-check` is offline and part of `make check`;
# `make codegen-verify` needs the key and writes nothing (docs/codegen.md).
codegen: ## Regenerate the package's generated/ tree from its method/ (needs PIPELEX_API_KEY)
	$(PYTHON) -m scripts.codegen

codegen-check: ## Check, offline, that the generated/ tree is current with its method/ and its lock
	$(PYTHON) -m scripts.codegen_check

codegen-verify: ## Check that the committed tree is what the API resolves the method to, writing nothing (needs PIPELEX_API_KEY)
	$(PYTHON) -m scripts.codegen_verify

check: lint format-check typecheck codegen-check ## Run lint, format check, type check and the offline codegen check

test: ## Run the tests
	$(PYTEST)

agent-check: install-if-missing ## Run check, silent on success, installing first when .venv is missing (for agents)
	@OUTPUT=$$($(MAKE) --no-print-directory check 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi

agent-test: install-if-missing ## Run the tests, silent on success, installing first when .venv is missing (for agents)
	@OUTPUT=$$($(PYTEST) -q 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi

build: ## Build the wheel and the source distribution into dist/
	uv build

all: check test build ## Full validation: check, test and build

clean: ## Remove build artifacts and caches
	rm -rf dist build .pytest_cache .ruff_cache
	find . -path ./.venv -prune -o -type d -name __pycache__ -exec rm -rf {} +

# template-only:begin — this block leaves with the gesture when the template becomes a project.
# Turns this template into the CLI for one method (docs/create.md). The
# gesture's arguments are the method-app family's contract, forwarded exactly as
# the web app template forwards them, so one step drives either template. On top
# of `shq` and `given`: `$(call opt,NAME,--name)` expands to `--name '<value>'`,
# or to nothing; `flag` forwards a switch as its flag alone, and `0` is not
# given; and `require` refuses a run without its variable, decided by make from
# the variable's origin and value, so the value never reaches a shell line
# unquoted. A value such as `TITLE=Bob's "$5" app` arrives intact, and a
# relative bundle path is read from the directory make runs in.
# tests/test_create.py pins the expansions with `make -n`.
opt = $(if $(call given,$(1)),$(2) $(call shq,$(value $(1))))
flag = $(if $(filter-out 0,$(call given,$(1))),$(2))
require = @$(if $(call given,$(1)),:,echo "$(2)"; exit 2)

.PHONY: create
create: ## Turn this template into the CLI for METHOD=<path/to/bundle | mt_… | address> (one-shot; needs PIPELEX_API_KEY)
	$(call require,METHOD,usage: make create METHOD=<path/to/bundle | mt_… | github.com/owner/repo[/pkg][@tag]> [NAME=<package>] [TITLE=<title>] [DESCRIPTION=<text>] [PIPE=<pipe_code>] [AUTHOR_NAME=…] [AUTHOR_EMAIL=…] [REPO_URL=…] [LICENSE=mit|proprietary|<spdx>] [LICENSE_HOLDER=…] [LICENSE_YEAR=…] [DRY_RUN=1])
	@[ -x $(PYTHON) ] || uv sync
	$(PYTHON) -m scripts.create $(call shq,$(value METHOD)) $(call opt,NAME,--name) $(call opt,TITLE,--title) $(call opt,DESCRIPTION,--description) $(call opt,PIPE,--pipe) $(call opt,AUTHOR_NAME,--author-name) $(call opt,AUTHOR_EMAIL,--author-email) $(call opt,REPO_URL,--repo-url) $(call opt,LICENSE,--license) $(call opt,LICENSE_HOLDER,--license-holder) $(call opt,LICENSE_YEAR,--license-year) $(call flag,DRY_RUN,--dry-run)
# template-only:end

# ── Local Pipelex package development ──────────────────────────────────────
# By default, `make install` installs the published `pipelex-sdk` and `mthds`
# packages uv.lock pins. `make use-local` installs the checkouts beside the
# project instead, as editable packages, so you can develop them and the CLI
# side by side: the SDK is the `python/` directory of a `Pipelex/pipelex-sdk`
# checkout, and `mthds` a checkout of `Pipelex/mthds-python`. `make
# use-published` switches back, and `make local-status` says which is installed.
#
# The checkouts are looked for in the parent directory. SIBLINGS_DIR=<dir> names
# another one, and SDK_DIR=<dir> and MTHDS_DIR=<dir> name either checkout
# directly; each goes through `given` like every variable here. The SDK checkout
# is required. The mthds checkout is installed with it when it is there, in the
# same `uv pip install`, so one resolution decides both; when it is not, `mthds`
# stays as uv.lock pins it. The SDK pins `mthds` exactly, so a checkout of
# another version is refused by that resolution, naming both.
#
# Editable installs change nothing in pyproject.toml or uv.lock: moving a pin is
# a reviewed change with a changelog to read, never a side effect of local mode.
# And since the tools run from .venv/bin/, nothing re-syncs the environment
# behind your back; `make install` and `make use-published` do, on purpose.
SIBLINGS = $(or $(call given,SIBLINGS_DIR),..)
SDK_CHECKOUT = $(call shq,$(or $(call given,SDK_DIR),$(SIBLINGS)/pipelex-sdk/python))
MTHDS_CHECKOUT = $(call shq,$(or $(call given,MTHDS_DIR),$(SIBLINGS)/mthds-python))
LOCAL_PACKAGES := pipelex-sdk mthds

use-local: install-if-missing ## Install the sibling pipelex-sdk (its python/) and mthds-python checkouts as editable packages (from .., or SIBLINGS_DIR=<dir>)
	@sdk=$(SDK_CHECKOUT); mthds=$(MTHDS_CHECKOUT); \
	if [ ! -d "$$sdk" ]; then echo "ERROR: $$sdk not found: expected the python/ directory of a pipelex-sdk checkout (SIBLINGS_DIR=<dir> or SDK_DIR=<dir> says where)."; exit 1; fi; \
	if [ -d "$$mthds" ]; then \
		echo "Installing $$sdk and $$mthds as editable packages..."; \
		uv pip install --quiet --python $(PYTHON) --editable "$$sdk" --editable "$$mthds"; \
	else \
		echo "Installing $$sdk as an editable package; $$mthds not found, so mthds stays as uv.lock pins it..."; \
		uv pip install --quiet --python $(PYTHON) --editable "$$sdk"; \
	fi
	@$(PYTHON) scripts/local_status.py $(LOCAL_PACKAGES)
	@echo "Edits to the checkouts take effect at once. 'make use-published' switches back."

use-published: ## Restore the pipelex-sdk and mthds versions uv.lock pins
	@if [ ! -x $(PYTHON) ]; then echo "Not installed, so there is nothing to restore."; exit 0; fi; \
	uv sync --quiet $(foreach p,$(LOCAL_PACKAGES),--reinstall-package $(p)) && $(PYTHON) scripts/local_status.py $(LOCAL_PACKAGES)

local-status: ## Say whether pipelex-sdk and mthds come from a local checkout or from PyPI
	@if [ -x $(PYTHON) ]; then $(PYTHON) scripts/local_status.py $(LOCAL_PACKAGES); else for p in $(LOCAL_PACKAGES); do echo "$$p missing"; done; fi

ul: use-local ## Alias for use-local
un: use-published ## Alias for use-published
