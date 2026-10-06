"""The run's lifecycle: one function per mode, over one client, and what a finished run prints.

The counterpart of the web app template's `useRun` hook with its `blockingRun` and `durableRun`
helpers. The mode is the person's choice, made with the command's flags (`lib/app.py`'s `RunMode`):

- **attended**, the default: `start`, the run id on stderr at once, then `wait_for_result` with a
  one-line status on stderr fed by `on_poll`. Ctrl-C leaves the run going on the server, prints the
  `--resume` command that reattaches to it, and the command exits with code 130. Losing the API
  mid-wait prints the same command before the error.
- **`--blocking`**: one `execute`, lifted onto the same `RunResults` with `results_from_execute`.
  Behind the hosted gateway it is cut off at about 30 seconds, and `lib/errors.py` presents that
  with a hint to drop the flag.
- **`--detach`**: `start`, the run id alone on stdout, and the command exits 0.
- **`--resume <run-id>`**: `wait_for_result` on a run started earlier, then the result printed
  exactly as an attended run prints it.

A durable start against a deployment that serves only blocking runs is an error that names
`--blocking`, never a silent downgrade, which is why the SDK's `start_and_wait`, which chooses
between the two from the `/v1/version` handshake, is deliberately not used here: a silent fallback
would make `--detach` and `--resume` quietly inapplicable, and on the hosted gateway a long run would
hit the blocking cut-off instead of running durably.

A new run whose method declares a file input anywhere in its input form first goes through the
SDK's `prepare_inputs`, which uploads each local path the options or the inputs file gave and
rewrites it to the `pipelex-storage://` reference the run reads; a URL passes through. A finished
run's result is checked against the generated model before it is printed (`lib/narrow.py`), and an
optional output the method left absent is printed as `null`, with a line on stderr saying why.

The SDK is async only, so these are coroutines and the command makes one `asyncio.run` call at its
root (`cli.py`). Every function takes the client it runs on, opened once by `execute_plan` through
`lib/client.py`, which is where a test replaces it.
"""

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.artifact_models import DownloadArtifactsResult
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError
from pipelex_sdk.execute_result import results_from_execute
from pipelex_sdk.runs import PollInfo, RunResults, WaitForResultOptions
from pydantic import ValidationError
from rich.console import Console
from rich.markup import escape

from pipelex_method_cli_python.lib import client as api
from pipelex_method_cli_python.lib.app import AppError, RunMode
from pipelex_method_cli_python.lib.artifacts import EarlierDownload, download_produced_files, print_downloads
from pipelex_method_cli_python.lib.binding import MethodBinding
from pipelex_method_cli_python.lib.errors import present_error, print_error, resume_command
from pipelex_method_cli_python.lib.inputs import declares_files
from pipelex_method_cli_python.lib.narrow import NarrowedOutput, OutputValidationError, narrow_output
from pipelex_method_cli_python.lib.output import OutputShapeError, print_payload, print_run_id
from pipelex_method_cli_python.lib.usage import print_cost_report

#: What saving a run's files can raise besides the SDK's own errors and the CLI's: an `OSError` from
#: the filesystem, such as a working directory removed before `--out` is resolved; the `RuntimeError`
#: Python 3.11 and 3.12 raise when `--out` is a symbolic link loop; a body httpx cannot decode, which
#: the SDK's transport mapping leaves as httpx's own error; and a malformed answer from the route that
#: resolves the files' links, as JSON or as its model.
UNWORDED_DOWNLOAD_FAILURES = (OSError, RuntimeError, httpx.HTTPError, json.JSONDecodeError, ValidationError)


@dataclass(frozen=True)
class RunPlan:
    """What one invocation does, read from the command line by `cli.py` and checked there."""

    mode: RunMode
    #: The inputs a new run sends; empty for a resumed run, which already has its own.
    inputs: dict[str, Any] = field(default_factory=dict[str, Any])
    #: The run a `--resume` reattaches to; `None` in every other mode.
    resume_run_id: str | None = None
    #: Whether the run's produced files are downloaded, which `--no-download` turns off.
    download: bool = True
    #: Where they go, from `--out`; `None` for `outputs/<run-id>/`.
    out_dir: Path | None = None


