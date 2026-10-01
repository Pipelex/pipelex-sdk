SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

ifeq ($(wildcard .env),.env)
include .env
export
endif
VIRTUAL_ENV := $(CURDIR)/.venv
PROJECT_NAME := $(shell grep '^name = ' pyproject.toml | sed -E 's/name = "(.*)"/\1/')

# The "?" is used to make the variable optional, so that it can be overridden by the user.
PYTHON_VERSION ?= 3.13
VENV_PYTHON := $(VIRTUAL_ENV)/bin/python
VENV_PYTEST := $(VIRTUAL_ENV)/bin/pytest
VENV_RUFF := $(VIRTUAL_ENV)/bin/ruff
VENV_PYRIGHT := $(VIRTUAL_ENV)/bin/pyright
VENV_MYPY := $(VIRTUAL_ENV)/bin/mypy
VENV_PLXT := RUST_LOG=warn "$(VIRTUAL_ENV)/bin/plxt"

UV_MIN_VERSION = $(shell grep -m1 'required-version' pyproject.toml | sed -E 's/.*= *"([^<>=, ]+).*/\1/')

USUAL_PYTEST_MARKERS := "(dry_runnable or not inference) and not (needs_output or pipelex_api)"

define PRINT_TITLE
    $(eval PROJECT_PART := [$(PROJECT_NAME)])
    $(eval TARGET_PART := ($@))
    $(eval MESSAGE_PART := $(1))
    $(if $(MESSAGE_PART),\
        $(eval FULL_TITLE := === $(PROJECT_PART) ===== $(TARGET_PART) ====== $(MESSAGE_PART) ),\
        $(eval FULL_TITLE := === $(PROJECT_PART) ===== $(TARGET_PART) ====== )\
    )
    $(eval TITLE_LENGTH := $(shell echo -n "$(FULL_TITLE)" | wc -c | tr -d ' '))
    $(eval PADDING_LENGTH := $(shell echo $$((126 - $(TITLE_LENGTH)))))
    $(eval PADDING := $(shell printf '%*s' $(PADDING_LENGTH) '' | tr ' ' '='))
    $(eval PADDED_TITLE := $(FULL_TITLE)$(PADDING))
    @echo ""
    @echo "$(PADDED_TITLE)"
endef

define HELP
Manage $(PROJECT_NAME) located in $(CURDIR).
Usage:

make env                      - Create python virtual env
make lock                     - Refresh uv.lock without updating anything
make install                  - Create local virtualenv & install all dependencies
make update                   - Upgrade dependencies via uv
make export-requirements      - Export production requirements.txt (no dev dependencies)
make export-requirements-dev  - Export requirements-dev.txt (all dependencies including dev)
make er                       - Shorthand -> export-requirements
make erd                      - Shorthand -> export-requirements-dev
make validate                 - Lint/validate the .mthds bundle with plxt
make codegen                  - Regenerate the typed clients from the .mthds methods (needs PIPELEX_API_KEY)
make codegen-check            - Verify the generated clients are current (offline, pure hashing)
make add-method               - Scaffold a catalog or published method into the CLI (needs PIPELEX_API_KEY)

make format                   - Format all (ruff-format + plxt-format)
make lint                     - Lint all (ruff-lint + plxt-lint)
make ruff-format              - Format Python with ruff
make ruff-lint                - Lint Python with ruff
make plxt-format              - Format .mthds/.toml with plxt
make plxt-lint                - Lint .mthds/.toml with plxt
make pyright                  - Check types with pyright
make mypy                     - Check types with mypy

make cleanenv                 - Remove virtual env and lock files
make cleanderived             - Remove extraneous compiled files, caches, logs, etc.
make cleanall                 - Remove all -> cleanenv + cleanderived
make reinstall                - Reinstall dependencies

make merge-check-ruff-lint    - Run ruff merge check without updating files
make merge-check-ruff-format  - Run ruff merge check without updating files
make merge-check-plxt-format  - Check .mthds/.toml formatting with plxt
make merge-check-plxt-lint    - Lint .mthds/.toml with plxt
make merge-check-mypy         - Run mypy merge check without updating files
make merge-check-pyright	  - Run pyright merge check without updating files

