# Agent instructions — pipelex-starter-js

The full project guide for AI coding agents is [`CLAUDE.md`](CLAUDE.md) — read it; everything there applies regardless of which agent you are. The rules below are the ones that cause real damage when missed:

- **Never edit anything under `src/generated/`** — not even a reformat. Every file carries a stamp, and any edit makes `make check` fail with `hand-edited`. Customize by wrapping from `src/types/` instead. Relatedly, `src/generated/` is excluded from Prettier and ESLint on purpose — do not "fix" that exclusion.
- **After editing anything under `methods/`, run `npm run codegen`** and commit the regenerated `src/generated/` tree in the same commit. `make check` fails until you do. (Regeneration needs `PIPELEX_API_KEY`; the default hosted URL serves the route.)
- **After any code change, run `make all`** (lint + format-check + typecheck + offline codegen check + unit tests + build). Do not declare a task done until it passes. If formatting fails, run `make format` — don't hand-edit to satisfy Prettier.
- **Prefer `make agent-test` over `make test`** — silent on success, full output on failure.
- **No hand-written output shapes, no `as` casts on SDK output** — go through the `parseXxx()` narrowers in `src/types/`, which wrap the generated binders.
- **Server Actions return classified errors** (`{ ok: false, error }`), never throw across the server→client boundary.

Reference docs live in [`docs/`](docs/) — [`docs/codegen.md`](docs/codegen.md) for the generated-types design, [`docs/adopt-in-an-existing-project.md`](docs/adopt-in-an-existing-project.md) for transplanting this pattern into an existing app.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
