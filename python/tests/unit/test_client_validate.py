"""Tests for the `validate` override — render injection, `views`, the method selectors, the union round-trip."""

import asyncio
import json
from typing import cast

import httpx
import pytest
from mthds.protocol.exceptions import PipelineRequestError
from pytest_mock import MockerFixture, MockType

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError
from pipelex_sdk.validation_models import VALIDATION_VIEW_INPUT_FORM, PipelexInvalidReport, PipelexValidationReport
from tests.unit.conftest import problem_document

_BASE_URL = "http://localhost:8081"

_FILES = {"main.mthds": "bundle"}

_VALID_BODY = {"is_valid": True, "rendered_markdown": "## ok"}
_INVALID_BODY = {
    "is_valid": False,
    "is_runnable": False,
    "message": "bundle failed",
    "errors": [{"code": "method.syntax", "detail": "boom"}],
    "rendered_markdown": "## errors",
}


class TestClientValidate:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="t", base_url=_BASE_URL)

    def _mock_send(self, mocker: MockerFixture, client: PipelexAPIClient, *, json_body: object) -> MockType:
        response = httpx.Response(200, json=json_body, request=httpx.Request("POST", f"{_BASE_URL}/v1/validate"))
        return mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=response))

    @staticmethod
    def _sent_body(send: MockType) -> dict[str, object]:
        content = send.call_args.kwargs["content"]
        return cast("dict[str, object]", json.loads(content))

    def test_injects_markdown_render_by_default(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        asyncio.run(client.validate(_FILES))

        body = self._sent_body(send)
        assert send.call_args.args[1] == f"{_BASE_URL}/v1/validate"
        assert body == {"files": _FILES, "allow_signatures": False, "render": ["markdown"]}

    def test_merges_and_dedupes_caller_render(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        asyncio.run(client.validate(_FILES, render=["html", "markdown"]))

        # Caller tokens first, markdown not duplicated (mirrors the JS Set semantics).
        assert self._sent_body(send)["render"] == ["html", "markdown"]

    def test_returns_valid_report_with_rendered_markdown(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, json_body=_VALID_BODY)

        result = asyncio.run(client.validate(_FILES))

        assert isinstance(result, PipelexValidationReport)
        assert result.is_valid is True
        assert result.rendered_markdown == "## ok"

    def test_returns_invalid_report_union_arm(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, json_body=_INVALID_BODY)

        result = asyncio.run(client.validate(_FILES))

        assert isinstance(result, PipelexInvalidReport)
        assert result.is_valid is False
        assert result.rendered_markdown == "## errors"
        assert [(item.code, item.detail) for item in result.errors] == [("method.syntax", "boom")]

    # ── views ────────────────────────────────────────────────────────

    def test_views_absent_from_body_by_default(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        asyncio.run(client.validate(_FILES))

        # The opt-in stays opt-in: no `views` key at all, so the response is byte-identical
        # for consumers that never asked for a view.
        assert "views" not in self._sent_body(send)

    def test_views_sent_verbatim(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        asyncio.run(client.validate(_FILES, views=[VALIDATION_VIEW_INPUT_FORM, "future_view", VALIDATION_VIEW_INPUT_FORM]))

        # Unlike `render`, nothing is injected and nothing is de-duplicated — the server
        # resolves the tokens as a set and lenient-ignores the ones it does not know.
        assert self._sent_body(send)["views"] == ["input_form", "future_view", "input_form"]

    def test_explicit_empty_views_is_sent_as_empty_list(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        asyncio.run(client.validate(_FILES, views=[]))

        assert self._sent_body(send)["views"] == []

    def test_views_rides_alongside_render_injection(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        asyncio.run(client.validate(_FILES, render=["html"], views=[VALIDATION_VIEW_INPUT_FORM]))

        body = self._sent_body(send)
        assert body["render"] == ["html", "markdown"]
        assert body["views"] == ["input_form"]

    # ── method selectors (the strict tooling three-way XOR) ──────────

    def test_method_ref_selector_rides_the_body_without_files(self, mocker: MockerFixture) -> None:
        """A selector validation must NOT carry the `files` key at all — the server
        XORs on presence, and an empty map is a request-shape 422.
        """
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        asyncio.run(client.validate(method_ref="github.com/Pipelex/methods/documents@v0.1.0"))

        body = self._sent_body(send)
        assert send.call_args.args[1] == f"{_BASE_URL}/v1/validate"
        assert body["method_ref"] == "github.com/Pipelex/methods/documents@v0.1.0"
        assert "files" not in body
        assert "method_id" not in body
        assert body["allow_signatures"] is False
        # The markdown render injection holds on the selector path too.
        assert body["render"] == ["markdown"]

    def test_method_id_selector_is_a_pure_pass_through(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_INVALID_BODY)

        result = asyncio.run(client.validate(method_id="mt_1", allow_signatures=True, views=[VALIDATION_VIEW_INPUT_FORM]))

        body = self._sent_body(send)
        assert body["method_id"] == "mt_1"
        assert body["allow_signatures"] is True
        assert body["views"] == ["input_form"]
        assert "files" not in body
        # A produced invalid verdict still parses into the union's invalid arm.
        assert isinstance(result, PipelexInvalidReport)

    @pytest.mark.parametrize(
        ("kwargs", "status", "problem"),
        [
            (
                {"method_id": "mt_missing"},
                404,
                problem_document("pipelex.catalog.not_found", 404, detail="Method not found."),
            ),
            ({"files": _FILES}, 422, problem_document("request.invalid", 422, detail="files holds an invalid tree path.")),
        ],
    )
    def test_a_no_verdict_answer_raises_api_response_error(
        self, mocker: MockerFixture, kwargs: dict[str, object], status: int, problem: dict[str, object]
    ) -> None:
        """Both wire paths — the selector one built here and the tree one on the inherited seam — raise the typed error."""
        client = self._client()
        response = httpx.Response(status, json=problem, request=httpx.Request("POST", f"{_BASE_URL}/v1/validate"))
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=response))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.validate(**kwargs))  # type: ignore[arg-type]
        assert exc_info.value.status == status
        assert exc_info.value.request_url == f"{_BASE_URL}/v1/validate"
        assert str(exc_info.value) == f"API POST /v1/validate failed ({status}): {problem['detail']}"
        assert exc_info.value.problem.code == problem["code"]

    @pytest.mark.parametrize(
        "kwargs",
        [
            {},
            {"files": _FILES, "method_ref": "github.com/x/y@v1"},
            {"files": _FILES, "method_id": "mt_1"},
            {"contents": {"main.mthds": "bundle"}, "method_ref": "github.com/x/y@v1"},
            {"method_ref": "github.com/x/y@v1", "method_id": "mt_1"},
            {"method_ref": ""},
        ],
    )
    def test_exactly_one_selector_is_enforced(self, mocker: MockerFixture, kwargs: dict[str, object]) -> None:
        """The tooling routes are stateless, so there is NO linkage exception (unlike the run
        routes' tree+method_id): zero selectors and every pairing are refused client-side.
        """
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        with pytest.raises(PipelineRequestError, match="exactly one method selector"):
            asyncio.run(client.validate(**kwargs))  # type: ignore[arg-type]

        send.assert_not_called()

    def test_a_tree_in_two_forms_is_refused_before_any_request(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        with pytest.raises(
            PipelineRequestError, match=r"validate\(\) takes the method's tree in one form, files, tree or contents; got files and contents"
        ):
            asyncio.run(client.validate(_FILES, contents={"main.mthds": "bundle"}))

        send.assert_not_called()

    def test_an_empty_files_map_is_refused_before_any_request(self, mocker: MockerFixture) -> None:
        """An empty map is a tree holding no file, refused by the base's own seam, never sent as a 422 to be."""
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        with pytest.raises(PipelineRequestError, match="files holds no file"):
            asyncio.run(client.validate({}))

        send.assert_not_called()

    @pytest.mark.parametrize("wrong_typed_selector", [0, 123, [], {}, 1.5, True])
    def test_non_string_selector_raises_before_any_request(self, mocker: MockerFixture, wrong_typed_selector: object) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, json_body=_VALID_BODY)

        with pytest.raises(PipelineRequestError, match="method_ref must be a string"):
            asyncio.run(client.validate(method_ref=wrong_typed_selector))  # type: ignore[arg-type]
        with pytest.raises(PipelineRequestError, match="method_id must be a string"):
            asyncio.run(client.validate(method_id=wrong_typed_selector))  # type: ignore[arg-type]

        send.assert_not_called()
