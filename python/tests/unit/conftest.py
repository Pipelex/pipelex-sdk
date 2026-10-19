"""Shared fixtures for the unit suite — a client, a wire-response builder, the `_send` spy, a client
whose transport fails, and one whose transport records the requests it sends.

House rule: fixtures live in `conftest.py`. `test_client_product.py` predates these and keeps
its own equivalent private helpers; migrating it is deliberately not part of this change.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient

if TYPE_CHECKING:
    from pytest_mock import MockerFixture, MockType

    from pipelex_sdk.errors import PipelexRequestError

BASE_URL = "http://localhost:8081"


def refused_argument(error: PipelexRequestError) -> dict[str, object]:
    """The argument and the reason an argument refusal names, as its `client.argument_invalid` problem carries them."""
    assert error.problem.code == "client.argument_invalid"
    assert error.problem.params is not None
    return error.problem.params.model_dump(exclude_none=True)


class ResponseBuilder(Protocol):
    """Builds one wire response the way the transport would hand it back."""

    def __call__(self, status_code: int, *, json_body: object | None = None) -> httpx.Response: ...


class SendPatcher(Protocol):
    """Patches a client's `_send` with a scripted response sequence and returns the spy."""

    def __call__(self, client: PipelexAPIClient, *responses: httpx.Response) -> MockType: ...


class UnreachableClientBuilder(Protocol):
    """Builds a client whose every request fails in the transport with `failure`, no answer coming back."""

    def __call__(self, failure: type[httpx.TransportError]) -> PipelexAPIClient: ...


@pytest.fixture
def unreachable_client() -> UnreachableClientBuilder:
    """The failure is raised by an `httpx.MockTransport` below the client's `_send`, where a real refused
    connection, DNS failure or timeout is raised, so every route meets it through the client's own mapping.
    """

    def _build(failure: type[httpx.TransportError]) -> PipelexAPIClient:
        def _fail(request: httpx.Request) -> httpx.Response:
            msg = f"simulated {failure.__name__}"
            raise failure(msg, request=request)

        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        client.client = httpx.AsyncClient(transport=httpx.MockTransport(_fail))
        return client

    return _build


class RecordingClientBuilder(Protocol):
    """Builds a client whose transport appends every request to `sent`, as httpx resolved its URL, and answers it."""

    def __call__(self, sent: list[httpx.Request], status_code: int, *, json_body: object | None = None) -> PipelexAPIClient: ...


@pytest.fixture
def recording_client() -> RecordingClientBuilder:
    """The requests are recorded by an `httpx.MockTransport` below the client's `_send`, after httpx has built
    each one, so what is recorded is the URL the request would leave with, dot segments already resolved.
    """

    def _build(sent: list[httpx.Request], status_code: int, *, json_body: object | None = None) -> PipelexAPIClient:
        def _answer(request: httpx.Request) -> httpx.Response:
            sent.append(request)
            if json_body is None:
                return httpx.Response(status_code, request=request)
            return httpx.Response(status_code, json=json_body, request=request)

        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        client.client = httpx.AsyncClient(transport=httpx.MockTransport(_answer))
        return client

    return _build


@pytest.fixture
def api_client() -> PipelexAPIClient:
    return PipelexAPIClient(api_key="test-token", base_url=BASE_URL)


@pytest.fixture
def wire_response() -> ResponseBuilder:
    def _build(status_code: int, *, json_body: object | None = None) -> httpx.Response:
        request = httpx.Request("GET", f"{BASE_URL}/x")
        if json_body is None:
            return httpx.Response(status_code, request=request)
        return httpx.Response(status_code, json=json_body, request=request)

    return _build


@pytest.fixture
def patch_send(mocker: MockerFixture) -> SendPatcher:
    def _patch(client: PipelexAPIClient, *responses: httpx.Response) -> MockType:
        return mocker.patch.object(client, "_send", mocker.AsyncMock(side_effect=list(responses)))

    return _patch
