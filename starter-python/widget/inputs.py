"""Build the inputs a pipe run is given — shared by every execution mode.

Input encoding is orthogonal to *how* a run is executed, so it lives here rather
than in one of the mode packages (`widget/blocking`, `widget/attended`,
`widget/detached`), which never share lifecycle code with each other.

Two shapes cover the demos:

- `read_text_input()` — a text argument, a `--file` pointing at one, or (when you
  give neither) a built-in sample, so every demo runs with zero arguments.
- `upload_document_input()` — a local file, uploaded to hosted Pipelex storage with
  `client.upload_file`, then wrapped in the `Document` envelope the API expects:
  `{"concept": "Document", "content": {"url": <pipelex-storage:// URI>, "filename":
  ..., "mime_type": ...}}`. A hosted run cannot see your filesystem, so the file is
  uploaded first and the run request carries only the URI, never the bytes. Preparation
  is deliberately a separate step from running: a file error surfaces before any run
  exists, and the uploaded asset is reusable across retries and modes. The pure
  `build_document_input(path, uri)` assembles the envelope once the URI is known.

The built-in samples let a fresh clone show a working result before you have any
input of your own; they are also the values the README documents.
"""

import mimetypes
from pathlib import Path
from typing import Any, NamedTuple

import typer
from pipelex_sdk.client import PipelexAPIClient

DEFAULT_MIME_TYPE = "application/octet-stream"

# Sample inputs — the zero-argument fallback for each demo (also the README's examples).
SAMPLE_ENTITIES_TEXT = "Alice from Acme met Bob on May 3rd, 2026."
SAMPLE_IMAGE_PROMPT = "a fox reading under a tree"
SAMPLE_INVOICE = Path(__file__).parent.parent / "samples" / "sample-invoice.pdf"


class TextInput(NamedTuple):
    """A resolved text input, plus whether it came from the built-in sample.

    The `is_sample` flag lets a command tell the user it filled in the input for
    them (so the result isn't mysterious) without the input helper owning a console.
    """

    text: str
    is_sample: bool


def read_text_input(*, text: str | None, file: Path | None, sample: str) -> TextInput:
    """Resolve the text to process: an argument, a `--file`, or the built-in `sample`.

    An explicit argument or `--file` wins; with neither, `sample` is used so the
    command runs with no arguments at all.

    Raises:
        typer.BadParameter: both an argument and `--file` were given, or `--file`
            does not point at a readable file.
    """
    if text is not None and file is not None:
        msg = "Give the text either as an argument or via --file, not both."
        raise typer.BadParameter(msg)
    if file is not None:
        if not file.is_file():
            msg = f"No such file: {file}"
            raise typer.BadParameter(msg)
        return TextInput(text=file.read_text(), is_sample=False)
    if text is not None:
        return TextInput(text=text, is_sample=False)
    return TextInput(text=sample, is_sample=True)


def build_document_input(path: Path, uri: str) -> dict[str, Any]:
    """Build the `Document` input envelope for an already-uploaded asset.

    `uri` is the `pipelex-storage://` reference `client.upload_file` returned for the file;
    the envelope carries that URI (not the bytes). The MIME type is guessed from the
    extension (falling back to `application/octet-stream`). Pure and offline — the upload
    itself happens in `upload_document_input`.
    """
    mime_type = mimetypes.guess_type(path.name)[0] or DEFAULT_MIME_TYPE
    return {
        "concept": "Document",
        "content": {"url": uri, "filename": path.name, "mime_type": mime_type},
    }


async def upload_document_input(path: Path) -> dict[str, Any]:
    """Upload a local document to hosted Pipelex storage and build its `Document` input envelope.

    A hosted run cannot read your filesystem, so a local file is uploaded first:
    `client.upload_file` stores it and returns a `pipelex-storage://` URI, which the envelope
    references — the run request never carries the file's bytes. Credentials come from
    `PIPELEX_API_KEY` / `PIPELEX_BASE_URL`.

    Upload is a hosted Pipelex capability; a deployment without it raises
    `UnsupportedUploadCapabilityError`, and an unreadable path raises `InvalidLocalSourceError`
    (both descend from `PipelineRequestError`, so the mode's `_run()` presents them cleanly).
    """
    async with PipelexAPIClient() as client:
        record = await client.upload_file(path)
    return build_document_input(path, record.uri)
