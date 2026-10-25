"""`prepare_inputs` — signature-driven input preparation over the input-form descriptor.

Cases derive from the behavior this SDK shares with `@pipelex/sdk` (`docs/input-preparation.md`) and port
`pipelex-sdk-js/tests/prepare-inputs.test.ts`: file-bearing positions come from the DESCRIPTOR's
declared kind (`document` / `image`), assets are uploaded and rewritten to `pipelex-storage://`
in `url`, http(s)/storage references pass through, dedup keys on source identity, and the call
is copy-on-write.

The fake client returns a canned `/v1/pipe-io` answer from `pipe_io` and records the request, so the
request shape is asserted and not just the outcome; the wiring tests drive the real client, including
the typed selection refusal it must parse off the wire.
"""

import asyncio
import base64
import json
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from mthds.method_tree.exceptions import (
    EmptyMethodTreeError,
    MethodTreeError,
    MethodTreeRefusedError,
    TreeLimitError,
    TreeRefusal,
    TreeSourceError,
)
from mthds.method_tree.file_entry import Base64FileEntry, FileEntry
from mthds.method_tree.models import MethodTree
from mthds.method_tree.vocabulary import TreeLimitKind, TreeRefusalCode
from mthds.protocol.input_form import (
    DocumentField,
    DocumentItem,
    ImageField,
    InputFormField,
    ListField,
    ObjectField,
    PipeInputFormDescriptor,
    TextField,
    UnknownField,
)
from mthds.protocol.pipe_io_contracts import PresenceMarker
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.crate_models import CrateInvalidReport, PipeIORequest, PipeIOResponse, PipeIOValidReport
from pipelex_sdk.errors import ApiResponseError, InputPreparationError, InvalidInputValueError, MethodLoadError, RejectedAssetError
from pipelex_sdk.prepare_inputs import prepare_inputs
from pipelex_sdk.product_models import UploadedFile, UploadInput
from tests.unit.conftest import problem_document, refused_argument
from tests.unit.test_data import PipeIOBodies

_BASE_URL = "http://localhost:8081"
_FILES: dict[str, FileEntry] = {"main.mthds": 'domain = "demo"'}
_PIPE_REF = "demo.main"


def _required(**kwargs: Any) -> dict[str, Any]:
    """The pipe-slot facts every TOP-LEVEL field must state (`required` restates `presence`)."""
    return {"required": True, "presence": PresenceMarker.PLAIN, "gating": True, **kwargs}


def _optional(**kwargs: Any) -> dict[str, Any]:
    """An optional slot: `required: false`, `presence: optional`, and it never gates."""
    return {"required": False, "presence": PresenceMarker.OPTIONAL, "gating": False, **kwargs}


def _form(*fields: InputFormField, pipe_ref: str = _PIPE_REF) -> dict[str, PipeInputFormDescriptor]:
    return {pipe_ref: PipeInputFormDescriptor(fields=list(fields))}


def _report(input_form: dict[str, PipeInputFormDescriptor], *, pipe_ref: str | None = _PIPE_REF) -> PipeIOValidReport:
    """A single-pipe valid answer: the route resolved `pipe_ref` and keyed the descriptor by it."""
    return PipeIOValidReport(
        is_valid=True,
        pipe_ref=pipe_ref,
        pipe_io_contracts={},
        input_form=input_form,
        output_form={},
        default_pipe_ref=pipe_ref,
        pending_signatures=[],
        is_runnable=True,
    )


def _api_error(status: int, body: dict[str, Any]) -> ApiResponseError:
    """The `ApiResponseError` the real client raises for this answer, built through its own error seam."""
    client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
    response = httpx.Response(status, json=body, request=httpx.Request("POST", f"{_BASE_URL}/v1/pipe-io"))
    with pytest.raises(ApiResponseError) as exc_info:
        client._raise_v1_refusal(method="POST", endpoint="pipe-io", response=response)
    return exc_info.value


class _FakePrepareClient:
    """Fake client: `pipe_io` returns the given answer (or raises) and records the request; `upload` counts calls."""

    def __init__(
        self,
        result: PipeIOResponse | None = None,
        *,
        pipe_io_error: Exception | None = None,
        upload_error: Exception | None = None,
    ) -> None:
        self.api_key = "test-token"
        self._result = result
        self._pipe_io_error = pipe_io_error
        self._upload_error = upload_error
        self.upload_calls: list[UploadInput] = []
        self.pipe_io_calls: list[PipeIORequest] = []
        self._counter = 0

    async def pipe_io(self, request: PipeIORequest) -> PipeIOResponse:
        self.pipe_io_calls.append(request)
        if self._pipe_io_error is not None:
            raise self._pipe_io_error
        assert self._result is not None
        return self._result

    async def upload(self, upload_input: UploadInput) -> UploadedFile:
        if self._upload_error is not None:
            raise self._upload_error
        self._counter += 1
        self.upload_calls.append(upload_input)
        return UploadedFile(uri=f"pipelex-storage://user/assets/{self._counter}.bin", filename=upload_input.filename)


def _image_client(name: str = "photo", **upload_error: Any) -> _FakePrepareClient:
    return _FakePrepareClient(_report(_form(ImageField(name=name, **_required()))), **upload_error)


