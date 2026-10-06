# Codegen: the method's typed models and contracts, generated from it

The command holds one method, and everything it knows about that method's inputs and output is generated from the method rather than written by hand. `make codegen` asks the Pipelex API for two things and commits both into the package's `generated/` directory: the method's typed models, which `binding.py` names the output model from, and the method's contracts, which the command derives its options from (see [`cli-kernel.md`](cli-kernel.md)). Two checks then say whether what is committed is still what the method describes: `make codegen-check`, offline and part of `make check`, and `make codegen-verify`, which asks the API.

The scripts are ports of the web app template's codegen kit, over one method instead of a directory of them, and they hold the same policies. Each script's docstring names the module it ports.

## The commands

| Command | Needs | What it does |
| --- | --- | --- |
| `make codegen` | `PIPELEX_API_KEY` | Regenerates `generated/` from the method in `method/`, writing only the files whose bytes changed |
| `make codegen-check` | nothing | Says, offline, whether `generated/` is current with `method/`; part of `make check`, so it runs on every clone and in CI |
| `make codegen-verify` | `PIPELEX_API_KEY` | Asks the API whether the committed tree is still what the method resolves to, and writes nothing |

The keyed scripts read `PIPELEX_API_KEY` and `PIPELEX_BASE_URL` from the shell or from `.env`, as the command does, and reach the API through the command's own `lib/client.py`, so a missing key is refused before any request.

## What `generated/` holds

| File | Written from | Signed by |
| --- | --- | --- |
| `models.py` and any other artifact | `POST /v1/codegen`, verbatim, through the SDK's `write_codegen_tree` | `codegen.lock`, and each file's own stamp |
| `codegen.lock` | `POST /v1/codegen`, verbatim | itself: the crate fingerprint and the engine version |
| `contracts.json` | `POST /v1/pipe-io` with `all_pipes`: the pipe IO contracts, the input-form descriptors and the output-form descriptors, keyed by pipe reference | `sources.json`, under `derived` |
| `__init__.py` | the script, so that `binding.py` can import the models as a package | `sources.json`, under `derived` |
| `sources.json` | the script: the SHA-256 of every source in `method/`, and of each file above the lock does not sign | nothing; it is the record the offline check compares against |

`contracts.json` is rendered through the same `mthds.protocol` models the command reads it back with, with two-space indentation and the models' member order, so the same answer always gives the same bytes and a file the command could not read is never written. The command reads it with `lib/contracts.py`, and the binding refuses to load when the pipe `binding.py` names is not in it.

Nothing under `generated/` is edited by hand: ruff excludes the directory so that no reformat breaks a stamp, and pyright still checks it. The project's `.gitattributes` marks `generated/` as `-text`, so that git never translates its line endings and every checkout holds the bytes the API emitted, and pins `method/` to LF, the bytes its hashes in `sources.json` were taken over. Both are hygiene rather than correctness: the checks fold line endings before they hash or compare, so a checkout made under `core.autocrlf=true` is no edit.

## In what order, and what is refused

`make codegen` writes nothing until every answer is in and checked:

1. The base URL is refused when it would carry the key over plaintext `http:` to another machine; `localhost`, `*.localhost`, `127.0.0.1` and `[::1]` may be reached over `http:`.
2. A method named by `method.json` is checked against `GET /v1/version`: a base URL whose `extensions` list lacks the selector the manifest uses, `method_ref` or `method_id`, is refused before any crate route is called. A version request that fails, and an answer with no `extensions` list, proceed, since the crate route then answers for itself with a better message.
3. `POST /v1/codegen` answers the models and their lock, and the answer is held to the policies below. The last of them writes the answer into a scratch directory and runs the SDK's offline check over it: a tree the server describes must be current by construction, so one that is not is an upstream bug and never reaches the package.
4. `POST /v1/pipe-io` answers the contracts. A method the route reports as not runnable is refused, naming the pipes still declared as signatures.
5. `POST /v1/codegen`, asked again with the same request, confirms the revision. Each route resolves the method on its own, and only the codegen answer names the revision it resolved, its `crate_fingerprint`, so a method edited or republished between the two calls would otherwise commit the models of one revision beside the contracts of another, a tree the offline check would call current. A fingerprint that moved is refused, with nothing written: the message says the method changed while it was being generated and to run `make codegen` again. Since steps 4 and 5 come after every guard on the first answer, a failure of either leaves the tree exactly as it was.
6. The tree is written: the models and the lock through `write_codegen_tree`, then `contracts.json` and `__init__.py`, then the sidecar, each only when its bytes changed. A stamped file the new lock does not track is removed, and what counts as such an orphan is the SDK's offline check's verdict over the tree just written, never a filename test, so a hand-written sibling module is never deleted.

