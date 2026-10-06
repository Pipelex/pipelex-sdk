# `make create`: from the template to the command for your method

A fresh copy of this template is a command with no method, under the template's own name. `make create` turns it into the command for the method you have, in one command:

```bash
make install
PIPELEX_API_KEY=… make create METHOD=path/to/my_method.mthds
.venv/bin/my-method --help
```

When it finishes, the package holds your method, its generated models and contracts, and a `binding.py` naming the pipe the command runs; the project, its package and its command are named after the method; `.env` points at the API the gesture ran against; and `make all` is green. Nothing is committed: the whole result is a working-tree change for you to review.

This document is part of the template, not of the projects it creates: the gesture is one-shot, and the bootstrap removes it, with this document, once it has run.

## The gesture

| | |
| --- | --- |
| Make | `make create METHOD=<method> [NAME=…] [TITLE=…] [DESCRIPTION=…] [PIPE=…] [AUTHOR_NAME=…] [AUTHOR_EMAIL=…] [REPO_URL=…] [LICENSE=…] [LICENSE_HOLDER=…] [LICENSE_YEAR=…] [DRY_RUN=1]` |
| Script | `.venv/bin/python -m scripts.create <method> [--name …] [--title …] [--description …] [--pipe …] [--author-name …] [--author-email …] [--repo-url …] [--license …] [--license-holder …] [--license-year …] [--dry-run]` |
| Needs | `PIPELEX_API_KEY`, and a base URL that serves `/v1/codegen` and `/v1/pipe-io` (with `method_id` or `method_ref` for a named method, and `GET /v1/methods/{id}` for a catalog id) — see [the key and the base URL](#the-key-and-the-base-url) |
| Runs on | The un-bootstrapped template only: `pyproject.toml` must still name `pipelex-method-cli-python`, the bootstrap skill must be present, and the package must hold no method |
| Exit codes | `0` created (or rehearsed), `1` refused or failed, with a message naming the file or the step, `2` from make when `METHOD` is missing, `130` after Ctrl-C, with the commands left once the method is written — never a traceback |

The arguments are the method-app family's contract, the one `webapp-js`'s `make create` takes, less the two values that choose a method among several (`METHOD_NAME` and `LABEL`), which mean nothing for a command that holds one. A family test runs `make -n create` in both templates and fails when they forward a variable differently.

Nothing asks a question. A value the gesture cannot derive is a refusal naming the flag that supplies it, so a person runs the command exactly as an agent does. Only a variable given on the `make` command line counts: a `NAME` or `TITLE` your shell happens to export is ignored. A value is passed to the script exactly as typed, quotes and `$` included, and a blank one (`TITLE=`) counts as not given.

## The method

`METHOD` is read in this order:

1. **A path that exists** is a bundle, whatever it looks like: a `.mthds` file, or a directory whose `.mthds` files, at any depth, make up the method. A directory is often a methods repository, so what it holds beside its bundle is never entered: a hidden directory such as `.git` or `.venv`, `node_modules`, Python's bytecode cache, and a virtual environment by any name, a directory holding `pyvenv.cfg`. Every hidden entry is skipped too, and nothing in what is skipped is read, refused or copied. `~`, `~/…` and `~user/…` are expanded as a shell would, by the rule the command applies to a file input's path, and a relative path is resolved from the directory you ran `make` in. The files are copied into `src/<package>/method/` as they were read, their relative paths kept.
2. **`mt_…`** is a catalog id, a method stored in your organization's catalog on [app.pipelex.com](https://app.pipelex.com). It stays in the catalog, and `method/method.json` names it.
3. **`github.com/<owner>/<repo>[/<package>…][@<tag>]`**, with or without `https://`, is a published method's address. It stays where it is published, and `method/method.json` names it.

Anything else is refused with the forms listed. A bundle is held to the codegen kit's policies: a symbolic link or a special file, at the path given or anywhere the walk enters under the directory, is refused rather than followed, and so is a file that is not UTF-8, a file or a directory that cannot be read, which the refusal names, a path that is not a `.mthds` file, a directory that holds none, and a directory that contains the project itself.

The method is fetched once, through the codegen kit's own `fetch_generated` (`docs/codegen.md`): `/v1/codegen` and `/v1/pipe-io`, with every guard `make codegen` holds, the self-check of what came back and the revision confirmed by a second `/v1/codegen` included. Everything below is read from that one fetch. The requests are the ones `make codegen` and `make codegen-verify` send for the tree the gesture writes: a bundle's files are labelled as the package will hold them, `method/<path>`, whatever path was typed, so the committed tree is one `make codegen-verify` reproduces. A refusal from the API names a file by that label, and says which directory `method/` stands for.

## What it derives, and how to override it

| Value | Derived from | Override |
| --- | --- | --- |
| Pipe | The method's own entry pipe, `/v1/pipe-io`'s `default_pipe_ref`; otherwise its only pipe; otherwise a refusal listing the pipes | `PIPE`, by `<domain>.<pipe_code>` or by its bare code when only one pipe has it |
| Output model | The model the generated `models.py` defines under the code of the pipe's output concept, as `binding.py`'s import reads it, and whether the output is a list of it | Nothing: a `models.py` that cannot be imported, or that defines no pydantic model of that name, is a refusal, and so is a code another domain of the method also gives a concept, which the codegen then names after each domain (`cv__Result`); `PIPE` chooses a pipe with another output |
| Name | A bundle's pipe's domain; a catalog method's name; an address's package, or its repository when it names no package — kebab-cased, starting with a letter, a letter with an accent keeping its letter (`Résumé screening` gives `resume-screening`) | `NAME` / `--name` |
| Title | A catalog method's name; otherwise the name title-cased, each word the method's own prose spells its own way respelled (`cv-screening` → `CV Screening` where the method writes "CVs") | `TITLE` / `--title` |
| Description | A catalog method's description; otherwise the domain's own `description`; otherwise the chosen pipe's; otherwise a sentence naming the method. Always on one line | `DESCRIPTION` / `--description` |
| Author, repository URL, license | Nothing: the bootstrap's own rules, optional, never invented, MIT unless asked | `AUTHOR_NAME`, `AUTHOR_EMAIL`, `REPO_URL`, `LICENSE`, `LICENSE_HOLDER`, `LICENSE_YEAR` |

The name is the distribution and the command as derived, and the import package with its dashes as underscores: `receipt-review` gives the command `receipt-review` and the package `receipt_review`. The bootstrap refuses a name whose package would be a Python keyword, shadow a standard-library module, shadow one of the project's own or its dependencies' import names, or shadow the import name of any distribution installed in the project's environment, such as `markdown_it`, which `markdown-it-py` provides and rich imports; and it refuses a name that is the name of any package `uv.lock` pins, such as `anyio`, which the dependencies need and the project would replace. Since the name is also the command's, which `uv sync` installs into `.venv/bin/` after the rename, it refuses `python`, `python3`, `pythonw`, `pypy`, `pypy2`, `pypy3` and `graalpy`, which uv reserves for the interpreter and refuses to install, and `activate` and `deactivate`, the virtual environment's own commands, which the project's would replace or collide with. A name the gesture derived is checked by those same rules, which it reads from the bootstrap rather than restating them, before anything else: a method whose domain is `email` or `json` is refused with the derived name, the reason, and `NAME` (`--name`) as the fix.

The pipe's inputs are derived as options the way the command derives them when it loads, so a method whose input form the command cannot offer is refused here, before anything is written, rather than by the first `--help`.

A catalog id comes with a warning: a stored method is scoped to the organization of the key that stored it, so `make codegen` and every run of the command need a key of that organization. A published address is the portable form.

## What it does, in order

The gesture runs in two halves, and nothing is written until the first has finished.

**Read-only.**

1. Refuse anything but the un-bootstrapped template, and a package that already holds a method, a `binding.py` or a generated tree.
2. Read `PIPELEX_BASE_URL` and `PIPELEX_API_KEY` from the shell first, then load the nearest `.env`, the one the command itself would read, without overriding the shell. The key must be set by one of them, and is never sent in plaintext `http:` to a machine other than this one.
3. Plan the method: read the bundle or check that the base URL serves the selector, fetch the catalog entry of a catalog id, fetch the generated tree and the contracts, choose the pipe, bind the output, derive the options, and render `binding.py`, formatted by ruff, in memory. Binding the output imports the generated `models.py` in this process, to check that the command can load it, a dry run included: it is the code the command imports on every run, generated by the API your key is configured for.
4. Derive the project's name, title and description, and check a derived name by the bootstrap's rules.
5. Plan `.env`.
6. Run the bootstrap with `--dry-run` and the derived values, which validates every one of them: a name it would refuse, an author email without a name, a malformed license year. It is also handed the `binding.py` the gesture will write, as a temporary file outside the project, and checks it with the rest of the tree, so a binding the real run would refuse is refused here; its `PIPE_REF` is the method's own pipe reference and is never read for that, so a pipe named `planning.create_plan` is no refusal. A refusal here stops the gesture with nothing written. Every value is handed over as `--flag=value`, so a title or a description derived from the method may start with dashes.

`DRY_RUN=1` stops at this point and prints the plan: the identity, the pipe with its output and its options, the env file, any warning (each line starting `! `), and the steps below. It writes nothing, but it has imported the generated models to check the binding (step 3).

**Write.**

1. **Write the method**: `method/`, the generated tree through the codegen kit's own `write_generated`, so that it is exactly the tree `make codegen` would write, and `binding.py`. Nothing is overwritten: each part is created exclusively before anything is written into it, so a `generated/` that appeared since the read-only half is refused and left as it is. If a write fails, everything this step created is removed, and nothing else, so the template is exactly as it was and the gesture can be run again.
2. **Run the bootstrap** with the derived values and `--clean`. It renames the distribution, the package directory under `src/` and the command; rewrites the template's identifier wherever the project keeps it, `.gitattributes` and the Makefile included; renders the README; rewrites `CLAUDE.md`'s description line, `AGENTS.md`'s heading, the license and the changelog; and removes what only the template needs: this gesture, its planning code, its tests and their fixtures, this document, and the passages describing them. Its warnings start with `warning: `. It writes each file whole, and `pyproject.toml` last, so a bootstrap that stops part-way leaves a tree that its own command, run again, finishes.
3. **Write `.env`**, unless it already exists or the key is to be left where it was found (see below).
4. **Re-sync `uv.lock` and the environment** with `uv sync`, since the project was renamed, its command with it, and CI installs with a locked `uv.lock`.
5. **Run `make all`.**
6. **Remove the bootstrap skill**, only once `make all` is green, with `.claude/` when that leaves it empty.

A failure after step 1 cannot be undone by running the gesture again, because the package now holds a method and the gesture refuses it. The message names the steps that are left, and so does a Ctrl-C, which then exits with code 130; a Ctrl-C while the method is being written leaves the template as it was, and one before that has written nothing. Which of these a Ctrl-C left is read from the disk: one landing once the method's last file is written finds the whole method there, which counts as written, and a second Ctrl-C that cuts the removal short leaves parts of it, which the message names with the `rm -rf` that removes them before the gesture runs again. The gesture plans the method under `asyncio.run` and does everything else outside the event loop, where a Ctrl-C stops it where it lands, rather than as a cancellation that code with no `await` would meet only once it had finished. The steps left are ordinary commands: when the bootstrap is what failed or was interrupted, its own command line with the values the gesture planned, with `--force` when it had already written `pyproject.toml`, which then names the project; the copy of `.env.example` to `.env` when the gesture was to write one and none exists yet, which is also what is left when writing `.env` failed, naming the base URL to set in it beside the key when your shell or a `.env` above chose one rather than the default, since the method was generated against that API; then `uv sync`, `make all`, and `rm -rf .claude/skills/bootstrap`. Fix the cause first, and never by editing `src/<package>/generated/`.

## The key and the base URL

`.env` is written only when it does not exist, from `.env.example`, and is created readable by you alone. It holds:

- **exactly one `PIPELEX_BASE_URL` line**, holding the base URL the gesture ran against: the one your shell exports, the one a `.env` above the project sets, or the default, `https://api.pipelex.com`, when neither does, and the plan says which. A `.env` above that sets other variables only leaves the base URL to its default. Any other assignment of it is dropped, so the file can never hold two;
- **`PIPELEX_API_KEY`**, set to the value your shell exports. The gesture refuses to run without a key, so one your shell does not export came from a `.env` above the project, and then no `.env` is written at all (below).

Every value is written in single quotes, so a `#`, a `$` or a space in it reaches the command as it was. A value holding a line break, `${`, which python-dotenv expands as a variable even inside quotes, or a byte that is not UTF-8, is refused: write `.env` yourself and run the gesture again. An `.env` or `.env.example` the gesture must read and cannot, unreadable or not UTF-8, is refused by name before anything is written.

The command reads the nearest `.env`, in the directory it runs from or the first directory above it that has one, and only that one. So when the key came from a `.env` above the project rather than from your shell, the gesture writes no `.env` at all: one in the project would hide the file that supplies the key, and the gesture copies a key only from the shell. When it does write one while a `.env` above exists, the plan says that the new file hides it.

An existing `.env` is yours and is never touched; when your shell exports a base URL the file disagrees with, the plan says so, because the command reads the file whenever the shell does not set the variable.

## Where the Python gesture differs from `webapp-js`'s

The contract, the two halves, the refusals and the warning prefixes are `webapp-js`'s. What differs, differs because Python does:

- **The env file is `.env`**, the Python convention, loaded by python-dotenv without overriding the shell. Every value is quoted, so a `#` or a `$` survives, and since python-dotenv reads one file, the gesture writes none when the key came from a `.env` above the project.
- **The rename reaches the import package.** The bootstrap moves `src/pipelex_method_cli_python/` to the project's package with a plain filesystem move, never `git mv`, so it works before `git init`, and rewrites that identifier everywhere the project keeps it. A fixed import name would make two commands made from the template collide in one environment, and give every project's tracebacks a generic name.
- **The bootstrap and the gesture are written in Python**, so a copy of the template needs no Node. The gesture runs both with the project's own interpreter, `.venv/bin/python`, never through `uv run`, which would re-sync the environment first and undo `make use-local`; `make create` runs `uv sync` itself first when `.venv/` is missing.

## Known limits

- A method whose concepts use a native date or time (`native.Date`) generates a `models.py` that cannot be imported until the hosted engine ships the fix. The gesture imports the generated models before anything is written, so such a method is refused with nothing changed.
- A pipe whose output concept shares its code with a concept of another domain of the method, or with a native concept, is refused: the codegen then names every concept of that code after its domain (`cv__Result`, `legal·contracts__Result`), and the gesture binds an output only to a code that names one concept. Rename one of the concepts, or run another pipe with `PIPE`.
- A command holds one method, for good. To change it, edit `src/<package>/method/` — the bundle, or the tag in `method.json` — run `make codegen`, and keep `binding.py` in step with the regenerated tree. For another method, create another command from a fresh copy.

## References

- [`codegen.md`](codegen.md) — the codegen kit the gesture fetches and writes through.
- [`ci.md`](ci.md) — how the gesture is proven: the offline test that creates a project per kind of method, and the live proof taken by hand.
- `scripts/create.py` and `scripts/create_plan.py` — the behavior, tested in `tests/test_create.py`, `tests/test_create_plan.py` and `tests/test_create_tree.py`.
- `.claude/skills/bootstrap/SKILL.md` — the bootstrap the gesture drives, and its interactive path.