make v                        - Shorthand -> validate
make codex-tests              - Run tests for Codex (exit on first failure) (no inference, no codex_disabled)
make gha-tests		          - Run tests for github actions (exit on first failure) (no inference, no gha_disabled)
make test                     - Run unit tests (no inference)
make test-with-prints         - Run tests with prints (no inference)
make t                        - Shorthand -> test-with-prints
make tp                       - Shorthand -> test-with-prints
make tb                       - Shorthand -> `make test-with-prints TEST=test_boot`
make test-inference           - Run unit tests only for inference (with prints)
make ti                       - Shorthand -> test-inference

make check                    - Shorthand -> format lint mypy
make c                        - Shorthand -> check
make cc                       - Shorthand -> cleanderived check
make agent-check              - Shorthand -> fix-unused-imports format lint pyright mypy (for AI agents)
make agent-test               - Run unit tests, silent on success, output on failure (for AI agents)
make li                       - Shorthand -> lock install
make check-unused-imports     - Check for unused imports without fixing
make fix-unused-imports       - Fix unused imports with ruff
make fui                      - Shorthand -> fix-unused-imports

endef
export HELP

.PHONY: \
	all help env env-verbose check-uv check-uv-verbose lock install update build \
	export-requirements export-requirements-dev er erd \
	format lint ruff-format ruff-lint plxt-format plxt-lint pyright mypy \
	cleanderived cleanenv cleanall \
	test t test-quiet tq test-with-prints tp test-inference ti \
	codex-tests gha-tests \
	run-all-tests run-manual-trigger-gha-tests run-gha_disabled-tests \
	validate v check c cc agent-check agent-test codegen codegen-check add-method \
	merge-check-ruff-lint merge-check-ruff-format merge-check-plxt-format merge-check-plxt-lint merge-check-mypy merge-check-pyright \
	li check-unused-imports fix-unused-imports check-uv check-TODOs

all help:
	@echo "$$HELP"


##########################################################################################
### SETUP
##########################################################################################

# Quiet check-uv: only shows output if uv is missing (needs install)
check-uv:
	@command -v uv >/dev/null 2>&1 || { \
		echo ""; \
		echo "=== [$(PROJECT_NAME)] ===== (check-uv) ====== Ensuring uv ≥ $(UV_MIN_VERSION) =========="; \
		echo "uv not found – installing latest …"; \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	}
	@uv self update >/dev/null 2>&1 || true

# Verbose check-uv: always shows output (for setup commands)
check-uv-verbose:
	$(call PRINT_TITLE,"Ensuring uv ≥ $(UV_MIN_VERSION)")
	@command -v uv >/dev/null 2>&1 || { \
		echo "uv not found – installing latest …"; \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	}
	@uv self update >/dev/null 2>&1 || true

# Quiet env: only shows output if venv needs to be created
env: check-uv
	@if [ ! -d $(VIRTUAL_ENV) ]; then \
		echo ""; \
		echo "=== [$(PROJECT_NAME)] ===== (env) ====== Creating virtual environment ================="; \
		echo "Creating Python virtual env in \`${VIRTUAL_ENV}\`"; \
		uv venv $(VIRTUAL_ENV) --python $(PYTHON_VERSION); \
	fi

# Verbose env: always shows output (for setup commands like install, lock, update)
env-verbose: check-uv-verbose
	$(call PRINT_TITLE,"Creating virtual environment")
	@if [ ! -d $(VIRTUAL_ENV) ]; then \
		echo "Creating Python virtual env in \`${VIRTUAL_ENV}\`"; \
		uv venv $(VIRTUAL_ENV) --python $(PYTHON_VERSION); \
	else \
		echo "Python virtual env already exists in \`${VIRTUAL_ENV}\`"; \
	fi

install: env-verbose
	$(call PRINT_TITLE,"Installing dependencies")
	@. $(VIRTUAL_ENV)/bin/activate && \
	uv sync --all-extras && \
	echo "Installed dependencies in ${VIRTUAL_ENV}";

lock: env-verbose
	$(call PRINT_TITLE,"Resolving dependencies without update")
	@uv lock && \
	echo "uv lock without update";

