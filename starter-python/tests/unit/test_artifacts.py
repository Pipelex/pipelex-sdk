"""Tests for `widget/artifacts.py` — bringing a run's produced files down to disk.

Nothing here touches the network, and the module's own short-circuit is what makes that honest for
a text result: `collect_artifacts` answers offline, so a run that produced nothing never opens a
client. The tests that go past the short-circuit patch `PipelexAPIClient`, because past it the real
code opens one — which is exactly why a CLI test whose fixture output carries a realistic
`pipelex-storage://` reference needs the `stub_download` fixture rather than the short-circuit.

The download rules themselves (minting a fresh link per reference, never reading the expiring
`public_url`, reporting a failed reference as a value) belong to `pipelex-sdk` and are tested
there. What is pinned here is this module's own half: when the network is reached at all, what is
passed when it is, and how a verdict is rendered.
"""

import io
from pathlib import Path

from pipelex_sdk.artifact_models import ArtifactItemError, ArtifactScope, DownloadArtifactsResult, DownloadedArtifact
from pipelex_sdk.runs import RunResults
from pytest_mock import MockerFixture
from rich.console import Console

from widget.artifacts import DEFAULT_DOWNLOAD_DIR, download_produced_files, print_downloads

REPO_ROOT = Path(__file__).parent.parent.parent

TEXT_OUTPUT = {"people": ["Marie Curie"], "orgs": ["University of Paris"], "dates": ["1906"]}
# The shape the hosted runtime really returns for an image: the durable storage reference, plus the
# short-lived signed link beside it. Only the first is what the artifact stack walks.
IMAGE_OUTPUT = {"url": "pipelex-storage://run-1/cat.png", "public_url": "https://cdn.example.com/signed/cat.png"}


def _results(main_stuff: object) -> RunResults:
    return RunResults(pipeline_run_id="run-1", main_stuff=main_stuff, tokens_usages=None, usage_assembly_error=None)


def _render(downloaded: DownloadArtifactsResult | None) -> str:
    buffer = io.StringIO()
    # A wide, non-terminal console → plain text, no wrapping, no ANSI styling to assert around.
    print_downloads(Console(file=buffer, width=200), downloaded)
    return buffer.getvalue()


def _verdict(*artifacts: DownloadedArtifact) -> DownloadArtifactsResult:
    saved = [artifact.path for artifact in artifacts if artifact.path is not None]
    return DownloadArtifactsResult(
        scope=ArtifactScope.MAIN_STUFF,
        artifacts=list(artifacts),
        saved_paths=saved,
        all_saved=len(saved) == len(artifacts),
    )


class TestDownloadProducedFiles:
    async def test_a_text_output_stays_offline_and_opens_no_client(self, mocker: MockerFixture):
        # The whole point of the short-circuit: a text result must cost nothing, so the client is
        # never constructed. Patched with a plain Mock — awaiting it would fail loudly if reached.
        client = mocker.patch("widget.artifacts.PipelexAPIClient")
        downloaded = await download_produced_files(_results(TEXT_OUTPUT), dir_path=DEFAULT_DOWNLOAD_DIR)
        assert downloaded is None
        client.assert_not_called()

    async def test_an_output_referencing_a_file_goes_through_the_client(self, mocker: MockerFixture, tmp_path: Path):
        artifact = DownloadedArtifact(
            uri="pipelex-storage://run-1/cat.png", found_at=["$.url"], path=str(tmp_path / "cat.png"), content_type="image/png", size=3
        )
        fake_client = mocker.AsyncMock()
        fake_client.download_artifacts.return_value = _verdict(artifact)
        async_cm = mocker.MagicMock()
        async_cm.__aenter__ = mocker.AsyncMock(return_value=fake_client)
        async_cm.__aexit__ = mocker.AsyncMock(return_value=None)
        mocker.patch("widget.artifacts.PipelexAPIClient", return_value=async_cm)

        results = _results(IMAGE_OUTPUT)
        downloaded = await download_produced_files(results, dir_path=tmp_path)

        assert downloaded is not None
        assert downloaded.saved_paths == [str(tmp_path / "cat.png")]
        # The whole results envelope is handed over, not the reference read out here: resolving
        # which references a run produced is the SDK's job, and its scope is the main output.
        fake_client.download_artifacts.assert_awaited_once_with(results=results, dir_path=tmp_path)


class TestPrintDownloads:
    def test_says_nothing_when_the_run_produced_no_file(self):
        assert _render(None) == ""

    def test_names_each_saved_file(self):
        rendered = _render(_verdict(DownloadedArtifact(uri="pipelex-storage://run-1/cat.png", found_at=["$.url"], path="/tmp/out/cat.png", size=3)))
        assert "/tmp/out/cat.png" in rendered

    def test_names_a_reference_that_did_not_come_down(self):
        failed = DownloadedArtifact(
            uri="pipelex-storage://run-1/cat.png", found_at=["$.url"], error=ArtifactItemError(code="forbidden", detail="Not your run.")
        )
        rendered = _render(_verdict(failed))
        # The reference, the machine code and the sentence a person reads — a failed reference is
        # reported rather than raised, so the message is the only place it surfaces.
        assert "pipelex-storage://run-1/cat.png" in rendered
        assert "forbidden" in rendered
        assert "Not your run." in rendered

    def test_reports_both_arms_of_a_partial_download(self):
        saved = DownloadedArtifact(uri="pipelex-storage://run-1/ok.png", found_at=["$[0].url"], path="/tmp/out/ok.png", size=3)
        failed = DownloadedArtifact(
            uri="pipelex-storage://run-1/bad.png", found_at=["$[1].url"], error=ArtifactItemError(code="write_failed", detail="Disk full.")
        )
        rendered = _render(_verdict(saved, failed))
        assert "/tmp/out/ok.png" in rendered
        assert "Disk full." in rendered


class TestDefaultDownloadDir:
    def test_the_default_download_dir_is_gitignored(self):
        # It is a relative path, so the demos write it into whatever directory they are run from —
        # which the README walks a reader through doing at the repo root. This is the template every
        # new project is cloned from, so an untracked `downloads/` must not show up in `git status`.
        assert not DEFAULT_DOWNLOAD_DIR.is_absolute()
        ignored = (REPO_ROOT / ".gitignore").read_text().splitlines()
        assert f"{DEFAULT_DOWNLOAD_DIR.name}/" in ignored
