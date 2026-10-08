"""`pipelex-sdk run`: run one method and print its main output.

Every check that needs no request comes first, in this order, so that a mistake costs nothing: the
flags, `--pipe`'s form, the method (a path is read from disk), the inputs, the poll interval, the key
and the base URL. They run before the command's event loop starts, so a Ctrl-C while stdin or a file is
read stops at once (`loop.py`). Then, on that one loop, the inputs are prepared, which uploads each local file at a file input; the
run is started through the SDK's start-and-wait, whose `on_started` gives the run id to stderr as soon
as the run exists; and the main output reaches stdout once the run completes, however long that takes.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Any

from mthds.protocol.inputs_template import InputsTemplateFormat, render_inputs_template

from pipelex_sdk.command.args import FlagKind, parse_flags
from pipelex_sdk.command.bundle import read_bundle
from pipelex_sdk.command.environment import make_client, read_poll_interval
from pipelex_sdk.command.help import RUN_HELP
from pipelex_sdk.command.inputs import read_inputs
from pipelex_sdk.command.io import EXIT_OK, usage_error
from pipelex_sdk.command.loop import before_request, run_until_done
from pipelex_sdk.command.method import AddressSelector, CatalogSelector, PathSelector, check_pipe_ref, classify_method
from pipelex_sdk.command.present import print_result
from pipelex_sdk.command.source import AddressSource, BundleSource, CatalogSource, crate_selector, describe_pipe, run_selector
from pipelex_sdk.runs import RunArtifact, WaitForResultOptions

if TYPE_CHECKING:
    from collections.abc import Sequence

    from pipelex_sdk.client import PipelexAPIClient
    from pipelex_sdk.command.io import CommandIO, Progress
    from pipelex_sdk.command.source import MethodSource
    from pipelex_sdk.runs import PipelexRunResultStart

_RUN_FLAGS: dict[str, FlagKind] = {
    "method": FlagKind.STRING,
    "pipe": FlagKind.STRING,
    "inputs": FlagKind.STRING,
    "inputs-template": FlagKind.BOOLEAN,
}

_NOT_STARTED = "Interrupted. No run was started."
_STARTING = "Interrupted before the API answered with a run id. A run may or may not have started on the server."


def run_command_run(args: Sequence[str], io: CommandIO, progress: Progress) -> int:
    """Run `pipelex-sdk run` and return its exit code."""
    flags = parse_flags("run", args, _RUN_FLAGS)
    if flags.help:
        io.write_stdout(RUN_HELP)
        return EXIT_OK
    method = flags.strings.get("method")
    if method is None:
        msg = "--method is required."
        raise usage_error(msg, ["Run 'pipelex-sdk run --help' to see its flags."])
    inputs_source = flags.strings.get("inputs")
    template_only = "inputs-template" in flags.booleans
    if template_only and inputs_source is not None:
        msg = "--inputs-template prints the inputs a run takes, so it takes no --inputs."
        raise usage_error(msg)
    pipe = flags.strings.get("pipe")
    if pipe is not None:
        check_pipe_ref(pipe)

    progress.interrupt_message = "Interrupted." if template_only else _NOT_STARTED
    source = _method_source(method)
    inputs = None if inputs_source is None else read_inputs(inputs_source, io)
    interval_seconds = read_poll_interval(io)
    client = make_client(io)

    if template_only:
        return run_until_done(_print_template(client, source, pipe, io))
    return run_until_done(_run(client, source, pipe, inputs, interval_seconds, io, progress))


def _method_source(method: str) -> MethodSource:
    """The method `--method` names, a path being read from disk."""
    match classify_method(method):
        case AddressSelector(method_ref=method_ref):
            return AddressSource(method_ref=method_ref)
        case CatalogSelector(method_id=method_id):
            return CatalogSource(method_id=method_id)
        case PathSelector(path=path):
            return BundleSource(files=tuple(read_bundle(path)))


async def _print_template(client: PipelexAPIClient, source: MethodSource, pipe: str | None, io: CommandIO) -> int:
    """Print the pipe's inputs template, rendered by `mthds` from the descriptor one pipe I/O call returns."""
    async with client:
        described = await describe_pipe(client, source, pipe)
    template = render_inputs_template(descriptor=described.descriptor, explicit=False, output_format=InputsTemplateFormat.JSON)
    io.write_stdout(f"{template}\n")
    return EXIT_OK


async def _run(
    client: PipelexAPIClient,
    source: MethodSource,
    pipe: str | None,
    inputs: dict[str, Any] | None,
    interval_seconds: float | None,
    io: CommandIO,
    progress: Progress,
) -> int:
    """Prepare the inputs, run the method until it ends, and print its main output."""

    def on_started(ack: PipelexRunResultStart) -> None:
        progress.interrupt_message = f"Interrupted. Run {ack.pipeline_run_id} keeps going on the server."
        progress.waiting_on_run = ack.pipeline_run_id
        io.write_stderr(f"Run started: {ack.pipeline_run_id}\n")

    # A run takes as long as it takes: the command waits for it until it ends or the person interrupts.
    wait_options = (
        WaitForResultOptions(timeout_seconds=math.inf)
        if interval_seconds is None
        else WaitForResultOptions(interval_seconds=interval_seconds, timeout_seconds=math.inf)
    )
    selector = run_selector(source)
    async with client:
        prepared = await _prepare(client, source, pipe, inputs, io)
        await before_request()
        # Only once the start is under way: an interrupt that landed before it starts nothing, and
        # the command says no run was started.
        progress.interrupt_message = _STARTING
        results = await client.start_and_wait(
            pipe_code=pipe,
            mthds_contents=selector.mthds_contents,
            inputs=prepared,
            wait_options=wait_options,
            method_ref=selector.method_ref,
            method_id=selector.method_id,
            artifacts=[RunArtifact.MAIN_STUFF],
            on_started=on_started,
        )
    progress.waiting_on_run = None
    print_result(results.main_stuff, io)
    return EXIT_OK


async def _prepare(
    client: PipelexAPIClient,
    source: MethodSource,
    pipe: str | None,
    inputs: dict[str, Any] | None,
    io: CommandIO,
) -> dict[str, Any] | None:
    """Upload the local files the inputs name at the method's file inputs, through the SDK's input
    preparation, and report each upload on stderr. Inputs that are absent or empty are sent as they
    are, with no request: there is nothing to upload.
    """
    if not inputs:
        return inputs
    selector = crate_selector(source)
    await before_request()
    prepared = await client.prepare_inputs(
        files=selector.files,
        method_ref=selector.method_ref,
        method_id=selector.method_id,
        pipe_ref=pipe,
        inputs=inputs,
    )
    for upload in prepared.uploads:
        io.write_stderr(f"Uploaded {upload.filename} as {upload.uri}\n")
    return prepared.inputs
