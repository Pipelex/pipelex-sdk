"""`prepare_inputs` against a pipe I/O answer whose input-form descriptor is malformed where preparation
reads it, driven through the case file `tests/fixtures/malformed-input-forms.json`.

The file's source is `js/tests/fixtures/malformed-input-forms.json`, which `@pipelex/sdk`'s suite drives too;
this copy is written by `make shared-files` at the repository root and never edited here, and
`make check-shared-files` fails when the two differ, so both SDKs refuse the same answers. Here the client
parses the answer into the standard's closed models, so every case is refused before `prepare_inputs` walks
anything, as the `ApiResponseError` the client raises for a 2xx it cannot read: `client.response_unreadable`,
the code `@pipelex/sdk` gives its `InputPreparationError` for the same answer. Every request goes through
an `httpx.MockTransport`, below the client's `_send`, so a case also shows that nothing was uploaded.
"""

from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.crate_models import PipeIORequest, PipeIOValidReport
from pipelex_sdk.errors import ApiResponseError
from tests.unit.conftest import BASE_URL
from tests.unit.test_data import MalformedInputFormData

_CASE_FILE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "malformed-input-forms.json"
_CASE_FILE: dict[str, Any] = json.loads(_CASE_FILE_PATH.read_bytes())
_PIPE_REF: str = _CASE_FILE["pipe_ref"]
_CASES = [pytest.param(case["entry"], id=case["name"]) for case in _CASE_FILE["cases"]]


def _answer() -> dict[str, Any]:
    """A fresh copy of the shared well-formed answer."""
    return copy.deepcopy(_CASE_FILE["answer"])


def _client_answering(answer: dict[str, Any], seen: list[str]) -> PipelexAPIClient:
    """A client whose pipe I/O request is answered with `answer`, recording the path of every request."""

    def _respond(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        return httpx.Response(200, json=answer)

    client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(_respond))
    return client


def _inputs_for_every_field() -> dict[str, Any]:
    """A value for every input of the shared answer, each but the note needing an upload."""
    return {
        "doc": b"\x01",
        "note": "a note",
        "dossier": {"title": "t", "cover": b"\x02"},
        "pages": [b"\x03", b"\x04"],
    }


class TestPrepareInputsMalformedForm:
    def test_the_well_formed_answer_parses(self) -> None:
        seen: list[str] = []
        client = _client_answering(_answer(), seen)

        report = asyncio.run(client.pipe_io(PipeIORequest(files=MalformedInputFormData.FILES)))

        assert isinstance(report, PipeIOValidReport)
        assert [field.name for field in report.input_form[_PIPE_REF].fields] == ["doc", "note", "dossier", "pages"]

    @pytest.mark.parametrize("allow_uploads", [True, False])
    @pytest.mark.parametrize("entry", _CASES)
    def test_a_malformed_descriptor_is_refused_before_anything_is_uploaded(self, entry: object, allow_uploads: bool) -> None:
        answer = _answer()
        answer["input_form"][_PIPE_REF] = entry
        seen: list[str] = []
        client = _client_answering(answer, seen)

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.prepare_inputs(files=MalformedInputFormData.FILES, inputs=_inputs_for_every_field(), allow_uploads=allow_uploads))

        refused = exc_info.value
        assert str(refused) == "API POST /v1/pipe-io answered 200 with a body that is not the answer the route returns"
        assert isinstance(refused.__cause__, ValidationError)
        # The route broke its own contract, which no change to the request fixes.
        assert refused.problem.code == MalformedInputFormData.UNREADABLE_CODE
        assert seen == ["/v1/pipe-io"]
