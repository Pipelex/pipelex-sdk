# The `pipelex-sdk` command

`pipelex-sdk` on PyPI publishes one command, `pipelex-sdk`, which runs a method on the Pipelex API with nothing to install but [uv](https://docs.astral.sh/uv/). Its subcommands are `run`, which runs a method and prints its main output as JSON, and `script`, which writes a short shell script that runs one method with this SDK's version pinned, which is the lightest way to give a method a command of its own.

```bash
uvx pipelex-sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs inputs.json
uvx pipelex-sdk run --method ./receipt-review --inputs-template > inputs.json
uvx pipelex-sdk script --method github.com/acme/methods/receipt-review@v1.0.0 --pipe receipts.review_receipt
./receipt-review --inputs inputs.json
```

`uvx` runs a package's command of the package's own name, so `uvx pipelex-sdk …` is enough; it installs the package in an environment of its own, cached after the first run. In an environment that has the SDK installed, `pip install pipelex-sdk` or `uv add pipelex-sdk`, the command is `pipelex-sdk …`. The JavaScript SDK, `@pipelex/sdk` on npm, publishes the same command under the same name (`npx @pipelex/sdk …`, its `js/docs/cli.md`), with the same flags and the same output: both are held to one recorded case table, described at the end of this page.

The command lives in `pipelex_sdk/cli.py`, the executable that `[project.scripts]` in `pyproject.toml` declares, and the `pipelex_sdk/command/` package. It sits at the top of the SDK's dependency graph: nothing in the SDK imports it, so a program that uses the client never loads it (`tests/unit/test_cli_packaging.py` imports every other module in a fresh interpreter and holds that), and it reaches the SDK only through its public modules, as any other caller would. It adds no dependency. Its flags are read by its own reader, `command/args.py`, which splits the command line as Node's `util.parseArgs` does and applies the JavaScript command's rules to the result: `argparse` lets the last of a repeated flag win, reports an unknown option only after the other problems, words its refusals itself and exits by itself, so it cannot be held to the table.

## `run`

```text
pipelex-sdk run --method <method> [--pipe <domain.pipe_code>] [--inputs <file> | --inputs-template]
```

- **`--method`**, required, names the method in one of three forms, told apart by shape alone. A value starting with `mt_` is a catalog id, sent as `method_id`. A value starting with `github.com/` is a published method's address, `github.com/<owner>/<repo>[/<package>][@<tag>]`, sent as `method_ref`. Anything else is a path to a `.mthds` file or a bundle directory, which must exist and is read from disk and sent inline (see "Reading a bundle" below). A file or directory that happens to be named `mt_…` is reached as `./mt_…`, so what a value names never depends on what the current directory holds, and an address is written without its scheme. An `mt_` value holding a character no catalog id holds, anything but letters, digits, `_` and `-`, is a usage error made before any request, which says to write `./` to name a file: `mt_review.mthds` is refused, `./mt_review.mthds` is a path.
- **`--pipe`** names the pipe by its qualified ref, `domain.pipe_code`. It is sent as `pipe_ref` to the input preparation and as `pipe_code` to the run. A bare code, and an `alias->domain.pipe_code` ref naming a dependency's pipe, are usage errors. Without it, the run takes the method's main pipe, as the API resolves it.
- **`--inputs`** names a JSON file holding one object, one entry per input, the shape `mthds run --inputs` and `cli-python`'s `--inputs` take; `-` reads it from stdin. A relative path resolves against the current directory. Without it the run gets no inputs. When the object has entries, they first go through the SDK's input preparation (`prepare_inputs`, one `POST /v1/pipe-io` call): a local path or a `data:` URL at a file input is uploaded and replaced by its `pipelex-storage://` reference, each upload is reported on stderr, and a URL passes through. An empty object or no `--inputs` makes no preparation request. A value at a file input that is no file, a `data:` URL that does not decode or a value of another type such as a number, is a usage error, as is a local path that cannot be read; a method that does not load, met during the preparation, is reported as `--inputs-template` reports it ("Exit codes, errors and Ctrl-C" below). The command tells the two apart by the SDK's error classes, `InvalidLocalSourceError` and `InvalidInputValueError` for the inputs' mistakes and `MethodLoadError` for the method's ([`input-preparation.md`](input-preparation.md)).
- **`--inputs-template`** prints the pipe's inputs template, the object `--inputs` takes with a placeholder for every input, and runs nothing. The template is rendered by `mthds`' `render_inputs_template`, in its compact JSON shape, from the input-form descriptor one `POST /v1/pipe-io` call returns, which spends no inference. It takes no `--inputs`.

The run goes through the SDK's `start_and_wait`: on the hosted API a durable start, then polls until the run ends, however long it takes, and on a bare runner the blocking execute. Its `on_started` callback prints `Run started: <id>` on stderr as soon as the run exists ([`run-results.md`](run-results.md)). The poll reads only the `main_stuff` artifact.

**stdout carries the run's main output and nothing else**, as indented JSON (two spaces), followed by a newline: exactly what JavaScript's `JSON.stringify(value, null, 2)` prints, non-ASCII characters as they are. The command prints it with its own printer, `command/json_text.py`, rather than `json.dumps`, whose layout of a number differs (`1e-07` where JavaScript prints `1e-7`, `1e+16` where it prints `10000000000000000`), so that both commands print the same bytes. It is printed as the method produced it, unvalidated and unrepaired: a list output arrives either bare or wrapped as `{"items": […]}` depending on the runtime path, and is printed as it arrived. An output the method left absent, which the run delivers as the runtime's absence document (matched by its whole shape, as `cli-python` matches it) or as nothing, prints `null`, and stderr says `The method left its output "<name>" absent (<reason>), so the result is null.` A produced file is not downloaded: its short-lived signed URL is in the printed JSON.

## `script`

```text
pipelex-sdk script --method <address | catalog id> [--pipe <domain.pipe_code>] [--name <name>] [--dir <dir>]
```

`script` checks the method with one `POST /v1/pipe-io` call, which selects the pipe as the run will and spends no inference, so a typo in the address or the pipe is caught when the script is written rather than when it first runs. Then it writes an executable file and prints its path on stdout:

```sh
#!/bin/sh
# receipt-review: runs github.com/acme/methods/receipt-review@v1.0.0 on the Pipelex API.
# Written by pipelex-sdk X.Y.Z. Needs uv, and PIPELEX_API_KEY in the environment.
# Usage: ./receipt-review --inputs inputs.json, or ./receipt-review --inputs-template to see what to fill in.
exec uvx pipelex-sdk@X.Y.Z run --method 'github.com/acme/methods/receipt-review@v1.0.0' --pipe 'receipts.review_receipt' "$@"
```

- **The method is an address or a catalog id.** A local bundle is refused, since a script naming a path breaks as soon as the script or the bundle moves; the refusal names both ways to get one, publishing the method or saving it to the catalog. An address without a tag is accepted, with a warning that the script follows the repository's default branch.
- **The name** defaults to the address's last segment without its tag, or, for a catalog id, to the method's name read from its catalog entry (`GET /v1/methods/{id}`) and kebab-cased: decomposed (NFKD), stripped of combining marks, lowercased, every run of characters outside `a-z0-9` turned into one `-`, trimmed of `-`. A name that comes out empty asks for `--name`. A name is a file name: it may not be empty, `.` or `..`, or hold a `/` or a control character.
- **The file** is written in `--dir`, by default the current directory, which must exist. It is created with the permissions of an executable (`0755`, less the umask) and never over an existing file, a dangling link included (`O_CREAT | O_EXCL`). The path printed is `--dir` as given without its trailing `/`, or `.`, then `/` and the name.
- **The script's one line** is `exec uvx pipelex-sdk@<version> run --method '<method>' [--pipe '<pipe>'] "$@"`: every value single-quoted, an inner `'` spelled `'\''`, and no value may hold a control character. The `"$@"` passes everything else on, `--inputs`, `--inputs-template` and stdin included, and since `run` refuses a flag given twice, a second `--method` cannot quietly run another method. The version is the one of the SDK that wrote the script, read from the installed package's metadata, so the script keeps running the command it was written with; `uvx` caches the package's environment, so after the first run only the API needs the network. There is no option to write the JavaScript SDK's line, since this SDK cannot know which version of the other package exists and was tested.
- **On Windows** the script needs a POSIX shell, such as Git Bash or WSL; otherwise type the `uvx` line directly.

## The environment

The key comes from `PIPELEX_API_KEY` and nowhere else, since a flag would put it in the shell's history and the process list; its absence is a usage error that says where to get a key, and the command never prints it. The API's address comes from `PIPELEX_BASE_URL`, `https://api.pipelex.com` when unset; a refused base URL is reported without its credentials, path or query, which is the SDK's own refusal ([`architecture.md`](architecture.md), "Credentials & configuration"). An empty variable counts as unset. Every request carries `pipelex-sdk-cli/<version>` before the SDK's own tokens in its `User-Agent` ([`client-identification.md`](client-identification.md)).

**No `.env` file is read.** A command started through `uvx` from wherever the person stands would otherwise pick up a credential from whichever file it found there. To load one into the shell: `set -a; . ./.env; set +a`.

**`PIPELEX_SDK_POLL_INTERVAL_MS` is for tests only.** It sets the poll interval in milliseconds, a whole number; the case table sets it to `0` so that a run answered "still running" is polled again at once, and serves its `202` answers with `Retry-After: 0`, since the SDK waits at least as long as the server's `Retry-After`. Unset, the SDK's own interval applies. The JavaScript command reads the same variable.

## Exit codes, errors and Ctrl-C

The exit code is presentation, following the workspace's surface-output rule: a script reads stdout.

| Code | When |
| --- | --- |
| `0` | The result was printed, or the script written, or the help or version shown |
| `1` | The run failed, the API refused a request, could not be reached, or answered what the command cannot read |
| `2` | A usage error: a bad flag, an unreadable or invalid inputs file, a selector of no known form, a path that names no bundle, a missing key, a refused base URL, an `mt_` value that cannot be a catalog id, a local file the inputs name that cannot be read, a value at a file input that is no file, a script that would overwrite a file |
| `130` | Interrupted |

Every error goes to stderr, its first line `Error: <sentence>` and the lines under it giving the details, never a traceback. The command words a failure from the error's typed fields rather than from an SDK message, wherever the fields carry what a person needs, so that the Python and JavaScript commands print the same lines for the same answer:

- **A refused request**: `Error: the API refused the request (status <n>).`, then `Reason: <the problem's detail>`, each validation error as `  - <file>: <message>`, `Next step: <the advised action>` and `Request id: <id>` when the answer carries them.
- **A failed run**: `Error: run <id> ended with status <STATUS>.`, then `Reason: <the report's message>` (the problem's own sentence when the run has no report) and `Next step: <the report's advised action>`.
- **A method that does not load**: `Error: the method does not load.`, then one line per validation error, as `  - <file>: <message>`, or, when there is none, `  - <the answer's own message>`. It reads the same whichever request found it: the pipe I/O call of `--inputs-template` and `script`, or the input preparation of a run with inputs, which raises `MethodLoadError`.
- **A value at a file input that is no file**: `Error: the inputs hold a value at a file input that cannot be read as a file.`, then `Reason: <the SDK's message>` and the forms a file input takes. An unreadable local path reads `Error: Local file cannot be read: "<path>" (<code>).`, the code being the system's (`ENOENT`, `EACCES`, …).
- **An unreachable API**: `Error: could not reach the Pipelex API at <base URL> (<code>).`, the code being the name of the httpx failure (`ConnectError`, `ABORT_TIMEOUT` for a timeout) that `ApiUnreachableError` carries.

The checks that need no request come first, so a mistake costs nothing, and they run before the command starts its one event loop. `run` checks, in this order, its flags, `--pipe`'s form, the method (reading a path from disk), the inputs, the poll interval, the key and the base URL. `script` checks its flags, `--pipe`'s form, a control character in any value, the method's form, `--name`, `--dir`, the target file when its name is already known, the key and the base URL. The flags are read in command-line order and the first problem is the one reported: `--help` or `-h` anywhere before `--` asks for the help whatever else is there, and an argument that is exactly one of the two is never taken as a flag's value, so `run --method --help` prints the help; an unknown option or a positional argument is refused; a flag given twice is refused rather than the last one winning; a string flag needs a non-empty value, given as the next argument or after `=`, and a next argument starting with `-` is not taken as one, except `-` alone, which `--inputs` reads as stdin.

**Ctrl-C does not stop the run.** The command stops waiting, says where the run stood and exits `130`: before any request to run, `Interrupted. No run was started.`; from the request that starts the run until the API answers with its id, `Interrupted before the API answered with a run id. A run may or may not have started on the server.`; once the run exists, `Interrupted. Run <id> keeps going on the server.` Fetching that run later is not built into the command: the SDK's `wait_for_result(run_id)` does it. All the waiting happens inside one `asyncio.run`, which turns the first Ctrl-C into a cancellation of the wait and raises `KeyboardInterrupt` once the wait has unwound; the SDK's wait gives up on that cancellation on every supported Python, 3.11 included. A second Ctrl-C ends the wait at once.

## Reading a bundle

A `--method` path is read by the command's own reader (`command/bundle.py`), whose rules are recorded as cases so that both commands read a bundle the same way:

- **A `.mthds` file** is a one-file bundle, sent under its own file name. A file of any other name is refused.
- **A directory** is every `.mthds` file under it, at any depth, each sent under its path relative to the directory, with `/` between segments.
- **The order** is the order of those names compared code point by code point, which is the order of their UTF-8 bytes and the order Python sorts strings in: `Zeta.mthds` before `main.mthds`, `steps/score.mthds` before `steps2.mthds`, and `～.mthds` (U+FF5E) before `🧾.mthds` (U+1F9FE). A run sends the contents in this order as `mthds_contents`, and the pipe I/O route gets them as `files`, each with its name as `source`.
- **A hidden entry**, a file or a directory whose name starts with `.`, is skipped, so a `.venv/` or a `.git/` inside a bundle is never read.
- **Any file not named `.mthds`** is ignored, Python files included: the command sends only the MTHDS sources.
- **A symbolic link** is judged by its own name. One named `.mthds` that leads to a file is read through, under the link's name; one that leads to a directory is not descended into, which keeps a link cycle from looping; one that leads nowhere is refused. The `--method` path itself may be a link, and is followed.
- **A directory with no `.mthds` file** under it is refused, and so is a file that is not UTF-8 text and a directory that cannot be listed. A byte-order mark is kept as the file's first character, as it is on disk.

## The case table

The Python and JavaScript commands share no code, so they are held together by one recorded table of cases written for both. Its source is the JavaScript SDK's `js/tests/fixtures/cli-cases.json`; `tests/fixtures/cli-cases.json` here is its copy, which `make shared-files` at the repository root writes and `make check-shared-files` holds byte for byte, and which is never edited here. A behaviour of the command changes at the source, in the table and in both commands, and a case one command cannot pass is settled by changing the table for both, never by skipping it here. The table's fields are described in the JavaScript SDK's `js/docs/cli.md`, "The case table".

`tests/unit/test_cli.py` runs every case through `run_command` in-process, in a fresh working directory holding the case's files, with the case's environment and stdin, and with every `httpx.AsyncClient` answering from the case's recorded routes through an `httpx.MockTransport`. So the command runs on the SDK's real client: what is checked is what it sends and what it prints, never which client method it called. The table's placeholders take their Python values: `WRITER` is `pipelex-sdk`, `NEEDS` is `uv`, and `RUNNER` is `uvx pipelex-sdk@{{SDK_VERSION}}`. A sent body is compared without its top-level keys whose value is `null`, which mean absent. An interrupt case raises a real `SIGINT` while the named request is in flight, which `asyncio.run` turns into a cancellation of the wait, as Ctrl-C would. A case that uses a field the suite does not know fails rather than being skipped.

`make test-package` builds the wheel and runs its `pipelex-sdk` command through `uvx --from <wheel>` from a directory outside the package, checking that `--help` prints the help and `--version` the version in `pyproject.toml`; CI's `python package-check` job runs it.

**What the table does not hold.** The help texts are the same word for word, and so is every sentence the table pins. Outside it, the commands differ where their languages do: an integer beyond 2^53 in an output is printed exactly here, where JavaScript prints its nearest double; an object key that looks like an integer keeps its place here, where JavaScript prints such keys first; the code of an unreachable API names the httpx failure (`ConnectError`) where the JavaScript command names the system's (`ECONNREFUSED`); the `Reason:` under an answer that is not JSON quotes each language's parser; and a refused base URL's host is shown as written here, where JavaScript shows an internationalized host in its punycode form. The table's rules for writing a case keep its numbers and keys clear of the integer and key differences.
