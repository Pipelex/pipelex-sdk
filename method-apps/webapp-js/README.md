# pipelex-method-webapp-js

A Next.js 16 template for an app that runs [MTHDS](https://mthds.ai) methods through the [Pipelex](https://pipelex.com) API with [`@pipelex/sdk`](https://www.npmjs.com/package/@pipelex/sdk). Each method's input form and result view are rendered from the method's own contract, so adding a method writes no form fields and no result markup.

The template ships no method. It ships what every method needs: blocking and durable execution, a server-side input gate, file uploads, classified errors, a cost report, and the codegen kit that projects a method into typed code. One command turns a copy of it into the app for your method.

Looking for worked examples instead? [`pipelex-starter-js`](https://github.com/Pipelex/pipelex-starter-js) is the gallery this template was extracted from, with several demo methods presented as tabs.

## Use this template

This template is the `webapp-js/` directory of the [`pipelex-method-apps`](https://github.com/Pipelex/pipelex-method-apps) repository, which holds one template per shape and language. A project starts as a copy of this directory alone. The family's initializer writes it into a new directory, commits it as it came, and runs `make create` there with the method you have:

```bash
export PIPELEX_API_KEY=…                               # from app.pipelex.com
npm create @pipelex/method-app@latest my-app -- --method path/to/my_method.mthds
make -C my-app serve                                   # the URL, once the page answers
```

`make serve` starts the dev server in the background, prints its URL once the page answers, and `make stop` stops it; `make dev` runs the same server in this terminal instead, on http://127.0.0.1:4300. The initializer's [README](https://github.com/Pipelex/pipelex-method-apps/tree/main/initializers/js#readme) lists its options, one per `make create` variable below.

`--method`, which the initializer hands to `make create` as `METHOD`, is a `.mthds` file or a directory of them, a method id from your organization's catalog (`mt_…`, from [app.pipelex.com](https://app.pipelex.com)), or a published package address (`github.com/Pipelex/methods/text_stats@v0.1.1`).

`make create` scaffolds the method, names the project after it (the package name, the title and the description all come from the method, and `--name`, `--title` and `--description` override them, which are `NAME=`, `TITLE=` and `DESCRIPTION=` to `make create` itself), writes `.env.local` from your shell, and runs `make all`. It commits nothing, so `git diff` against the initializer's pristine commit shows everything it did. `--dry-run` (`DRY_RUN=1`) prints the plan first. [`docs/create.md`](docs/create.md) is the reference.

To choose every value yourself instead, open the repository in [Claude Code](https://claude.com/claude-code), run `/bootstrap`, then `make add-method METHOD=…`.

## What a method looks like here

With no method, the page shows an empty state that names `make add-method`. With one method, its form is the page. With several, they are tabs. The registry is `src/methods.ts`.

`make add-method` writes one vertical slice per method, and `make create` runs it for the first one:

- `methods/<name>/` — the method's own `.mthds` files, or a `method.json` naming a method that lives elsewhere. Changing the method is editing the files, or the tag, and running `npm run codegen`.
- `src/generated/<name>/` — the method's zod schemas, binders, input and output contracts, and the codegen lock. Committed, and never edited by hand.
- `src/types/`, `src/actions/`, `src/components/` — a typed narrower, the Server Actions for both execution modes with a test, and the form.
- `src/methods.ts` — one import and one registry entry.

The command refuses rather than overwriting a slice that already exists, and `DRY_RUN=1` prints the plan without writing anything. [`docs/add-method.md`](docs/add-method.md) is the reference, including how to remove a method.

## How it works

1. A form renders the method's inputs from its committed input-form descriptor with `@pipelex/mthds-form`. A file the user drops is stored at once, straight from the browser to Pipelex storage with an upload grant the method's Server Action asks for, and the form keeps its reference. The form then calls the `useRun` hook, which dispatches to the Server Actions for the deployment's execution mode.
2. The Server Action gates the inputs against the same committed contract — a Server Action is a public endpoint, so the browser's check is only UX — and checks that every file position holds a reference it accepts.
3. The SDK runs the method: `execute` in **Blocking** mode, or `start` and a poll loop in **Durable** mode, the default, which survives the hosted gateway's ~30s synchronous cap and streams live status.
4. A narrower validates the main output against the zod schema generated from the method's contract.
5. `<RunResult>` renders the validated output from the method's output-form descriptor, or `<ErrorDisplay>` shows a classified error. A file the run produced is streamed from the app's own origin through `/api/assets/…`, so the store's signed link is never what the browser fetches (the run's JSON receipt still carries it for a reader who opens that view), and `<RunDetails>` shows the run's id with a Copy button, and what the run consumed behind a closed "Usage and cost" disclosure.

[`docs/input-form.md`](docs/input-form.md) covers the forms and result views, and [`docs/codegen.md`](docs/codegen.md) covers the generated types and the checks that keep them current.

## Prerequisites

- Node.js 22.12+.
- Access to the **hosted Pipelex API**, currently in private beta. Join the waitlist at [go.pipelex.com/waitlist](https://go.pipelex.com/waitlist); once you have access, get an API key at [app.pipelex.com](https://app.pipelex.com).

## Environment variables

| Variable                     | Purpose                                                                               | Default                   |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| `PIPELEX_API_KEY`            | Bearer token used by the SDK                                                          | (required at runtime)     |
| `PIPELEX_BASE_URL`           | Pipelex API base URL                                                                  | `https://api.pipelex.com` |
| `NEXT_PUBLIC_EXECUTION_MODE` | Execution mode for every method — `durable` or `blocking`. The page offers no switch. | `durable`                 |

**`make create`, `make add-method`, `npm run codegen` and `npm run codegen:verify` need `PIPELEX_API_KEY` and the network.** Each one asks the API for the form views codegen needs and, for a catalog id or a package address, checks that the base URL resolves that kind of method, naming the missing capability when one is not served. `make all` needs neither a key nor a network.

A variable already exported in your shell wins over `.env.local`.

## Where the app listens

`make dev` and `make start` listen on `127.0.0.1:4300`, which only this machine can reach. That is deliberate. The app's Server Actions run methods with the `PIPELEX_API_KEY` in the server's environment, and nothing authenticates the browser that calls them, so anyone who can reach the server runs methods billed to your key. Two variables change it, on the command line or from the shell:

| Variable   | Purpose                                                                                          | Default     |
| ---------- | ------------------------------------------------------------------------------------------------ | ----------- |
| `APP_HOST` | The interface the server binds. `0.0.0.0` opens it to your network.                              | `127.0.0.1` |
| `APP_PORT` | The port, to run a second checkout beside one that already holds 4300: `make dev APP_PORT=4301`. | `4300`      |

Widen the host only on a network you trust, for a container or to open the app on another device: `make dev APP_HOST=0.0.0.0`. The Makefile prints a warning each time a server starts beyond loopback. `npm run dev` and `npm run start` read the same two variables and fall back to the same defaults.

`make serve` runs the dev server in the background and never beyond loopback: it refuses an `APP_HOST` that is not, and it stops a server that turns out to listen anywhere else before a page can compile. It takes `APP_PORT` when you give one, and otherwise the first port from 4300 to 4309 that no other directory holds. It then checks that the listener is the server it started, requests the page, and ends with one line: `serving http://127.0.0.1:4300/ — "<title>"`, or a refusal or a failure naming its cause. The server's log is `.serve/server.log`. Running it again reports the same server as `already-serving`, and a server you started here with `make dev` is reported too and left alone. Two runs in one checkout take turns, the second waiting for the first. `make stop` stops only what `make serve` started. It needs `lsof`, which macOS ships; on Linux, install it from your distribution's packages if `make serve` says it is missing, BusyBox's included. Outside Linux it also needs to run `ps`, which a sandbox may refuse, as Codex's does on macOS: `make serve` then says `refused: no-ps` before starting anything, and so does `make stop` while the first process of the server it recorded still runs, leaving that server and its record as they were; both work once run outside the sandbox.

## Make targets

| Target                    | Purpose                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `make dev`                | Start the Next.js dev server on `127.0.0.1:4300` — see [Where the app listens](#where-the-app-listens)                              |
| `make serve`              | Start the dev server in the background, prove the page answers, and print its URL                                                   |
| `make stop`               | Stop the dev server `make serve` started                                                                                            |
| `make build`              | Production build                                                                                                                    |
| `make create`             | Turn the template into the app for one method — `METHOD=<bundle \| mt_… \| address>` (needs an API key)                             |
| `make add-method`         | Scaffold a method into the app — `METHOD=<bundle \| mt_… \| address>` (needs an API key)                                            |
| `make codegen`            | Regenerate `src/generated/` from `methods/` (needs an API key)                                                                      |
| `make codegen-check`      | Prove `src/generated/` is current — offline, no key                                                                                 |
| `make codegen-verify`     | Ask the API whether the committed types still match the methods (needs an API key)                                                  |
| `make test`               | Unit tests                                                                                                                          |
| `make test-e2e`           | **Optional** Playwright e2e — a live spec costs an LLM call (prompts first; auto-skips without a key)                               |
| `make check`              | lint + format-check + typecheck + codegen-check                                                                                     |
| `make all`                | check + test + build                                                                                                                |
| `make use-local`          | Install the sibling `../pipelex-sdk-js` and `../mthds-form` checkouts into `node_modules` (`SIBLINGS_DIR=` names another directory) |
| `make use-local-form`     | Install the sibling `../mthds-form` checkout alone                                                                                  |
| `make use-published`      | Restore the `@pipelex/sdk` and `@pipelex/mthds-form` versions the lockfile pins                                                     |
| `make use-published-form` | Restore the `@pipelex/mthds-form` version the lockfile pins                                                                         |
| `make local-status`       | Say whether each `@pipelex` package comes from a sibling checkout or from npm                                                       |

`make help` lists them all.

## Stack

Next.js 16 (App Router), React 19, TypeScript 5 (strict), Tailwind CSS 4 (configured in CSS), Vitest 4 with Testing Library, Playwright, ESLint 9, Prettier 3, Husky with lint-staged, [`@pipelex/sdk`](https://www.npmjs.com/package/@pipelex/sdk) and [`@pipelex/mthds-form`](https://www.npmjs.com/package/@pipelex/mthds-form).

## Documentation

- [`docs/create.md`](docs/create.md) — turning the template into the app for one method.
- [`docs/add-method.md`](docs/add-method.md) — adding a method, and removing one.
- [`docs/codegen.md`](docs/codegen.md) — the generated types and the checks that keep them current.
- [`docs/input-form.md`](docs/input-form.md) — how the input form and the result view are rendered from a method's contract.
- [`docs/errors.md`](docs/errors.md) — what a person reads when something fails, and where a failed run's reason comes from.
- [`docs/ci.md`](docs/ci.md) — what the pull-request checks prove, and how `make create` is proven against the live API.
- [`docs/chrome-lineage.md`](docs/chrome-lineage.md) — what this template took from the gallery, and what it changed.
- [`CLAUDE.md`](CLAUDE.md) — the project guide for coding agents.

## License

This project is licensed under the [MIT license](LICENSE). Runtime dependencies are distributed under their own licenses via npm.
