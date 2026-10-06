# The run lifecycle

The command runs its one method in one of the modes below, chosen with a flag. [`lib/run.py`](../src/pipelex_method_cli_python/lib/run.py) holds one function per mode over one client, and [`cli.py`](../src/pipelex_method_cli_python/cli.py) reads the flags, refuses the combinations that make no sense, and makes the one `asyncio.run` call at the command's root.

## The modes

| Flags | What happens | stdout |
| --- | --- | --- |
| none | `start`, the run id on stderr at once, then `wait_for_result` with a status line on stderr | the result |
| `--blocking` | one `execute`, lifted onto the same `RunResults` with `results_from_execute` | the result |
| `--detach` | `start`, then the command returns | the run id alone |
| `--resume RUN_ID` | `wait_for_result` on a run started earlier | the result |

**The result is the same JSON in every mode**: the run's `main_stuff` as the method produced it, a plural output as the bare list of its elements whichever wire shape arrived. After it, on stderr, come the paths of the files the run produced, downloaded under `outputs/<run-id>/` unless `--out DIR` or `--no-download` says otherwise, and the cost report, which is printed whatever the download did.

**An optional output may be absent.** A pipe whose output contract says `optional` may succeed without producing it, and the run then delivers the runtime's absence document, `{"absent": true, "variable_name": …, "kind": …, "reason": …, "producing_pipe": …, "upstream": …}`, in place of the output. The document is recognised by exactly those keys and no other, each holding the type the runtime writes, so a result of the method's own that happens to carry `"absent": true`, from a model with an `absent` field, is data and is checked and printed like any other. It is recognised before the output model is consulted, whatever the output's optionality, since an opaque model, or one with no required field, would otherwise take it as data. The command prints `null` on stdout, says on stderr that the method produced no output this time, with the runtime's reason, and that its output is optional, and exits 0: the method worked as declared. The same absence from a pipe whose output is not optional, the document or no output at all, is the method breaking its own contract: nothing is printed on stdout, the error says the run delivered no output although the pipe's contract requires one, with the absence's kind and reason beneath it, and the command exits 1. The hint points at the method, which did not produce what it promises, rather than at the generated tree, and offers no `--resume`, since fetching the result again would deliver the same absence. The run's files still come down and its cost is still reported, as for a result the model refuses.

**A file that did not come down** makes the exit code 1 after the result, and the hint depends on the mode. It says the result above is complete only when the result was printed; when the output model refused it, the hint says the result was not printed, and the error follows it. A durable run's files come down again with `--resume <run-id> --out DIR` into an empty directory: the SDK never overwrites a file, so fetching into the same directory would save the files that did come down a second time, beside themselves. A blocking run has no id to resume by, so its hint says that only running the method again, without `--blocking`, brings the files down. **A finished download leaves a manifest.** Once every file of a run has come down into `outputs/<run-id>/`, the command writes `.pipelex-download.json` there, moved into place only once it is whole: each file's storage reference, its name and the size it was saved at. A second `--resume` of that run finds the manifest, checks that it names every file the run produced and that each is there at its size, and fetches nothing, saying so, with exit code 0. A directory holding files and no manifest, or a manifest that names a file now missing, cut short or not at all, is a download that an interruption, a failure or a concurrent run left unfinished: the command fetches nothing, says why the download is not whole, and exits 1 with the same hint, `--out DIR` into an empty directory, since fetching into that directory would save the files already there a second time. A directory holding only dotfiles, such as a file browser's `.DS_Store`, is no earlier download, and one the command cannot read, or a file standing where the directory should be, is an error that says to name another with `--out`.

**A result in a shape the binding does not declare** (a plural output that is neither a list nor the `items` envelope) is not printed, and the command exits 1; the run's files still come down and the cost report still follows, since the run was paid for and the links to its files expire. **So is a result the output model refuses**: before printing, the command validates the result against `OUTPUT_MODEL`, strictly and as the JSON it arrived as, so `"12"` never passes an integer field, and a method that changed since `make codegen` last ran can return one the model no longer describes. The error names each field that failed, and the hint says to run `make codegen`, update `binding.py`, and fetch the result again with `--resume`, which a blocking run cannot do. The model is a check, never a filter: an accepted result is printed as the method produced it. In both cases, a failure to save the run's files is printed when it happens and the refusal still follows it, so the error saying the result was not printed is never lost behind one about the download: the SDK's own errors, and those the download can raise besides, from the filesystem, from httpx or from a malformed answer, which `lib/run.py` lists. Anything else is a bug, and crashes with its traceback rather than reading like a failed download.

