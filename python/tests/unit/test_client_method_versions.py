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
from mthds.method_tree.file_entry import HashFileEntry
from pydantic import BaseModel, ValidationError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, MethodErrorCode, RequestArgumentError
from pipelex_sdk.execute_result import PipelexExecuteResult
from pipelex_sdk.product_models import (
    MethodData,
    MethodDetail,
    MethodDraftInput,
    MethodPublished,
    MethodPublishOutcome,
    MethodPublishRefusalReason,
    MethodPublishRefused,
    MethodPublishUnchanged,
    MethodSummary,
    MethodVersion,
    MethodVersionSummary,
    PipelineRun,
    RunDetail,
    RunHistoryItem,
    RunPage,
    SavedMethodFile,
)
from pipelex_sdk.runs import PipelexRunResultStart, RunPublic, RunRead
from pipelex_sdk.validation_models import PipelexInvalidReport, PipelexValidationReport
from tests.unit.conftest import BASE_URL, problem_document, refused_argument
from tests.unit.test_data import MethodVersionBodies

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from pytest_mock import MockType

    from tests.unit.conftest import ResponseBuilder, SendPatcher


#: A call of one method route on a client, as a coroutine `asyncio.run` drives.
MethodRouteCall: TypeAlias = "Callable[[PipelexAPIClient], Coroutine[Any, Any, object]]"

_SUFFIXED_ID = "mt_receipts01@3"

#: The verdict of an argument refused before anything is sent: the caller changes it, and asking again unchanged cannot pass.

