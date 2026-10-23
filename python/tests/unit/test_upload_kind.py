"""What an upload is recorded as on `POST /v1/upload`: the `kind` and `method_id` carried through `upload`,
`upload_file` and `prepare_inputs`, the pair checked before any file is read, and the upload route's
refusals of a test file, each read as the `TestFileRefusedError` it is while the refusals that only share
its status keep their old reading.

Ports `pipelex-sdk-js/tests/upload-kind.test.ts`. The refusals are answered below the client's `_send`,
through an `httpx.MockTransport`, so the client's real request pipeline and problem parsing run.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, cast

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import (
    ApiResponseError,
    InputPreparationError,
    InvalidLocalSourceError,
    TestFileRefusalCode,
    TestFileRefusedError,
    UnsupportedUploadCapabilityError,
    UploadAuthenticationError,
    UploadTransportError,
)
from pipelex_sdk.product_models import FileKind, UploadedFile, UploadInput, UploadKind
from pipelex_sdk.upload import UploadKindOptions, upload_file
from tests.unit.conftest import refused_argument
from tests.unit.test_data import PipeIOBodies

if TYPE_CHECKING:
    from pathlib import Path

_BASE_URL = "http://localhost:8081"
_STORED = {"uri": "pipelex-storage://org_1/assets/a.pdf", "filename": "case.pdf"}
_CONFIG = ErrorVerdict(error_domain=ErrorDomain.CONFIG, retryable=False)
_INPUT = ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)


class _RecordingUploadClient:
    """A fake `upload` client that records each wire model it is handed and stores nothing."""

    def __init__(self) -> None:
        self.api_key = "test-token"
        self.calls: list[UploadInput] = []

    async def upload(self, upload_input: UploadInput) -> UploadedFile:
        self.calls.append(upload_input)
        return UploadedFile(uri="pipelex-storage://org_1/assets/a.pdf", filename=upload_input.filename)


def _problem(status: int, code: str, error_domain: str, detail: str) -> dict[str, Any]:
    """A platform refusal as the platform serializes one: RFC 9457 with its code and verdict."""
    return {
        "type": f"https://pipelex.com/errors/{code}",
        "title": code,
        "status": status,
        "detail": detail,
        "code": code,
        "error_domain": error_domain,
        "retryable": False,
        "instance": "/v1/upload",
    }


def _client_answering(status: int, body: dict[str, Any], sent: list[httpx.Request] | None = None) -> PipelexAPIClient:
    """A client whose every request the API answers with `status` and `body`, recording each request in `sent`."""
    content_type = "application/json" if 200 <= status < 300 else "application/problem+json"

    def _answer(request: httpx.Request) -> httpx.Response:
        if sent is not None:
            sent.append(request)
        return httpx.Response(status, json=body, headers={"content-type": content_type}, request=request)

    client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(_answer))
    return client


def _preparing_client(sent: list[httpx.Request]) -> PipelexAPIClient:
    """A client the API answers as `prepare_inputs` needs: the pipe I/O report, and a new address per upload."""

    def _answer(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if request.url.path == "/v1/pipe-io":
            return httpx.Response(200, json=PipeIOBodies.VALID, request=request)
        if request.url.path == "/v1/upload":
            stored = {"uri": f"pipelex-storage://org_1/assets/{len(sent)}.bin", "filename": "f.bin"}
            return httpx.Response(200, json=stored, request=request)
        msg = f"unexpected request to {request.url}"
        raise AssertionError(msg)

    client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(_answer))
    return client


def _body_of(request: httpx.Request) -> dict[str, Any]:
    return cast("dict[str, Any]", json.loads(request.content))


def _refused_test_file(status: int, body: dict[str, Any], *, method_id: str = "mt_abc") -> InputPreparationError:
    """What `upload_file` raises when the upload route answers `status` and `body` to a test file."""
    client = _client_answering(status, body)
    with pytest.raises(InputPreparationError) as caught:
        asyncio.run(client.upload_file(b"\x01", filename="case.pdf", kind=UploadKind.TEST, method_id=method_id))
    return caught.value


class TestUploadKind:
    # ── The pair on the wire ──

    def test_upload_sends_kind_and_method_id_in_the_body_as_given(self) -> None:
        sent: list[httpx.Request] = []
        client = _client_answering(200, _STORED, sent)

        asyncio.run(
            client.upload(UploadInput(filename="a.pdf", data="Zm9v", content_type="application/pdf", kind=UploadKind.TEST, method_id="mt_abc"))
        )

        assert _body_of(sent[0]) == {"filename": "a.pdf", "data": "Zm9v", "content_type": "application/pdf", "kind": "test", "method_id": "mt_abc"}

    def test_upload_file_sends_a_test_file_s_kind_and_method_with_its_bytes(self) -> None:
        sent: list[httpx.Request] = []
        client = _client_answering(200, _STORED, sent)

        record = asyncio.run(client.upload_file(b"\x01\x02\x03", filename="case.png", kind=UploadKind.TEST, method_id="mt_abc"))

        assert _body_of(sent[0]) == {"filename": "case.png", "data": "AQID", "content_type": "image/png", "kind": "test", "method_id": "mt_abc"}
        assert record.uri == _STORED["uri"]

    def test_upload_file_sends_neither_member_when_neither_is_given(self) -> None:
        sent: list[httpx.Request] = []
        client = _client_answering(200, _STORED, sent)

        asyncio.run(client.upload_file(b"\x01", filename="c.bin"))

        assert sorted(_body_of(sent[0])) == ["content_type", "data", "filename"]

    def test_a_kind_given_as_its_string_is_sent_as_that_kind(self) -> None:
        client = _RecordingUploadClient()

        asyncio.run(upload_file(client, b"\x01", filename="a.pdf", kind=cast("UploadKind", "test"), method_id="mt_abc"))

        assert client.calls[0].kind is UploadKind.TEST
        assert client.calls[0].method_id == "mt_abc"

    def test_an_explicit_kind_uploaded_is_sent_and_a_none_method_is_not(self) -> None:
        client = _RecordingUploadClient()

        asyncio.run(upload_file(client, b"\x01", filename="a.pdf", kind=UploadKind.UPLOADED, method_id=None))

        assert client.calls[0].model_dump(exclude_none=True)["kind"] == "uploaded"
        assert client.calls[0].method_id is None

    # ── The pair, checked before any file is read ──

    @pytest.mark.parametrize(
        ("kind", "method_id", "words", "named"),
        [
            pytest.param(
                UploadKind.TEST, None, "a test file names the method", {"argument": "method_id", "reason": "missing"}, id="test-without-method"
            ),
            pytest.param(
                None, "mt_abc", "only a test file names a method", {"argument": "method_id", "reason": "without_test_kind"}, id="method-without-kind"
            ),
            pytest.param(
                UploadKind.UPLOADED,
                "mt_abc",
                "only a test file names a method",
                {"argument": "method_id", "reason": "without_test_kind"},
                id="method-beside-uploaded",
            ),
            pytest.param(
                "draft", None, '`kind` is "uploaded" or "test", got "draft"', {"argument": "kind", "reason": "unknown_value"}, id="unknown-kind"
            ),
            pytest.param(
                FileKind.GENERATED,
                None,
                '`kind` is "uploaded" or "test", got "generated"',
                {"argument": "kind", "reason": "unknown_value"},
                id="generated-kind",
            ),
            pytest.param(3, None, "got int", {"argument": "kind", "reason": "unknown_value"}, id="kind-not-a-string"),
            pytest.param(
                UploadKind.TEST, "mt_abc@3", "with no version suffix", {"argument": "method_id", "reason": "version_suffix"}, id="versioned-method"
            ),
            pytest.param(
                UploadKind.TEST, "mt_abc@draft", "with no version suffix", {"argument": "method_id", "reason": "version_suffix"}, id="draft-method"
            ),
            pytest.param(UploadKind.TEST, "", "is not a catalog id", {"argument": "method_id", "reason": "not_a_catalog_id"}, id="empty-method"),
            pytest.param(UploadKind.TEST, "abc", "is not a catalog id", {"argument": "method_id", "reason": "not_a_catalog_id"}, id="no-catalog-id"),
            pytest.param(UploadKind.TEST, 7, "got int", {"argument": "method_id", "reason": "not_a_string"}, id="method-not-a-string"),
        ],
    )
    def test_refuses_a_pair_the_route_would_refuse_before_reading_the_asset(
        self, kind: object, method_id: object, words: str, named: dict[str, str], tmp_path: Path
    ) -> None:
        client = _RecordingUploadClient()

        # A path that does not exist: a refusal after reading would be an InvalidLocalSourceError.
        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(upload_file(client, tmp_path / "absent.pdf", kind=cast("UploadKind", kind), method_id=cast("str", method_id)))

        assert not isinstance(caught.value, InvalidLocalSourceError)
        assert str(caught.value).startswith("Cannot upload: ")
        assert words in str(caught.value)
        assert refused_argument(caught.value) == named
        assert error_verdict_of(caught.value) == _INPUT
        assert client.calls == []

    # ── The upload route's refusals of a test file ──

    def test_reads_a_403_role_not_permitted_as_the_caller_s_role_not_its_credential(self) -> None:
        detail = "Your role in this organization is runner: it runs the organization's published versions and changes no method."

        error = _refused_test_file(403, _problem(403, "role_not_permitted", "config", detail))

        assert isinstance(error, TestFileRefusedError)
        assert not isinstance(error, UploadAuthenticationError)
        assert (error.code, error.status, error.filename, error.method_id) == (TestFileRefusalCode.ROLE_NOT_PERMITTED, 403, "case.pdf", "mt_abc")
        assert str(error) == (
            f'Upload of "case.pdf" as a test file was refused (403): {detail}. '
            'Upload it as "uploaded", or with the credential of a member who may change methods.'
        )
        # The server's verdict: an admin changes the role; sending again changes nothing.
        assert error_verdict_of(error) == _CONFIG
        assert isinstance(error.__cause__, ApiResponseError)
        assert error.problem == error.__cause__.problem

    def test_reads_a_404_not_found_the_platform_answers_as_input_as_the_unknown_method(self) -> None:
        error = _refused_test_file(404, _problem(404, "not_found", "input", "Item not found."), method_id="mt_gone")

        assert isinstance(error, TestFileRefusedError)
        assert not isinstance(error, UnsupportedUploadCapabilityError)
        assert (error.code, error.method_id) == (TestFileRefusalCode.METHOD_NOT_FOUND, "mt_gone")
        assert str(error) == 'Upload of "case.pdf" as a test file was refused (404): the method "mt_gone" is not one of the organization\'s methods.'
        assert error_verdict_of(error) == _INPUT

    def test_reads_a_409_method_being_deleted_as_the_method_being_erased(self) -> None:
        error = _refused_test_file(409, _problem(409, "method_being_deleted", "input", "Method 'mt_abc' is being deleted."))

        assert isinstance(error, TestFileRefusedError)
        assert error.code == TestFileRefusalCode.METHOD_BEING_DELETED
        assert str(error) == 'Upload of "case.pdf" as a test file was refused (409): the method "mt_abc" is being deleted.'
        assert error_verdict_of(error) == _INPUT

    def test_keeps_a_404_the_platform_answers_as_config_a_deployment_without_the_route_unsupported(self) -> None:
        error = _refused_test_file(404, _problem(404, "not_found", "config", "Not Found"))

        assert type(error) is UnsupportedUploadCapabilityError

    def test_keeps_a_bare_runner_s_404_which_carries_no_code_unsupported(self) -> None:
        error = _refused_test_file(404, {"detail": "Not Found"})

        assert type(error) is UnsupportedUploadCapabilityError

    def test_keeps_any_other_403_a_refused_credential(self) -> None:
        error = _refused_test_file(403, _problem(403, "forbidden", "config", "Forbidden."))

        assert type(error) is UploadAuthenticationError

    def test_keeps_any_other_409_a_transport_failure_carrying_the_server_s_verdict(self) -> None:
        error = _refused_test_file(409, _problem(409, "conflict", "input", "Key reused."))

        assert type(error) is UploadTransportError
        assert error_verdict_of(error) == _INPUT

    @pytest.mark.parametrize(
        ("code", "problem_code"),
        [
            pytest.param(TestFileRefusalCode.ROLE_NOT_PERMITTED, "auth.forbidden", id="role"),
            pytest.param(TestFileRefusalCode.METHOD_NOT_FOUND, "client.argument_invalid", id="unknown-method"),
            pytest.param(TestFileRefusalCode.METHOD_BEING_DELETED, "client.argument_invalid", id="method-being-erased"),
            pytest.param(None, "client.argument_invalid", id="no-code"),
        ],
    )
    def test_a_refusal_built_without_a_cause_states_the_problem_of_its_code(self, code: TestFileRefusalCode | None, problem_code: str) -> None:
        error = TestFileRefusedError("The test file was refused.", code=code)

        assert error.problem.code == problem_code
        if code is not None and problem_code == "client.argument_invalid":
            assert refused_argument(error) == {"argument": "method_id", "reason": code}

    def test_reads_a_404_not_found_as_unsupported_when_the_upload_named_no_method(self) -> None:
        client = _client_answering(404, _problem(404, "not_found", "input", "Item not found."))

        with pytest.raises(UnsupportedUploadCapabilityError):
            asyncio.run(client.upload_file(b"\x01", filename="a.pdf"))

    # ── Every upload of a preparation ──

    def test_prepare_inputs_sends_its_upload_s_kind_and_method_with_every_file_it_uploads(self) -> None:
        sent: list[httpx.Request] = []
        client = _preparing_client(sent)

        prepared = asyncio.run(
            client.prepare_inputs(
                method_id="mt_abc",
                inputs={"doc": b"\x01", "note": "a note", "dossier": {"title": "A dossier", "cover": b"\x02"}},
                upload=UploadKindOptions(kind=UploadKind.TEST, method_id="mt_abc"),
            )
        )

        uploads = [_body_of(request) for request in sent if request.url.path == "/v1/upload"]
        assert len(uploads) == 2
        for body in uploads:
            assert (body["kind"], body["method_id"]) == ("test", "mt_abc")
        # The request's own `method_id` still selects the method on the pipe I/O call, which carries no `upload`.
        pipe_io = next(_body_of(request) for request in sent if request.url.path == "/v1/pipe-io")
        assert pipe_io["method_id"] == "mt_abc"
        assert "upload" not in pipe_io
        assert len(prepared.uploads) == 2

    def test_prepare_inputs_without_upload_sends_neither_member(self) -> None:
        sent: list[httpx.Request] = []
        client = _preparing_client(sent)

        asyncio.run(client.prepare_inputs(method_id="mt_abc", inputs={"doc": b"\x01"}))

        upload = next(_body_of(request) for request in sent if request.url.path == "/v1/upload")
        assert sorted(upload) == ["content_type", "data", "filename"]

    def test_prepare_inputs_refuses_a_test_upload_naming_no_method_before_any_request(self) -> None:
        sent: list[httpx.Request] = []
        client = _preparing_client(sent)

        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(client.prepare_inputs(method_id="mt_abc", inputs={"doc": b"\x01"}, upload=UploadKindOptions(kind=UploadKind.TEST)))

        assert str(caught.value) == (
            'Cannot prepare inputs: a test file names the method it is for; give `upload.method_id` with `upload.kind="test"`.'
        )
        assert refused_argument(caught.value) == {"argument": "upload.method_id", "reason": "missing"}
        assert sent == []

    def test_prepare_inputs_refuses_an_upload_that_is_no_upload_kind_options_before_any_request(self) -> None:
        sent: list[httpx.Request] = []
        client = _preparing_client(sent)
        given: Any = {"kind": "test", "method_id": "mt_abc"}

        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(client.prepare_inputs(method_id="mt_abc", inputs={"doc": b"\x01"}, upload=given))

        assert str(caught.value) == "Cannot prepare inputs: `upload` must be an UploadKindOptions of `kind` and `method_id`, got dict."
        assert refused_argument(caught.value) == {"argument": "upload", "reason": "not_upload_kind_options"}
        assert sent == []

    def test_prepare_inputs_refuses_a_test_file_the_route_refuses_for_its_method(self) -> None:
        def _answer(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/pipe-io":
                return httpx.Response(200, json=PipeIOBodies.VALID, request=request)
            body = _problem(409, "method_being_deleted", "input", "Method 'mt_abc' is being deleted.")
            return httpx.Response(409, json=body, headers={"content-type": "application/problem+json"}, request=request)

        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        client.client = httpx.AsyncClient(transport=httpx.MockTransport(_answer))

        with pytest.raises(TestFileRefusedError) as caught:
            asyncio.run(
                client.prepare_inputs(method_id="mt_abc", inputs={"doc": b"\x01"}, upload=UploadKindOptions(kind=UploadKind.TEST, method_id="mt_abc"))
            )

        assert (caught.value.code, caught.value.method_id) == (TestFileRefusalCode.METHOD_BEING_DELETED, "mt_abc")
