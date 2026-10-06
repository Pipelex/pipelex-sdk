"""What the tests of `make create` share: a client answering from recorded API responses, and copies of the template.

The responses under `fixtures/recorded/` are real and complete, stamps included, so nothing in the
SDK is mocked: the codegen kit's self-check and the offline check that follows run as they do for
real. They were recorded from the hosted API on 2026-10-06, for the bundle in
`fixtures/bundles/receipt-review/` (a list of documents in, a list of records out) and for the
published method `github.com/Pipelex/methods/text_stats@v0.1.1` (a text in, a text out), with the
requests the gesture sends. A catalog id is answered with the published method's responses and a
catalog entry made up for the tests, since a stored method belongs to one organization.
"""

import os
import shutil
from pathlib import Path
from typing import Any

from mthds.protocol.models import VersionInfo
from pipelex_sdk.crate_models import CodegenRequest, CodegenResponse, CodegenValidReport, PipeIORequest, PipeIOResponse, PipeIOValidReport
from pipelex_sdk.product_models import MethodData

from tests.support import FIXTURES

#: The template's root, which every copy is taken from.
TEMPLATE_ROOT = Path(__file__).resolve().parent.parent

#: The recorded API responses, and the bundle they answer for.
RECORDED = FIXTURES / "recorded"
RECEIPT_REVIEW_BUNDLE = FIXTURES / "bundles" / "receipt-review"

#: The published method the address and catalog-id responses describe.
TEXT_STATS_REF = "github.com/Pipelex/methods/text_stats@v0.1.1"

#: A catalog id no organization holds, for the stored method the tests make up.
STORED_METHOD_ID = "mt_00000000-0000-0000-0000-000000000000"

#: What a copy leaves behind: the environment, caches, build output, and local files.
NOT_COPIED = frozenset({".venv", ".git", "__pycache__", ".pytest_cache", ".ruff_cache", "dist", "build", "outputs", ".env", "wip"})


def _recorded(name: str) -> str:
    return (RECORDED / name).read_text(encoding="utf-8")


class RecordedClient:
    """Stands in for `PipelexAPIClient` on the routes the gesture calls, answering from the recordings.

    A request carrying files is the bundle's; one naming a method is the published method's,
    whichever selector names it.
    """

    def __init__(self) -> None:
        self.base_url = "https://api.example.com"
        self.calls: list[str] = []
        self.requests: list[CodegenRequest | PipeIORequest] = []

    async def __aenter__(self) -> "RecordedClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    async def version(self) -> VersionInfo:
        self.calls.append("version")
        return VersionInfo.model_validate_json(_recorded("version.json"))

    async def codegen(self, request: CodegenRequest) -> CodegenResponse:
        self.calls.append("codegen")
        self.requests.append(request)
        name = "receipt-review" if request.files is not None else "text-stats"
        return CodegenValidReport.model_validate_json(_recorded(f"{name}.codegen.json"))

    async def pipe_io(self, request: PipeIORequest) -> PipeIOResponse:
        self.calls.append("pipe_io")
        self.requests.append(request)
        name = "receipt-review" if request.files is not None else "text-stats"
        return PipeIOValidReport.model_validate_json(_recorded(f"{name}.pipe-io.json"))

    async def get_method(self, method_id: str) -> MethodData:
        self.calls.append("get_method")
        return MethodData.model_validate(stored_method(method_id))


def stored_method(method_id: str, *, name: str = "Stored text stats", description: str | None = None) -> dict[str, Any]:
    """A catalog entry as `GET /v1/methods/{id}` answers one, made up: no real organization's method is recorded."""
    return {
        "method_id": method_id,
        "name": name,
        "description": description,
        "mthds": "",
        "org_id": "org_00000000",
        "created_by_user_id": "user_00000000",
        "created_at": "2026-10-06T00:00:00Z",
        "updated_at": "2026-10-06T00:00:00Z",
    }


def copy_template(destination: Path) -> Path:
    """A copy of the template as a person starts from it, in `destination`, with the template's environment linked in.

    The environment is a link, not a copy: the tools in it run in the copy as they do here, and
    nothing in a copy installs anything.
    """

    def ignored(directory: str, names: list[str]) -> set[str]:
        at_root = Path(directory).resolve() == TEMPLATE_ROOT
        return {name for name in names if name in NOT_COPIED or (at_root and name.startswith(".env") and name != ".env.example")}

    shutil.copytree(TEMPLATE_ROOT, destination, ignore=ignored, symlinks=True)
    os.symlink(TEMPLATE_ROOT / ".venv", destination / ".venv", target_is_directory=True)
    return destination
