"""`prepare_inputs` with `allow_uploads=False`: a value at a file input that would need an upload — a
local path, a `data:` URL, bytes — is refused with an `UploadNotAllowedError` naming the input and where
inside it the value sits, before anything is read, decoded or uploaded, while `http(s)` URLs and
`pipelex-storage://` references pass through (`docs/input-preparation.md`, "Preparing without uploads").

Ports `js/tests/prepare-inputs-no-uploads.test.ts`. The upload module's path reader is spied on, so a case
shows that no file was read at all rather than only that nothing was uploaded.
"""

import asyncio
from pathlib import Path
from typing import Any

import pytest
from mthds.protocol.input_form import (
    DocumentField,
    DocumentItem,
    ImageField,
    InputFormField,
    ListField,
    ObjectField,
    PipeInputFormDescriptor,
    TextField,
)
from mthds.protocol.pipe_io_contracts import PresenceMarker
from pytest_mock import MockerFixture

from pipelex_sdk import upload as upload_module
from pipelex_sdk.crate_models import MthdsFileItem, PipeIORequest, PipeIOValidReport
from pipelex_sdk.error_verdicts import ErrorDomain, error_verdict_of
from pipelex_sdk.errors import InputPreparationError, InvalidInputValueError, UploadNotAllowedError, UploadNotAllowedKind
from pipelex_sdk.prepare_inputs import prepare_inputs
from pipelex_sdk.product_models import UploadedFile, UploadInput

_FILES = [MthdsFileItem(content='domain = "demo"')]
_PIPE_REF = "demo.main"


def _required(**kwargs: Any) -> dict[str, Any]:
    return {"required": True, "presence": PresenceMarker.PLAIN, "gating": True, **kwargs}


class _FakeClient:
    """`pipe_io` answers one pipe's descriptor and records the request; `upload` counts its calls."""

    def __init__(self, *fields: InputFormField) -> None:
        self._report = PipeIOValidReport(
            is_valid=True,
            pipe_ref=_PIPE_REF,
            pipe_io_contracts={},
            input_form={_PIPE_REF: PipeInputFormDescriptor(fields=list(fields))},
            output_form={},
            default_pipe_ref=_PIPE_REF,
            pending_signatures=[],
            is_runnable=True,
        )
        self.pipe_io_calls: list[PipeIORequest] = []
        self.upload_calls = 0

    async def pipe_io(self, request: PipeIORequest) -> PipeIOValidReport:
        self.pipe_io_calls.append(request)
        return self._report

    async def upload(self, upload_input: UploadInput) -> UploadedFile:
        self.upload_calls += 1
        return UploadedFile(uri=f"pipelex-storage://user/assets/{self.upload_calls}.bin", filename=upload_input.filename)


def _image_client() -> _FakeClient:
    return _FakeClient(ImageField(name="photo", **_required()))


def _refused(client: _FakeClient, inputs: dict[str, Any]) -> UploadNotAllowedError:
    with pytest.raises(UploadNotAllowedError) as exc_info:
        asyncio.run(prepare_inputs(client, files=_FILES, inputs=inputs, allow_uploads=False))
    return exc_info.value


@pytest.fixture
def read_spy(mocker: MockerFixture) -> Any:
    """The upload module's path reader, still reading, but counted."""
    return mocker.patch.object(upload_module, "_read_path", wraps=upload_module._read_path)  # pyright: ignore[reportPrivateUsage]


