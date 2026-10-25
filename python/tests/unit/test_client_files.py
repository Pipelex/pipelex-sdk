"""Tests for an organization's files — `list_files`, `iterate_files`, `get_file`, `get_files_by_uri`, `rename_file`,
`link_files` and `copy_file_into_draft`.

The twin of `pipelex-sdk-js/tests/files.test.ts` and `tests/file-routes.test.ts`. `_send` is mocked; the bodies are the
platform's own serialized shapes (`FileBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import parse_qs, urlsplit

import pytest
from pydantic import ValidationError

from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.product_models import (
    DraftFileBlob,
    FileKind,
    FileLinked,
    FileLinkRefused,
    FileLinkTarget,
    FileRole,
    FileState,
    FileSummary,
    FileUseHolderType,
)
from tests.unit.conftest import BASE_URL, problem_document, refused_argument
from tests.unit.test_data import FileBodies

if TYPE_CHECKING:
    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import ResponseBuilder, SendPatcher

_FILES_URL = f"{BASE_URL}/v1/files"

#: The verdict of an argument refused before anything is sent: the caller changes it, and asking again unchanged cannot pass.


def _sent_method(send: MockType) -> str:
    return cast("str", send.call_args.args[0])


def _sent_url(send: MockType) -> str:
    return cast("str", send.call_args.args[1])


def _sent_query(send: MockType) -> dict[str, list[str]]:
    return parse_qs(urlsplit(_sent_url(send)).query, keep_blank_values=True)


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


def _page(*rows: dict[str, Any], next_cursor: str | None = None) -> dict[str, Any]:
    return {"items": list(rows), "next_cursor": next_cursor}


async def _collect_files(client: PipelexAPIClient, **filters: Any) -> list[FileSummary]:
    return [file async for file in client.iterate_files(**filters)]


class TestClientFiles:
    # ----- list_files and iterate_files ----------------------------------------------------------

    def test_list_reads_a_page_of_rows(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        send = patch_send(api_client, wire_response(200, json_body=_page(FileBodies.SUMMARY, next_cursor="c2")))

        page = asyncio.run(api_client.list_files())

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == _FILES_URL
        assert page.next_cursor == "c2"
        row = page.items[0]
        assert row.uri == FileBodies.URI
        assert row.kind == FileKind.UPLOADED
        assert row.origin.surface == "app"

    def test_list_sends_every_filter_under_the_apis_names_the_repeated_ones_once_per_value(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=_page()))

        asyncio.run(
            api_client.list_files(
                method_id="mt_abc",
                run_id="run_7",
                created_by="me",
                kind=FileKind.TEST,
                formats=["pdf", "image"],
                media_types=["image/png"],
                created_from="2026-10-01T00:00:00Z",
                created_to="2026-10-31T23:59:59Z",
                q="invoice",
                limit=20,
                cursor="c2",
            )
        )

        assert _sent_query(send) == {
            "method_id": ["mt_abc"],
            "run_id": ["run_7"],
            "created_by": ["me"],
            "kind": ["test"],
            "format": ["pdf", "image"],
            "media_type": ["image/png"],
            "created_from": ["2026-10-01T00:00:00Z"],
            "created_to": ["2026-10-31T23:59:59Z"],
            "q": ["invoice"],
            "limit": ["20"],
            "cursor": ["c2"],
        }

    def test_list_sends_an_explicit_empty_search_rather_than_dropping_it(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=_page()))

        asyncio.run(api_client.list_files(q=""))

        assert _sent_query(send) == {"q": [""]}

    @pytest.mark.parametrize("argument", ["formats", "media_types"])
    def test_list_refuses_an_empty_repeated_filter_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, argument: str
    ) -> None:
        """Sent as no parameter, an empty filter would list every format: it is refused rather than widened."""
        send = patch_send(api_client, wire_response(200, json_body=_page()))
        empty: list[str] = []

        with pytest.raises(RequestArgumentError, match=rf'^list_files\(\) takes "{argument}" as one or more values') as exc_info:
            asyncio.run(api_client.list_files(formats=empty) if argument == "formats" else api_client.list_files(media_types=empty))

        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        assert refused_argument(exc_info.value) == {"argument": argument, "reason": "empty"}
        send.assert_not_called()

    def test_list_sends_a_one_shot_filter_whole_rather_than_dropping_it(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=_page()))
        one_shot = (value for value in ["pdf", "image"])

        asyncio.run(api_client.list_files(formats=cast("list[str]", one_shot), media_types=cast("list[str]", iter(["application/pdf"]))))

        assert _sent_query(send) == {"format": ["pdf", "image"], "media_type": ["application/pdf"]}

    @pytest.mark.parametrize(
        "value",
        [
            pytest.param("pdf", id="bare-string"),
            pytest.param(["pdf", 3], id="non-string-value"),
            pytest.param(3, id="not-iterable"),
            pytest.param((value for value in ["pdf", 3]), id="one-shot-with-a-non-string-value"),
        ],
    )
    def test_list_raises_type_error_for_a_filter_that_is_not_a_list_of_strings(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, value: object
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=_page()))

        with pytest.raises(TypeError, match=r'takes "formats" as a list of strings\.$'):
            asyncio.run(api_client.list_files(formats=cast("list[str]", value)))

        send.assert_not_called()

    def test_list_reads_a_kind_it_does_not_know_as_its_raw_string(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=_page({**FileBodies.SUMMARY, "kind": "imported"})))

        page = asyncio.run(api_client.list_files())

        assert page.items[0].kind == "imported"
        assert not isinstance(page.items[0].kind, FileKind)

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"items": {}, "next_cursor": None}, id="items-not-a-list"),
            pytest.param({"items": []}, id="no-cursor"),
            pytest.param({"items": [], "next_cursor": 2}, id="numeric-cursor"),
        ],
    )
    def test_list_refuses_a_page_it_cannot_walk(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_files())

        assert str(exc_info.value) == "API GET /v1/files answered 200 with a body that is not the answer the route returns"
        assert exc_info.value.problem.code == "client.response_unreadable"

    def test_iterate_follows_the_cursor_through_an_empty_page_sending_the_same_filters(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        second = {**FileBodies.SUMMARY, "file_id": "fl_2"}
        send = patch_send(
            api_client,
            wire_response(200, json_body=_page(FileBodies.SUMMARY, next_cursor="c2")),
            wire_response(200, json_body=_page(next_cursor="c3")),
            wire_response(200, json_body=_page(second)),
        )

        files = asyncio.run(_collect_files(api_client, kind=FileKind.UPLOADED, formats=["pdf"]))

        assert [file.file_id for file in files] == [FileBodies.FILE_ID, "fl_2"]
        sent_queries = [parse_qs(urlsplit(cast("str", call.args[1])).query) for call in send.call_args_list]
        assert sent_queries == [
            {"kind": ["uploaded"], "format": ["pdf"]},
            {"kind": ["uploaded"], "format": ["pdf"], "cursor": ["c2"]},
            {"kind": ["uploaded"], "format": ["pdf"], "cursor": ["c3"]},
        ]

    def test_iterate_sends_a_one_shot_filter_whole_with_every_page(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(
            api_client,
            wire_response(200, json_body=_page(FileBodies.SUMMARY, next_cursor="c2")),
            wire_response(200, json_body=_page({**FileBodies.SUMMARY, "file_id": "fl_2"})),
        )
        one_shot = (value for value in ["pdf", "image"])

        files = asyncio.run(_collect_files(api_client, formats=one_shot, media_types=iter(["application/pdf"])))

        assert len(files) == 2
        sent_queries = [parse_qs(urlsplit(cast("str", call.args[1])).query) for call in send.call_args_list]
        assert sent_queries == [
            {"format": ["pdf", "image"], "media_type": ["application/pdf"]},
            {"format": ["pdf", "image"], "media_type": ["application/pdf"], "cursor": ["c2"]},
        ]

    def test_iterate_refuses_an_empty_filter_at_the_call_before_it_is_iterated(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=_page()))

        with pytest.raises(RequestArgumentError, match=r'^iterate_files\(\) takes "media_types"'):
            api_client.iterate_files(media_types=[])

        send.assert_not_called()

    # ----- get_file -------------------------------------------------------------------------------

    def test_get_reads_one_file_with_its_methods_and_a_page_of_its_uses(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.DETAIL))

        detail = asyncio.run(api_client.get_file(FileBodies.FILE_ID))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == f"{_FILES_URL}/{FileBodies.FILE_ID}"
        assert detail.original_name == "March invoice.pdf"
        assert detail.state == FileState.STORED
        assert detail.method_ids == ["mt_abc"]
        assert [use.holder_type for use in detail.uses.items] == [FileUseHolderType.EXAMPLE, FileUseHolderType.RUN]
        assert [use.created_by for use in detail.uses.items] == ["user_1", None]
        assert detail.uses.next_cursor == "u2"

    def test_get_reads_a_use_without_its_creator_as_none(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """A platform that predates `created_by` leaves it out of every use, which still validates and reads as `None`."""
        uses_without_creator: list[dict[str, Any]] = []
        for use_body in FileBodies.DETAIL["uses"]["items"]:
            legacy_use = dict(use_body)
            del legacy_use["created_by"]
            uses_without_creator.append(legacy_use)
        body = {**FileBodies.DETAIL, "uses": {"items": uses_without_creator, "next_cursor": None}}
        patch_send(api_client, wire_response(200, json_body=body))

        detail = asyncio.run(api_client.get_file(FileBodies.FILE_ID))

        assert [use.created_by for use in detail.uses.items] == [None, None]
        assert [use.holder_id for use in detail.uses.items] == ["ex_1", "run_7"]
        assert all("created_by" not in use.model_fields_set for use in detail.uses.items)

    def test_get_pages_the_uses_with_their_limit_and_cursor(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.DETAIL))

        asyncio.run(api_client.get_file(FileBodies.FILE_ID, uses_limit=10, uses_cursor="u2"))

        assert _sent_query(send) == {"uses_limit": ["10"], "uses_cursor": ["u2"]}

    @pytest.mark.parametrize(
        ("file_id", "got"),
        [
            pytest.param("", "an empty string", id="empty"),
            pytest.param("..", '"..", a dot segment', id="dot-segment"),
            pytest.param(None, "None", id="none"),
        ],
    )
    def test_get_refuses_a_file_id_that_names_no_file_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, file_id: object, got: str
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.DETAIL))

        with pytest.raises(RequestArgumentError, match=rf"^get_file\(\) takes a file id, the file's non-empty `file_id`; got {got}") as exc_info:
            asyncio.run(api_client.get_file(cast("str", file_id)))

        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        send.assert_not_called()

    def test_get_refuses_a_file_whose_uses_are_not_a_page(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={**FileBodies.DETAIL, "uses": [FileBodies.DETAIL["uses"]]}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_file(FileBodies.FILE_ID))

        assert isinstance(exc_info.value.__cause__, ValidationError)
        assert exc_info.value.problem.code == "client.response_unreadable"

    def test_get_raises_not_found_for_another_organizations_file(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body=problem_document("pipelex.storage.not_found", 404, detail="Item not found.")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_file(FileBodies.FILE_ID))

        assert exc_info.value.problem.code == "pipelex.storage.not_found"

    # ----- get_files_by_uri -----------------------------------------------------------------------

    def test_by_uri_sends_the_address_and_the_run_and_reads_the_records_in_order(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        pending = {**FileBodies.RECORD, "file_id": "fl_2", "state": "pending", "created_by": "user_2"}
        send = patch_send(api_client, wire_response(200, json_body={"items": [FileBodies.RECORD, pending]}))

        records = asyncio.run(api_client.get_files_by_uri(FileBodies.URI, run_id="run_7"))

        assert urlsplit(_sent_url(send)).path == "/v1/files/by-uri"
        assert _sent_query(send) == {"uri": [FileBodies.URI], "run_id": ["run_7"]}
        assert [record.file_id for record in records.items] == [FileBodies.FILE_ID, "fl_2"]
        assert records.items[1].state == FileState.PENDING

    def test_by_uri_reads_an_address_no_record_holds_as_an_empty_list(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"items": []}))

        records = asyncio.run(api_client.get_files_by_uri(FileBodies.URI))

        assert records.items == []

    @pytest.mark.parametrize(("uri", "got"), [pytest.param("", "an empty string", id="empty"), pytest.param(3, "int", id="number")])
    def test_by_uri_refuses_an_address_that_is_not_a_non_empty_string_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, uri: object, got: str
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": []}))

        with pytest.raises(
            RequestArgumentError, match=rf"^get_files_by_uri\(\) takes a `pipelex-storage://` address, a non-empty string; got {got}\.$"
        ):
            asyncio.run(api_client.get_files_by_uri(cast("str", uri)))

        send.assert_not_called()

    def test_by_uri_raises_forbidden_for_another_organizations_address(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(403, json_body=problem_document("pipelex.org.mismatch", 403, detail="Not this organization's.")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_files_by_uri("pipelex-storage://org_2/assets/x.pdf"))

        assert exc_info.value.problem.code == "pipelex.org.mismatch"

    # ----- rename_file ----------------------------------------------------------------------------

    def test_rename_patches_the_name_alone_and_reads_the_name_the_rule_saved(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={**FileBodies.RECORD, "name": "March invoice.pdf"}))

        record = asyncio.run(api_client.rename_file(FileBodies.FILE_ID, "March invoice"))

        assert _sent_method(send) == "PATCH"
        assert _sent_url(send) == f"{_FILES_URL}/{FileBodies.FILE_ID}"
        assert _sent_body(send) == {"name": "March invoice"}
        assert record.name == "March invoice.pdf"

    def test_rename_refuses_a_name_that_is_not_a_string_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.RECORD))

        with pytest.raises(RequestArgumentError, match=r"^rename_file\(\) takes the file's new name, a string; got NoneType\.$"):
            asyncio.run(api_client.rename_file(FileBodies.FILE_ID, cast("str", None)))

        send.assert_not_called()

    def test_rename_raises_auth_forbidden_for_a_runner_renaming_anothers_file(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(
            api_client,
            wire_response(
                403,
                json_body=problem_document(
                    "auth.forbidden",
                    403,
                    domain="account",
                    detail="Your role in this organization is runner.",
                    params={"requirement": "a role that may change files"},
                ),
            ),
        )

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.rename_file(FileBodies.FILE_ID, "x"))

        assert (exc_info.value.problem.code, exc_info.value.problem.domain) == ("auth.forbidden", "account")

    # ----- link_files -----------------------------------------------------------------------------

    def test_links_post_each_file_by_its_id_or_its_address_and_read_one_verdict_per_file(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": [FileBodies.LINKED, FileBodies.REFUSED_LINK]}))

        result = asyncio.run(api_client.link_files([FileLinkTarget(uri=FileBodies.URI), FileLinkTarget(file_id="fl_gone")]))

        assert _sent_method(send) == "POST"
        assert _sent_url(send) == f"{_FILES_URL}/links"
        assert _sent_body(send) == {"files": [{"uri": FileBodies.URI}, {"file_id": "fl_gone"}]}
        linked, refused = result.items
        match linked:
            case FileLinked():
                assert linked.url == FileBodies.SIGNED_URL
            case FileLinkRefused():
                pytest.fail("A link read as refused.")
        match refused:
            case FileLinkRefused():
                assert refused.error.code == "not_found"
            case FileLinked():
                pytest.fail("A refusal read as a link.")

    @pytest.mark.parametrize(
        "kwargs",
        [
            pytest.param({}, id="neither"),
            pytest.param({"file_id": "fl_1", "uri": FileBodies.URI}, id="both"),
            pytest.param({"file_id": ""}, id="empty-id"),
            pytest.param({"file_id": "fl_1", "name": "x"}, id="unknown-field"),
        ],
    )
    def test_a_link_target_names_exactly_one_file_at_construction(self, kwargs: dict[str, Any]) -> None:
        with pytest.raises(ValidationError):
            FileLinkTarget(**kwargs)

    def test_links_raise_type_error_for_one_target_passed_alone(self, api_client: PipelexAPIClient) -> None:
        with pytest.raises(TypeError, match=r"^link_files\(\) takes a list of FileLinkTarget"):
            asyncio.run(api_client.link_files(cast("list[FileLinkTarget]", FileLinkTarget(file_id="fl_1"))))

    def test_links_raise_type_error_naming_an_item_that_is_not_a_target_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": []}))
        items = cast("list[FileLinkTarget]", [FileLinkTarget(file_id="fl_1"), {"file_id": "fl_2"}])

        with pytest.raises(TypeError, match=r"^link_files\(\) takes a list of FileLinkTarget, one per file to link; item 1 is a dict\.$"):
            asyncio.run(api_client.link_files(items))

        send.assert_not_called()

    @pytest.mark.parametrize(
        "items",
        [
            pytest.param([FileBodies.LINKED], id="fewer-items"),
            pytest.param([{**FileBodies.LINKED, "url": None}, FileBodies.REFUSED_LINK], id="neither-link-nor-error"),
            pytest.param([{**FileBodies.LINKED, "error": {"code": "x", "detail": "y"}}, FileBodies.REFUSED_LINK], id="link-and-error"),
        ],
    )
    def test_links_refuse_an_answer_off_one_verdict_per_file_and_hide_every_link(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, items: list[dict[str, Any]]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"items": items}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.link_files([FileLinkTarget(file_id=FileBodies.FILE_ID), FileLinkTarget(file_id="fl_gone")]))

        unreadable = exc_info.value
        assert str(unreadable) == "API POST /v1/files/links answered 200 with a body that is not the answer the route returns"
        assert "X-Amz-Signature=deadbeef" not in (unreadable.response_body or "")
        assert "deadbeef" not in str(unreadable.__cause__)
        assert unreadable.problem.code == "client.response_unreadable"

    # ----- copy_file_into_draft -------------------------------------------------------------------

    def test_copy_posts_the_file_the_path_and_the_token_and_reads_the_blob(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.DRAFT_COPY))

        result = asyncio.run(
            api_client.copy_file_into_draft(
                "mt_abc", file_id=FileBodies.FILE_ID, path="assets/logo.png", expected_updated_at="2026-10-23T08:00:00+00:00"
            )
        )

        assert _sent_method(send) == "POST"
        assert _sent_url(send) == f"{BASE_URL}/v1/methods/mt_abc/draft/files/from-file"
        assert _sent_body(send) == {"file_id": FileBodies.FILE_ID, "path": "assets/logo.png", "expected_updated_at": "2026-10-23T08:00:00+00:00"}
        assert result.blob == DraftFileBlob.COPIED
        assert result.file.path == "assets/logo.png"
        assert result.method.updated_at == FileBodies.METHOD["updated_at"]

    def test_copy_without_a_token_sends_none_and_reads_already_held(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={**FileBodies.DRAFT_COPY, "blob": "already_held"}))

        result = asyncio.run(api_client.copy_file_into_draft("mt_abc", file_id=FileBodies.FILE_ID, path="assets/logo.png"))

        assert _sent_body(send) == {"file_id": FileBodies.FILE_ID, "path": "assets/logo.png"}
        assert result.blob == DraftFileBlob.ALREADY_HELD

    @pytest.mark.parametrize(
        ("method_id", "kwargs", "message"),
        [
            pytest.param("mt_abc@3", {"file_id": "fl_1", "path": "a.png"}, r'"mt_abc@3" carries a version suffix', id="suffixed-method"),
            pytest.param("mt_abc", {"file_id": "", "path": "a.png"}, r"takes a file id, .*; got an empty string\.$", id="empty-file-id"),
            pytest.param(
                "mt_abc",
                {"file_id": "fl_1", "path": ""},
                r"takes the tree path the file takes in the draft, .*; got an empty string\.$",
                id="empty-path",
            ),
            pytest.param(
                "mt_abc", {"file_id": "fl_1", "path": "a.png", "expected_updated_at": 3}, r"takes the draft token .*; got int\.$", id="numeric-token"
            ),
        ],
    )
    def test_copy_refuses_what_names_no_copy_before_any_request(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        method_id: str,
        kwargs: dict[str, Any],
        message: str,
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.DRAFT_COPY))

        with pytest.raises(RequestArgumentError, match=message):
            asyncio.run(api_client.copy_file_into_draft(method_id, **kwargs))

        send.assert_not_called()

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({**FileBodies.DRAFT_COPY, "blob": "moved"}, id="unknown-blob"),
            pytest.param({**FileBodies.DRAFT_COPY, "file": None}, id="no-file"),
            pytest.param({**FileBodies.DRAFT_COPY, "method": "mt_abc"}, id="method-not-an-object"),
        ],
    )
    def test_copy_refuses_an_answer_it_cannot_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.copy_file_into_draft("mt_abc", file_id="fl_1", path="a.png"))

        assert exc_info.value.problem.code == "client.response_unreadable"

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(403, "auth.forbidden", id="runner"),
            pytest.param(409, "pipelex.catalog.update_conflict", id="stale-token"),
            pytest.param(422, "method.package_invalid", id="bad-path"),
        ],
    )
    def test_copy_surfaces_the_platforms_refusals_by_code(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status, detail="Refused.")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.copy_file_into_draft("mt_abc", file_id="fl_1", path="a.png"))

        assert exc_info.value.problem.code == code

    # ----- the record -----------------------------------------------------------------------------

    def test_a_generated_record_reads_its_role_and_its_runs_origin(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"items": [FileBodies.OUTPUT_RECORD]}))

        records = asyncio.run(api_client.get_files_by_uri(cast("str", FileBodies.OUTPUT_RECORD["uri"])))

        record = records.items[0]
        assert record.kind == FileKind.GENERATED
        assert record.role == FileRole.FINAL
        assert record.origin.method_version == 3
