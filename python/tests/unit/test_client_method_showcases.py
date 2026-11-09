"""Tests for a method's showcases — `freeze_method_showcase` and its verdict, `withdraw_method_showcase`, the holder's
reads (`list_method_showcases`, `get_method_showcase`), every reader's reads of a published version
(`list_method_version_showcases`, `get_method_version_showcase`) and the read of the draft's layouts
(`list_method_draft_layouts`).

The twin of `pipelex-sdk-js/tests/method-showcases.test.ts`. `_send` is mocked; the bodies are the platform's own
serialized shapes (`MethodShowcaseBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, cast

import pytest

from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.method_layout_models import MethodLayoutList
from pipelex_sdk.method_showcase_models import (
    MethodShowcaseDetail,
    MethodShowcaseFile,
    MethodShowcaseFrozen,
    MethodShowcaseList,
    MethodShowcaseRefusalReason,
    MethodShowcaseRefused,
    MethodShowcaseSummary,
    MethodShowcaseUnchanged,
    read_method_showcases,
)
from tests.unit.conftest import BASE_URL, problem_document, refused_argument
from tests.unit.test_data import MethodLayoutBodies, MethodShowcaseBodies

if TYPE_CHECKING:
    import httpx
    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import RecordingClientBuilder, ResponseBuilder, SendPatcher

_METHOD_ID = MethodShowcaseBodies.METHOD_ID
_SHOWCASE_ID = MethodShowcaseBodies.SHOWCASE_ID
_SHOWCASES_URL = f"{BASE_URL}/v1/methods/{_METHOD_ID}/showcases"
_VERSION_SHOWCASES_URL = f"{BASE_URL}/v1/methods/{_METHOD_ID}/versions/3/showcases"
_DRAFT_LAYOUTS_URL = f"{BASE_URL}/v1/methods/{_METHOD_ID}/draft/layouts"


def _sent_method(send: MockType) -> str:
    return cast("str", send.call_args.args[0])


def _sent_url(send: MockType) -> str:
    return cast("str", send.call_args.args[1])


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


def _freeze(api_client: PipelexAPIClient) -> Any:
    return api_client.freeze_method_showcase(_METHOD_ID, run_id="run_1", name="March receipt")


class TestClientMethodShowcases:
    # ----- the freeze ----------------------------------------------------------------------------

    def test_freeze_posts_the_closed_body_and_answers_the_frozen_verdict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"outcome": "frozen", "showcase": MethodShowcaseBodies.SUMMARY}))

        result = asyncio.run(_freeze(api_client))

        assert _sent_method(send) == "POST"
        assert _sent_url(send) == _SHOWCASES_URL
        assert _sent_body(send) == MethodShowcaseBodies.FREEZE
        match result:
            case MethodShowcaseFrozen():
                assert result.showcase.showcase_id == _SHOWCASE_ID
                assert result.showcase.tree_digest == MethodShowcaseBodies.DIGEST
            case _:
                pytest.fail("A frozen answer read as another arm.")

    def test_freeze_answers_unchanged_with_the_showcase_that_stands(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"outcome": "unchanged", "showcase": MethodShowcaseBodies.SUMMARY}))

        result = asyncio.run(_freeze(api_client))

        assert isinstance(result, MethodShowcaseUnchanged)
        assert result.showcase.name == "March receipt"

    @pytest.mark.parametrize("reason", list(MethodShowcaseRefusalReason))
    def test_freeze_answers_each_refusal_as_a_verdict_never_a_raise(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, reason: MethodShowcaseRefusalReason
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"outcome": "refused", "reason": reason, "message": "Why it was refused."}))

        result = asyncio.run(_freeze(api_client))

        assert isinstance(result, MethodShowcaseRefused)
        assert result.reason == reason
        assert result.message == "Why it was refused."

    def test_freeze_reads_a_refusal_this_sdk_does_not_know_as_its_raw_string(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"outcome": "refused", "reason": "a_later_reason", "message": "Later."}))

        result = asyncio.run(_freeze(api_client))

        assert isinstance(result, MethodShowcaseRefused)
        assert result.reason == "a_later_reason"

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"outcome": "maybe"}, id="unknown-outcome"),
            pytest.param({"outcome": "frozen"}, id="no-showcase"),
            pytest.param({"outcome": "unchanged", "showcase": {**MethodShowcaseBodies.SUMMARY, "name": 4}}, id="unreadable-summary"),
            pytest.param({"outcome": "refused", "message": "Why."}, id="no-reason"),
            pytest.param({"outcome": "refused", "reason": "too_many"}, id="no-message"),
        ],
    )
    def test_freeze_refuses_an_answer_it_cannot_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(_freeze(api_client))

        assert exc_info.value.problem.code == "client.response_unreadable"

    @pytest.mark.parametrize(
        ("run_id", "name", "argument", "reason"),
        [
            pytest.param(None, "n", "run_id", "not_a_string", id="no-run-id"),
            pytest.param("", "n", "run_id", "empty", id="empty-run-id"),
            pytest.param("run_1", None, "name", "not_a_string", id="no-name"),
            pytest.param("run_1", "", "name", "empty", id="empty-name"),
        ],
    )
    def test_freeze_refuses_a_run_id_or_a_name_before_any_request(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        run_id: object,
        name: object,
        argument: str,
        reason: str,
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"outcome": "frozen", "showcase": MethodShowcaseBodies.SUMMARY}))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.freeze_method_showcase(_METHOD_ID, run_id=cast("str", run_id), name=cast("str", name)))

        assert refused_argument(exc_info.value) == {"argument": argument, "reason": reason}
        send.assert_not_called()

    @pytest.mark.parametrize("key", ["f-1", None], ids=["keyed", "unkeyed"])
    def test_freeze_sends_its_key_as_the_idempotency_key_header_never_in_the_body(
        self, recording_client: RecordingClientBuilder, key: str | None
    ) -> None:
        sent: list[httpx.Request] = []
        client = recording_client(sent, 200, json_body={"outcome": "frozen", "showcase": MethodShowcaseBodies.SUMMARY})

        asyncio.run(client.freeze_method_showcase(_METHOD_ID, run_id="run_1", name="March receipt", idempotency_key=key))

        [request] = sent
        assert request.headers.get("idempotency-key") == key
        assert json.loads(request.content) == MethodShowcaseBodies.FREEZE

    def test_freeze_refuses_a_malformed_key_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"outcome": "frozen", "showcase": MethodShowcaseBodies.SUMMARY}))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.freeze_method_showcase(_METHOD_ID, run_id="run_1", name="n", idempotency_key=""))

        assert str(exc_info.value).endswith("Leave it out to freeze the showcase without one.")
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(403, "auth.forbidden", id="a-runner"),
            pytest.param(404, "pipelex.catalog.not_found", id="unknown-method"),
            pytest.param(409, "pipelex.catalog.being_deleted", id="being-erased"),
            pytest.param(422, "request.invalid", id="invalid-body"),
            pytest.param(503, "runtime.unavailable", id="past-the-deadline"),
        ],
    )
    def test_freeze_raises_each_refusal_as_its_problem(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(_freeze(api_client))

        assert exc_info.value.status == status
        assert exc_info.value.problem.code == code

    # ----- the withdrawal ------------------------------------------------------------------------

    def test_withdraw_deletes_the_showcase_and_answers_nothing(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(204))

        result = asyncio.run(api_client.withdraw_method_showcase(_METHOD_ID, _SHOWCASE_ID))

        assert result is None
        assert _sent_method(send) == "DELETE"
        assert _sent_url(send) == f"{_SHOWCASES_URL}/{_SHOWCASE_ID}"
        assert _sent_body(send) is None

    def test_withdraw_sends_its_key_as_the_idempotency_key_header(self, recording_client: RecordingClientBuilder) -> None:
        sent: list[httpx.Request] = []
        client = recording_client(sent, 204)

        asyncio.run(client.withdraw_method_showcase(_METHOD_ID, _SHOWCASE_ID, idempotency_key="w-1"))

        [request] = sent
        assert request.headers.get("idempotency-key") == "w-1"

    def test_withdraw_raises_the_404_of_a_showcase_already_withdrawn(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body=problem_document("pipelex.catalog.not_found", 404, params={"resource": "example"})))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.withdraw_method_showcase(_METHOD_ID, _SHOWCASE_ID))

        assert exc_info.value.problem.code == "pipelex.catalog.not_found"
        assert exc_info.value.problem.params is not None
        assert exc_info.value.problem.params.as_wire() == {"resource": "example"}

    # ----- the lists -----------------------------------------------------------------------------

    def test_list_method_showcases_gets_the_holders_showcases_oldest_first(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": [MethodShowcaseBodies.OLDER, MethodShowcaseBodies.SUMMARY]}))

        answer = asyncio.run(api_client.list_method_showcases(_METHOD_ID))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == _SHOWCASES_URL
        assert isinstance(answer, MethodShowcaseList)
        assert [showcase.name for showcase in answer.items] == ["February receipt", "March receipt"]

    def test_list_method_version_showcases_gets_the_tree_the_version_holds(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": [MethodShowcaseBodies.SUMMARY]}))

        answer = asyncio.run(api_client.list_method_version_showcases(_METHOD_ID, 3))

        assert _sent_url(send) == _VERSION_SHOWCASES_URL
        assert [showcase.showcase_id for showcase in answer.items] == [_SHOWCASE_ID]

    def test_a_list_leaves_out_an_entry_that_does_not_read_keeping_the_others_in_order(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        items = [MethodShowcaseBodies.OLDER, {**MethodShowcaseBodies.SUMMARY, "tree_digest": 4}, "not one", MethodShowcaseBodies.SUMMARY]
        patch_send(api_client, wire_response(200, json_body={"items": items}))

        answer = asyncio.run(api_client.list_method_showcases(_METHOD_ID))

        assert [showcase.showcase_id for showcase in answer.items] == [MethodShowcaseBodies.OLDER["showcase_id"], _SHOWCASE_ID]

    @pytest.mark.parametrize("entries", [None, "x", {"first": MethodShowcaseBodies.SUMMARY}])
    def test_read_method_showcases_reads_a_value_that_is_no_list_as_no_showcase(self, entries: object) -> None:
        assert read_method_showcases(entries) == []

    @pytest.mark.parametrize("body", [pytest.param({}, id="no-items"), pytest.param({"items": {}}, id="items-not-a-list")])
    def test_a_list_refuses_an_answer_it_cannot_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_showcases(_METHOD_ID))

        assert exc_info.value.problem.code == "client.response_unreadable"

    @pytest.mark.parametrize("version", [0, -1, True, 2.0, "3", None])
    def test_list_method_version_showcases_refuses_a_version_that_is_not_a_positive_integer(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, version: object
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": []}))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.list_method_version_showcases(_METHOD_ID, cast("int", version)))

        assert str(exc_info.value) == (
            "list_method_version_showcases() takes a version number, the published version whose showcases to read, a positive integer;"
            f" got {version!r}."
        )
        assert refused_argument(exc_info.value) == {"argument": "version", "reason": "not_a_positive_integer"}
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(404, "pipelex.catalog.not_found", id="unknown-method-or-version"),
            pytest.param(409, "pipelex.catalog.being_deleted", id="being-erased"),
        ],
    )
    def test_list_method_version_showcases_raises_each_refusal_as_its_problem(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_version_showcases(_METHOD_ID, 3))

        assert exc_info.value.status == status
        assert exc_info.value.problem.code == code

    # ----- the details ---------------------------------------------------------------------------

    def test_get_method_showcase_reads_the_showcase_in_full(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodShowcaseBodies.DETAIL))

        detail = asyncio.run(api_client.get_method_showcase(_METHOD_ID, _SHOWCASE_ID))

        assert _sent_url(send) == f"{_SHOWCASES_URL}/{_SHOWCASE_ID}"
        assert isinstance(detail, MethodShowcaseDetail)
        assert detail.document.main_stuff == {"merchant": "Corner Bakery"}
        assert detail.document.inputs["total"] == 3
        assert detail.document.inputs["rate"] == pytest.approx(3.5)
        assert detail.files[0].address == MethodShowcaseBodies.FILE["address"]
        assert detail.files[0].size_bytes == 2048

    def test_get_method_version_showcase_reads_through_the_version(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodShowcaseBodies.DETAIL))

        detail = asyncio.run(api_client.get_method_version_showcase(_METHOD_ID, 3, _SHOWCASE_ID))

        assert _sent_url(send) == f"{_VERSION_SHOWCASES_URL}/{_SHOWCASE_ID}"
        assert detail.showcase_id == _SHOWCASE_ID

    def test_a_files_link_is_left_out_of_the_models_repr(self) -> None:
        """A presigned link is a bearer credential, so printing a detail never prints one."""
        file_entry = MethodShowcaseFile.model_validate(MethodShowcaseBodies.FILE)

        assert MethodShowcaseBodies.SIGNATURE not in repr(file_entry)

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({**MethodShowcaseBodies.DETAIL, "name": 4}, id="summary-member-not-a-string"),
            pytest.param({**MethodShowcaseBodies.DETAIL, "document": "x"}, id="no-document"),
            pytest.param({**MethodShowcaseBodies.DETAIL, "document": {**MethodShowcaseBodies.DOCUMENT, "inputs": None}}, id="no-inputs"),
            pytest.param({**MethodShowcaseBodies.DETAIL, "files": {}}, id="files-not-a-list"),
            pytest.param({**MethodShowcaseBodies.DETAIL, "files": [{**MethodShowcaseBodies.FILE, "address": 4}]}, id="file-with-no-address"),
            pytest.param({**MethodShowcaseBodies.DETAIL, "files": [{**MethodShowcaseBodies.FILE, "size_bytes": -1}]}, id="file-with-a-negative-size"),
        ],
    )
    def test_a_detail_refuses_an_answer_it_cannot_read_with_its_links_redacted(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method_showcase(_METHOD_ID, _SHOWCASE_ID))

        error = exc_info.value
        assert error.problem.code == "client.response_unreadable"
        assert MethodShowcaseBodies.SIGNATURE not in (error.response_body or "")

    def test_get_method_version_showcase_raises_the_404_of_a_showcase_it_does_not_have(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body=problem_document("pipelex.catalog.not_found", 404, params={"resource": "example"})))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method_version_showcase(_METHOD_ID, 3, _SHOWCASE_ID))

        assert exc_info.value.problem.params is not None
        assert exc_info.value.problem.params.as_wire() == {"resource": "example"}

    # ----- the draft's layouts -------------------------------------------------------------------

    def test_list_method_draft_layouts_reads_them_as_a_versions_are_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        items = [MethodLayoutBodies.STORED, {**MethodLayoutBodies.STORED, "jsonl": 4}]
        send = patch_send(api_client, wire_response(200, json_body={"items": items}))

        answer = asyncio.run(api_client.list_method_draft_layouts(_METHOD_ID))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == _DRAFT_LAYOUTS_URL
        assert isinstance(answer, MethodLayoutList)
        assert [layout.catalog for layout in answer.items] == ["composer"]

    def test_list_method_draft_layouts_answers_an_empty_list_for_a_draft_none_was_designed_for(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"items": []}))

        assert asyncio.run(api_client.list_method_draft_layouts(_METHOD_ID)).items == []

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(404, "pipelex.catalog.not_found", id="a-method-it-does-not-hold"),
            pytest.param(409, "pipelex.catalog.being_deleted", id="being-erased"),
        ],
    )
    def test_list_method_draft_layouts_raises_each_refusal_as_its_problem(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_draft_layouts(_METHOD_ID))

        assert exc_info.value.status == status
        assert exc_info.value.problem.code == code

    # ----- the summary's reading --------------------------------------------------------------------

    def test_a_summary_keeps_a_field_a_later_platform_adds(self) -> None:
        summary = MethodShowcaseSummary.model_validate({**MethodShowcaseBodies.SUMMARY, "added_later": 1})

        assert summary.model_extra == {"added_later": 1}
