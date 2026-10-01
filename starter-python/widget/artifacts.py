"""Bring a run's produced files down to disk — shared by every execution mode.

A method that produces an image, a PDF or a document does not put the bytes in the result: the
output carries the file's durable `pipelex-storage://` reference, beside a `public_url` the storage
provider signed when the run wrote it. **That signed link is short-lived and must not be stored** —
it expires on the provider's schedule, while the reference beside it is permanent. Turning
references into files is the SDK's artifact stack, whose page is `docs/artifact-download.md` in
`pipelex-sdk`.

Downloading is orthogonal to *how* a run was executed, so this lives beside `widget/inputs.py`,
`widget/errors.py`, `widget/usage.py` and `widget/outputs.py` rather than in one of the mode packages,
which never share lifecycle code with each other.

Two layers of the stack are used, and the SDK owns both: `collect_artifacts` lists a result's
references without touching the network, which is how a text-only run costs nothing here, and
`download_artifacts` mints a fresh link for each reference and saves the files. It never reads the
embedded `public_url`, never overwrites a file, and answers a verdict naming every reference it
walked with errors as values — so a file that did not come down is reported, not raised.
"""

from pathlib import Path

from pipelex_sdk.artifact_models import DownloadArtifactsResult
from pipelex_sdk.artifacts import collect_artifacts
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.runs import RunResults
from rich.console import Console

#: Where a demo saves what a run produced, unless the command is given another directory.
DEFAULT_DOWNLOAD_DIR = Path("downloads")


async def download_produced_files(results: RunResults, *, dir_path: Path) -> DownloadArtifactsResult | None:
    """Save every file the run's main output references under `dir_path`.

    Returns `None` when the output references no file at all — the ordinary case for a text result.
    That question is answered offline by `collect_artifacts`, so nothing is requested and no
    directory is created for a run that produced nothing. The scope is the main output on purpose:
    `working_memory` would also bring down the inputs the run was given and every intermediate.
    """
    if not collect_artifacts(results.main_stuff):
        return None
    async with PipelexAPIClient() as client:
        return await client.download_artifacts(results=results, dir_path=dir_path)


def print_downloads(console: Console, downloaded: DownloadArtifactsResult | None) -> None:
    """Say where each produced file landed, and name any reference that did not come down."""
    if downloaded is None:
        return
    for artifact in downloaded.artifacts:
        if artifact.error is not None:
            console.print(f"[yellow]Could not save {artifact.uri} ({artifact.error.code}): {artifact.error.detail}[/yellow]")
        else:
            console.print(f"Saved [bold]{artifact.path}[/bold]")
