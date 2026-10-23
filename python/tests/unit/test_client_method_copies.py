"""Tests for a method copied into another organization and the copies a method lists — `copy_method`,
`list_method_copies`, and the `copied_from` a copy's method reads carry.

The twin of `pipelex-sdk-js/tests/method-copies.test.ts`. Most tests mock `_send` and answer with the
platform's own serialized shapes (`MethodCopyBodies`), so Pydantic's validation on the way back is part of what
runs; the idempotency key's tests send through an `httpx.MockTransport`, below the client's `_send`, so the
headers asserted are the ones on the wire.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, cast

import httpx
import pytest
from pydantic import ValidationError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, IdempotencyErrorCode, MethodErrorCode, RequestArgumentError
from pipelex_sdk.product_models import (
    MethodCopied,
    MethodCopiedFrom,
    MethodCopyLimit,
    MethodCopyMarker,
    MethodCopyRefusalReason,
    MethodCopyRefused,
)
from tests.unit.conftest import BASE_URL, problem_document, refused_argument
from tests.unit.test_data import MethodCopyBodies

if TYPE_CHECKING:
    from pytest_mock import MockType

    from tests.unit.conftest import RecordingClientBuilder, ResponseBuilder, SendPatcher

_COPY_PATH = "/v1/methods/mt_receipts01/copy"
_HEADER = "idempotency-key"


def _sent_method(send: MockType) -> str:
    return cast("str", send.call_args.args[0])


def _sent_url(send: MockType) -> str:
    return cast("str", send.call_args.args[1])


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


def _problem(status: int, code: str, **members: Any) -> dict[str, Any]:
    """A problem document as the platform renders one of its refusals of the copy."""
    return problem_document(code, status, instance=_COPY_PATH, **members)


class _ScriptedServer:
    """A server answering every request from a queue, in order, and recording each one it receives."""

    def __init__(self, *answers: httpx.Response) -> None:
        self.answers = list(answers)
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answers.pop(0)

    def client(self) -> PipelexAPIClient:
        """A client over this server, its httpx client carrying the default headers `start_client` gives it."""
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        client.client = httpx.AsyncClient(
            headers={"Authorization": "Bearer test-token", "User-Agent": client.user_agent},
            transport=httpx.MockTransport(self.handle),
        )
        return client


class TestClientMethodCopies:
    # ----- the request ---------------------------------------------------------------------------------------

    def test_copy_method_posts_the_destination_alone_and_reads_the_copied_verdict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodCopyBodies.COPIED))

        result = asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team"))

        assert _sent_method(send) == "POST"
        assert _sent_url(send) == f"{BASE_URL}{_COPY_PATH}"
        assert _sent_body(send) == {"destination_org_id": "org_team"}
        assert isinstance(result, MethodCopied)
        assert result.method.method_id == "mt_copy01"
        assert result.method.org_id == "org_team"
        assert result.method.copied_from == MethodCopiedFrom.model_validate(MethodCopyBodies.COPIED_FROM)
        assert result.method.latest_version is None
        assert result.examples_copied == 2
        assert result.stored_files_copied == 1

    def test_copy_method_sends_the_name_and_the_draft_token_when_given(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodCopyBodies.COPIED))

        asyncio.run(
            api_client.copy_method(
                "mt_receipts01",
                destination_org_id="org_personal",
                name="Receipt review (copy)",
                expected_draft_updated_at="2026-10-08T09:00:00.123456+00:00",
            )
        )

        assert _sent_body(send) == {
            "destination_org_id": "org_personal",
            "name": "Receipt review (copy)",
            "expected_draft_updated_at": "2026-10-08T09:00:00.123456+00:00",
        }

    def test_copy_method_sends_a_lone_surrogate_escaped_as_the_js_twin_does(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        # The platform refuses the name with its own `422`; the client must send it rather than fail on `to_json`.
        refusal = _problem(422, "request.invalid")
        send = patch_send(api_client, wire_response(422, json_body=refusal))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(
                api_client.copy_method(
                    "mt_receipts01", destination_org_id="org_team", name="Receipts \ud800", expected_draft_updated_at="2026-10-08\udc00"
                )
            )

        assert send.call_args.kwargs["content"] == (
            b'{"destination_org_id":"org_team","name":"Receipts \\ud800","expected_draft_updated_at":"2026-10-08\\udc00"}'
        )
        assert _sent_body(send) == {
            "destination_org_id": "org_team",
            "name": "Receipts \ud800",
            "expected_draft_updated_at": "2026-10-08\udc00",
        }
        assert exc_info.value.status == 422
        assert exc_info.value.problem.code == "request.invalid"

    @pytest.mark.parametrize(
        ("destination", "got", "reason"),
        [
            pytest.param(None, "None", "not_a_string", id="none"),
            pytest.param("", "an empty string", "empty", id="empty"),
            pytest.param(42, "int", "not_a_string", id="int"),
        ],
    )
    def test_copy_method_refuses_a_destination_that_is_not_a_non_empty_string_before_any_request(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        destination: object,
        got: str,
        reason: str,
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodCopyBodies.COPIED))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id=cast("str", destination)))

        assert str(exc_info.value) == (
            f"copy_method() takes a destination_org_id, the canonical id of the organization to copy into, a non-empty string; got {got}."
        )
        assert refused_argument(exc_info.value) == {"argument": "destination_org_id", "reason": reason}
        assert (exc_info.value.problem.code, exc_info.value.problem.domain, exc_info.value.problem.retry) == (
            "client.argument_invalid",
            "input",
            "no",
        )
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("arguments", "argument", "words"),
        [
            pytest.param({"name": 7}, "name", "a name for the copy, a string, or none; got int.", id="name"),
            pytest.param(
                {"expected_draft_updated_at": False},
                "expected_draft_updated_at",
                "an expected_draft_updated_at, the draft token the caller last read, the method's `updated_at`, a string, or none; got bool.",
                id="token",
            ),
        ],
    )
    def test_copy_method_refuses_a_name_or_token_that_is_not_a_string_before_any_request(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        arguments: dict[str, Any],
        argument: str,
        words: str,
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodCopyBodies.COPIED))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team", **arguments))

        assert str(exc_info.value) == f"copy_method() takes {words}"
        assert refused_argument(exc_info.value) == {"argument": argument, "reason": "not_a_string"}
        send.assert_not_called()

    def test_copy_method_takes_its_destination_by_keyword_only(self, api_client: PipelexAPIClient) -> None:
        with pytest.raises(TypeError):
            asyncio.run(api_client.copy_method("mt_receipts01", "org_team"))  # type: ignore[misc]  # pyright: ignore[reportCallIssue]

    # ----- the idempotency key ---------------------------------------------------------------------------------

    def test_copy_method_sends_the_key_as_the_idempotency_key_header_never_in_the_body(self, recording_client: RecordingClientBuilder) -> None:
        sent: list[httpx.Request] = []
        client = recording_client(sent, 200, json_body=MethodCopyBodies.COPIED)

        asyncio.run(client.copy_method("mt_receipts01", destination_org_id="org_team", idempotency_key=MethodCopyBodies.KEY))

        [request] = sent
        assert request.method == "POST"
        assert str(request.url) == f"{BASE_URL}{_COPY_PATH}"
        assert request.headers[_HEADER] == MethodCopyBodies.KEY
        assert request.headers["content-type"] == "application/json"
        assert request.headers["accept"] == "application/json"
        assert json.loads(request.content) == {"destination_org_id": "org_team"}

    def test_a_keyed_copy_carries_the_headers_of_an_unkeyed_one_plus_the_key(self) -> None:
        server = _ScriptedServer(httpx.Response(200, json=MethodCopyBodies.COPIED), httpx.Response(200, json=MethodCopyBodies.COPIED))
        client = server.client()

        async def scenario() -> None:
            await client.copy_method("mt_receipts01", destination_org_id="org_team")
            await client.copy_method("mt_receipts01", destination_org_id="org_team", idempotency_key=MethodCopyBodies.KEY)

        asyncio.run(scenario())

        unkeyed, keyed = (dict(request.headers) for request in server.requests)
        assert _HEADER not in unkeyed
        assert keyed.pop(_HEADER) == MethodCopyBodies.KEY
        assert keyed == unkeyed

    def test_copy_method_sends_the_same_key_and_body_on_a_callers_retry(self) -> None:
        server = _ScriptedServer(
            httpx.Response(503, json=_problem(503, "runtime.unavailable", domain="runtime", retry="yes")),
            httpx.Response(200, json=MethodCopyBodies.COPIED),
        )
        client = server.client()

        async def scenario() -> object:
            with pytest.raises(ApiResponseError) as exc_info:
                await client.copy_method("mt_receipts01", destination_org_id="org_team", name="Receipts", idempotency_key=MethodCopyBodies.KEY)
            assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("runtime", "yes")
            return await client.copy_method("mt_receipts01", destination_org_id="org_team", name="Receipts", idempotency_key=MethodCopyBodies.KEY)

        result = asyncio.run(scenario())

        assert isinstance(result, MethodCopied)
        first, retry = server.requests
        assert first.headers[_HEADER] == retry.headers[_HEADER] == MethodCopyBodies.KEY
        assert first.content == retry.content

    def test_the_key_is_set_only_around_the_copy(self) -> None:
        """The key rides the copy's one request: a request the same client sends afterwards carries none."""
        server = _ScriptedServer(
            httpx.Response(200, json=MethodCopyBodies.COPIED),
            httpx.Response(200, json={"items": [], "next_cursor": None}),
        )
        client = server.client()

        async def scenario() -> None:
            await client.copy_method("mt_receipts01", destination_org_id="org_team", idempotency_key=MethodCopyBodies.KEY)
            await client.list_method_copies("mt_receipts01")

        asyncio.run(scenario())

        assert [_HEADER in request.headers for request in server.requests] == [True, False]

    @pytest.mark.parametrize(
        ("key", "fault"),
        [
            pytest.param("", "this one is empty", id="empty"),
            pytest.param("copy 42", "this one holds a character outside visible ASCII", id="space"),
            pytest.param("k" * 256, "this one is 256 characters long", id="too-long"),
            pytest.param(42, "this one is not a string", id="int"),
        ],
    )
    def test_copy_method_refuses_a_malformed_key_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, key: object, fault: str
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodCopyBodies.COPIED))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team", idempotency_key=cast("str", key)))

        message = str(exc_info.value)
        assert fault in message
        assert "1 to 255 visible ASCII characters" in message
        assert message.endswith("Leave it out to copy the method without one.")
        assert (exc_info.value.problem.code, exc_info.value.problem.domain, exc_info.value.problem.retry) == (
            "client.argument_invalid",
            "input",
            "no",
        )
        send.assert_not_called()

    def test_copy_method_reads_a_key_an_earlier_copy_still_holds_as_worth_sending_again(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = _problem(409, "request.idempotency_key_in_use", domain="runtime", retry="yes")
        patch_send(api_client, wire_response(409, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team", idempotency_key=MethodCopyBodies.KEY))

        assert exc_info.value.problem.code == IdempotencyErrorCode.KEY_IN_USE
        assert exc_info.value.problem.retry == "yes"

    # ----- the verdict -----------------------------------------------------------------------------------------

    def test_copy_method_reads_a_refusal_naming_every_reference(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=MethodCopyBodies.REFUSED))

        result = asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team"))

        assert isinstance(result, MethodCopyRefused)
        assert result.reason == MethodCopyRefusalReason.BUNDLE_NAMES_OTHER_STORAGE
        assert result.message == MethodCopyBodies.REFUSED["message"]
        assert [(reference.path, reference.uri) for reference in result.references] == [
            ("main.mthds", "pipelex-storage://org_personal/assets/logo.png")
        ]

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"method": MethodCopyBodies.COPY, "examples_copied": 0, "stored_files_copied": 0}, id="no-outcome"),
            pytest.param({"outcome": "queued", "method": MethodCopyBodies.COPY}, id="unknown-outcome"),
            pytest.param({"outcome": "copied", "examples_copied": 0, "stored_files_copied": 0}, id="no-method"),
            pytest.param({**MethodCopyBodies.REFUSED, "references": "main.mthds"}, id="references-not-a-list"),
            pytest.param({**MethodCopyBodies.REFUSED, "reason": "late"}, id="unknown-reason"),
        ],
    )
    def test_copy_method_refuses_an_answer_off_the_union(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        """A body that names no known outcome, or breaks its arm, is never mistaken for a verdict."""
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team"))

        unreadable = exc_info.value
        assert str(unreadable) == f"API POST {_COPY_PATH} answered 200 with a body that is not the answer the route returns"
        assert isinstance(unreadable.__cause__, ValidationError)
        assert (unreadable.problem.code, unreadable.problem.domain, unreadable.problem.retry) == ("client.response_unreadable", "runtime", "no")

    # ----- the refusals ----------------------------------------------------------------------------------------

    @pytest.mark.parametrize(
        ("status", "code", "domain", "retry"),
        [
            pytest.param(403, "auth.forbidden", "account", "no", id="not-a-web-session"),
            pytest.param(403, "auth.forbidden", "account", "no", id="role"),
            pytest.param(404, MethodErrorCode.ORGANIZATION_NOT_FOUND, "input", "no", id="destination"),
            pytest.param(404, MethodErrorCode.NOT_FOUND, "input", "no", id="unknown-method"),
            pytest.param(409, MethodErrorCode.BEING_DELETED, "input", "no", id="being-deleted"),
            pytest.param(409, MethodErrorCode.UPDATE_CONFLICT, "input", "no", id="stale-token"),
            pytest.param(413, "request.too_large", "input", "no", id="too-large-for-an-item"),
            pytest.param(422, "request.invalid", "input", "no", id="body"),
            pytest.param(502, "runtime.unavailable", "runtime", "yes", id="workos"),
            pytest.param(503, "pipelex.storage.unavailable", "runtime", "yes", id="storage"),
            pytest.param(503, "runtime.unavailable", "runtime", "yes", id="deadline"),
        ],
    )
    def test_copy_method_raises_each_refusal_with_its_problem(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        status: int,
        code: str,
        domain: str,
        retry: str,
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=_problem(status, code, domain=domain, retry=retry)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team"))

        assert exc_info.value.status == status
        assert (exc_info.value.problem.code, exc_info.value.problem.domain, exc_info.value.problem.retry) == (code, domain, retry)

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(404, "request.not_found", id="a-404"),
            pytest.param(403, "auth.invalid_credential", id="a-403"),
            pytest.param(422, "client.response_unreadable", id="a-422"),
        ],
    )
    def test_copy_method_reads_a_body_that_is_no_problem_document_by_its_status(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body={"status": status, "code": "organization_not_found", "detail": "Refused."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team"))

        assert exc_info.value.problem.code == code

    def test_copy_method_reads_a_copy_past_its_bounds_with_the_limit_it_names(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = _problem(422, MethodErrorCode.COPY_TOO_LARGE, limit=MethodCopyBodies.LIMIT)
        patch_send(api_client, wire_response(422, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.copy_method("mt_receipts01", destination_org_id="org_team"))

        refused = exc_info.value
        assert refused.problem.code == MethodErrorCode.COPY_TOO_LARGE
        limit = MethodCopyLimit.model_validate((refused.problem.model_extra or {})["limit"])
        assert limit == MethodCopyLimit(name="max_stored_files", value=200, reached=201)
        assert (refused.problem.domain, refused.problem.retry) == ("input", "no")

    # ----- the copies of a method ------------------------------------------------------------------------------

    def test_list_method_copies_reads_a_page_of_markers(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": [MethodCopyBodies.MARKER], "next_cursor": "c2"}))

        page = asyncio.run(api_client.list_method_copies("mt_receipts01"))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/copies"
        assert page.items == [MethodCopyMarker.model_validate(MethodCopyBodies.MARKER)]
        assert page.items[0].destination_org_id == "org_team"
        assert page.next_cursor == "c2"

    @pytest.mark.parametrize(
        ("limit", "cursor", "query"),
        [
            pytest.param(5, "c1", "?limit=5&cursor=c1", id="both"),
            pytest.param(None, "", "?cursor=", id="empty-cursor"),
            pytest.param(None, None, "", id="neither"),
        ],
    )
    def test_list_method_copies_passes_the_limit_and_cursor(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        limit: int | None,
        cursor: str | None,
        query: str,
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": [], "next_cursor": None}))

        page = asyncio.run(api_client.list_method_copies("mt_receipts01", limit=limit, cursor=cursor))

        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/copies{query}"
        assert page.items == []
        assert page.next_cursor is None

    def test_list_method_copies_follows_the_cursor_to_the_last_page(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        second = {**MethodCopyBodies.MARKER, "copy_method_id": "mt_copy02"}
        patch_send(
            api_client,
            wire_response(200, json_body={"items": [MethodCopyBodies.MARKER], "next_cursor": "c2"}),
            wire_response(200, json_body={"items": [second], "next_cursor": None}),
        )

        async def scenario() -> list[str]:
            first = await api_client.list_method_copies("mt_receipts01", limit=1)
            assert first.next_cursor is not None
            last = await api_client.list_method_copies("mt_receipts01", limit=1, cursor=first.next_cursor)
            assert last.next_cursor is None
            return [marker.copy_method_id for marker in [*first.items, *last.items]]

        assert asyncio.run(scenario()) == ["mt_copy01", "mt_copy02"]

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(404, MethodErrorCode.NOT_FOUND, id="unknown-method"),
            pytest.param(409, MethodErrorCode.BEING_DELETED, id="being-deleted"),
            pytest.param(422, "request.invalid", id="foreign-cursor"),
            pytest.param(422, "request.invalid", id="limit"),
        ],
    )
    def test_list_method_copies_raises_each_refusal_with_its_problem(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status, detail="Refused.")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_copies("mt_receipts01"))

        assert (exc_info.value.problem.code, exc_info.value.problem.domain, exc_info.value.problem.retry) == (code, "input", "no")

    def test_list_method_copies_refuses_a_page_without_its_cursor(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """A page missing `next_cursor` is an answer the SDK cannot read, never a last page."""
        patch_send(api_client, wire_response(200, json_body={"items": [MethodCopyBodies.MARKER]}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_copies("mt_receipts01"))

        assert str(exc_info.value) == "API GET /v1/methods/mt_receipts01/copies answered 200 with a body that is not the answer the route returns"

    # ----- copied_from on a method read ------------------------------------------------------------------------

    def test_a_method_read_carries_the_original_a_copy_names_and_none_on_a_fresh_one(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        fresh = {key: value for key, value in MethodCopyBodies.COPY.items() if key != "copied_from"}
        patch_send(
            api_client,
            wire_response(200, json_body={**MethodCopyBodies.COPY, "files": []}),
            wire_response(200, json_body={**MethodCopyBodies.COPY, "copied_from": None, "files": []}),
            wire_response(200, json_body={**fresh, "files": []}),
        )

        async def scenario() -> list[MethodCopiedFrom | None]:
            copy = await api_client.get_method("mt_copy01")
            null_one = await api_client.get_method("mt_copy01")
            absent_one = await api_client.get_method("mt_copy01")
            return [copy.copied_from, null_one.copied_from, absent_one.copied_from]

        copied_from, null_one, absent_one = asyncio.run(scenario())

        assert copied_from == MethodCopiedFrom(org_id="org_personal", method_id="mt_receipts01", draft_digest=MethodCopyBodies.DIGEST)
        assert null_one is None
        assert absent_one is None

    def test_copied_from_reads_an_empty_draft_as_a_null_digest(self) -> None:
        copied_from = MethodCopiedFrom.model_validate({"org_id": "org_personal", "method_id": "mt_receipts01", "draft_digest": None})

        assert copied_from.draft_digest is None
