"""`make codegen`, `make codegen-check` and `make codegen-verify`, over a fake client and a package of the test's own.

Every gesture runs as it does for real down to the client's three routes, which a fake answers from
recordings: `fixtures/codegen/summarize-pdf/` holds the starter template's summarize-pdf bundle and
the `/v1/codegen` answer its committed tree was written from (its `models.py` and `codegen.lock`,
verbatim), and the `/v1/pipe-io` answer is built from the contracts of `webapp-js`'s fixture for the
same method. The fake replaces `lib/client.py`'s `make_client`, the one seam every gesture reaches
the API through, and each test points the gestures at a `Layout` under its own temporary directory,
so no test writes into the package's tree.

Each policy `webapp-js`'s codegen holds has its test here: symlinks and special files refused,
UTF-8 fatal, the server's paths contained and clear of the files the script writes itself, the key
never sent over plaintext to another machine, the selector handshake, the self-check, the
revision confirmed by a second `/v1/codegen` after `/v1/pipe-io`, so that a method changed in
between writes nothing, and the failures each request can raise, caught by name.
"""

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import NoReturn

import httpx
import pytest
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.models import VersionInfo
from pipelex_sdk.codegen_check import run_codegen_check
from pipelex_sdk.codegen_writer import write_codegen_tree
from pipelex_sdk.crate_models import CodegenRequest, CodegenResponse, CodegenValidReport, CrateInvalidReport, PipeIORequest, PipeIOResponse
from pipelex_sdk.errors import ApiResponseError

from pipelex_method_cli_python.lib import client as client_module
from pipelex_method_cli_python.lib.contracts import CONTRACTS_FILENAME, GENERATED_FILES, INIT_FILENAME, LOCK_FILENAME, SOURCES_SIDECAR
from scripts import codegen_check
from scripts.codegen import run_codegen
from scripts.codegen_check import EXIT_CURRENT, EXIT_DRIFT, EXIT_NO_VERDICT, run_check, summarize_verdicts
from scripts.codegen_shared import PACKAGE_LAYOUT, Layout, insecure_base_url_reason, is_contained_path
from scripts.codegen_verify import run_verify
from tests.support import FIXTURES, pipe_io_report, wire_contracts

#: The recordings of the summarize-pdf method.
RECORDED = FIXTURES / "codegen" / "summarize-pdf"

#: The typed models' file the recorded answer writes.
MODELS = "models.py"


def recorded_codegen() -> CodegenValidReport:
    """The `/v1/codegen` answer the starter template's summarize-pdf tree was written from."""
    return CodegenValidReport.model_validate_json((RECORDED / "codegen-response.json").read_text(encoding="utf-8"))


def _not_found(route: str) -> ApiResponseError:
    return ApiResponseError(f"API {route} failed (404)", api_url="https://api.example.com", status=404, status_text="Not Found", response_body="")


def _refused_base_url() -> NoReturn:
    """`make_client` refusing the base URL, as the SDK's client does for one that is not host-only."""
    msg = 'Invalid API base URL "https://api.example.com/v1": must be host-only'
    raise PipelineRequestError(msg)


class FakeCodegenClient:
    """Stands in for `PipelexAPIClient` on the three routes the gestures call, recording the order they are called in."""

    def __init__(self) -> None:
        self.base_url = "https://api.example.com"
        self.codegen_answer: CodegenResponse | BaseException = recorded_codegen()
        #: Answers `codegen` gives first, one per call in order, before it falls back to `codegen_answer`.
        self.codegen_queue: list[CodegenResponse | BaseException] = []
        self.pipe_io_answer: PipeIOResponse | BaseException = pipe_io_report(wire_contracts("summarize-pdf"))
        #: An origin that advertises no capabilities at all, unless a test says otherwise.
        self.version_answer: VersionInfo | BaseException = VersionInfo.model_validate({"protocol_version": "1"})
        self.calls: list[str] = []
        self.requests: list[CodegenRequest | PipeIORequest] = []

    async def __aenter__(self) -> "FakeCodegenClient":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    async def version(self) -> VersionInfo:
        self.calls.append("version")
        if isinstance(self.version_answer, BaseException):
            raise self.version_answer
        return self.version_answer

    async def codegen(self, request: CodegenRequest) -> CodegenResponse:
        self.calls.append("codegen")
        self.requests.append(request)
        answer = self.codegen_queue.pop(0) if self.codegen_queue else self.codegen_answer
        if isinstance(answer, BaseException):
            raise answer
        return answer

    async def pipe_io(self, request: PipeIORequest) -> PipeIOResponse:
        self.calls.append("pipe_io")
        self.requests.append(request)
        if isinstance(self.pipe_io_answer, BaseException):
            raise self.pipe_io_answer
        return self.pipe_io_answer


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> FakeCodegenClient:
    """Replace `lib.client.make_client`, which the gestures call through its module, with the fake."""
    fake = FakeCodegenClient()
    monkeypatch.setattr(client_module, "make_client", lambda: fake)
    return fake


