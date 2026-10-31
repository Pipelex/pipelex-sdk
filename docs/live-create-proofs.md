# The live proofs of `make create`

The method-app templates ship no method, so their `make create` gesture is proven in two halves. The offline half runs inside each template's `make test`, against API responses recorded under the template's tests, and the template's own `docs/ci.md` describes it. The live half runs the gesture against the hosted API, from the repository's root, because no workflow is given a Pipelex API key. It is a maintainers' release check, so it lives here rather than in a template, every file of which ships to the projects made from it.

## When to take them

Take a template's proofs before a release that ships `method-apps` and touched that template's create gesture, its bootstrap, or the code a project created from it runs; the root `/release` skill names them among its live checks. The root `/bump-sdk` and `/bump-mthds-form` take them too, when a bump reaches the gesture or the code it writes. `webapp-js`'s execute no method and spend no model call; `cli-python`'s run each command they create once, which spends a few, so ask before taking them. Record the plane, the date and the outcome where the work is tracked, in the release summary or on the ledger item.

## Running them

The proofs act for the registered test account the repository's other live checks use, QA Builder (dev) in QA SDK (dev), whose key the workspace's `test-account run` hands over beside what the registry of test accounts expects of it, with `PIPELEX_BASE_URL` naming the dev plane ([`live-accounts.md`](live-accounts.md)). From the repository's root:

```bash
test-account run dev-sdk.builder -- make live-create IN=method-apps/webapp-js
test-account run dev-sdk.builder -- make live-create IN=method-apps/cli-python
```

`make live-create` first runs the account check, which reads `GET /v1/me` with the key and stops before anything else on any difference, and refuses the production API, the templates' default, unless `PIPELEX_E2E_ALLOW_PRODUCTION=1` asks for it. For `cli-python` it then asks before it spends, unless `CONFIRM=1` is set, the shell is not a terminal or `CI` is set. It then takes the template's two proofs, one after the other, each in a fresh copy:

- once with the template's bundle fixture, `scripts/lib/fixtures/bundles/receipt-review` in `webapp-js` and `tests/fixtures/bundles/receipt-review` in `cli-python`;
- once with a published address, `github.com/Pipelex/methods/text_stats@v0.1.1`.

`METHOD=<method>` takes one proof instead, with any method `make create` accepts, read from the copy's directory when it is a path. A created command's run needs its arguments, which `scripts/live-create.mjs` records by the command's name, so a `cli-python` proof of another method first adds them to its `CLI_RUNS`.

The proofs read the key from the environment `test-account run` hands them, and never from an env file of this checkout or from the shell that started them: `test-account run` takes every Pipelex credential out of the environment before it hands over its own, and a copy holds only what git tracks or would track, so no `.env.local` or `.env` of the checkout, both of which the templates' `.gitignore` names, is in it.

## A fresh copy of a template

Each proof runs in a fresh copy of the template, never in the checkout or the worktree itself. `scripts/live-create.mjs` takes the template as the checkout holds it: its tracked files with their uncommitted changes, and its untracked files git does not ignore, so never an env file or an install. The bump skills take the proofs before they commit, so `HEAD` alone would prove the template they started from. The script builds that tree in a git index of its own, which leaves the checkout's untouched, writes it through `git archive` into a new temporary directory, gives the copy a repository of its own with a first commit, as a project starts, and runs every command there with the environment it was started with, less the root make's own variables and the template's `APP_HOST` and `APP_PORT`, and with `DO_NOT_TRACK=1`. A release ships what `HEAD` holds, so the script's first line says whether the copies hold changes `HEAD` does not, and a release's proofs are taken once they are committed.

A proof that passes removes its copy. One that fails lists each check that failed and keeps its copy, naming the directory, so it can be read and then removed. A proof stops at the first command that fails, so a gesture that fails is reported with its own output above the verdict.

A Ctrl-C stops the whole run, never only the command it reached: the next step does not start, so neither does the next proof and the model calls it would spend. A SIGTERM or a SIGHUP, as when the terminal closes, stops it the same way. Either way the web app's dev server is stopped and the copy of the proof in progress is kept and named.

## What `webapp-js`'s proof checks

The gesture runs `make all` itself, so a red check fails the proof. Then the copy must be what the gesture promised:

- `package.json` no longer carries the template's name;
- the bootstrap skill, `scripts/create.mts` and `docs/create.md` are gone;
- `.env.local` is readable by its owner alone and holds exactly one `PIPELEX_BASE_URL` line, the one the run used, and one empty `PIPELEX_API_KEY` line, never the key the run used, whose value a failure never shows;
- `make dev` serves a page titled after the method, not the template's "Pipelex Method App", showing the method's form rather than the empty state. The proof starts the copy's dev server on a free loopback port, reads the page, and runs the copy's own `e2e/home.spec.ts` against that server, which checks the heading, the title and a clean hydration.

The proof executes no method, so it spends no model call.

## What `cli-python`'s proof checks

The copy runs `make install` before the gesture, as a person does, and the gesture runs `make all` itself, so a red check fails the proof. Then the copy must be what the gesture promised:

- `pyproject.toml`'s name, the package directory under `src/` and the command are named after the method, the command being its one `[project.scripts]` entry, and no file holds `pipelex_method_cli_python` outside `.venv`, `.git` and `__pycache__`, the copy's own commit of the template and the bytecode the gesture's deleted scripts left behind;
- the bootstrap skill, `scripts/create.py`, `scripts/create_plan.py` and `docs/create.md` are gone, and the `bump-sdk` skill is still there;
- `.env` is readable by its owner alone and holds exactly one `PIPELEX_BASE_URL` line, the one the run used, and one empty `PIPELEX_API_KEY` line, never the key the run used, which the run below reads from the environment;
- `.venv/bin/<name> --help` offers the method's input as an option;
- one run prints its JSON result on stdout, and its run id and cost report on stderr: `.venv/bin/text-stats --text "Hello there. Two sentences."`, and for the receipt review `.venv/bin/receipt-review --receipts starter-python/samples/sample-invoice.pdf`, the repository's own sample. Its input is a `Document`, which the plane hands the model as a file, and the model refuses an image there, so a run given a PNG fails at the provider whatever the template does.

The runs spend a few model calls.