class TestPrepareInputs:
    # ── The signature call ────────────────────────────────────────────────

    def test_asks_pipe_io_for_the_pipe_the_route_selects(self) -> None:
        client = _image_client()

        asyncio.run(prepare_inputs(client, files=_FILES, inputs={}))

        # One call, one pipe, no echo: the route selects the pipe when none is named.
        assert client.pipe_io_calls == [PipeIORequest(files=_FILES)]
        request = client.pipe_io_calls[0]
        assert request.pipe_ref is None
        assert request.all_pipes is False
        assert request.include_files is False

    def test_passes_the_files_through_as_given(self) -> None:
        # The route takes the method's tree, so each file keeps its tree path and its entry as given.
        client = _image_client()
        files: dict[str, FileEntry] = {"main.mthds": "a", "steps/b.mthds": "b", "logo.png": Base64FileEntry(base64="AQ==")}

        asyncio.run(prepare_inputs(client, files=files, inputs={}))

        assert client.pipe_io_calls[0].files == PipeIORequest(files=files).files

    def test_passes_contents_and_dependencies_to_the_route(self) -> None:
        # A tree given as `contents` reaches `pipe_io` as given, which prepares it as a save would, and the
        # packages it calls ride beside it.
        client = _image_client()
        dependencies: dict[str, dict[str, FileEntry]] = {"github.com/acme/helpers": {"main.mthds": 'domain = "helpers"'}}

        asyncio.run(prepare_inputs(client, contents={"main.mthds": "a"}, dependencies=dependencies, inputs={}))

        assert client.pipe_io_calls == [PipeIORequest(contents={"main.mthds": "a"}, dependencies=dependencies)]

    def test_two_forms_of_the_tree_are_refused_before_any_request(self) -> None:
        client = _image_client()

        with pytest.raises(InputPreparationError, match="given as `files` and `contents`") as caught:
            asyncio.run(prepare_inputs(client, files=_FILES, contents={"main.mthds": "a"}, inputs={}))
        assert refused_argument(caught.value) == {"argument": "files", "reason": "mutually_exclusive"}
        assert client.pipe_io_calls == []

    def test_the_retired_list_of_files_is_refused_not_read_as_absent(self) -> None:
        client = _image_client()
        retired: Any = [{"content": 'domain = "demo"', "source": "demo.mthds"}]

        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(prepare_inputs(client, files=retired, inputs={}))
        assert str(caught.value) == ("Cannot prepare inputs: `files` must be the method's tree as a map from tree path to file entry, got a list.")
        assert refused_argument(caught.value) == {"argument": "files", "reason": "not_a_map"}
        assert client.pipe_io_calls == []

    @pytest.mark.parametrize(
        ("selector", "message", "named"),
        [
            pytest.param(
                {"contents": [("demo.mthds", 'domain = "demo"')]},
                "`contents` must be the method's files as a map from tree path to bytes or text, got a list.",
                {"argument": "contents", "reason": "not_a_map"},
                id="contents-list",
            ),
            pytest.param(
                {"contents": {"demo.mthds": 42}},
                '`contents` must be the method\'s files as a map from tree path to bytes or text, and "demo.mthds" holds int.',
                {"argument": "contents", "reason": "entry_mistyped"},
                id="contents-value",
            ),
            pytest.param(
                {"files": {"main.mthds": "a"}, "dependencies": ["github.com/acme/scoring"]},
                "`dependencies` must be the method packages as a map from package address to its map of file entries, got a list.",
                {"argument": "dependencies", "reason": "not_a_map"},
                id="dependencies-list",
            ),
            pytest.param(
                {"files": {"main.mthds": "a"}, "dependencies": {"github.com/acme/scoring": "scoring.mthds"}},
                "`dependencies` must be the method packages as a map from package address to its map of file entries, "
                'and "github.com/acme/scoring" holds str.',
                {"argument": "dependencies", "reason": "entry_mistyped"},
                id="dependency-value",
            ),
            pytest.param(
                {"tree": 42},
                "`tree` must be a listed method tree, a `MethodTree` such as the client's `list_method_tree` returns, "
                "or the path of a directory or of a `.mthds` file, got int.",
                {"argument": "tree", "reason": "not_a_tree"},
                id="tree-int",
            ),
            pytest.param(
                {"tree": MethodTree(files=[], digest=f"sha256:{'0' * 64}")},
                "`tree` holds no file, and a method tree holds at least one.",
                {"argument": "tree", "reason": "empty"},
                id="tree-empty",
            ),
        ],
    )
    def test_a_mistyped_selector_is_refused_before_any_request(self, selector: dict[str, Any], message: str, named: dict[str, str]) -> None:
        """Each is refused with the wording `@pipelex/sdk` uses, never as pydantic's `ValidationError`, its problem naming the argument."""
        client = _image_client()

        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(prepare_inputs(client, **selector, inputs={}))
        assert str(caught.value) == f"Cannot prepare inputs: {message}"
        assert refused_argument(caught.value) == named
        assert client.pipe_io_calls == []

    def test_a_string_tree_reaches_pipe_io_as_the_path_it_names(self) -> None:
        client = _image_client()
        tree: Any = "./method"

        asyncio.run(prepare_inputs(client, tree=tree, inputs={}))

        assert client.pipe_io_calls == [PipeIORequest(tree=Path("./method"))]

    @pytest.mark.parametrize(
        ("error", "reason"),
        [
            pytest.param(
                EmptyMethodTreeError("The tree holds no file.", root=Path("method"), excluded_files={}, excluded_directories={}, raw_paths={}),
                "empty",
                id="empty",
            ),
            pytest.param(
                MethodTreeRefusedError("The tree holds a symbolic link.", refusal=TreeRefusal(code=TreeRefusalCode.SYMBOLIC_LINK, names=["link"])),
                "symbolic_link",
                id="refused",
            ),
            pytest.param(
                TreeLimitError("The tree holds too many files.", root=Path("method"), kind=TreeLimitKind.FILE_COUNT, limit=1, reached=2),
                "limit_passed",
                id="limit",
            ),
            pytest.param(TreeSourceError("No such directory."), "unreadable", id="source"),
        ],
    )
    def test_a_refusal_of_the_tree_listing_is_an_input_preparation_error(self, error: MethodTreeError, reason: str) -> None:
        """The client lists a path when it sends the pipe I/O request, and the standard's refusal names `tree`, kept as the cause."""
        client = _FakePrepareClient(pipe_io_error=error)

        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(prepare_inputs(client, tree=Path("method"), inputs={}))

        assert str(caught.value) == f"Cannot prepare inputs: the method's tree cannot be sent — {error.message}"
        assert refused_argument(caught.value) == {"argument": "tree", "reason": reason}
        assert caught.value.__cause__ is error
        assert client.upload_calls == []

    def test_a_files_entry_the_request_refuses_is_an_input_preparation_error(self) -> None:
        """What the selector checks do not read is the request model's to refuse, still before any request."""
        client = _image_client()
        files: Any = {"main.mthds": 42}

        with pytest.raises(
            InputPreparationError, match=r"^Cannot prepare inputs: the method selector does not form a pipe I/O request: files\.main\.mthds"
        ) as caught:
            asyncio.run(prepare_inputs(client, files=files, inputs={}))
        assert refused_argument(caught.value) == {"argument": "files", "reason": "invalid"}
        assert client.pipe_io_calls == []

    @pytest.mark.parametrize("selector", [{"method_ref": "github.com/o/r"}, {"method_id": "mt_1"}])
    def test_dependencies_beside_a_published_or_stored_method_are_refused(self, selector: dict[str, Any]) -> None:
        client = _image_client()

        with pytest.raises(InputPreparationError, match="`dependencies` accompany the method's own tree") as caught:
            asyncio.run(prepare_inputs(client, dependencies={"github.com/acme/helpers": {"main.mthds": "x"}}, inputs={}, **selector))
        assert refused_argument(caught.value) == {"argument": "dependencies", "reason": "without_a_tree"}
        assert client.pipe_io_calls == []

    def test_method_ref_is_a_server_side_pass_through(self) -> None:
        client = _image_client()

        asyncio.run(prepare_inputs(client, method_ref="github.com/Pipelex/methods/documents", inputs={}))

        assert client.pipe_io_calls == [PipeIORequest(method_ref="github.com/Pipelex/methods/documents")]

    def test_method_id_is_a_server_side_pass_through(self) -> None:
        client = _image_client()

        asyncio.run(prepare_inputs(client, method_id="mt_abc123", inputs={}))

        assert client.pipe_io_calls == [PipeIORequest(method_id="mt_abc123")]

    # ── The three selectors ───────────────────────────────────────────────

    def test_no_selector_is_refused_before_any_request(self) -> None:
        client = _image_client()

        with pytest.raises(InputPreparationError, match="no method selector"):
            asyncio.run(prepare_inputs(client, inputs={"photo": bytes([1])}))
        assert client.pipe_io_calls == []
        assert client.upload_calls == []

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"files": _FILES, "method_ref": "github.com/o/r"},
            {"files": _FILES, "method_id": "mt_1"},
            {"contents": {"main.mthds": "a"}, "method_ref": "github.com/o/r"},
            {"method_ref": "github.com/o/r", "method_id": "mt_1"},
        ],
    )
    def test_several_selectors_are_refused_before_any_request(self, kwargs: dict[str, Any]) -> None:
        client = _image_client()

        with pytest.raises(InputPreparationError, match="exactly one method selector"):
            asyncio.run(prepare_inputs(client, inputs={}, **kwargs))
        assert client.pipe_io_calls == []

    def test_empty_selectors_are_absent_beside_a_real_one(self) -> None:
        # `files={}` and a blank `method_id` select nothing, so they may sit beside a real
        # `method_ref` without tripping the XOR — the run options' empty-as-absent rule.
        client = _image_client()

        asyncio.run(prepare_inputs(client, files={}, contents={}, method_ref="github.com/o/r", method_id="   ", inputs={}))

        assert client.pipe_io_calls == [PipeIORequest(method_ref="github.com/o/r")]

    def test_only_empty_selectors_is_no_selector(self) -> None:
        client = _image_client()

        with pytest.raises(InputPreparationError, match="no method selector"):
            asyncio.run(prepare_inputs(client, files={}, method_ref="", inputs={}))

    @pytest.mark.parametrize(
        ("kwargs", "argument", "type_name"),
        [
            ({"method_ref": 123}, "method_ref", "int"),
            ({"method_id": ["mt_1"]}, "method_id", "list"),
            ({"method_ref": True}, "method_ref", "bool"),
        ],
    )
    def test_a_non_string_selector_is_refused_rather_than_read_as_absent(self, kwargs: dict[str, Any], argument: str, type_name: str) -> None:
        # Empty is absent, but a WRONG TYPE is not: coercing it to `None` would let the XOR
        # pass on `files` alone and prepare against a method the caller did not name.
        client = _image_client()

        with pytest.raises(InputPreparationError) as exc_info:
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={}, **kwargs))

        assert str(exc_info.value) == f"Cannot prepare inputs: `{argument}` must be a string, got {type_name}."
        assert client.pipe_io_calls == []
        assert client.upload_calls == []

    def test_a_non_string_pipe_ref_is_refused_rather_than_silently_defaulted(self) -> None:
        # Read as absent, it would let the route select the default pipe: the pipe the caller
        # named would vanish without a word. Refused on the pre-request boundary.
        client = _image_client()

        with pytest.raises(InputPreparationError) as exc_info:
            asyncio.run(prepare_inputs(client, files=_FILES, pipe_ref=cast("str", 123), inputs={}))

        assert str(exc_info.value) == "Cannot prepare inputs: `pipe_ref` must be a string, got int."
        assert client.pipe_io_calls == []

    # ── Pipe selection: the route's ───────────────────────────────────────

    def test_reads_the_descriptor_of_the_pipe_the_route_resolved(self) -> None:
        # No `pipe_ref`: the route's chain picks `demo.second`, and the walk follows its
        # descriptor, which declares `photo` as an image.
        client = _FakePrepareClient(_report(_form(ImageField(name="photo", **_required()), pipe_ref="demo.second"), pipe_ref="demo.second"))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": bytes([1])}))

        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/1.bin"}}

    def test_an_explicit_pipe_ref_is_sent_to_the_route(self) -> None:
        client = _FakePrepareClient(_report(_form(ImageField(name="photo", **_required()), pipe_ref="demo.second"), pipe_ref="demo.second"))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, pipe_ref=" demo.second ", inputs={"photo": bytes([1])}))

        # Trimmed on the way out, like every caller-supplied selector.
        assert client.pipe_io_calls == [PipeIORequest(files=_FILES, pipe_ref="demo.second")]
        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/1.bin"}}

    def test_a_bare_pipe_ref_is_refused_before_any_request(self) -> None:
        # The runner would still resolve a bare code across domains; preparation is
        # qualified-only, so it refuses before spending the round-trip.
        client = _image_client()

        with pytest.raises(InputPreparationError) as exc_info:
            asyncio.run(prepare_inputs(client, files=_FILES, pipe_ref="main", inputs={}))

        assert str(exc_info.value) == 'Cannot prepare inputs: `pipe_ref` must be qualified (`domain.pipe_code`), got the bare "main".'
        assert client.pipe_io_calls == []

    @pytest.mark.parametrize("pipe_ref", ["deps->legal.summarize", "deps->summarize"])
    def test_a_dependency_package_pipe_ref_is_refused_before_any_request(self, pipe_ref: str) -> None:
        # The alias names a dependency package's pipe, and the route loads no address-based
        # dependency. Checked before the bare rule, so `deps->summarize` is named for what it is.
        client = _image_client()

        with pytest.raises(InputPreparationError) as exc_info:
            asyncio.run(prepare_inputs(client, files=_FILES, pipe_ref=pipe_ref, inputs={}))

        assert str(exc_info.value) == (
            f'Cannot prepare inputs: `pipe_ref` "{pipe_ref}" names a dependency package\'s pipe. '
            "Preparation covers the method's own pipes: name one as `domain.pipe_code`."
        )
        assert client.pipe_io_calls == []

    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            (PipeIOBodies.UNKNOWN_PIPE_REFUSAL, "Pipe 'smoke.absent' not found in the submitted closure."),
            (
                PipeIOBodies.AMBIGUOUS_PIPE_REFUSAL,
                "No `pipe_ref` was given and the closure declares several `main_pipe`s (alpha.run, beta.run) — name the pipe explicitly.",
            ),
        ],
    )
    def test_a_refused_selection_is_an_input_preparation_error(self, body: dict[str, Any], detail: str) -> None:
        refusal = _api_error(422, body)
        client = _FakePrepareClient(pipe_io_error=refusal)

        with pytest.raises(InputPreparationError) as exc_info:
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": bytes([1])}))

        assert str(exc_info.value) == f"Cannot prepare inputs: the pipe could not be selected — {detail}"
        # The whole problem document stays reachable for a caller who needs it.
        assert exc_info.value.__cause__ is refusal
        assert client.upload_calls == []

    @pytest.mark.parametrize(
        ("status", "body"),
        [
            (422, PipeIOBodies.REQUEST_SHAPE_REFUSAL),
            (422, problem_document("method.fetch_failed", 422, domain="method", detail="The repository could not be fetched.")),
            (404, problem_document("pipelex.catalog.not_found", 404, detail="Unknown method")),
            (404, {"detail": "Unknown method", "code": "request.pipe_not_found"}),
            (500, problem_document("runtime.unexpected", 500, domain="runtime", detail="PipeIOContractError")),
        ],
    )
    def test_every_other_error_is_left_as_it_is(self, status: int, body: dict[str, Any]) -> None:
        # Only the problems of the pipe selection codes are a selection: a problem of any other code is not, nor a body
        # that is no problem document, whatever members it carries.
        error = _api_error(status, body)
        client = _FakePrepareClient(pipe_io_error=error)

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(prepare_inputs(client, method_id="mt_1", inputs={}))

        assert exc_info.value is error

    @pytest.mark.parametrize(
        ("input_form", "pipe_ref"),
        [
            ({}, _PIPE_REF),
            (_form(ImageField(name="photo", **_required()), pipe_ref="demo.other"), _PIPE_REF),
            (_form(ImageField(name="photo", **_required())), None),
        ],
    )
    def test_an_answer_without_the_selected_descriptor_is_an_error_not_a_silent_no_op(
        self, input_form: dict[str, PipeInputFormDescriptor], pipe_ref: str | None
    ) -> None:
        # Never a silent degrade to "no uploads": without the descriptor there is no signature
        # to prepare against, and the caller's local path would travel to the runner verbatim.
        client = _FakePrepareClient(_report(input_form, pipe_ref=pipe_ref))

        with pytest.raises(InputPreparationError, match="carries no input-form descriptor for the selected pipe"):
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": bytes([1])}))
        assert client.upload_calls == []

    # ── The descriptor-guided walk ────────────────────────────────────────

    def test_uploads_top_level_image_bytes(self) -> None:
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": bytes([1, 2, 3])}))

        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/1.bin"}}
        assert len(prepared.uploads) == 1
        assert prepared.uploads[0].uri == "pipelex-storage://user/assets/1.bin"

    def test_passes_http_url_through(self) -> None:
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": "https://example.com/real.png"}))

        assert prepared.inputs == {"photo": {"url": "https://example.com/real.png"}}
        assert prepared.uploads == []
        assert client.upload_calls == []

    def test_passes_existing_storage_uri_through(self) -> None:
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": "pipelex-storage://user/assets/already.png"}))

        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/already.png"}}
        assert prepared.uploads == []

    def test_decodes_and_uploads_data_url(self) -> None:
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": "data:image/png;base64,AQIDBA=="}))

        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/1.bin"}}
        assert client.upload_calls[0].content_type == "image/png"
        assert client.upload_calls[0].data == "AQIDBA=="

    @pytest.mark.parametrize(
        ("data_url", "reason"),
        [
            ("data:image/png;base64,AQI", "invalid base64"),  # bad padding — binascii.Error
            ("data:image/png;base64,AQID!!!!", "invalid base64"),  # non-alphabet junk — rejected by validate=True
            ("data:image/png;base64", "no comma separator"),  # no comma, so no payload at all
        ],
    )
    def test_malformed_data_url_raises_invalid_input_value(self, data_url: str, reason: str) -> None:
        # A malformed data URL must surface as the typed `InvalidInputValueError`, the inputs' own
        # mistake (never a raw binascii.Error), and must never upload silently-corrupted bytes.
        client = _image_client()

        with pytest.raises(InvalidInputValueError) as exc_info:
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": data_url}))
        assert str(exc_info.value) == f'Input "photo" holds a malformed data URL ({reason}).'
        assert client.upload_calls == []

    def test_percent_encoded_binary_data_url_keeps_exact_bytes(self) -> None:
        # A non-base64 data URL carrying percent-encoded binary must upload its exact bytes;
        # decoding as UTF-8 text first would corrupt any byte >= 0x80 (e.g. %FF).
        client = _image_client()

        asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": "data:application/octet-stream,%00%ff%01"}))

        assert base64.b64decode(client.upload_calls[0].data) == bytes([0x00, 0xFF, 0x01])

    def test_uploads_each_element_of_a_declared_list(self) -> None:
        client = _FakePrepareClient(_report(_form(ListField(name="exhibits", item=DocumentItem(required=True), **_required()))))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"exhibits": [bytes([1]), bytes([2])]}))

        assert prepared.inputs == {"exhibits": [{"url": "pipelex-storage://user/assets/1.bin"}, {"url": "pipelex-storage://user/assets/2.bin"}]}
        assert len(prepared.uploads) == 2

    def test_leaves_text_input_untouched(self) -> None:
        client = _FakePrepareClient(_report(_form(TextField(name="question", **_required()))))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"question": "notes/summary.txt"}))

        assert prepared.inputs == {"question": "notes/summary.txt"}
        assert client.upload_calls == []

    def test_uploads_only_the_nested_image_of_a_structured_input(self) -> None:
        dossier = ObjectField(
            name="dossier",
            fields=[TextField(name="title", required=True), ImageField(name="cover", required=True)],
            **_required(),
        )
        client = _FakePrepareClient(_report(_form(dossier)))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"dossier": {"title": "Q3 report", "cover": bytes([7, 7])}}))

        assert prepared.inputs == {"dossier": {"title": "Q3 report", "cover": {"url": "pipelex-storage://user/assets/1.bin"}}}
        assert len(prepared.uploads) == 1

    def test_preserves_sibling_keys_of_canonical_file_content(self) -> None:
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": {"url": bytes([1]), "mime_type": "image/png"}}))

        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/1.bin", "mime_type": "image/png"}}

    def test_copies_through_object_keys_the_descriptor_does_not_name(self) -> None:
        dossier = ObjectField(name="dossier", fields=[ImageField(name="cover", required=True)], **_required())
        client = _FakePrepareClient(_report(_form(dossier)))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"dossier": {"cover": bytes([1]), "note": "kept"}}))

        assert prepared.inputs["dossier"]["note"] == "kept"

    def test_dedups_by_source_identity(self) -> None:
        client = _FakePrepareClient(_report(_form(ListField(name="exhibits", item=DocumentItem(required=True), **_required()))))
        shared = bytes([9, 9, 9])

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"exhibits": [shared, shared]}))

        assert len(client.upload_calls) == 1
        exhibits = prepared.inputs["exhibits"]
        assert exhibits[0]["url"] == exhibits[1]["url"]

    def test_is_copy_on_write(self) -> None:
        client = _image_client()
        original = {"photo": bytes([1, 2, 3])}

        asyncio.run(prepare_inputs(client, files=_FILES, inputs=original))

        assert original["photo"] == bytes([1, 2, 3])

    def test_passes_through_undeclared_input(self) -> None:
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": "https://example.com/p.png", "stray": "left alone"}))

        assert prepared.inputs["stray"] == "left alone"

    def test_uploads_real_local_path(self, tmp_path: Path) -> None:
        client = _image_client()
        path = tmp_path / "shot.png"
        path.write_bytes(bytes([1, 2, 3, 4]))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": str(path)}))

        assert prepared.inputs == {"photo": {"url": "pipelex-storage://user/assets/1.bin"}}
        assert client.upload_calls[0].content_type == "image/png"

    def test_a_shape_mismatch_passes_through_for_the_run_to_reject(self) -> None:
        # A scalar where the descriptor declares an object: preparation never second-guesses
        # the signature, so the value rides through and the run answers for it.
        dossier = ObjectField(name="dossier", fields=[ImageField(name="cover", required=True)], **_required())
        client = _FakePrepareClient(_report(_form(dossier)))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"dossier": "not an object"}))

        assert prepared.inputs == {"dossier": "not an object"}
        assert client.upload_calls == []

    # ── The two misclassifications of L-260826-ddd843 ─────────────────────

    def test_uploads_an_optional_top_level_file_field_when_supplied(self) -> None:
        client = _FakePrepareClient(_report(_form(DocumentField(name="appendix", **_optional()))))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"appendix": bytes([3])}))

        assert prepared.inputs == {"appendix": {"url": "pipelex-storage://user/assets/1.bin"}}

    def test_uploads_an_optional_nested_file_field(self) -> None:
        # First edge: the required-only inputs template never rendered an optional nested
        # file field, so its position was invisible and the caller's local path travelled to
        # the runner as a literal string. The descriptor states `required: false` and the
        # walk enters it.
        dossier = ObjectField(
            name="dossier",
            fields=[TextField(name="title", required=True), ImageField(name="cover", required=False)],
            **_required(),
        )
        client = _FakePrepareClient(_report(_form(dossier)))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"dossier": {"title": "t", "cover": bytes([7])}}))

        assert prepared.inputs["dossier"]["cover"] == {"url": "pipelex-storage://user/assets/1.bin"}

    def test_does_not_read_a_text_field_merely_named_url_from_disk(self) -> None:
        # Second edge: the template marked a file position by rendering a `url`-bearing dict —
        # a side effect of the field's NAME, not of its concept — so a path-shaped text value
        # was uploaded. `kind: "text"` ends that.
        client = _FakePrepareClient(_report(_form(TextField(name="url", **_required()))))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"url": "notes/summary.txt"}))

        assert prepared.inputs == {"url": "notes/summary.txt"}
        assert client.upload_calls == []

    def test_does_not_enter_a_dynamic_input(self) -> None:
        # A `Dynamic` / `Composite` input is `kind: "unknown"` — the standard's escape hatch —
        # and the walk does not enter it, so a canonical file dict nested inside is NOT
        # uploaded. Uploading on the strength of a `url` key is the value-shape guess this
        # walk removes; such a caller uses `upload_file` first and passes the storage URI.
        client = _FakePrepareClient(_report(_form(UnknownField(name="data", **_required()))))
        nested = {"text": "hi", "images": [{"url": "https://mock/i.png"}]}

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"data": nested}))

        assert prepared.inputs == {"data": nested}
        assert client.upload_calls == []

    def test_does_not_path_interpret_a_bare_string_at_a_dynamic_input(self) -> None:
        client = _FakePrepareClient(_report(_form(UnknownField(name="freeform", **_required()))))

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"freeform": "resembles/a/path"}))

        assert prepared.inputs == {"freeform": "resembles/a/path"}
        assert client.upload_calls == []

    # ── The explicit `{concept, content}` envelope ────────────────────────

    def test_unwraps_and_rewraps_the_explicit_envelope(self) -> None:
        client = _image_client()

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": {"concept": "native.Image", "content": bytes([1])}}))

        # The concept annotation rides through to the run; only `content` is rewritten.
        assert prepared.inputs == {"photo": {"concept": "native.Image", "content": {"url": "pipelex-storage://user/assets/1.bin"}}}

    def test_walks_inside_an_envelope_carrying_a_structured_content(self) -> None:
        dossier = ObjectField(
            name="dossier",
            fields=[TextField(name="title", required=True), ImageField(name="cover", required=True)],
            **_required(),
        )
        client = _FakePrepareClient(_report(_form(dossier)))
        envelope = {"concept": "demo.Dossier", "content": {"title": "t", "cover": bytes([7])}}

        prepared = asyncio.run(prepare_inputs(client, files=_FILES, inputs={"dossier": envelope}))

        assert prepared.inputs["dossier"]["concept"] == "demo.Dossier"
        assert prepared.inputs["dossier"]["content"]["cover"] == {"url": "pipelex-storage://user/assets/1.bin"}

    def test_a_dict_that_is_not_exactly_concept_and_content_is_not_an_envelope(self) -> None:
        # The envelope test matches the runtime's `_is_explicit`: keys EXACTLY `concept` and
        # `content`. A third key means it is ordinary content, not an envelope.
        client = _image_client()

        with pytest.raises(InvalidInputValueError, match="which no file input takes"):
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": {"concept": "x", "content": bytes([1]), "extra": 1}}))

    # ── Failures, all raised before any run exists ────────────────────────

    def test_raises_for_unrecognized_value_at_file_position(self) -> None:
        client = _image_client()

        # A plain object that is neither a canonical {url} content nor bytes — a realistic
        # caller typo — must surface as a typed error, not pass through unresolved.
        with pytest.raises(InvalidInputValueError, match=r'^Input "photo" holds a dict with no "url" key, '):
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": {"mimeType": "image/png", "bytes": [1, 2, 3]}}))
        assert client.upload_calls == []

    def test_raises_invalid_input_value_for_a_number_at_a_file_position(self) -> None:
        client = _image_client()

        with pytest.raises(InvalidInputValueError, match=r'^Input "photo" holds a number, '):
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": 42}))
        assert client.upload_calls == []

    def test_raises_when_the_signature_does_not_resolve(self) -> None:
        invalid = CrateInvalidReport.model_validate(PipeIOBodies.INVALID)
        client = _FakePrepareClient(invalid)

        with pytest.raises(MethodLoadError) as exc_info:
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": bytes([1])}))

        assert (
            str(exc_info.value)
            == "Cannot prepare inputs: the method signature did not resolve — Input 'doc' is declared but never read by the template."
        )
        # Every item of the answer, as a problem item of `method.invalid`, so a caller lists them rather than reading
        # the first out of a sentence.
        assert exc_info.value.problem.code == "method.invalid"
        assert [item.model_dump(exclude_none=True) for item in exc_info.value.problem.errors or []] == PipeIOBodies.INVALID["errors"]
        assert exc_info.value.server_message == "1 validation error"
        assert client.upload_calls == []

    def test_surfaces_rejected_asset_before_returning(self) -> None:
        error = ApiResponseError("HTTP 413", api_url=f"{_BASE_URL}/v1/upload", status=413, status_text="Payload Too Large", response_body="too big")
        client = _image_client(upload_error=error)

        with pytest.raises(RejectedAssetError):
            asyncio.run(prepare_inputs(client, files=_FILES, inputs={"photo": bytes([1])}))

    # ── Wiring ────────────────────────────────────────────────────────────

    def test_wires_through_the_real_client(self, mocker: MockerFixture) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        upload_body = {"uri": "pipelex-storage://user/assets/1.bin", "filename": "upload.bin"}
        request = httpx.Request("POST", f"{_BASE_URL}/x")
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    httpx.Response(200, json=PipeIOBodies.VALID, request=request),
                    httpx.Response(200, json=upload_body, request=request),
                ]
            ),
        )

        prepared = asyncio.run(
            client.prepare_inputs(
                files={"smoke.mthds": 'domain = "smoke"'},
                inputs={"doc": bytes([1, 2, 3]), "note": "hi", "dossier": {"title": "t"}},
            )
        )

        assert prepared.inputs == {"doc": {"url": "pipelex-storage://user/assets/1.bin"}, "note": "hi", "dossier": {"title": "t"}}
        assert len(prepared.uploads) == 1
        first_call = send.await_args_list[0]
        assert first_call.args[1] == f"{_BASE_URL}/v1/pipe-io"
        assert json.loads(first_call.kwargs["content"]) == {"files": {"smoke.mthds": 'domain = "smoke"'}}
        assert first_call.kwargs["request_timeout"] == 30.0

    def test_a_directory_past_an_announced_limit_is_refused_after_the_handshake_and_before_pipe_io(self, tmp_path: Path) -> None:
        """The listing needs the limits the handshake announces, so it is refused after that request and before any other."""
        paths: list[str] = []

        def answer(request: httpx.Request) -> httpx.Response:
            paths.append(request.url.path)
            version = {"protocol_version": "1", "runner_version": "0.89.0", "blob_store": True, "limits": {"method_tree": {"max_files": 1}}}
            return httpx.Response(200, json=version, request=request)

        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        client.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
        method_dir = tmp_path / "method"
        method_dir.mkdir()
        (method_dir / "main.mthds").write_text('domain = "smoke"\n')
        (method_dir / "other.mthds").write_text('domain = "other"\n')

        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(client.prepare_inputs(tree=method_dir, inputs={}))

        assert refused_argument(caught.value) == {"argument": "tree", "reason": "limit_passed"}
        assert isinstance(caught.value.__cause__, TreeLimitError)
        assert paths == ["/v1/version"]

    def test_wires_a_method_ref_through_the_real_client(self, mocker: MockerFixture) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        request = httpx.Request("POST", f"{_BASE_URL}/x")
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=httpx.Response(200, json=PipeIOBodies.VALID, request=request)))

        asyncio.run(client.prepare_inputs(method_ref="github.com/o/r", pipe_ref="smoke.echo", inputs={"note": "hi"}))

        call = send.await_args_list[0]
        assert json.loads(call.kwargs["content"]) == {"method_ref": "github.com/o/r", "pipe_ref": "smoke.echo"}
        # The server may clone the repository before it answers.
        assert call.kwargs["request_timeout"] == 180.0

    def test_wires_a_refused_selection_off_the_wire(self, mocker: MockerFixture) -> None:
        # The mapping reads the code of the problem document the real client parses.
        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        request = httpx.Request("POST", f"{_BASE_URL}/v1/pipe-io")
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                return_value=httpx.Response(
                    422, json=PipeIOBodies.UNKNOWN_PIPE_REFUSAL, headers={"content-type": "application/problem+json"}, request=request
                )
            ),
        )

        with pytest.raises(InputPreparationError, match="the pipe could not be selected") as exc_info:
            asyncio.run(client.prepare_inputs(files=_FILES, pipe_ref="smoke.absent", inputs={}))

        cause = exc_info.value.__cause__
        assert isinstance(cause, ApiResponseError)
        assert cause.problem.code == "request.pipe_not_found"