update: env-verbose
	$(call PRINT_TITLE,"Updating all dependencies")
	@uv pip compile --upgrade pyproject.toml -o requirements.lock && \
	uv pip install -e ".[dev]" && \
	echo "Updated dependencies in ${VIRTUAL_ENV}";

export-requirements: env
	$(call PRINT_TITLE,"Exporting production requirements")
	@uv export --no-dev --output-file requirements.txt && \
	echo "Exported production requirements to requirements.txt";

export-requirements-dev: env
	$(call PRINT_TITLE,"Exporting development requirements")
	@uv export --all-extras --output-file requirements-dev.txt && \
	echo "Exported all requirements (including dev) to requirements-dev.txt";

er: export-requirements
	@echo "> done: er = export-requirements"

erd: export-requirements-dev
	@echo "> done: erd = export-requirements-dev"

validate: env
	$(call PRINT_TITLE,"Validating the .mthds bundle with plxt")
	$(VENV_PLXT) lint

##########################################################################################
### CODEGEN
##########################################################################################

# Regenerate the typed clients (stamped models + codegen.lock) from the .mthds methods, through
# the hosted API. Needs PIPELEX_API_KEY and nothing else — no pipelex install: scripts/codegen.py
# posts each method to /v1/codegen with pipelex-sdk and writes the response verbatim. Run it after editing any main.mthds, then commit the result. The script
# discovers the methods from widget/methods/, so a new method only has to be added to the
# packages/package-data lists in pyproject.toml to ship.
codegen: env
	$(call PRINT_TITLE,"Regenerating typed clients from the .mthds methods")
	@$(VENV_PYTHON) -m scripts.codegen

# Offline drift check: pure hashing against each codegen.lock — no engine boot, no network,
# no API key, and no pipelex install, because the check is pipelex-sdk's own
# (`pipelex_sdk.codegen_check.run_codegen_check`, in scripts/codegen_check.py). Exit 0 = current,
# 1 = drift (stale/hand-edited), 2 = no lock. It compares a tree against its own lock and never
# against the bundle — only `make codegen` answers that.
codegen-check: env
	$(call PRINT_TITLE,"Checking generated clients are current - offline")
	@$(VENV_PYTHON) -m scripts.codegen_check

# Scaffolds a method that lives on the platform (a catalog id) or in a published package (an
# address) into the CLI: the manifest, the generated tree, and one Typer command in the execution
# mode you chose. One-shot — it never overwrites, and `make codegen` is the refresh. Keyed and
# online, so it is no more part of an offline gate than `codegen` is. See docs/add-method.md.
# Its arguments are read from the make command line only: make imports every environment variable
# as a make variable, and WSL exports `NAME` as the machine's hostname, so a plain
# `make add-method METHOD=…` there would otherwise scaffold under the hostname.
ADD_METHOD_ARG = $(if $(filter command line,$(origin $(1))),$($(1)))
add-method: env
	@if [ -z "$(call ADD_METHOD_ARG,METHOD)" ]; then \
		echo "usage: make add-method METHOD=<mt_… | github.com/owner/repo[/package][@tag]> [PIPE=<pipe_code>] [NAME=<dir-name>] [MODE=blocking|attended|detached] [DRY_RUN=1]"; \
		exit 2; \
	fi
	@$(VENV_PYTHON) -m scripts.add_method "$(call ADD_METHOD_ARG,METHOD)" \
		$(if $(call ADD_METHOD_ARG,PIPE),--pipe "$(call ADD_METHOD_ARG,PIPE)") \
		$(if $(call ADD_METHOD_ARG,NAME),--name "$(call ADD_METHOD_ARG,NAME)") \
		$(if $(call ADD_METHOD_ARG,MODE),--mode "$(call ADD_METHOD_ARG,MODE)") \
		$(if $(call ADD_METHOD_ARG,DRY_RUN),--dry-run)

##############################################################################################
############################      Cleaning                        ############################
##############################################################################################

