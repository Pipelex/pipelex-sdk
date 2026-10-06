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

A default directory that already holds files is left alone: only a second `--resume` of the same run
finds one, and since the SDK never overwrites, downloading again would save every file a second time
beside itself. Whether it holds the earlier download whole is read from evidence, never from a count
of its files, which a file cut short by a killed process or a second `--resume` still writing would
satisfy: a download that saved every file writes a manifest, `.pipelex-download.json`, atomically,
naming each reference with the file it went to and its size. A directory is complete only when that
manifest names every file the run produced and each is still there at its size; anything else is
reported as incomplete, with the way to fetch the files again. A directory holding nothing but
dotfiles, the `.DS_Store` a file browser leaves, is empty, and the files are downloaded into it.
"""

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from pipelex_sdk.artifact_models import DownloadArtifactsResult
from pipelex_sdk.artifacts import collect_artifacts
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.runs import RunResults
from rich.console import Console
from rich.markup import escape

from pipelex_method_cli_python.lib.app import AppError

#: Where a run's files go, one directory per run, unless `--out` names another.
DEFAULT_OUTPUT_ROOT = Path("outputs")

#: The manifest a complete download into a run's default directory leaves there.
MANIFEST_NAME = ".pipelex-download.json"

#: What the manifest records about itself, so that a file of another shape is never read as one.
MANIFEST_FORMAT = "pipelex-method-cli/download/1"

#: A run id that can name a directory: one path segment, with no separator and no dot.
_SAFE_RUN_ID = re.compile(r"[A-Za-z0-9_-]+")


@dataclass(frozen=True)
class EarlierDownload:
    """A run's default directory that already held files, so nothing was downloaded into it.

    `complete` is whether its manifest names every file the run produced, each still there at its
    recorded size; `detail` says what is wrong when it is not.
    """

    dir_path: Path
    complete: bool
    detail: str | None = None


def default_download_dir(run_id: str) -> Path:
    """The directory a run's files go to when `--out` names none: `outputs/<run-id>/`.

    Raises:
        AppError: The run id could not name a single directory, so the default cannot be used.
    """
    if _SAFE_RUN_ID.fullmatch(run_id) is None:
        msg = f"The run id {run_id!r} cannot name a directory under {DEFAULT_OUTPUT_ROOT}/."
        raise AppError(msg, hint="Name the directory for its files with --out DIR.")
    return DEFAULT_OUTPUT_ROOT / run_id


async def download_produced_files(
    client: PipelexAPIClient, results: RunResults, *, out_dir: Path | None
) -> DownloadArtifactsResult | EarlierDownload | None:
    """Save every file the run's main output references under `out_dir`, or `outputs/<run-id>/`.

    Returns `None` when the output references no file at all, the ordinary case for a text result.
    That question is answered offline by `collect_artifacts`, so nothing is requested, no directory
    is created and no default directory is named for a run that produced nothing. The scope is the
    main output on purpose: the working memory would also bring down the inputs the run was given
    and every intermediate. Returns an `EarlierDownload` when `out_dir` is `None` and the run's
    default directory already holds files, checked against its manifest, which a directory `--out`
    names is never checked for. A download into the default directory that saved every file leaves
    the manifest behind it.

    Raises:
        AppError: There is a file to save, `out_dir` is `None`, and the run id cannot name a
            directory, or its directory cannot be used: it, or a part of its path, is a file, or it
            cannot be read.
    """
    references = collect_artifacts(results.main_stuff)
    if not references:
        return None
    if out_dir is not None:
        return await client.download_artifacts(results=results, dir_path=out_dir)
    dir_path = default_download_dir(results.pipeline_run_id)
    entries = _listing(dir_path)
    if any(not name.startswith(".") for name in entries) or MANIFEST_NAME in entries:
        return earlier_download(dir_path, references)
    downloaded = await client.download_artifacts(results=results, dir_path=dir_path)
    if downloaded.all_saved and downloaded.saved_paths:
        write_manifest(dir_path, downloaded)
    return downloaded


def _listing(dir_path: Path) -> list[str]:
    """The names directly under `dir_path`, none when it does not exist.

    Raises:
        AppError: The path, or a part of it, is a file rather than a directory, or the directory
            cannot be read, none of which a download into it could fix.
    """
    hint = "Name a readable, writable directory for the run's files with --out DIR."
    try:
        mode = dir_path.stat().st_mode
    except FileNotFoundError:
        return []
    except NotADirectoryError as exc:
        msg = f"A part of {dir_path} is a file rather than a directory, so the run's files cannot be saved there."
        raise AppError(msg, hint=hint) from exc
    except OSError as exc:
        msg = f"{dir_path} cannot be read, so the CLI cannot tell what an earlier download left there."
        raise AppError(msg, hint=hint) from exc
    if not stat.S_ISDIR(mode):
        msg = f"{dir_path} exists and is not a directory, so the run's files cannot be saved there."
        raise AppError(msg, hint=hint)
    try:
        return [entry.name for entry in dir_path.iterdir()]
    except OSError as exc:
        msg = f"{dir_path} exists but cannot be read, so the CLI cannot tell what an earlier download left there."
        raise AppError(msg, hint=hint) from exc


def write_manifest(dir_path: Path, downloaded: DownloadArtifactsResult) -> None:
    """Record a complete download: each reference, the file it went to and its size, written atomically.

    The manifest is written to a temporary name and moved into place, so a process killed while
    writing it leaves no manifest rather than half of one. A manifest that cannot be written is left
    out rather than failing a run whose files all came down: without it, a later `--resume` only
    reports the download as not whole, which is the safe side.
    """
    temporary = dir_path / f"{MANIFEST_NAME}.tmp"
    try:
        files = [
            {"uri": artifact.uri, "path": Path(artifact.path).name, "size": Path(artifact.path).stat().st_size}
            for artifact in downloaded.artifacts
            if artifact.path is not None
        ]
        temporary.write_text(json.dumps({"format": MANIFEST_FORMAT, "files": files}, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, dir_path / MANIFEST_NAME)
    except OSError:
        temporary.unlink(missing_ok=True)


def earlier_download(dir_path: Path, references: list[str]) -> EarlierDownload:
    """Whether a default directory holds a run's earlier download whole, by its manifest."""
    manifest = dir_path / MANIFEST_NAME
    try:
        recorded: Any = json.loads(manifest.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return EarlierDownload(dir_path, complete=False, detail="it has no record of a download that finished")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return EarlierDownload(dir_path, complete=False, detail=f"its {MANIFEST_NAME} cannot be read")
    if not isinstance(recorded, dict) or cast("dict[str, Any]", recorded).get("format") != MANIFEST_FORMAT:
        return EarlierDownload(dir_path, complete=False, detail=f"its {MANIFEST_NAME} is not one this CLI wrote")
    entries = cast("dict[str, Any]", recorded).get("files")
    files = cast("list[Any]", entries) if isinstance(entries, list) else []
    sizes: dict[str, tuple[str, object]] = {}
    for entry in files:
        if isinstance(entry, dict):
            record = cast("dict[str, Any]", entry)
            sizes[str(record.get("uri"))] = (str(record.get("path")), record.get("size"))
    for reference in references:
        found = sizes.get(reference)
        if found is None:
            return EarlierDownload(dir_path, complete=False, detail=f"its record does not name {reference}")
        name, size = found
        if Path(name).name != name:
            return EarlierDownload(dir_path, complete=False, detail=f"{name} is missing")
        try:
            # One `stat` answers both questions, so a file removed between two calls is read as missing, never raised.
            status = (dir_path / name).stat()
        except OSError:
            return EarlierDownload(dir_path, complete=False, detail=f"{name} is missing")
        if not stat.S_ISREG(status.st_mode):
            return EarlierDownload(dir_path, complete=False, detail=f"{name} is missing")
        if status.st_size != size:
            return EarlierDownload(dir_path, complete=False, detail=f"{name} is not the size it was saved at")
    return EarlierDownload(dir_path, complete=True)


def print_downloads(console: Console, downloaded: DownloadArtifactsResult | EarlierDownload | None) -> None:
    """Say where each produced file landed, and name any reference that did not come down."""
    if downloaded is None:
        return
    if isinstance(downloaded, EarlierDownload):
        where = escape(str(downloaded.dir_path))
        if downloaded.complete:
            console.print(f"{where} already holds this run's files from an earlier download, so none were fetched.")
        else:
            why = escape(downloaded.detail or "it cannot be checked")
            console.print(f"[yellow]{where} holds an earlier download of this run that is not whole, since {why}, so none were fetched.[/yellow]")
        return
    for artifact in downloaded.artifacts:
        if artifact.error is not None:
            console.print(f"[yellow]Could not save {escape(artifact.uri)} ({escape(artifact.error.code)}): {escape(artifact.error.detail)}[/yellow]")
        else:
            console.print(f"Saved [bold]{escape(str(artifact.path))}[/bold]")
