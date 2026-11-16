import asyncio
import base64
import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

import httpx
import pytest
from mthds.protocol.input_form import InputFormItem, ListItem
from pydantic import TypeAdapter
from pytest_mock import MockerFixture

from pipelex_sdk.artifact_models import BULK_RESOLVE_MAX_URIS, ArtifactScope, DownloadArtifactsOptions, DownloadedKind, StoredTextLocation
from pipelex_sdk.artifacts import (
    artifact_filename,
    collect_artifacts,
    download_artifacts,
    load_stored_texts,
    locate_artifacts,
    locate_stored_references,
)
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import RunTimeoutError, StoredTextLoadError
from pipelex_sdk.runs import RunArtifact, RunResultCompleted, RunResults, WaitForResultOptions
from pipelex_sdk.stored_texts import (
    STORED_TEXT_CONCEPT_REFS,
    StoredTextKind,
    is_stored_text_concept,
    main_stuff_node,
    stored_text_kind_of,
    stored_text_kind_of_node,
    working_memory_node,
)

_BASE_URL = "http://localhost:8081"
_RUN_ID = "run-stored"
_STORE = "https://store.example"
_SCOPE = "pipelex-storage://org/method/run-stored/generated"
_NODE: TypeAdapter[InputFormItem] = TypeAdapter(InputFormItem)

_TEXT_NODE: dict[str, Any] = {"kind": "prose", "concept_ref": "native.Text", "required": True}
_DOSSIER_NODE: dict[str, Any] = {
    "kind": "object",
    "concept_ref": "my_domain.Dossier",
    "required": True,
    "fields": [
        {"kind": "prose", "name": "summary", "concept_ref": "native.Text", "required": True},
        {"kind": "document", "name": "notes", "concept_ref": "native.Document", "required": True},
    ],
}


def _stored_uri(digest: str, extension: str = "txt") -> str:
    return f"{_SCOPE}/{digest}/value.{extension}"


def _reference(uri: str, *, mime_type: str = "text/plain", preview: str = "The start…") -> dict[str, Any]:
    return {"url": uri, "size": 4096, "mime_type": mime_type, "preview": preview}


def _results(concept: str, main_stuff: Any, output_field: dict[str, Any] | None = None) -> dict[str, Any]:
    """A results body: the main stuff, its working memory, and an output form describing it."""
    output_form = {} if output_field is None else {"my_domain.summarize": {"field": {**output_field, "name": "output"}}}
    return {
        "pipeline_run_id": _RUN_ID,
        "main_stuff": main_stuff,
        "working_memory": {"root": {"summary": {"concept": concept, "content": main_stuff}}, "aliases": {"main_stuff": "summary"}},
        "output_form": output_form,
        "input_form": {},
    }


_DOCUMENT_URI = "pipelex-storage://org/assets/brief.pdf"

#: A top-level input-form field, which states the slot facts (`presence`, `gating`) no nested node may carry.
_DOCUMENT_INPUT_FIELD: dict[str, Any] = {
    "kind": "document",
    "name": "doc",
    "concept_ref": "native.Document",
    "required": True,
    "presence": "plain",
    "gating": True,
}


def _results_with_document_input(main_stuff: Any) -> dict[str, Any]:
    """A results body whose main output is a `native.Text` no output form describes, beside an echoed document input
    that the input form describes as a top-level field.
    """
    body = _results("native.Text", main_stuff)
    body["working_memory"]["root"]["doc"] = {
        "concept": "native.Document",
        "content": {"url": _DOCUMENT_URI, "mime_type": "application/pdf", "filename": "brief.pdf"},
    }
    body["input_form"] = {"my_domain.summarize": {"fields": [_DOCUMENT_INPUT_FIELD]}}
    return body


