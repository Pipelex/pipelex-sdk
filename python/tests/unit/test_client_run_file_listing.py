"""Tests for a run's files — `list_run_files`, `GET /v1/runs/{run_id}/files`.

The twin of `pipelex-sdk-js/tests/run-file-listing.test.ts`. `_send` is mocked; the body is the platform's own
serialized shape (`FileBodies.RUN_FILES_PAGE`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import pytest

from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.product_models import FileRole, RunFileMark, RunFilesState
from tests.unit.conftest import BASE_URL, problem_document
from tests.unit.test_data import FileBodies

if TYPE_CHECKING:
    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import ResponseBuilder, SendPatcher


class TestClientRunFileListing:
    def test_list_reads_a_page_of_the_runs_inputs_outputs_and_links(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.RUN_FILES_PAGE))

        page = asyncio.run(api_client.list_run_files("run_7"))

        assert send.call_args.args[0] == "GET"
        assert send.call_args.args[1] == f"{BASE_URL}/v1/runs/run_7/files"
        assert page.state == RunFilesState.LISTED
        assert page.inputs[0].mark == RunFileMark.INPUT
        assert page.inputs[0].input_name == "invoice"
        output = page.outputs[0]
        assert output.mark == RunFileMark.FINAL
        assert output.file is not None
        assert output.file.role == FileRole.FINAL
        assert page.links[0].url == "https://example.com/logo.png"
        assert page.next_cursor == "c2"

    def test_list_pages_the_runs_own_records_with_limit_and_cursor(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body: dict[str, Any] = {**FileBodies.RUN_FILES_PAGE, "inputs": [], "links": [], "next_cursor": None}
        send = patch_send(api_client, wire_response(200, json_body=body))

        page = asyncio.run(api_client.list_run_files("run_7", limit=20, cursor="c2"))

        assert send.call_args.args[1] == f"{BASE_URL}/v1/runs/run_7/files?limit=20&cursor=c2"
        assert page.next_cursor is None

    def test_list_reads_a_run_still_being_recorded_as_listing_and_an_input_without_a_record(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        unrecorded = {"mark": "input", "input_name": "invoice", "uri": FileBodies.URI, "file": None}
        body = {**FileBodies.RUN_FILES_PAGE, "state": "listing", "inputs": [unrecorded], "outputs": [], "next_cursor": None}
        patch_send(api_client, wire_response(200, json_body=body))

        page = asyncio.run(api_client.list_run_files("run_7"))

        assert page.state == RunFilesState.LISTING
        assert page.inputs[0].file is None

    def test_list_refuses_an_empty_run_id_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=FileBodies.RUN_FILES_PAGE))

        with pytest.raises(
            RequestArgumentError, match=r"^list_run_files\(\) takes a run id, the run's non-empty `pipeline_run_id`; got an empty string\.$"
        ):
            asyncio.run(api_client.list_run_files(""))

        send.assert_not_called()

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({**FileBodies.RUN_FILES_PAGE, "state": "done"}, id="unknown-state"),
            pytest.param({key: value for key, value in FileBodies.RUN_FILES_PAGE.items() if key != "outputs"}, id="no-outputs"),
            pytest.param({**FileBodies.RUN_FILES_PAGE, "links": {}}, id="links-not-a-list"),
            pytest.param({**FileBodies.RUN_FILES_PAGE, "next_cursor": 2}, id="numeric-cursor"),
        ],
    )
    def test_list_refuses_a_page_it_cannot_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_run_files("run_7"))

        assert str(exc_info.value) == "API GET /v1/runs/run_7/files answered 200 with a body that is not the answer the route returns"
        assert exc_info.value.problem.code == "client.response_unreadable"

    def test_list_raises_for_another_organizations_run(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body=problem_document("run.not_found", 404, detail="Run not found.")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_run_files("run_7"))

        assert exc_info.value.problem.code == "run.not_found"
