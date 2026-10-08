# CLI architecture: three modes, three self-contained files

This starter has two jobs: show how easy it is to call the Pipelex API, and be code you would actually copy into your own project. Both push in the same direction — **the shortest possible reading path from a command to the SDK call it makes**.

So the execution mode is not an option you pass, it is the command group you type:

```
widget blocking  extract-entities     # or summarize-pdf, generate-image
widget attended  extract-entities     # or summarize-pdf, generate-image
widget detached  extract-entities     # or summarize-pdf, generate-image
widget detached  wait <run-id>        # or status, result
```

## The layout

```
widget/
  cli.py            # the assembler: load .env, mount the three groups in reading order. Nothing else.
  inputs.py         # SHARED — prepare the inputs (text/file; incl. the hosted file upload)
  errors.py         # SHARED — present an SDK error
  usage.py          # SHARED — read + print the run's cost report
  blocking/cli.py   # the whole blocking mode
  attended/cli.py   # the whole attended mode
  detached/cli.py   # the whole detached mode + the run-id lifecycle commands
```

Each mode file is a **copy-paste unit**: that file plus `inputs.py` plus `errors.py` plus `usage.py` is all the *lifecycle* code you need to lift the mode into your own project. A runnable copy also carries the method-specific artifacts the demos reference — the bundles (`widget/methods/`), the generated models (`widget/generated/`), and the sample document — but those are exactly what you replace with your own method anyway. No other code in `widget/` is load-bearing for a mode.

## The sharing rule

> Share what is orthogonal to execution. **Never share lifecycle code.**

Input preparation, error presentation, and cost-report formatting don't care how a run is executed, so they are shared. The lifecycle — what you call, in what order, and what you do while waiting — *is* the mode, so it lives in the mode's own file, in full, even when that means near-duplicating a demo command across three files. (Cost *extraction* is the one seam that differs per mode — the durable modes read a typed `RunResults.tokens_usages`, blocking lifts the same records raw off its execute result — so each helper picks the right `usage.py` reader; the *formatting* is shared.)

That duplication is deliberate, and it is the pedagogy: diff `blocking/cli.py` against `attended/cli.py` and the only thing that differs is the lifecycle helper. The moment two modes reach for a shared `runner` helper, a dispatch layer is back between the command and the SDK, and the reading path grows a hop. (The earlier version of this starter had exactly that: a `--mode` option → `_dispatch()` → `match ExecutionMode` → `runner.py` → the SDK. Four layers to answer "how do I call the API?".)

The duplication can drift, so `tests/unit/test_mode_symmetry.py` holds it in place: every demo exists in every mode, with the same parameters. A demo added to one mode and forgotten in another fails CI.

## Anatomy of a mode file

All three have the same four-part shape, so they diff cleanly:

1. **Module docstring** — the mode's contract in a paragraph, plus its copy-paste contract.
2. **App + consoles** — its own `typer.Typer`, its own `Console()` (stdout, for results — pipeable) and `Console(stderr=True)` (stderr, for progress chatter).
3. **The lifecycle helper** — one public async function that *is* the mode (`detached` adds the run-id lifecycle helpers described below). It gets a public name because it is the featured code, and it is what the unit tests patch and the e2e tests call directly.
4. **The demo commands + a private `_run()`** — each command reads its input, reads its bundle, awaits the lifecycle helper through `_run()` (`asyncio.run` + the single `except PipelineRequestError` that presents via `widget/errors.py`), narrows the result into its *generated* model, prints JSON to stdout, brings down any file the result references, and prints the run's cost report to stderr.

The lifecycle helpers take the bundle as `mthds_contents: list[str]` — one string per `.mthds` file — and pass it straight to the SDK. The three demos are single-file methods, so each reads its `main.mthds` and wraps it as `mthds_contents=[bundle]`. A method dir may instead hold several `.mthds` files (a multi-file bundle split across pipes with `signature_for` cross-file declarations); read them all with `[p.read_text() for p in sorted((METHODS_DIR / "<name>").glob("*.mthds"))]` and hand that list to the helper unchanged. Concatenating the files into one string would be invalid TOML — the list is the interface for exactly this reason.

