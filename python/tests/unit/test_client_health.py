"""Tests for the origin-level `health()` probe — httpx mocked."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError

if TYPE_CHECKING:
    from pytest_mock import MockerFixture

    from tests.unit.conftest import UnreachableClientBuilder

_BASE_URL = "http://localhost:8081"


def _response(status_code: int, *, json: object | None = None, content: bytes | None = None) -> httpx.Response:
    """Build a constructed httpx.Response with a request attached."""
    request = httpx.Request("GET", f"{_BASE_URL}/health")
    if json is not None:
        return httpx.Response(status_code, json=json, request=request)
    if content is not None:
        return httpx.Response(status_code, content=content, request=request)
    return httpx.Response(status_code, request=request)


class TestClientHealth:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="t", base_url=_BASE_URL)

    def test_health_hits_origin_level_path_outside_v1(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json={"status": "ok"})))
        result = asyncio.run(client.health())
        assert result == {"status": "ok"}
        assert send.call_args.args[0] == "GET"
        # `/health` lives at the origin, NOT under `/v1`.
        assert send.call_args.args[1] == f"{_BASE_URL}/health"
        assert "/v1/" not in send.call_args.args[1]

    def test_health_non_2xx_raises_api_response_error_naming_health(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(503, content=b"unavailable")))
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.health())
        err = exc_info.value
        assert str(err) == "API GET /health failed (503): unavailable"
        assert err.status == 503
        assert err.request_url == f"{_BASE_URL}/health"
        # The probe answers no problem document, so the SDK reads the status by the edge's rules: a 503 may pass.
        assert (err.problem.code, err.problem.retry) == ("runtime.unavailable", "yes")

    def test_health_bare_404_is_a_missing_route(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json={"detail": "Not Found"})))
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.health())
        assert (exc_info.value.problem.code, exc_info.value.problem.retry) == ("request.not_found", "no")

    def test_health_transport_failure_maps_to_unreachable(self, unreachable_client: UnreachableClientBuilder) -> None:
        client = unreachable_client(httpx.ConnectError)
        with pytest.raises(ApiUnreachableError):
            asyncio.run(client.health())
