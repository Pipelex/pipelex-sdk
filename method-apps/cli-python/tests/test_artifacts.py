"""`lib/artifacts.py`: bringing a run's produced files down to disk.

Nothing here touches the network, and the module's own short-circuit is what makes that honest for
a text result: `collect_artifacts` answers offline, so a run that produced nothing never asks the
client for anything. The download rules themselves (a fresh link per reference, never the expiring
`public_url`, a failed reference reported as a value) belong to `pipelex-sdk` and are tested there.
What is pinned here is this module's own half: when the client is called at all, with what, where
the files go by default, and how a verdict is rendered.
"""

import io
from pathlib import Path
from typing import cast

import pytest
from pipelex_sdk.artifact_models import ArtifactItemError, DownloadArtifactsResult, DownloadedArtifact
from pipelex_sdk.client import PipelexAPIClient
from rich.console import Console

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.artifacts import (
    DEFAULT_OUTPUT_ROOT,
    EarlierDownload,
    default_download_dir,
    download_produced_files,
    print_downloads,
)
from tests.support import IMAGE_OUTPUT, RUN_ID, TEXT_OUTPUT, TWO_FILES_OUTPUT, FakeClient, download_verdict, run_results

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _render(downloaded: DownloadArtifactsResult | EarlierDownload | None) -> str:
    buffer = io.StringIO()
    print_downloads(Console(file=buffer, width=200), downloaded)
    return buffer.getvalue()


def _as_client(fake: FakeClient) -> PipelexAPIClient:
    """The fake, typed as the client the function takes: it answers every method the function calls."""
    return cast("PipelexAPIClient", fake)


