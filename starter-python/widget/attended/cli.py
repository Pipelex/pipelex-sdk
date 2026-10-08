"""The attended CLI — start a durable run, then wait here for its result.

`client.start(...)` submits the run server-side (it survives anything, including
the ~30s cap that kills `widget blocking`), and `client.wait_for_result(...)` polls
it to completion from this terminal. The run id is printed *before* polling starts,
so once you see it, a Ctrl-C doesn't lose the run: it keeps executing server-side and
you resume it with `widget detached wait <id>`. (A Ctrl-C while the start request is
still in flight is the one window with no id to resume from.)

The SDK also offers `start_and_wait()`, a self-healing one-liner that picks the
right path by itself — that is the production shortcut. This starter spells the
lifecycle out because teaching the difference is the point.

Copy-paste unit: this file + `widget/inputs.py` + `widget/errors.py` + `widget/usage.py` +
`widget/artifacts.py`. The
three mode packages never share lifecycle code, so the demo commands below are deliberate
mirrors of their `blocking` / `detached` twins: only `start_and_wait()` differs.
"""

import asyncio
from pathlib import Path
from typing import Annotated, Any, Coroutine, TypeVar

import typer
from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.runs import PollInfo, RunResults, WaitForResultOptions
from rich.console import Console

# add-method:imports — `make add-method` inserts a scaffolded method's generated-model import
# into the block below, in sorted position. Keep the token; the prose after it is free.
from widget.artifacts import DEFAULT_DOWNLOAD_DIR, download_produced_files, print_downloads
from widget.errors import present_error, print_error
from widget.generated.extract_entities.models import ExtractedEntities
from widget.generated.generate_image.models import Image
from widget.generated.summarize_pdf.models import DocumentSummary
from widget.inputs import SAMPLE_ENTITIES_TEXT, SAMPLE_IMAGE_PROMPT, SAMPLE_INVOICE, read_text_input, upload_document_input
from widget.usage import print_cost_report

ResultT = TypeVar("ResultT")

METHODS_DIR = Path(__file__).parent.parent / "methods"

app = typer.Typer(no_args_is_help=True, help="Run a demo as a durable run and wait here for the result.")

# Results go to stdout (pipeable); progress chatter goes to stderr.
output_console = Console()
progress_console = Console(stderr=True)


async def start_and_wait(
    *,
    pipe_code: str,
    inputs: dict[str, Any],
    mthds_contents: list[str] | None = None,
    method_id: str | None = None,
    method_ref: str | None = None,
) -> RunResults:
    """The whole attended lifecycle: start a durable run, print its id, wait here for the result.

    Credentials come from `PIPELEX_API_KEY` / `PIPELEX_BASE_URL`. The method arrives as exactly
    one of three selectors, which is the SDK's own rule: inline `mthds_contents` (the bundle's
    `.mthds` files as strings — one entry for a single-file bundle, several for a multi-file
    one), a hosted catalog id (`method_id`), or a published address (`method_ref`). The demos
    below send the bundle they ship; a command written by `make add-method` sends the selector
    its `method.json` holds, and the SDK refuses a request carrying more than one.

    What comes back is the run's whole `RunResults`: `.main_stuff` is the content the pipe named as
    its result (a completed run that names none raises `MissingMainStuffError`), and beside it are
    the usage pair the command prints as a cost report and the references to whatever files the run
    produced. The blocking mode hands back the same object, so a command reads the same in either.
    """
    async with PipelexAPIClient() as client:
        start_result = await client.start(
            pipe_code=pipe_code,
            mthds_contents=mthds_contents,
            inputs=inputs,
            method_id=method_id,
            method_ref=method_ref,
        )
        run_id = start_result.pipeline_run_id
        # Printed before the first poll, so Ctrl-C leaves you with a usable run id.
        progress_console.print(f"Run started: [bold]{run_id}[/bold]")
        short_id = run_id[:8]
        with progress_console.status(f"Run {short_id}… in progress") as status:

            def on_poll(info: PollInfo) -> None:
                status.update(f"Run {short_id}… in progress — {info.elapsed_seconds:.0f}s, poll #{info.attempt}")

            try:
                results = await client.wait_for_result(run_id, options=WaitForResultOptions(on_poll=on_poll))
            except asyncio.CancelledError:
                # Ctrl-C: the run keeps executing server-side — it has just become a detached run.
                progress_console.print(f"\nInterrupted — the run is still executing. Resume with: [bold]widget detached wait {run_id}[/bold]")
                raise
    return results