async def execute_plan(plan: RunPlan, *, binding: MethodBinding, stderr: Console) -> int:
    """Run the plan over one client and return the command's exit code.

    Raises:
        PipelineRequestError: An SDK error, which the command's boundary presents.
        AppError: A failure the CLI detected itself, which the boundary presents the same way.
    """
    async with api.make_client() as client:
        inputs = plan.inputs
        if plan.mode is not RunMode.RESUME:
            inputs = await prepare_run_inputs(client, binding=binding, inputs=inputs, stderr=stderr)
        match plan.mode:
            case RunMode.DETACH:
                run_id = await start_run(client, binding=binding, inputs=inputs, stderr=stderr)
                print_run_id(run_id)
                stderr.print(f"Run {escape(run_id)} started. Collect its result with: [bold]{escape(resume_command(run_id))}[/bold]")
                return 0
            case RunMode.BLOCKING:
                results = await run_blocking(client, binding=binding, inputs=inputs, stderr=stderr)
            case RunMode.RESUME:
                if plan.resume_run_id is None:
                    msg = "A resumed run needs the id of the run to resume."
                    raise ValueError(msg)
                results = await attend_run(client, run_id=plan.resume_run_id, stderr=stderr)
            case RunMode.ATTENDED:
                run_id = await start_run(client, binding=binding, inputs=inputs, stderr=stderr)
                stderr.print(f"Run started: [bold]{escape(run_id)}[/bold]")
                results = await attend_run(client, run_id=run_id, stderr=stderr)
        return await deliver(client, results, plan=plan, binding=binding, stderr=stderr)


async def prepare_run_inputs(client: PipelexAPIClient, *, binding: MethodBinding, inputs: dict[str, Any], stderr: Console) -> dict[str, Any]:
    """Upload the local files a new run's inputs name, when its method declares a file input anywhere.

    The SDK's `prepare_inputs` asks the API for the pipe's signature, walks the inputs by each
    input's declared kind, uploads every local path at a file position and rewrites it to the
    `pipelex-storage://` reference the run reads; a URL and a reference already uploaded pass through.
    A method with no file input skips the request altogether.

    Raises:
        InputPreparationError: A file cannot be read or uploaded, raised before any run starts.
    """
    if not inputs or not declares_files(binding.contracts.input_form):
        return inputs
    with stderr.status("Preparing the input files…"):
        prepared = await client.prepare_inputs(pipe_ref=binding.pipe_ref, inputs=inputs, **binding.source.crate_kwargs())
    for upload in prepared.uploads:
        stderr.print(f"Uploaded {escape(upload.filename)} as {escape(upload.uri)}")
    return prepared.inputs


async def start_run(client: PipelexAPIClient, *, binding: MethodBinding, inputs: dict[str, Any], stderr: Console) -> str:
    """Start a durable run of the bound pipe and return its id.

    A Ctrl-C while the start request is in flight is the one moment with no id to resume from: the
    request may or may not have reached the server, which this says rather than guessing.
    """
    try:
        started = await client.start(pipe_code=binding.pipe_ref, inputs=inputs, **binding.source.run_kwargs())
    except asyncio.CancelledError:
        stderr.print(
            "\nInterrupted before the API answered with a run id. A run may or may not have started on the server, "
            "and without its id it cannot be resumed."
        )
        raise
    return started.pipeline_run_id


async def attend_run(client: PipelexAPIClient, *, run_id: str, stderr: Console) -> RunResults:
    """Wait here for a durable run's result, with a one-line status on stderr.

    Cancelling the wait, which is what Ctrl-C does under `asyncio.run`, leaves the run going on the
    server: it prints the command that reattaches to it and lets the cancellation through, which the
    command's boundary turns into exit code 130. Losing the API mid-wait, unreachable or answering a
    server fault or a rate limit, says the same before the boundary presents the error, since the
    run may well still be going; a refusal such as a `404` for an unknown id says nothing of the kind.
    """
    short_id = escape(run_id[:8])
    with stderr.status(f"Run {short_id}… in progress") as status:

        def on_poll(info: PollInfo) -> None:
            status.update(f"Run {short_id}… in progress, {info.elapsed_seconds:.0f}s, poll #{info.attempt}")

        try:
            return await client.wait_for_result(run_id, options=WaitForResultOptions(on_poll=on_poll))
        except asyncio.CancelledError:
            stderr.print(f"\nInterrupted. The run is still going on the server; resume it with: [bold]{escape(resume_command(run_id))}[/bold]")
            raise
        except (ApiUnreachableError, ApiResponseError) as exc:
            if isinstance(exc, ApiResponseError) and not _is_transient(exc):
                raise
            stderr.print(
                f"\nLost contact with the API while waiting. The run may still be going on the server; "
                f"resume it with: [bold]{escape(resume_command(run_id))}[/bold]"
            )
            raise


def _is_transient(exc: ApiResponseError) -> bool:
    """Whether a poll's refusal says nothing about the run: a server fault, or a rate limit."""
    return exc.status >= 500 or exc.status == 429


async def run_blocking(client: PipelexAPIClient, *, binding: MethodBinding, inputs: dict[str, Any], stderr: Console) -> RunResults:
    """Run the bound pipe in one request and lift the response onto `RunResults`, as a durable run returns it."""
    with stderr.status("Running…"):
        try:
            result = await client.execute(pipe_code=binding.pipe_ref, inputs=inputs, **binding.source.run_kwargs())
        except asyncio.CancelledError:
            stderr.print("\nInterrupted. A blocking run has no id to resume it by.")
            raise
    return results_from_execute(result)


