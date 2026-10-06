"""Bring a run's produced files down to disk, and say on stderr where they landed.

A method that produces an image, a PDF or a document does not put the bytes in the result: the
output carries the file's durable `pipelex-storage://` reference, beside a `public_url` the storage
provider signed when the run wrote it. That signed link is short-lived; the reference beside it is
permanent. Turning references into files is the SDK's artifact stack, whose page is
`docs/artifact-download.md` in `pipelex-sdk`.

The SDK owns every layer of the stack this module uses: `collect_artifacts` lists a result's
references without touching the network, which is how a text-only run costs nothing here, and
`download_artifacts` mints a fresh link for each reference and saves the files. It never reads the
embedded `public_url`, never overwrites a file, and answers a verdict naming every reference it
walked with errors as values, so a file that did not come down is reported, not raised.

The files go to `outputs/<run-id>/` under the working directory, or to the directory `--out` names,
and `--no-download` skips them. The default directory is worked out only once there is a file to
save, so a run id that could not name one never fails a text-only run.
"""

import re
from pathlib import Path

from pipelex_sdk.artifact_models import DownloadArtifactsResult
from pipelex_sdk.artifacts import collect_artifacts
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.runs import RunResults
from rich.console import Console
from rich.markup import escape

from pipelex_method_cli_python.lib.app import AppError

#: Where a run's files go, one directory per run, unless `--out` names another.
DEFAULT_OUTPUT_ROOT = Path("outputs")

#: A run id that can name a directory: one path segment, with no separator and no dot.
_SAFE_RUN_ID = re.compile(r"[A-Za-z0-9_-]+")


def default_download_dir(run_id: str) -> Path:
    """The directory a run's files go to when `--out` names none: `outputs/<run-id>/`.

    Raises:
        AppError: The run id could not name a single directory, so the default cannot be used.
    """
    if _SAFE_RUN_ID.fullmatch(run_id) is None:
        msg = f"The run id {run_id!r} cannot name a directory under {DEFAULT_OUTPUT_ROOT}/."
        raise AppError(msg, hint="Name the directory for its files with --out DIR.")
    return DEFAULT_OUTPUT_ROOT / run_id


async def download_produced_files(client: PipelexAPIClient, results: RunResults, *, out_dir: Path | None) -> DownloadArtifactsResult | None:
    """Save every file the run's main output references under `out_dir`, or `outputs/<run-id>/`.

    Returns `None` when the output references no file at all, the ordinary case for a text result.
    That question is answered offline by `collect_artifacts`, so nothing is requested, no directory
    is created and no default directory is named for a run that produced nothing. The scope is the
    main output on purpose: the working memory would also bring down the inputs the run was given
    and every intermediate.

    Raises:
        AppError: There is a file to save, `out_dir` is `None`, and the run id cannot name a directory.
    """
    if not collect_artifacts(results.main_stuff):
        return None
    dir_path = out_dir if out_dir is not None else default_download_dir(results.pipeline_run_id)
    return await client.download_artifacts(results=results, dir_path=dir_path)


def print_downloads(console: Console, downloaded: DownloadArtifactsResult | None) -> None:
    """Say where each produced file landed, and name any reference that did not come down."""
    if downloaded is None:
        return
    for artifact in downloaded.artifacts:
        if artifact.error is not None:
            console.print(f"[yellow]Could not save {escape(artifact.uri)} ({escape(artifact.error.code)}): {escape(artifact.error.detail)}[/yellow]")
        else:
            console.print(f"Saved [bold]{escape(str(artifact.path))}[/bold]")
