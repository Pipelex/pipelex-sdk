"""Offline gates for the two source kinds a method directory can hold (`scripts/codegen.py`).

A method is either a bundle on disk (`.mthds` files) or a manifest naming one that lives
elsewhere (`method.json`, written by `make add-method`). Both project into a generated tree
through the same `POST /v1/codegen` call, which is the whole reason the manifest sits under
`widget/methods/` rather than beside the generated tree: `widget/methods/` stays the source of
truth and `widget/generated/` stays purely derived.

Everything here is filesystem and request-shape work — no key, no network. The failure translation
the two scripts share (`explain`) is here too, because a failure reported without its route, its
reason or its fix is the shape both of them exist to avoid.
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from mthds.protocol.problem.models import Problem
from pipelex_sdk.errors import ApiResponseError

from widget.manifest import ManifestError, MethodSelector, read_manifest, write_manifest

ROOT = Path(__file__).resolve().parents[2]


def load_codegen() -> Any:
    """Import the generator the way `python -m scripts.codegen` does."""
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    return importlib.import_module("scripts.codegen")


codegen = load_codegen()

ADDRESS = "github.com/Pipelex/methods/text_stats@v0.2.0"


class TestMethodSources:
    def test_a_manifest_round_trips_an_address(self, tmp_path: Path):
        path = tmp_path / "method.json"
        write_manifest(path, MethodSelector(method_ref=ADDRESS))
        assert read_manifest(path) == MethodSelector(method_ref=ADDRESS)
        assert "method_id" not in path.read_text()

    def test_a_manifest_round_trips_a_catalog_id(self, tmp_path: Path):
        path = tmp_path / "method.json"
        write_manifest(path, MethodSelector(method_id="mt_abc123"))
        assert read_manifest(path) == MethodSelector(method_id="mt_abc123")

    @pytest.mark.parametrize(
        "content",
        [
            "{}",
            '{"method_id": "mt_abc", "method_ref": "github.com/a/b"}',
            '{"method_ref": ""}',
            '{"method_ref": 3}',
            '{"whatever": "x"}',
            "[]",
            "not json",
        ],
    )
    def test_a_manifest_that_does_not_name_exactly_one_method_is_refused(self, tmp_path: Path, content: str):
        path = tmp_path / "method.json"
        path.write_text(content)
        with pytest.raises(ManifestError):
            read_manifest(path)

    def test_a_bundle_directory_sends_every_mthds_file_under_it(self, tmp_path: Path):
        method_dir = tmp_path / "text-stats"
        (method_dir / "nested").mkdir(parents=True)
        (method_dir / "main.mthds").write_text("main_pipe = 'x'\n")
        (method_dir / "nested" / "extra.mthds").write_text("# extra\n")
        source = codegen.read_method_source(method_dir)
        assert source is not None
        assert source.files == {"main.mthds": "main_pipe = 'x'\n", "nested/extra.mthds": "# extra\n"}
        # The tree is sent as `contents`, which the SDK sends inline when small and by hash otherwise.
        request = source.codegen_request()
        assert request.files is None and request.contents == source.files
        assert source.method_id is None and source.method_ref is None
        assert source.origin == "bundle"

    def test_a_manifest_directory_sends_the_selector_instead(self, tmp_path: Path):
        method_dir = tmp_path / "text-stats"
        method_dir.mkdir()
        write_manifest(method_dir / "method.json", MethodSelector(method_ref=ADDRESS))
        source = codegen.read_method_source(method_dir)
        assert source is not None
        assert source.files is None
        assert source.method_ref == ADDRESS
        assert source.origin == ADDRESS

    def test_a_directory_holding_neither_is_not_a_method(self, tmp_path: Path):
        method_dir = tmp_path / "notes"
        method_dir.mkdir()
        (method_dir / "README.md").write_text("# notes\n")
        assert codegen.read_method_source(method_dir) is None

    def test_a_directory_holding_both_kinds_is_refused(self, tmp_path: Path):
        """The two would disagree about where the generated tree came from."""
        method_dir = tmp_path / "text-stats"
        method_dir.mkdir()
        (method_dir / "main.mthds").write_text("main_pipe = 'x'\n")
        write_manifest(method_dir / "method.json", MethodSelector(method_ref=ADDRESS))
        with pytest.raises(ManifestError, match="one source"):
            codegen.read_method_source(method_dir)

    @pytest.mark.parametrize(
        ("selector", "expected"),
        [
            (MethodSelector(method_ref=ADDRESS), "method_ref"),
            (MethodSelector(method_id="mt_abc123"), "method_id"),
        ],
    )
    def test_the_codegen_request_carries_exactly_one_selector(self, selector: Any, expected: str):
        """The SDK's own three-way XOR refuses a second one at construction, so this is the proof."""
        source = codegen.MethodSource(
            name="text-stats",
            out_dir=Path("widget/generated/text_stats"),
            method_id=selector.method_id,
            method_ref=selector.method_ref,
        )
        request = source.codegen_request()
        assert getattr(request, expected) is not None
        assert request.files is None and request.contents is None
        assert request.target == codegen.TARGET

    def test_dashes_become_underscores(self):
        assert codegen.generated_package_dir("summarize-pdf").name == "summarize_pdf"

    def test_a_bare_403_names_both_the_key_and_the_route(self):
        """A gateway answers a path it does not route with a bare 403, as it answers a key it refuses."""
        exc = ApiResponseError(
            "nope",
            api_url="https://api.example.com",
            status=403,
            status_text="Forbidden",
            response_body="",
            headers={"x-request-id": "req_gw_1"},
        )
        # The SDK reads the bare status as a refused key, which the answer alone cannot prove.
        assert exc.problem.code == "auth.invalid_credential"
        message = codegen.explain(exc, "https://api.example.com", route="POST /v1/validate")
        assert message == (
            "HTTP 403 from POST /v1/validate, with no problem document: either PIPELEX_API_KEY was refused,\n"
            "    or this base URL does not serve POST /v1/validate, which a gateway answers alike.\n"
            "    Base URL: https://api.example.com\n"
            "    Check the key in .env — get one at https://app.pipelex.com — and that PIPELEX_BASE_URL\n"
            "    points at a Pipelex API that serves this route, or drop it to use the default.\n"
            "    Request id: req_gw_1"
        )

    def test_a_protocol_route_refusal_names_the_route_and_the_key(self):
        """`validate` is a protocol route, and it raises the SDK's typed error like a product route does."""
        body = {
            "type": "https://mthds.ai/errors/auth.invalid_credential",
            "title": "The credential is not valid",
            "status": 403,
            "detail": "The API key is not valid.",
            "code": "auth.invalid_credential",
            "domain": "account",
            "retry": "no",
            "next_step": {"kind": "check_credentials", "detail": "Check the API key the request sends."},
        }
        exc = ApiResponseError("nope", api_url="https://api.example.com", status=403, status_text="Forbidden", response_body=json.dumps(body))
        message = codegen.explain(exc, "https://api.example.com", route="POST /v1/validate")
        # A refused credential the API said in a problem document: the fix on this side is the key.
        assert message == (
            "PIPELEX_API_KEY was refused on POST /v1/validate (HTTP 403, auth.invalid_credential).\n"
            "    Base URL: https://api.example.com\n"
            "    Check the key in .env — get one at https://app.pipelex.com."
        )

    def test_an_unknown_status_names_the_route_the_reason_and_the_next_step(self):
        problem = Problem.model_validate(
            {
                "type": "https://mthds.ai/errors/request.invalid",
                "title": "The request is invalid",
                "status": 422,
                "detail": "method_ref is not supported here",
                "code": "request.invalid",
                "domain": "input",
                "retry": "no",
                "next_step": {"kind": "change_input", "detail": "Send the bundle's files instead."},
                "request_id": "req_1",
                "errors": [{"code": "request.field_invalid", "detail": "Unexpected member.", "location": {"field": "method_ref"}}],
            }
        )
        exc = ApiResponseError(
            "nope",
            api_url="https://api.example.com",
            status=422,
            status_text="Unprocessable Entity",
            response_body=json.dumps(problem.as_wire()),
            problem=problem,
        )
        message = codegen.explain(exc, "https://api.example.com", route="POST /v1/validate")
        assert message == (
            "HTTP 422 from POST /v1/validate — method_ref is not supported here\n"
            "    method_ref: Unexpected member.\n"
            "    Next step: Send the bundle's files instead.\n"
            "    For support: request.invalid · request req_1"
        )

    def test_a_plain_text_answer_is_still_the_reason(self):
        exc = ApiResponseError(
            "nope", api_url="https://api.example.com", status=422, status_text="Unprocessable Entity", response_body="not supported\n"
        )
        assert codegen.explain(exc, "https://api.example.com", route="POST /v1/validate") == "HTTP 422 from POST /v1/validate — not supported"

    def test_a_missing_route_sends_the_reader_to_the_base_url(self):
        exc = ApiResponseError("gone", api_url="https://api.example.com/v1/codegen", status=404, status_text="Not Found", response_body="")
        assert "PIPELEX_BASE_URL" in codegen.explain(exc, "https://api.example.com")

    def test_a_404_the_route_itself_answered_is_not_a_missing_route(self):
        """A `method_ref` whose package does not exist is a 404 carrying its own code, not a wrong base URL."""
        problem = Problem.model_validate(
            {
                "type": "https://mthds.ai/errors/method.not_found",
                "title": "No method is found at the address",
                "status": 404,
                "detail": "No package at github.com/acme/nothing.",
                "code": "method.not_found",
                "domain": "input",
                "retry": "no",
                "next_step": {"kind": "change_input", "detail": "Check the method's address."},
            }
        )
        exc = ApiResponseError(
            "gone",
            api_url="https://api.example.com",
            status=404,
            status_text="Not Found",
            response_body=json.dumps(problem.as_wire()),
            problem=problem,
        )
        message = codegen.explain(exc, "https://api.example.com", route="POST /v1/validate")
        assert "PIPELEX_BASE_URL" not in message
        assert message == (
            "HTTP 404 from POST /v1/validate — No package at github.com/acme/nothing.\n"
            "    Next step: Check the method's address.\n"
            "    For support: method.not_found"
        )

    def test_a_failure_that_is_no_answer_reads_as_itself(self):
        assert codegen.explain(OSError("disk full"), "https://api.example.com") == "disk full"