class _Boundary:
    """The mocked API and object store, and what each was asked."""

    def __init__(
        self,
        mocker: MockerFixture,
        client: PipelexAPIClient,
        *,
        body: dict[str, Any],
        objects: dict[str, bytes] | None = None,
        refusals: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.body = body
        self.objects = objects or {}
        self.refusals = refusals or {}
        self.reads: list[str | None] = []
        self.resolved: list[list[str]] = []
        self.fetched: list[str] = []
        mocker.patch.object(client, "_send", mocker.AsyncMock(side_effect=self._send))
        mocker.patch("pipelex_sdk.artifacts._new_storage_client", self._storage_client)

    async def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        parts = urlsplit(url)
        request = httpx.Request(method, url)
        if parts.path == f"/v1/runs/{_RUN_ID}/results":
            selection = parse_qs(parts.query).get("artifacts", [None])[0]
            self.reads.append(selection)
            if selection is not None and "main_stuff" not in selection.split(","):
                picked: dict[str, Any] = {"pipeline_run_id": _RUN_ID}
                for name in selection.split(","):
                    picked[name] = self.body.get(name)
                return httpx.Response(200, json=picked, request=request)
            if selection is not None:
                narrowed = {name: self.body[name] for name in ("pipeline_run_id", *selection.split(",")) if name in self.body}
                return httpx.Response(200, json=narrowed, request=request)
            return httpx.Response(200, json=self.body, request=request)
        if parts.path == "/v1/resolve-storage-url/bulk":
            uris: list[str] = json.loads(kwargs["content"])["uris"]
            self.resolved.append(uris)
            items = [
                self.refusals.get(uri)
                or {
                    "uri": uri,
                    "url": f"{_STORE}/{quote(uri, safe='')}?sig=1",
                    "expires_at": "2099-01-01T00:00:00Z",
                    "content_type": "text/plain",
                    "error": None,
                }
                for uri in uris
            ]
            return httpx.Response(200, json={"items": items}, request=request)
        msg = f"unexpected request {method} {url}"
        raise AssertionError(msg)

    def _store(self, request: httpx.Request) -> httpx.Response:
        self.fetched.append(str(request.url))
        uri = unquote(request.url.path.removeprefix("/"))
        payload = self.objects.get(uri)
        if payload is None:
            return httpx.Response(404)
        return httpx.Response(200, content=payload)

    def _storage_client(self, timeout_seconds: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self._store), timeout=httpx.Timeout(timeout_seconds), follow_redirects=False)


def _client() -> PipelexAPIClient:
    return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)


def _completed(state: Any) -> RunResults:
    assert isinstance(state, RunResultCompleted)
    return state.result


