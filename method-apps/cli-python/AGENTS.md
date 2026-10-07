# Agent instructions — pipelex-method-cli-python

The full project guide for AI coding agents is [`CLAUDE.md`](CLAUDE.md) — read it; everything there applies regardless of which agent you are. The rules below are the ones that cause real damage when missed:

<!-- template-only:begin -->

- **In a fresh copy of the template, `make create METHOD=<bundle path | mt_… | address>` is the whole setup**, with `PIPELEX_API_KEY` in the shell. It writes the method into the package, names the project after it, writes `.env` and leaves `make all` green, and `DRY_RUN=1` shows the plan first. Never bind a method by hand, and never run the bootstrap on its own except to finish a `make create` whose message says to ([`docs/create.md`](docs/create.md)).

<!-- template-only:end -->

- **stdout is the result, as JSON, and nothing else.** Everything else a change prints (progress, ids, paths, costs, warnings, errors) goes to the stderr console. A stray `print` breaks every script that pipes the command.
- **Never fall back from a durable run to a blocking one, and never call `start_and_wait`.** A server that cannot hold runs is an error that names `--blocking`; the person chooses the mode.
- **One `asyncio.run`, in `cli.py`.** Everything under `lib/run.py` is a coroutine over the client `execute_plan` opened.
- **Run tools through the Makefile, never with `uv run`**, which re-syncs the environment and silently undoes `make use-local`.
- **Tests replace `lib/client.py`'s `make_client` with the `fake_client` fixture, never the `pipelex_sdk` package**, and keep stdout and stderr apart in every assertion.
- **Never edit anything under `src/pipelex_method_cli_python/generated/`** once it exists: the codegen writes and stamps it. After changing the method, run `make codegen` and commit the tree; `make check` fails until you do.
- **Never write an option for one input by hand.** The options are derived from the committed input form when the command loads (`lib/inputs.py`), and what each value puts on the wire is held to the web app template's form kernel by `tests/test_wire_table.py`.
- **After any code change, run `make all`** (ruff, the format check, pyright strict, the offline codegen check, the tests and the build). Do not declare a task done until it passes. If formatting fails, run `make format`.
- **Prefer `make agent-test` over `make test`**: silent on success, full output on failure.
