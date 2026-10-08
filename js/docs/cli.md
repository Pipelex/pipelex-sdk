# The `pipelex-sdk` command

`@pipelex/sdk` publishes one command, `pipelex-sdk`, which runs a method on the Pipelex API with nothing to install but Node 22.12 or later. It has two subcommands: `run` runs a method and prints its main output as JSON, and `script` writes a short shell script that runs one method with this SDK's version pinned, which is the lightest way to give a method a command of its own.

```bash
npx @pipelex/sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs inputs.json
npx @pipelex/sdk run --method ./receipt-review --inputs-template > inputs.json
npx @pipelex/sdk script --method github.com/acme/methods/receipt-review@v1.0.0 --pipe receipts.review_receipt
./receipt-review --inputs inputs.json
```

`npx` runs a package's only command whatever its name, so `npx @pipelex/sdk …` is enough. In a project that has the SDK installed, the command is `npx pipelex-sdk …`. The Python SDK, `pipelex-sdk` on PyPI, is to publish the same command under the same name (`uvx pipelex-sdk …`), with the same flags and the same output, held to this one by the recorded case table described at the end of this page.

The command lives in `src/cli.ts`, the executable, and `src/cli/`. It sits at the top of the SDK's dependency graph: nothing in the SDK imports it, the package entry does not export it, and it reaches the SDK only through the public barrel, as any other caller would (`.dependency-cruiser.cjs` holds both rules). It adds no runtime dependency: its flags are read with `node:util`'s `parseArgs`.

## `run`

```text
pipelex-sdk run --method <method> [--pipe <domain.pipe_code>] [--inputs <file> | --inputs-template]
```

- **`--method`**, required, names the method in one of three forms, told apart by shape alone. A value starting with `mt_` is a catalog id, sent as `method_id`. A value starting with `github.com/` is a published method's address, `github.com/<owner>/<repo>[/<package>][@<tag>]`, sent as `method_ref`. Anything else is a path to a `.mthds` file or a bundle directory, which must exist and is read from disk and sent inline (see "Reading a bundle" below). A file or directory that happens to be named `mt_…` is reached as `./mt_…`, so what a value names never depends on what the current directory holds, and an address is written without its scheme. An `mt_` value holding a character no catalog id holds, anything but letters, digits, `_` and `-` (the ids are minted as `mt_` and a UUID, and the run route takes no other character), is a usage error made before any request, which says to write `./` to name a file: `mt_review.mthds` is refused, `./mt_review.mthds` is a path.
- **`--pipe`** names the pipe by its qualified ref, `domain.pipe_code`. It is sent as `pipe_ref` to the input preparation and as `pipe_code` to the run. A bare code, and an `alias->domain.pipe_code` ref naming a dependency's pipe, are usage errors. Without it, the run takes the method's main pipe, as the API resolves it.
- **`--inputs`** names a JSON file holding one object, one entry per input, the shape `mthds run --inputs` and `cli-python`'s `--inputs` take; `-` reads it from stdin. The text is UTF-8, and a byte-order mark at its start is dropped, as RFC 8259 lets a JSON reader do, since Windows PowerShell 5.1 writes one (`Out-File -Encoding utf8`); a bundle's mark, by contrast, is sent as it is on disk. A relative path resolves against the current directory. Without it the run gets no inputs. When the object has entries, they first go through the SDK's input preparation (`prepareInputs`, one `POST /v1/pipe-io` call): a local path or a `data:` URL at a file input is uploaded and replaced by its `pipelex-storage://` reference, each upload is reported on stderr, and a URL passes through. An empty object or no `--inputs` makes no preparation request. A value at a file input that is no file, a `data:` URL that does not decode or a value of another type such as a number, is a usage error, as is a local path that cannot be read; a method that does not load, met during the preparation, is reported as `--inputs-template` reports it ("Exit codes, errors and Ctrl-C" below). The command tells the two apart by the SDK's error classes, `InvalidLocalSourceError` and `InvalidInputValueError` for the inputs' mistakes and `MethodLoadError` for the method's ([`input-preparation.md`](input-preparation.md)).
- **`--inputs-template`** prints the pipe's inputs template, the object `--inputs` takes with a placeholder for every input, and runs nothing. The template is rendered by `mthds`' `renderInputsTemplate`, in its compact JSON shape, from the input-form descriptor one `POST /v1/pipe-io` call returns, which spends no inference. It takes no `--inputs`.

The run goes through the SDK's `startAndWaitForResult`: on the hosted API a durable start, then polls until the run ends, however long it takes, and on a bare runner the blocking execute. Its `onStarted` callback prints `Run started: <id>` on stderr as soon as the run exists ([`run-results.md`](run-results.md)). The poll reads only the `main_stuff` artifact.