cleanderived:
	$(call PRINT_TITLE,"Erasing derived files and directories")
	@find . -name '.coverage' -delete && \
	find . -wholename '**/*.pyc' -delete && \
	find . -type d -wholename '__pycache__' -exec rm -rf {} + && \
	find . -type d -wholename './.cache' -exec rm -rf {} + && \
	find . -type d -wholename './.mypy_cache' -exec rm -rf {} + && \
	find . -type d -wholename './.ruff_cache' -exec rm -rf {} + && \
	find . -type d -wholename '.pytest_cache' -exec rm -rf {} + && \
	find . -type d -wholename '**/.pytest_cache' -exec rm -rf {} + && \
	find . -type d -wholename './logs/*.log' -exec rm -rf {} + && \
	find . -type d -wholename './.reports/*' -exec rm -rf {} + && \
	echo "Cleaned up derived files and directories";

cleanenv:
	$(call PRINT_TITLE,"Erasing virtual environment")
	find . -name 'requirements.lock' -delete && \
	find . -type d -wholename './.venv' -exec rm -rf {} + && \
	echo "Cleaned up virtual env and dependency lock files";

cleanlock:
	$(call PRINT_TITLE,"Erasing uv lock file")
	@find . -name 'requirements.lock' -delete && \
	echo "Cleaned up uv lock file";

reinstall: cleanenv cleanlock install
	@echo "Reinstalled dependencies";

ri: reinstall
	@echo "> done: ri = reinstall"

cleanconfig:
	$(call PRINT_TITLE,"Erasing .pipelex config files and directories")
	@find . -type d -wholename './.pipelex' -exec rm -rf {} + && \
	echo "Cleaned up .pipelex";

cleanall: cleanderived cleanenv cleanconfig
	@echo "Cleaned up all derived files and directories";

##########################################################################################
### TESTING
##########################################################################################

codex-tests: env
	$(call PRINT_TITLE,"Unit testing for Codex")
	@echo "• Running unit tests for Codex (excluding inference, pipelex_api and codex_disabled)"
	$(VENV_PYTEST) --exitfirst --quiet -m "not inference and not pipelex_api and not codex_disabled" || [ $$? = 5 ]

gha-tests: env
	$(call PRINT_TITLE,"Unit testing for github actions")
	@echo "• Running unit tests for github actions (excluding inference, pipelex_api and gha_disabled)"
	$(VENV_PYTEST) --exitfirst --quiet -m "not inference and not pipelex_api and not gha_disabled" || [ $$? = 5 ]

run-all-tests: env
	$(call PRINT_TITLE,"Running all unit tests")
	@echo "• Running all unit tests"
	$(VENV_PYTEST) --exitfirst --quiet

run-manual-trigger-gha-tests: env
	$(call PRINT_TITLE,"Running GHA tests")
	@echo "• Running GHA unit tests for inference, llm, and not gha_disabled"
	$(VENV_PYTEST) --exitfirst --quiet -m "not gha_disabled and (inference or llm)" || [ $$? = 5 ]

run-gha_disabled-tests: env
	$(call PRINT_TITLE,"Running GHA disabled tests")
	@echo "• Running GHA disabled unit tests"
	$(VENV_PYTEST) --exitfirst --quiet -m "gha_disabled" || [ $$? = 5 ]

test: env
	$(call PRINT_TITLE,"Unit testing without prints but displaying logs via pytest for WARNING level and above")
	@echo "• Running unit tests"
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

test-quiet: env
	$(call PRINT_TITLE,"Unit testing without prints but displaying logs via pytest for WARNING level and above")
	@echo "• Running unit tests"
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) -m $(USUAL_PYTEST_MARKERS) -o log_cli=true -o log_level=WARNING $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

tq: test-quiet
	@echo "> done: tq = test-quiet"

test-with-prints: env
	$(call PRINT_TITLE,"Unit testing with prints and our rich logs")
	@echo "• Running unit tests"
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

t: test-with-prints
	@echo "> done: tp = test-with-prints"

tp: test-with-prints
	@echo "> done: tp = test-with-prints"

tb: env
	$(call PRINT_TITLE,"Unit testing a simple boot")
	@echo "• Running unit test test_boot"
	$(VENV_PYTEST) -s -m $(USUAL_PYTEST_MARKERS) -k "test_boot" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,)));


