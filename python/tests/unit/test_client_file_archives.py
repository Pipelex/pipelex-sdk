"""Tests for zips of an organization's files — `request_file_archive` and `get_file_archive`.

The twin of `pipelex-sdk-js/tests/file-archives.test.ts`. `_send` is mocked; the bodies are the platform's own
serialized shapes (`FileBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, cast

import pytest

from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.product_models import FileArchiveFailureCode, FileArchiveLimit, FileArchiveSource, FileArchiveState
from tests.unit.conftest import BASE_URL, problem_document, refused_argument
from tests.unit.test_data import FileBodies

if TYPE_CHECKING:
    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import ResponseBuilder, SendPatcher

_ARCHIVES_URL = f"{BASE_URL}/v1/files/archives"


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


class TestClientFileArchives:
    def test_request_posts_the_file_ids_and_the_name_and_reads_the_archive_queued(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(202, json_body=FileBodies.QUEUED_ARCHIVE))

        archive = asyncio.run(api_client.request_file_archive(file_ids=["fl_1", "fl_2"], name="March invoices"))

        assert send.call_args.args[0] == "POST"
        assert send.call_args.args[1] == _ARCHIVES_URL
        assert _sent_body(send) == {"file_ids": ["fl_1", "fl_2"], "name": "March invoices"}
        assert archive.state == FileArchiveState.QUEUED
        assert archive.source == FileArchiveSource.FILES
        assert archive.url is None

    def test_request_posts_a_runs_files_by_run_id_alone(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        run_archive = {**FileBodies.QUEUED_ARCHIVE, "source": "run", "run_id": "run_7", "name": "files-run_7.zip"}
        send = patch_send(api_client, wire_response(202, json_body=run_archive))

        archive = asyncio.run(api_client.request_file_archive(run_id="run_7"))

        assert _sent_body(send) == {"run_id": "run_7"}
        assert archive.run_id == "run_7"

    @pytest.mark.parametrize(
        ("kwargs", "message", "argument", "reason"),
        [
            pytest.param({}, r"exactly one of file_ids and run_id; got neither\.$", "file_ids", "not_exactly_one", id="neither"),
            pytest.param(
                {"file_ids": ["fl_1"], "run_id": "run_7"},
                r"exactly one of file_ids and run_id; got both\.$",
                "file_ids",
                "not_exactly_one",
                id="both",
            ),
            pytest.param(
                {"file_ids": []},
                r"takes file_ids, a non-empty list of the file ids to zip; got an empty list\.$",
                "file_ids",
                "empty",
                id="empty-list",
            ),
            pytest.param(
                {"file_ids": ["fl_1", ""]}, r"takes a file id to zip, a non-empty string; got an empty string\.$", "file_ids", "empty", id="empty-id"
            ),
            pytest.param({"run_id": ""}, r"takes a run_id naming the run whose files to zip", "run_id", "empty", id="empty-run-id"),
            pytest.param(
                {"run_id": "run_7", "name": 3}, r"takes a name for the zip, a string, or none; got int\.$", "name", "not_a_string", id="numeric-name"
            ),
        ],
    )
    def test_request_refuses_what_names_no_zip_before_any_request(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        kwargs: dict[str, Any],
        message: str,
        argument: str,
        reason: str,
    ) -> None:
        send = patch_send(api_client, wire_response(202, json_body=FileBodies.QUEUED_ARCHIVE))

        with pytest.raises(RequestArgumentError, match=rf"^request_file_archive\(\) .*{message}") as exc_info:
            asyncio.run(api_client.request_file_archive(**kwargs))

        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        assert refused_argument(exc_info.value) == {"argument": argument, "reason": reason}
        send.assert_not_called()

    def test_request_raises_type_error_for_file_ids_given_as_one_string(self, api_client: PipelexAPIClient) -> None:
        with pytest.raises(TypeError, match=r"takes file_ids as a list of file ids, not a single string\.$"):
            asyncio.run(api_client.request_file_archive(file_ids=cast("list[str]", "fl_1")))

    def test_request_surfaces_a_selection_past_a_cap_with_the_limit_it_names(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(422, json_body=FileBodies.ARCHIVE_TOO_LARGE))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.request_file_archive(file_ids=["fl_1", "fl_2"]))

        refusal = exc_info.value
        # The code is the platform's; the SDK keeps the problem's `limit` member as received.
        assert refusal.problem.code == "pipelex.files.archive_too_large"
        assert (refusal.problem.domain, refusal.problem.retry) == ("input", "no")
        limit = FileArchiveLimit.model_validate((refusal.problem.model_extra or {})["limit"])
        assert limit == FileArchiveLimit(name="max_total_bytes", value=2000000000, reached=2147483648)

    def test_request_surfaces_a_run_not_yet_recorded_as_a_retryable_conflict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = problem_document("run.not_finished", 409, domain="runtime", retry="yes", detail="Not all recorded yet.")
        patch_send(api_client, wire_response(409, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.request_file_archive(run_id="run_7"))

        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("runtime", "yes")

    def test_get_reads_a_ready_archive_with_its_link(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.READY_ARCHIVE))

        archive = asyncio.run(api_client.get_file_archive(FileBodies.ARCHIVE_ID))

        assert send.call_args.args[0] == "GET"
        assert send.call_args.args[1] == f"{_ARCHIVES_URL}/{FileBodies.ARCHIVE_ID}"
        assert archive.state == FileArchiveState.READY
        assert archive.url == FileBodies.ARCHIVE_URL
        assert archive.archive_bytes == 3101422

    def test_get_reads_a_failed_archive_as_a_value(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        failed = {**FileBodies.QUEUED_ARCHIVE, "state": "failed", "failure": {"code": "file_gone", "detail": "A file was deleted."}}
        patch_send(api_client, wire_response(200, json_body=failed))

        archive = asyncio.run(api_client.get_file_archive(FileBodies.ARCHIVE_ID))

        assert archive.state == FileArchiveState.FAILED
        assert archive.failure is not None
        assert archive.failure.code == FileArchiveFailureCode.FILE_GONE

    def test_get_follows_the_documented_loop_until_ready(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(
            api_client,
            wire_response(200, json_body=FileBodies.QUEUED_ARCHIVE),
            wire_response(200, json_body={**FileBodies.QUEUED_ARCHIVE, "state": "building"}),
            wire_response(200, json_body=FileBodies.READY_ARCHIVE),
        )

        async def _until_done() -> FileArchiveState:
            archive = await api_client.get_file_archive(FileBodies.ARCHIVE_ID)
            while archive.state in {FileArchiveState.QUEUED, FileArchiveState.BUILDING}:
                archive = await api_client.get_file_archive(FileBodies.ARCHIVE_ID)
            return archive.state

        assert asyncio.run(_until_done()) == FileArchiveState.READY
        assert send.call_count == 3

    def test_get_refuses_an_empty_archive_id_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.READY_ARCHIVE))

        with pytest.raises(
            RequestArgumentError, match=r"^get_file_archive\(\) takes an archive id, the archive's non-empty `archive_id`; got an empty string\.$"
        ):
            asyncio.run(api_client.get_file_archive(""))

        send.assert_not_called()

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({**FileBodies.READY_ARCHIVE, "state": "done"}, id="unknown-state"),
            pytest.param({key: value for key, value in FileBodies.READY_ARCHIVE.items() if key != "archive_id"}, id="no-archive-id"),
        ],
    )
    def test_get_refuses_an_archive_it_cannot_read_and_hides_its_link(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_file_archive(FileBodies.ARCHIVE_ID))

        unreadable = exc_info.value
        assert (
            str(unreadable) == f"API GET /v1/files/archives/{FileBodies.ARCHIVE_ID} answered 200 with a body that is not the answer the route returns"
        )
        assert "deadbeef" not in (unreadable.response_body or "")
        assert "deadbeef" not in str(unreadable.__cause__)

    def test_get_raises_not_found_for_an_expired_archive(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body=problem_document("pipelex.storage.not_found", 404, detail="Item not found.")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_file_archive(FileBodies.ARCHIVE_ID))

        assert exc_info.value.problem.code == "pipelex.storage.not_found"
