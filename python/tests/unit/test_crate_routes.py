"""The crate routes — `resolve` and `codegen` — and the three-form method selector the family shares.

Ports the relevant slice of `pipelex-sdk-js/tests/crate-routes.test.ts`: verb + path + body,
the 200-verdict discipline (branch on `is_valid`), the strict three-way XOR at request
construction, the hosted `method_id` pass-through, and the fetch-sized budget a
`method_ref` closure gets (the server may have to clone before it answers). `pipe_io` has its own
module, `test_pipe_io_route.py`; its request joins the XOR cases here, which pin the whole family.
"""

import asyncio
import json
from typing import TYPE_CHECKING

import httpx
import pytest
from pydantic import ValidationError
from pytest_mock import MockerFixture, MockType

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.crate_models import (
    CodegenRequest,
    CodegenValidReport,
    CrateInvalidReport,
    PipeIORequest,
    ResolveRequest,
    ResolveValidReport,
)
from pipelex_sdk.errors import ApiResponseError

if TYPE_CHECKING:
    from mthds.method_tree.file_entry import FileEntry

_BASE_URL = "http://localhost:8081"
_METHOD_REF = "github.com/Pipelex/methods/documents@v0.1.0"

_RESOLVE_VALID: dict[str, object] = {"is_valid": True, "crate": {"concepts": {}, "pipes": {}, "domains": {}, "fingerprint": "abc"}, "message": "ok"}
_CODEGEN_VALID = {
    "is_valid": True,
    "kind": "types",
    "target": "python-pydantic",
    "crate_fingerprint": "abc",
    "engine_version": "0.55.0",
    "artifacts": [{"path": "models.py", "content": "# stamped\n"}],
    "lock": 'lock_version = 1\ncrate_fingerprint = "abc"\n',
    "lock_filename": "codegen.lock",
    "message": "ok",
}
_INVALID = {
    "is_valid": False,
    "message": "closure did not validate",
    "errors": [{"code": "method.pipe_type_invalid", "detail": "unknown pipe type"}],
}


def _response(status_code: int, *, json_body: object | None = None) -> httpx.Response:
    request = httpx.Request("POST", f"{_BASE_URL}/x")
    if json_body is not None:
        return httpx.Response(status_code, json=json_body, request=request)
    return httpx.Response(status_code, request=request)


