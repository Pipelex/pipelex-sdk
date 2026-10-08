"""Tests for a saved method's draft and published versions — `write_draft`, `rename_method`, `publish_method`,
`list_method_versions`, `get_method_version`, and the version a run ran.

The twin of `pipelex-sdk-js/tests/method-versions.test.ts`. `_send` is mocked; the bodies are the platform's
own serialized shapes (`MethodVersionBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, cast

import pytest
from mthds.protocol.exceptions import PipelineRequestError
from pydantic import ValidationError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, MethodErrorCode
from pipelex_sdk.product_models import (
    MethodData,
    MethodDraftInput,
    MethodFile,
    MethodPublished,
    MethodPublishOutcome,
    MethodPublishRefusalReason,
    MethodPublishRefused,
    MethodPublishUnchanged,
    MethodVersion,
    PipelineRun,
    RunDetail,
    RunHistoryItem,
    RunPage,
)
from pipelex_sdk.runs import PipelexRunResultStart, RunRead
from pipelex_sdk.validation_models import PipelexInvalidReport, PipelexValidationReport
from tests.unit.conftest import BASE_URL
from tests.unit.test_data import MethodVersionBodies

if TYPE_CHECKING:
    from pytest_mock import MockType

    from tests.unit.conftest import ResponseBuilder, SendPatcher


def _sent_method(send: MockType) -> str:
    return cast("str", send.call_args.args[0])


def _sent_url(send: MockType) -> str:
    return cast("str", send.call_args.args[1])


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


def _valid_verdict() -> dict[str, Any]:
    """A valid `POST /v1/validate` verdict with pending signatures, as a `not_runnable` refusal carries it."""
    return {
        "is_valid": True,
        "bundle_blueprint": {"domain": "receipts"},
        "pipe_structures": {},
        "pending_signatures": ["review"],
        "is_runnable": False,
        "message": "The bundle is valid but does not run yet.",
    }


class TestClientMethodVersions:
    # ----- the method read ---------------------------------------------------------------------

    def test_a_method_read_carries_its_draft_digest_and_latest_published_version(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        method = asyncio.run(api_client.get_method("mt_receipts01"))

        assert method.updated_at == MethodVersionBodies.TOKEN
        assert method.draft_digest == MethodVersionBodies.DIGEST
        assert method.latest_version == 3
        assert method.latest_published is not None
        assert method.latest_published.version == 3
        assert method.latest_published.source_digest == MethodVersionBodies.DIGEST
        assert method.latest_published.crate_fingerprint == "a1b2c3"
        assert method.python == [MethodFile(name="helper.py", content="x = 1")]

    def test_a_method_never_published_reads_with_no_version(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.NEVER_PUBLISHED))

        method = asyncio.run(api_client.get_method("mt_receipts01"))

        assert method.latest_version is None
        assert method.latest_published is None

    def test_a_method_without_its_draft_digest_does_not_parse(self) -> None:
        """`draft_digest` is required: a server that predates versions is not read as a method with no draft."""
        body = {key: value for key, value in MethodVersionBodies.METHOD.items() if key != "draft_digest"}

        with pytest.raises(ValidationError, match="draft_digest"):
            MethodData.model_validate(body)

    def test_update_method_is_gone(self) -> None:
        """The whole-method `PUT /v1/methods/{id}` is replaced by `write_draft` and `rename_method`."""
        assert not hasattr(PipelexAPIClient, "update_method")

    # ----- write_draft -------------------------------------------------------------------------

    def test_write_draft_puts_the_draft_with_its_token(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))
        draft = MethodDraftInput(
            mthds="src",
            python=[MethodFile(name="helper.py", content="x = 1")],
            input_data={"total": 1},
            expected_updated_at=MethodVersionBodies.TOKEN,
        )

        method = asyncio.run(api_client.write_draft("mt_receipts01", draft))

        assert _sent_method(send) == "PUT"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/draft"
        assert _sent_body(send) == {
            "mthds": "src",
            "python": '[{"name": "helper.py", "content": "x = 1"}]',
            "input_data": {"total": 1},
            "expected_updated_at": MethodVersionBodies.TOKEN,
        }
        assert method.draft_digest == MethodVersionBodies.DIGEST

    def test_write_draft_sends_only_what_was_set(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        """An unset field keeps the stored value; an unset token is a last-writer-wins write."""
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(mthds="src")))

        assert _sent_body(send) == {"mthds": "src"}

    def test_write_draft_sends_an_explicit_none_input_data_to_clear_it(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(mthds="src", input_data=None)))

        assert _sent_body(send) == {"mthds": "src", "input_data": None}

    def test_write_draft_encodes_the_id(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        asyncio.run(api_client.write_draft("a/b", MethodDraftInput(mthds="src")))

        assert _sent_url(send) == f"{BASE_URL}/v1/methods/a%2Fb/draft"

    def test_a_stale_draft_token_raises_the_update_conflict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {
            "type": "https://docs.pipelex.com/errors/method-update-conflict",
            "title": "Method update conflict",
            "status": 409,
            "detail": "The draft changed since you loaded it.",
            "code": "method_update_conflict",
            "errors": [{"field": "expected_updated_at", "code": "method_update_conflict", "detail": "stale"}],
        }
        patch_send(api_client, wire_response(409, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(mthds="src", expected_updated_at="old")))

        assert exc_info.value.status == 409
        assert exc_info.value.code == MethodErrorCode.METHOD_UPDATE_CONFLICT
        assert exc_info.value.errors is not None
        assert exc_info.value.errors[0].field == "expected_updated_at"

    # ----- rename_method -----------------------------------------------------------------------

    def test_rename_method_patches_the_name_alone(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={**MethodVersionBodies.METHOD, "name": "Renamed"}))

        method = asyncio.run(api_client.rename_method("mt_receipts01", "Renamed"))

        assert _sent_method(send) == "PATCH"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01"
        assert _sent_body(send) == {"name": "Renamed"}
        assert method.name == "Renamed"
        # A rename moves no token.
        assert method.updated_at == MethodVersionBodies.TOKEN

    # ----- publish_method ----------------------------------------------------------------------

    def test_publish_method_posts_the_token_and_reads_a_published_version(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {"outcome": "published", "version": MethodVersionBodies.SUMMARY, "method": MethodVersionBodies.METHOD}
        send = patch_send(api_client, wire_response(200, json_body=body))

        result = asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=MethodVersionBodies.TOKEN))

        assert _sent_method(send) == "POST"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/publish"
        assert _sent_body(send) == {"expected_draft_updated_at": MethodVersionBodies.TOKEN}
        assert isinstance(result, MethodPublished)
        assert result.outcome == MethodPublishOutcome.PUBLISHED
        assert result.version.version == 3
        assert result.method.latest_version == 3

    def test_publish_method_reads_an_unchanged_draft(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {"outcome": "unchanged", "version": MethodVersionBodies.SUMMARY, "method": MethodVersionBodies.METHOD}
        patch_send(api_client, wire_response(200, json_body=body))

        result = asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=MethodVersionBodies.TOKEN))

        assert isinstance(result, MethodPublishUnchanged)
        assert result.version.source_digest == result.method.draft_digest

    def test_publish_method_reads_an_invalid_refusal_with_the_runner_verdict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {
            "outcome": "refused",
            "reason": "invalid",
            "message": "The draft does not validate.",
            "validation": MethodVersionBodies.INVALID_VERDICT,
            "method": MethodVersionBodies.NEVER_PUBLISHED,
        }
        patch_send(api_client, wire_response(200, json_body=body))

        result = asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=MethodVersionBodies.TOKEN))

        assert isinstance(result, MethodPublishRefused)
        assert result.reason == MethodPublishRefusalReason.INVALID
        assert isinstance(result.validation, PipelexInvalidReport)
        assert result.validation.validation_errors[0].message == "Pipe 'review' has no output."
        assert result.method.latest_version is None

    def test_publish_method_reads_a_not_runnable_refusal_with_the_valid_verdict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {
            "outcome": "refused",
            "reason": "not_runnable",
            "message": "The draft is valid but does not run yet.",
            "validation": _valid_verdict(),
            "method": MethodVersionBodies.METHOD,
        }
        patch_send(api_client, wire_response(200, json_body=body))

        result = asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=MethodVersionBodies.TOKEN))

        assert isinstance(result, MethodPublishRefused)
        assert result.reason == MethodPublishRefusalReason.NOT_RUNNABLE
        assert isinstance(result.validation, PipelexValidationReport)
        assert result.validation.pending_signatures == ["review"]

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"version": MethodVersionBodies.SUMMARY, "method": MethodVersionBodies.METHOD}, id="no-outcome"),
            pytest.param({"outcome": "skipped", "version": MethodVersionBodies.SUMMARY, "method": MethodVersionBodies.METHOD}, id="unknown-outcome"),
            pytest.param({"outcome": "published", "version": MethodVersionBodies.SUMMARY}, id="no-method"),
            pytest.param({"outcome": "refused", "reason": "late", "message": "m", "validation": {}, "method": {}}, id="unknown-reason"),
        ],
    )
    def test_publish_method_refuses_an_answer_off_the_union(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        """A body that names no known outcome, or breaks its arm, is never mistaken for a verdict."""
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ValidationError):
            asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=MethodVersionBodies.TOKEN))

    def test_publish_method_raises_the_update_conflict_for_a_stale_token(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """A stale token produces no verdict about the content, so it raises instead of answering an outcome."""
        patch_send(api_client, wire_response(409, json_body={"status": 409, "code": "method_update_conflict"}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at="old"))

        assert exc_info.value.code == MethodErrorCode.METHOD_UPDATE_CONFLICT

    @pytest.mark.parametrize(
        ("token", "type_name"),
        [
            pytest.param(None, "NoneType", id="none"),
            pytest.param(5, "int", id="int"),
            pytest.param(datetime(2026, 10, 1, 9, tzinfo=UTC), "datetime", id="datetime"),
        ],
    )
    def test_publish_method_refuses_a_token_that_is_not_a_string_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, token: object, type_name: str
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"outcome": "unchanged"}))

        with pytest.raises(PipelineRequestError, match=rf"needs expected_draft_updated_at: .*; got {type_name}\.$"):
            asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=cast("str", token)))

        send.assert_not_called()

    def test_publish_method_takes_its_token_by_keyword_only(self, api_client: PipelexAPIClient) -> None:
        with pytest.raises(TypeError):
            asyncio.run(api_client.publish_method("mt_receipts01", MethodVersionBodies.TOKEN))  # type: ignore[misc]  # pyright: ignore[reportCallIssue]

    # ----- list_method_versions ----------------------------------------------------------------

    def test_list_method_versions_reads_a_page_of_summaries(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        older = {**MethodVersionBodies.SUMMARY, "version": 2, "source_digest": MethodVersionBodies.OTHER_DIGEST, "crate_fingerprint": None}
        body = {"items": [MethodVersionBodies.SUMMARY, older], "next_cursor": "c/2"}
        send = patch_send(api_client, wire_response(200, json_body=body))

        page = asyncio.run(api_client.list_method_versions("mt_receipts01"))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/versions"
        assert [summary.version for summary in page.items] == [3, 2]
        assert page.items[1].crate_fingerprint is None
        assert page.next_cursor == "c/2"

    def test_list_method_versions_passes_the_limit_and_cursor(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": [], "next_cursor": None}))

        page = asyncio.run(api_client.list_method_versions("mt_receipts01", limit=5, cursor="c/2"))

        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/versions?limit=5&cursor=c%2F2"
        assert page.items == []
        assert page.next_cursor is None

    # ----- get_method_version ------------------------------------------------------------------

    def test_get_method_version_reads_one_version_with_its_sources(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.VERSION))

        version = asyncio.run(api_client.get_method_version("mt_receipts01", 3))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/versions/3"
        assert isinstance(version, MethodVersion)
        assert version.method_id == "mt_receipts01"
        assert version.mthds == "domain = 'receipts'"
        assert version.python == [MethodFile(name="helper.py", content="x = 1")]
        assert version.published_by == "user_1"

    @pytest.mark.parametrize("version", [0, -1, True, 2.0, 1.5, float("nan"), "3", None])
    def test_get_method_version_refuses_a_value_that_names_no_version_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, version: object
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.VERSION))

        with pytest.raises(PipelineRequestError, match="positive integer"):
            asyncio.run(api_client.get_method_version("mt_receipts01", cast("int", version)))

        send.assert_not_called()

    def test_get_method_version_raises_the_version_not_found(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body={"status": 404, "code": "method_version_not_found"}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method_version("mt_receipts01", 9))

        assert exc_info.value.status == 404
        assert exc_info.value.code == MethodErrorCode.METHOD_VERSION_NOT_FOUND

    # ----- the error codes ---------------------------------------------------------------------

    def test_the_method_error_codes_are_the_platform_wire_strings(self) -> None:
        assert [code.value for code in MethodErrorCode] == [
            "method_update_conflict",
            "method_being_deleted",
            "method_not_published",
            "method_version_not_found",
        ]

    def test_a_bare_id_of_a_method_never_published_raises_not_published(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {"status": 409, "code": "method_not_published", "detail": "Publish the method, or run mt_receipts01@draft."}
        patch_send(api_client, wire_response(409, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.start(method_id="mt_receipts01"))

        assert exc_info.value.code == MethodErrorCode.METHOD_NOT_PUBLISHED

    # ----- the version a run ran ---------------------------------------------------------------

    def test_start_passes_a_selector_through_and_reads_the_version_it_runs(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        ack = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-10-08T00:00:00Z", "method_version": "draft"}
        send = patch_send(api_client, wire_response(202, json_body=ack))

        started = asyncio.run(api_client.start(method_id="mt_receipts01@draft"))

        assert _sent_body(send)["method_id"] == "mt_receipts01@draft"
        assert isinstance(started, PipelexRunResultStart)
        assert started.method_version == "draft"

    def test_the_start_ack_of_a_server_without_versions_reads_no_version(self) -> None:
        ack = PipelexRunResultStart.model_validate({"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "t"})

        assert ack.method_version is None

    def test_a_run_status_carries_its_version_and_digest(self) -> None:
        run = RunRead.model_validate(
            {"pipeline_run_id": "run_1", "status": "COMPLETED", "created_at": "t", "method_version": 3, "source_digest": MethodVersionBodies.DIGEST}
        )

        assert run.method_version == 3
        assert run.source_digest == MethodVersionBodies.DIGEST

    def test_run_records_read_the_version_fields_when_present_and_absent(self) -> None:
        base: dict[str, Any] = {"pipeline_run_id": "run_1", "pipe_code": "review", "status": "COMPLETED", "created_at": "t"}
        record: dict[str, Any] = {**base, "org_id": "org_1", "created_by_user_id": "u1", "method_id": "mt_receipts01", "workflow_id": "w"}

        history = RunHistoryItem.model_validate({**base, "method_version": "draft", "source_digest": MethodVersionBodies.DIGEST})
        assert history.method_version == "draft"
        assert history.source_digest == MethodVersionBodies.DIGEST

        assert RunHistoryItem.model_validate(base).method_version is None
        assert PipelineRun.model_validate({**record, "method_version": 2}).method_version == 2
        assert RunDetail.model_validate({**record, "method_version": None}).method_version is None
        assert RunPage.model_validate({"items": [{**base, "method_version": 1}], "next_cursor": None}).items[0].method_version == 1

    @pytest.mark.parametrize("method_version", ["latest", "Draft", 1.5])
    def test_a_run_record_refuses_a_version_that_is_neither_a_number_nor_draft(self, method_version: object) -> None:
        with pytest.raises(ValidationError):
            RunHistoryItem.model_validate(
                {"pipeline_run_id": "run_1", "pipe_code": "review", "status": "COMPLETED", "created_at": "t", "method_version": method_version}
            )
