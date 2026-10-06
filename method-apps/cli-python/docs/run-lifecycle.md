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

**A file that did not come down** makes the exit code 1 after the result, and the hint depends on the mode. A durable run's files come down again with `--resume <run-id> --out DIR` into an empty directory: the SDK never overwrites a file, so fetching into the same directory would save the files that did come down a second time, beside themselves. A blocking run has no id to resume by, so its hint says that only running the method again, without `--blocking`, brings the files down. A second `--resume` of a run whose files were already downloaded finds `outputs/<run-id>/` holding files and fetches nothing, saying so: the directory may hold every file or only those an interrupted or partly failed download saved, so the way to fetch them all again is the same `--out DIR` into an empty directory.

**A result in a shape the binding does not declare** (a plural output that is neither a list nor the `items` envelope) is not printed, and the command exits 1; the run's files still come down and the cost report still follows, since the run was paid for and the links to its files expire.

**`--detach` and `--resume` are a pair**: `RUN_ID=$(my-cli --inputs inputs.json --detach)` captures exactly the id, and `my-cli --resume "$RUN_ID"` prints the result as an attended run would have. A resumed run takes no inputs, since it already has them.

## Why the mode is the person's choice

A durable start (`start`, then polling) survives the hosted gateway's cut-off of about 30 seconds, can be followed later and resumed after Ctrl-C. A blocking run (`execute`) is one request, which a deployment without a run store can still serve. The SDK's `start_and_wait` picks between the two from the `/v1/version` handshake, and this command deliberately does not use it: a silent fallback would make `--detach` and `--resume` quietly inapplicable, and on the hosted gateway a long method would hit the blocking cut-off instead of running durably. So:

- A durable start against a deployment that cannot hold runs is an error that names `--blocking`: a bare runner's `404` (`RunLifecycleUnavailableError`) and an orchestration that serves only synchronous runs (`StartRequiresAsyncOrchestration`) both say to add the flag, and for a `--detach` invocation to drop that flag too, since a blocking run cannot be detached.
- A blocking run cut off by the gateway (`PipelineExecuteTimeoutError`, or a `502` or `504` on the blocking path) is an error that says to drop the flag.

**An attended or resumed run is waited on for up to twenty minutes**, the SDK's default for `wait_for_result`. Past that, the command exits 1 saying the run is still going on the server and printing the `--resume` command, which waits again from that moment.

## Ctrl-C

- **While an attended or resumed run is being followed**, Ctrl-C cancels the wait, not the run: the run keeps going on the server, the command prints `my-cli --resume <run-id>` on stderr, and exits with code 130.
- **While the start request is in flight**, there is no id yet, and the command says so: the request may or may not have reached the server.
- **During a blocking run**, there is no id to resume by, and the command says that too.

Under `asyncio.run`, Ctrl-C cancels the running task and then raises `KeyboardInterrupt`; the command catches it at its root and exits with 130 rather than letting Click print its own `Aborted!`.

## Flags that are refused

The command refuses, with exit code 2 and before anything is sent: `--detach` with `--blocking`, `--resume` with `--blocking` or `--detach`, `--resume` with `--inputs`, `--out` or `--no-download` with `--detach` (which downloads nothing), `--out` with `--no-download`, and a blank `--resume`.

## Exit codes

| Code | When |
| --- | --- |
| 0 | The run succeeded, its result was printed and every produced file came down; or `--detach` started a run |
| 1 | A request or the run failed, the API key is missing, the inputs file could not be read, or a produced file did not come down (the result is printed first, and the hint says how to fetch the files again where the mode allows it) |
| 2 | A command line the command refuses |
| 130 | Ctrl-C |
