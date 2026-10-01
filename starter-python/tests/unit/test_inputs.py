from pathlib import Path

import pytest
import typer
from pipelex_sdk.upload import UploadRecord
from pytest_mock import MockerFixture

from widget.inputs import build_document_input, read_text_input, upload_document_input


class TestInputs:
    def test_read_text_input_from_argument(self):
        resolved = read_text_input(text="inline text", file=None, sample="the sample")
        assert resolved.text == "inline text"
        assert resolved.is_sample is False

    def test_read_text_input_from_file(self, tmp_path: Path):
        input_file = tmp_path / "input.txt"
        input_file.write_text("text from a file")
        resolved = read_text_input(text=None, file=input_file, sample="the sample")
        assert resolved.text == "text from a file"
        assert resolved.is_sample is False

    def test_read_text_input_rejects_both(self, tmp_path: Path):
        input_file = tmp_path / "input.txt"
        input_file.write_text("text from a file")
        with pytest.raises(typer.BadParameter):
            read_text_input(text="inline text", file=input_file, sample="the sample")

    def test_read_text_input_rejects_a_missing_file(self, tmp_path: Path):
        # Same clean CLI error as the `summarize-pdf` document path — a mistyped
        # --file must not surface as a raw FileNotFoundError traceback.
        with pytest.raises(typer.BadParameter):
            read_text_input(text=None, file=tmp_path / "nope.txt", sample="the sample")

    def test_read_text_input_falls_back_to_the_sample(self):
        resolved = read_text_input(text=None, file=None, sample="the sample")
        assert resolved.text == "the sample"
        assert resolved.is_sample is True

    def test_pdf_envelope(self, tmp_path: Path):
        # build_document_input is pure now: it wraps an already-uploaded storage URI.
        pdf = tmp_path / "invoice.pdf"
        envelope = build_document_input(pdf, "pipelex-storage://abc123")
        assert envelope["concept"] == "Document"
        content = envelope["content"]
        assert content["filename"] == "invoice.pdf"
        assert content["mime_type"] == "application/pdf"
        assert content["url"] == "pipelex-storage://abc123"

    def test_unknown_extension_falls_back_to_octet_stream(self, tmp_path: Path):
        blob = tmp_path / "data.unknownext"
        envelope = build_document_input(blob, "pipelex-storage://blob")
        assert envelope["content"]["mime_type"] == "application/octet-stream"

    async def test_upload_document_input_uploads_then_wraps_the_uri(self, mocker: MockerFixture, tmp_path: Path):
        # upload_document_input uploads the file, then builds the envelope around the returned URI.
        pdf = tmp_path / "doc.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake")
        record = UploadRecord(uri="pipelex-storage://uploaded", filename="doc.pdf", content_type="application/pdf", size=12)
        fake_client = mocker.AsyncMock()
        fake_client.upload_file.return_value = record
        async_cm = mocker.MagicMock()
        async_cm.__aenter__ = mocker.AsyncMock(return_value=fake_client)
        async_cm.__aexit__ = mocker.AsyncMock(return_value=None)
        mocker.patch("widget.inputs.PipelexAPIClient", return_value=async_cm)

        envelope = await upload_document_input(pdf)

        fake_client.upload_file.assert_awaited_once_with(pdf)
        assert envelope["concept"] == "Document"
        assert envelope["content"]["url"] == "pipelex-storage://uploaded"
        assert envelope["content"]["filename"] == "doc.pdf"
        assert envelope["content"]["mime_type"] == "application/pdf"