class TestStoredTexts:
    # ── concepts ─────────────────────────────────────────────────────

    def test_names_the_four_natives_and_reads_a_refinement_chain(self) -> None:
        assert STORED_TEXT_CONCEPT_REFS == ("native.Text", "native.Markdown", "native.Html", "native.JSON")
        assert stored_text_kind_of("native.Markdown") == StoredTextKind.TEXT
        assert stored_text_kind_of("native.Html") == StoredTextKind.HTML
        assert stored_text_kind_of("legal.Memo", ["legal.Note", "native.JSON"]) == StoredTextKind.JSON
        assert is_stored_text_concept("native.Document") is False
        assert is_stored_text_concept("legal.Contract", ["native.Document"]) is False

    @pytest.mark.parametrize(
        ("node", "expected"),
        [
            pytest.param({"kind": "prose", "concept_ref": "legal.Clause", "required": True}, StoredTextKind.TEXT, id="description_only"),
            pytest.param(
                {"kind": "prose", "concept_ref": "legal.Special", "refines": ["legal.Clause"], "required": True},
                StoredTextKind.TEXT,
                id="refining_description_only",
            ),
            pytest.param({"kind": "text", "concept_ref": "legal.When", "refines": ["native.Time"], "required": True}, None, id="other_native"),
            pytest.param({"kind": "text", "required": True}, None, id="bare_field_type"),
            pytest.param({"kind": "object", "concept_ref": "legal.Contract", "required": True, "fields": []}, None, id="structured"),
            pytest.param({"kind": "image", "concept_ref": "native.Image", "required": True}, None, id="image"),
        ],
    )
    def test_reads_the_stored_text_kind_of_a_node(self, node: dict[str, Any], expected: StoredTextKind | None) -> None:
        assert stored_text_kind_of_node(_NODE.validate_python(node)) == expected

    def test_finds_the_main_outputs_node_from_the_working_memory_and_the_output_form(self) -> None:
        results = RunResults.model_validate(_results("my_domain.Dossier", {"summary": {"text": "x"}}, _DOSSIER_NODE))
        node = main_stuff_node(results)
        assert node is not None
        assert node.concept_ref == "my_domain.Dossier"
        assert main_stuff_node(RunResults.model_validate({"pipeline_run_id": _RUN_ID, "main_stuff": {}})) is None

    def test_describes_each_stuff_of_the_working_memory_beside_a_top_level_input_field(self) -> None:
        text_uri = _stored_uri("wm")
        results = RunResults.model_validate(_results_with_document_input(_reference(text_uri)))

        node = working_memory_node(results)

        assert node is not None
        assert results.working_memory is not None
        references = locate_stored_references(results.working_memory.model_dump(), node)
        assert references.texts == [
            StoredTextLocation(
                uri=text_uri,
                found_at=["$.root.summary.content.url"],
                kind=StoredTextKind.TEXT,
                size=4096,
                mime_type="text/plain",
                preview="The start…",
            )
        ]
        assert [(location.uri, location.found_at) for location in references.files] == [(_DOCUMENT_URI, ["$.root.doc.content.url"])]

    def test_wraps_a_plural_output_whose_concept_only_a_top_level_input_field_names(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("pl")
        prose_input = {"kind": "prose", "name": "brief", "concept_ref": "native.Text", "required": True, "presence": "plain", "gating": True}
        body = _results("native.Text", {"items": [_reference(uri)]})
        body["input_form"] = {"my_domain.summarize": {"fields": [prose_input]}}
        results = RunResults.model_validate(body)

        node = main_stuff_node(results)

        assert isinstance(node, ListItem)
        _Boundary(mocker, client, body={}, objects={uri: b"One of many."})
        loaded = asyncio.run(load_stored_texts(client, results))
        assert loaded.main_stuff == {"items": [{"text": "One of many."}]}

    def test_download_artifacts_walks_the_working_memory_beside_a_top_level_input_field(self, mocker: MockerFixture, tmp_path: Path) -> None:
        client = _client()
        text_uri = _stored_uri("dl")
        boundary = _Boundary(mocker, client, body={}, objects={text_uri: b"Summary.", _DOCUMENT_URI: b"%PDF-1.4"})
        results = RunResults.model_validate(_results_with_document_input(_reference(text_uri)))

        verdict = asyncio.run(
            download_artifacts(client, dir_path=tmp_path, results=results, options=DownloadArtifactsOptions(scope=ArtifactScope.WORKING_MEMORY))
        )

        assert boundary.resolved == [[text_uri, _DOCUMENT_URI]]
        assert verdict.all_saved is True
        assert [(artifact.uri, artifact.kind, artifact.found_at) for artifact in verdict.artifacts] == [
            (text_uri, DownloadedKind.TEXT, ["$.root.summary.content.url"]),
            (_DOCUMENT_URI, DownloadedKind.FILE, ["$.root.doc.content.url"]),
        ]
        assert verdict.saved_paths == [str(tmp_path / "root-summary-content.txt"), str(tmp_path / "root-doc-content.pdf")]

    # ── the result readers load by default ───────────────────────────

    def test_get_run_result_loads_a_stored_text(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("a")
        boundary = _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE), objects={uri: "Héllo, long text.".encode()})

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID)))

        assert result.main_stuff == {"text": "Héllo, long text."}
        assert boundary.resolved == [[uri]]
        assert len(boundary.fetched) == 1

    def test_load_stored_texts_false_returns_the_wire_shape(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("b")
        boundary = _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE))

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID, load_stored_texts=False)))

        assert result.main_stuff == _reference(uri)
        assert boundary.resolved == []

    def test_wait_for_result_loads_and_honours_the_opt_out(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("c")
        body = _results("native.Text", _reference(uri), _TEXT_NODE)
        _Boundary(mocker, client, body=body, objects={uri: b"Waited."})
        options = WaitForResultOptions(timeout_seconds=5)

        loaded = asyncio.run(client.wait_for_result(_RUN_ID, options))
        wire = asyncio.run(client.wait_for_result(_RUN_ID, options, load_stored_texts=False))

        assert loaded.main_stuff == {"text": "Waited."}
        assert wire.main_stuff == _reference(uri)

    def test_wait_for_result_deadline_covers_stored_text_load(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("w1")
        _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE), objects={uri: b"never read"})

        async def _stall(request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(30)
            return httpx.Response(200, content=b"too late", request=request)

        def _stalling_store(timeout_seconds: float) -> httpx.AsyncClient:
            return httpx.AsyncClient(transport=httpx.MockTransport(_stall), timeout=httpx.Timeout(timeout_seconds))

        mocker.patch("pipelex_sdk.artifacts._new_storage_client", _stalling_store)
        started = time.monotonic()

        with pytest.raises(RunTimeoutError) as exc_info:
            asyncio.run(client.wait_for_result(_RUN_ID, WaitForResultOptions(timeout_seconds=0.2)))

        assert time.monotonic() - started < 2
        assert exc_info.value.run_id == _RUN_ID
        assert exc_info.value.timeout_seconds == 0.2
        assert f"Run {_RUN_ID} completed, but its stored texts did not load within 0.2s" in str(exc_info.value)

    def test_blocking_fallback_keeps_wire_results_when_load_fails(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("b1")
        reference = _reference(uri)
        execute_body = {
            "pipeline_run_id": _RUN_ID,
            "main_stuff_name": "summary",
            "pipe_output": {
                "working_memory": {"root": {"summary": {"concept": "native.Text", "content": reference}}, "aliases": {"main_stuff": "summary"}},
                "pipeline_run_id": _RUN_ID,
            },
        }
        paths: list[str] = []

        async def _bare_runner(method: str, url: str, **_kwargs: Any) -> httpx.Response:
            path = urlsplit(url).path
            paths.append(path)
            request = httpx.Request(method, url)
            if path == "/v1/version":
                return httpx.Response(200, json={"protocol_version": "0.6.0", "runner_version": "9.9.9"}, request=request)
            if path == "/v1/start":
                return httpx.Response(404, json={"detail": "Not Found"}, request=request)
            if path == "/v1/execute":
                return httpx.Response(200, json=execute_body, request=request)
            if path == "/v1/resolve-storage-url/bulk":
                return httpx.Response(404, json={"detail": "Not Found"}, request=request)
            msg = f"unexpected request {method} {url}"
            raise AssertionError(msg)

        mocker.patch.object(client, "_send", mocker.AsyncMock(side_effect=_bare_runner))

        with pytest.raises(StoredTextLoadError) as exc_info:
            asyncio.run(client.start_and_wait(pipe_code="p", files={"main.mthds": "x"}))

        assert paths == ["/v1/version", "/v1/start", "/v1/execute", "/v1/resolve-storage-url/bulk"]
        assert exc_info.value.reason == "resolve_failed"
        assert exc_info.value.wire_results is not None
        assert exc_info.value.wire_results.main_stuff == reference
        assert exc_info.value.wire_results.pipeline_run_id == _RUN_ID

    def test_keeps_an_html_css_class_and_parses_a_json_object(self, mocker: MockerFixture) -> None:
        client = _client()
        html_uri = _stored_uri("h", "html")
        json_uri = _stored_uri("j", "json")
        node = {
            "kind": "object",
            "concept_ref": "my_domain.Report",
            "required": True,
            "fields": [
                {"kind": "prose", "name": "page", "concept_ref": "native.Html", "required": True},
                {"kind": "unknown", "name": "data", "concept_ref": "native.JSON", "required": True},
            ],
        }
        main_stuff = {
            "page": {**_reference(html_uri, mime_type="text/html"), "css_class": "report"},
            "data": _reference(json_uri, mime_type="application/json"),
        }
        objects = {html_uri: b"<p>Hi</p>", json_uri: b'{"count": 3, "tags": ["a"]}'}
        _Boundary(mocker, client, body=_results("my_domain.Report", main_stuff, node), objects=objects)

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID)))

        assert result.main_stuff == {"page": {"inner_html": "<p>Hi</p>", "css_class": "report"}, "data": {"json_obj": {"count": 3, "tags": ["a"]}}}

    def test_loads_a_concept_refining_a_native_and_a_plural_page_from_the_native_shape(self, mocker: MockerFixture) -> None:
        client = _client()
        memo_uri = _stored_uri("m")
        memo = {"kind": "prose", "concept_ref": "legal.Memo", "refines": ["native.Text"], "required": True}
        _Boundary(mocker, client, body=_results("legal.Memo", _reference(memo_uri), memo), objects={memo_uri: b"A memo."})
        assert _completed(asyncio.run(client.get_run_result(_RUN_ID))).main_stuff == {"text": "A memo."}

        page_client = _client()
        page_uri = _stored_uri("p")
        page: dict[str, Any] = {"text_and_images": {"text": _reference(page_uri), "images": []}, "page_view": None}
        _Boundary(mocker, page_client, body=_results("native.Page", {"items": [page]}), objects={page_uri: b"Page one."})

        result = _completed(asyncio.run(page_client.get_run_result(_RUN_ID)))

        assert result.main_stuff == {"items": [{"text_and_images": {"text": {"text": "Page one."}, "images": []}, "page_view": None}]}

    def test_batches_the_resolve_route_past_its_bound(self, mocker: MockerFixture) -> None:
        client = _client()
        count = BULK_RESOLVE_MAX_URIS + 30
        uris = [_stored_uri(f"n{index_uri}") for index_uri in range(count)]
        list_node = {"kind": "list", "concept_ref": "native.Text", "required": True, "item": _TEXT_NODE}
        body = _results("native.Text", {"items": [_reference(uri) for uri in uris]}, list_node)
        boundary = _Boundary(mocker, client, body=body, objects={uri: uri.encode() for uri in uris})

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID)))

        assert [len(batch) for batch in boundary.resolved] == [BULK_RESOLVE_MAX_URIS, 30]
        assert result.main_stuff == {"items": [{"text": uri} for uri in uris]}

    def test_a_narrowed_read_reads_the_concepts_beside_it_and_changes_only_main_stuff(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("q")
        boundary = _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE), objects={uri: b"Narrow."})

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID, artifacts=[RunArtifact.MAIN_STUFF])))

        assert boundary.reads == ["main_stuff", "input_form,output_form,working_memory"]
        assert result.main_stuff == {"text": "Narrow."}
        assert result.carries(RunArtifact.WORKING_MEMORY) is False

    def test_narrowed_read_of_an_image_output_reads_once(self, mocker: MockerFixture) -> None:
        client = _client()
        picture = f"{_SCOPE}/0f0f.png"
        image = {"url": picture, "mime_type": "image/png", "public_url": "https://cdn.example/0f0f.png"}
        image_node = {"kind": "image", "concept_ref": "native.Image", "required": True}
        boundary = _Boundary(mocker, client, body=_results("native.Image", image, image_node))

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID, artifacts=[RunArtifact.MAIN_STUFF])))

        assert boundary.reads == ["main_stuff"]
        assert boundary.resolved == []
        assert result.main_stuff == image

    def test_a_narrowed_read_with_nothing_to_load_reads_nothing_more(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(mocker, client, body=_results("native.Text", {"text": "Inline."}, _TEXT_NODE))

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID, artifacts=[RunArtifact.MAIN_STUFF])))

        assert boundary.reads == ["main_stuff"]
        assert result.main_stuff == {"text": "Inline."}

    # ── failures ─────────────────────────────────────────────────────

    def test_bytes_that_are_not_utf8_name_the_text(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("r")
        _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE), objects={uri: b"\xff\xfe\xfa"})

        with pytest.raises(StoredTextLoadError) as exc_info:
            asyncio.run(client.get_run_result(_RUN_ID))

        assert exc_info.value.reason == "not_utf8"
        assert exc_info.value.path == "$"
        assert exc_info.value.uri == uri

    def test_a_resolve_refusal_names_where_the_text_sits(self, mocker: MockerFixture) -> None:
        client = _client()
        allowed = _stored_uri("s1")
        refused = _stored_uri("s2")
        list_node = {"kind": "list", "concept_ref": "native.Text", "required": True, "item": _TEXT_NODE}
        refusal = {
            "uri": refused,
            "url": None,
            "expires_at": None,
            "content_type": None,
            "error": {"code": "pipelex.org.mismatch", "detail": "another organization", "params": {"reference": "storage_uri"}},
        }
        _Boundary(
            mocker,
            client,
            body=_results("native.Text", {"items": [_reference(allowed), _reference(refused)]}, list_node),
            objects={allowed: b"ok"},
            refusals={refused: refusal},
        )

        with pytest.raises(StoredTextLoadError) as exc_info:
            asyncio.run(client.get_run_result(_RUN_ID))

        assert exc_info.value.reason == "pipelex.org.mismatch"
        assert exc_info.value.path == "$.items[1]"

    @pytest.mark.parametrize("code", ["pipelex.org.mismatch", "pipelex.storage.uri_invalid"])
    def test_cross_org_stored_text_reads_as_reference_not_found(self, mocker: MockerFixture, code: str) -> None:
        client = _client()
        uri = _stored_uri("x1")
        refusal = {"uri": uri, "url": None, "expires_at": None, "content_type": None, "error": {"code": code, "detail": "refused"}}
        _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE), refusals={uri: refusal})

        with pytest.raises(StoredTextLoadError) as exc_info:
            asyncio.run(client.get_run_result(_RUN_ID))

        assert exc_info.value.reason == code
        assert exc_info.value.problem.code == "input.reference_not_found"
        assert exc_info.value.wire_results is None

    def test_stored_text_at_a_foreign_url_is_refused_without_a_request(self, mocker: MockerFixture) -> None:
        client = _client()
        foreign = "https://10.0.0.5/admin"
        boundary = _Boundary(mocker, client, body=_results("native.Text", {"url": foreign}, _TEXT_NODE))

        with pytest.raises(StoredTextLoadError) as exc_info:
            asyncio.run(client.get_run_result(_RUN_ID))

        assert exc_info.value.reason == "unsupported_url"
        assert exc_info.value.path == "$"
        assert exc_info.value.uri == foreign
        assert exc_info.value.problem.code == "client.link_refused"
        assert boundary.reads == [None]
        assert boundary.resolved == []
        assert boundary.fetched == []
        # Turned off, the reader hands the reference back as written, still without reading it.
        wire = _completed(asyncio.run(client.get_run_result(_RUN_ID, load_stored_texts=False)))
        assert wire.main_stuff == {"url": foreign}
        assert boundary.fetched == []

    def test_a_resolve_route_failing_as_a_whole_names_the_first_text(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("x2")
        boundary = _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE))
        send = boundary._send

        async def _bulk_missing(method: str, url: str, **kwargs: Any) -> httpx.Response:
            if urlsplit(url).path == "/v1/resolve-storage-url/bulk":
                return httpx.Response(404, json={"detail": "Not Found"}, request=httpx.Request(method, url))
            return await send(method, url, **kwargs)

        mocker.patch.object(client, "_send", mocker.AsyncMock(side_effect=_bulk_missing))

        with pytest.raises(StoredTextLoadError) as exc_info:
            asyncio.run(client.get_run_result(_RUN_ID))

        assert exc_info.value.reason == "resolve_failed"
        assert exc_info.value.status == 404
        assert exc_info.value.path == "$"
        assert exc_info.value.uri == uri

    def test_a_missing_object_is_not_found(self, mocker: MockerFixture) -> None:
        client = _client()
        _Boundary(mocker, client, body=_results("native.Text", _reference(_stored_uri("t")), _TEXT_NODE))

        with pytest.raises(StoredTextLoadError) as exc_info:
            asyncio.run(client.get_run_result(_RUN_ID))

        assert exc_info.value.reason == "not_found"

    # ── load_stored_texts on a result in hand ────────────────────────

    def test_loads_a_wire_result_and_never_changes_the_one_passed_in(self, mocker: MockerFixture) -> None:
        client = _client()
        uri = _stored_uri("u")
        _Boundary(mocker, client, body=_results("native.Text", _reference(uri), _TEXT_NODE), objects={uri: b"Later."})
        wire = _completed(asyncio.run(client.get_run_result(_RUN_ID, load_stored_texts=False)))

        loaded = asyncio.run(load_stored_texts(client, wire))

        assert loaded.main_stuff == {"text": "Later."}
        assert wire.main_stuff == _reference(uri)

    def test_decodes_a_data_url_without_any_request(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(mocker, client, body={})
        data_url = "data:text/plain;base64," + base64.b64encode(b"Inline bytes.").decode()
        wire = RunResults.model_validate(_results("native.Text", {"url": data_url}))

        loaded = asyncio.run(load_stored_texts(client, wire))

        assert loaded.main_stuff == {"text": "Inline bytes."}
        assert boundary.resolved == []

    def test_returns_a_result_whose_concepts_are_unknown_as_it_is(self) -> None:
        wire = RunResults.model_validate({"pipeline_run_id": _RUN_ID, "main_stuff": _reference(_stored_uri("v"))})
        assert asyncio.run(load_stored_texts(_client(), wire)) is wire

    # ── the walkers tell stored texts from files ─────────────────────

    def test_counts_a_document_typed_text_plain_as_a_file_and_a_stored_text_as_none(self) -> None:
        text_uri = _stored_uri("w")
        notes_uri = f"{_SCOPE}/notes.txt"
        value = {"summary": _reference(text_uri), "notes": {"url": notes_uri, "mime_type": "text/plain", "filename": "notes.txt"}}
        node = _NODE.validate_python(_DOSSIER_NODE)

        assert collect_artifacts(value, node) == [notes_uri]
        assert [location.found_at for location in locate_artifacts(value, node)] == [["$.notes.url"]]
        assert collect_artifacts(value) == [text_uri, notes_uri]

        references = locate_stored_references(value, node)
        assert [location.uri for location in references.files] == [notes_uri]
        assert references.texts == [
            StoredTextLocation(
                uri=text_uri, found_at=["$.summary.url"], kind=StoredTextKind.TEXT, size=4096, mime_type="text/plain", preview="The start…"
            )
        ]
        assert [location.uri for location in locate_stored_references(value).files] == [text_uri, notes_uri]

    def test_names_a_saved_stored_text_by_its_mime_type(self) -> None:
        location = StoredTextLocation(uri=_stored_uri("x", "bin"), found_at=["$.summary.url"], kind=StoredTextKind.TEXT, mime_type="text/markdown")
        assert artifact_filename(location, None, ArtifactScope.MAIN_STUFF) == "summary.md"
        assert artifact_filename(location.model_copy(update={"mime_type": None}), None, ArtifactScope.MAIN_STUFF) == "summary.txt"

    def test_download_artifacts_saves_a_stored_text_as_a_text_file(self, mocker: MockerFixture, tmp_path: Path) -> None:
        client = _client()
        markdown_uri = _stored_uri("y", "bin")
        notes_uri = f"{_SCOPE}/notes.txt"
        main_stuff = {
            "summary": {"url": markdown_uri, "size": 8, "mime_type": "text/markdown", "preview": "# Title"},
            "notes": {"url": notes_uri, "mime_type": "text/plain", "filename": "notes.txt"},
        }
        boundary = _Boundary(mocker, client, body={}, objects={markdown_uri: b"# Title\n", notes_uri: b"plain notes"})
        results = RunResults.model_validate(_results("my_domain.Dossier", main_stuff, _DOSSIER_NODE))

        verdict = asyncio.run(download_artifacts(client, dir_path=tmp_path, results=results))

        assert boundary.resolved == [[markdown_uri, notes_uri]]
        assert verdict.all_saved is True
        assert [(artifact.kind, artifact.found_at, artifact.content_type, artifact.size) for artifact in verdict.artifacts] == [
            (DownloadedKind.TEXT, ["$.summary.url"], "text/markdown", 8),
            (DownloadedKind.FILE, ["$.notes.url"], "text/plain", 11),
        ]
        assert verdict.saved_paths == [str(tmp_path / "summary.md"), str(tmp_path / "notes.txt")]
        assert (tmp_path / "summary.md").read_bytes() == b"# Title\n"

    def test_download_by_run_id_reads_the_concepts_only_beside_a_stored_text(self, mocker: MockerFixture, tmp_path: Path) -> None:
        client = _client()
        text_uri = _stored_uri("z", "md")
        notes_uri = f"{_SCOPE}/notes.txt"
        main_stuff = {
            "summary": {"url": text_uri, "size": 8, "mime_type": "text/markdown", "preview": "# Title"},
            "notes": {"url": notes_uri, "mime_type": "text/plain", "filename": "notes.txt"},
        }
        body = _results("my_domain.Dossier", main_stuff, _DOSSIER_NODE)
        boundary = _Boundary(mocker, client, body=body, objects={text_uri: b"# Title\n", notes_uri: b"plain notes"})

        verdict = asyncio.run(download_artifacts(client, dir_path=tmp_path, run_id=_RUN_ID))

        assert boundary.reads == ["main_stuff", "input_form,output_form,working_memory"]
        assert [(artifact.kind, artifact.found_at) for artifact in verdict.artifacts] == [
            (DownloadedKind.TEXT, ["$.summary.url"]),
            (DownloadedKind.FILE, ["$.notes.url"]),
        ]
