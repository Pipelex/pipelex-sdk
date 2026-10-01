import pytest

from widget.detached.cli import METHODS_DIR, attend_run, start_pipe
from widget.generated.generate_image.models import Image

BUNDLE_PATH = METHODS_DIR / "generate-image" / "main.mthds"

SAMPLE_PROMPT = "A watercolor painting of a fox reading a book under a tree."


@pytest.mark.inference
@pytest.mark.img_gen
@pytest.mark.pipelex_api
class TestGenerateImage:
    async def test_detached(self):
        # The detached lifecycle end to end, and with it the whole run-id story:
        # start, get an id back, then pick the run up again through that id alone.
        # Image generation outlives the ~30s blocking cap, so it is the demo detached mode owns.
        bundle = BUNDLE_PATH.read_text()
        run_id = await start_pipe(pipe_code="generate_image.generate_image", mthds_contents=[bundle], inputs={"image_prompt": SAMPLE_PROMPT})
        assert run_id
        results = await attend_run(run_id)
        image = Image.model_validate(results.main_stuff)
        assert image.url