@pytest.fixture
def layout(tmp_path: Path) -> Layout:
    """A package of the test's own holding the summarize-pdf bundle and no tree yet."""
    package = Layout(tmp_path / "pkg")
    package.method_dir.mkdir(parents=True)
    shutil.copyfile(RECORDED / "main.mthds", package.method_dir / "main.mthds")
    return package


def generate(layout: Layout) -> int:
    return asyncio.run(run_codegen(layout))


def verify(layout: Layout) -> int:
    return asyncio.run(run_verify(layout))


def tree_bytes(layout: Layout) -> dict[str, bytes]:
    """Every file of the tree with its bytes, to say a failed gesture wrote nothing."""
    root = layout.generated_dir
    if not root.exists():
        return {}
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


class TestGenerate:
    def test_writes_the_tree_which_the_check_then_finds_current(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        assert generate(layout) == 0
        assert sorted(tree_bytes(layout)) == sorted({*GENERATED_FILES, MODELS})
        assert run_check(layout) == EXIT_CURRENT
        assert "1 current · 0 drift · 0 no verdict" in capsys.readouterr().out

    def test_the_contracts_come_after_the_models_and_the_models_are_confirmed_last(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        assert api.calls == ["codegen", "pipe_io", "codegen"]

    def test_the_bundle_is_sent_with_package_relative_labels_and_the_contracts_for_every_pipe(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        codegen_request, pipe_io_request, confirming_request = api.requests
        assert isinstance(codegen_request, CodegenRequest) and isinstance(pipe_io_request, PipeIORequest)
        assert [item.source for item in codegen_request.files or []] == ["method/main.mthds"]
        assert (codegen_request.kind, codegen_request.target, codegen_request.pipe_ref) == ("types", "python-pydantic", None)
        assert pipe_io_request.all_pipes
        assert confirming_request == codegen_request

    def test_contracts_json_holds_the_pipe_io_answer_and_reads_back(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        written = json.loads((layout.generated_dir / CONTRACTS_FILENAME).read_text(encoding="utf-8"))
        assert written["pipe_io_contracts"] == wire_contracts("summarize-pdf").model_dump(mode="json")["pipe_io_contracts"]
        assert (layout.generated_dir / INIT_FILENAME).read_text(encoding="utf-8").startswith('"""')

    def test_a_second_run_changes_nothing(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        before = tree_bytes(layout)
        capsys.readouterr()
        assert generate(layout) == 0
        assert tree_bytes(layout) == before
        assert "no changes" in capsys.readouterr().out

    def test_a_failure_of_the_contracts_call_leaves_the_tree_as_it_was(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        before = tree_bytes(layout)
        api.codegen_answer = recorded_codegen().model_copy(update={"engine_version": "0.51.0"})
        api.pipe_io_answer = _not_found("POST /v1/pipe-io")
        assert generate(layout) == 1
        assert tree_bytes(layout) == before

    def test_a_method_that_changed_between_the_answers_is_refused_leaving_the_tree_as_it_was(
        self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]
    ):
        generate(layout)
        before = tree_bytes(layout)
        capsys.readouterr()
        # The contracts of another revision, which would change contracts.json if they were written.
        api.pipe_io_answer = pipe_io_report(wire_contracts("text-stats"))
        api.codegen_queue = [recorded_codegen(), recorded_codegen().model_copy(update={"crate_fingerprint": "e" * 64})]
        api.calls.clear()
        assert generate(layout) == 1
        err = capsys.readouterr().err
        assert "the method changed while it was being generated" in err
        assert "Run `make codegen` again." in err
        assert api.calls == ["codegen", "pipe_io", "codegen"]
        assert tree_bytes(layout) == before

    def test_a_confirming_request_that_fails_writes_nothing(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        api.codegen_queue = [recorded_codegen(), httpx.ReadTimeout("timed out")]
        assert generate(layout) == 1
        assert "timed out" in capsys.readouterr().err
        assert tree_bytes(layout) == {}

    @pytest.mark.parametrize(
        "error",
        [
            pytest.param(httpx.ConnectError("connection refused"), id="a transport error the SDK leaves unmapped"),
            pytest.param(ValueError("the body is not JSON"), id="a body that is not the answer"),
            pytest.param(PipelineRequestError("the API is unreachable"), id="an SDK error"),
        ],
    )
    def test_a_codegen_request_that_raises_is_reported_writing_nothing(
        self, api: FakeCodegenClient, layout: Layout, error: Exception, capsys: pytest.CaptureFixture[str]
    ):
        api.codegen_answer = error
        assert generate(layout) == 1
        assert str(error) in capsys.readouterr().err
        assert tree_bytes(layout) == {}

    @pytest.mark.parametrize(
        "error",
        [
            pytest.param(httpx.ConnectError("connection refused"), id="a transport error the SDK leaves unmapped"),
            pytest.param(ValueError("the body is not JSON"), id="a body that is not the answer"),
        ],
    )
    def test_a_contracts_request_that_raises_is_reported_writing_nothing(
        self, api: FakeCodegenClient, layout: Layout, error: Exception, capsys: pytest.CaptureFixture[str]
    ):
        api.pipe_io_answer = error
        assert generate(layout) == 1
        assert str(error) in capsys.readouterr().err
        assert tree_bytes(layout) == {}

    def test_an_unforeseen_failure_of_a_request_is_never_swallowed(self, api: FakeCodegenClient, layout: Layout):
        # Only what a request can raise is caught; a bug surfaces with its traceback.
        api.codegen_answer = RuntimeError("a bug")
        with pytest.raises(RuntimeError, match="a bug"):
            generate(layout)

    def test_a_base_url_the_sdk_refuses_is_reported(self, layout: Layout, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]):
        monkeypatch.setattr(client_module, "make_client", _refused_base_url)
        assert generate(layout) == 1
        err = capsys.readouterr().err
        assert "must be host-only" in err
        assert "Check PIPELEX_BASE_URL" in err

    def test_a_method_that_is_not_runnable_is_refused_naming_its_signatures(
        self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]
    ):
        report = pipe_io_report(wire_contracts("summarize-pdf"))
        api.pipe_io_answer = report.model_copy(update={"is_runnable": False, "pending_signatures": ["summarize_pdf.later"]})
        assert generate(layout) == 1
        assert "summarize_pdf.later" in capsys.readouterr().err
        assert tree_bytes(layout) == {}

    def test_a_method_that_does_not_resolve_is_refused_with_its_errors(
        self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]
    ):
        api.codegen_answer = CrateInvalidReport.model_validate(
            {
                "is_valid": False,
                "message": "1 error",
                "validation_errors": [{"category": "pipe_validation", "message": "Unknown concept", "source": "method/main.mthds"}],
            }
        )
        assert generate(layout) == 1
        err = capsys.readouterr().err
        assert "the method does not resolve: 1 error" in err
        assert "method/main.mthds: Unknown concept" in err

    def test_a_package_with_no_method_says_to_create_one(self, api: FakeCodegenClient, tmp_path: Path, capsys: pytest.CaptureFixture[str]):
        assert generate(Layout(tmp_path / "empty")) == 1
        assert "holds no method. Run `make create` first." in capsys.readouterr().err
        assert api.calls == []

    def test_a_missing_key_is_refused_before_any_request(self, layout: Layout, capsys: pytest.CaptureFixture[str]):
        # No fake: the real `make_client` reads the environment, which the autouse fixture emptied.
        assert generate(layout) == 1
        assert "PIPELEX_API_KEY is not set" in capsys.readouterr().err

    def test_a_stamped_file_the_lock_does_not_track_is_removed_as_an_orphan(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        stray = layout.generated_dir / "stray.py"
        stray.write_bytes((layout.generated_dir / MODELS).read_bytes())
        assert generate(layout) == 0
        assert not stray.exists()
        assert run_check(layout) == EXIT_CURRENT


class TestPolicies:
    @pytest.mark.parametrize(
        ("base_url", "allowed"),
        [
            ("https://api.example.com", True),
            ("http://localhost:8081", True),
            ("http://127.0.0.1:8081", True),
            ("http://[::1]:8081", True),
            ("http://dev.localhost", True),
            ("http://api.example.com", False),
            ("ftp://api.example.com", False),
        ],
    )
    def test_the_key_never_travels_in_plaintext_beyond_this_machine(self, base_url: str, allowed: bool):
        assert (insecure_base_url_reason(base_url) is None) is allowed

    def test_a_plaintext_base_url_is_refused_before_any_request(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        api.base_url = "http://api.example.com"
        assert generate(layout) == 1
        assert "plaintext http:" in capsys.readouterr().err
        assert api.calls == []

    def test_a_lock_under_another_name_is_refused(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        api.codegen_answer = recorded_codegen().model_copy(update={"lock_filename": "other.lock"})
        assert generate(layout) == 1
        assert "lock_filename 'other.lock'" in capsys.readouterr().err
        assert tree_bytes(layout) == {}

    @pytest.mark.parametrize("path", ["../escape.py", "/etc/escape.py", "sub/../../escape.py"])
    def test_a_path_that_leaves_the_tree_is_refused(self, api: FakeCodegenClient, layout: Layout, path: str, capsys: pytest.CaptureFixture[str]):
        report = recorded_codegen()
        api.codegen_answer = report.model_copy(update={"artifacts": [*report.artifacts, report.artifacts[0].model_copy(update={"path": path})]})
        assert generate(layout) == 1
        assert "escape" in capsys.readouterr().err
        assert tree_bytes(layout) == {}
        assert not (layout.package_dir / "escape.py").exists()

    def test_containment_is_judged_on_the_resolved_path(self, tmp_path: Path):
        assert is_contained_path(tmp_path, "a/b.py")
        assert not is_contained_path(tmp_path, "a/../../b.py")
        assert not is_contained_path(tmp_path, ".")

    @pytest.mark.parametrize("path", [CONTRACTS_FILENAME, SOURCES_SIDECAR, INIT_FILENAME, f"./{CONTRACTS_FILENAME}"])
    def test_a_path_that_lands_on_a_file_the_script_writes_is_refused(
        self, api: FakeCodegenClient, layout: Layout, path: str, capsys: pytest.CaptureFixture[str]
    ):
        report = recorded_codegen()
        api.codegen_answer = report.model_copy(update={"artifacts": [*report.artifacts, report.artifacts[0].model_copy(update={"path": path})]})
        assert generate(layout) == 1
        assert "land on a file this script writes itself" in capsys.readouterr().err
        assert tree_bytes(layout) == {}

    def test_an_answer_that_fails_its_own_check_is_refused_as_an_upstream_bug(
        self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]
    ):
        report = recorded_codegen()
        tampered = report.artifacts[0].model_copy(update={"content": report.artifacts[0].content + "\n# drifted\n"})
        api.codegen_answer = report.model_copy(update={"artifacts": [tampered]})
        assert generate(layout) == 1
        err = capsys.readouterr().err
        assert "fail the offline check" in err or "cannot be written as it is" in err
        assert "upstream" in err
        assert tree_bytes(layout) == {}
        # Refused before the contracts were asked for.
        assert api.calls == ["codegen"]

    @pytest.mark.skipif(os.name != "posix", reason="symbolic links need POSIX")
    def test_a_link_in_the_method_is_refused(self, api: FakeCodegenClient, layout: Layout, tmp_path: Path, capsys: pytest.CaptureFixture[str]):
        outside = tmp_path / "outside.mthds"
        outside.write_text("domain = 'x'\n", encoding="utf-8")
        (layout.method_dir / "linked.mthds").symlink_to(outside)
        assert generate(layout) == 1
        assert "refusing a symlink" in capsys.readouterr().err
        assert api.calls == []

    @pytest.mark.skipif(os.name != "posix", reason="symbolic links need POSIX")
    def test_a_generated_directory_that_is_a_link_is_refused(self, api: FakeCodegenClient, layout: Layout, tmp_path: Path):
        (tmp_path / "elsewhere").mkdir()
        layout.generated_dir.symlink_to(tmp_path / "elsewhere")
        assert generate(layout) == 1
        assert list((tmp_path / "elsewhere").iterdir()) == []
        assert api.calls == []

    def test_a_source_that_is_not_utf8_is_refused(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        (layout.method_dir / "broken.mthds").write_bytes(b"domain = '\xff'\n")
        assert generate(layout) == 1
        assert "is not valid UTF-8" in capsys.readouterr().err
        assert api.calls == []


class TestHandshake:
    @pytest.fixture
    def named(self, tmp_path: Path) -> Layout:
        package = Layout(tmp_path / "named")
        package.method_dir.mkdir(parents=True)
        (package.method_dir / "method.json").write_text(
            json.dumps({"method_ref": "github.com/Pipelex/methods/summarize_pdf@v1.0.0"}), encoding="utf-8"
        )
        return package

    def test_a_base_url_without_the_selector_is_refused_before_any_crate_route(
        self, api: FakeCodegenClient, named: Layout, capsys: pytest.CaptureFixture[str]
    ):
        api.version_answer = VersionInfo.model_validate({"protocol_version": "1", "extensions": ["method_id"]})
        assert generate(named) == 1
        err = capsys.readouterr().err
        assert "does not serve method selectors (method_ref)" in err
        assert "It advertises: method_id" in err
        assert api.calls == ["version"]

    def test_a_base_url_serving_the_selector_proceeds_and_sends_no_bundle(self, api: FakeCodegenClient, named: Layout):
        api.version_answer = VersionInfo.model_validate({"protocol_version": "1", "extensions": ["method_ref", "method_id"]})
        assert generate(named) == 0
        assert api.calls == ["version", "codegen", "pipe_io", "codegen"]
        codegen_request, pipe_io_request, _ = api.requests
        assert codegen_request.method_ref == "github.com/Pipelex/methods/summarize_pdf@v1.0.0"
        assert codegen_request.files is None
        assert isinstance(pipe_io_request, PipeIORequest) and pipe_io_request.method_ref == codegen_request.method_ref
        assert pipe_io_request.files is None and pipe_io_request.all_pipes

    @pytest.mark.parametrize(
        "error",
        [
            pytest.param(_not_found("GET /v1/version"), id="a refusal"),
            pytest.param(httpx.ConnectError("connection refused"), id="a transport error the SDK leaves unmapped"),
            pytest.param(ValueError("the body is not JSON"), id="a body that is not a version"),
        ],
    )
    def test_a_version_route_that_fails_is_advice_and_the_crate_route_answers(self, api: FakeCodegenClient, named: Layout, error: Exception):
        api.version_answer = error
        assert generate(named) == 0

    def test_an_origin_that_advertises_no_extensions_list_proceeds(self, api: FakeCodegenClient, named: Layout):
        assert generate(named) == 0
        assert api.calls == ["version", "codegen", "pipe_io", "codegen"]

    def test_an_empty_extensions_list_is_a_refusal(self, api: FakeCodegenClient, named: Layout, capsys: pytest.CaptureFixture[str]):
        api.version_answer = VersionInfo.model_validate({"protocol_version": "1", "extensions": []})
        assert generate(named) == 1
        assert "It advertises: (nothing)" in capsys.readouterr().err

    def test_a_bundle_needs_no_handshake(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        assert "version" not in api.calls

    def test_a_404_on_a_named_method_says_the_api_could_not_resolve_it(
        self, api: FakeCodegenClient, named: Layout, capsys: pytest.CaptureFixture[str]
    ):
        api.codegen_answer = ApiResponseError(
            "API POST /v1/codegen failed (404)",
            api_url="https://api.example.com",
            status=404,
            status_text="Not Found",
            response_body="",
            server_message="No package at github.com/Pipelex/methods.",
        )
        assert generate(named) == 1
        assert "could not resolve method_ref github.com/Pipelex/methods/summarize_pdf@v1.0.0" in capsys.readouterr().err


class TestCheck:
    def test_the_template_as_shipped_is_current(self, capsys: pytest.CaptureFixture[str]):
        # No method and no tree: nothing to be out of step with, so `make check` is green on a fresh clone.
        assert not PACKAGE_LAYOUT.generated_dir.exists() or not any(PACKAGE_LAYOUT.method_dir.glob("*.mthds"))
        assert codegen_check.main() == EXIT_CURRENT
        assert "nothing to check" in capsys.readouterr().out

    def test_a_method_without_a_tree_is_drift(self, layout: Layout, capsys: pytest.CaptureFixture[str]):
        assert run_check(layout) == EXIT_DRIFT
        assert "no generated tree" in capsys.readouterr().err

    def test_a_tree_without_a_method_is_drift(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        shutil.rmtree(layout.method_dir)
        assert run_check(layout) == EXIT_DRIFT
        assert "with no method" in capsys.readouterr().err

    def test_a_tree_without_its_lock_has_no_verdict(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        (layout.generated_dir / LOCK_FILENAME).unlink()
        assert run_check(layout) == EXIT_NO_VERDICT
        assert "0 current · 0 drift · 1 no verdict" in capsys.readouterr().out

    def test_a_lock_that_cannot_be_read_has_no_verdict(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        (layout.generated_dir / LOCK_FILENAME).write_text("not = [toml", encoding="utf-8")
        assert run_check(layout) == EXIT_NO_VERDICT

    def test_an_edited_source_is_stale(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        with (layout.method_dir / "main.mthds").open("a", encoding="utf-8") as bundle:
            bundle.write("\n# an edit\n")
        assert run_check(layout) == EXIT_DRIFT
        assert "stale-source: method/main.mthds — edited since the tree was generated" in capsys.readouterr().err

    def test_a_new_source_is_stale(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        (layout.method_dir / "more.mthds").write_text("domain = 'more'\n", encoding="utf-8")
        assert run_check(layout) == EXIT_DRIFT
        assert "stale-source: method/more.mthds — a new source" in capsys.readouterr().err

    def test_line_endings_alone_are_no_edit(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        bundle = layout.method_dir / "main.mthds"
        bundle.write_bytes(bundle.read_bytes().replace(b"\n", b"\r\n"))
        assert run_check(layout) == EXIT_CURRENT

    def test_a_hand_edited_contracts_file_is_drift(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        contracts = layout.generated_dir / CONTRACTS_FILENAME
        contracts.write_text(contracts.read_text(encoding="utf-8").replace("Document", "Doc"), encoding="utf-8")
        assert run_check(layout) == EXIT_DRIFT
        assert f"derived: {CONTRACTS_FILENAME} — hand-edited since it was generated" in capsys.readouterr().err

    def test_a_contracts_file_that_is_not_utf8_is_drift(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        (layout.generated_dir / CONTRACTS_FILENAME).write_bytes(b"\xff\xfe")
        assert run_check(layout) == EXIT_DRIFT

    def test_hand_edited_models_are_drift(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        with (layout.generated_dir / MODELS).open("a", encoding="utf-8") as models:
            models.write("\n# hand edit\n")
        assert run_check(layout) == EXIT_DRIFT
        assert MODELS in capsys.readouterr().err

    def test_a_missing_sidecar_is_stale(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        (layout.generated_dir / SOURCES_SIDECAR).unlink()
        assert run_check(layout) == EXIT_DRIFT

    def test_bytecode_and_dotfiles_in_the_tree_are_not_part_of_it(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        (layout.generated_dir / "__pycache__").mkdir()
        (layout.generated_dir / "__pycache__" / "models.cpython-313.pyc").write_bytes(b"\x00")
        (layout.generated_dir / ".DS_Store").write_bytes(b"\x00")
        assert run_check(layout) == EXIT_CURRENT

    @pytest.mark.skipif(os.name != "posix", reason="symbolic links need POSIX")
    def test_a_link_in_the_tree_has_no_verdict(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        (layout.generated_dir / "linked.py").symlink_to(layout.generated_dir / MODELS)
        assert run_check(layout) == EXIT_NO_VERDICT

    @pytest.mark.parametrize(
        ("codes", "expected"),
        [([], EXIT_CURRENT), ([0, 0], EXIT_CURRENT), ([0, 1], EXIT_DRIFT), ([1, 2, 0], EXIT_NO_VERDICT), ([5], EXIT_NO_VERDICT)],
    )
    def test_verdicts_fold_by_precedence(self, codes: list[int], expected: int):
        assert summarize_verdicts(codes).exit == expected

    def test_an_unforeseen_failure_is_no_verdict_never_a_pass(self, monkeypatch: pytest.MonkeyPatch):
        def broken() -> int:
            msg = "boom"
            raise RuntimeError(msg)

        monkeypatch.setattr(codegen_check, "run_check", broken)
        assert codegen_check.main() == EXIT_NO_VERDICT


class TestVerify:
    def test_a_tree_that_matches_both_answers_passes(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        capsys.readouterr()
        assert verify(layout) == 0
        assert "matches the engine" in capsys.readouterr().out

    def test_a_crate_that_moved_fails(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        api.codegen_answer = recorded_codegen().model_copy(update={"crate_fingerprint": "f" * 64})
        assert verify(layout) == 1
        assert "the committed crate is not what the method resolves to" in capsys.readouterr().err

    def test_contracts_that_moved_fail(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        api.pipe_io_answer = pipe_io_report(wire_contracts("text-stats"))
        assert verify(layout) == 1
        assert f"the committed {CONTRACTS_FILENAME} is not what /v1/pipe-io returns" in capsys.readouterr().err

    def test_an_engine_that_moved_alone_is_a_note(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        api.codegen_answer = recorded_codegen().model_copy(update={"engine_version": "9.9.9"})
        assert verify(layout) == 0
        assert "note: the engine moved" in capsys.readouterr().out

    def test_verify_writes_nothing(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        before = tree_bytes(layout)
        api.pipe_io_answer = pipe_io_report(wire_contracts("text-stats"))
        verify(layout)
        assert tree_bytes(layout) == before

    def test_a_tree_without_a_lock_says_to_generate_first(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        assert verify(layout) == 1
        assert "Run `make codegen` first" in capsys.readouterr().err
        assert api.calls == []

    def test_a_plaintext_base_url_is_refused(self, api: FakeCodegenClient, layout: Layout):
        generate(layout)
        api.base_url = "http://api.example.com"
        api.calls.clear()
        assert verify(layout) == 1
        assert api.calls == []

    def test_a_codegen_request_that_raises_is_reported(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        api.codegen_answer = httpx.ConnectError("connection refused")
        assert verify(layout) == 1
        assert "connection refused" in capsys.readouterr().err

    def test_a_contracts_request_that_raises_is_reported(self, api: FakeCodegenClient, layout: Layout, capsys: pytest.CaptureFixture[str]):
        generate(layout)
        api.pipe_io_answer = ValueError("the body is not JSON")
        assert verify(layout) == 1
        assert "the body is not JSON" in capsys.readouterr().err

    def test_a_base_url_the_sdk_refuses_is_reported(
        self, api: FakeCodegenClient, layout: Layout, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ):
        generate(layout)
        monkeypatch.setattr(client_module, "make_client", _refused_base_url)
        assert verify(layout) == 1
        err = capsys.readouterr().err
        assert "must be host-only" in err
        assert "Check PIPELEX_BASE_URL" in err


def test_the_recorded_answer_is_signed_by_its_own_lock(tmp_path: Path) -> None:
    """The recording is not hand-made: written as it is, the offline check finds it current, as the starter's committed tree is."""
    report = recorded_codegen()
    assert [artifact.path for artifact in report.artifacts] == [MODELS]
    write_codegen_tree(report, output_dir=tmp_path)
    assert run_codegen_check(root=tmp_path).is_current
