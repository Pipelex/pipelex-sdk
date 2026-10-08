"""Tests for a saved method's draft and published versions — `write_draft`, `rename_method`, `publish_method`,
`list_method_versions`, `get_method_version`, and the version a run ran.

The twin of `pipelex-sdk-js/tests/method-versions.test.ts`. `_send` is mocked; the bodies are the platform's
own serialized shapes (`MethodVersionBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, TypeAlias, cast

import pytest
from pydantic import ValidationError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import ApiResponseError, MethodErrorCode, RequestArgumentError
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
    from collections.abc import Callable, Coroutine

    from pytest_mock import MockType

    from tests.unit.conftest import ResponseBuilder, SendPatcher


#: A call of one method route on a client, as a coroutine `asyncio.run` drives.
MethodRouteCall: TypeAlias = "Callable[[PipelexAPIClient], Coroutine[Any, Any, object]]"

_SUFFIXED_ID = "mt_receipts01@3"

#: The verdict of an argument refused before anything is sent: the caller changes it, and asking again unchanged cannot pass.
_INPUT_VERDICT = ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)

#: One call of each method route, addressed by a suffixed id that every one of them refuses before sending.
_SUFFIXED_ID_ROUTES: list[tuple[str, MethodRouteCall]] = [
    ("get_method", lambda client: client.get_method(_SUFFIXED_ID)),
    ("write_draft", lambda client: client.write_draft(_SUFFIXED_ID, MethodDraftInput(mthds="src"))),
    ("rename_method", lambda client: client.rename_method(_SUFFIXED_ID, "Receipts")),
    ("publish_method", lambda client: client.publish_method(_SUFFIXED_ID, expected_draft_updated_at="t")),
    ("list_method_versions", lambda client: client.list_method_versions(_SUFFIXED_ID)),
    ("get_method_version", lambda client: client.get_method_version(_SUFFIXED_ID, 3)),
    ("delete_method", lambda client: client.delete_method(_SUFFIXED_ID)),
]


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

        with pytest.raises(RequestArgumentError, match=rf"needs expected_draft_updated_at: .*; got {type_name}\.$") as exc_info:
            asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=cast("str", token)))

        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
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

        with pytest.raises(RequestArgumentError, match="positive integer") as exc_info:
            asyncio.run(api_client.get_method_version("mt_receipts01", cast("int", version)))

        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    def test_get_method_version_raises_the_version_not_found(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body={"status": 404, "code": "method_version_not_found"}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method_version("mt_receipts01", 9))

        assert exc_info.value.status == 404
        assert exc_info.value.code == MethodErrorCode.METHOD_VERSION_NOT_FOUND

    # ----- the method routes take a bare id ----------------------------------------------------

    @pytest.mark.parametrize("route", [pytest.param(route, id=name) for name, route in _SUFFIXED_ID_ROUTES])
    def test_a_method_route_refuses_a_suffixed_id_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, route: MethodRouteCall
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={}))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(route(api_client))

        assert str(exc_info.value) == (
            '"mt_receipts01@3" carries a version suffix, and the method routes take a bare catalog id: they address the method '
            "itself, never one of its versions. Strip the suffix with parse_method_selector, and read a published version "
            "with get_method_version."
        )
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    # ----- the run routes' linkage form takes a bare id ----------------------------------------

    @pytest.mark.parametrize("selector", ["mt_receipts01@3", "mt_receipts01@draft"])
    @pytest.mark.parametrize("route", ["start", "execute"])
    def test_a_suffixed_id_beside_an_inline_source_is_refused_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, route: str, selector: str
    ) -> None:
        """Beside an inline source the id is linkage, and a suffix would claim a version that did not run."""
        send = patch_send(api_client, wire_response(202, json_body={}))
        run = api_client.start if route == "start" else api_client.execute

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(run(mthds_contents=['domain = "receipts"'], method_id=selector))

        assert str(exc_info.value) == (
            f'method_id "{selector}" beside an inline source is run-history linkage and must be a bare catalog id: the '
            "inline source is what runs, so a version suffix would claim a version that did not. Send the bare id "
            "(parse_method_selector(...).method_id), or drop the inline source to run the version the selector names."
        )
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    def test_a_suffixed_id_beside_empty_inline_contents_is_sent(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """Empty `mthds_contents` carry no source to link, so the id is the run source and keeps its suffix."""
        ack = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-10-08T00:00:00Z", "method_version": 3}
        send = patch_send(api_client, wire_response(202, json_body=ack))

        asyncio.run(api_client.start(mthds_contents=[], method_id="mt_receipts01@3"))

        assert _sent_body(send)["method_id"] == "mt_receipts01@3"

    def test_a_bare_id_beside_an_inline_source_is_sent_as_linkage(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        ack = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-10-08T00:00:00Z"}
        send = patch_send(api_client, wire_response(202, json_body=ack))

        asyncio.run(api_client.start(mthds_contents=['domain = "receipts"'], method_id="mt_receipts01"))

        body = _sent_body(send)
        assert body["method_id"] == "mt_receipts01"
        assert body["mthds_contents"] == ['domain = "receipts"']

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