#: One call of each method route, addressed by a suffixed id that every one of them refuses before sending.
_SUFFIXED_ID_ROUTES: list[tuple[str, MethodRouteCall]] = [
    ("get_method", lambda client: client.get_method(_SUFFIXED_ID)),
    ("write_draft", lambda client: client.write_draft(_SUFFIXED_ID, MethodDraftInput(files={"main.mthds": "src"}))),
    ("rename_method", lambda client: client.rename_method(_SUFFIXED_ID, "Receipts")),
    ("publish_method", lambda client: client.publish_method(_SUFFIXED_ID, expected_draft_updated_at="t")),
    ("list_method_versions", lambda client: client.list_method_versions(_SUFFIXED_ID)),
    ("get_method_version", lambda client: client.get_method_version(_SUFFIXED_ID, 3)),
    ("copy_method", lambda client: client.copy_method(_SUFFIXED_ID, destination_org_id="org_team")),
    ("list_method_copies", lambda client: client.list_method_copies(_SUFFIXED_ID)),
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

    def test_a_method_read_carries_its_draft_digest_files_and_latest_published_version(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD_DETAIL))

        method = asyncio.run(api_client.get_method("mt_receipts01"))

        assert isinstance(method, MethodDetail)
        assert method.updated_at == MethodVersionBodies.TOKEN
        assert method.draft_digest == MethodVersionBodies.DIGEST
        assert method.latest_version == 3
        assert method.latest_published is not None
        assert method.latest_published.version == 3
        assert method.latest_published.tree_digest == MethodVersionBodies.DIGEST
        assert method.latest_published.crate_fingerprint == "a1b2c3"
        assert [saved_file.path for saved_file in method.files] == ["helper.py", "main.mthds"]
        assert method.files[0] == SavedMethodFile.model_validate(MethodVersionBodies.FILES[0])
        # The draft is unchanged since the latest version: both name the same tree.
        assert method.draft_digest == method.latest_published.tree_digest

    def test_a_method_never_published_reads_with_no_version(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={**MethodVersionBodies.NEVER_PUBLISHED, "files": []}))

        method = asyncio.run(api_client.get_method("mt_receipts01"))

        assert method.latest_version is None
        assert method.latest_published is None

    def test_an_empty_draft_and_a_version_held_back_read_their_digests_as_none(self) -> None:
        """An empty draft names no tree, and a version the migration held back names none either."""
        held_back = {**MethodVersionBodies.SUMMARY, "tree_digest": None}
        method = MethodData.model_validate({**MethodVersionBodies.METHOD, "draft_digest": None, "latest_published": held_back})

        assert method.draft_digest is None
        assert method.latest_published is not None
        assert method.latest_published.tree_digest is None

    def test_a_method_read_keeps_no_source_field(self) -> None:
        """The draft is a tree named by its digest: the model declares no `mthds` and no `python`."""
        assert {"mthds", "python"}.isdisjoint(MethodData.model_fields)
        assert {"mthds", "python"}.isdisjoint(MethodVersion.model_fields)

    def test_update_method_is_gone(self) -> None:
        """The whole-method `PUT /v1/methods/{id}` is replaced by `write_draft` and `rename_method`."""
        assert not hasattr(PipelexAPIClient, "update_method")

    # ----- write_draft -------------------------------------------------------------------------

    def test_write_draft_puts_the_draft_with_its_token(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))
        draft = MethodDraftInput(
            files={"main.mthds": "src", "helper.py": HashFileEntry(sha256="a" * 64, size=5)},
            input_data={"total": 1},
            expected_updated_at=MethodVersionBodies.TOKEN,
        )

        method = asyncio.run(api_client.write_draft("mt_receipts01", draft))

        assert _sent_method(send) == "PUT"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/draft"
        assert _sent_body(send) == {
            "files": {"main.mthds": "src", "helper.py": {"sha256": "a" * 64, "size": 5}},
            "input_data": {"total": 1},
            "expected_updated_at": MethodVersionBodies.TOKEN,
        }
        assert method.draft_digest == MethodVersionBodies.DIGEST

    def test_write_draft_sends_only_what_was_set(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        """An unset field keeps the stored value; an unset token is a last-writer-wins write."""
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(files={"main.mthds": "src"})))

        assert _sent_body(send) == {"files": {"main.mthds": "src"}}

    def test_write_draft_sends_an_explicit_none_files_to_empty_the_draft(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """`files` is required on the wire, and null empties the draft."""
        send = patch_send(api_client, wire_response(200, json_body={**MethodVersionBodies.METHOD, "draft_digest": None}))

        method = asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(files=None)))

        assert _sent_body(send) == {"files": None}
        assert method.draft_digest is None

    def test_write_draft_refuses_a_draft_giving_no_tree_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """The write replaces the whole tree, so a draft naming none would be sent as an empty draft by mistake."""
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        with pytest.raises(RequestArgumentError, match="files=None empties the draft") as exc_info:
            asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(input_data={"total": 2})))

        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        assert refused_argument(exc_info.value) == {"argument": "files", "reason": "missing"}
        send.assert_not_called()

    def test_write_draft_sends_an_explicit_none_input_data_to_clear_it(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(files={"main.mthds": "src"}, input_data=None)))

        assert _sent_body(send) == {"files": {"main.mthds": "src"}, "input_data": None}

    def test_write_draft_encodes_the_id(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.METHOD))

        asyncio.run(api_client.write_draft("a/b", MethodDraftInput(files={"main.mthds": "src"})))

        assert _sent_url(send) == f"{BASE_URL}/v1/methods/a%2Fb/draft"

    def test_a_stale_draft_token_raises_the_update_conflict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = problem_document(
            "pipelex.catalog.update_conflict", 409, detail="The draft changed since you loaded it.", location={"field": "expected_updated_at"}
        )
        patch_send(api_client, wire_response(409, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.write_draft("mt_receipts01", MethodDraftInput(files={"main.mthds": "src"}, expected_updated_at="old")))

        assert exc_info.value.status == 409
        assert exc_info.value.problem.code == MethodErrorCode.UPDATE_CONFLICT
        assert exc_info.value.problem.location is not None
        assert exc_info.value.problem.location.field == "expected_updated_at"
        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")

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

    def test_rename_method_sends_a_name_holding_a_lone_surrogate_escaped_and_raises_the_platforms_422(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        # `to_json` refuses a lone surrogate before any request; `JSON.stringify` escapes it, and the platform
        # refuses the text it cannot store with its own `422`, so the client sends what `@pipelex/sdk` sends.
        send = patch_send(api_client, wire_response(422, json_body=problem_document("request.invalid", 422)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.rename_method("mt_receipts01", "Renamed \ud800"))

        assert send.call_args.kwargs["content"] == b'{"name":"Renamed \\ud800"}'
        assert _sent_body(send) == {"name": "Renamed \ud800"}
        assert exc_info.value.status == 422
        assert exc_info.value.problem.code == "request.invalid"

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
        assert result.version.tree_digest == result.method.draft_digest

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
        assert [item.detail for item in result.validation.errors] == ["Pipe 'review' has no output."]
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
        ("errors", "expected_details"),
        [
            pytest.param(None, [], id="no-errors"),
            pytest.param(
                [None, {"code": 7}, MethodVersionBodies.INVALID_VERDICT["errors"][0]], ["Pipe 'review' has no output."], id="malformed-entries"
            ),
        ],
    )
    def test_publish_method_reads_a_refusals_verdict_member_by_member(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        errors: list[Any] | None,
        expected_details: list[str],
    ) -> None:
        """The refusal's verdict is read as `validate` reads one: a verdict listing no `errors` lists none, and an entry
        that names no fault is left out while the well-formed one is kept.
        """
        verdict = {key: value for key, value in MethodVersionBodies.INVALID_VERDICT.items() if key != "errors"}
        if errors is not None:
            verdict["errors"] = errors
        body = {
            "outcome": "refused",
            "reason": "invalid",
            "message": "The draft does not validate.",
            "validation": verdict,
            "method": MethodVersionBodies.METHOD,
        }
        patch_send(api_client, wire_response(200, json_body=body))

        result = asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=MethodVersionBodies.TOKEN))

        assert isinstance(result, MethodPublishRefused)
        assert isinstance(result.validation, PipelexInvalidReport)
        assert [item.detail for item in result.validation.errors] == expected_details

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"version": MethodVersionBodies.SUMMARY, "method": MethodVersionBodies.METHOD}, id="no-outcome"),
            pytest.param({"outcome": "skipped", "version": MethodVersionBodies.SUMMARY, "method": MethodVersionBodies.METHOD}, id="unknown-outcome"),
            pytest.param({"outcome": "published", "version": MethodVersionBodies.SUMMARY}, id="no-method"),
            pytest.param({"outcome": "refused", "reason": "late", "message": "m", "validation": {}, "method": {}}, id="unknown-reason"),
            pytest.param(
                {"outcome": "refused", "reason": "invalid", "message": "m", "method": MethodVersionBodies.METHOD}, id="refusal-without-validation"
            ),
            pytest.param(
                {"outcome": "refused", "reason": "invalid", "message": "m", "validation": "invalid", "method": MethodVersionBodies.METHOD},
                id="refusal-whose-validation-is-no-object",
            ),
        ],
    )
    def test_publish_method_refuses_an_answer_off_the_union(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        """A body that names no known outcome, or breaks its arm, is never mistaken for a verdict: it is an
        answer the SDK cannot read, pydantic's refusal as its cause.
        """
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at=MethodVersionBodies.TOKEN))
        unreadable = exc_info.value
        assert str(unreadable) == "API POST /v1/methods/mt_receipts01/publish answered 200 with a body that is not the answer the route returns"
        assert unreadable.status == 200
        assert isinstance(unreadable.__cause__, ValidationError)
        assert (unreadable.problem.domain, unreadable.problem.retry) == ("runtime", "no")

    def test_publish_method_raises_the_update_conflict_for_a_stale_token(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """A stale token produces no verdict about the content, so it raises instead of answering an outcome."""
        conflict = problem_document("pipelex.catalog.update_conflict", 409, location={"field": "expected_draft_updated_at"})
        patch_send(api_client, wire_response(409, json_body=conflict))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.publish_method("mt_receipts01", expected_draft_updated_at="old"))

        assert exc_info.value.problem.code == MethodErrorCode.UPDATE_CONFLICT
        assert exc_info.value.problem.location is not None
        assert exc_info.value.problem.location.field == "expected_draft_updated_at"

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

        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        send.assert_not_called()

    def test_publish_method_takes_its_token_by_keyword_only(self, api_client: PipelexAPIClient) -> None:
        with pytest.raises(TypeError):
            asyncio.run(api_client.publish_method("mt_receipts01", MethodVersionBodies.TOKEN))  # type: ignore[misc]  # pyright: ignore[reportCallIssue]

    # ----- list_method_versions ----------------------------------------------------------------

    def test_list_method_versions_reads_a_page_of_summaries(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        older = {**MethodVersionBodies.SUMMARY, "version": 2, "tree_digest": MethodVersionBodies.OTHER_DIGEST, "crate_fingerprint": None}
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

    def test_get_method_version_reads_one_version_with_its_files(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.VERSION))

        version = asyncio.run(api_client.get_method_version("mt_receipts01", 3))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_receipts01/versions/3"
        assert isinstance(version, MethodVersion)
        assert version.method_id == "mt_receipts01"
        assert version.tree_digest == MethodVersionBodies.DIGEST
        assert version.files == [SavedMethodFile.model_validate(saved_file) for saved_file in MethodVersionBodies.FILES]
        assert version.published_by == "user_1"

    @pytest.mark.parametrize("version", [0, -1, True, 2.0, 1.5, float("nan"), "3", None])
    def test_get_method_version_refuses_a_value_that_names_no_version_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, version: object
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodVersionBodies.VERSION))

        with pytest.raises(RequestArgumentError, match="positive integer") as exc_info:
            asyncio.run(api_client.get_method_version("mt_receipts01", cast("int", version)))

        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        send.assert_not_called()

    def test_get_method_version_raises_the_version_not_found(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        not_found = problem_document("pipelex.catalog.not_found", 404, detail="No version 9.", params={"resource": "version"})
        patch_send(api_client, wire_response(404, json_body=not_found))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method_version("mt_receipts01", 9))

        assert exc_info.value.status == 404
        assert exc_info.value.problem.code == MethodErrorCode.NOT_FOUND
        assert exc_info.value.problem.params is not None
        assert exc_info.value.problem.params.as_wire() == {"resource": "version"}

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
        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        send.assert_not_called()

    # ----- the run routes' linkage form takes a bare id ----------------------------------------

    @pytest.mark.parametrize("form", ["files", "contents"])
    @pytest.mark.parametrize("selector", ["mt_receipts01@3", "mt_receipts01@draft"])
    @pytest.mark.parametrize("route", ["start", "execute"])
    def test_a_suffixed_id_beside_the_tree_is_refused_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, route: str, selector: str, form: str
    ) -> None:
        """Beside the method's tree the id is linkage, and a suffix would claim a version that did not run."""
        send = patch_send(api_client, wire_response(202, json_body={}))
        run = api_client.start if route == "start" else api_client.execute

        tree = {"main.mthds": 'domain = "receipts"'}

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(run(method_id=selector, files=tree if form == "files" else None, contents=tree if form == "contents" else None))

        assert str(exc_info.value) == (
            f'method_id "{selector}" beside the method tree is run-history linkage and must be a bare catalog id: the '
            "tree is what runs, so a version suffix would claim a version that did not. Send the bare id "
            "(parse_method_selector(...).method_id), or drop the tree to run the version the selector names."
        )
        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        send.assert_not_called()

    def test_a_bare_id_beside_the_tree_is_sent_as_linkage(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        ack = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-10-08T00:00:00Z"}
        send = patch_send(api_client, wire_response(202, json_body=ack))

        asyncio.run(api_client.start(contents={"main.mthds": 'domain = "receipts"'}, method_id="mt_receipts01"))

        body = _sent_body(send)
        assert body["method_id"] == "mt_receipts01"
        assert body["files"] == {"main.mthds": 'domain = "receipts"'}

    # ----- the error codes ---------------------------------------------------------------------

    def test_the_method_error_codes_are_the_platform_problem_codes(self) -> None:
        assert [str(code) for code in MethodErrorCode] == [
            "pipelex.catalog.update_conflict",
            "pipelex.catalog.being_deleted",
            "pipelex.catalog.not_published",
            "pipelex.catalog.not_found",
            "pipelex.org.not_found",
            "pipelex.catalog.copy_too_large",
        ]

    def test_a_bare_id_of_a_method_never_published_raises_not_published(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = problem_document("pipelex.catalog.not_published", 409, detail="Publish the method, or run mt_receipts01@draft.")
        patch_send(api_client, wire_response(409, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.start(method_id="mt_receipts01"))

        assert exc_info.value.problem.code == MethodErrorCode.NOT_PUBLISHED

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
            {
                "pipeline_run_id": "run_1",
                "status": "COMPLETED",
                "created_at": "t",
                "method_version": 3,
                "source_digest": MethodVersionBodies.SOURCE_DIGEST,
            }
        )

        assert run.method_version == 3
        assert run.source_digest == MethodVersionBodies.SOURCE_DIGEST

    def test_run_records_read_the_version_fields_when_present_and_absent(self) -> None:
        base: dict[str, Any] = {
            "pipeline_run_id": "run_1",
            "method_id": "mt_receipts01",
            "created_by_user_id": "u1",
            "pipe_code": "review",
            "status": "COMPLETED",
            "created_at": "t",
        }
        record: dict[str, Any] = {**base, "org_id": "org_1", "workflow_id": "w"}

        history = RunHistoryItem.model_validate({**base, "method_version": "draft", "source_digest": MethodVersionBodies.SOURCE_DIGEST})
        assert history.method_version == "draft"
        assert history.source_digest == MethodVersionBodies.SOURCE_DIGEST

        assert RunHistoryItem.model_validate(base).method_version is None
        assert PipelineRun.model_validate({**record, "method_version": 2}).method_version == 2
        assert RunDetail.model_validate({**record, "method_version": None}).method_version is None
        assert RunPage.model_validate({"items": [{**base, "method_version": 1}], "next_cursor": None}).items[0].method_version == 1

    def test_a_run_detail_names_the_tree_it_ran_and_the_crate_it_loaded(self) -> None:
        """A run sent as a tree records its digest, in the form of a method's `draft_digest`, and the crate's fingerprint."""
        record: dict[str, Any] = {"pipeline_run_id": "run_1", "status": "COMPLETED", "created_at": "t"}

        detail = RunDetail.model_validate({**record, "tree_digest": MethodVersionBodies.DIGEST, "crate_fingerprint": "a1b2c3"})

        assert detail.tree_digest == MethodVersionBodies.DIGEST
        assert detail.crate_fingerprint == "a1b2c3"
        assert detail.model_extra == {}
        older = RunDetail.model_validate(record)
        assert older.tree_digest is None
        assert older.crate_fingerprint is None

    @pytest.mark.parametrize("method_version", ["latest", "Draft", 1.5])
    def test_a_run_record_refuses_a_version_that_is_neither_a_number_nor_draft(self, method_version: object) -> None:
        with pytest.raises(ValidationError):
            RunHistoryItem.model_validate(
                {
                    "pipeline_run_id": "run_1",
                    "method_id": "mt_receipts01",
                    "created_by_user_id": "u1",
                    "pipe_code": "review",
                    "status": "COMPLETED",
                    "created_at": "t",
                    "method_version": method_version,
                }
            )

    @pytest.mark.parametrize(
        "method_version",
        [
            pytest.param(True, id="boolean"),
            pytest.param("3", id="numeric-string"),
            pytest.param(2.0, id="float"),
        ],
    )
    @pytest.mark.parametrize("record_model", [RunHistoryItem, PipelineRun, RunDetail])
    def test_a_run_record_never_coerces_a_version(self, record_model: type[RunHistoryItem | PipelineRun], method_version: object) -> None:
        """A boolean, a numeric string or a float is never read as a version number: the record refuses it."""
        with pytest.raises(ValidationError):
            record_model.model_validate(
                {
                    "pipeline_run_id": "run_1",
                    "method_id": "mt_receipts01",
                    "created_by_user_id": "u1",
                    "status": "COMPLETED",
                    "created_at": "t",
                    "method_version": method_version,
                }
            )

    @pytest.mark.parametrize(
        "version",
        [
            pytest.param(True, id="boolean"),
            pytest.param("3", id="numeric-string"),
            pytest.param(2.0, id="float"),
        ],
    )
    @pytest.mark.parametrize(
        ("answer_model", "answer", "field"),
        [
            pytest.param(
                PipelexRunResultStart,
                {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "t"},
                "method_version",
                id="start-ack",
            ),
            pytest.param(RunPublic, {"pipeline_run_id": "run_1", "status": "COMPLETED", "created_at": "t"}, "method_version", id="run-public"),
            pytest.param(RunRead, {"pipeline_run_id": "run_1", "status": "COMPLETED", "created_at": "t"}, "method_version", id="run-read"),
            pytest.param(
                PipelexExecuteResult,
                {
                    "pipeline_run_id": "run_1",
                    "main_stuff_name": "result",
                    "pipe_output": {"pipeline_run_id": "run_1", "working_memory": {"root": {}, "aliases": {}}},
                },
                "method_version",
                id="execute-result",
            ),
            pytest.param(MethodVersionSummary, MethodVersionBodies.SUMMARY, "version", id="version-summary"),
            pytest.param(MethodData, MethodVersionBodies.METHOD, "latest_version", id="method"),
            pytest.param(
                MethodSummary,
                {"method_id": "mt_receipts01", "name": "Receipt review", "created_at": "t"},
                "latest_version",
                id="method-row",
            ),
        ],
    )
    def test_an_answer_never_coerces_a_version_number(
        self, answer_model: type[BaseModel], answer: dict[str, Any], field: str, version: object
    ) -> None:
        """Every answer naming a method version refuses a boolean, a numeric string or a float rather than reading it as a number."""
        answer_model.model_validate({**answer, field: 3})

        with pytest.raises(ValidationError):
            answer_model.model_validate({**answer, field: version})
