"""The detached CLI — start a durable run and walk away; collect it later.

`client.start(...)` submits the run server-side and this command exits with the run
id on stdout, so it pipes: `RUN_ID=$(widget detached generate-image "a fox")`. All the
run's state lives behind that id, so you pick it back up whenever you like — even
from another terminal, another machine, another day:

- `widget detached wait <id>`   — poll it to completion and print its result.
- `widget detached status <id>` — where is it right now, without waiting, and why it failed if it did.
- `widget detached result <id>` — its result if it is done, without waiting.

Same durable run as `widget attended`; the only difference is who waits.

Copy-paste unit: this file + `widget/inputs.py` + `widget/errors.py` + `widget/usage.py` +
`widget/artifacts.py`. The
three mode packages never share lifecycle code, so the demo commands below are deliberate
mirrors of their `blocking` / `attended` twins: only `start_pipe()` differs — plus
the run-lifecycle commands, which exist only here.
"""

import asyncio
from pathlib import Path
from typing import Annotated, Any, Coroutine, TypeVar

import typer
from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.runs import (
    PollInfo,
    RunRead,
    RunResultCompleted,
    RunResultFailed,
    RunResultRunning,
    RunResults,
    RunResultState,
    WaitForResultOptions,
)
from rich.console import Console
from rich.markup import escape

# add-method:imports — `make add-method` inserts a scaffolded method's generated-model import
# into the block below, in sorted position. Keep the token; the prose after it is free.
from widget.artifacts import DEFAULT_DOWNLOAD_DIR, download_produced_files, print_downloads
from widget.errors import present_error, present_failed_run, print_error
from widget.inputs import SAMPLE_ENTITIES_TEXT, SAMPLE_IMAGE_PROMPT, SAMPLE_INVOICE, read_text_input, upload_document_input
from widget.usage import print_cost_report

ResultT = TypeVar("ResultT")

METHODS_DIR = Path(__file__).parent.parent / "methods"

app = typer.Typer(no_args_is_help=True, help="Start a demo as a durable run and exit; collect the result later.")

# Results go to stdout (pipeable); progress chatter goes to stderr.
output_console = Console()
progress_console = Console(stderr=True)


async def start_pipe(
    *,
    pipe_code: str,
    inputs: dict[str, Any],
    mthds_contents: list[str] | None = None,
    method_id: str | None = None,
    method_ref: str | None = None,
) -> str:
    """The whole detached lifecycle: start a durable run, return its id, don't wait.

    Credentials come from `PIPELEX_API_KEY` / `PIPELEX_BASE_URL`. The method arrives as exactly
    one of three selectors, which is the SDK's own rule: inline `mthds_contents` (the bundle's
    `.mthds` files as strings — one entry for a single-file bundle, several for a multi-file
    one), a hosted catalog id (`method_id`), or a published address (`method_ref`). The demos
    below send the bundle they ship; a command written by `make add-method` sends the selector
    its `method.json` holds, and the SDK refuses a request carrying more than one.

    The run keeps executing server-side after this process exits.
    """
    async with PipelexAPIClient() as client:
        start_result = await client.start(
            pipe_code=pipe_code,
            mthds_contents=mthds_contents,
            inputs=inputs,
            method_id=method_id,
            method_ref=method_ref,
        )
    return start_result.pipeline_run_id


async def attend_run(run_id: str) -> RunResults:
    """Poll an already-started run to completion and hand back its whole `RunResults`."""
    async with PipelexAPIClient() as client:
        short_id = run_id[:8]
        with progress_console.status(f"Run {short_id}… in progress") as status:

            def on_poll(info: PollInfo) -> None:
                status.update(f"Run {short_id}… in progress — {info.elapsed_seconds:.0f}s, poll #{info.attempt}")

            try:
                results = await client.wait_for_result(run_id, options=WaitForResultOptions(on_poll=on_poll))
            except asyncio.CancelledError:
                # Ctrl-C: the run keeps executing server-side — nothing is lost, just wait on it again.
                progress_console.print(f"\nInterrupted — the run is still executing. Resume with: [bold]widget detached wait {run_id}[/bold]")
                raise
    return results


