from pathlib import Path

import pytest

from widget.attended.cli import METHODS_DIR, start_and_wait
from widget.generated.summarize_pdf.models import DocumentSummary
from widget.inputs import upload_document_input

BUNDLE_PATH = METHODS_DIR / "summarize-pdf" / "main.mthds"

SAMPLE_PDF = Path(__file__).parents[2] / "samples" / "sample-invoice.pdf"


@pytest.mark.inference
@pytest.mark.llm
@pytest.mark.pipelex_api
class TestSummarizePdf:
    async def test_attended(self):
        # The attended lifecycle end to end: upload the PDF, start a durable run, poll it, narrow.
        bundle = BUNDLE_PATH.read_text()
        inputs = {"document": await upload_document_input(SAMPLE_PDF)}
        results = await start_and_wait(pipe_code="summarize_pdf.summarize_pdf", mthds_contents=[bundle], inputs=inputs)
        summary = DocumentSummary.model_validate(results.main_stuff)
        assert summary.title
        assert summary.doc_type
        assert summary.key_points