**stdout carries the run's main output and nothing else**, as indented JSON (two spaces), followed by a newline: exactly what `JSON.stringify(value, null, 2)` prints, non-ASCII characters as they are. It is printed as the method produced it, unvalidated and unrepaired: a list output arrives either bare or wrapped as `{"items": […]}` depending on the runtime path, and is printed as it arrived. An output the method left absent, which the run delivers as the runtime's absence document (matched by its whole shape, as `cli-python` matches it) or as nothing, prints `null`, and stderr says `The method left its output "<name>" absent (<reason>), so the result is null.` A produced file is not downloaded: its short-lived signed URL is in the printed JSON. A reader that stops early and closes either stream, as `| head` or `2>&1 | head -1` does, ends nothing: the lines it no longer reads are dropped, and the command goes on waiting for the run it started and exits as it would have.

## `script`

```text
pipelex-sdk script --method <address | catalog id> [--pipe <domain.pipe_code>] [--name <name>] [--dir <dir>]
```

`script` checks the method with one `POST /v1/pipe-io` call, which selects the pipe as the run will and spends no inference, so a typo in the address or the pipe is caught when the script is written rather than when it first runs. Then it writes an executable file and prints its path on stdout:

```sh
#!/bin/sh
# receipt-review: runs github.com/acme/methods/receipt-review@v1.0.0 on the Pipelex API.
# Written by @pipelex/sdk X.Y.Z. Needs Node 22.12 or later, and PIPELEX_API_KEY in the environment.
# Usage: ./receipt-review --inputs inputs.json, or ./receipt-review --inputs-template to see what to fill in.
exec npx --yes @pipelex/sdk@X.Y.Z run --method 'github.com/acme/methods/receipt-review@v1.0.0' --pipe 'receipts.review_receipt' "$@"
```

- **The method is an address or a catalog id.** A local bundle is refused, since a script naming a path breaks as soon as the script or the bundle moves; the refusal names both ways to get one, publishing the method or saving it to the catalog. An address without a tag is accepted, with a warning that the script follows the repository's default branch.
- **The name** defaults to the address's last segment without its tag, or, for a catalog id, to the method's name read from its catalog entry (`GET /v1/methods/{id}`) and kebab-cased: decomposed (NFKD), stripped of combining marks, lowercased, every run of characters outside `a-z0-9` turned into one `-`, trimmed of `-`. A name that comes out empty asks for `--name`. A name is a file name: it may not be empty, `.` or `..`, or hold a `/`, a `\` or a control character. The `\` is refused on every platform, since Windows reads it as a `/` and `..\outside` would leave `--dir`.
- **The file** is written in `--dir`, by default the current directory, which must exist. It is created with the permissions of an executable (`0755`, less the umask) and never over an existing file, a dangling link included. The path printed is `--dir` as given without its trailing `/`, or `.`, then `/` and the name.
- **The script's one line** is `exec npx --yes @pipelex/sdk@<version> run --method '<method>' [--pipe '<pipe>'] "$@"`: every value single-quoted, an inner `'` spelled `'\''`, and no value may hold a control character. The `"$@"` passes everything else on, `--inputs`, `--inputs-template` and stdin included, and since `run` refuses a flag given twice, a second `--method` cannot quietly run another method. The version is the one of the SDK that wrote the script, so the script keeps running the command it was written with; `npx` caches the package, so after the first run only the API needs the network. There is no option to write the Python SDK's line, since this SDK cannot know which version of the other package exists and was tested.
- **On Windows** the script needs a POSIX shell, such as Git Bash or WSL; otherwise type the `npx` line directly.

## The environment

The key comes from `PIPELEX_API_KEY` and nowhere else, since a flag would put it in the shell's history and the process list; its absence is a usage error that says where to get a key, and the command never prints it. The API's address comes from `PIPELEX_BASE_URL`, `https://api.pipelex.com` when unset; a refused base URL is reported without its credentials, path or query. An empty variable counts as unset. Every request carries `pipelex-sdk-cli/<version>` before the SDK's own token in its `User-Agent` ([`client-identification.md`](client-identification.md)).

**No `.env` file is read.** A command started through `npx` from wherever the person stands would otherwise pick up a credential from whichever file it found there. To load one into the shell: `set -a; . ./.env; set +a`.

**`PIPELEX_SDK_POLL_INTERVAL_MS` is for tests only.** It sets the poll interval in milliseconds, a whole number; the case table sets it to `0` so that a run answered "still running" is polled again at once, and serves its `202` answers with `Retry-After: 0`, since the SDK waits at least as long as the server's `Retry-After` and five seconds when a `202` gives none. Unset, the SDK's own interval applies. The Python command is to read the same variable.

## Exit codes, errors and Ctrl-C

The exit code is presentation, following the workspace's surface-output rule: a script reads stdout.

