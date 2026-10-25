"""Tests for the method's tree on the crate routes: a `tree` or `contents` sent as a save sends it, inline when
small and by hash otherwise, after uploading the blobs the API lacks.

The API and storage both answer through an `httpx.MockTransport` below the clients, as in
`test_client_method_trees.py`, so what each test checks is the request httpx would send. The route-level
body, the selector XOR and the budgets are pinned in `test_crate_routes.py` and `test_pipe_io_route.py`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from mthds.method_tree.models import MethodTree

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.crate_models import CodegenRequest, PipeIORequest, PipeIOValidReport, ResolveRequest
from pipelex_sdk.errors import MethodFileTransferError, MethodFileTransferOperation, MethodFileTransferReason, RequestArgumentError
from tests.unit.conftest import BASE_URL, refused_argument
from tests.unit.test_data import PipeIOBodies

if TYPE_CHECKING:
    from pathlib import Path

    from pytest_mock import MockerFixture

_STORAGE = "https://app-bucket.s3.amazonaws.com"
_SIGNATURE = "X-Amz-Signature=fixture-signature"
_MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n'

#: A file past the inline threshold on its own, so a tree holding it travels by hash.
_LARGE = b"x" * (300 * 1024)

_RESOLVE_VALID: dict[str, Any] = {"is_valid": True, "crate": {"fingerprint": "abc"}, "message": "ok"}
_CODEGEN_VALID: dict[str, Any] = {
    "is_valid": True,
    "kind": "types",
    "target": "python-pydantic",
    "crate_fingerprint": "abc",
    "engine_version": "0.89.0",
    "artifacts": [],
    "lock": "",
    "lock_filename": "codegen.lock",
    "message": "ok",
}
_ROUTE_ANSWERS: dict[str, dict[str, Any]] = {"/v1/resolve": _RESOLVE_VALID, "/v1/codegen": _CODEGEN_VALID, "/v1/pipe-io": PipeIOBodies.VALID}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _link(sha256: str) -> str:
    return f"{_STORAGE}/org_1/blobs/{sha256}?{_SIGNATURE}"


class _Api:
    """The API and its storage: the version handshake, `POST /v1/blobs/missing`, the crate routes and the uploads.

    `held` names the blobs the API already holds; `storage_status` is what storage answers an upload with.
    """

    def __init__(self, *, blob_store: bool = True, held: frozenset[str] | None = None, storage_status: int = 200) -> None:
        self.blob_store = blob_store
        self.held = held or frozenset()
        self.storage_status = storage_status
        self.requests: list[httpx.Request] = []
        self.uploads: list[httpx.Request] = []

    def api(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/v1/version":
            return httpx.Response(200, json={"protocol_version": "1", "runner_version": "0.89.0", "blob_store": self.blob_store}, request=request)
        if path == "/v1/blobs/missing":
            missing: list[dict[str, Any]] = [
                {"sha256": blob["sha256"], "size": blob["size"], "upload": {"method": "PUT", "url": _link(blob["sha256"]), "headers": {}}}
                for blob in json.loads(request.content)["blobs"]
                if blob["sha256"] not in self.held
            ]
            return httpx.Response(200, json={"missing": missing}, request=request)
        return httpx.Response(200, json=_ROUTE_ANSWERS[path], request=request)

    def storage(self, request: httpx.Request) -> httpx.Response:
        self.uploads.append(request)
        if self.storage_status >= 300:
            return httpx.Response(self.storage_status, text=f"<Error><CanonicalRequest>{request.url}</CanonicalRequest></Error>", request=request)
        return httpx.Response(200, request=request)

    def paths(self) -> list[str]:
        return [request.url.path for request in self.requests]

    def body_of(self, path: str) -> dict[str, Any]:
        (sent,) = [request for request in self.requests if request.url.path == path]
        body: dict[str, Any] = json.loads(sent.content)
        return body


def _client(api: _Api, mocker: MockerFixture) -> PipelexAPIClient:
    client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(api.api), headers={"Authorization": "Bearer test-token"})

    def storage_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(api.storage))

    mocker.patch.object(client, "_make_upload_client", side_effect=storage_client)
    return client


def _tree_dir(root: Path, contents: dict[str, bytes]) -> Path:
    for tree_path, data in contents.items():
        target = root.joinpath(*tree_path.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return root


class TestCrateRouteTrees:
    def test_a_small_tree_listed_from_a_directory_is_sent_inline(self, mocker: MockerFixture, tmp_path: Path) -> None:
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "templates/invoice.html": b"<p>{{ total }}</p>"})

        async def resolve() -> None:
            tree = await client.list_method_tree(method_dir)
            await client.resolve(ResolveRequest(tree=tree))

        asyncio.run(resolve())

        # The listing asks the handshake for the tree limits, the request asks it for the inline limit the API
        # announces, and the inline tree needs no other round trip.
        assert api.paths() == ["/v1/version", "/v1/version", "/v1/resolve"]
        assert api.body_of("/v1/resolve") == {"files": {"main.mthds": _MAIN, "templates/invoice.html": "<p>{{ total }}</p>"}}
        assert not api.uploads

    def test_a_directory_path_is_listed_when_the_request_is_sent(self, mocker: MockerFixture, tmp_path: Path) -> None:
        """A `Path` names the tree as `list_method_tree` lists it, so the run's inputs file stays out of it."""
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "inputs.json": b"{}"})

        report = asyncio.run(client.pipe_io(PipeIORequest(tree=method_dir)))

        assert isinstance(report, PipeIOValidReport)
        assert api.paths() == ["/v1/version", "/v1/pipe-io"]
        assert api.body_of("/v1/pipe-io") == {"files": {"main.mthds": _MAIN}}

    def test_a_large_tree_is_sent_by_hash_after_uploading_the_blobs_the_api_lacks(self, mocker: MockerFixture) -> None:
        main = _MAIN.encode()
        api = _Api(held=frozenset({_sha256(main)}))
        client = _client(api, mocker)

        asyncio.run(client.codegen(CodegenRequest(contents={"main.mthds": _MAIN, "data/big.txt": _LARGE}, target="python-pydantic")))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/codegen"]
        (upload,) = api.uploads
        assert str(upload.url) == _link(_sha256(_LARGE))
        assert upload.content == _LARGE
        assert api.body_of("/v1/codegen") == {
            "files": {
                "data/big.txt": {"sha256": _sha256(_LARGE), "size": len(_LARGE)},
                "main.mthds": {"sha256": _sha256(main), "size": len(main)},
            },
            "kind": "types",
            "target": "python-pydantic",
        }

    def test_a_large_tree_travels_inline_to_an_api_with_no_blob_store(self, mocker: MockerFixture) -> None:
        api = _Api(blob_store=False)
        client = _client(api, mocker)

        report = asyncio.run(client.pipe_io(PipeIORequest(contents={"main.mthds": _MAIN, "data/big.txt": _LARGE}, include_files=True)))

        assert isinstance(report, PipeIOValidReport)
        assert api.paths() == ["/v1/version", "/v1/pipe-io"]
        assert api.body_of("/v1/pipe-io") == {"files": {"data/big.txt": _LARGE.decode(), "main.mthds": _MAIN}, "include_files": True}

    def test_an_upload_storage_refuses_sends_no_request(self, mocker: MockerFixture) -> None:
        """A failed upload says the request was not sent, never that a method was not saved, and carries no link."""
        api = _Api(storage_status=403)
        client = _client(api, mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(client.resolve(ResolveRequest(contents={"data/big.txt": _LARGE})))

        error = caught.value
        assert (error.operation, error.reason, error.sha256, error.status) == (
            MethodFileTransferOperation.UPLOAD,
            MethodFileTransferReason.REFUSED,
            _sha256(_LARGE),
            403,
        )
        assert str(error).endswith("so the request was not sent.")
        assert "fixture-signature" not in str(error)
        assert "/v1/resolve" not in api.paths()

    def test_the_blob_route_is_asked_under_the_request_read_scope(self, mocker: MockerFixture) -> None:
        """The blobs go to the store the request's hash entries are read from, and the request still carries its scope."""
        api = _Api()
        client = _client(api, mocker)

        asyncio.run(client.resolve(ResolveRequest(contents={"data/big.txt": _LARGE}, read_scope="org_acme")))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/resolve"]
        (asked,) = [request for request in api.requests if request.url.path == "/v1/blobs/missing"]
        assert dict(asked.url.params) == {"read_scope": "org_acme"}
        assert api.body_of("/v1/resolve") == {
            "files": {"data/big.txt": {"sha256": _sha256(_LARGE), "size": len(_LARGE)}},
            "read_scope": "org_acme",
        }

    def test_the_scope_does_not_outlive_its_request(self, mocker: MockerFixture) -> None:
        """A request with no `read_scope`, after one with a scope, asks the blob route with no query."""
        api = _Api()
        client = _client(api, mocker)

        async def both() -> None:
            await client.resolve(ResolveRequest(contents={"data/big.txt": _LARGE}, read_scope="org_acme"))
            await client.resolve(ResolveRequest(contents={"data/other.txt": _LARGE + b"y"}))

        asyncio.run(both())

        asked = [request for request in api.requests if request.url.path == "/v1/blobs/missing"]
        assert [dict(request.url.params) for request in asked] == [{"read_scope": "org_acme"}, {}]

    @pytest.mark.parametrize("call", ["resolve", "codegen", "pipe_io"])
    def test_a_tree_holding_no_file_is_refused_before_any_request(self, mocker: MockerFixture, call: str) -> None:
        api = _Api()
        client = _client(api, mocker)
        empty = MethodTree(files=[], digest=f"sha256:{'0' * 64}")
        requests: dict[str, Any] = {
            "resolve": (client.resolve, ResolveRequest(tree=empty)),
            "codegen": (client.codegen, CodegenRequest(tree=empty, target="python-pydantic")),
            "pipe_io": (client.pipe_io, PipeIORequest(tree=empty)),
        }
        route, request = requests[call]

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(route(request))

        assert str(caught.value) == f"{call}() got a tree holding no file, and a method tree holds at least one."
        assert refused_argument(caught.value) == {"argument": "tree", "reason": "empty"}
        assert not api.requests