| Mode | Lifecycle helper | SDK calls | What the demo prints |
| --- | --- | --- | --- |
| `blocking` | `execute_pipe()` | `client.execute` | the result as JSON, then any produced file and a cost report (stderr) |
| `attended` | `start_and_wait()` | `client.start` + `client.wait_for_result` | the run id (stderr), then the result as JSON + any produced file and a cost report (stderr) |
| `detached` | `start_pipe()` | `client.start` | the run id, bare, on **stdout** (no cost — the run isn't done yet) |

`detached` additionally owns the run-id lifecycle: `attend_run()` backs `wait`, and thin fetchers back `status` and `result`. It is the only mode with more than the demos, because "start now, collect later" is only a complete story if you can come back for the result. The cost report lands where the *result* does, so in detached mode it prints from `wait` and `result` (collection time), not from the start-only demo commands.

The result-producing helpers — `execute_pipe()`, `start_and_wait()`, and detached's `attend_run()` — all return the SDK's own `RunResults`. That is one object for the whole run: `.main_stuff` is the resolved output (the SDK types it `Any` — the content is polymorphic), `.tokens_usages` / `.usage_assembly_error` are what it consumed, and the produced files are referenced inside the output. The blocking mode reaches it through `pipelex_sdk.execute_result.results_from_execute`, which lifts the blocking response onto the same shape the durable path returns, so no mode reads the runner's raw `pipe_output` and every mode reads the same accessors. In blocking and attended mode each demo command narrows `results.main_stuff` with `Model.model_validate(...)`, which is what restores type safety (the models are generated from the bundles — see [codegen.md](codegen.md)), then hands the whole `results` to the cost report and the download. Detached is different by design: `start_pipe()` returns only the run id, and the run-id commands (`wait`, `result`) print the output generically — at collection time the command doesn't know which method the run executed, so there is no model to narrow into.

### Cost reports, produced files and file upload

Three SDK capabilities show up in every result-producing path:

- **Cost report.** A completed run reports what its inference calls consumed. The reading belongs to the SDK: `pipelex_sdk.usage.summarize_usage(results)` folds the usage pair into one `UsageSummary` under every rule the SDK's `docs/run-usage.md` states — an unrated call (`cost is None`: mock / own-GPU / dry-run) is not a zero-cost call, token categories are never summed (`input_cached` is a subset of `input`), and a run that did no inference is told apart from a run nothing is known about. `widget/usage.py` re-derives none of that; `print_cost_report` reads the summary's state and totals and renders a per-call table, always to **stderr**, so stdout stays the clean, pipeable result.
- **Produced files.** A run that generates an image or a document does not return the bytes: the output carries a durable `pipelex-storage://` reference beside a signed `public_url` that expires, so the link must not be stored. `widget/artifacts.py` brings the files down through the SDK's artifact stack — `collect_artifacts` answers offline whether the output references any file at all, so a text result costs nothing, and `download_artifacts` mints a fresh link for each and saves it under `DEFAULT_DOWNLOAD_DIR`, never reading the embedded `public_url` and never overwriting a file. It answers a verdict with errors as values, so a file that did not come down is reported rather than raised. See `docs/artifact-download.md` in `pipelex-sdk`.
- **File upload.** `summarize-pdf` feeds a *file* to a pipe. A hosted run cannot see your filesystem, so `inputs.py`'s `upload_document_input` uploads the file first (`client.upload_file`) and the run request carries only the returned `pipelex-storage://` URI — never the bytes. Preparation is a step of its own, before the run: an unreadable file or an upload-incapable deployment fails before any run is created, presented through the same `widget/errors.py` path as every other SDK error.

## Conventions worth copying

**stdout is the result; stderr is everything else.** Progress spinners, run ids in attended mode, error messages, and hints all go to stderr, so stdout stays pipeable. In detached mode the run id *is* the result, so it goes to stdout bare (`print`, not Rich) — `RUN_ID=$(widget detached generate-image "…")` just works.

**SDK errors are presented once, at the root of the command.** `_run()` catches `PipelineRequestError` (the base of the SDK's typed errors, a non-2xx answer from any route included), maps it to an `ErrorPresentation` (a message, the lines that explain it, and a hint) via `widget/errors.py`, prints it with `print_error`, and exits non-zero. `print_error` escapes every piece before it reaches Rich, because the message and its lines carry the server's text, and a bracketed span in it would otherwise be read as markup. Ctrl-C is handled separately: the durable lifecycle helpers catch the cancellation just long enough to print the resume hint before re-raising, and `_run()` maps the resulting `KeyboardInterrupt` to exit 130. Beyond those two, nothing is caught: an unexpected exception crashes loudly with its traceback, which is what you want while you are building. A request that gets no answer is not one of those: a connection that fails, from a mistyped `PIPELEX_BASE_URL` or a machine that is offline, or a time limit that runs out, reaches `_run()` as the SDK's `ApiUnreachableError` on every route, `execute` and `start` included, and is presented with the `PIPELEX_BASE_URL` hint.

**A refused request says why, where and what to do.** Every route of the SDK — the protocol routes (`execute`, `start`, `runs/*`) as much as the product ones — raises the typed `ApiResponseError` on a non-2xx answer, with the API's RFC 9457 **problem+json** document parsed onto it: its `title` and `detail`, the runner's `error_type`, the `validation_errors` of a method it refused to run, the `user_action` it advises and whether the request is `retryable`. `problem_lines` reads that document out the way `report_lines` reads a failed run's report, so a method the API will not run reads like this whichever mode you met it with:

```text
Error: The API answered 422 Unprocessable Entity.
  Reason: Validate bundle — Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck

    Did you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna
  Pipe: draft_pitch
  Next step: Edit the bundle as each validation error says: apply its suggested fix where it has one, after confirming an unsafe one
  Retry: running it again will fail the same way until the cause is fixed.
```

The reason is the problem's `title` and `detail`. Each validation item follows it, located by the pipe or concept it names; the runner writes a refusal's `detail` from its items, so an item whose message the reason already says is reduced to where it is rather than printed twice. The lines of a multi-line reason hang under its label. As under a failed run's report, the next step is the advice, and no hint competes with it. The branch that earns a hint goes on the structured `error_type`, never the wording: a `/start` against a synchronous-only runner (`StartRequiresAsyncOrchestration`) is presented with a hint pointing at `widget blocking`, which the server cannot know to say. The HTTP status decides only an authentication failure (`401`/`403`), which gets the API-key hint and still reads out its reason, because a `403` can be a key that was recognised but may not use the route.

**A failed run says why.** A durable run that ended without a result carries the error report the runner stored when it failed, which the SDK hands back typed as `RunErrorReport` on `RunFailedError.error` (out of `wait_for_result`, `start_and_wait` and an artifact download), on the failed arm of `get_run_result`, and on the status read's `RunRead.error`. `present_failed_run` presents all three the same way, and `report_lines` reads the report out as the lines a person reads:

```text
Error: Run 3f2a… failed.
  Reason: LLM completion — The model refused the request.
  Next step: Rephrase the prompt, or pick another model.
  Retry: running it again may succeed.
```

The reason is the report's `title` and `message` (its `error_type` when it carries neither), the next step its `user_action` (the advice's own words, or a sentence for its `kind` when it gives none), and the retry line its `retryable`, left unsaid when that is `None`, which means unknown rather than no. There is no hint under a report: the next step is the advice. `widget detached status <id>` prints the same lines under the status, so a failed run reads the same whichever command you met it with. A run that ended with no stored report — a cancelled or timed-out one, or one the platform finalized itself — says that no reason was recorded, keeps the platform's own sentence (on a stored result the platform refuses to serve, that sentence is the only thing that says what happened), and hints at what is left: support for a failure, starting it again for a run that was stopped. The report is the runner's verbose one, so a provider's raw text can reach the terminal; that is right for a developer's tool, and an application in front of end users decides what of it they see.

The other hints name the mode *groups*, because when a mode cannot carry a run, the fix is usually another group: a blocking run that hit the ~30s cap tells you to rerun it with `widget attended`; a run that timed out while you waited tells you to resume it with `widget detached wait <id>`; a durable run against a runner that can't do them tells you to use `widget blocking`.

**Every demo runs with zero arguments.** When you give neither an argument nor `--file`, the input helper returns a bundled sample (`widget/inputs.py`'s `SAMPLE_*` constants), and the command prints a one-line notice on stderr saying so. A fresh clone shows a working result on its very first command once your API key is set; stdout stays the clean, pipeable result because the notice is on stderr. Sample data is orthogonal to execution, so like input encoding it is shared, not duplicated per mode.

**A demo names its pipe by its qualified reference.** Each call sends `pipe_code="<domain>.<pipe_code>"` — `extract_entities.extract_entities`, the bundle's own `domain` and its `main_pipe` — never the bare code. The runtime keys a pipe by exactly that reference, while a bare code is searched for across every domain of the bundle and fails as ambiguous once two domains declare the same one, which a bundle you grow from a demo can easily come to do. The qualified form ties the call site to the bundle's `domain`, so rename the two together; `tests/unit/test_mode_symmetry.py` reads the reference from each bundle and fails when a call site no longer matches it.

## Why `attended` and `detached`, not `durable`

Both start the *same* durable run — one that lives server-side behind an id and outlives your terminal. The only difference is who waits: `attended` polls from your terminal, `detached` exits and lets you collect the result later. Naming the middle one "durable" would suggest detached is not, which is exactly backwards. The mode names the axis that actually differs.

A nice consequence: Ctrl-C during an attended run doesn't lose anything — it has just turned into a detached run, and the hint you get says so (`widget detached wait <id>`).
