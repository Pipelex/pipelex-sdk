import asyncio

import httpx
from mthds.protocol.models import ModelCategory
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient

_BASE_URL = "http://localhost:8081"


def _response(*, json: object) -> httpx.Response:
    request = httpx.Request("GET", f"{_BASE_URL}/v1/models")
    return httpx.Response(200, json=json, request=request)


class TestClientModels:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    def test_a_deck_carrying_a_judgment_entry_reads_whole(self, mocker: MockerFixture) -> None:
        """A `judgment` entry no longer fails the whole deck, and reads as its enum member."""
        client = self._client()
        deck_body = {
            "models": [
                {"name": "gpt-4o", "type": "llm"},
                {"name": "judge-small", "type": "judgment"},
            ],
        }
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(json=deck_body)))

        deck = asyncio.run(client.models())

        assert send.call_args.args == ("GET", f"{_BASE_URL}/v1/models")
        assert [entry.name for entry in deck.models] == ["gpt-4o", "judge-small"]
        assert deck.models[0].type is ModelCategory.LLM
        assert deck.models[1].type is ModelCategory.JUDGMENT

    def test_an_unknown_category_keeps_its_raw_value(self, mocker: MockerFixture) -> None:
        """The protocol's reader rule: a category this client has never heard of, which a later
        protocol minor may add, keeps its raw string instead of failing the whole deck.
        """
        client = self._client()
        deck_body = {
            "models": [
                {"name": "gpt-4o", "type": "llm"},
                {"name": "oracle-1", "type": "divination"},
                {"name": "untyped-model"},
            ],
        }
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(json=deck_body)))

        deck = asyncio.run(client.models())

        unknown_entry = deck.models[1]
        assert unknown_entry.name == "oracle-1"
        assert unknown_entry.type == "divination"
        assert not isinstance(unknown_entry.type, ModelCategory)
        assert deck.models[2].type is None

    def test_the_judgment_filter_rides_the_query(self, mocker: MockerFixture) -> None:
        """`models(ModelCategory.JUDGMENT)` asks the runner for `?type=judgment`."""
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(json={"models": []})))

        deck = asyncio.run(client.models(ModelCategory.JUDGMENT))

        assert send.call_args.args == ("GET", f"{_BASE_URL}/v1/models?type=judgment")
        assert deck.models == []
