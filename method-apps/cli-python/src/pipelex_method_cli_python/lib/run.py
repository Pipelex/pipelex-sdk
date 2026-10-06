"""The run's lifecycle: one function per mode, over one client, and what a finished run prints.

The counterpart of the web app template's `useRun` hook with its `blockingRun` and `durableRun`
helpers. The mode is the person's choice, made with the command's flags (`lib/app.py`'s `RunMode`):

- **attended**, the default: `start`, the run id on stderr at once, then `wait_for_result` with a
  one-line status on stderr fed by `on_poll`. Ctrl-C leaves the run going on the server, prints the
  `--resume` command that reattaches to it, and the command exits with code 130.
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

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.execute_result import results_from_execute
from pipelex_sdk.runs import PollInfo, RunResults, WaitForResultOptions
from rich.console import Console
from rich.markup import escape

from pipelex_method_cli_python.lib import client as api
from pipelex_method_cli_python.lib.app import RunMode
from pipelex_method_cli_python.lib.artifacts import default_download_dir, download_produced_files, print_downloads
from pipelex_method_cli_python.lib.binding import MethodBinding
from pipelex_method_cli_python.lib.errors import resume_command
from pipelex_method_cli_python.lib.output import print_result, print_run_id
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
    source = binding.source
    try:
        started = await client.start(
            pipe_code=binding.pipe_ref,
            inputs=inputs,
            mthds_contents=list(source.mthds_contents) if source.mthds_contents is not None else None,
            method_id=source.method_id,
            method_ref=source.method_ref,
        )
    except asyncio.CancelledError:
        stderr.print("\nInterrupted before the API answered with a run id, so there is no run to resume.")
        raise
    return started.pipeline_run_id


async def attend_run(client: PipelexAPIClient, *, run_id: str, stderr: Console) -> RunResults:
    """Wait here for a durable run's result, with a one-line status on stderr.

    Cancelling the wait, which is what Ctrl-C does under `asyncio.run`, leaves the run going on the
    server: it prints the command that reattaches to it and lets the cancellation through, which the
    command's boundary turns into exit code 130.
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


async def run_blocking(client: PipelexAPIClient, *, binding: MethodBinding, inputs: dict[str, Any], stderr: Console) -> RunResults:
    """Run the bound pipe in one request and lift the response onto `RunResults`, as a durable run returns it."""
    source = binding.source
    with stderr.status("Running…"):
        try:
            result = await client.execute(
                pipe_code=binding.pipe_ref,
                inputs=inputs,
                mthds_contents=list(source.mthds_contents) if source.mthds_contents is not None else None,
                method_id=source.method_id,
                method_ref=source.method_ref,
            )
        except asyncio.CancelledError:
            stderr.print("\nInterrupted. A blocking run has no id to resume it by.")
            raise
    return results_from_execute(result)


async def deliver(client: PipelexAPIClient, results: RunResults, *, plan: RunPlan, binding: MethodBinding, stderr: Console) -> int:
    """Print a finished run's result on stdout, then its files and its cost on stderr; return the exit code.

    The result is printed first, so a failure to bring a file down never costs the reader the result
    the run was paid for. A file that did not come down makes the exit code 1, since the command did
    not do all it was asked, and the hint says how to fetch the files again.
    """
    print_result(results, output_is_list=binding.output_is_list)
    exit_code = 0
    if plan.download:
        dir_path = plan.out_dir if plan.out_dir is not None else default_download_dir(results.pipeline_run_id)
        downloaded = await download_produced_files(client, results, dir_path=dir_path)
        print_downloads(stderr, downloaded)
        if downloaded is not None and not downloaded.all_saved:
            run_id = results.pipeline_run_id
            stderr.print(
                "[yellow]Hint:[/yellow] The run succeeded and its result is complete above; "
                f"fetch its files again with [bold]{escape(resume_command(run_id))}[/bold]."
            )
            exit_code = 1
    print_cost_report(stderr, results)
    return exit_code
