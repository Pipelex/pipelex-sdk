# pipelex-sdk-js (`@pipelex/sdk`)

TypeScript SDK for the **Pipelex hosted API**. It owns the Pipelex-branded product client: the request pipeline (auth, base URL, retries/timeouts/abort, problem-details), the protocol-execution routes (`execute` / `start` / `validate` / `models` / `version`), the run lifecycle, and the product surface (methods catalog, organizations, billing, API keys, storage, onboarding).

## Tech stack

| Concern        | Choice                                                            |
| -------------- | ---------------------------------------------------------------- |
| Language       | TypeScript, ESM-only (`.js` import extensions, `NodeNext`)       |
| Build          | `tsc` (`target ES2022`, full strict flag set) → `dist/`          |
| Test           | Vitest 4 + `@vitest/coverage-v8`                                 |
| Lint / format  | ESLint 9 flat config + Prettier 3 (double quotes, `printWidth 100`) |
| Boundaries     | `dependency-cruiser` (one-way `@pipelex/sdk → mthds/protocol`)   |
| Task surface   | `Makefile`                                                       |
| License        | MIT                                                              |

## Build & test

```bash
make install    # Install the dependencies from the lockfile (npm ci, which never rewrites it)
make check      # Lockfile check + lint + format check + typecheck + build + depcruise (alias: make c)
make test       # Run the test suite (alias: make t)
make test-e2e   # E2E suite against a live pipelex-api (alias: make te) — PIPELEX_E2E_BASE_URL, default http://localhost:8081
make all        # Clean, check, and test
make build      # TypeScript compilation only
make clean      # Remove dist/ and tsbuildinfo
```

Always run `make check` before committing.

## Structure

Flat `src/` — the SDK has one client, so there is no runner/registry abstraction.

```
src/
├── index.ts        # Public barrel: re-exports mthds/protocol + the client/models/runs/errors
├── client.ts       # PipelexApiClient — request pipeline + all routes (implements MTHDSProtocol, all but validate)
├── models.ts       # Dict concretes, /v1/validate surface, tools + crate route req/resp models
├── runs.ts         # Run-lifecycle types + the single poll loop (pollUntilResult)
└── errors.ts       # Typed errors (derive from PipelineRequestError from mthds/protocol)
tests/              # Vitest suites (mock the fetch boundary)
tests/e2e/          # E2E suites (*.e2e.ts) against a LIVE pipelex-api — excluded from `make test`, run via `make test-e2e`
docs/               # Architecture and surface documentation
```

## Architecture

The dependency direction is strictly one-way: `@pipelex/sdk → mthds`, and only through the published `mthds/protocol` subpath — never a deep import into `mthds` internals, and `mthds` must never import from `@pipelex/sdk`. The one exception is the Node host, `src/node-host/node.ts`, which loads the `mthds` root entry's tree lister by a dynamic `import("mthds")` only when a caller gives a `directory`. `dependency-cruiser` enforces both.

**The barrel bundles for the browser with nothing marked external.** What only Node has (a Node built-in, `undici`, the `mthds` root entry) is loaded by the Node host alone, which the rest of the SDK reaches through `loadNodeHost()` (`src/node-host.ts`) and the package's own `#node-host` import, resolved by the `imports` map of `package.json` to the host under `node` and to `src/node-host/unavailable.ts` everywhere else. Never import a Node built-in or `undici` from another module of the barrel's graph: `dependency-cruiser` refuses it, and `tests/browser-bundle.test.ts` bundles the built package for the browser and fails on it (`docs/architecture.md`, "The Node host").

The client re-implements the official MTHDS protocol routes using MTHDS *types* (from `mthds/protocol`); it does not delegate to the `mthds` package's protocol client. This keeps route shapes pinned to the standard so they can't silently diverge.

**Brand boundary:** MTHDS-branded concepts (protocol wire models, the standard validation shapes) belong to `mthds`. Pipelex-branded concepts (`PipelexApiClient`, run lifecycle, `PipelexValidationResult`, hosted-product errors, the product catalog/billing/keys surface) belong here. Inside a Pipelex envelope, keep neutral field names (`bundle_blueprint`, `pipe_io_contracts`, `input_form`, `liftable_pipes`, `graph_spec`) — do not stamp `pipelex_` onto standard artifacts.

See [`docs/architecture.md`](./docs/architecture.md) for the full narrative as the client surface lands.