@app.command(name="extract-entities")
def extract_entities(
    text: Annotated[str | None, typer.Argument(help="The text to extract entities from.")] = None,
    file: Annotated[Path | None, typer.Option("--file", help="Read the input text from a file instead of the argument.")] = None,
) -> None:
    """Extract people, organizations, and dates from a piece of text."""
    resolved = read_text_input(text=text, file=file, sample=SAMPLE_ENTITIES_TEXT)
    if resolved.is_sample:
        progress_console.print(f"[dim]No text given — using the sample: {resolved.text!r}. Pass your own as an argument or via --file.[/dim]")
    bundle = (METHODS_DIR / "extract-entities" / "main.mthds").read_text()
    results = _run(start_and_wait(pipe_code="extract_entities.extract_entities", mthds_contents=[bundle], inputs={"text": resolved.text}))
    # Narrow into the generated typed model (validates the concept's shape), then print it as JSON.
    entities = ExtractedEntities.model_validate(results.main_stuff)
    output_console.print_json(data=entities.model_dump())
    print_cost_report(progress_console, results)


@app.command(name="summarize-pdf")
def summarize_pdf(
    file: Annotated[Path | None, typer.Argument(help="Path to the PDF (or other document) to summarize.")] = None,
) -> None:
    """Summarize a document into a title, type, and key points."""
    document = file or SAMPLE_INVOICE
    if not document.is_file():
        msg = f"No such file: {document}"
        raise typer.BadParameter(msg)
    if file is None:
        progress_console.print(f"[dim]No file given — using the sample: {document.name}. Pass a path to summarize your own document.[/dim]")
    bundle = (METHODS_DIR / "summarize-pdf" / "main.mthds").read_text()
    # Upload the file first (a separate step from the run) — the run request carries only its URI.
    inputs = {"document": _run(upload_document_input(document))}
    results = _run(start_and_wait(pipe_code="summarize_pdf.summarize_pdf", mthds_contents=[bundle], inputs=inputs))
    summary = DocumentSummary.model_validate(results.main_stuff)
    output_console.print_json(data=summary.model_dump())
    print_cost_report(progress_console, results)


@app.command(name="generate-image")
def generate_image(
    prompt: Annotated[str | None, typer.Argument(help="The text prompt describing the image to generate.")] = None,
    file: Annotated[Path | None, typer.Option("--file", help="Read the prompt from a file instead of the argument.")] = None,
) -> None:
    """Generate an image from a text prompt.

    The same method `widget blocking generate-image` cannot finish: image generation
    routinely outlives the hosted ~30s cap. Run durably, it just takes as long as it
    takes.
    """
    resolved = read_text_input(text=prompt, file=file, sample=SAMPLE_IMAGE_PROMPT)
    if resolved.is_sample:
        progress_console.print(f"[dim]No prompt given — using the sample: {resolved.text!r}. Pass your own as an argument or via --file.[/dim]")
    bundle = (METHODS_DIR / "generate-image" / "main.mthds").read_text()
    results = _run(start_and_wait(pipe_code="generate_image.generate_image", mthds_contents=[bundle], inputs={"image_prompt": resolved.text}))
    # On the hosted path the runtime returns a storage `url` (`pipelex-storage://…`)
    # *and* a web-renderable `public_url` (a signed URL); the model keeps both.
    image = Image.model_validate(results.main_stuff)
    output_console.print_json(data=image.model_dump())
    # The result names the produced file; the bytes come down through the SDK's artifact stack,
    # which mints a fresh link rather than reading the expiring `public_url` printed above.
    print_downloads(progress_console, _run(download_produced_files(results, dir_path=DEFAULT_DOWNLOAD_DIR)))
    print_cost_report(progress_console, results)


# add-method:commands — `make add-method` inserts a scaffolded method's command directly above
# this line. Keep the token; the prose after it is free.


def _run(coro: Coroutine[Any, Any, ResultT]) -> ResultT:
    """Await the lifecycle, presenting SDK errors and Ctrl-C as clean exits.

    The SDK's typed errors descend from `PipelineRequestError`: a non-2xx answer from any
    route (`ApiResponseError`), and a request that got no answer at all, a connection that
    failed or a time limit that ran out, on any route `execute` and `start` included
    (`ApiUnreachableError`). Nothing else is caught here, so any other exception crashes
    with its traceback.
    """
    try:
        return asyncio.run(coro)
    except PipelineRequestError as exc:
        print_error(progress_console, present_error(exc))
        raise typer.Exit(1) from exc
    except KeyboardInterrupt as exc:
        # The resume hint was already printed by `start_and_wait`; the run keeps executing server-side.
        raise typer.Exit(130) from exc


if __name__ == "__main__":
    app()