The bundle is sent with each file labelled by its path relative to the package, `method/<path>`, which is also the key the sidecar records it under, so a validation error names the file a person edits.

<!-- template-only:begin -->

In the template, `make create` fetches and writes the method through these same functions, `fetch_generated` and `write_generated`, so that the tree it writes is the one `make codegen` would write and every guard above holds for it too ([`create.md`](create.md)). It asks `/v1/pipe-io` to echo a named method's `.mthds` files as well (`include_files`), since the method's own prose names the project; `make codegen` does not read them and never asks for them. Its bundle reader walks a bundle directory with the same `walk` and reads it with the same `read_bundle`, so it refuses the same links, special files and undecodable files.

<!-- template-only:end -->

## Gate fidelity policies

Each of these replaced a way the gates could be silently wrong, and each has its test in `tests/test_codegen.py`:

- **Symbolic links and special files are refused** under `method/` and `generated/`, the roots included, so nothing outside the package is read as the method and nothing is written through a link. The check reports no verdict.
- **UTF-8 is fatal.** A file that does not decode is refused, never read with replacement characters: in `method/` the gesture stops before any request, and in `generated/` the check reports drift, since regenerating rewrites the file.
- **A path the server names must stay inside the tree**, once resolved, and must not land on a file the script writes itself (`contracts.json`, `__init__.py`, `sources.json`, `codegen.lock`). Either refuses the whole answer, with nothing written.
- **A lock under another name is refused**, since the offline check opens `codegen.lock` by name and would keep validating the old one.
- **The self-check runs before anything is written**, as step 3 says.
- **The models and the contracts describe one revision**, as step 5 says, or nothing is written.
- **A failed request is caught by what it can raise**, and nothing else: the SDK's request errors, a transport error the SDK leaves unmapped, and a body that is not the answer. Anything else is a bug, which surfaces with its traceback rather than as a refusal.

## Two staleness gates

**The offline check** (`make codegen-check`) answers whether the committed tree matches its lock and its sources, with no key and no network. The tree is current when the SDK's `run_codegen_check` finds every artifact the lock signs at its signed hash and no stamped file the lock does not track, and when `sources.json` records the hash of every source in `method/` as it is now and the hash of each derived file as it is now. An edited bundle, a new or removed source, or a hand edit to `contracts.json` is therefore drift. Hashing folds CRLF and lone CR to LF first, so a checkout's line endings are no edit. Python's bytecode cache and dotfiles inside the tree are not part of it.

The exit code is the verdict: `0` current, `1` drift, `2` no verdict (a missing or unreadable lock, a symbolic link, or a method that cannot be read). Verdicts fold by precedence, no verdict over drift over current, and a summary line counts them. **The template as shipped holds no method and no tree, and that is current**, so `make check` is green on a fresh copy; a method with no tree is drift, and so is a tree with no method behind it, since regeneration never removes a whole tree.

**The keyed check** (`make codegen-verify`) answers what the offline one cannot: whether the method, as the API resolves it today, is still the one the tree was generated from. A bundle that did not change can resolve to another crate when a published dependency moved, and a method named by `method.json` lives elsewhere entirely. It compares the crate fingerprint `/v1/codegen` returns with the lock's, and `contracts.json` re-rendered from a fresh `/v1/pipe-io` answer with the committed file, its line endings folded to LF as the offline check folds them; either difference exits `1`. An engine that moved while the crate did not is a note: regenerating would restamp every file with no change of meaning.

## The output model is a check

`binding.py` names `OUTPUT_MODEL`, imported from the generated models, and `OUTPUT_IS_LIST`, which must agree with the contract's multiplicity for the output or the command refuses to load. Before a result is printed, `lib/narrow.py` validates it against the model, element by element for a plural output. The validation is strict and reads the result as the JSON it arrived as, so a value is never coerced into the type a field declares: `"12"` does not pass an integer field, nor `"yes"` a boolean, while an ISO 8601 date, date and time or time, an enumeration's value and an integer for a float field are taken, being how JSON carries those types. The model is a check and never a filter: what is printed is the payload as the method produced it, so a field the model does not declare is kept. A result the model refuses is not printed: the error names every field that failed, the hint says to run `make codegen` and update `binding.py`, and, for a durable run, how to fetch the result again with `--resume`. The run's files still come down and its cost is still reported, since the run was paid for. An output the contract declares `optional` may be absent from a successful run, which then delivers the runtime's absence document in its place: that is printed as `null`, with a line on stderr saying the method produced no output this time, and the command exits 0 ([`run-lifecycle.md`](run-lifecycle.md)).
