"""`lib/artifacts.py`: bringing a run's produced files down to disk.

Nothing here touches the network, and the module's own short-circuit is what makes that honest for
a text result: `collect_artifacts` answers offline, so a run that produced nothing never asks the
client for anything. The download rules themselves (a fresh link per reference, never the expiring
`public_url`, a failed reference reported as a value) belong to `pipelex-sdk` and are tested there.
What is pinned here is this module's own half: when the client is called at all, with what, where
the files go by default, and how a verdict is rendered.
"""

import errno
import io
import json
import os
from pathlib import Path
from typing import Any, NoReturn, cast

import pytest
from pipelex_sdk.artifact_models import ArtifactItemError, DownloadArtifactsResult, DownloadedArtifact
from pipelex_sdk.client import PipelexAPIClient
from rich.console import Console

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.artifacts import (
    DEFAULT_OUTPUT_ROOT,
    MANIFEST_FORMAT,
    MANIFEST_NAME,
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

    async def test_without_out_the_files_go_under_outputs_by_run_id(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.chdir(tmp_path)
        fake = FakeClient()
        await download_produced_files(_as_client(fake), run_results(IMAGE_OUTPUT), out_dir=None)
        assert fake.downloaded_to == [DEFAULT_OUTPUT_ROOT / RUN_ID]


class TestCompletionEvidence:
    """Whether a run's default directory holds an earlier download whole is read from its manifest, never from a count."""

    async def _first_download(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, FakeClient]:
        monkeypatch.chdir(tmp_path)
        earlier = DEFAULT_OUTPUT_ROOT / RUN_ID
        fake = FakeClient()
        fake.download_answer = download_verdict(
            DownloadedArtifact(uri=TWO_FILES_OUTPUT["first"]["url"], found_at=["$.first.url"], path=str(earlier / "first.png"), size=3),
            DownloadedArtifact(uri=TWO_FILES_OUTPUT["second"]["url"], found_at=["$.second.url"], path=str(earlier / "second.png"), size=5),
        )
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert isinstance(downloaded, DownloadArtifactsResult) and downloaded.all_saved
        return earlier, fake

    async def test_a_complete_download_leaves_a_manifest_of_each_file_and_its_size(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        earlier, _ = await self._first_download(tmp_path, monkeypatch)
        manifest = json.loads((earlier / MANIFEST_NAME).read_text(encoding="utf-8"))
        assert manifest == {
            "format": MANIFEST_FORMAT,
            "files": [
                {"uri": TWO_FILES_OUTPUT["first"]["url"], "path": "first.png", "size": 3},
                {"uri": TWO_FILES_OUTPUT["second"]["url"], "path": "second.png", "size": 5},
            ],
        }
        # Written to a temporary name and moved into place: nothing of the move is left behind.
        assert sorted(entry.name for entry in earlier.iterdir()) == [MANIFEST_NAME, "first.png", "second.png"]

    async def test_a_second_resume_finds_the_download_whole_and_fetches_nothing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        earlier, fake = await self._first_download(tmp_path, monkeypatch)
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert downloaded == EarlierDownload(dir_path=earlier, complete=True)
        assert fake.downloaded_to == [earlier]

    async def test_a_file_cut_short_after_the_download_is_incomplete(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # As a process killed mid-stream leaves it, or a second --resume still writing: the count is right, the size is not.
        earlier, fake = await self._first_download(tmp_path, monkeypatch)
        (earlier / "second.png").write_bytes(b"x")
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert isinstance(downloaded, EarlierDownload) and not downloaded.complete
        assert downloaded.detail == "second.png is not the size it was saved at"

    async def test_a_file_gone_since_the_download_is_incomplete(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        earlier, fake = await self._first_download(tmp_path, monkeypatch)
        (earlier / "first.png").unlink()
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert isinstance(downloaded, EarlierDownload) and downloaded.detail == "first.png is missing"

    async def test_files_with_no_manifest_are_a_download_that_never_finished(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # Every file there, at whatever size, and still not whole: nothing says the download ended.
        monkeypatch.chdir(tmp_path)
        earlier = DEFAULT_OUTPUT_ROOT / RUN_ID
        earlier.mkdir(parents=True)
        (earlier / "first.png").write_bytes(b"png")
        (earlier / "second.png").write_bytes(b"png")
        fake = FakeClient()
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert downloaded == EarlierDownload(dir_path=earlier, complete=False, detail="it has no record of a download that finished")
        assert fake.downloaded_to == []

    async def test_a_manifest_that_does_not_name_a_produced_file_is_incomplete(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        earlier, fake = await self._first_download(tmp_path, monkeypatch)
        manifest = json.loads((earlier / MANIFEST_NAME).read_text(encoding="utf-8"))
        manifest["files"] = manifest["files"][:1]
        (earlier / MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert isinstance(downloaded, EarlierDownload) and downloaded.detail == f"its record does not name {TWO_FILES_OUTPUT['second']['url']}"

    @pytest.mark.parametrize("content", ["{not json", '{"format": "something else", "files": []}', "[]"])
    async def test_a_manifest_this_cli_did_not_write_is_incomplete(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: str):
        earlier, fake = await self._first_download(tmp_path, monkeypatch)
        (earlier / MANIFEST_NAME).write_text(content, encoding="utf-8")
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert isinstance(downloaded, EarlierDownload) and not downloaded.complete

    async def test_a_manifest_that_cannot_be_written_never_fails_the_download(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        def refused(source: object, target: object) -> None:
            del source, target
            raise OSError(28, "No space left on device")

        monkeypatch.setattr(os, "replace", refused)
        earlier, _ = await self._first_download(tmp_path, monkeypatch)
        assert sorted(entry.name for entry in earlier.iterdir()) == ["first.png", "second.png"]

    async def test_a_partial_download_leaves_no_manifest(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.chdir(tmp_path)
        earlier = DEFAULT_OUTPUT_ROOT / RUN_ID
        fake = FakeClient()
        fake.download_answer = download_verdict(
            DownloadedArtifact(uri=TWO_FILES_OUTPUT["first"]["url"], found_at=["$.first.url"], path=str(earlier / "first.png"), size=3),
            DownloadedArtifact(
                uri=TWO_FILES_OUTPUT["second"]["url"], found_at=["$.second.url"], error=ArtifactItemError(code="gone", detail="Gone.")
            ),
        )
        await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert not (earlier / MANIFEST_NAME).exists()

    async def test_a_directory_holding_only_dotfiles_is_downloaded_into(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # A file browser's .DS_Store is not an earlier download.
        monkeypatch.chdir(tmp_path)
        earlier = DEFAULT_OUTPUT_ROOT / RUN_ID
        earlier.mkdir(parents=True)
        (earlier / ".DS_Store").write_bytes(b"")
        fake = FakeClient()
        await download_produced_files(_as_client(fake), run_results(IMAGE_OUTPUT), out_dir=None)
        assert fake.downloaded_to == [earlier]

    @pytest.mark.skipif(os.name != "posix" or os.geteuid() == 0, reason="needs POSIX permissions that bind the user running the tests")
    async def test_an_unreadable_directory_is_refused_naming_out(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.chdir(tmp_path)
        earlier = DEFAULT_OUTPUT_ROOT / RUN_ID
        earlier.mkdir(parents=True)
        earlier.chmod(0o000)
        try:
            with pytest.raises(AppError, match="cannot be read") as caught:
                await download_produced_files(_as_client(FakeClient()), run_results(IMAGE_OUTPUT), out_dir=None)
        finally:
            earlier.chmod(0o755)
        assert caught.value.hint == "Name a readable, writable directory for the run's files with --out DIR."

    async def test_a_directory_that_fails_to_list_is_refused_naming_out(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        def failing(self: Path) -> NoReturn:
            raise OSError(errno.EIO, "Input/output error", str(self))

        monkeypatch.chdir(tmp_path)
        (DEFAULT_OUTPUT_ROOT / RUN_ID).mkdir(parents=True)
        monkeypatch.setattr(Path, "iterdir", failing)
        with pytest.raises(AppError, match="cannot be read") as caught:
            await download_produced_files(_as_client(FakeClient()), run_results(IMAGE_OUTPUT), out_dir=None)
        assert caught.value.hint == "Name a readable, writable directory for the run's files with --out DIR."

    @pytest.mark.parametrize(
        ("file_at", "says"),
        [
            pytest.param(DEFAULT_OUTPUT_ROOT / RUN_ID, "exists and is not a directory", id="the run's directory"),
            pytest.param(DEFAULT_OUTPUT_ROOT, "is a file rather than a directory", id="the output root"),
        ],
    )
    async def test_a_file_where_the_directory_should_be_is_refused_naming_out(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, file_at: Path, says: str
    ):
        monkeypatch.chdir(tmp_path)
        file_at.parent.mkdir(parents=True, exist_ok=True)
        file_at.write_text("not a directory", encoding="utf-8")
        fake = FakeClient()
        with pytest.raises(AppError, match=says) as caught:
            await download_produced_files(_as_client(fake), run_results(IMAGE_OUTPUT), out_dir=None)
        assert caught.value.hint == "Name a readable, writable directory for the run's files with --out DIR."
        assert fake.downloaded_to == []

    async def test_a_file_gone_while_it_is_checked_is_missing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # Removed by a concurrent cleanup after any earlier look found it: read as missing, never raised.
        earlier, fake = await self._first_download(tmp_path, monkeypatch)
        real_stat = Path.stat
        real_is_file = Path.is_file

        def vanishing(self: Path, *, follow_symlinks: bool = True) -> os.stat_result:
            if self.name == "first.png":
                raise FileNotFoundError(errno.ENOENT, "No such file or directory", str(self))
            return real_stat(self, follow_symlinks=follow_symlinks)

        def seen_a_moment_ago(self: Path, **kwargs: Any) -> bool:
            # Its keywords passed as they came: `follow_symlinks` exists only from Python 3.13.
            return self.name == "first.png" or real_is_file(self, **kwargs)

        monkeypatch.setattr(Path, "stat", vanishing)
        monkeypatch.setattr(Path, "is_file", seen_a_moment_ago)
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert downloaded == EarlierDownload(dir_path=earlier, complete=False, detail="first.png is missing")

    async def test_a_directory_where_a_file_was_saved_is_missing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        earlier, fake = await self._first_download(tmp_path, monkeypatch)
        (earlier / "first.png").unlink()
        (earlier / "first.png").mkdir()
        downloaded = await download_produced_files(_as_client(fake), run_results(TWO_FILES_OUTPUT), out_dir=None)
        assert isinstance(downloaded, EarlierDownload) and downloaded.detail == "first.png is missing"


class TestOtherDirectories:
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
        rendered = _render(EarlierDownload(dir_path=Path("outputs/run-1"), complete=True))
        assert "outputs/run-1 already holds this run's files from an earlier download" in rendered
        assert "none were fetched" in rendered

    def test_an_earlier_download_not_whole_says_why(self):
        rendered = _render(EarlierDownload(dir_path=Path("outputs/run-1"), complete=False, detail="first.png is missing"))
        assert "outputs/run-1 holds an earlier download of this run that is not whole, since first.png is missing" in rendered
        assert "none were fetched" in rendered

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