class TestCrateRoutes:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    def _mock_send(self, mocker: MockerFixture, client: PipelexAPIClient, response: httpx.Response) -> MockType:
        return mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=response))

    # ── resolve ──────────────────────────────────────────────────────

    def test_resolve_posts_the_files_map_and_returns_the_crate(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_RESOLVE_VALID))

        report = asyncio.run(client.resolve(ResolveRequest(files={"b.mthds": 'domain = "demo"', "steps/c.mthds": 'domain = "steps"'})))

        call = send.call_args
        assert call.args[0] == "POST"
        assert call.args[1] == f"{_BASE_URL}/v1/resolve"
        assert json.loads(call.kwargs["content"]) == {"files": {"b.mthds": 'domain = "demo"', "steps/c.mthds": 'domain = "steps"'}}
        assert isinstance(report, ResolveValidReport)
        assert report.crate["fingerprint"] == "abc"

    def test_resolve_method_id_is_a_pure_pass_through(self, mocker: MockerFixture) -> None:
        """Nothing is expanded client-side: the id rides the body alone and the platform
        resolves it (a bare runner rejects the request as carrying no source it understands).
        """
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_RESOLVE_VALID))

        asyncio.run(client.resolve(ResolveRequest(method_id="mt_1")))

        assert json.loads(send.call_args.kwargs["content"]) == {"method_id": "mt_1"}

    def test_resolve_invalid_closure_is_a_200_verdict(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(200, json_body=_INVALID))

        report = asyncio.run(client.resolve(ResolveRequest(method_ref=_METHOD_REF)))

        assert isinstance(report, CrateInvalidReport)
        assert [(item.code, item.detail) for item in report.errors] == [("method.pipe_type_invalid", "unknown pipe type")]

    def test_resolve_no_verdict_raises_api_response_error(self, mocker: MockerFixture) -> None:
        """A selector-resolution failure (no package at the address, an unknown id) is a
        non-2xx — never an `is_valid: false` verdict.
        """
        client = self._client()
        self._mock_send(mocker, client, _response(404, json_body={"detail": "Unknown method", "code": "not_found"}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.resolve(ResolveRequest(method_id="mt_ghost")))
        assert exc_info.value.status == 404

    # ── codegen ──────────────────────────────────────────────────────

    def test_codegen_posts_axes_and_returns_artifacts_with_lock(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_CODEGEN_VALID))

        report = asyncio.run(client.codegen(CodegenRequest(files={"main.mthds": "x"}, target="python-pydantic")))

        call = send.call_args
        assert call.args[1] == f"{_BASE_URL}/v1/codegen"
        assert json.loads(call.kwargs["content"]) == {"files": {"main.mthds": "x"}, "kind": "types", "target": "python-pydantic"}
        assert isinstance(report, CodegenValidReport)
        assert report.artifacts[0].path == "models.py"
        assert report.lock_filename == "codegen.lock"

    # ── the strict three-way XOR ─────────────────────────────────────

    @pytest.mark.parametrize(
        "kwargs",
        [
            {},
            {"files": {"main.mthds": "x"}, "method_ref": _METHOD_REF},
            {"files": {"main.mthds": "x"}, "method_id": "mt_1"},
            {"contents": {"main.mthds": "x"}, "method_ref": _METHOD_REF},
            {"method_ref": _METHOD_REF, "method_id": "mt_1"},
            {"files": {"main.mthds": "x"}, "method_ref": _METHOD_REF, "method_id": "mt_1"},
        ],
    )
    def test_request_construction_enforces_exactly_one_selector(self, kwargs: dict[str, object]) -> None:
        """The tooling routes are stateless, so there is no linkage exception: zero selectors
        and every pairing fail at construction, mirroring the server's request-shape 422.
        """
        with pytest.raises(ValidationError, match="exactly one"):
            ResolveRequest.model_validate(kwargs)
        with pytest.raises(ValidationError, match="exactly one"):
            CodegenRequest.model_validate({**kwargs, "target": "python-pydantic"})
        with pytest.raises(ValidationError, match="exactly one"):
            PipeIORequest.model_validate({**kwargs, "pipe_ref": "demo.main"})

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"files": {}},
            {"contents": {}},
            {"method_ref": ""},
            {"method_ref": "   "},
            {"method_id": ""},
            {"method_id": "  \t"},
            {"files": {}, "contents": {}, "method_ref": "", "method_id": ""},
        ],
    )
    def test_empty_selectors_are_absent_and_fail_the_xor(self, kwargs: dict[str, object]) -> None:
        """`files={}`, `contents={}` and blank strings select nothing — the same empty-as-absent rule as the
        run routes — so an empty selector never counts as the sole one and never reaches the
        wire as an unusable value: alone it is zero selectors, refused at construction.
        """
        with pytest.raises(ValidationError, match="exactly one"):
            ResolveRequest.model_validate(kwargs)
        with pytest.raises(ValidationError, match="exactly one"):
            CodegenRequest.model_validate({**kwargs, "target": "python-pydantic"})
        with pytest.raises(ValidationError, match="exactly one"):
            PipeIORequest.model_validate({**kwargs, "pipe_ref": "demo.main"})

    def test_empty_selector_beside_a_real_one_is_simply_absent(self, mocker: MockerFixture) -> None:
        """An empty selector beside a real one is absent, not a conflict — exactly-one
        semantics stay coherent with the run boundary, and the empty key is not sent.
        """
        request = ResolveRequest(files={"main.mthds": "x"}, method_ref="", method_id="  ", dependencies={})
        assert request.method_ref is None
        assert request.method_id is None
        assert request.dependencies is None
        pipe_io_request = PipeIORequest(method_ref=" ", method_id="mt_1", files={})
        assert pipe_io_request.files is None
        assert pipe_io_request.method_ref is None

        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_RESOLVE_VALID))
        asyncio.run(client.resolve(request))
        assert json.loads(send.call_args.kwargs["content"]) == {"files": {"main.mthds": "x"}}

    @pytest.mark.parametrize(
        ("kwargs", "named"),
        [
            ({"files": {"main.mthds": "x"}, "contents": {"main.mthds": "x"}}, "files and contents"),
            ({"files": {"main.mthds": "x"}, "contents": {"main.mthds": "x"}, "method_id": "mt_1"}, "files and contents"),
        ],
    )
    def test_two_forms_of_the_tree_are_refused_at_construction(self, kwargs: dict[str, object], named: str) -> None:
        """The tree is one selector given in one form: two forms of it are refused before the XOR counts."""
        with pytest.raises(ValidationError, match=f"in one form, `files`, `tree` or `contents`; got {named}"):
            ResolveRequest.model_validate(kwargs)
        with pytest.raises(ValidationError, match="in one form"):
            PipeIORequest.model_validate(kwargs)

    @pytest.mark.parametrize("request_model", [ResolveRequest, CodegenRequest, PipeIORequest])
    def test_a_member_the_request_does_not_declare_is_refused_not_dropped(
        self, request_model: type[ResolveRequest | CodegenRequest | PipeIORequest]
    ) -> None:
        """`resources`, which `@pipelex/sdk`'s crate requests carry, is refused at construction rather than
        dropped from the wire without a word, until this SDK carries it too (L-261012-992a34).
        """
        with pytest.raises(ValidationError, match="resources\n  Extra inputs are not permitted"):
            request_model.model_validate({"files": {"main.mthds": "x"}, "resources": {"templates/invoice.docx": b"PK"}})

    @pytest.mark.parametrize("selector", [{"method_ref": _METHOD_REF}, {"method_id": "mt_1"}])
    def test_dependencies_accompany_the_tree_alone(self, selector: dict[str, object]) -> None:
        """`dependencies` are the packages the sent tree calls: beside a published or stored method they
        are the runner's request-shape `422`, refused here at construction.
        """
        dependencies = {"github.com/acme/helpers": {"METHODS.toml": "[package]\n", "main.mthds": 'domain = "helpers"'}}
        with pytest.raises(ValidationError, match="`dependencies` accompany the method's own tree"):
            ResolveRequest.model_validate({**selector, "dependencies": dependencies})

    def test_dependencies_and_read_scope_ride_beside_the_tree(self, mocker: MockerFixture) -> None:
        """`dependencies` travel as given beside `files`, each package a map of file entries keyed by its
        address, and `read_scope` is sent as given, the hosted platform replacing it with the caller's
        organization.
        """
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_RESOLVE_VALID))
        dependencies: dict[str, dict[str, FileEntry]] = {
            "github.com/acme/helpers": {"METHODS.toml": "[package]\n", "main.mthds": 'domain = "helpers"'}
        }

        asyncio.run(client.resolve(ResolveRequest(files={"main.mthds": "x"}, dependencies=dependencies, read_scope="org_1")))

        assert json.loads(send.call_args.kwargs["content"]) == {"files": {"main.mthds": "x"}, "dependencies": dependencies, "read_scope": "org_1"}

    def test_contents_are_sent_inline_as_the_files_map(self, mocker: MockerFixture) -> None:
        """A small `contents` travels inline with no round trip: each UTF-8 file as its text, any other
        as its Base64, in tree path order.
        """
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_RESOLVE_VALID))

        asyncio.run(client.resolve(ResolveRequest(contents={"main.mthds": "x", "logo.png": b"\x89PNG\xff"})))

        send.assert_called_once()
        assert json.loads(send.call_args.kwargs["content"]) == {"files": {"logo.png": {"base64": "iVBOR/8="}, "main.mthds": "x"}}

    # ── the fetch-sized budget ───────────────────────────────────────

    def test_method_ref_closure_gets_the_fetch_budget(self, mocker: MockerFixture) -> None:
        """Resolving an address can make the server clone a repository before it answers; the
        30s management budget would abort a legitimate cold-cache clone and blame the network.
        """
        client = self._client()
        codegen_valid = {**_CODEGEN_VALID, "target": "ts-zod"}
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json_body=_RESOLVE_VALID), _response(200, json_body=codegen_valid)]),
        )

        asyncio.run(client.resolve(ResolveRequest(method_ref=_METHOD_REF)))
        assert send.call_args.kwargs["request_timeout"] == 180.0

        asyncio.run(client.codegen(CodegenRequest(method_ref=_METHOD_REF, target="ts-zod")))
        assert send.call_args.kwargs["request_timeout"] == 180.0

    def test_inline_and_by_id_closures_keep_the_management_budget(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_RESOLVE_VALID))

        asyncio.run(client.resolve(ResolveRequest(files={"main.mthds": "x"})))
        assert send.call_args.kwargs["request_timeout"] == 30.0

        asyncio.run(client.resolve(ResolveRequest(method_id="mt_1")))
        assert send.call_args.kwargs["request_timeout"] == 30.0