async def deliver(client: PipelexAPIClient, results: RunResults, *, plan: RunPlan, binding: MethodBinding, stderr: Console) -> int:
    """Print a finished run's result on stdout, then its files and its cost on stderr; return the exit code.

    The result is printed first, so a failure to bring a file down never costs the reader the result
    the run was paid for, and the cost report follows whatever happened after the run, an error
    raised on the way included. A result in a shape the binding does not declare, or one the output
    model refuses, is not printed, but the run's files still come down, since they are paid for and
    their links expire, and the error is raised once the cost report is out. An optional output the
    method left absent is printed as `null`, and a line on stderr says so. A file that did not come
    down makes the exit code 1, since the command did not do all it was asked, and so does a default
    directory an earlier download left short; the hint says how to fetch the files again where that
    is possible, and whether the result above is complete, and a Ctrl-C while they come down says it
    too before the cancellation goes through. A download that raises after the model refused the
    result is printed here, and the refusal is raised all the same: it is what says the result was
    not printed, which a failure to save the files must never hide.
    """
    exit_code = 0
    shape_error: OutputShapeError | OutputValidationError | None = None
    try:
        resume_hint = None if plan.mode is RunMode.BLOCKING else resume_command(results.pipeline_run_id)
        try:
            narrowed = narrow_output(
                results,
                output_model=binding.output_model,
                output_is_list=binding.output_is_list,
                output_optional=binding.contracts.io.output.optional,
                resume_hint=resume_hint,
            )
        except (OutputShapeError, OutputValidationError) as exc:
            shape_error = exc
        else:
            print_payload(narrowed.payload)
            if narrowed.absent:
                stderr.print(absence_note(narrowed))
        if plan.download:
            try:
                downloaded = await download_produced_files(client, results, out_dir=plan.out_dir)
            except asyncio.CancelledError:
                stderr.print(f"\nInterrupted while saving the run's files. {refetch_advice(plan.mode, results.pipeline_run_id)}")
                raise
            except (PipelineRequestError, AppError) as exc:
                if shape_error is None:
                    raise
                print_error(stderr, present_error(exc, mode=plan.mode))
                # Raised without `from`, so the refusal keeps its own cause; the download's failure, printed above, is its context.
                raise shape_error
            except UNWORDED_DOWNLOAD_FAILURES as exc:
                # A failure neither the SDK nor the CLI words must not hide the refusal either; without one, it
                # stays what it is. Anything else is a bug, and crashes loudly whatever the result was.
                if shape_error is None:
                    raise
                failure = AppError(f"Saving the run's files failed: {type(exc).__name__}: {exc}")
                print_error(stderr, present_error(failure, mode=plan.mode))
                raise shape_error
            print_downloads(stderr, downloaded)
            if _incomplete(downloaded):
                said = "its result is complete above" if shape_error is None else "its result was not printed, for the reason below"
                stderr.print(f"[yellow]Hint:[/yellow] The run succeeded and {said}. {refetch_advice(plan.mode, results.pipeline_run_id)}")
                exit_code = 1
    finally:
        print_cost_report(stderr, results)
    if shape_error is not None:
        raise shape_error
    return exit_code


def absence_note(narrowed: NarrowedOutput) -> str:
    """What stderr says when the method left its optional output absent, as Rich markup."""
    reason = f" ({escape(narrowed.absence_reason)})" if narrowed.absence_reason else ""
    return f"The method produced no output this time{reason}. Its output is optional, so the result is null."


def _incomplete(downloaded: DownloadArtifactsResult | EarlierDownload | None) -> bool:
    """Whether the run's files are known not to be all on disk."""
    if isinstance(downloaded, EarlierDownload):
        return not downloaded.complete
    return downloaded is not None and not downloaded.all_saved


def refetch_advice(mode: RunMode, run_id: str) -> str:
    """How to bring a finished run's files down again, as Rich markup.

    A durable run is read again with `--resume`, into a directory of its own: the SDK never
    overwrites a file, so fetching into the same directory would save the files that did come down
    a second time, beside themselves. A blocking run has no id to resume by, since a bare runner
    keeps no run and the hosted API files a blocking run under an id of its own, so the only way to
    its files is to run the method again.
    """
    if mode is RunMode.BLOCKING:
        return (
            "A blocking run cannot be resumed, so its files come down again only by running the method again, "
            "without --blocking so that --resume can fetch them later."
        )
    return f"Fetch its files again into an empty directory with [bold]{escape(resume_command(run_id))} --out DIR[/bold]."
