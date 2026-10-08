"""Tests for the transport extension layer — `_request_product`, httpx mocked."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError

if TYPE_CHECKING:
    from pytest_mock import MockerFixture

    from tests.unit.conftest import UnreachableClientBuilder

_BASE_URL = "http://localhost:8081"


def _as_is(answer: Any) -> Any:
    """Read an answer's decoded body as it came, for the tests of the transport alone."""
    return answer


def _response(status_code: int, *, json: object | None = None, content: bytes | None = None, headers: dict[str, str] | None = None) -> httpx.Response:
    """Build a constructed httpx.Response with a request attached."""
    request = httpx.Request("GET", f"{_BASE_URL}/x")
    if json is not None:
        return httpx.Response(status_code, json=json, headers=headers or {}, request=request)
    if content is not None:
        return httpx.Response(status_code, content=content, headers=headers or {}, request=request)
    return httpx.Response(status_code, headers=headers or {}, request=request)


class TestClientTransport:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="t", base_url=_BASE_URL)

    # ── _request_product ─────────────────────────────────────────────

    def test_request_product_parses_2xx_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json={"id": "u1"})))
        result = asyncio.run(client._request_product("GET", "me", read=_as_is))
        assert result == {"id": "u1"}
        assert send.call_args.args[0] == "GET"
        assert send.call_args.args[1] == f"{_BASE_URL}/v1/me"

    def test_a_route_without_answer_takes_an_empty_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(204)))
        asyncio.run(client._request_product_without_answer("DELETE", "pipelex-api-keys/k1"))
        assert send.call_args.args[0] == "DELETE"

    def test_a_route_without_answer_refuses_a_body_that_is_not_json(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, content=b"<html>Gateway</html>")))
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client._request_product_without_answer("POST", "onboarding/submit", body={}))
        assert str(exc_info.value) == "API POST /v1/onboarding/submit answered 200 with a body that is not JSON"

    def test_request_product_refuses_an_empty_2xx_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200)))
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client._request_product("GET", "me", read=_as_is))
        assert str(exc_info.value) == "API GET /v1/me answered 200 with an empty body where JSON was expected"

    def test_request_product_sends_body_and_verb(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json={"ok": True})))
        asyncio.run(client._request_product("PUT", "runs/r1", body={"name": "x"}, read=_as_is))
        assert send.call_args.args[0] == "PUT"
        assert send.call_args.kwargs["content"] == b'{"name":"x"}'

    def test_request_product_non_2xx_raises_api_response_error_with_code(self, mocker: MockerFixture) -> None:
        client = self._client()
        body = {"code": "conflict", "detail": {"error_type": "Conflict", "message": "no subscription"}}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client._request_product("POST", "billing/change-plan", body={"plan": "pro"}, read=_as_is))
        err = exc_info.value
        assert err.code == "conflict"
        assert err.status == 409
        assert err.server_message == "no subscription"
        assert err.error_type == "Conflict"
        assert err.api_url == _BASE_URL

    def test_request_product_connect_failure_maps_to_unreachable(self, unreachable_client: UnreachableClientBuilder) -> None:
        client = unreachable_client(httpx.ConnectError)
        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client._request_product("GET", "me", read=_as_is))
        err = exc_info.value
        assert err.api_url == _BASE_URL
        assert err.code == "ConnectError"

    def test_request_product_read_timeout_maps_to_unreachable_abort(self, unreachable_client: UnreachableClientBuilder) -> None:
        client = unreachable_client(httpx.ReadTimeout)
        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client._request_product("GET", "me", read=_as_is))
        assert exc_info.value.code == "ABORT_TIMEOUT"

    def test_request_product_connect_timeout_carries_its_class_name(self, unreachable_client: UnreachableClientBuilder) -> None:
        # A connection that never opened sent nothing: it is not the client's own time limit on a request.
        client = unreachable_client(httpx.ConnectTimeout)
        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client._request_product("GET", "me", read=_as_is))
        assert exc_info.value.code == "ConnectTimeout"

    def test_a_body_that_does_not_decode_maps_to_unreachable(self) -> None:
        """A gzip answer whose bytes are not gzip is lost on the way, as `@pipelex/sdk` reports it (`Z_DATA_ERROR`)."""
        client = PipelexAPIClient(api_key="t", base_url=_BASE_URL)
        client.client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(b"not gzip")))
        )
        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client._request_product("GET", "me", read=_as_is))
        assert exc_info.value.code == "DecodingError"
        assert isinstance(exc_info.value.__cause__, httpx.DecodingError)