# ── An invalid value names its input (L-261012-a1ce83) ──────────────


def _positions_client() -> _FakePrepareClient:
    """A descriptor with a file at the top level, in a nested field and in a list."""
    dossier = ObjectField(
        name="dossier",
        fields=[ImageField(name="cover", required=True), ListField(name="attachments", item=DocumentItem(required=True), required=True)],
        **_required(),
    )
    return _FakePrepareClient(_report(_form(ImageField(name="photo", **_required()), dossier)))


def _invalid_value(client: _FakePrepareClient, inputs: dict[str, Any]) -> InvalidInputValueError:
    """Run a preparation that must fail with an `InvalidInputValueError`, and hand it back."""
    with pytest.raises(InvalidInputValueError) as exc_info:
        asyncio.run(prepare_inputs(client, files=_FILES, inputs=inputs))
    return exc_info.value


class TestAnInvalidValueNamesItsInput:
    @pytest.mark.parametrize(
        ("inputs", "input_name", "input_path"),
        [
            pytest.param({"photo": 42}, "photo", "photo", id="at the top level"),
            pytest.param({"dossier": {"cover": 42}}, "dossier", "dossier.cover", id="in a nested field"),
            pytest.param({"dossier": {"attachments": ["https://a/x.pdf", 42]}}, "dossier", "dossier.attachments[1]", id="in a list"),
            pytest.param({"photo": {"concept": "native.Image", "content": 42}}, "photo", "photo", id="inside an explicit envelope"),
        ],
    )
    def test_names_the_input_and_the_path_of_a_value_no_file_input_takes(self, inputs: dict[str, Any], input_name: str, input_path: str) -> None:
        client = _positions_client()

        error = _invalid_value(client, inputs)

        assert (error.input_name, error.input_path) == (input_name, input_path)
        assert str(error) == (
            f'Input "{input_path}" holds a number, which no file input takes: pass a local path (a str or a Path), bytes, a data: URL, '
            "an http(s) URL or a pipelex-storage:// reference, bare or as the url of {url} content."
        )
        assert client.upload_calls == []

    @pytest.mark.parametrize(
        ("value", "described"),
        [
            (42, "a number"),
            (4.2, "a number"),
            (True, "a boolean"),
            (None, "None"),
            ([1, 2], "a list"),
            ({"mimeType": "image/png"}, 'a dict with no "url" key'),
            ((1, 2), "a tuple"),
            (bytearray(b"x"), "a bytearray"),
            (object(), "an object"),
            ({"url": 42}, "{url} content whose url is a number"),
            ({"url": {"url": "https://a/x.png"}}, "{url} content whose url is {url} content"),
        ],
    )
    def test_describes_the_value_by_its_kind(self, value: object, described: str) -> None:
        error = _invalid_value(_positions_client(), {"photo": value})

        assert str(error).startswith(f'Input "photo" holds {described}, ')

    def test_leaves_the_callers_data_out_of_the_message(self) -> None:
        error = _invalid_value(_positions_client(), {"photo": {"filename": "contract-acme.pdf", "token": "s3cr3t"}})

        assert "contract-acme" not in str(error)
        assert "s3cr3t" not in str(error)

    @pytest.mark.parametrize(
        ("reason", "data_url"),
        [
            ("no comma separator", "data:image/png;base64"),
            ("invalid base64", "data:image/png;base64,%%%%"),
        ],
    )
    def test_names_the_position_of_a_malformed_data_url_and_quotes_none_of_it(self, reason: str, data_url: str) -> None:
        client = _positions_client()

        error = _invalid_value(client, {"dossier": {"attachments": [data_url]}})

        assert (error.input_name, error.input_path) == ("dossier", "dossier.attachments[0]")
        assert str(error) == f'Input "dossier.attachments[0]" holds a malformed data URL ({reason}).'
        assert "data:" not in str(error)
        assert "image/png" not in str(error)
        assert client.upload_calls == []

    @pytest.mark.parametrize("value", [42, "data:image/png;base64"], ids=["a value no file input takes", "a malformed data URL"])
    def test_reports_the_first_position_of_a_value_met_twice_in_one_list(self, value: object) -> None:
        error = _invalid_value(_positions_client(), {"dossier": {"attachments": ["https://a/x.pdf", value, value]}})

        assert error.input_path == "dossier.attachments[1]"
