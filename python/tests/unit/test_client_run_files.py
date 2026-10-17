"""Tests for a run's method given as `files`, the MTHDS standard's map of file entries, beside the inline
`mthds_contents` the Pipelex API still reads and the selectors that pair with neither.

`_send` is mocked, so what each test checks is the body the client would send, or the refusal it raises
before sending anything.
"""

import asyncio
import json
from typing import Any

import httpx
import pytest
from mthds.method_tree.file_entry import HashFileEntry
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import RequestArgumentError

_BASE_URL = "http://localhost:8081"
_MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n'
_HASHED = HashFileEntry(sha256="8ff436def1451285599a1b1ad70800493b8dcafde2912e1a38345633054e4c26", size=5)

_START_BODY = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-10-08T09:00:00Z"}
_EXECUTE_BODY: dict[str, object] = {
    "pipeline_run_id": "run_1",
    "main_stuff_name": "result",
    "pipe_output": {
        "working_memory": {
            "root": {"result": {"concept": "native.Text", "content": {"text": "hi"}}},
            "aliases": {"main_stuff": "result"},
        },
        "pipeline_run_id": "run_1",
    },
}

_ARGUMENT_VERDICT = ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)


def _response(status_code: int, *, json_body: object) -> httpx.Response:
    return httpx.Response(status_code, json=json_body, request=httpx.Request("POST", f"{_BASE_URL}/v1/start"))


def _sent_body(send: Any) -> dict[str, Any]:
    body: dict[str, Any] = json.loads(send.call_args.kwargs["content"])
    return body


class TestClientRunFiles:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    def test_files_reach_the_start_body_as_the_standard_writes_them(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json_body=_START_BODY)))

        asyncio.run(client.start(pipe_code="review_receipt", files={"main.mthds": _MAIN, "helper.py": _HASHED}))

        body = _sent_body(send)
        assert body["files"] == {"main.mthds": _MAIN, "helper.py": {"sha256": _HASHED.sha256, "size": 5}}
        assert body["pipe_code"] == "review_receipt"
        assert "mthds_contents" not in body

    def test_files_reach_the_execute_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json_body=_EXECUTE_BODY)))

        asyncio.run(client.execute(files={"main.mthds": _MAIN}))

        assert _sent_body(send)["files"] == {"main.mthds": _MAIN}

    def test_inline_bundles_still_ride_the_body_as_mthds_contents(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json_body=_START_BODY)))

        asyncio.run(client.start(mthds_contents=[_MAIN]))

        body = _sent_body(send)
        assert body["mthds_contents"] == [_MAIN]
        assert "files" not in body

    def test_start_and_wait_forwards_files_to_the_start(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_supports_run_lifecycle", mocker.AsyncMock(return_value=True))
        start = mocker.patch.object(client, "start", mocker.AsyncMock(side_effect=RequestArgumentError("stop here")))

        with pytest.raises(RequestArgumentError, match="stop here"):
            asyncio.run(client.start_and_wait(files={"main.mthds": _MAIN}))

        assert start.call_args.kwargs["files"] == {"main.mthds": _MAIN}

    def test_the_blocking_fallback_forwards_files_to_execute(self, mocker: MockerFixture) -> None:
        client = self._client()
        mocker.patch.object(client, "_supports_run_lifecycle", mocker.AsyncMock(return_value=False))
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json_body=_EXECUTE_BODY)))

        asyncio.run(client.start_and_wait(files={"main.mthds": _MAIN}))

        assert send.call_args.args[1] == f"{_BASE_URL}/v1/execute"
        assert _sent_body(send)["files"] == {"main.mthds": _MAIN}

    @pytest.mark.parametrize("route", ["start", "execute"])
    def test_an_empty_mthds_contents_alone_names_nothing_to_run(self, mocker: MockerFixture, route: str) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError, match=f"must be provided to the API {route}") as caught:
            asyncio.run(getattr(client, route)(mthds_contents=[]))

        assert error_verdict_of(caught.value) == _ARGUMENT_VERDICT
        send.assert_not_called()

    @pytest.mark.parametrize("smuggled", ["mthds_contents", "files"])
    def test_extra_cannot_carry_a_run_source(self, mocker: MockerFixture, smuggled: str) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError, match=smuggled) as caught:
            asyncio.run(client.start(pipe_code="p", extra={smuggled: [_MAIN]}))

        assert error_verdict_of(caught.value) == _ARGUMENT_VERDICT
        send.assert_not_called()

    @pytest.mark.parametrize("route", ["start", "execute"])
    def test_a_method_ref_pairs_with_no_files(self, mocker: MockerFixture, route: str) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError, match="method_ref and a method bundle"):
            asyncio.run(getattr(client, route)(method_ref="github.com/Pipelex/methods/documents@v0.1.0", files={"main.mthds": _MAIN}))

        send.assert_not_called()
