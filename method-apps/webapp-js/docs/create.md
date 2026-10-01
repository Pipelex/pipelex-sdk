# `make create`: from the template to the app for your method

A fresh copy of this template is an app with no method, under the template's own name. `make create` turns it into the app for the method you have, in one command:

```bash
PIPELEX_API_KEY=… make create METHOD=path/to/my_method.mthds
make dev   # http://127.0.0.1:4300
```

When it finishes, the page is your method's input form and result view, the project is named after the method, `.env.local` points at the API the gesture ran against, and `make all` is green. Nothing is committed: the whole result is a working-tree change for you to review.

This document is part of the template, not of the projects it creates: the gesture is one-shot, and the bootstrap removes it — with this document — once it has run.

## The gesture

|            |                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Make       | `make create METHOD=<method> [NAME=…] [TITLE=…] [DESCRIPTION=…] [METHOD_NAME=…] [PIPE=…] [LABEL=…] [AUTHOR_NAME=…] [AUTHOR_EMAIL=…] [REPO_URL=…] [LICENSE=…] [LICENSE_HOLDER=…] [LICENSE_YEAR=…] [DRY_RUN=1]`                        |
| npm        | `npm run create -- <method> [--name …] [--title …] [--description …] [--method-name …] [--pipe …] [--label …] [--author-name …] [--author-email …] [--repo-url …] [--license …] [--license-holder …] [--license-year …] [--dry-run]` |
| Needs      | `PIPELEX_API_KEY`, and a base URL that serves the form views (and `method_ref`, for an address) — see [the base URL](#the-key-and-the-base-url)                                                                                      |
| Runs on    | The un-bootstrapped template only: `package.json` must still be named `pipelex-method-webapp-js`, and the bootstrap skill must be present                                                                                            |
| Exit codes | `0` created (or rehearsed), `1` refused or failed — never a thrown stack                                                                                                                                                             |

`METHOD` is the one required value, in any of the forms `make add-method` takes: a path to a `.mthds` file or to a directory of them, a catalog id (`mt_…`), or a published address (`github.com/<owner>/<repo>[/<package>][@<tag>]`). [`add-method.md`](add-method.md) describes each.

Nothing asks a question. A value the gesture cannot derive is a refusal naming the flag that supplies it, so a person runs the command exactly as an agent does. Only a variable given on the `make` command line counts: a `NAME` or `TITLE` your shell happens to export is ignored. A value is passed to the script exactly as typed, quotes and `$` included, and a blank one (`TITLE=`) counts as not given.

## What it derives, and how to override it

The method is fetched once, and everything below is read from that one fetch.

| Value                           | Derived from                                                                                                                                                      | Override                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The method's directory name     | `add-method`'s rule: a bundle's domain, a catalog method's name, an address's package — kebab-cased                                                               | `METHOD_NAME` / `--method-name`                                                        |
| Package name                    | The method's directory name                                                                                                                                       | `NAME` / `--name`                                                                      |
| Title                           | A catalog method's name; otherwise the package name, title-cased (`receipt-review` → `Receipt Review`)                                                            | `TITLE` / `--title`                                                                    |
| Description                     | A catalog method's description; otherwise the domain's own `description`; otherwise the chosen pipe's; otherwise a sentence naming the method. Always on one line | `DESCRIPTION` / `--description`                                                        |
| Pipe, label                     | `add-method`'s pipe rule and label rule                                                                                                                           | `PIPE`, `LABEL`                                                                        |
| Author, repository URL, license | Nothing: the bootstrap's own rules — optional, never invented, MIT unless asked                                                                                   | `AUTHOR_NAME`, `AUTHOR_EMAIL`, `REPO_URL`, `LICENSE`, `LICENSE_HOLDER`, `LICENSE_YEAR` |

`NAME` and `METHOD_NAME` are separate on purpose: the package names the app and the directory names the method, and they coincide only until one of them is overridden.

## What it does, in order

The gesture runs in two halves, like `make add-method`, and nothing is written until the first has finished.

**Read-only.**

1. Refuse anything but the un-bootstrapped template.
2. Read `PIPELEX_BASE_URL` and `PIPELEX_API_KEY` from the shell first, then load the env files Next.js reads (`.env.local`, `.env`, and their mode-specific variants), noting which file supplied each value the shell did not set. The key must be set by one of them.
3. Run `add-method`'s read-only half: fetch the method, choose the pipe, derive every name, refuse every collision, and render every file in memory.
4. Derive the project's name, title and description.
5. Plan `.env.local`.
6. Run the bootstrap with `--dry-run` and the derived values, which validates every one of them: a package name npm would refuse, an author email without a name, a malformed license year. A refusal here stops the gesture with nothing written.

`DRY_RUN=1` stops at this point and prints the plan: the identity, the method's slice, the env file, and the steps below.

**Write.**

1. **Scaffold the method** with `add-method`'s write half. If it fails, it removes what it wrote, so the template is exactly as it was and the gesture can be run again.
2. **Run the bootstrap** with the derived values and `--clean`. It names the project, rewrites the README, `CLAUDE.md`, `AGENTS.md`, `src/site.ts`, the license and the changelog, and removes what only the template needs — this gesture, its test, this document and the passages describing them.
3. **Write `.env.local`**, unless it already exists (see below).
4. **Re-sync `package-lock.json`** with `npm install --package-lock-only`, since the package was renamed and CI installs with `npm ci`.
5. **Run `make all`.**
6. **Remove the bootstrap skill**, only once `make all` is green.

A failure after step 1 cannot be undone by running the gesture again, because the template has become a project and the gesture refuses it. The message names the steps that are left, and they are ordinary commands: fix the cause (never by editing `src/generated/`), then `npm install --package-lock-only`, `make all`, and `rm -rf .claude/skills/bootstrap`.

## The key and the base URL

`.env.local` is written only when it does not exist, from `.env.example`. Next.js reads it before every other env file, and the first file that assigns a variable wins even when the value is empty, so the gesture writes it such that it hides nothing another file supplies:

- **exactly one `PIPELEX_BASE_URL` line**, holding the base URL the gesture ran against — the one your shell exports, the one an env file such as `.env` sets, or the default when neither does. Any other assignment of it is dropped, so the file can never hold two;
- **`PIPELEX_API_KEY`** set to the value your shell exports. When the key came from another env file instead, `.env.local` carries no `PIPELEX_API_KEY` line at all, only a comment naming that file, so the file keeps supplying it and the secret is not copied a second time. The gesture reads the env files a production build reads, as every script here does, so that file can be `.env.production` or `.env.production.local`, which `make dev` never opens. In that case the comment and the plan say that the dev server will not see the key, and tell you to put it in `.env` or `.env.development.local` before `make dev`.

The file is created readable by you alone. An existing `.env.local` is yours and is never touched; when your shell exports a base URL the file disagrees with, the plan says so, because the app reads the file whenever the shell does not set the variable.

## What it leaves for later

- **A second method** is `make add-method`, which the project keeps. Two methods render as tabs.
- **A change to the method** is an edit under `methods/<name>/` — the bundle, or the tag in `method.json` — followed by `npm run codegen`.
- **The first commit** is yours: `git status` shows everything the gesture did.

## References

- [`add-method.md`](add-method.md) — the scaffold the gesture runs, and its three source kinds.
- [`ci.md`](ci.md) — how the gesture is proven: the offline fixture test, and a local run against the live API.
- `scripts/lib/create.mts` — the behavior, with its helpers unit-tested in `create.test.mts`.
- `.claude/skills/bootstrap/SKILL.md` — the bootstrap the gesture drives, and its interactive path.
