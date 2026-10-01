import asyncio

import httpx
import pytest
from dotenv import load_dotenv
from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult, DownloadedArtifact
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError
from pipelex_sdk.upload import UploadRecord
from pytest_mock import MockerFixture

# Load .env so the Pipelex API client picks up PIPELEX_BASE_URL / PIPELEX_API_KEY
# (the tests marked `pipelex_api` / `inference` reach the hosted API).
load_dotenv()

# The storage URI the offline `stub_upload` fixture pretends the hosted upload returned.
STUB_UPLOAD_URI = "pipelex-storage://stub-upload"


@pytest.fixture
def stub_upload(mocker: MockerFixture) -> str:
    """Patch the hosted file upload so `summarize-pdf` CLI tests stay offline.

    `inputs.upload_document_input` opens a `PipelexAPIClient` and calls `upload_file`; here we
    replace the client with a fake whose `upload_file` returns a fixed `pipelex-storage://` URI.
    The real `build_document_input` still runs, so the envelope keeps the real filename / MIME
    from the path — only the network upload is stubbed. Returns the stub URI for assertions.
    """
    record = UploadRecord(uri=STUB_UPLOAD_URI, filename="stub", content_type="application/octet-stream", size=0)
    fake_client = mocker.AsyncMock()
    fake_client.upload_file.return_value = record
    async_cm = mocker.MagicMock()
    async_cm.__aenter__ = mocker.AsyncMock(return_value=fake_client)
    async_cm.__aexit__ = mocker.AsyncMock(return_value=None)
    mocker.patch("widget.inputs.PipelexAPIClient", return_value=async_cm)
    return STUB_UPLOAD_URI


# What the offline `stub_download` fixture pretends the hosted artifact stack brought down.
STUB_ARTIFACT_URI = "pipelex-storage://stub-run/cat.png"
STUB_ARTIFACT_PATH = "/tmp/stub-run/cat.png"


@pytest.fixture
def stub_download(mocker: MockerFixture) -> str:
    """Patch the hosted artifact download so CLI tests over a file-producing method stay offline.

    `artifacts.download_produced_files` short-circuits offline when the output references no stored
    file, which is why the text demos need nothing here. Past that short-circuit it opens a real
    `PipelexAPIClient`, so any test whose fixture output carries a `pipelex-storage://` reference —
    which is the shape the hosted runtime really returns for an image — must take this fixture or
    it will reach for the network. Returns the path the stub pretends it wrote, for assertions.
    """
    artifact = DownloadedArtifact(uri=STUB_ARTIFACT_URI, found_at=["$.url"], path=STUB_ARTIFACT_PATH, content_type="image/png", size=3)
    result = DownloadArtifactsResult(scope=ArtifactScope.MAIN_STUFF, artifacts=[artifact], saved_paths=[STUB_ARTIFACT_PATH], all_saved=True)
    fake_client = mocker.AsyncMock()
    fake_client.download_artifacts.return_value = result
    async_cm = mocker.MagicMock()
    async_cm.__aenter__ = mocker.AsyncMock(return_value=fake_client)
    async_cm.__aexit__ = mocker.AsyncMock(return_value=None)
    mocker.patch("widget.artifacts.PipelexAPIClient", return_value=async_cm)
    return STUB_ARTIFACT_PATH


#: The hosted plane's answer to a `POST /v1/start` whose bundle names a model the deck does not know,
#: as `api-dev.pipelex.com` gave it on 2026-09-27 (the execution-errors acceptance reading, case 1):
#: the runner's refusal, relayed with its reason, the item naming the failing pipe and the next step.
_REFUSED_START_MESSAGE = (
    "Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck\n\n"
    "Did you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna"
)
_REFUSED_START_NEXT_STEP = "Edit the bundle as each validation error says: apply its suggested fix where it has one, after confirming an unsafe one"
_REFUSED_START_BODY: dict[str, object] = {
    "type": "https://docs.pipelex.com/latest/errors/validate-bundle-error/",
    "title": "Validate bundle",
    "detail": _REFUSED_START_MESSAGE,
    "error_category": "configuration",
    "error_domain": "input",
    "retryable": False,
    "error_type": "ValidateBundleError",
    "validation_errors": [
        {
            "category": "pipe_validation",
            "message": _REFUSED_START_MESSAGE,
            "error_type": "unknown_model",
            "pipe_code": "draft_pitch",
            "domain_code": "sales_copy",
            "field_path": "pipe.draft_pitch.model",
            "field_name": "model",
            "model_reference": "gpt-5.1",
            "model_type": "llm",
            "suggestions": ["gpt-5.5", "gpt-5.4", "gpt-5.6-sol", "gpt-5.4-pro", "gpt-5.6-luna"],
        }
    ],
    "user_action": {"kind": "change_input", "detail": _REFUSED_START_NEXT_STEP},
    "status": 422,
    "instance": "urn:pipelex:request:req_97e7f218-e071-4682-b9fe-30c1193cff9d",
    "request_id": "req_97e7f218-e071-4682-b9fe-30c1193cff9d",
}


@pytest.fixture
def refused_start() -> ApiResponseError:
    """The refusal above as `pipelex-sdk` raises it: a real client's `start` answered by a faked transport.

    Built through the client rather than by hand, so the tests that take it hold the SDK in the lock to
    its promise that every route — `start`, a protocol route, among them — raises the typed
    `ApiResponseError` with the problem document parsed onto it.
    """

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json=_REFUSED_START_BODY, headers={"content-type": "application/problem+json"}, request=request)

    async def start() -> None:
        async with PipelexAPIClient(api_key="test-key", base_url="https://api.example.com") as client:
            if client.client is not None:
                await client.client.aclose()
            client.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
            await client.start(pipe_code="sales_copy.pitch_product", mthds_contents=["domain = 'sales_copy'"])

    with pytest.raises(ApiResponseError) as caught:
        asyncio.run(start())
    return caught.value
