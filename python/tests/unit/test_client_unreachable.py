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
        "validate": lambda client: client.validate({"main.mthds": "domain = 'd'"}),
        "validate_by_method_ref": lambda client: client.validate(method_ref="github.com/Pipelex/methods/documents"),
        "models": lambda client: client.models(),
        "version": lambda client: client.version(),
        "get_run_status": lambda client: client.get_run_status("run_1"),
        "get_run_progress": lambda client: client.get_run_progress("run_1"),
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
        assert err.network_code == "ConnectError"
        # A refused connection proves nothing was sent, even on a start.
        assert (err.problem.code, err.problem.retry) == ("client.unreachable", "yes")
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
        assert err.network_code == "ABORT_TIMEOUT"
        # A start or an execute timed out once the request had left may have started a run; `start_and_wait` times
        # out on its handshake, before any start is sent.
        assert err.problem.code == ("client.outcome_unknown" if route in {"execute", "start"} else "client.timeout")
        assert isinstance(err.__cause__, httpx.ReadTimeout)

    @pytest.mark.parametrize(
        ("failure", "network_code", "code"),
        [
            # No request left, so no run started.
            (httpx.ConnectError, "ConnectError", "client.unreachable"),
            # The request may have left before the connection failed, so a run may exist.
            (httpx.ReadError, "ReadError", "client.outcome_unknown"),
            (httpx.RemoteProtocolError, "RemoteProtocolError", "client.outcome_unknown"),
            # A request that reached the server and ran out of time while it was sent or answered.
            (httpx.ReadTimeout, "ABORT_TIMEOUT", "client.outcome_unknown"),
            (httpx.WriteTimeout, "ABORT_TIMEOUT", "client.outcome_unknown"),
            # No request was sent: never the client's own limit on one, so never the gateway's cut-off.
            (httpx.ConnectTimeout, "ConnectTimeout", "client.unreachable"),
            (httpx.PoolTimeout, "PoolTimeout", "client.timeout"),
        ],
    )
    def test_every_transport_failure_on_a_start_carries_its_network_code_and_its_problem(
        self, unreachable_client: UnreachableClientBuilder, failure: type[httpx.TransportError], network_code: str, code: str
    ) -> None:
        client = unreachable_client(failure)

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.start(pipe_code="p"))
        assert exc_info.value.network_code == network_code
        assert exc_info.value.problem.code == code
        assert isinstance(exc_info.value.__cause__, failure)

    def test_start_and_wait_raises_an_unreachable_handshake_and_sends_no_start(self, unreachable_client: UnreachableClientBuilder) -> None:
        """No answer to the `/v1/version` handshake raises at once, uncached: a start sent to a host that did not
        answer would wait a second time for the same silence.
        """
        client = unreachable_client(httpx.ConnectError)

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.start_and_wait(pipe_code="p"))
        cause = exc_info.value.__cause__
        assert isinstance(cause, httpx.ConnectError)
        assert cause.request.url.path == "/v1/version"
        assert client._lifecycle_available is None
