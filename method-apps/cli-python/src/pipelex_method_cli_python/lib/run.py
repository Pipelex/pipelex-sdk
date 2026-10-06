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

The SDK is async only, so these are coroutines and the command makes one `asyncio.run` call at its
root (`cli.py`). Every function takes the client it runs on, opened once by `execute_plan` through
`lib/client.py`, which is where a test replaces it.
"""

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pipelex_sdk.artifact_models import DownloadArtifactsResult
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError
from pipelex_sdk.execute_result import results_from_execute
from pipelex_sdk.runs import PollInfo, RunResults, WaitForResultOptions
from rich.console import Console
from rich.markup import escape

from pipelex_method_cli_python.lib import client as api
from pipelex_method_cli_python.lib.app import RunMode
from pipelex_method_cli_python.lib.artifacts import EarlierDownload, download_produced_files, print_downloads
from pipelex_method_cli_python.lib.binding import MethodBinding
from pipelex_method_cli_python.lib.errors import resume_command
from pipelex_method_cli_python.lib.output import OutputShapeError, print_result, print_run_id
from pipelex_method_cli_python.lib.usage import print_cost_report


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
        match plan.mode:
            case RunMode.DETACH:
                run_id = await start_run(client, binding=binding, inputs=plan.inputs, stderr=stderr)
                print_run_id(run_id)
                stderr.print(f"Run {escape(run_id)} started. Collect its result with: [bold]{escape(resume_command(run_id))}[/bold]")
                return 0
            case RunMode.BLOCKING:
                results = await run_blocking(client, binding=binding, inputs=plan.inputs, stderr=stderr)
            case RunMode.RESUME:
                if plan.resume_run_id is None:
                    msg = "A resumed run needs the id of the run to resume."
                    raise ValueError(msg)
                results = await attend_run(client, run_id=plan.resume_run_id, stderr=stderr)
            case RunMode.ATTENDED:
                run_id = await start_run(client, binding=binding, inputs=plan.inputs, stderr=stderr)
                stderr.print(f"Run started: [bold]{escape(run_id)}[/bold]")
                results = await attend_run(client, run_id=run_id, stderr=stderr)
        return await deliver(client, results, plan=plan, binding=binding, stderr=stderr)


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
    raised on the way included. A result in a shape the binding does not declare is not printed, but
    the run's files still come down, since they are paid for and their links expire, and the error
    is raised once the cost report is out. A file that did not come down makes the exit code 1,
    since the command did not do all it was asked, and so does a default directory an earlier
    download left short; the hint says how to fetch the files again where that is possible, and a
    Ctrl-C while they come down says it too before the cancellation goes through.
    """
    exit_code = 0
    shape_error: OutputShapeError | None = None
    try:
        try:
            print_result(results, output_is_list=binding.output_is_list)
        except OutputShapeError as exc:
            shape_error = exc
        if plan.download:
            try:
                downloaded = await download_produced_files(client, results, out_dir=plan.out_dir)
            except asyncio.CancelledError:
                stderr.print(f"\nInterrupted while saving the run's files. {refetch_advice(plan.mode, results.pipeline_run_id)}")
                raise
            print_downloads(stderr, downloaded)
            if _incomplete(downloaded):
                stderr.print(
                    f"[yellow]Hint:[/yellow] The run succeeded and its result is complete above. {refetch_advice(plan.mode, results.pipeline_run_id)}"
                )
                exit_code = 1
    finally:
        print_cost_report(stderr, results)
    if shape_error is not None:
        raise shape_error
    return exit_code


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
