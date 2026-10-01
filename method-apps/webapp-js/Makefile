.PHONY: help run dev serve stop build start port-check lint format format-check typecheck codegen codegen-check codegen-verify add-method test test-watch test-e2e test-e2e-ui confirm-live-e2e agent-test check clean install lock all use-local use-local-form use-published use-published-form local-status ul un

# ── Arguments ──────────────────────────────────────────────────────────────
# The gestures take their values as make variables (`make add-method
# METHOD=… NAME=…`) and hand them to a script as flags. Three rules keep that
# faithful:
#
#   - Only a value given on the command line counts. A variable of the same name
#     exported by the shell (NAME, TITLE and LICENSE all exist in the wild) is
#     not a request, so `opt` reads a variable's origin before its value.
#   - The value reaches the script exactly as typed. `shq` wraps it in single
#     quotes, closing and escaping any quote inside, and `$(value …)` keeps a `$`
#     in it from being expanded by make, so a title such as `Bob's "$5" app`
#     arrives intact.
#   - A blank value is not given: `NAME=` is how a person clears a value, not
#     how they ask for an empty one. For a switch, `0` is not given either.
#
# `$(call opt,NAME,--name)` expands to `--name '<value>'`, or to nothing.
shq = '$(subst ','\'',$(1))'
given = $(if $(filter command line,$(origin $(1))),$(strip $(value $(1))))
opt = $(if $(call given,$(1)),$(2) $(call shq,$(value $(1))))
flag = $(if $(filter-out 0,$(call given,$(1))),$(2))
# Refuse a gesture run without its required variable. Decided by make from the
# variable's origin and value, so the value itself never reaches a shell line
# unquoted.
require = @$(if $(call given,$(1)),:,echo "$(2)"; exit 2)

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "The servers listen on "$(call shq,$(host_shown))", port "$(call shq,$(port_shown))" — loopback only, unless APP_HOST says otherwise."
	@echo "APP_HOST=0.0.0.0 opens them to your network, where anyone can run methods on your API key. APP_PORT=4301 moves them."

# ── Where the app listens ──────────────────────────────────────────────────
# Declared once here and exported, so package.json's `dev`/`start` scripts and
# playwright.config.ts all read the same host and port. Each of them still
# falls back to 127.0.0.1 and 4300 on its own, so `npm run dev` outside make
# keeps working.
#
# APP_HOST is loopback by default because the app must not be reachable from
# the network. Its Server Actions run methods with the PIPELEX_API_KEY in the
# server's environment, and nothing authenticates the browser that calls them,
# so anyone who can reach the server runs methods billed to that key. `next`
# given no host binds every interface, which is why the scripts always pass
# one. Widen it only on a network you trust — for a container, or to open the
# app on another device:
#
#     make dev APP_HOST=0.0.0.0
#
# APP_PORT moves the port, to run this checkout beside one that already holds
# it:
#
#     make run APP_PORT=4301
#
# The names are deliberately not `HOST`, `HOSTNAME` or `PORT`. Those are
# ambient — the shell sets HOSTNAME to the machine's name, and hosting
# platforms, other dev servers and shell profiles export the others — and
# inheriting one would widen or move this server without saying so.
APP_HOST ?= 127.0.0.1
APP_PORT ?= 4300
export APP_HOST APP_PORT

# The host and port as they were set, a blank one meaning the default, as an
# empty value does in the scripts. `value` keeps a `$` in them from being
# expanded by make. The host is for messages only; the port is also what
# port-check looks up, since a blank one would hand lsof `-iTCP:`, which it
# rejects, and the check would pass without looking.
host_shown = $(or $(strip $(value APP_HOST)),127.0.0.1)
port_shown = $(or $(strip $(value APP_PORT)),4300)
# What of that host is not loopback: nothing for 127.x.x.x, ::1 or localhost.
# Next takes an IPv6 host bare, so `[::1]` is not a spelling of loopback here.
exposed = $(filter-out 127.% ::1 localhost,$(host_shown))
# Said each time a server is about to listen beyond this machine.
warn-exposed = @$(if $(exposed),echo "Warning: APP_HOST="$(call shq,$(host_shown))" opens this server beyond this machine. Anyone who can reach it runs methods billed to your PIPELEX_API_KEY.",:)