async def fetch_run_status(run_id: str) -> RunRead:
    """Fetch a run's coarse status (`GET /v1/runs/{id}/status`) — no polling."""
    async with PipelexAPIClient() as client:
        return await client.get_run_status(run_id)


async def fetch_run_result(run_id: str) -> RunResultState:
    """Fetch a run's result state (`GET /v1/runs/{id}/results`) — no polling."""
    async with PipelexAPIClient() as client:
        return await client.get_run_result(run_id)


@app.command(name="extract-entities")
def extract_entities(
    text: Annotated[str | None, typer.Argument(help="The text to extract entities from.")] = None,
    file: Annotated[Path | None, typer.Option("--file", help="Read the input text from a file instead of the argument.")] = None,
) -> None:
    """Start extracting people, organizations, and dates from a piece of text."""
    resolved = read_text_input(text=text, file=file, sample=SAMPLE_ENTITIES_TEXT)
    if resolved.is_sample:
        progress_console.print(f"[dim]No text given — using the sample: {resolved.text!r}. Pass your own as an argument or via --file.[/dim]")
    bundle = (METHODS_DIR / "extract-entities" / "main.mthds").read_text()
    run_id = _run(start_pipe(pipe_code="extract_entities.extract_entities", mthds_contents=[bundle], inputs={"text": resolved.text}))
    _print_run_id(run_id)


@app.command(name="summarize-pdf")
def summarize_pdf(
    file: Annotated[Path | None, typer.Argument(help="Path to the PDF (or other document) to summarize.")] = None,
) -> None:
    """Start summarizing a document into a title, type, and key points."""
    document = file or SAMPLE_INVOICE
    if not document.is_file():
        msg = f"No such file: {document}"
        raise typer.BadParameter(msg)
    if file is None:
        progress_console.print(f"[dim]No file given — using the sample: {document.name}. Pass a path to summarize your own document.[/dim]")
    bundle = (METHODS_DIR / "summarize-pdf" / "main.mthds").read_text()
    # Upload the file first (a separate step from the run) — the run request carries only its URI.
    inputs = {"document": _run(upload_document_input(document))}
    run_id = _run(start_pipe(pipe_code="summarize_pdf.summarize_pdf", mthds_contents=[bundle], inputs=inputs))
    _print_run_id(run_id)


@app.command(name="generate-image")
def generate_image(
    prompt: Annotated[str | None, typer.Argument(help="The text prompt describing the image to generate.")] = None,
    file: Annotated[Path | None, typer.Option("--file", help="Read the prompt from a file instead of the argument.")] = None,
) -> None:
    """Start generating an image from a text prompt.

    The demo that makes detached mode obvious: image generation is slow enough that
    you would rather not hold a terminal open for it.
    """
    resolved = read_text_input(text=prompt, file=file, sample=SAMPLE_IMAGE_PROMPT)
    if resolved.is_sample:
        progress_console.print(f"[dim]No prompt given — using the sample: {resolved.text!r}. Pass your own as an argument or via --file.[/dim]")
    bundle = (METHODS_DIR / "generate-image" / "main.mthds").read_text()
    run_id = _run(start_pipe(pipe_code="generate_image.generate_image", mthds_contents=[bundle], inputs={"image_prompt": resolved.text}))
    _print_run_id(run_id)


@app.command(name="wait")
def wait(
    run_id: Annotated[str, typer.Argument(help="The pipeline run id printed when the run started.")],
) -> None:
    """Poll a run to completion, then print its result."""
    results = _run(attend_run(run_id))
    _print_results(results)


