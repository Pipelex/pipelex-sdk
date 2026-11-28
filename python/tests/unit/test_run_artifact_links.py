"""Result artifacts handed back by reference — `RunResults.artifact_links`.

When inline they would take the results body past the API Gateway's limit, the platform answers each of the largest
artifacts as `null` beside a signed link to its stored file. The result readers follow those links by default, before
the main-stuff check and the stored-text load; `follow_artifact_links=False` hands them back untouched, for a caller
that passes the link on. The boundary is mocked per URL: the results route, the bulk resolve route and the object store.
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from urllib.parse import parse_qs, quote, unquote, urlsplit

import httpx
import pytest
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ArtifactFetchError, MissingMainStuffError, RequestArgumentError
from pipelex_sdk.run_artifact_links import RUN_ARTIFACT_UNREADABLE, follow_artifact_links, parse_run_artifact
from pipelex_sdk.runs import RunArtifact, RunArtifactLink, RunResultCompleted, RunResults, WaitForResultOptions

_BASE_URL = "http://localhost:8081"
_RUN_ID = "run-referenced"
_STORE = "https://store.example"
_SIGNATURE = "X-Amz-Signature=deadbeef"
_STORED_TEXT = "pipelex-storage://org/method/run-referenced/generated/a/value.txt"

_GRAPH_TEXT = '{"meta":{"mode":"live"},"nodes":[{"id":"n1","cost":12345678901234567890}]}'
_USAGE_ENVELOPE: dict[str, Any] = {"tokens_usages": [], "usage_assembly_error": "usage assembly broke"}
_MEMORY: dict[str, Any] = {
    "root": {"summary": {"concept": "native.Text", "content": {"url": _STORED_TEXT}}},
    "aliases": {"main_stuff": "summary"},
}

#: The stored files of `_referenced_body`, written as the runner writes them.
_REFERENCED_FILES: dict[str, str] = {
    "main_stuff.json": json.dumps({"text": "Short."}),
    "graphspec.json": _GRAPH_TEXT,
    "tokens_usages.json": json.dumps(_USAGE_ENVELOPE),
}


def _link_to(file_name: str) -> dict[str, str]:
    expires_at = (datetime.now(UTC) + timedelta(minutes=15)).isoformat()
    return {"url": f"{_STORE}/results/{file_name}?{_SIGNATURE}", "expires_at": expires_at}


def _referenced_body() -> dict[str, Any]:
    """A body that handed `main_stuff`, `graph_spec` and the usage envelope back by reference."""
    return {
        "pipeline_run_id": _RUN_ID,
        "main_stuff": None,
        "working_memory": {"root": {"summary": {"concept": "native.Text", "content": {"text": "Short."}}}, "aliases": {"main_stuff": "summary"}},
        "graph_spec": None,
        "pipe_io_contracts": None,
        "input_form": None,
        "output_form": None,
        "tokens_usages": None,
        "usage_assembly_error": None,
        "artifact_links": {
            "main_stuff": _link_to("main_stuff.json"),
            "graph_spec": _link_to("graphspec.json"),
            "tokens_usages": _link_to("tokens_usages.json"),
        },
    }


def _referenced_memory_body() -> dict[str, Any]:
    """A body whose main stuff is a stored text and whose working memory, which names its concept, is referenced."""
    return {
        "pipeline_run_id": _RUN_ID,
        "main_stuff": {"url": _STORED_TEXT, "size": 12, "mime_type": "text/plain", "preview": "A long"},
        "working_memory": None,
        "output_form": {},
        "input_form": {},
        "artifact_links": {"working_memory": _link_to("working_memory.json")},
    }


class _Boundary:
    """The mocked API and object store, and what each was asked."""

    def __init__(
        self,
        mocker: MockerFixture,
        client: PipelexAPIClient,
        *,
        body: dict[str, Any],
        files: dict[str, str] | None = None,
        texts: dict[str, str] | None = None,
    ) -> None:
        self.body = body
        self.files = files or {}
        self.texts = texts or {}
        self.reads: list[str | None] = []
        self.fetched: list[str] = []
        mocker.patch.object(client, "_send", mocker.AsyncMock(side_effect=self._send))
        mocker.patch("pipelex_sdk.artifacts._new_storage_client", self._storage_client)

    async def _send(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        parts = urlsplit(url)
        request = httpx.Request(method, url)
        if parts.path == f"/v1/runs/{_RUN_ID}/results":
            self.reads.append(parse_qs(parts.query).get("artifacts", [None])[0])
            return httpx.Response(200, json=self.body, request=request)
        if parts.path == "/v1/resolve-storage-url/bulk":
            uris: list[str] = json.loads(kwargs["content"])["uris"]
            items = [
                {
                    "uri": uri,
                    "url": f"{_STORE}/texts/{quote(uri, safe='')}",
                    "expires_at": "2099-01-01T00:00:00Z",
                    "content_type": None,
                    "error": None,
                }
                for uri in uris
            ]
            return httpx.Response(200, json={"items": items}, request=request)
        msg = f"unexpected request {method} {url}"
        raise AssertionError(msg)

    def _store(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.fetched.append(path)
        if path.startswith("/texts/"):
            text = self.texts.get(unquote(path.removeprefix("/texts/")))
            return httpx.Response(404) if text is None else httpx.Response(200, content=text.encode())
        content = self.files.get(path.removeprefix("/results/"))
        return httpx.Response(403) if content is None else httpx.Response(200, content=content.encode())

    def _storage_client(self, timeout_seconds: float) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self._store), timeout=httpx.Timeout(timeout_seconds), follow_redirects=False)


def _client() -> PipelexAPIClient:
    return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)


def _completed(state: Any) -> RunResults:
    assert isinstance(state, RunResultCompleted)
    return state.result


class TestRunArtifactLinks:
    # ── parse_run_artifact ───────────────────────────────────────────

    def test_reads_an_artifact_exactly_into_its_own_field(self) -> None:
        assert parse_run_artifact(RunArtifact.GRAPH_SPEC, _GRAPH_TEXT.encode()) == {
            "graph_spec": {"meta": {"mode": "live"}, "nodes": [{"id": "n1", "cost": 12345678901234567890}]}
        }

    @pytest.mark.parametrize(
        ("content", "expected"),
        [
            pytest.param(json.dumps(_USAGE_ENVELOPE), {"tokens_usages": [], "usage_assembly_error": "usage assembly broke"}, id="envelope"),
            pytest.param("{}", {"tokens_usages": None, "usage_assembly_error": None}, id="empty_envelope"),
        ],
    )
    def test_unpacks_the_usage_envelope_onto_both_usage_fields(self, content: str, expected: dict[str, Any]) -> None:
        assert parse_run_artifact(RunArtifact.TOKENS_USAGES, content) == expected

    @pytest.mark.parametrize(
        ("artifact", "content"),
        [
            pytest.param(RunArtifact.MAIN_STUFF, "<html>", id="not_json"),
            pytest.param(RunArtifact.MAIN_STUFF, b"\xff\xfe", id="not_utf8"),
            pytest.param(RunArtifact.TOKENS_USAGES, "[]", id="usage_not_an_envelope"),
        ],
    )
    def test_refuses_a_file_that_is_not_the_artifact(self, artifact: RunArtifact, content: bytes | str) -> None:
        with pytest.raises(ArtifactFetchError) as exc_info:
            parse_run_artifact(artifact, content)
        assert exc_info.value.reason == RUN_ARTIFACT_UNREADABLE
        assert exc_info.value.uri == f"artifact_links.{artifact}"
        assert exc_info.value.problem.code == "client.response_unreadable"

    def test_refuses_an_unknown_artifact_name(self) -> None:
        with pytest.raises(RequestArgumentError):
            parse_run_artifact(cast("RunArtifact", "graph"), "{}")

    # ── the readers follow by default ────────────────────────────────

    def test_fills_every_referenced_field_from_its_stored_file_and_drops_the_links(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(mocker, client, body=_referenced_body(), files=_REFERENCED_FILES)

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID)))

        assert result.main_stuff == {"text": "Short."}
        assert result.graph_spec == {"meta": {"mode": "live"}, "nodes": [{"id": "n1", "cost": 12345678901234567890}]}
        assert result.tokens_usages == []
        assert result.usage_assembly_error == "usage assembly broke"
        assert result.artifact_links is None
        assert sorted(boundary.fetched) == ["/results/graphspec.json", "/results/main_stuff.json", "/results/tokens_usages.json"]

    def test_follows_through_wait_for_result_a_referenced_memory_telling_the_load_what_is_a_text(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(
            mocker,
            client,
            body=_referenced_memory_body(),
            files={"working_memory.json": json.dumps(_MEMORY)},
            texts={_STORED_TEXT: "A long text."},
        )

        result = asyncio.run(client.wait_for_result(_RUN_ID, WaitForResultOptions(interval_seconds=0.01)))

        assert result.main_stuff == {"text": "A long text."}
        assert result.working_memory is not None
        assert result.working_memory.aliases == {"main_stuff": "summary"}
        assert result.artifact_links is None
        # One results read: no `concepts_missing` re-poll.
        assert boundary.reads == [None]

    def test_names_the_link_never_the_signed_url_when_the_store_refuses_it(self, mocker: MockerFixture) -> None:
        client = _client()
        _Boundary(mocker, client, body=_referenced_body(), files={})

        with pytest.raises(ArtifactFetchError) as exc_info:
            asyncio.run(client.get_run_result(_RUN_ID))

        assert exc_info.value.uri.startswith("artifact_links.")
        assert exc_info.value.status == 403
        assert _SIGNATURE not in str(exc_info.value)

    # ── follow_artifact_links=False hands the links back ─────────────

    def test_does_not_fetch_and_a_referenced_main_stuff_is_no_missing_main_stuff(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(mocker, client, body=_referenced_body(), files=_REFERENCED_FILES)

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID, follow_artifact_links=False)))

        assert result.main_stuff is None
        assert result.graph_spec is None
        link = result.artifact_link(RunArtifact.MAIN_STUFF)
        assert link is not None
        assert link.url == f"{_STORE}/results/main_stuff.json?{_SIGNATURE}"
        assert sorted(result.artifact_links or {}) == ["graph_spec", "main_stuff", "tokens_usages"]
        assert boundary.fetched == []

    def test_still_raises_missing_main_stuff_for_a_null_main_stuff_with_no_link(self, mocker: MockerFixture) -> None:
        client = _client()
        body = {**_referenced_body(), "artifact_links": {"graph_spec": _link_to("graphspec.json")}}
        _Boundary(mocker, client, body=body)

        with pytest.raises(MissingMainStuffError):
            asyncio.run(client.get_run_result(_RUN_ID, follow_artifact_links=False))

    def test_returns_the_links_from_wait_for_result_too(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(mocker, client, body=_referenced_body(), files=_REFERENCED_FILES)

        result = asyncio.run(client.wait_for_result(_RUN_ID, WaitForResultOptions(interval_seconds=0.01), follow_artifact_links=False))

        assert result.main_stuff is None
        assert result.artifact_link(RunArtifact.TOKENS_USAGES) is not None
        assert boundary.fetched == []

    def test_reads_a_referenced_memory_for_the_stored_text_load_alone_keeping_its_link(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(
            mocker,
            client,
            body=_referenced_memory_body(),
            files={"working_memory.json": json.dumps(_MEMORY)},
            texts={_STORED_TEXT: "A long text."},
        )

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID, follow_artifact_links=False)))

        assert result.main_stuff == {"text": "A long text."}
        assert result.working_memory is None
        assert result.artifact_link(RunArtifact.WORKING_MEMORY) is not None
        assert "/results/working_memory.json" in boundary.fetched

    def test_follows_later_only_the_named_links_when_asked(self, mocker: MockerFixture) -> None:
        client = _client()
        boundary = _Boundary(mocker, client, body=_referenced_body(), files=_REFERENCED_FILES)
        read = _completed(asyncio.run(client.get_run_result(_RUN_ID, follow_artifact_links=False)))

        partly = asyncio.run(client.follow_artifact_links(read, artifacts=[RunArtifact.GRAPH_SPEC]))

        assert partly is not read
        assert read.graph_spec is None
        assert partly.graph_spec == {"meta": {"mode": "live"}, "nodes": [{"id": "n1", "cost": 12345678901234567890}]}
        assert sorted(partly.artifact_links or {}) == ["main_stuff", "tokens_usages"]
        assert boundary.fetched == ["/results/graphspec.json"]

        whole = asyncio.run(follow_artifact_links(client, partly))
        assert whole.main_stuff == {"text": "Short."}
        assert whole.artifact_links is None
        assert asyncio.run(follow_artifact_links(client, whole)) is whole

    def test_leaves_a_link_under_a_name_this_version_does_not_know(self, mocker: MockerFixture) -> None:
        client = _client()
        body = {**_referenced_body(), "artifact_links": {"main_stuff": _link_to("main_stuff.json"), "future_artifact": _link_to("future.json")}}
        boundary = _Boundary(mocker, client, body=body, files=_REFERENCED_FILES)

        result = _completed(asyncio.run(client.get_run_result(_RUN_ID)))

        assert result.main_stuff == {"text": "Short."}
        assert sorted(result.artifact_links or {}) == ["future_artifact"]
        assert boundary.fetched == ["/results/main_stuff.json"]

    def test_fetches_one_artifact_with_fetch_run_artifact(self, mocker: MockerFixture) -> None:
        client = _client()
        _Boundary(mocker, client, body=_referenced_body(), files=_REFERENCED_FILES)

        link = RunArtifactLink.model_validate(_link_to("tokens_usages.json"))
        fields = asyncio.run(client.fetch_run_artifact(RunArtifact.TOKENS_USAGES, link))

        assert fields == _USAGE_ENVELOPE