# `next dev` refuses a taken port with a bare EADDRINUSE naming the port and
# nothing else. In this workspace every branch gets its own worktree and each
# one runs `make run` on the same port, so the holder is routinely ANOTHER
# checkout of this same app — which answers on http://127.0.0.1:4300 and looks
# entirely right in a browser. Name the holder rather than print a stack trace.
#
# ALLOW_OWN=1 accepts a server started from this directory and still refuses a
# foreign one. That is the e2e case: Playwright reuses an existing server
# (`reuseExistingServer` in playwright.config.ts), so without this check a
# stale worktree on the same port would run the whole suite against another
# branch's app and report it green.
port-check:
	@command -v lsof >/dev/null 2>&1 || exit 0; \
	pid=$$(lsof -nP -iTCP:$(port_shown) -sTCP:LISTEN -t 2>/dev/null | head -1); \
	if [ -z "$$pid" ]; then exit 0; fi; \
	cwd=$$(lsof -a -p $$pid -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1); \
	if [ "$$cwd" = "$(CURDIR)" ]; then \
		if [ -n "$(ALLOW_OWN)" ]; then exit 0; fi; \
		addr=$$(lsof -nP -a -p $$pid -iTCP:$(port_shown) -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p' | head -1); \
		case "$$addr" in ""|\**) url=127.0.0.1:$(port_shown) ;; *) url=$$addr ;; esac; \
		echo "Port $(port_shown) is already served by this checkout (pid $$pid, listening on $${addr:-an unknown address})."; \
		echo "Open http://$$url, or stop that server first."; \
		exit 1; \
	fi; \
	echo "Port $(port_shown) is held by pid $$pid, running in $${cwd:-an unknown directory}."; \
	echo "That is not this checkout ($(CURDIR)) — it is serving a different app."; \
	echo "Leave it alone and use another port, e.g. APP_PORT=4301 on this target."; \
	exit 1

run: port-check ## Start the dev server on 127.0.0.1:4300 (APP_HOST=, APP_PORT= to change)
	$(warn-exposed)
	npm run dev

dev: run ## Alias for run

# `make serve` starts the same dev server in the background, detached from this
# terminal and bound to loopback, waits for its port, checks that the listener
# is the server it started and that it listens on this machine alone, proves
# that the page answers, and prints the URL and the page's title. `make stop`
# stops what it started. scripts/lib/serve.mts says why each check is there.
#
# Its verdict is its last line, opening with a stable word (`serving`,
# `already-serving`, `refused: …`, `failed: …`; `stopped` or `not-running` for
# stop). Running it twice gives one server and the same URL, and a server
# started here with `make dev` is reported, never stopped.
#
# The port it tries is APP_PORT when the command line or the shell sets it, and
# only that one; otherwise the first of 4300 to 4309 that no other directory
# holds. `serve_port` is that given port, read from APP_PORT's origin: the
# default this file sets is not a request. A non-loopback APP_HOST is refused —
# widening the host stays `make dev APP_HOST=…`, in the foreground.
serve_port = $(if $(filter-out file,$(origin APP_PORT)),$(strip $(value APP_PORT)))

serve: ## Start the dev server in the background on loopback, prove the page answers, print its URL (make stop stops it)
	@npm run --silent serve -- serve --host $(call shq,$(host_shown))$(if $(serve_port), --port $(call shq,$(serve_port)))

stop: ## Stop the dev server make serve started
	@npm run --silent serve -- stop

build: ## Production build
	npm run build

start: port-check ## Start the production server on 127.0.0.1:4300 (APP_HOST=, APP_PORT= to change)
	$(warn-exposed)
	npm run start

lint: ## Run ESLint
	npm run lint

format: ## Format code with Prettier
	npm run format

format-check: ## Check formatting (CI)
	npm run format:check

typecheck: ## Run TypeScript type checking (app + e2e specs + scripts)
	npm run typecheck
	npm run typecheck:e2e
	npm run typecheck:scripts

# Regenerates src/generated/<method>/ from methods/<method>/. Needs PIPELEX_API_KEY
# and a base URL that serves /v1/validate's form views, which the default does
# (see docs/add-method.md).
# Deliberately OUT of `make all`, for the same reason test-e2e is: key + network.
codegen: ## Regenerate the typed artifacts in src/generated/ from methods/ (needs PIPELEX_API_KEY)
	npm run codegen

# The CI half of the trust chain: pure hashing, no key, no network. Proves each
# committed tree still agrees with its own lock, and that the .mthds sources it
# was generated from have not changed since. Part of `make check`.
codegen-check: ## Verify src/generated/ is current, offline (no API key needed)
	npm run codegen:check

# The semantic gate the offline check deliberately cannot be: re-resolves each
# method live and compares crate fingerprints. Keyed and online, so it stays out
# of `make all` — run it before a release, or after touching methods/. Wants the
# same base URL as `codegen`.
codegen-verify: ## Ask the engine whether the committed crates are still current (needs PIPELEX_API_KEY)
	npm run codegen:verify

# Scaffolds a method into the app: a bundle (a .mthds file or a directory of
# them, copied into methods/<name>/ unless it is already there), a method on the
# platform (a catalog id) or one in a published package (an address). It writes
# the generated tree, the action trio, the narrower, the form and a registry
# entry, and the manifest for a method that lives elsewhere. One-shot — it never
# overwrites, and `npm run codegen` is the refresh. Keyed and online, so it stays
# out of `make all`. Wants the same base URL as `codegen`, which is also the one
# that resolves a package address. A relative bundle path is read from the
# directory make runs in.
add-method: ## Scaffold a method into the app from METHOD=<path/to/bundle | mt_… | github.com/owner/repo[/pkg][@tag]> (needs PIPELEX_API_KEY)
	$(call require,METHOD,usage: make add-method METHOD=<path/to/bundle | mt_… | github.com/owner/repo[/pkg][@tag]> [PIPE=<pipe_code>] [NAME=<dir-name>] [LABEL=<label>] [DRY_RUN=1])
	npm run add-method -- $(call shq,$(value METHOD)) $(call opt,PIPE,--pipe) $(call opt,NAME,--name) $(call opt,LABEL,--label) $(call flag,DRY_RUN,--dry-run)

# template-only:begin — the bootstrap removes this block, with the gesture it runs.
# Turns this template into the app for one method, in one go: scaffolds the
# method, names the project after it (the bootstrap, run with the derived
# values), writes .env.local from the shell, re-syncs the lock file, runs
# `make all`, and removes the bootstrap. One-shot, keyed and online, so it stays
# out of `make all`; docs/create.md is the reference. A relative bundle path is
# read from the directory make runs in.
.PHONY: create
create: ## Turn this template into the app for METHOD=<path/to/bundle | mt_… | address> (one-shot; needs PIPELEX_API_KEY)
	$(call require,METHOD,usage: make create METHOD=<path/to/bundle | mt_… | github.com/owner/repo[/pkg][@tag]> [NAME=<package>] [TITLE=<title>] [DESCRIPTION=<text>] [METHOD_NAME=<dir-name>] [PIPE=<pipe_code>] [LABEL=<label>] [AUTHOR_NAME=…] [AUTHOR_EMAIL=…] [REPO_URL=…] [LICENSE=mit|proprietary|<spdx>] [LICENSE_HOLDER=…] [LICENSE_YEAR=…] [DRY_RUN=1])
	@[ -d node_modules ] || npm install
	npm run create -- $(call shq,$(value METHOD)) $(call opt,NAME,--name) $(call opt,TITLE,--title) $(call opt,DESCRIPTION,--description) $(call opt,METHOD_NAME,--method-name) $(call opt,PIPE,--pipe) $(call opt,LABEL,--label) $(call opt,AUTHOR_NAME,--author-name) $(call opt,AUTHOR_EMAIL,--author-email) $(call opt,REPO_URL,--repo-url) $(call opt,LICENSE,--license) $(call opt,LICENSE_HOLDER,--license-holder) $(call opt,LICENSE_YEAR,--license-year) $(call flag,DRY_RUN,--dry-run)
# template-only:end

test: ## Run tests (single pass)
	npm run test

test-watch: ## Run tests in watch mode
	npm run test:watch

# OPTIONAL. The live-API specs hit the real Pipelex API (cost an LLM call, need
# PIPELEX_API_KEY) and auto-skip without a key. Confirmation gate guards against
# accidental spend; skipped in CI / non-interactive shells, or pass CONFIRM=1.
confirm-live-e2e:
	@if [ -z "$$CI" ] && [ -z "$$CONFIRM" ] && [ -t 0 ]; then \
		printf "⚠️  Playwright e2e runs against the LIVE Pipelex API and costs an LLM call per live spec.\n"; \
		printf "Continue? [y/N] "; \
		read ans; \
		case "$$ans" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac; \
	fi

# ALLOW_OWN is a target-specific variable, so it reaches the port-check
# prerequisite: Playwright reusing THIS checkout's dev server is the point,
# reusing another one silently is the bug.
test-e2e test-e2e-ui: ALLOW_OWN = 1

test-e2e: confirm-live-e2e port-check ## Run OPTIONAL Playwright e2e (LIVE API — needs PIPELEX_API_KEY, costs an LLM call; auto-skips without a key)
	npm run test:e2e

test-e2e-ui: confirm-live-e2e port-check ## Same as test-e2e, with the Playwright UI runner
	npm run test:e2e:ui

agent-test: ## Run tests, silent on success (for agents)
	@OUTPUT=$$(npm run test --silent 2>&1); STATUS=$$?; if [ $$STATUS -ne 0 ]; then echo "$$OUTPUT"; exit $$STATUS; fi

check: lint format-check typecheck codegen-check ## Run lint, format check, type check, and the offline codegen check

all: check test build ## Full validation: check + test + build (excludes e2e — see test-e2e)

install: ## Install dependencies
	npm install

lock: ## Regenerate package-lock.json without installing
	npm install --package-lock-only

clean: ## Remove build artifacts and caches
	rm -rf .next node_modules/.cache

# ── Local Pipelex package development ──────────────────────────────────────
# By default, `make install` fetches the published `@pipelex/sdk` and
# `@pipelex/mthds-form` packages from npm. `make use-local` packs and installs
# the sibling pipelex-sdk-js and mthds-form checkouts so you can develop them
# and the app side-by-side, and `make use-local-form` does the same for the form
# kernel alone. `make use-published` and `make use-published-form` switch back,
# and `make local-status` says which mode node_modules is in.
#
# The siblings are looked for in the parent directory. SIBLINGS_DIR=<dir> names
# another one — `../..` for a checkout nested one level deeper than its
# siblings — and goes through `given` like every other variable here.
#
# We use `npm pack` + tarball install rather than a symlink because Next.js
# 16's Turbopack does not follow symlinked workspace packages — `npm run dev`
# and `npm run build` both fail with "Module not found" against a symlinked
# node_modules entry. The tarball install gives us a real directory that
# Turbopack resolves correctly. Re-run the target after every sibling edit to
# pick up changes.
#
# Every switch installs `--no-save`, so package.json and package-lock.json are
# never rewritten. Switching back restores the version the lockfile pins, not
# `@latest`: moving a range is a reviewed change with a changelog to read, which
# belongs to the `/bump-mthds-form` and `/bump-sdk` skills, never a side effect
# of leaving local mode.
#
# ONE `npm install` per switch, on purpose: an `--no-save` install re-reconciles
# node_modules against the lockfile and silently puts any EARLIER tarball back
# on the registry version. That is why `use-local` installs both tarballs in one
# call, and why the one-package targets refuse to run while the SDK is local —
# they would put it back on npm without a word.
#
# The tarballs are packed straight into a fresh temporary directory
# (`--pack-destination`), so nothing is written into the sibling checkouts, no
# filename is captured from npm's output, and two worktrees switching at once
# cannot overwrite each other's tarball. The pack steps pass `--ignore-scripts`
# because each sibling's `prepare` re-runs its build during `npm pack`; we build
# explicitly just before packing, so skipping `prepare` loses nothing.
#
# The kernel is packed alone, without the workspace's `mthds` checkout: it
# resolves `mthds` from npm, the same copy `@pipelex/sdk` uses, and a local
# `mthds` the SDK's range did not cover would split the protocol types the two
# packages share. A kernel on a sibling branch that needs an unpublished `mthds`
# fails loudly at the install, naming the version it could not find.
SIBLINGS = $(or $(call given,SIBLINGS_DIR),..)
SDK_DIR = $(call shq,$(SIBLINGS)/pipelex-sdk-js)
FORM_DIR = $(call shq,$(SIBLINGS)/mthds-form)

# `$(call install_local,<sibling dirs>,<package names>)` builds and packs each
# sibling into one temporary directory, then installs every tarball there in a
# single `npm install`, and removes the directory whatever happens.
define install_local
	@for d in $(1); do \
		if [ ! -d "$$d" ]; then echo "ERROR: $$d not found — expected as a sibling checkout (SIBLINGS_DIR=<dir> says where the siblings are)."; exit 1; fi; \
	done
	@DEST=$$(mktemp -d) && trap 'rm -rf "$$DEST"' EXIT && \
	for d in $(1); do \
		echo "Building and packing $$d..." && (cd "$$d" && npm run build && npm pack --silent --ignore-scripts --pack-destination "$$DEST" >/dev/null) || exit 1; \
	done && \
	for n in $(2); do rm -rf "node_modules/$$n"; done && \
	npm install "$$DEST"/*.tgz --no-save --silent
endef

# Where node_modules got each named package, read from npm's hidden lockfile:
# `local` for a tarball packed from a sibling, `npm` for the registry, `missing`
# when it is not installed. The version string cannot tell the first two apart,
# since a local build carries the version it will be published as.
SOURCE_OF = node -e 'let p = {}; try { p = require("./node_modules/.package-lock.json").packages; } catch {} for (const n of process.argv.slice(1)) { const e = p["node_modules/" + n]; const r = e?.resolved; console.log(n, !r ? "missing" : r.startsWith("file:") ? "local" : "npm", e?.version ?? ""); }'

# The version package-lock.json pins for a package: what switching back restores.
locked = $$(node -p 'require("./package-lock.json").packages["node_modules/$(1)"].version')

# Refuse a one-package switch while the SDK is local, since its install would
# silently put the SDK back on the registry version.
define refuse_while_sdk_local
	@if $(SOURCE_OF) @pipelex/sdk | grep -q ' local '; then \
		echo "ERROR: @pipelex/sdk is installed from a local tarball, and installing the kernel alone would silently put it back on npm. Run 'make $(1)' instead, which switches both."; exit 1; \
	fi
endef

use-local: ## Pack and install the sibling pipelex-sdk-js and mthds-form checkouts into node_modules (from .., or SIBLINGS_DIR=<dir>)
	$(call install_local,$(SDK_DIR) $(FORM_DIR),@pipelex/sdk @pipelex/mthds-form)
	@echo "Now using the local pipelex-sdk-js and mthds-form (tarball installs). Re-run after every edit. 'make use-published' to switch back."

use-local-form: ## Pack and install the sibling mthds-form checkout alone into node_modules (from .., or SIBLINGS_DIR=<dir>)
	$(call refuse_while_sdk_local,use-local)
	$(call install_local,$(FORM_DIR),@pipelex/mthds-form)
	@echo "Now using the local mthds-form (tarball install). Re-run after every kernel edit. 'make use-published-form' to switch back."

use-published: ## Restore the @pipelex/sdk and @pipelex/mthds-form versions package-lock.json pins
	rm -rf node_modules/@pipelex/sdk node_modules/@pipelex/mthds-form
	npm install @pipelex/sdk@$(call locked,@pipelex/sdk) @pipelex/mthds-form@$(call locked,@pipelex/mthds-form) --no-save --silent
	@$(SOURCE_OF) @pipelex/sdk @pipelex/mthds-form

use-published-form: ## Restore the @pipelex/mthds-form version package-lock.json pins
	$(call refuse_while_sdk_local,use-published)
	rm -rf node_modules/@pipelex/mthds-form
	npm install @pipelex/mthds-form@$(call locked,@pipelex/mthds-form) --no-save --silent
	@$(SOURCE_OF) @pipelex/mthds-form

local-status: ## Say whether @pipelex/sdk and @pipelex/mthds-form come from a sibling checkout or from npm
	@$(SOURCE_OF) @pipelex/sdk @pipelex/mthds-form

ul: use-local ## Alias for use-local
un: use-published ## Alias for use-published