@app.command(name="status")
def status(run_id: Annotated[str, typer.Argument(help="The pipeline run id printed when the run started.")]) -> None:
    """Show a run's coarse status without waiting — and, for a run that ended without a result, why."""
    run = _run(fetch_run_status(run_id))
    pipe_part = f" (pipe: {run.pipe_code})" if run.pipe_code else ""
    output_console.print(f"{run.pipeline_run_id}: [bold]{run.status}[/bold]{escape(pipe_part)}")
    if run.degraded:
        output_console.print("[yellow]Status is degraded — last-known value, the status backend was unreachable; retry shortly.[/yellow]")
    if run.status.is_terminal and not run.status.is_success:
        # The status read carries the run's stored error report, read out as a failed `wait` reads it.
        # The reason is part of the answer (stdout); the hint, for a run that recorded none, is chatter (stderr).
        failure = present_failed_run(run_id=run.pipeline_run_id, status=run.status, report=run.error, platform_message=None)
        for line in failure.details or ("No reason was recorded for this run.",):
            output_console.print(escape(line))
        if failure.hint:
            progress_console.print(f"[yellow]Hint:[/yellow] {escape(failure.hint)}")


@app.command(name="result")
def result(
    run_id: Annotated[str, typer.Argument(help="The pipeline run id printed when the run started.")],
) -> None:
    """Fetch a run's result if it is finished (no waiting)."""
    state = _run(fetch_run_result(run_id))
    match state:
        case RunResultRunning():
            # The command goes in a local so the message line keeps headroom: a
            # bootstrapped project's name is longer than the placeholder, and inline
            # this was the one line in the package that crossed ruff's 150.
            resume = f"[bold]widget detached wait {state.pipeline_run_id}[/bold]"
            progress_console.print(f"Run {state.pipeline_run_id} is still running — wait for it with: {resume}")
        case RunResultCompleted():
            _print_results(state.result)
        case RunResultFailed():
            # The failed arm carries what `RunFailedError` carries, so it reads exactly as a failed `wait` does.
            print_error(
                progress_console,
                present_failed_run(run_id=state.pipeline_run_id, status=state.status, report=state.error, platform_message=state.message),
            )
            raise typer.Exit(1)


def _print_run_id(run_id: str) -> None:
    """The id on stdout (bare, so `$(widget detached …)` captures it), the hint on stderr."""
    print(run_id)
    progress_console.print(f"Run started — fetch it later with: [bold]widget detached wait {run_id}[/bold]")


def _print_results(results: RunResults) -> None:
    """Render a completed run: its main output as raw JSON, its produced files, its cost report.

    Deliberately generic — any run id can land here, so there is no per-demo model narrowing, and a
    run that produced no file downloads nothing. `wait` and `result` share it so the two render a
    finished run identically and a script can use either.
    """
    output_console.print_json(data=results.main_stuff)
    print_downloads(progress_console, _run(download_produced_files(results, dir_path=DEFAULT_DOWNLOAD_DIR)))
    print_cost_report(progress_console, results)


# add-method:commands — `make add-method` inserts a scaffolded method's command directly above
# this line. Keep the token; the prose after it is free.


def _run(coro: Coroutine[Any, Any, ResultT]) -> ResultT:
    """Await the lifecycle, presenting SDK errors and Ctrl-C as clean exits.

    The SDK's typed errors descend from `PipelineRequestError`, a non-2xx answer from any
    route included (`ApiResponseError`). A connection that fails on `execute` or `start` is
    the exception: the SDK lets httpx's own transport error through from those two routes,
    so it crashes with its traceback like any unexpected exception, since nothing else is
    caught here.
    """
    try:
        return asyncio.run(coro)
    except PipelineRequestError as exc:
        print_error(progress_console, present_error(exc))
        raise typer.Exit(1) from exc
    except KeyboardInterrupt as exc:
        # The resume hint was already printed by `attend_run`; the run keeps executing server-side.
        raise typer.Exit(130) from exc


if __name__ == "__main__":
    app()
