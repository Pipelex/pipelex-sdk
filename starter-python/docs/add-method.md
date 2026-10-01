# `make add-method`: scaffolding a method that lives elsewhere

This is the reference for the second way a method reaches this CLI. The first is the one the three demos tell: the bundle lives at `widget/methods/<name>/main.mthds`, [`make codegen`](codegen.md) projects it, and a person writes the command that uses the projection. `make add-method` is the same story for a method that lives **on the platform** (a catalog id) or **in a published package** (an address): the method stays where it is, a one-line manifest names it, and the whole Python fan-out is written from the method's own contract.

```bash
make add-method METHOD=github.com/Pipelex/methods/text_stats@v0.1.1
```

## The gesture

|            |                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Make       | `make add-method METHOD=<selector> [PIPE=…] [NAME=…] [MODE=…] [DRY_RUN=1]`                               |
| Directly   | `python -m scripts.add_method <selector> [--pipe …] [--name …] [--mode …] [--dry-run]`                   |
| Needs      | `PIPELEX_API_KEY`, and a base URL that resolves your selector (see [the handshake](#the-handshake-and-the-base-url)) |
| Exit codes | `0` written (or rehearsed), `1` refused or failed — never a thrown stack                                  |

It is out of every offline gate for the same reason `make codegen` is: it needs a key and a network.

The Make variables are read **from the command line only** — `make add-method NAME=invoice-triage`, never `NAME=invoice-triage make add-method`. Make imports every environment variable as a make variable, and WSL exports `NAME` as the machine's hostname, so reading the environment would scaffold under the hostname there.

`METHOD` is the one required argument, and it is one of two forms:

- **A catalog id** — `mt_…`, a method saved under your key's organization on [app.pipelex.com](https://app.pipelex.com). Sent as `method_id`.
- **An address** — `github.com/<owner>/<repo>[/<package>][@<tag>]`, a published MTHDS package, with or without an `https://` prefix. Sent as `method_ref`, normalized to the bare form.

Anything else is refused naming both. There is deliberately **no local `.mthds` path**: that story already exists — put the bundle in `widget/methods/<name>/` and run `make codegen`.

The optional arguments:

| Argument                  | What it does                                                                                 | Default                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `PIPE` / `--pipe`         | Which pipe of the method to wire, bare (`analyze_text`) or qualified (`stats.analyze_text`)  | The pipe rule below                                     |
| `NAME` / `--name`         | The kebab-case slug every derived name is built from                                         | The address's last path segment; **required** for an id |
| `MODE` / `--mode`         | Which execution mode the command lands in — `blocking`, `attended` or `detached`             | `attended`                                              |
| `DRY_RUN=1` / `--dry-run` | Fetch, derive and print the whole plan; write nothing                                        | off                                                     |

## What it writes

For `METHOD=github.com/Pipelex/methods/text_stats@v0.1.1`, with no other arguments:

```
widget/methods/text-stats/method.json       # { "method_ref": "github.com/Pipelex/methods/text_stats@v0.1.1" }
widget/generated/text_stats/                # models.py, codegen.lock, __init__.py
widget/attended/cli.py                      # its imports and one Typer command, at the anchors
```

Three files rather than the JS starter's seven, and the difference is not a gap. A CLI has no narrower layer (a generated pydantic model narrows itself, with `Model.model_validate`), no action trio (the mode's own lifecycle helper is the action), no form (the command's parameters are the form) and no tab. What is left is exactly the manifest, the projection and the command.

**Nothing is written until everything has been fetched and derived.** The run has a read-only half — parse the selector, validate the method, choose the pipe, derive every name, map every input, check every collision, confirm the anchors are in place and confirm the output model exists in the artifacts just fetched — and a write half that runs only once all of that has passed. Every refusal happens in the first half, with nothing on disk changed. `--dry-run` stops at the boundary and prints the plan.

**The write half writes all three or none.** The mode file's new text is built and compiled before anything touches the disk, and a failure after that — the SDK's writer refusing the tree, the filesystem refusing a write, a Ctrl-C — takes back what the run had written: the manifest's directory, the generated package and the mode file's original text. A half-written slice would otherwise be refused by the next run as a name that already exists, and read by `make codegen` as a method nobody finished adding.

**The emitted command is formatted with this repo's own ruff** before the run reports success, so it lands `make agent-check`-clean. Its imports are inserted in already-sorted position rather than fixed up afterwards, so `ruff check` has nothing to complain about either. A ruff that cannot be found, cannot start or fails is reported as a note rather than a traceback: by then the slice is written in full and the mode file compiles, so what is missing is the formatting alone, which `make agent-check` applies.

## The manifest is the source

`widget/methods/<name>/method.json` holds exactly the selector and nothing else:

```json
{ "method_ref": "github.com/Pipelex/methods/text_stats@v0.1.1" }
```

It sits under `widget/methods/` rather than beside the generated tree, and that placement is the whole reason the second source kind cost `scripts/codegen.py` almost no new logic: `widget/methods/` stays the source of truth, `widget/generated/` stays purely derived, and `make codegen` regenerates a selector-sourced tree beside a bundle-sourced one instead of being a second regeneration path. A method directory holds either `.mthds` files or a `method.json`, never both — the two would disagree about where the tree came from, and the discovery refuses that naming it.

**To move to another version of a published method, edit the tag and run `make codegen`.** That is the whole upgrade: the regenerated diff shows what the new tag changed, and a changed output shape surfaces as a type error against your command rather than as a surprise at run time. It is the whole upgrade because the scaffolded command **reads `method.json` every time it runs** (`read_manifest`, from `widget/manifest.py`, the same reader `make codegen` uses) rather than carrying a copy of the selector — a copy would go on running the old version after the models had moved to the new one.

## One-shot, on purpose

The gesture never overwrites. Run it for a name that already exists and it refuses, naming the collision and the two ways forward: `make codegen` to refresh the tree, or `NAME=<other-name>` to scaffold a second slice of the same method (which is what `PIPE=` is for — a package with several pipes is the usual reason). A `--force` that rewrote the command would delete work you had done in it to save you a `git checkout`, and the command is explicitly yours to edit from the moment it lands.

The refresh is therefore always `make codegen`, and it refreshes only the generated tree. It does not re-derive the command: that is yours now, and a method change that alters what it needs — a renamed output concept, a new required input — surfaces as a type error or a server-side refusal, which is the loud failure you want.

## How each name is derived

Everything comes from one kebab-case slug.

- **The slug** is `NAME` when given; otherwise the address's last path segment — the package, falling back to the repository for an address naming none — kebab-cased (`text_stats` → `text-stats`) and validated. A slug that cannot be a directory name, a command name and a Python package stem at once is a refusal here, not a broken import later.
- **`text_stats`** (snake) names the generated package and the command function; **`text-stats`** (the slug) names the method directory and the command as you type it; **`TextStatsOutput`** aliases the generated model on import, so two methods that both project a concept called `Image` never collide in one mode file.

**A derived name something else already uses is a refusal.** The command is a module-level function, so neither its name nor the model's alias may be a name the mode file already binds — an import, an assignment, a function — or one the emitted command itself reads, such as `start_and_wait`, `output_console` or `read_manifest`. `NAME=app` would otherwise replace the mode's `typer.Typer` instance and take the whole CLI down with it. The mode file is parsed to find those names, so a mode file that does not parse is refused too. A Python builtin is refused as a command name for the same reason: a detached command named `print` would replace the `print` that `_print_run_id` calls, so every run id it tried to show would start another run. So are `wait`, `status` and `result` in every mode, because they are `widget detached`'s run-lifecycle commands and `tests/unit/test_mode_symmetry.py` keeps them out of the other two.

**A catalog id needs `NAME=`.** The JS starter reads the catalog method's name for its slug; this one does not, because resolving an id to a name is a call to the hosted product surface (`GET /v1/methods/{id}`) and `widget` deliberately speaks only the protocol routes — `execute`, `start`, `validate`, `codegen`, the run lifecycle and the upload. Asking for one word is a smaller price than widening what the starter demonstrates.

## The pipe rule

A published package can carry several pipes, so the pipe is chosen by a rule that ends in a refusal rather than a guess. In order:

1. `PIPE`, if given — bare or qualified, refused if the method declares no such pipe (the message lists the ones it does), and refused as ambiguous if a bare code matches more than one domain.
2. The validate report's `default_pipe_ref`, when the method names one.
3. The only pipe, when the method declares exactly one.
4. Otherwise a refusal listing the pipes and asking for `PIPE`.

The command sends the chosen ref **qualified** (`pipe_code="stats.analyze_text"`) beside the selector. A bare code would be ambiguous in exactly the case step 1 refuses to guess at — a code two domains of the method both declare — and the runtime resolves a `domain.pipe_code` directly, so the qualified ref is right on every path. The demo commands send qualified refs too, for the same reason.

## The command's parameters are the method's inputs

Each top-level input of the chosen pipe becomes one Typer parameter, typed from the method's own input-form descriptor — not from a schema this script sniffs, and not from anything written by hand:

| Input kind             | Parameter                                                                 |
| ---------------------- | ------------------------------------------------------------------------- |
| `text`, `prose`, `date`, `enum` | `str` (an enum lists its choices in the help)                     |
| `number`               | `int` or `float`, by what the method says it is                           |
| `boolean`              | a `--flag/--no-flag` pair, never a positional                             |
| `document`             | `Path`, existence-checked by Typer, uploaded with `upload_document_input` before the run |

A **required** input is a positional argument (a required boolean is a required flag); an **optional** one is an option defaulting to `None` and is left out of the run inputs entirely when it is not given. Required parameters are emitted first because Python demands it, and within each group the method's own authored input order is kept — which is what the input-form descriptor exists to carry.

**An input spelled like a name the command uses is refused**, naming the input: a parameter called `start_and_wait` would shadow the lifecycle helper inside the command and turn the run into `'str' object is not callable`. The names are `COMMAND_LOCALS` and `COMMAND_GLOBALS` in `scripts/add_method.py`, and `tests/unit/test_add_method.py` parses every shape of emitted command to keep that list complete. An input spelled like a Python builtin, such as `format`, `type` or `id`, is refused as well, because ruff refuses a parameter that shadows a builtin (A002) and cannot fix it, so the scaffold would fail `make agent-check`.

**Four kinds are refused rather than guessed at**, each naming the input and why: `object` and `list`, because a nested value has no honest spelling as a command-line flag and inventing a JSON encoding for it would be the hand-written input shape this starter never writes; `image`, because the starter uploads documents and has no image-input envelope to copy; and `unknown`, because the method itself is reporting that it cannot say what the input is. In each case the remedy is the same: write that command by hand from the generated model, the way the three demos are written.

## The output is narrowed by the generated model

The command narrows `main_stuff` into the generated model for the pipe's output concept — `TextStatsOutput.model_validate(main_stuff)` — and prints it as JSON on stdout with the cost report on stderr, which is what every result-producing demo does. The model is dumped with `model_dump(mode="json")`: validation turns a date, datetime or time field into a Python object, which plain `model_dump()` would hand to `print_json` unencodable, so the command would crash on a result the run had already paid for.

A **plural** output (a multiplicity other than `single`) goes through `widget/outputs.py`'s `list_items` first. That function exists because one plural output arrives in two shapes depending on the execution path rather than on the method: a `{"items": [...]}` envelope on the blocking path and on a durable run whose element concept the worker can hydrate, a bare array on a durable run of a concept the method declares itself. `list_items` accepts both and hands back the elements, so the generated model still owns the verdict on every element and no shape is declared anywhere in the command. It is the Python twin of `pipelex-starter-js`'s `wireListOutput`, and like it, a workaround with an expiry.

Before writing anything, the run confirms that the artifacts it just fetched actually declare the model the command is about to import. An emitter that named the concept differently is a refusal with nothing written, not an `ImportError` in a file you did not write.

## One mode, not three

The demos exist in all three execution modes, and that symmetry is the teaching: the same method run three ways, so that diffing two mode files shows only the lifecycle. A method you did not write wants the one lifecycle that fits it, so `make add-method` writes **one** command into the mode named by `MODE=`, defaulting to `attended` — the only mode that both survives the hosted ~30s cap and hands you the result in the same command.

`MODE=detached` is the exception worth knowing: like detached's own demos, the scaffolded command prints the run id and narrows nothing, because at start time there is no result to narrow. Collect it later with `widget detached wait <id>`.

`tests/unit/test_mode_symmetry.py` asserts containment rather than equality for exactly this reason: every demo must still be in every mode, and a scaffolded command beside them is legitimate.

## The handshake, and the base URL

A selector is resolved **server-side**, so the API has to support it. `GET /v1/version`'s `extensions` array is the protocol's documented handshake for exactly that, and the run asks it once before anything is fetched. A missing capability is a refusal naming the base URL, the kind that is missing and what the deployment does advertise, rather than the opaque `403` or `422` the real call would otherwise produce.

Two cases deliberately **proceed** rather than refuse, because in both the handshake has no verdict to give and the real call's own error is the better message: the handshake itself failing, and a response that advertises no capabilities at all.

**Today `api.pipelex.com` advertises `runs` and `method_id`, not `method_ref`** (hosted `0.10.1`, measured 2026-09-13), so scaffolding a published address against it refuses at the handshake. This is a deploy away and nothing in the committed tree depends on it: every offline gate is pure hashing and compilation, so `git clone && make agent-check && make agent-test` stays green with no key and no network.

## The two anchors

Each `widget/<mode>/cli.py` carries two marker comments, and they are the scaffolder's whole contract with the hand-written files:

```
# add-method:imports
# add-method:commands
```

The import goes into the `from widget.…` block in sorted position, above the first anchor; the command goes directly above the second. The match is on the **token alone**, so the prose after each marker can be reworded freely — but **the tokens themselves must not move, be reworded, or be deleted.** `tests/unit/test_add_method.py` reads the real mode files, so a template edit that loses an anchor fails the suite rather than the next person's scaffold run.

## Removing a scaffolded slice

In one commit, delete `widget/methods/<slug>/` and `widget/generated/<package>/` together — the drift gate fails on either half without the other — then the command and its model import from `widget/<mode>/cli.py`, leaving both anchors in place — and the `widget.manifest` import too, unless another scaffolded command in that file still reads a manifest. Then `make agent-check` and `make agent-test`.

## What this deliberately does not do

- **No local `.mthds` path.** That story already exists, and serving it here would be a second way to do one thing.
- **No `--force`, no refresh mode.** `make codegen` is the refresh.
- **No skill.** A Make target over a script is what the gesture is; a slash command would wrap a one-line command.
- **No `method_id` slice in the template.** A catalog id is scoped to one organization, so ours would 404 for everyone else.
- **No shipped scaffolded example.** The JS starter commits the output of its own scaffolder as a fifth tab, which keeps the emitted code compiling on every `make all`. Here that guarantee is bought without a network round trip and without a fourth demo in the matrix: `tests/unit/test_add_method.py` emits a command for every mode, inserts it into the real mode file and compiles the result. A committed slice would additionally pin a live published address into the template's own gates.

## References

- [`docs/codegen.md`](codegen.md) — the trust chain this extends, and the two source kinds.
- [`docs/cli-architecture.md`](cli-architecture.md) — why the execution mode is the command group, which is what `MODE=` picks.
- `scripts/add_method.py` — the behavior, with each pure helper unit-tested in `tests/unit/test_add_method.py`.
