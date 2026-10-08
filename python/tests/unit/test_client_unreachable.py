"""Every route maps a request that got no answer to `ApiUnreachableError` (httpx `MockTransport` failing below `_send`).

The protocol routes the client inherits from `mthds` (`execute`, `start`, `validate`, `models`, `version`) send
through the same `_send` override as the run reads, the product routes and `health`, so a refused connection, a
DNS failure or a timeout raises the SDK's own error whichever route met it, never httpx's own exception.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from mthds.protocol.exceptions import PipelineRequestError

from pipelex_sdk.errors import ApiUnreachableError
from pipelex_sdk.runs import WaitForResultOptions

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import UnreachableClientBuilder

_BASE_URL = "http://localhost:8081"


def _routes() -> dict[str, Callable[[PipelexAPIClient], Coroutine[Any, Any, Any]]]:
    """One call per route, the inherited protocol routes first, each named for the test id."""
    return {
        "execute": lambda client: client.execute(pipe_code="p"),
        "start": lambda client: client.start(pipe_code="p"),
        "validate": lambda client: client.validate(["domain = 'd'"]),
        "validate_by_method_ref": lambda client: client.validate(method_ref="github.com/Pipelex/methods/documents"),
        "models": lambda client: client.models(),
        "version": lambda client: client.version(),
        "get_run_status": lambda client: client.get_run_status("run_1"),
        "get_run_result": lambda client: client.get_run_result("run_1"),
        "wait_for_result": lambda client: client.wait_for_result("run_1", WaitForResultOptions(timeout_seconds=5.0)),
        "start_and_wait": lambda client: client.start_and_wait(pipe_code="p"),
        "get_me": lambda client: client.get_me(),
        "health": lambda client: client.health(),
    }


class TestClientUnreachable:
    @pytest.mark.parametrize("route", list(_routes()))
    def test_a_refused_connection_raises_api_unreachable_error(self, unreachable_client: UnreachableClientBuilder, route: str) -> None:
        client = unreachable_client(httpx.ConnectError)

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(_routes()[route](client))
        err = exc_info.value
        assert str(err) == f"Could not reach Pipelex API at {_BASE_URL} (ConnectError)"
        assert err.api_url == _BASE_URL
        assert err.code == "ConnectError"
        assert isinstance(err.__cause__, httpx.ConnectError)
        # A caller catching the protocol's base error catches it, as it catches `ApiResponseError`.
        assert isinstance(err, PipelineRequestError)

    @pytest.mark.parametrize("route", list(_routes()))
    def test_a_timeout_raises_api_unreachable_error_with_abort_timeout(self, unreachable_client: UnreachableClientBuilder, route: str) -> None:
        client = unreachable_client(httpx.ReadTimeout)

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(_routes()[route](client))
        err = exc_info.value
        assert str(err) == f"Could not reach Pipelex API at {_BASE_URL} (timeout)"
        assert err.api_url == _BASE_URL
        assert err.code == "ABORT_TIMEOUT"
        assert isinstance(err.__cause__, httpx.ReadTimeout)

    @pytest.mark.parametrize(
        ("failure", "code"),
        [
            (httpx.ConnectError, "ConnectError"),
            (httpx.ReadError, "ReadError"),
            (httpx.RemoteProtocolError, "RemoteProtocolError"),
            (httpx.ConnectTimeout, "ABORT_TIMEOUT"),
            (httpx.PoolTimeout, "ABORT_TIMEOUT"),
        ],
    )
    def test_every_transport_failure_carries_its_code(
        self, unreachable_client: UnreachableClientBuilder, failure: type[httpx.TransportError], code: str
    ) -> None:
        client = unreachable_client(failure)

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.start(pipe_code="p"))
        assert exc_info.value.code == code
        assert isinstance(exc_info.value.__cause__, failure)

    def test_start_and_wait_raises_the_start_failure_after_an_unreachable_handshake(self, unreachable_client: UnreachableClientBuilder) -> None:
        """The `/v1/version` handshake failing is read as hosted, and the start then raises the same unreachable error."""
        client = unreachable_client(httpx.ConnectError)

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.start_and_wait(pipe_code="p"))
        cause = exc_info.value.__cause__
        assert isinstance(cause, httpx.ConnectError)
        assert cause.request.url.path == "/v1/start"
        assert client._lifecycle_available is True
