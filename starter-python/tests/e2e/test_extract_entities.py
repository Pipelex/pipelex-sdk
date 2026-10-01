import pytest

from widget.blocking.cli import METHODS_DIR, execute_pipe
from widget.generated.extract_entities.models import ExtractedEntities

BUNDLE_PATH = METHODS_DIR / "extract-entities" / "main.mthds"

SAMPLE_TEXT = (
    "Marie Curie joined the University of Paris in 1906, two years after Pierre Curie won recognition from the Royal Swedish Academy of Sciences."
)


@pytest.mark.inference
@pytest.mark.llm
@pytest.mark.pipelex_api
class TestExtractEntities:
    async def test_blocking(self):
        # The blocking lifecycle end to end: one `execute` call, then narrow.
        # Extraction finishes well under the hosted ~30s cap, so the blocking mode owns this demo.
        bundle = BUNDLE_PATH.read_text()
        results = await execute_pipe(pipe_code="extract_entities.extract_entities", mthds_contents=[bundle], inputs={"text": SAMPLE_TEXT})
        entities = ExtractedEntities.model_validate(results.main_stuff)
        assert any("Curie" in person for person in entities.people)