**A reader that stops early is not a failure**: `my-cli | head -1` closes the pipe once it has its line, and the command still brings the run's files down and prints its cost report, both on stderr.

**`--detach` and `--resume` are a pair**: `RUN_ID=$(my-cli --inputs inputs.json --detach)` captures exactly the id, and `my-cli --resume "$RUN_ID"` prints the result as an attended run would have. A resumed run takes no inputs, since it already has them.

**A new run's local files are uploaded first.** When the method declares a file input, the inputs go through the SDK's `prepare_inputs` before the run starts, which uploads each local file an option or the inputs file names and prints where it went, on stderr.

**Every hint names the command as it was invoked**: the bare name when that command is on the `PATH`, and the path it was run by otherwise, such as `.venv/bin/my-cli`, so a hint pasted back runs the same command. A path that needs quoting is quoted for the platform's shell: in POSIX single quotes, and in double quotes on Windows, where cmd.exe would keep single quotes as part of the path.

## Why the mode is the person's choice

A durable start (`start`, then polling) survives the hosted gateway's cut-off of about 30 seconds, can be followed later and resumed after Ctrl-C. A blocking run (`execute`) is one request, which a deployment without a run store can still serve. The SDK's `start_and_wait` picks between the two from the `/v1/version` handshake, and this command deliberately does not use it: a silent fallback would make `--detach` and `--resume` quietly inapplicable, and on the hosted gateway a long method would hit the blocking cut-off instead of running durably. So:

- A durable start against a deployment that cannot hold runs is an error that names `--blocking`: a bare runner's `404` (`RunLifecycleUnavailableError`) and an orchestration that serves only synchronous runs (`StartRequiresAsyncOrchestration`) both say to add the flag, and for a `--detach` invocation to drop that flag too, since a blocking run cannot be detached.
- A blocking run cut off by the gateway (`PipelineExecuteTimeoutError`, or a `502` or `504` on the blocking path) is an error that says to drop the flag.

**An attended or resumed run is waited on for up to twenty minutes**, the SDK's default for `wait_for_result`. Past that, the command exits 1 saying the run is still going on the server and printing the `--resume` command, which waits again from that moment. Losing the API during the wait, unreachable or answering a server fault or a rate limit, prints the same command before the error, since the run may well still be going; a refusal such as a `404` for an unknown run id does not.

## Ctrl-C

- **While an attended or resumed run is being followed**, Ctrl-C cancels the wait, not the run: the run keeps going on the server, the command prints `my-cli --resume <run-id>` on stderr, and exits with code 130.
- **While the start request is in flight**, there is no id yet, and the command says so: a run may or may not have started on the server, and without its id it cannot be resumed.
- **During a blocking run**, there is no id to resume by, and the command says that too.
- **While the run's files are coming down**, the files already saved stay, the one being written is removed, and the command prints how to fetch them all again: `--resume <run-id> --out DIR` for a durable run, a new run for a blocking one.

Under `asyncio.run`, Ctrl-C cancels the running task and then raises `KeyboardInterrupt`; the command catches it at its root and exits with 130 rather than letting Click print its own `Aborted!`.

## Flags that are refused

The command refuses, with exit code 2 and before anything is sent: `--detach` with `--blocking`, `--resume` with `--blocking` or `--detach`, `--resume` with `--inputs` or with any input's option, `--out` or `--no-download` with `--detach` (which downloads nothing), `--out` with `--no-download`, a blank `--resume`, and `--inputs-template` with anything else. It also refuses, the same way, an input's value it cannot read as the input's kind, two options both reading stdin, and a new run missing an input it needs, naming each missing input with its option ([`cli-kernel.md`](cli-kernel.md)).

## Exit codes

| Code | When |
| --- | --- |
| 0 | The run succeeded, its result was printed (`null` for an optional output it left absent) and every produced file came down, or was already in `outputs/<run-id>/`; or `--detach` started a run |
| 1 | A request or the run failed, the API key is missing, the inputs file could not be read, the result does not match the output model or is absent although the output is required (it is not printed), or a produced file did not come down or is missing from an earlier download (the result is printed first, and the hint says how to fetch the files again where the mode allows it) |
| 2 | A command line the command refuses, a required input missing among them |
| 130 | Ctrl-C |
