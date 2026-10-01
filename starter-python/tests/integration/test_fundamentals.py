from pathlib import Path

import pytest
from pipelex_sdk.client import PipelexAPIClient

import widget

# The bundles ship with the package. Each mode CLI resolves them the same way
# (`METHODS_DIR` in `widget/<mode>/cli.py`), so this check stays mode-agnostic.
METHODS_DIR = Path(widget.__file__).parent / "methods"

BUNDLE_PATHS = [
    METHODS_DIR / "extract-entities" / "main.mthds",
    METHODS_DIR / "summarize-pdf" / "main.mthds",
    METHODS_DIR / "generate-image" / "main.mthds",
]


class TestFundamentals:
    def test_boot(self):
        # Constructing the client resolves credentials + base URL (no network).
        # This fails if PIPELEX_BASE_URL is malformed.
        client = PipelexAPIClient()
        assert client.base_url

    @pytest.mark.parametrize("bundle_path", BUNDLE_PATHS)
    def test_bundle_exists(self, bundle_path: Path):
        assert bundle_path.exists()
        assert bundle_path.read_text().strip()

    @pytest.mark.pipelex_api
    @pytest.mark.parametrize("bundle_path", BUNDLE_PATHS)
    async def test_validate_bundle(self, bundle_path: Path):
        # Parse, validate, and dry-run the bundle through the hosted API.
        # The verdict rides a 200 body (never raised); assert it is valid.
        bundle = bundle_path.read_text()
        async with PipelexAPIClient() as client:
            report = await client.validate([bundle])
        assert report.is_valid, report.rendered_markdown
