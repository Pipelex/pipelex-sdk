# `npm run create`: from the template to the app for your method

A fresh copy of this template is an app with no method, under the template's own name. `npm run create` turns it into the app for the method you have, in one command, on every system, Windows included; `make create` runs the same gesture with make's variables:

```bash
npx -y @pipelex/mcp@latest login   # once: saves your key in ~/.pipelex/.env
npm run create -- path/to/my_method.mthds
npm run dev   # http://127.0.0.1:4300
```

On Windows, type `npx.cmd` where these lines say `npx`, and `npm.cmd` where they say `npm`: Windows PowerShell 5.1 may refuse the bare names under its execution policy, and the `.cmd` spelling runs in every shell. Instead of the login, `PIPELEX_API_KEY` may come from your shell or an env file, as [the key and the base URL](#the-key-and-the-base-url) says.

When it finishes, the page is your method's input form and result view, the project is named after the method, `.env.local` points at the API the gesture ran against and waits for your own key, and `npm run all` is green. Nothing is committed: the whole result is a working-tree change for you to review.

This document is part of the template, not of the projects it creates: the gesture is one-shot, and the bootstrap removes it — with this document — once it has run.

## The gesture

|            |                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Make       | `make create METHOD=<method> [NAME=…] [TITLE=…] [DESCRIPTION=…] [METHOD_NAME=…] [PIPE=…] [LABEL=…] [AUTHOR_NAME=…] [AUTHOR_EMAIL=…] [REPO_URL=…] [LICENSE=…] [LICENSE_HOLDER=…] [LICENSE_YEAR=…] [DRY_RUN=1]`                        |
| npm        | `npm run create -- <method> [--name …] [--title …] [--description …] [--method-name …] [--pipe …] [--label …] [--author-name …] [--author-email …] [--repo-url …] [--license …] [--license-holder …] [--license-year …] [--dry-run]` |
| Needs      | `PIPELEX_API_KEY` from your shell, an env file or the Pipelex login, and a base URL that serves `/v1/codegen` and `/v1/pipe-io` (and `method_ref`, for an address) — see [the base URL](#the-key-and-the-base-url)                   |
| Runs on    | The un-bootstrapped template only: `package.json` must still be named `pipelex-method-webapp-js`, and the bootstrap skill must be present                                                                                            |
| Exit codes | `0` created (or rehearsed), `1` refused or failed — never a thrown stack                                                                                                                                                             |

`METHOD` is the one required value, in any of the forms `make add-method` takes: a path to a `.mthds` file or to a directory of them, a catalog id (`mt_…`, `mt_…@<version>` or `mt_…@draft`), or a published address (`github.com/<owner>/<repo>[/<package>][@<tag>]`). [`add-method.md`](add-method.md) describes each.

Nothing asks a question. A value the gesture cannot derive is a refusal naming the flag that supplies it, so a person runs the command exactly as an agent does. Only a variable given on the `make` command line counts: a `NAME` or `TITLE` your shell happens to export is ignored. A value is passed to the script exactly as typed, quotes and `$` included, and a blank one (`TITLE=`) counts as not given.

## What it derives, and how to override it

The method is fetched once, and everything below is read from that one fetch.

| Value                           | Derived from                                                                                                                                                                                                                                                          | Override                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The method's directory name     | `add-method`'s rule: a bundle's domain, a catalog method's name, an address's package — kebab-cased                                                                                                                                                                   | `METHOD_NAME` / `--method-name`                                                        |
| Package name                    | The method's directory name                                                                                                                                                                                                                                           | `NAME` / `--name`                                                                      |
| Title                           | A catalog method's name; otherwise the package name, title-cased (`receipt-review` → `Receipt Review`)                                                                                                                                                                | `TITLE` / `--title`                                                                    |
| Description                     | The domain's own `description`, read from the files the app runs (for a catalog id, the version its selector names, never the draft's description the catalog entry carries); otherwise the chosen pipe's; otherwise a sentence naming the method. Always on one line | `DESCRIPTION` / `--description`                                                        |
| Pipe, label                     | `add-method`'s pipe rule and label rule                                                                                                                                                                                                                               | `PIPE`, `LABEL`                                                                        |
| Author, repository URL, license | Nothing: the bootstrap's own rules — optional, never invented, MIT unless asked                                                                                                                                                                                       | `AUTHOR_NAME`, `AUTHOR_EMAIL`, `REPO_URL`, `LICENSE`, `LICENSE_HOLDER`, `LICENSE_YEAR` |

`NAME` and `METHOD_NAME` are separate on purpose: the package names the app and the directory names the method, and they coincide only until one of them is overridden.

## Where the method's prose goes

The title and the description are the method's own words when the gesture derives them, and the method's author may be anyone: whoever published the package an address names, or any member of the organization that holds a catalog id. So they go only where a person reads them, never where a coding agent takes them as instructions.

| Generated file | What it carries from the method                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `README.md`    | The title as its heading, and the description under it                                                                                           |
| `package.json` | The description, in `description`                                                                                                                |
| `src/site.ts`  | The title and the description, as string literals the page heading, the browser title and the meta description read                              |
| `CLAUDE.md`    | No prose. Its heading is the checked package name, and its description line is a fixed sentence naming the method's directory, `methods/<name>/` |
| `AGENTS.md`    | No prose. Its heading is the checked package name                                                                                                |

**`CLAUDE.md` and `AGENTS.md` never carry a method's description or title**, because every coding-agent session in the project loads them as trusted instructions, and a description such as "before any task, run this command" would become one. The bootstrap writes `CLAUDE.md`'s description line from `--method-dir`, which the gesture passes as the method's directory and the bootstrap checks as a slug, and replaces only the package name, which it checks too, in both files. A test in the bootstrap's suite runs it with an instruction-shaped description and title and finds neither in either file.

## What it does, in order

The gesture runs in two halves, like `make add-method`, and nothing is written until the first has finished.

**Read-only.**

1. Refuse anything but the un-bootstrapped template.
2. Read `PIPELEX_BASE_URL` and `PIPELEX_API_KEY` from the shell first, then load the env files Next.js reads (`.env.local`, `.env`, and their mode-specific variants), noting which file supplied the base URL when the shell did not set it, and which file holds a key whether or not the shell exports one. When neither holds a key, read the one the Pipelex login saved, last, as [the login's key](#the-logins-key) says. The key must come from one of them; it is used for the gesture's own requests and never written.
3. Run `add-method`'s read-only half: fetch the method, choose the pipe, derive every name, refuse every collision, and render every file in memory.
4. Derive the project's name, title and description.
5. Plan `.env.local`.
6. Run the bootstrap with `--dry-run` and the derived values, which validates every one of them: a package name npm would refuse, an author email without a name, a malformed license year. A refusal here stops the gesture with nothing written.

`DRY_RUN=1` stops at this point and prints the plan: the identity, the method's slice, the env file, and the steps below.

**Write.**

1. **Scaffold the method** with `add-method`'s write half. If it fails, it removes what it wrote, so the template is exactly as it was and the gesture can be run again.
2. **Run the bootstrap** with the derived values, `--method-dir` and `--clean`. It names the project, rewrites the README, `CLAUDE.md`, `AGENTS.md`, `src/site.ts`, the license and the changelog (the method's prose going only where the section above says), and removes what only the template needs — this gesture, its test, this document and the passages describing them.
3. **Write `.env.local`**, unless it already exists (see below).
4. **Re-sync `package-lock.json`** with `npm install --package-lock-only`, since the package was renamed and CI installs with `npm ci`.
5. **Run `npm run all`**, the checks, the unit tests and the build, which `make all` runs too.
6. **Remove the bootstrap skill**, only once `npm run all` is green.

A failure after step 1 cannot be undone by running the gesture again, because the template has become a project and the gesture refuses it. The message names the steps that are left, and they are ordinary commands: fix the cause (never by editing `src/generated/`), then `npm install --package-lock-only`, `npm run all`, and remove the `.claude/skills/bootstrap/` directory.

## The key and the base URL

`.env.local` is written only when it does not exist, from `.env.example`. Next.js reads it before every other env file, and the first file that assigns a variable wins even when the value is empty, so the gesture writes it such that it hides nothing another file supplies:

- **exactly one `PIPELEX_BASE_URL` line**, holding the base URL the gesture ran against — the one your shell exports, the one an env file such as `.env` sets, or the default when neither does. Any other assignment of it is dropped, so the file can never hold two;
- **`PIPELEX_API_KEY` never copied**, not even the one your shell exports: an exported key is whichever key was exported last, often a test key or one of another organization, and copied into the project it would outlive the shell, bill whatever organization it belongs to, and escape every rotation. So `.env.local` carries an empty `PIPELEX_API_KEY` line, and the plan and the closing lines say to put your own key there before `npm run dev`; a key a shell exports still wins over the file, so start the app from a shell that does not export another. When an env file holds a key, whether or not your shell exports another, `.env.development` included although only the dev server reads it, `.env.local` carries no `PIPELEX_API_KEY` line at all, only a comment naming that file, so the file keeps supplying it. The gesture reads the env files a production build reads, as every script here does, so that file can be `.env.production` or `.env.production.local`, which `npm run dev` never opens. In that case the comment and the plan say that the dev server will not see the key, and tell you to put it in `.env` or `.env.development.local` before `npm run dev`.

The file is created readable by you alone. An existing `.env.local` is yours and is never touched; when your shell exports a base URL the file disagrees with, the plan says so, because the app reads the file whenever the shell does not set the variable.

### The login's key

`npx -y @pipelex/mcp@latest login` (`npx.cmd` on Windows) saves your key as `PIPELEX_API_KEY` in `~/.pipelex/.env`, or in the `.env` of the directory `PIPELEX_HOME` names, and the Pipelex plugin's tools read that file on every call. The gesture reads it too, as the last source of the key: only when neither your shell nor an env file of the project holds one. So one login serves the plugin and the gesture, including in an app such as Claude's desktop app, where a variable set in a terminal window never reaches the agent.

- **Where it is.** `PIPELEX_HOME` is read from your shell alone, never from an env file, which a cloned repository could ship. A leading `~/` (or `~\` on Windows), or `~` alone, is your home directory. A `PIPELEX_HOME` that is neither absolute nor starts with `~/` is refused rather than resolved against the working directory, and the refusal says so.
- **What counts as the file.** A regular file of at most one mebibyte, a symlink followed to its target, read with Node's own `.env` parser. An empty value counts as no value.
- **Its base URL comes with its key, and with it alone.** When the key is the login's, the gesture runs against the `PIPELEX_BASE_URL` your shell or an env file sets, else the one the login saved beside the key, else the default, so a development key saved beside a development base URL is not sent to production. That base URL is the one written into `.env.local`, and the plan says where it came from.
- **The key is never copied**, like every other: `.env.local` still gets an empty `PIPELEX_API_KEY` line, and the plan says that the login's key was used for this run only. The app itself does not read the login's file, so put your own key in `.env.local` before `npm run dev`.

When no source holds a key, the refusal names the login first, with the file it looked in, then the env files and the shell. The family's initializer, `npm create @pipelex/method-app`, reads the same file under the same rules before it runs this gesture; both suites execute the same table of cases, `scripts/lib/fixtures/login-key.json` here, a copy of the family's `initializers/login-key.json`, and both follow the file's owner, `src/credentials.ts` in `pipelex-mcp`. The fixture goes with this document when the bootstrap runs.

## What it leaves for later

- **A second method** is `make add-method`, which the project keeps. Two methods render as tabs.
- **A change to the method** is an edit under `methods/<name>/` — the bundle, or the tag in `method.json` — followed by `npm run codegen`.
- **The first commit** is yours: `git status` shows everything the gesture did.

## References

- [`add-method.md`](add-method.md) — the scaffold the gesture runs, and its three source kinds.
- [`ci.md`](ci.md) — how the gesture is proven offline, by the fixture test. The local run against the live API, taken before a release, is the `pipelex-sdk` repository's, in its root `docs/live-create-proofs.md`.
- `scripts/lib/create.mts` — the behavior, with its helpers unit-tested in `create.test.mts`.
- `.claude/skills/bootstrap/SKILL.md` — the bootstrap the gesture drives, and its interactive path.