| Code | When |
| --- | --- |
| `0` | The result was printed, or the script written, or the help or version shown |
| `1` | The run failed, the API refused a request, could not be reached, or answered what the command cannot read |
| `2` | A usage error: a bad flag, an unreadable or invalid inputs file, a selector of no known form, a path that names no bundle, a missing key, a refused base URL, an `mt_` value that cannot be a catalog id, a local file the inputs name that cannot be read, a value at a file input that is no file, a script that would overwrite a file |
| `130` | Interrupted: on Linux and macOS the process ends by the interrupt signal, which a shell reports as `130` |

Every error goes to stderr, its first line `Error: <sentence>` and the lines under it giving the details. The command words a failure from the error's typed fields rather than from an SDK message, wherever the fields carry what a person needs, so that the JavaScript and Python commands print the same lines for the same answer:

- **A refused request**: `Error: the API refused the request (status <n>).`, then `Reason: <the problem's detail>`, each validation error as `  - <file>: <message>`, `Next step: <the advised action>` and `Request id: <id>` when the answer carries them.
- **A failed run**: `Error: run <id> ended with status <STATUS>.`, then `Reason: <the report's message>` (the problem's own sentence when the run has no report) and `Next step: <the report's advised action>`.
- **A method that does not load**: `Error: the method does not load.`, then one line per validation error that carries a string category and message, as `  - <file>: <message>`, or, when there is none, `  - <the answer's own message>`. It reads the same whichever request found it: the pipe I/O call of `--inputs-template` and `script`, or the input preparation of a run with inputs.
- **A value at a file input that is no file**: `Error: the inputs hold a value at a file input that cannot be read as a file.`, then `Reason: <the SDK's message>` and the forms a file input takes. An unreadable local path reads `Error: Local file cannot be read: "<path>" (<reason>).`
- **An unreachable API**: `Error: could not reach the Pipelex API at <base URL> (<code>).`
- **A failed upload** of a file the inputs name: `Error: the upload of "<file>" failed (status <n>).`, the status left out when no answer came back, then `Reason: <the SDK's message>`, which says what the status means for an upload (a file past the size limit, a deployment without file upload, a credential refused), and `Next step:` and `Request id:` when the API's answer carries them. It covers the SDK's `RejectedAssetError`, `UploadAuthenticationError`, `UnsupportedUploadCapabilityError` and `UploadTransportError`, each of which names the file it was sending. It exits `1`, and no run starts.

The checks that need no request come first, so a mistake costs nothing. `run` checks, in this order, its flags, `--pipe`'s form, the method (reading a path from disk), the inputs, the poll interval, the key and the base URL. `script` checks its flags, `--pipe`'s form, a control character in any value, the method's form, `--name`, `--dir`, the target file when its name is already known, the key and the base URL. The flags are read in command-line order and the first problem is the one reported: `--help` or `-h` anywhere before `--` asks for the help whatever else is there, and an argument that is exactly one of the two is never taken as a flag's value, so `run --method --help` prints the help; an unknown option or a positional argument is refused; a flag given twice is refused rather than the last one winning; a string flag needs a non-empty value, given as the next argument or after `=`, and a next argument starting with `-` is not taken as one, except `-` alone, which `--inputs` reads as stdin.

**Ctrl-C does not stop the run.** The command stops waiting, says where the run stood and exits `130`: before any request to run, `Interrupted. No run was started.`; from the request that starts the run until the API answers with its id, `Interrupted before the API answered with a run id. A run may or may not have started on the server.`; once the run exists, `Interrupted. Run <id> keeps going on the server.` Fetching that run later is not built into the command: the SDK's `waitForResult(id)` does it. A second Ctrl-C ends the process at once.

**An interrupt sends nothing more.** Every request the command makes starts only if no interrupt has landed, so a Ctrl-C during the local work (reading the bundle or the inputs, a read from stdin or a named pipe included) sends no request at all, not the pipe I/O call, the version check nor the start, and the command says `Interrupted. No run was started.` A local read that never completes, such as `--inputs` naming a pipe no one writes to or a bundle on a stalled network mount, does not hold the command either: it stops waiting for the read. An upload under way when the interrupt lands finishes, but no further upload starts, and neither does the run. `script` interrupted writes nothing and says `Interrupted. Nothing was written.`, and `--inputs-template` says `Interrupted.`

**How the executable ends after Ctrl-C.** On Linux and macOS, once it has said where the run stood, the process ends by the interrupt signal itself, which a shell reports as status `130` and which tells a calling loop that the person interrupted. It does not call `exit(130)`, because Node's exit waits for its worker threads, and one can stay blocked for good in a read the command stopped waiting for. On Windows it exits with `130`. `runCommand`, the function the executable calls, returns `130` in every case.

## Reading a bundle

A `--method` path is read by the command's own reader (`src/cli/bundle.ts`), whose rules are recorded as cases so that the Python command reads a bundle the same way:

- **A `.mthds` file** is a one-file bundle, sent under its own file name. A file of any other name is refused.
- **A directory** is every `.mthds` file under it, at any depth, each sent under its path relative to the directory, with `/` between segments.
- **The order** is the order of those names compared code point by code point, which is the order of their UTF-8 bytes: `Zeta.mthds` before `main.mthds`, `steps/score.mthds` before `steps2.mthds`, and `～.mthds` (U+FF5E) before `🧾.mthds` (U+1F9FE), where UTF-16 order would put them the other way round. A run sends the contents in this order as `mthds_contents`, and the pipe I/O route gets them as `files`, each with its name as `source`.
- **A hidden entry**, a file or a directory whose name starts with `.`, is skipped, so a `.venv/` or a `.git/` inside a bundle is never read.
- **Any file not named `.mthds`** is ignored, Python files included: the command sends only the MTHDS sources.
- **A symbolic link** is judged by its own name. One named `.mthds` that leads to a file is read through, under the link's name; one that leads to a directory is not descended into, which keeps a link cycle from looping; one that leads nowhere is refused. The `--method` path itself may be a link, and is followed.
- **A directory with no `.mthds` file** under it is refused, and so is a file that is not UTF-8 text and a directory that cannot be listed. A byte-order mark is kept as the file's first character, as it is on disk.

## The case table

The two commands share no code, so they are held together by one recorded table of cases written for both: `tests/fixtures/cli-cases.json` is its source, and `python/tests/fixtures/cli-cases.json` its copy, which `make shared-files` at the repository root writes and `make check-shared-files` holds byte for byte (`docs/ci.md` at the root). A behaviour of the command changes here, in the table and in `src/cli/`, and the Python command follows it. `tests/cli.test.ts` runs every case through `runCommand` in-process; a case that uses a field the suite does not know fails rather than being skipped, so a case added for one language reaches the other.

The table holds:

- **`base_url`**, the origin every recorded route is served on, and **`env`**, the environment every case starts from: a key, that base URL and the poll interval `0`.
- **`answers`**, named answers a route's exchange can refer to rather than repeat.
- **`placeholders`**, each with its JavaScript and Python value: `WRITER` (`@pipelex/sdk`), `NEEDS` (`Node 22.12 or later`), `RUNNER` (`npx --yes @pipelex/sdk@{{SDK_VERSION}}`), and `SDK_VERSION`, which each suite fills with its own SDK's version. They appear as `{{NAME}}` in a case's expected outputs only, and each suite substitutes the language values first, then `{{SDK_VERSION}}`.
- **`cases`**, each with these fields:
  - `name`, unique, and `summary`, one sentence saying what the case holds.
  - `argv`, the arguments after the command's name.
  - `env`, merged over the table's `env`; a `null` value unsets the variable. The command sees only this environment.
  - `files`, created in a fresh, empty working directory before the command runs, parents included: `{path, text}`, `{path, base64}` for bytes that are not UTF-8, `{path, symlink}` whose value is the link's target as written, relative to the link's directory, and `{path, directory: true}`.
  - `stdin`, the text stdin holds; empty when absent.
  - `routes`, keyed `"<METHOD> <path>[?<query>]"` on the base URL, each a list of exchanges answering that route's calls in order, each once. An exchange gives the answer's `status`, `headers` and JSON `body` (or raw `text`, or none), or `answer`, the name of a table-level answer whose fields it takes, or `unreachable: true`, a connection refused. `request_body`, when given, is what the command must send: the sent JSON body, without its top-level keys whose value is `null`, which mean absent, must equal it. Every request must carry `Authorization: Bearer <PIPELEX_API_KEY>`. A request the case did not record, and a recorded exchange the command never asked for, fail the case.
  - `interrupt`, optional, `{route, call}`: when that call of that route arrives, the suite interrupts the command, as Ctrl-C would, instead of answering; the route lists no exchange for it.
  - `expect`: `exit_code`; either `stdout`, exact, or `stdout_includes`, substrings that must appear in order; `stderr`, substrings that must appear in stderr in this order, each found after the end of the one before, so a case pins the command's own sentences and the data they carry without pinning every line an SDK adds; `stderr_excludes`, substrings that must not appear anywhere, such as a key or a password; `files`, each `{path, text, executable}` that must exist with exactly that text, and with its owner's execute bit when `executable`; and `absent_files`, paths that must not exist.

**Writing a case.** A number in a recorded answer is an integer below 2^53 or a decimal whose shortest form both languages print alike, never `1.0` nor `1e16`, and an object's keys are never integer-like, since JavaScript would print those first; the two commands then print a recorded output byte for byte alike. A needle that ends with `\n` pins a whole line's end. Add the case at the source, run `make shared-files` at the root, and make it pass in both suites.
