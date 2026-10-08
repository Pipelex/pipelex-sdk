"""`check_model_reference` — `GET /v1/models/check`, the model reference check.

What the call sends (the reference and the category in an encoded query), how a verdict parses (one
arm per kind, chosen by the wire's own `kind`, so a preset entry never passes for an alias), and what
raises (a `422` problem, its `error_type` intact).
"""

import asyncio
from typing import Any

import httpx
import pytest
from pytest_mock import MockerFixture, MockType

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError
from pipelex_sdk.model_reference_models import (
    AliasMatch,
    AliasReferenceVerdict,
    HandleMatch,
    HandleReferenceVerdict,
    ModelCheckCategory,
    ModelReferenceKind,
    ModelReferenceResolution,
    PresetMatch,
    PresetReferenceVerdict,
    WaterfallMatch,
    WaterfallReferenceVerdict,
)
from tests.unit.test_data import ModelCheckBodies

_BASE_URL = "http://localhost:8081"


def _response(status_code: int, *, json_body: object) -> httpx.Response:
    request = httpx.Request("GET", f"{_BASE_URL}/v1/models/check")
    return httpx.Response(status_code, json=json_body, request=request)


class TestClientModelCheck:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    def _mock_send(self, mocker: MockerFixture, client: PipelexAPIClient, response: httpx.Response) -> MockType:
        return mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=response))

    # ── The request ──────────────────────────────────────────────────

    def test_the_reference_and_the_type_ride_an_encoded_query(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=ModelCheckBodies.RESOLVED_PRESET))

        asyncio.run(client.check_model_reference("$writing-factual", category=ModelCheckCategory.LLM))

        assert send.call_args.args == ("GET", f"{_BASE_URL}/v1/models/check?reference=%24writing-factual&type=llm")

    @pytest.mark.parametrize(
        ("reference", "encoded"),
        [
            ("@best-claude", "%40best-claude"),
            ("~robust-llm", "~robust-llm"),
            ("handle:claude-4.8-opus", "handle%3Aclaude-4.8-opus"),
            # Whitespace is the runner's to trim, so it travels as given.
            (" @best-claude ", "+%40best-claude+"),
            # A reference cannot smuggle a parameter of its own into the query.
            ("@a&type=img_gen", "%40a%26type%3Dimg_gen"),
        ],
    )
    def test_without_a_category_only_the_encoded_reference_is_sent(self, mocker: MockerFixture, reference: str, encoded: str) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=ModelCheckBodies.NOT_FOUND_MISSPELT))

        asyncio.run(client.check_model_reference(reference))

        assert send.call_args.args == ("GET", f"{_BASE_URL}/v1/models/check?reference={encoded}")

    def test_the_check_gets_the_management_budget(self, mocker: MockerFixture) -> None:
        """Static and inference-free, so the poll budget, never the blocking-execute ceiling."""
        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL, request_timeout_seconds=1200.0)
        send = self._mock_send(mocker, client, _response(200, json_body=ModelCheckBodies.RESOLVED_PRESET))

        asyncio.run(client.check_model_reference("$writing-factual"))

        assert send.call_args.kwargs["request_timeout"] == pytest.approx(30.0)

    # ── The verdict ──────────────────────────────────────────────────

    def test_a_resolved_preset_reads_as_the_preset_arm(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(200, json_body=ModelCheckBodies.RESOLVED_PRESET))

        verdict = asyncio.run(client.check_model_reference("$writing-factual", category=ModelCheckCategory.LLM))

        assert isinstance(verdict, PresetReferenceVerdict)
        assert verdict.kind is ModelReferenceKind.PRESET
        assert verdict.resolution is ModelReferenceResolution.RESOLVED
        assert verdict.category is ModelCheckCategory.LLM
        assert verdict.reference == "$writing-factual"
        assert verdict.name == "writing-factual"
        assert verdict.matches == [
            PresetMatch(
                category=ModelCheckCategory.LLM,
                resolves_to="claude-4.8-opus",
                target="@default-premium",
                description="Factual writing with high accuracy",
            )
        ]
        assert verdict.suggestions == []
        assert verdict.other_kinds == []
        assert verdict.other_categories == []

    @pytest.mark.parametrize(
        ("body", "verdict_class", "match_class"),
        [
            (ModelCheckBodies.RESOLVED_ALIAS, AliasReferenceVerdict, AliasMatch),
            (ModelCheckBodies.RESOLVED_WATERFALL, WaterfallReferenceVerdict, WaterfallMatch),
            (ModelCheckBodies.RESOLVED_HANDLE, HandleReferenceVerdict, HandleMatch),
        ],
    )
    def test_each_kind_reads_as_its_own_arm(
        self,
        mocker: MockerFixture,
        body: dict[str, Any],
        verdict_class: type[AliasReferenceVerdict | WaterfallReferenceVerdict | HandleReferenceVerdict],
        match_class: type[AliasMatch | WaterfallMatch | HandleMatch],
    ) -> None:
        """The verdict's `kind` picks the shape of every match, so an alias entry, which differs from a
        preset entry only by lacking `description`, is never read as a preset, nor a preset as an alias.
        """
        client = self._client()
        self._mock_send(mocker, client, _response(200, json_body=body))

        verdict = asyncio.run(client.check_model_reference(body["reference"]))

        assert type(verdict) is verdict_class
        assert [type(match) for match in verdict.matches] == [match_class]
        assert verdict.model_dump(mode="json") == body

    def test_a_preset_entry_never_reads_as_an_alias(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(200, json_body=ModelCheckBodies.RESOLVED_PRESET))

        verdict = asyncio.run(client.check_model_reference("$writing-factual"))

        assert [type(match) for match in verdict.matches] == [PresetMatch]
        assert verdict.model_dump(mode="json") == ModelCheckBodies.RESOLVED_PRESET

    def test_a_preset_asked_in_another_category_is_not_found_with_its_category_named(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(200, json_body=ModelCheckBodies.NOT_FOUND_IN_CATEGORY))

        verdict = asyncio.run(client.check_model_reference("$writing-factual", category=ModelCheckCategory.IMG_GEN))

        assert isinstance(verdict, PresetReferenceVerdict)
        assert verdict.resolution is ModelReferenceResolution.NOT_FOUND
        assert verdict.category is ModelCheckCategory.IMG_GEN
        assert verdict.matches == []
        assert verdict.other_categories == [ModelCheckCategory.LLM]

    def test_a_misspelt_alias_is_not_found_with_its_suggestions(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(200, json_body=ModelCheckBodies.NOT_FOUND_MISSPELT))

        verdict = asyncio.run(client.check_model_reference("@best-cluade"))

        assert isinstance(verdict, AliasReferenceVerdict)
        assert verdict.resolution is ModelReferenceResolution.NOT_FOUND
        assert verdict.category is None
        assert verdict.matches == []
        assert verdict.suggestions == ["@best-claude"]

    def test_an_unknown_resolution_keeps_its_raw_value(self, mocker: MockerFixture) -> None:
        """The spec's reader rule: a value this SDK does not know reads as its raw string, for the
        consumer to treat as unresolved, rather than failing the verdict.
        """
        client = self._client()
        body = {**ModelCheckBodies.NOT_FOUND_MISSPELT, "resolution": "ambiguous"}
        self._mock_send(mocker, client, _response(200, json_body=body))

        verdict = asyncio.run(client.check_model_reference("@best-cluade"))

        assert verdict.resolution == "ambiguous"
        assert not isinstance(verdict.resolution, ModelReferenceResolution)

    # ── What raises ──────────────────────────────────────────────────

    @pytest.mark.parametrize(
        ("body", "error_type"),
        [
            (ModelCheckBodies.INVALID_REFERENCE_REFUSAL, "InvalidModelReference"),
            (ModelCheckBodies.INVALID_CATEGORY_REFUSAL, "InvalidModelCategory"),
            (ModelCheckBodies.REPEATED_PARAMETER_REFUSAL, "ValidationError"),
        ],
    )
    def test_a_refusal_raises_api_response_error_with_its_error_type(self, mocker: MockerFixture, body: dict[str, Any], error_type: str) -> None:
        """A request the runner cannot produce a verdict for is a `422` problem, raised as the typed
        error with the runner's `error_type`, never a verdict and never refused client-side.
        """
        client = self._client()
        self._mock_send(mocker, client, _response(422, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.check_model_reference("~"))

        assert exc_info.value.status == 422
        assert exc_info.value.error_type == error_type
        assert exc_info.value.error_domain == "input"
        assert exc_info.value.retryable is False
        assert exc_info.value.server_message == body["detail"]
        assert exc_info.value.request_url == f"{_BASE_URL}/v1/models/check?reference=~"
