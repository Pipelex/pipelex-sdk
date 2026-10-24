"""Tests for a run's method given as its tree, in `files` (the MTHDS standard's map of file entries), `tree`
or `contents`, and the selectors that pair with none of them.

`_send` is mocked, so what each test checks is the body the client would send, or the refusal it raises
before sending anything. How a `tree` or `contents` is prepared, inline or by hash, is pinned in
`test_client_run_trees.py`.
"""

import asyncio
import inspect
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from mthds.method_tree.file_entry import HashFileEntry
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import RequestArgumentError
from tests.unit.conftest import refused_argument

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

    def test_files_reach_the_execute_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json_body=_EXECUTE_BODY)))

        asyncio.run(client.execute(files={"main.mthds": _MAIN}))

        assert _sent_body(send)["files"] == {"main.mthds": _MAIN}

    @pytest.mark.parametrize("route", ["start", "execute"])
    def test_small_contents_reach_the_body_inline_with_no_other_request(self, mocker: MockerFixture, route: str) -> None:
        client = self._client()
        answer = _response(202, json_body=_START_BODY) if route == "start" else _response(200, json_body=_EXECUTE_BODY)
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=answer))

        asyncio.run(getattr(client, route)(contents={"main.mthds": _MAIN, "data/logo.bin": b"\x89PNG"}))

        send.assert_called_once()
        assert _sent_body(send)["files"] == {"main.mthds": _MAIN, "data/logo.bin": {"base64": "iVBORw=="}}

    def test_a_bundle_riding_extra_reaches_the_body_as_given(self, mocker: MockerFixture) -> None:
        """The Pipelex API's `mthds_contents` is no argument of this client, so a caller still sending it passes it through `extra`."""
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json_body=_START_BODY)))

        asyncio.run(client.start(extra={"mthds_contents": [_MAIN]}))

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
    def test_empty_files_name_no_tree_and_are_refused(self, mocker: MockerFixture, route: str) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError, match="files holds no file") as caught:
            asyncio.run(getattr(client, route)(pipe_code="p", files={}))

        assert (caught.value.problem.domain, caught.value.problem.retry) == ("input", "no")
        assert refused_argument(caught.value) == {"argument": "files", "reason": "empty"}
        send.assert_not_called()

    @pytest.mark.parametrize("route", ["start", "execute", "start_and_wait"])
    def test_empty_contents_are_refused_with_no_word_of_a_draft(self, mocker: MockerFixture, route: str) -> None:
        """An empty draft is a save's, so a run's refusal names nothing it cannot take."""
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(getattr(client, route)(pipe_code="p", contents={}))

        assert str(caught.value) == f"{route}() got contents holding no file, and a method tree holds at least one."
        assert refused_argument(caught.value) == {"argument": "contents", "reason": "empty"}
        send.assert_not_called()

    def test_extra_cannot_carry_the_protocol_files(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError, match="files") as caught:
            asyncio.run(client.start(pipe_code="p", extra={"files": {"main.mthds": _MAIN}}))

        assert (caught.value.problem.domain, caught.value.problem.retry) == ("input", "no")
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("forms", "named"),
        [
            pytest.param({"files": {"main.mthds": _MAIN}, "contents": {"main.mthds": _MAIN}}, "files and contents", id="files-contents"),
            pytest.param({"files": {"main.mthds": _MAIN}, "tree": Path("method")}, "files and tree", id="files-tree"),
            pytest.param({"tree": Path("method"), "contents": {"main.mthds": _MAIN}}, "tree and contents", id="tree-contents"),
        ],
    )
    @pytest.mark.parametrize("route", ["start", "execute", "start_and_wait"])
    def test_a_tree_given_in_two_forms_is_refused_before_any_request(
        self, mocker: MockerFixture, route: str, forms: dict[str, Any], named: str
    ) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(getattr(client, route)(pipe_code="p", **forms))

        assert str(caught.value) == f"{route}() takes the method's tree in one form, files, tree or contents; got {named}."
        assert refused_argument(caught.value) == {"argument": "files", "reason": "mutually_exclusive"}
        send.assert_not_called()

    @pytest.mark.parametrize("form", ["files", "contents"])
    @pytest.mark.parametrize("route", ["start", "execute", "start_and_wait"])
    def test_a_method_ref_pairs_with_no_tree(self, mocker: MockerFixture, route: str, form: str) -> None:
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError, match="method_ref and the method's tree"):
            asyncio.run(getattr(client, route)(method_ref="github.com/Pipelex/methods/documents@v0.1.0", **{form: {"main.mthds": _MAIN}}))

        send.assert_not_called()

    def test_start_and_wait_takes_every_argument_but_the_pipe_by_keyword(self) -> None:
        """So no positional call reads one run source as another, as `start` and `execute` read `files` second."""
        parameters = list(inspect.signature(PipelexAPIClient.start_and_wait).parameters.values())

        assert [parameter.name for parameter in parameters[:2]] == ["self", "pipe_code"]
        assert all(parameter.kind is inspect.Parameter.KEYWORD_ONLY for parameter in parameters[2:])
        assert {"files", "tree", "contents", "method_ref", "method_id"} <= {parameter.name for parameter in parameters[2:]}

    @pytest.mark.parametrize("route", ["start", "execute"])
    def test_the_tree_forms_beside_files_are_keyword_only(self, route: str) -> None:
        """`start` and `execute` keep the protocol's positional order, and every argument they add is named."""
        parameters = inspect.signature(getattr(PipelexAPIClient, route)).parameters

        assert all(parameters[name].kind is inspect.Parameter.KEYWORD_ONLY for name in ("tree", "contents", "method_ref", "method_id"))
        assert "mthds_contents" not in parameters
