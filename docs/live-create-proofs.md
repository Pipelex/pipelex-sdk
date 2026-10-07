# The live proofs of `make create`

The method-app templates ship no method, so their `make create` gesture is proven in two halves. The offline half runs inside each template's `make test`, against API responses recorded under the template's tests, and the template's own `docs/ci.md` describes it. The live half runs the gesture against the hosted API, by hand, because no workflow is given a Pipelex API key. It is a maintainers' release check, so it lives here rather than in a template, every file of which ships to the projects made from it.

## When to take them

Take a template's proof before a release that ships `method-apps` and touched that template's create gesture, its bootstrap, or the code a project created from it runs; the root `/release` skill names them among its live checks. The root `/bump-sdk` and `/bump-mthds-form` take them too, when a bump reaches the gesture or the code it writes. Each proof needs `PIPELEX_API_KEY` in the shell. `webapp-js`'s executes no method and spends no model call; `cli-python`'s runs each command it creates once, which spends a few, so ask before taking it. Record the plane, the date and the outcome where the work is tracked, in the release summary or on the ledger item.

## A fresh copy of a template

Each proof runs in fresh copies of the template, never in the checkout or the worktree itself, each copy with a repository of its own, and the copies are discarded afterwards. From the repository's root:

```bash
copy="$(mktemp -d)/proof"
mkdir "$copy" && git archive HEAD:method-apps/<template> | tar -x -C "$copy" \
  && cd "$copy" && git init -q && git add -A && git commit -q -m "as copied"
```

`git archive` takes the template as `HEAD` holds it, which is what a release ships, so commit the work first. Run each proof against the default base URL, `https://api.pipelex.com`, which a `PIPELEX_BASE_URL` exported in the shell would override.

## `webapp-js`

Run it twice, each time in a fresh copy:

- once with the bundle fixture, `make create METHOD=scripts/lib/fixtures/bundles/receipt-review`;
- once with a published address, `make create METHOD=github.com/Pipelex/methods/text_stats@v0.1.1`.

The gesture runs `make all` itself, so a red check fails the run. Then check that each copy is what the gesture promised:

- `package.json` no longer carries the template's name;
- the bootstrap skill, `scripts/create.mts` and `docs/create.md` are gone;
- `.env.local` holds exactly one `PIPELEX_BASE_URL` line, the one the run used;
- `make dev` serves a page titled after the method, showing its form, which `npx playwright test e2e/home.spec.ts` also checks.

The run executes no method, so it spends no model call.

## `cli-python`

Run it twice, each time in a fresh copy where `make install` has run:

- once with the bundle fixture, `make create METHOD=tests/fixtures/bundles/receipt-review`;
- once with a published address, `make create METHOD=github.com/Pipelex/methods/text_stats@v0.1.1`.

The gesture runs `make all` itself, so a red check fails the run. Then check that each copy is what the gesture promised:

- `pyproject.toml`, the package directory under `src/` and the command are named after the method, and `grep -rn pipelex_method_cli_python --exclude-dir=.venv .` finds nothing;
- the bootstrap skill, `scripts/create.py`, `scripts/create_plan.py` and `docs/create.md` are gone, and the `bump-sdk` skill is still there;
- `.env` is readable by you alone and holds exactly one `PIPELEX_BASE_URL` line, the one the run used;
- `.venv/bin/<name> --help` lists the method's inputs, one option each;
- one run prints its JSON result on stdout, and its run id and cost report on stderr: `.venv/bin/text-stats --text "Hello there. Two sentences."`, and for the receipt review a run with a receipt or an invoice as a PDF, such as the repository's own sample, `.venv/bin/receipt-review --receipts <repository>/starter-python/samples/sample-invoice.pdf`. Its input is a `Document`, which the plane hands the model as a file, and the model refuses an image there, so a run given a PNG fails at the provider whatever the template does.

The runs spend a few model calls.