class TestDownloadProducedFiles:
    async def test_a_text_output_asks_the_client_for_nothing(self, tmp_path: Path):
        fake = FakeClient()
        downloaded = await download_produced_files(_as_client(fake), run_results(TEXT_OUTPUT), out_dir=tmp_path)
        assert downloaded is None
        assert fake.downloaded_to == []

    async def test_an_output_referencing_a_file_goes_through_the_client(self, tmp_path: Path):
        fake = FakeClient()
        saved = DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], path=str(tmp_path / "main_stuff.png"), size=3)
        fake.download_answer = download_verdict(saved)
        downloaded = await download_produced_files(_as_client(fake), run_results(IMAGE_OUTPUT), out_dir=tmp_path)
        assert isinstance(downloaded, DownloadArtifactsResult)
        assert downloaded.saved_paths == [str(tmp_path / "main_stuff.png")]
        assert fake.downloaded_to == [tmp_path]

    async def test_without_out_the_files_go_under_outputs_by_run_id(self):
        fake = FakeClient()
        await download_produced_files(_as_client(fake), run_results(IMAGE_OUTPUT), out_dir=None)
        assert fake.downloaded_to == [DEFAULT_OUTPUT_ROOT / RUN_ID]

    async def test_a_default_directory_that_already_holds_files_is_left_alone(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # Only a second --resume of the same run finds one; the SDK never overwrites, so a second
        # download would save every file again beside itself.
        monkeypatch.chdir(tmp_path)
        earlier = DEFAULT_OUTPUT_ROOT / RUN_ID
        earlier.mkdir(parents=True)
        (earlier / "main_stuff.png").write_bytes(b"png")
        fake = FakeClient()
        downloaded = await download_produced_files(_as_client(fake), run_results(IMAGE_OUTPUT), out_dir=None)
        assert downloaded == EarlierDownload(dir_path=earlier, expected=1, found=1)
        assert isinstance(downloaded, EarlierDownload) and downloaded.complete
        assert fake.downloaded_to == []

    async def test_an_earlier_download_left_short_is_counted_as_incomplete(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # An interrupted or partly failed download keeps the files it saved, and a file browser's
        # dotfile is no file the SDK saved.
        monkeypatch.chdir(tmp_path)
        earlier = DEFAULT_OUTPUT_ROOT / RUN_ID
        earlier.mkdir(parents=True)
        (earlier / "first.png").write_bytes(b"png")
        (earlier / ".DS_Store").write_bytes(b"")
        downloaded = await download_produced_files(_as_client(FakeClient()), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert downloaded == EarlierDownload(dir_path=earlier, expected=2, found=1)
        assert isinstance(downloaded, EarlierDownload) and not downloaded.complete

    async def test_a_directory_out_names_is_never_checked_for_earlier_files(self, tmp_path: Path):
        (tmp_path / "kept.txt").write_text("mine", encoding="utf-8")
        fake = FakeClient()
        await download_produced_files(_as_client(fake), run_results(IMAGE_OUTPUT), out_dir=tmp_path)
        assert fake.downloaded_to == [tmp_path]

    async def test_a_text_output_never_names_the_default_directory(self):
        # A run id that cannot name a directory matters only once there is a file to save.
        fake = FakeClient()
        assert await download_produced_files(_as_client(fake), run_results(TEXT_OUTPUT, run_id="run.1"), out_dir=None) is None


class TestDefaultDownloadDir:
    def test_a_run_gets_its_own_directory_under_outputs(self):
        assert default_download_dir("run-1") == DEFAULT_OUTPUT_ROOT / "run-1"

    @pytest.mark.parametrize("run_id", ["../escape", "a/b", ".", "..", ""])
    def test_a_run_id_that_is_not_one_path_segment_is_refused(self, run_id: str):
        with pytest.raises(AppError):
            default_download_dir(run_id)

    def test_the_default_output_root_is_gitignored(self):
        # It is relative, so it lands in whatever directory the command runs from, which is usually the
        # project's: an untracked outputs/ must not show up in `git status`.
        assert not DEFAULT_OUTPUT_ROOT.is_absolute()
        ignored = (PROJECT_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        assert f"{DEFAULT_OUTPUT_ROOT.name}/" in ignored


class TestPrintDownloads:
    def test_says_nothing_when_the_run_produced_no_file(self):
        assert _render(None) == ""

    def test_an_earlier_download_says_nothing_was_fetched(self):
        rendered = _render(EarlierDownload(dir_path=Path("outputs/run-1"), expected=2, found=2))
        assert "outputs/run-1 already holds this run's files from an earlier download" in rendered
        assert "none were fetched" in rendered

    def test_an_earlier_download_left_short_says_how_short(self):
        rendered = _render(EarlierDownload(dir_path=Path("outputs/run-1"), expected=2, found=1))
        assert "outputs/run-1 holds 1 of this run's 2 files" in rendered
        assert "stopped short" in rendered

    def test_names_each_saved_file(self):
        rendered = _render(download_verdict(DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], path="/tmp/out/cat.png", size=3)))
        assert "Saved /tmp/out/cat.png" in rendered

    def test_names_a_reference_that_did_not_come_down(self):
        failed = DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], error=ArtifactItemError(code="forbidden", detail="Not your run."))
        rendered = _render(download_verdict(failed))
        # The reference, the machine code and the sentence a person reads: a failed reference is
        # reported rather than raised, so the message is the only place it surfaces.
        assert IMAGE_OUTPUT["url"] in rendered
        assert "forbidden" in rendered
        assert "Not your run." in rendered

    def test_reports_both_arms_of_a_partial_download(self):
        saved = DownloadedArtifact(uri="pipelex-storage://run-1/ok.png", found_at=["$[0].url"], path="/tmp/out/ok.png", size=3)
        failed = DownloadedArtifact(
            uri="pipelex-storage://run-1/bad.png", found_at=["$[1].url"], error=ArtifactItemError(code="write_failed", detail="Disk full.")
        )
        rendered = _render(download_verdict(saved, failed))
        assert "/tmp/out/ok.png" in rendered
        assert "Disk full." in rendered
