"""Tests for `PipelexAPIClient` construction — credential resolution and base-URL validation."""

import os

import pytest
from mthds.protocol.exceptions import PipelineRequestError
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient


class TestClientConstruction:
    @pytest.fixture(autouse=True)
    def _isolate_env(self, mocker: MockerFixture) -> None:
        """Hermetic construction — no real env vars."""
        mocker.patch.dict(os.environ, {}, clear=True)

    def test_defaults_to_hosted_base_and_anonymous(self) -> None:
        client = PipelexAPIClient()
        assert client.base_url == "https://api.pipelex.com"
        assert client.origin_url == "https://api.pipelex.com"
        assert client.api_key == ""

    def test_reads_pipelex_env_vars(self, mocker: MockerFixture) -> None:
        mocker.patch.dict(os.environ, {"PIPELEX_API_KEY": "pk-live", "PIPELEX_BASE_URL": "http://localhost:8081"}, clear=True)
        client = PipelexAPIClient()
        assert client.api_key == "pk-live"
        assert client.base_url == "http://localhost:8081"

    def test_mthds_resolver_is_never_consulted(self, mocker: MockerFixture) -> None:
        """Regression: this SDK is Pipelex-only. `MTHDS_API_KEY` / `MTHDS_BASE_URL` are a
        credential pair for whatever runner the vendor-neutral mthds tooling targets — an
        unconfigured client must stay anonymous against the hosted default instead of
        borrowing a key configured for another runner.
        """
        mocker.patch.dict(os.environ, {"MTHDS_API_KEY": "mthds-key", "MTHDS_BASE_URL": "http://localhost:8081"}, clear=True)
        client = PipelexAPIClient()
        assert client.api_key == ""
        assert client.base_url == "https://api.pipelex.com"

    def test_explicit_args_override_env(self, mocker: MockerFixture) -> None:
        mocker.patch.dict(os.environ, {"PIPELEX_API_KEY": "pk-env", "PIPELEX_BASE_URL": "http://env.example.com"}, clear=True)
        client = PipelexAPIClient(api_key="arg-token", base_url="https://arg.example.com")
        assert client.api_key == "arg-token"
        assert client.base_url == "https://arg.example.com"

    def test_explicit_empty_token_forces_anonymous_over_env(self, mocker: MockerFixture) -> None:
        """An explicit `api_key=""` means anonymous and must win over a configured env token."""
        mocker.patch.dict(os.environ, {"PIPELEX_API_KEY": "pk-env"}, clear=True)
        client = PipelexAPIClient(api_key="")
        assert client.api_key == ""

    def test_strips_trailing_slash(self) -> None:
        client = PipelexAPIClient(base_url="https://api.pipelex.com/")
        assert client.base_url == "https://api.pipelex.com"
        assert client.origin_url == "https://api.pipelex.com"

    def test_origin_includes_port(self) -> None:
        client = PipelexAPIClient(base_url="http://localhost:8081")
        assert client.origin_url == "http://localhost:8081"

    @pytest.mark.parametrize(
        "bad_url",
        [
            "https://api.pipelex.com/v1",  # path
            "https://api.pipelex.com?x=1",  # query
            "https://api.pipelex.com#frag",  # fragment
            "https://user:pass@api.pipelex.com",  # embedded credentials
            "ftp://api.pipelex.com",  # non-http(s) scheme
            "api.pipelex.com",  # no scheme
            "not a url",  # garbage
            "",  # explicit empty string — presence semantics: it must fail, not fall through
        ],
    )
    def test_rejects_non_host_only_base_url(self, bad_url: str) -> None:
        with pytest.raises(PipelineRequestError):
            PipelexAPIClient(base_url=bad_url)

    # The rule refuses exactly the parts of a URL a secret travels in, so its refusal must not carry
    # them: the message reaches logs, and a page that relays an error's message. The shown forms are
    # `@pipelex/sdk`'s, word for word (`js/tests/client.test.ts`), so a refusal reads the same from
    # either SDK and the `pipelex-sdk` command's case table holds both.
    @pytest.mark.parametrize(
        ("base_url", "shown", "secrets"),
        [
            ("https://user:s3cret-pass@api.example.com", '"https://api.example.com" with credentials (not shown)', ["user", "s3cret-pass"]),
            ("https://proxy.example.com?token=abc123", '"https://proxy.example.com" with a query (not shown)', ["token", "abc123"]),
            (
                "https://api.example.com:8443/k3y/v1?sig=zzz#an-anchor",
                '"https://api.example.com:8443" with a path, a query and a fragment (not shown)',
                ["k3y", "sig", "zzz", "an-anchor"],
            ),
            ("http://admin:hunter2@localhost:8081/v1", '"http://localhost:8081" with credentials and a path (not shown)', ["admin", "hunter2"]),
            ("https://API.Example.com:443/v1", '"https://api.example.com" with a path (not shown)', []),
            # `;params` belong to the path, as WHATWG's parser reads them: accepted, the token would ride
            # every request line.
            ("https://api.example.com/;token=s3cret", '"https://api.example.com" with a path (not shown)', ["token", "s3cret"]),
            ("http://[::1]:8081/v1", '"http://[::1]:8081" with a path (not shown)', []),
            ("user:hunter2@api.example.com", "(not shown: it is not an http or https URL)", ["user", "hunter2", "api.example.com"]),
            ("not a url hunter2", "(not shown: it is not an absolute URL)", ["hunter2"]),
            ("", "(not shown: it is not an absolute URL)", []),
        ],
    )
    def test_refuses_a_base_url_without_echoing_it(self, base_url: str, shown: str, secrets: list[str]) -> None:
        with pytest.raises(PipelineRequestError) as raised:
            PipelexAPIClient(base_url=base_url)
        message = str(raised.value)
        assert message == (
            f"Invalid API base URL {shown}: it must be host-only (http/https, no path, query, fragment, or credentials). "
            "Endpoints compose as {base}/v1/{endpoint}."
        )
        for secret in secrets:
            assert secret not in message

    def test_set_but_empty_base_url_env_raises(self, mocker: MockerFixture) -> None:
        """A set-but-empty `PIPELEX_BASE_URL` (e.g. an unfilled CI secret) must fail fast
        instead of silently targeting the hosted default with whatever API key is configured.
        """
        mocker.patch.dict(os.environ, {"PIPELEX_BASE_URL": "", "PIPELEX_API_KEY": "pk-live"}, clear=True)
        with pytest.raises(PipelineRequestError):
            PipelexAPIClient()

    def test_default_request_timeout(self) -> None:
        """With no override, the blocking-execute ceiling defaults to 20 minutes."""
        client = PipelexAPIClient()
        assert client.request_timeout_seconds == 1200.0

    @pytest.mark.parametrize("timeout_seconds", [30.0, 0.0])
    def test_request_timeout_seconds_override(self, timeout_seconds: float) -> None:
        """An explicit `request_timeout_seconds` sets the per-instance ceiling — including a falsy `0.0`."""
        client = PipelexAPIClient(request_timeout_seconds=timeout_seconds)
        assert client.request_timeout_seconds == timeout_seconds
