"""Tests for the problem `ApiResponseError` carries off a refusal, driven through a product route."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError
from tests.unit.conftest import problem_document

if TYPE_CHECKING:
    from pytest_mock import MockerFixture

_BASE_URL = "http://localhost:8081"

# A request-validation 422 as the platform renders it: a core code, the request id in the body, and the
# fields its validation refused as problem items.
_PLATFORM_422: dict[str, Any] = problem_document(
    "request.malformed",
    422,
    request_id="req-422",
    errors=[{"code": "request.malformed", "detail": "String should have at most 64 characters", "location": {"field": "label"}}],
)

# A refusal under a Pipelex extension code, with a member the standard does not name.
_ARCHIVE_TOO_LARGE: dict[str, Any] = problem_document("pipelex.files.archive_too_large", 422, limit="max_files")


def _response(status_code: int, *, json_body: object | None = None, text: str | None = None, headers: dict[str, str] | None = None) -> httpx.Response:
    request = httpx.Request("GET", f"{_BASE_URL}/x")
    if json_body is not None:
        return httpx.Response(status_code, json=json_body, headers=headers or {}, request=request)
    return httpx.Response(status_code, text=text or "", headers=headers or {}, request=request)


class TestApiResponseError:
    def _raise_from(self, mocker: MockerFixture, response: httpx.Response) -> ApiResponseError:
        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=response))
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.get_subscription())
        return exc_info.value

    def test_reads_a_problem_document_as_received(self, mocker: MockerFixture) -> None:
        err = self._raise_from(mocker, _response(422, json_body=_PLATFORM_422, headers={"X-Request-ID": "req-422"}))

        assert err.status == 422
        assert err.problem.as_wire() == _PLATFORM_422
        assert err.problem.code == "request.malformed"
        assert (err.problem.domain, err.problem.retry) == ("input", "no")
        assert [(item.detail, item.location.field if item.location is not None else None) for item in err.problem.errors or []] == [
            ("String should have at most 64 characters", "label"),
        ]
        assert err.request_id == "req-422"
        assert str(err) == "API GET /v1/billing/subscription failed (422): The detail of request.malformed."

    def test_keeps_a_pipelex_code_and_the_members_the_standard_does_not_name(self, mocker: MockerFixture) -> None:
        err = self._raise_from(mocker, _response(422, json_body=_ARCHIVE_TOO_LARGE))

        assert err.problem.code == "pipelex.files.archive_too_large"
        assert (err.problem.model_extra or {})["limit"] == "max_files"

    def test_the_message_carries_no_next_step(self, mocker: MockerFixture) -> None:
        err = self._raise_from(mocker, _response(422, json_body=_PLATFORM_422))

        assert "Next step" not in str(err)
        assert err.problem.next_step.detail == "The next step of request.malformed."

    def test_request_id_falls_back_to_the_header(self, mocker: MockerFixture) -> None:
        body = {key: value for key, value in _PLATFORM_422.items() if key != "request_id"}
        err = self._raise_from(mocker, _response(422, json_body=body, headers={"X-Request-ID": "req-from-header"}))

        assert err.request_id == "req-from-header"

    def test_request_id_from_the_header_when_the_body_is_not_a_problem(self, mocker: MockerFixture) -> None:
        err = self._raise_from(mocker, _response(502, text="Bad Gateway", headers={"X-Request-ID": "req-edge"}))

        assert err.request_id == "req-edge"
        assert err.response_body == "Bad Gateway"

    def test_body_request_id_wins_over_the_header(self, mocker: MockerFixture) -> None:
        err = self._raise_from(mocker, _response(422, json_body=_PLATFORM_422, headers={"X-Request-ID": "req-other"}))

        assert err.request_id == "req-422"

    @pytest.mark.parametrize(
        ("response", "code", "retry"),
        [
            (_response(401, json_body={"message": "Unauthorized"}), "auth.missing_credential", "no"),
            (_response(403, json_body={"message": "Forbidden"}), "auth.invalid_credential", "no"),
            (_response(404, json_body={"detail": "Not Found"}), "request.not_found", "no"),
            (_response(500, text="Internal Server Error"), "runtime.unexpected", "no"),
            (_response(502, text="<html>Bad Gateway</html>"), "runtime.unavailable", "yes"),
            (_response(503, text=""), "runtime.unavailable", "yes"),
            (_response(504, json_body={"message": "Endpoint request timed out"}), "runtime.unavailable", "yes"),
            (_response(405, text=""), "request.method_not_allowed", "no"),
            (_response(409, json_body={"code": "conflict", "detail": "x"}), "client.response_unreadable", "no"),
        ],
    )
    def test_reads_a_body_that_is_no_problem_document_by_the_edges_rules(
        self, mocker: MockerFixture, response: httpx.Response, code: str, retry: str
    ) -> None:
        err = self._raise_from(mocker, response)

        assert err.problem.code == code
        assert err.problem.retry == retry
        assert err.response_body == response.text

    def test_reads_an_edge_throttle_as_runtime_unavailable_with_its_retry_after(self, mocker: MockerFixture) -> None:
        err = self._raise_from(mocker, _response(429, json_body={"message": "Too Many Requests"}, headers={"Retry-After": "12"}))

        assert err.problem.code == "runtime.unavailable"
        assert err.problem.retry_after == 12

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({**problem_document("request.malformed", 422), "retry": 5}, id="retry-not-a-string"),
            pytest.param({**problem_document("request.malformed", 422), "next_step": None}, id="next-step-null"),
            pytest.param({**problem_document("request.malformed", 422), "code": "NotACode"}, id="code-off-the-pattern"),
            pytest.param(
                {"detail": "x", "retryable": False, "error_domain": "input", "user_action": {"kind": "retry", "detail": "y"}}, id="old-shape"
            ),
        ],
    )
    def test_a_document_that_breaks_the_standard_is_read_by_its_status(self, mocker: MockerFixture, body: dict[str, Any]) -> None:
        err = self._raise_from(mocker, _response(422, json_body=body))

        assert err.problem.code == "client.response_unreadable"
        assert err.response_body == json.dumps(body, separators=(",", ":"))

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param("[" * 100_000 + "]" * 100_000, id="nested-past-the-limit"),
            pytest.param('{"code": "request.malformed", "detail": "x", "retry_after": NaN}', id="nan"),
            pytest.param('{"code": "request.malformed", "detail": "x", "retry_after": Infinity}', id="infinity"),
            pytest.param('{"code": "request.malformed", "detail": "x", "retry_after": 1e999}', id="past-a-double"),
        ],
    )
    def test_a_body_the_protocol_does_not_read_as_json_is_read_by_its_status(self, mocker: MockerFixture, body: str) -> None:
        """Decoded by the base's guarded decoder: never a bare `RecursionError`, never a `NaN` read."""
        err = self._raise_from(mocker, _response(409, text=body))

        assert err.response_body == body
        assert err.problem.code == "client.response_unreadable"

    @pytest.mark.parametrize(
        ("response", "reason"),
        [
            (
                _response(409, json_body=problem_document("request.idempotency_conflict", 409, detail="The key was used before.")),
                "The key was used before.",
            ),
            (_response(502, text="<html>Bad Gateway</html>"), "<html>Bad Gateway</html>"),
            (_response(502, text="x" * 600), "x" * 500 + "…"),
            (_response(503, text="   "), "Service Unavailable"),
        ],
    )
    def test_the_reason_is_the_problems_detail_else_the_body_else_the_status_text(
        self, mocker: MockerFixture, response: httpx.Response, reason: str
    ) -> None:
        err = self._raise_from(mocker, response)

        assert str(err) == f"API GET /v1/billing/subscription failed ({response.status_code}): {reason}"

    def test_headers_and_request_url_are_kept_as_plain_data(self, mocker: MockerFixture) -> None:
        err = self._raise_from(mocker, _response(429, json_body={"detail": "slow down"}, headers={"Retry-After": "12"}))

        assert err.headers["retry-after"] == "12"
        assert err.request_url == f"{_BASE_URL}/v1/billing/subscription"
        assert err.api_url == _BASE_URL
