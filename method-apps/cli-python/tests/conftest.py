"""The fixtures every test file shares: the fake client, and an environment that holds no key."""

import asyncio

import httpx
import pytest
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError

from pipelex_method_cli_python.lib import client as client_module
from tests.support import FakeClient


@pytest.fixture(autouse=True)
def no_ambient_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep a developer's own key and base URL out of every test, so no test can reach the API by accident."""
    monkeypatch.delenv("PIPELEX_API_KEY", raising=False)
    monkeypatch.delenv("PIPELEX_BASE_URL", raising=False)


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch) -> FakeClient:
    """Replace `lib.client.make_client` with a fake client, and hand the fake to the test to set and read."""
    fake = FakeClient()

    def make_fake() -> FakeClient:
        return fake

    monkeypatch.setattr(client_module, "make_client", make_fake)
    return fake


#: The hosted plane's answer to a `POST /v1/start` whose bundle names a model the deck does not know, as
#: a problem document: `method.invalid`, whose `errors` list one item per fault, here the unknown model with
#: the pipe and the field it is declared at. The sentences are the runtime's own, as the dev plane gave them.
_REFUSED_START_ITEM_DETAIL = (
    "Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck\n\n"
    "Did you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna"
)
_REFUSED_START_NEXT_STEP = "Fix each fault the problem's errors list, then validate the method again."
_REFUSED_START_BODY: dict[str, object] = {
    "type": "https://mthds.ai/errors/method.invalid",
    "title": "The method does not validate",
    "status": 422,
    "detail": "The method does not validate.",
    "code": "method.invalid",
    "domain": "method",
    "retry": "no",
    "next_step": {"kind": "change_method", "detail": _REFUSED_START_NEXT_STEP},
    "request_id": "req_a3dd6900-7909-48d3-b551-0140e73ac7fc",
    "errors": [
        {
            "code": "model.unknown",
            "detail": _REFUSED_START_ITEM_DETAIL,
            "params": {"model": "gpt-5.1", "model_type": "llm", "suggestions": ["gpt-5.5", "gpt-5.4", "gpt-5.6-sol", "gpt-5.4-pro", "gpt-5.6-luna"]},
            "location": {"pipe": "draft_pitch", "field": "model"},
        }
    ],
}


@pytest.fixture
def refused_start() -> ApiResponseError:
    """The refusal above as `pipelex-sdk` raises it: a real client's `start` answered by a faked transport.

    Built through the client rather than by hand, so the tests that take it hold the SDK in the lock to
    its promise that every route, `start` among them, raises the typed `ApiResponseError` with the
    problem document parsed onto it.
    """

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json=_REFUSED_START_BODY, headers={"content-type": "application/problem+json"}, request=request)

    async def start() -> None:
        async with PipelexAPIClient(api_key="test-key", base_url="https://api.example.com") as client:
            if client.client is not None:
                await client.client.aclose()
            client.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
            await client.start(pipe_code="sales_copy.pitch_product", files={"main.mthds": "domain = 'sales_copy'"})

    with pytest.raises(ApiResponseError) as caught:
        asyncio.run(start())
    return caught.value
