"""`lib/method_source.py`: reading the one method out of the package's `method/` directory."""

from pathlib import Path

import pytest

from pipelex_method_cli_python.lib.manifest import ManifestError
from pipelex_method_cli_python.lib.method_source import MethodSource, MethodSourceError, method_dir, read_method_source


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class TestReadMethodSource:
    def test_the_template_as_shipped_has_no_method_directory(self):
        # The template ships no method: `make create` writes `method/`, so the package's own is absent.
        assert not method_dir().is_dir()
        with pytest.raises(MethodSourceError, match="missing"):
            read_method_source()

    def test_a_bundle_is_every_mthds_file_in_the_order_of_its_path(self, tmp_path: Path):
        _write(tmp_path / "b.mthds", "b")
        _write(tmp_path / "a.mthds", "a")
        _write(tmp_path / "sub" / "c.mthds", "c")
        _write(tmp_path / "notes.md", "not part of the bundle")
        assert read_method_source(tmp_path) == MethodSource(mthds_contents=("a", "b", "c"))

    def test_a_manifest_names_the_method_instead(self, tmp_path: Path):
        _write(tmp_path / "method.json", '{"method_ref": "github.com/owner/repo@v1"}')
        assert read_method_source(tmp_path) == MethodSource(method_ref="github.com/owner/repo@v1")

    def test_both_a_bundle_and_a_manifest_are_refused(self, tmp_path: Path):
        _write(tmp_path / "a.mthds", "a")
        _write(tmp_path / "method.json", '{"method_id": "mt_abc"}')
        with pytest.raises(MethodSourceError, match="both"):
            read_method_source(tmp_path)

    def test_an_empty_directory_is_refused(self, tmp_path: Path):
        with pytest.raises(MethodSourceError, match="neither"):
            read_method_source(tmp_path)

    def test_a_broken_manifest_is_the_manifest_reader_s_refusal(self, tmp_path: Path):
        _write(tmp_path / "method.json", "{}")
        with pytest.raises(ManifestError):
            read_method_source(tmp_path)


class TestDescribe:
    @pytest.mark.parametrize(
        ("source", "described"),
        [
            (MethodSource(method_ref="github.com/o/r@v1"), "the published method github.com/o/r@v1"),
            (MethodSource(method_id="mt_abc"), "the catalog method mt_abc"),
            (MethodSource(mthds_contents=("a",)), "the bundle of 1 .mthds file"),
            (MethodSource(mthds_contents=("a", "b")), "the bundle of 2 .mthds files"),
        ],
    )
    def test_names_the_source_in_a_few_words(self, source: MethodSource, described: str):
        assert source.describe() == described