test-inference: env
	$(call PRINT_TITLE,"Unit testing")
	@if [ -n "$(TEST)" ]; then \
		$(VENV_PYTEST) --exitfirst -m "inference" -s -k "$(TEST)" $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	else \
		$(VENV_PYTEST) --exitfirst -m "inference" -s $(if $(filter 1,$(VERBOSE)),-v,$(if $(filter 2,$(VERBOSE)),-vv,$(if $(filter 3,$(VERBOSE)),-vvv,))); \
	fi

ti: test-inference
	@echo "> done: ti = test-inference"

agent-test: env
	@echo "• Running unit tests..."
	@tmpfile=$$(mktemp); \
	$(VENV_PYTEST) -m $(USUAL_PYTEST_MARKERS) -o log_level=WARNING --tb=short -q > "$$tmpfile" 2>&1; \
	exit_code=$$?; \
	if [ $$exit_code -ne 0 ]; then grep -vE '\[\s*[0-9]+%\]\s*$$' "$$tmpfile"; fi; \
	rm -f "$$tmpfile"; \
	if [ $$exit_code -eq 0 ]; then echo "• All tests passed."; fi; \
	exit $$exit_code

############################################################################################
############################               Linting              ############################
############################################################################################

ruff-format: env
	$(call PRINT_TITLE,"Formatting with ruff")
	@$(VENV_RUFF) format .

ruff-lint: env
	$(call PRINT_TITLE,"Linting with ruff")
	@$(VENV_RUFF) check . --fix

plxt-format: env
	$(call PRINT_TITLE,"Formatting MTHDS/TOML with plxt")
	$(VENV_PLXT) fmt

plxt-lint: env
	$(call PRINT_TITLE,"Linting MTHDS/TOML with plxt")
	$(VENV_PLXT) lint

format: ruff-format plxt-format
	@echo "> done: format = ruff-format plxt-format"

lint: ruff-lint plxt-lint
	@echo "> done: lint = ruff-lint plxt-lint"

pyright: env
	$(call PRINT_TITLE,"Typechecking with pyright")
	$(VENV_PYRIGHT) --pythonpath $(VENV_PYTHON) --project pyproject.toml

mypy: env
	$(call PRINT_TITLE,"Typechecking with mypy")
	@$(VENV_MYPY)


##########################################################################################
### MERGE CHECKS
##########################################################################################

merge-check-ruff-format: env
	$(call PRINT_TITLE,"Formatting with ruff")
	$(VENV_RUFF) format --check .

merge-check-plxt-format: env
	$(call PRINT_TITLE,"Checking MTHDS/TOML formatting with plxt")
	$(VENV_PLXT) fmt --check

merge-check-plxt-lint: env
	$(call PRINT_TITLE,"Linting MTHDS/TOML with plxt")
	$(VENV_PLXT) lint

merge-check-ruff-lint: env check-unused-imports
	$(call PRINT_TITLE,"Linting with ruff without fixing files")
	$(VENV_RUFF) check .

merge-check-pyright: env
	$(call PRINT_TITLE,"Typechecking with pyright")
	$(VENV_PYRIGHT) --pythonpath $(VENV_PYTHON)

merge-check-mypy: env
	$(call PRINT_TITLE,"Typechecking with mypy")
	$(VENV_MYPY) --version && \
	$(VENV_MYPY) --config-file pyproject.toml

##########################################################################################
### SHORTHANDS
##########################################################################################

check-unused-imports: env
	$(call PRINT_TITLE,"Checking for unused imports without fixing")
	$(VENV_RUFF) check --select=F401 --no-fix .

c: format lint pyright mypy
	@echo "> done: c = check"

cc: cleanderived c
	@echo "> done: cc = cleanderived check"

check: cleanderived check-unused-imports c
	@echo "> done: check"

agent-check: fix-unused-imports format lint pyright mypy
	@echo "> done: agent-check"

v: validate
	@echo "> done: v = validate"

li: lock install
	@echo "> done: lock install"

fix-unused-imports: env
	$(call PRINT_TITLE,"Fixing unused imports")
	$(VENV_RUFF) check --select=F401 --fix .

fui: fix-unused-imports
	@echo "> done: fui = fix-unused-imports"