class TestPrepareInputsWithoutUploads:
    def test_refuses_a_local_path_that_exists_without_reading_it(self, tmp_path: Path, read_spy: Any) -> None:
        path = tmp_path / "shot.png"
        path.write_bytes(b"\x01\x02\x03\x04")
        client = _image_client()

        for source in (str(path), path):
            error = _refused(client, {"photo": source})

            assert (error.input_name, error.input_path, error.value_kind) == ("photo", "photo", UploadNotAllowedKind.LOCAL_PATH)
        read_spy.assert_not_called()
        assert client.upload_calls == 0

    def test_refuses_a_local_path_inside_canonical_url_content(self, read_spy: Any) -> None:
        client = _FakeClient(DocumentField(name="report", **_required()))

        error = _refused(client, {"report": {"url": "/etc/passwd", "filename": "report.pdf"}})

        assert (error.input_path, error.value_kind) == ("report", UploadNotAllowedKind.LOCAL_PATH)
        read_spy.assert_not_called()

    @pytest.mark.parametrize("data_url", ["data:image/png;base64,AQIDBA==", "data:image/png;base64,%%%", "data:"])
    def test_refuses_a_data_url_without_decoding_it(self, data_url: str) -> None:
        client = _image_client()

        error = _refused(client, {"photo": data_url})

        assert error.value_kind is UploadNotAllowedKind.DATA_URL
        assert client.upload_calls == 0

    def test_refuses_bytes(self) -> None:
        client = _image_client()

        error = _refused(client, {"photo": b"\x01\x02"})

        assert error.value_kind is UploadNotAllowedKind.BYTES
        assert client.upload_calls == 0

    def test_names_where_the_value_sits_inside_a_structured_input_and_a_list(self) -> None:
        client = _FakeClient(
            ObjectField(
                name="dossier",
                fields=[
                    TextField(name="title", required=True),
                    ListField(name="attachments", item=DocumentItem(required=True), required=True),
                ],
                **_required(),
            )
        )

        error = _refused(client, {"dossier": {"title": "Q3", "attachments": ["https://example.com/a.pdf", "notes/b.pdf"]}})

        assert (error.input_name, error.input_path) == ("dossier", "dossier.attachments[1]")
        assert '"dossier.attachments[1]"' in str(error)

    def test_names_an_explicit_envelope_by_its_input_name_alone(self) -> None:
        error = _refused(_image_client(), {"photo": {"concept": "native.Image", "content": "shot.png"}})

        assert (error.input_name, error.input_path) == ("photo", "photo")

    def test_keeps_the_value_out_of_the_message_and_carries_the_input_verdict(self) -> None:
        error = _refused(_image_client(), {"photo": "/home/someone/secret-plans.png"})

        assert isinstance(error, InputPreparationError)
        assert "secret-plans" not in str(error)
        verdict = error_verdict_of(error)
        assert verdict is not None
        assert (verdict.error_domain, verdict.retryable) == (ErrorDomain.INPUT, False)

    def test_rewrites_urls_and_storage_references_uploading_nothing(self, read_spy: Any) -> None:
        client = _FakeClient(
            ImageField(name="photo", **_required()),
            ListField(name="exhibits", item=DocumentItem(required=True), **_required()),
            TextField(name="question", **_required()),
        )

        prepared = asyncio.run(
            prepare_inputs(
                client,
                files=_FILES,
                inputs={
                    "photo": {"concept": "native.Image", "content": "https://example.com/p.png"},
                    "exhibits": ["pipelex-storage://user/assets/a.pdf", {"url": "HTTP://example.com/b.pdf"}],
                    "question": "notes/summary.txt",
                },
                allow_uploads=False,
            )
        )

        assert prepared.inputs == {
            "photo": {"concept": "native.Image", "content": {"url": "https://example.com/p.png"}},
            "exhibits": [{"url": "pipelex-storage://user/assets/a.pdf"}, {"url": "HTTP://example.com/b.pdf"}],
            "question": "notes/summary.txt",
        }
        assert prepared.uploads == []
        assert client.upload_calls == 0
        read_spy.assert_not_called()

    def test_still_refuses_a_value_no_file_input_takes_as_an_invalid_input_value(self) -> None:
        with pytest.raises(InvalidInputValueError) as exc_info:
            asyncio.run(prepare_inputs(_image_client(), files=_FILES, inputs={"photo": 42}, allow_uploads=False))

        assert not isinstance(exc_info.value, UploadNotAllowedError)

    def test_uploads_as_before_when_allow_uploads_is_true(self, tmp_path: Path, read_spy: Any) -> None:
        path = tmp_path / "shot.png"
        path.write_bytes(b"\x01\x02\x03\x04")
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": str(path)}, allow_uploads=True))

        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/1.bin"}}
        read_spy.assert_called_once()

    @pytest.mark.parametrize("value", ["false", 0, None])
    def test_refuses_a_value_that_is_not_a_bool_before_any_request(self, value: object) -> None:
        client = _image_client()

        with pytest.raises(InputPreparationError, match="`allow_uploads` must be a bool"):
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": "shot.png"}, allow_uploads=value))  # type: ignore[arg-type]

        assert client.pipe_io_calls == []

    def test_allow_uploads_is_not_sent_to_the_server(self) -> None:
        client = _image_client()

        asyncio.run(prepare_inputs(client, method_id="mt_abc", inputs={"photo": "https://example.com/p.png"}, allow_uploads=False))

        assert client.pipe_io_calls == [PipeIORequest(method_id="mt_abc")]
