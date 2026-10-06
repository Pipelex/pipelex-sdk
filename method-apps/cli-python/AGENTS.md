# Agent instructions — pipelex-method-cli-python

The full project guide for AI coding agents is [`CLAUDE.md`](CLAUDE.md) — read it; everything there applies regardless of which agent you are. The rules below are the ones that cause real damage when missed:

<!-- template-only:begin -->

- **In a fresh copy of the template, `make create METHOD=<bundle path | mt_… | address>` will be the whole setup.** In this version it is not written yet: it parses its arguments and refuses, changing nothing, so do not try to bind a method by hand.

<!-- template-only:end -->

- **stdout is the result, as JSON, and nothing else.** Everything else a change prints (progress, ids, paths, costs, warnings, errors) goes to the stderr console. A stray `print` breaks every script that pipes the command.
- **Never fall back from a durable run to a blocking one, and never call `start_and_wait`.** A server that cannot hold runs is an error that names `--blocking`; the person chooses the mode.
- **One `asyncio.run`, in `cli.py`.** Everything under `lib/run.py` is a coroutine over the client `execute_plan` opened.
- **Run tools through the Makefile, never with `uv run`**, which re-syncs the environment and silently undoes `make use-local`.
- **Tests replace `lib/client.py`'s `make_client` with the `fake_client` fixture, never the `pipelex_sdk` package**, and keep stdout and stderr apart in every assertion.
- **Never edit anything under `src/pipelex_method_cli_python/generated/`** once it exists: the codegen writes and stamps it.
- **After any code change, run `make all`** (ruff, the format check, pyright strict, the tests and the build). Do not declare a task done until it passes. If formatting fails, run `make format`.
- **Prefer `make agent-test` over `make test`**: silent on success, full output on failure.
