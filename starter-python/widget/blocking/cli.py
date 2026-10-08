"""The blocking CLI — one request, one response, done.

The simplest way to run a method: `client.execute(...)` and you have the result.
Behind the hosted gateway a run longer than ~30s is cut off (run `generate-image`
to see it happen) — that is what `widget attended` and `widget detached` are for.

Copy-paste unit: this file + `widget/inputs.py` + `widget/errors.py` + `widget/usage.py` +
`widget/artifacts.py`. The
three mode packages never share lifecycle code, so the demo commands below are deliberate
mirrors of their `attended` / `detached` twins: only `execute_pipe()` differs.
"""

import asyncio
from pathlib import Path
from typing import Annotated, Any, Coroutine, TypeVar

import typer
from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.execute_result import results_from_execute
from pipelex_sdk.runs import RunResults
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

app = typer.Typer(no_args_is_help=True, help="Run a demo with a single blocking call (~30s cap on hosted).")

# Results go to stdout (pipeable); progress chatter goes to stderr.
output_console = Console()
progress_console = Console(stderr=True)


async def execute_pipe(
    *,
    pipe_code: str,
    inputs: dict[str, Any],
    mthds_contents: list[str] | None = None,
    method_id: str | None = None,
    method_ref: str | None = None,
) -> RunResults:
    """The whole blocking lifecycle: one call, and the result comes back in the response.

    Credentials come from `PIPELEX_API_KEY` / `PIPELEX_BASE_URL`. The method arrives as exactly
    one of three selectors, which is the SDK's own rule: inline `mthds_contents` (the bundle's
    `.mthds` files as strings — one entry for a single-file bundle, several for a multi-file
    one), a hosted catalog id (`method_id`), or a published address (`method_ref`). The demos
    below send the bundle they ship; a command written by `make add-method` sends the selector
    its `method.json` holds, and the SDK refuses a request carrying more than one.

    What comes back is a `RunResults`, the same object the durable modes hand back:
    `results_from_execute` lifts the blocking response onto it, so `.main_stuff` (the content the
    pipe named as its result — a completed run that names none raises `MissingMainStuffError`), the
    usage pair and the produced-file references all read the same whichever mode ran.
    """
    async with PipelexAPIClient() as client:
        with progress_console.status("Running…"):
            result = await client.execute(
                pipe_code=pipe_code,
                mthds_contents=mthds_contents,
                inputs=inputs,
                method_id=method_id,
                method_ref=method_ref,
            )
    return results_from_execute(result)


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
    results = _run(execute_pipe(pipe_code="extract_entities.extract_entities", mthds_contents=[bundle], inputs={"text": resolved.text}))
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
    results = _run(execute_pipe(pipe_code="summarize_pdf.summarize_pdf", mthds_contents=[bundle], inputs=inputs))
    summary = DocumentSummary.model_validate(results.main_stuff)
    output_console.print_json(data=summary.model_dump())
    print_cost_report(progress_console, results)


@app.command(name="generate-image")
def generate_image(
    prompt: Annotated[str | None, typer.Argument(help="The text prompt describing the image to generate.")] = None,
    file: Annotated[Path | None, typer.Option("--file", help="Read the prompt from a file instead of the argument.")] = None,
) -> None:
    """Generate an image from a text prompt — expected to hit the hosted ~30s cap.

    Image generation routinely outlives the blocking cap, so this command is here to
    fail: it is the teaching moment for `widget attended` / `widget detached`, which run
    the very same method durably.
    """
    resolved = read_text_input(text=prompt, file=file, sample=SAMPLE_IMAGE_PROMPT)
    if resolved.is_sample:
        progress_console.print(f"[dim]No prompt given — using the sample: {resolved.text!r}. Pass your own as an argument or via --file.[/dim]")
    bundle = (METHODS_DIR / "generate-image" / "main.mthds").read_text()
    results = _run(execute_pipe(pipe_code="generate_image.generate_image", mthds_contents=[bundle], inputs={"image_prompt": resolved.text}))
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
        raise typer.Exit(130) from exc


if __name__ == "__main__":
    app()
