"""`lib/client.py`: the one place a client is built, and the key it refuses to build one without."""

import pytest
from pipelex_sdk.client import PipelexAPIClient

from pipelex_method_cli_python.lib.app import COMMAND_NAME
from pipelex_method_cli_python.lib.client import API_KEY_ENV, MissingApiKeyError, app_info, make_client


class TestMakeClient:
    @pytest.mark.parametrize("value", [None, "", "   "])
    def test_refuses_a_missing_or_blank_key(self, monkeypatch: pytest.MonkeyPatch, value: str | None):
        if value is not None:
            monkeypatch.setenv(API_KEY_ENV, value)
        with pytest.raises(MissingApiKeyError) as caught:
            make_client()
        assert caught.value.hint is not None
        assert "app.pipelex.com" in caught.value.hint

    def test_builds_a_client_from_the_key(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(API_KEY_ENV, "test-key")
        assert isinstance(make_client(), PipelexAPIClient)


class TestAppInfo:
    def test_names_the_command_and_the_installed_version(self):
        info = app_info()
        assert info.name == COMMAND_NAME
        # The project is installed into its own environment by `uv sync`, so its version is known.
        assert info.version is not None
