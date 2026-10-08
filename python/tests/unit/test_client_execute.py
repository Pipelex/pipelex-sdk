"""Tests for the `execute` override — the hosted gateway ~30s timeout translation (httpx mocked).

Mirrors `pipelex-sdk-js/tests/client.test.ts` "execute gateway 30s timeout": a 503/504 — or a
client-side request timeout — at/after the ~28s ceiling becomes a clear `PipelineExecuteTimeoutError`
pointing at start+poll, while a fast 503 stays the `ApiResponseError` every non-2xx raises (runner down,
not a timeout) and the 202 async-degrade stays the inherited `RunStillRunningError`. The translation reads
the typed errors the inherited route raises through the client's overrides — `_raise_api_response_error`
for an answer, `_send` for a timeout, which arrives as the `ApiUnreachableError` whose code is
`ABORT_TIMEOUT` — so each case here proves it still fires on those errors rather than on httpx's.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError, MissingMainStuffError, PipelineExecuteTimeoutError, RunStillRunningError

if TYPE_CHECKING:
    from pytest_mock import MockerFixture

    from tests.unit.conftest import UnreachableClientBuilder

_BASE_URL = "http://localhost:8081"

# A completed execute response: `main_stuff_name` ("result") names the working-memory root key the
# `.main_stuff` accessor resolves to.
_EXECUTE_BODY: dict[str, object] = {
    "pipeline_run_id": "run-x",
    "main_stuff_name": "result",
    "pipe_output": {
        "working_memory": {
            "root": {"result": {"concept": "native.Text", "content": {"text": "hi"}}},
            "aliases": {"main_stuff": "result"},
        },
        "pipeline_run_id": "run-x",
    },
}


def _response(status_code: int, *, json: object | None = None) -> httpx.Response:
    request = httpx.Request("POST", f"{_BASE_URL}/v1/execute")
    if json is None:
        return httpx.Response(status_code, request=request)
    return httpx.Response(status_code, json=json, request=request)


class TestClientExecute:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    def test_gateway_503_past_ceiling_translates_to_timeout(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(503)))
        # start = 0s, failure observed at 31s → over the ~30s gateway ceiling.
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 31.0])

        with pytest.raises(PipelineExecuteTimeoutError) as exc_info:
            asyncio.run(client.execute(pipe_code="p"))

        error = exc_info.value
        assert error.elapsed_seconds == 31.0
        assert "30s" in str(error)
        assert "wait_for_result" in str(error)
        # The gateway's answer is kept as the cause, typed.
        assert isinstance(error.__cause__, ApiResponseError)
        assert error.__cause__.status == 503
        assert error.__cause__.request_url == f"{_BASE_URL}/v1/execute"

    def test_gateway_504_past_ceiling_translates_to_timeout(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(504)))
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 29.0])

        with pytest.raises(PipelineExecuteTimeoutError) as exc_info:
            asyncio.run(client.execute(pipe_code="p"))
        assert isinstance(exc_info.value.__cause__, ApiResponseError)
        assert exc_info.value.__cause__.status == 504

    def test_client_timeout_past_ceiling_translates_to_timeout(self, mocker: MockerFixture, unreachable_client: UnreachableClientBuilder) -> None:
        client = unreachable_client(httpx.ReadTimeout)
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 30.5])

        with pytest.raises(PipelineExecuteTimeoutError) as exc_info:
            asyncio.run(client.execute(pipe_code="p"))

        error = exc_info.value
        assert error.elapsed_seconds == 30.5
        # The timeout is kept as the cause, as the SDK's own unreachable error rather than httpx's.
        assert isinstance(error.__cause__, ApiUnreachableError)
        assert error.__cause__.code == "ABORT_TIMEOUT"
        assert isinstance(error.__cause__.__cause__, httpx.ReadTimeout)

    def test_client_timeout_under_ceiling_stays_unreachable(self, mocker: MockerFixture, unreachable_client: UnreachableClientBuilder) -> None:
        client = unreachable_client(httpx.ReadTimeout)
        # Cut off at 2s: the client's own timeout, not the gateway's ~30s ceiling.
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 2.0])

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.execute(pipe_code="p"))
        assert exc_info.value.code == "ABORT_TIMEOUT"

    def test_refused_connection_past_ceiling_stays_unreachable(self, mocker: MockerFixture, unreachable_client: UnreachableClientBuilder) -> None:
        client = unreachable_client(httpx.ConnectError)
        # However long it took, a request that never connected is no gateway cut-off.
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 30.5])

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.execute(pipe_code="p"))
        assert exc_info.value.code == "ConnectError"

    @pytest.mark.parametrize("failure", [httpx.ConnectTimeout, httpx.PoolTimeout])
    def test_a_connection_that_timed_out_past_ceiling_stays_unreachable(
        self, mocker: MockerFixture, unreachable_client: UnreachableClientBuilder, failure: type[httpx.TimeoutException]
    ) -> None:
        client = unreachable_client(failure)
        # A connect or a pool wait that ran out after 30s sent no request: no gateway saw it, so it is no
        # gateway cut-off, however long it took.
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 30.5])

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.execute(pipe_code="p"))
        assert exc_info.value.code == failure.__name__

    def test_fast_503_stays_an_api_response_error(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(503)))
        # Failure at 2s — under the ceiling: a genuinely-down runner, not a gateway timeout.
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 2.0])

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.execute(pipe_code="p"))
        assert exc_info.value.status == 503
        assert str(exc_info.value) == "API POST /v1/execute failed (503): Service Unavailable"

    def test_success_resolves_main_stuff(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=_EXECUTE_BODY)))

        result = asyncio.run(client.execute(pipe_code="p"))
        assert result.pipeline_run_id == "run-x"
        # `.main_stuff` resolves the output out of the working memory — same accessor as the durable path.
        assert result.main_stuff == {"text": "hi"}

    def test_main_stuff_raises_when_unlocatable(self, mocker: MockerFixture) -> None:
        client = self._client()
        # `main_stuff_name` names "missing", absent from the working-memory root.
        body: dict[str, object] = {
            "pipeline_run_id": "run-x",
            "main_stuff_name": "missing",
            "pipe_output": {
                "working_memory": {"root": {"other": {"concept": "native.Text", "content": {}}}, "aliases": {}},
                "pipeline_run_id": "run-x",
            },
        }
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        result = asyncio.run(client.execute(pipe_code="p"))
        with pytest.raises(MissingMainStuffError):
            _ = result.main_stuff

    def test_202_degrade_stays_run_still_running_error(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json={"pipeline_run_id": "run-x"})))

        with pytest.raises(RunStillRunningError):
            asyncio.run(client.execute(pipe_code="p"))
