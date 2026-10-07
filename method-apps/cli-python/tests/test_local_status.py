"""`scripts/local_status.py`: telling a local checkout from the registry's release, which the version cannot."""

from importlib.metadata import PackageNotFoundError

import pytest

from scripts import local_status


class _Installed:
    """An installed distribution's metadata, as much of it as `source_line` reads."""

    def __init__(self, version: str, direct_url: str | None) -> None:
        self.version = version
        self._direct_url = direct_url

    def read_text(self, filename: str) -> str | None:
        return self._direct_url if filename == "direct_url.json" else None


def _installed(monkeypatch: pytest.MonkeyPatch, installed: _Installed | None) -> None:
    def distribution(name: str) -> _Installed:
        if installed is None:
            raise PackageNotFoundError(name)
        return installed

    monkeypatch.setattr(local_status, "distribution", distribution)


class TestSourceLine:
    def test_a_release_carries_no_direct_url(self, monkeypatch: pytest.MonkeyPatch):
        _installed(monkeypatch, _Installed("0.31.0", None))
        assert local_status.source_line("pipelex-sdk") == "pipelex-sdk pypi 0.31.0"

    def test_a_checkout_names_its_path(self, monkeypatch: pytest.MonkeyPatch):
        _installed(monkeypatch, _Installed("0.31.0", '{"url": "file:///work/pipelex%20sdk/python", "dir_info": {"editable": true}}'))
        assert local_status.source_line("pipelex-sdk") == "pipelex-sdk local 0.31.0 /work/pipelex sdk/python"

    def test_a_direct_url_that_is_not_a_path_is_not_local(self, monkeypatch: pytest.MonkeyPatch):
        _installed(monkeypatch, _Installed("0.31.0", '{"url": "https://example.com/pipelex_sdk-0.31.0.whl"}'))
        assert local_status.source_line("pipelex-sdk") == "pipelex-sdk pypi 0.31.0"

    def test_an_absent_distribution_is_missing(self, monkeypatch: pytest.MonkeyPatch):
        _installed(monkeypatch, None)
        assert local_status.source_line("mthds") == "mthds missing"
