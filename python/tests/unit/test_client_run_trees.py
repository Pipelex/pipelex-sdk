"""Tests for the method's tree on the run routes and `validate`: a `tree` (listed, or the `Path` of a directory)
or `contents` sent inline when small and by hash otherwise, after uploading the blobs the API lacks.

The API and storage both answer through an `httpx.MockTransport` below the clients, as in
`test_crate_route_trees.py`, so what each test checks is the request httpx would send. The run bodies, the
refusals and the selector pairings are pinned in `test_client_run_files.py` and `test_client_validate.py`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import TYPE_CHECKING, Any

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import MethodFileTransferError, MethodFileTransferOperation, MethodFileTransferReason, RequestArgumentError
from pipelex_sdk.validation_models import PipelexValidationReport
from tests.unit.conftest import BASE_URL, refused_argument

if TYPE_CHECKING:
    from pathlib import Path

    from mthds.method_tree.models import MethodTree
    from pytest_mock import MockerFixture

_STORAGE = "https://app-bucket.s3.amazonaws.com"
_SIGNATURE = "X-Amz-Signature=fixture-signature"
_MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n'
_TEMPLATE = "<p>{{ total }}</p>"

#: A file past the inline threshold on its own, so a tree holding it travels by hash.
_LARGE = b"x" * (300 * 1024)

_RUN_ID = "run_1"
_START_ACK: dict[str, Any] = {"pipeline_run_id": _RUN_ID, "state": "STARTED", "created_at": "2026-10-20T09:00:00Z"}
_EXECUTE_ANSWER: dict[str, Any] = {
    "pipeline_run_id": _RUN_ID,
    "main_stuff_name": "result",
    "pipe_output": {
        "working_memory": {"root": {"result": {"concept": "native.Text", "content": {"text": "hi"}}}, "aliases": {"main_stuff": "result"}},
        "pipeline_run_id": _RUN_ID,
    },
}
_VALID_REPORT: dict[str, Any] = {"is_valid": True, "rendered_markdown": "## ok"}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _link(sha256: str) -> str:
    return f"{_STORAGE}/org_1/blobs/{sha256}?{_SIGNATURE}"


def _by_hash(*files: tuple[str, bytes]) -> dict[str, Any]:
    return {tree_path: {"sha256": _sha256(data), "size": len(data)} for tree_path, data in files}


class _Api:
    """The API and its storage: the version handshake, `POST /v1/blobs/missing`, the run routes, `validate` and the uploads.

    `held` names the blobs the API already holds; `storage_status` is what storage answers an upload with;
    `start_route` is False for a runner with no run store, whose `POST /v1/start` is an unmatched route;
    `max_inline_bytes`, when given, is announced under `limits.method_tree` of the handshake, as it is.
    """

    def __init__(
        self,
        *,
        blob_store: bool = True,
        held: frozenset[str] | None = None,
        storage_status: int = 200,
        start_route: bool = True,
        max_inline_bytes: object = None,
    ) -> None:
        self.blob_store = blob_store
        self.max_inline_bytes = max_inline_bytes
        self.held = held or frozenset()
        self.storage_status = storage_status
        self.start_route = start_route
        self.requests: list[httpx.Request] = []
        self.uploads: list[httpx.Request] = []

    def api(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        answer: httpx.Response
        match path:
            case "/v1/version":
                version: dict[str, Any] = {"protocol_version": "1", "runner_version": "0.89.0", "implementation": "pipelex-hosted"}
                version["blob_store"] = self.blob_store
                if self.max_inline_bytes is not None:
                    version["limits"] = {"method_tree": {"max_inline_bytes": self.max_inline_bytes}}
                answer = httpx.Response(200, json=version, request=request)
            case "/v1/blobs/missing":
                missing: list[dict[str, Any]] = [
                    {"sha256": blob["sha256"], "size": blob["size"], "upload": {"method": "PUT", "url": _link(blob["sha256"]), "headers": {}}}
                    for blob in json.loads(request.content)["blobs"]
                    if blob["sha256"] not in self.held
                ]
                answer = httpx.Response(200, json={"missing": missing}, request=request)
            case "/v1/start" if self.start_route:
                answer = httpx.Response(202, json=_START_ACK, request=request)
            case "/v1/start":
                answer = httpx.Response(404, json={"detail": "Not Found"}, request=request)
            case "/v1/execute":
                answer = httpx.Response(200, json=_EXECUTE_ANSWER, request=request)
            case "/v1/validate":
                answer = httpx.Response(200, json=_VALID_REPORT, request=request)
            case _:
                answer = httpx.Response(200, json={"pipeline_run_id": _RUN_ID, "main_stuff": {}}, request=request)
        return answer

    def storage(self, request: httpx.Request) -> httpx.Response:
        self.uploads.append(request)
        if self.storage_status >= 300:
            return httpx.Response(self.storage_status, text=f"<Error><CanonicalRequest>{request.url}</CanonicalRequest></Error>", request=request)
        return httpx.Response(200, request=request)

    def paths(self) -> list[str]:
        return [request.url.path for request in self.requests]

    def bodies_of(self, path: str) -> list[dict[str, Any]]:
        return [json.loads(request.content) for request in self.requests if request.url.path == path]

    def body_of(self, path: str) -> dict[str, Any]:
        (body,) = self.bodies_of(path)
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


class TestClientRunTrees:
    def test_a_directory_is_listed_and_started_inline_without_the_run_inputs(self, mocker: MockerFixture, tmp_path: Path) -> None:
        """The standard's lister decides what is sent, so a run's `inputs.json` or `inputs.toml` never is, at any depth."""
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(
            tmp_path / "method",
            {
                "main.mthds": _MAIN.encode(),
                "templates/invoice.html": _TEMPLATE.encode(),
                "inputs.json": b'{"receipt": "r.pdf"}',
                "samples/inputs.toml": b'receipt = "r.pdf"\n',
            },
        )

        ack = asyncio.run(client.start(pipe_code="review_receipt", tree=method_dir))

        assert ack.pipeline_run_id == _RUN_ID
        # The listing asks the handshake for the tree limits, and the inline tree needs no other round trip.
        assert api.paths() == ["/v1/version", "/v1/start"]
        assert api.body_of("/v1/start") == {"pipe_code": "review_receipt", "files": {"main.mthds": _MAIN, "templates/invoice.html": _TEMPLATE}}
        assert not api.uploads

    def test_a_listed_tree_is_executed_inline(self, mocker: MockerFixture, tmp_path: Path) -> None:
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode()})

        async def execute() -> None:
            tree = await client.list_method_tree(method_dir)
            await client.execute(tree=tree)

        asyncio.run(execute())

        # The listing asks the handshake for the tree limits, and the run asks it for the inline limit the API announces.
        assert api.paths() == ["/v1/version", "/v1/version", "/v1/execute"]
        assert api.body_of("/v1/execute") == {"files": {"main.mthds": _MAIN}}

    def test_a_large_directory_costs_one_handshake_for_its_listing_and_its_sending(self, mocker: MockerFixture, tmp_path: Path) -> None:
        """The base asks the handshake for a tree past the inline threshold, and is answered with the one the listing took."""
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "data/big.txt": _LARGE})

        asyncio.run(client.start(tree=method_dir))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/start"]
        assert api.body_of("/v1/start") == {"files": _by_hash(("data/big.txt", _LARGE), ("main.mthds", _MAIN.encode()))}

    @pytest.mark.parametrize("form", ["path", "listed"])
    def test_an_announced_inline_limit_below_the_default_sends_a_small_tree_by_hash(self, mocker: MockerFixture, tmp_path: Path, form: str) -> None:
        """A tree whose inline map passes the inline limit the API announces goes by hash, however far below 256 KiB it is."""
        api = _Api(max_inline_bytes=64)
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "templates/invoice.html": _TEMPLATE.encode()})

        async def execute() -> None:
            tree: Path | MethodTree = method_dir if form == "path" else await client.list_method_tree(method_dir)
            await client.execute(tree=tree)

        asyncio.run(execute())

        listing = [] if form == "path" else ["/v1/version"]
        assert api.paths() == [*listing, "/v1/version", "/v1/blobs/missing", "/v1/execute"]
        assert api.body_of("/v1/execute") == {"files": _by_hash(("main.mthds", _MAIN.encode()), ("templates/invoice.html", _TEMPLATE.encode()))}
        assert len(api.uploads) == 2

    @pytest.mark.parametrize("announced", [7 * 1024 * 1024, 0, -1, True, "64"], ids=["above-the-default", "zero", "negative", "bool", "string"])
    def test_an_inline_limit_above_the_default_or_unreadable_leaves_the_default(
        self, mocker: MockerFixture, tmp_path: Path, announced: object
    ) -> None:
        """The default is a ceiling the announcement only lowers, and an announcement that is no positive integer is not trusted."""
        api = _Api(max_inline_bytes=announced)
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "data/big.txt": _LARGE})

        asyncio.run(client.execute(tree=method_dir))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/execute"]
        assert api.body_of("/v1/execute") == {"files": _by_hash(("data/big.txt", _LARGE), ("main.mthds", _MAIN.encode()))}

    def test_small_contents_take_no_handshake_so_an_announced_inline_limit_is_not_read(self, mocker: MockerFixture) -> None:
        """`contents` keeps the default threshold alone, so a small one costs no round trip, as the command-line cases record it."""
        api = _Api(max_inline_bytes=16)
        client = _client(api, mocker)

        asyncio.run(client.execute(contents={"main.mthds": _MAIN}))

        assert api.paths() == ["/v1/execute"]
        assert api.body_of("/v1/execute") == {"files": {"main.mthds": _MAIN}}

    def test_a_string_tree_is_read_as_the_path_it_names(self, mocker: MockerFixture, tmp_path: Path) -> None:
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "inputs.json": b"{}"})
        tree: Any = str(method_dir)

        asyncio.run(client.start(tree=tree))

        assert api.paths() == ["/v1/version", "/v1/start"]
        assert api.body_of("/v1/start") == {"files": {"main.mthds": _MAIN}}

    @pytest.mark.parametrize("route", ["execute", "start", "start_and_wait", "validate"])
    @pytest.mark.parametrize(
        ("arguments", "message", "named"),
        [
            pytest.param(
                {"tree": 42},
                "takes tree as a listed method tree, a MethodTree such as list_method_tree returns, "
                "or the path of a directory or of a .mthds file, got int.",
                {"argument": "tree", "reason": "not_a_tree"},
                id="tree-int",
            ),
            pytest.param(
                {"files": [{"content": 'domain = "demo"', "source": "demo.mthds"}]},
                "takes files as the method's tree, a map from tree path to file entry, got a list.",
                {"argument": "files", "reason": "not_a_map"},
                id="files-list",
            ),
            pytest.param(
                {"contents": [("main.mthds", _MAIN)]},
                "takes contents as each file's bytes or text by tree path, got a list.",
                {"argument": "contents", "reason": "not_a_map"},
                id="contents-list",
            ),
            pytest.param(
                {"contents": {"main.mthds": 42}},
                "takes contents as each file's bytes or text by tree path, and contents['main.mthds'] holds int.",
                {"argument": "contents", "reason": "entry_mistyped"},
                id="contents-value",
            ),
        ],
    )
    def test_a_form_of_the_wrong_type_is_refused_before_any_request(
        self, mocker: MockerFixture, route: str, arguments: dict[str, Any], message: str, named: dict[str, str]
    ) -> None:
        """Refused as the caller's argument rather than failing deep in the preparation, naming none of them."""
        api = _Api()
        client = _client(api, mocker)

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(getattr(client, route)(**arguments))

        assert str(caught.value) == f"{route}() {message}"
        assert refused_argument(caught.value) == named
        assert not api.requests

    def test_the_retired_list_of_bundles_given_to_validate_is_refused_before_any_request(self, mocker: MockerFixture) -> None:
        api = _Api()
        client = _client(api, mocker)
        bundles: Any = [_MAIN]

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(client.validate(bundles))

        assert refused_argument(caught.value) == {"argument": "files", "reason": "not_a_map"}
        assert not api.requests

    def test_a_large_tree_is_started_by_hash_after_uploading_only_the_blobs_the_api_lacks(self, mocker: MockerFixture) -> None:
        main = _MAIN.encode()
        api = _Api(held=frozenset({_sha256(main)}))
        client = _client(api, mocker)

        asyncio.run(client.start(contents={"main.mthds": _MAIN, "data/big.txt": _LARGE}))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/start"]
        asked = {blob["sha256"] for blob in api.body_of("/v1/blobs/missing")["blobs"]}
        assert asked == {_sha256(main), _sha256(_LARGE)}
        (upload,) = api.uploads
        assert str(upload.url) == _link(_sha256(_LARGE))
        assert upload.content == _LARGE
        assert api.body_of("/v1/start") == {"files": _by_hash(("data/big.txt", _LARGE), ("main.mthds", main))}

    def test_a_large_tree_travels_inline_to_an_api_with_no_blob_store(self, mocker: MockerFixture) -> None:
        api = _Api(blob_store=False)
        client = _client(api, mocker)

        asyncio.run(client.execute(pipe_code="review_receipt", contents={"main.mthds": _MAIN, "data/big.txt": _LARGE}))

        assert api.paths() == ["/v1/version", "/v1/execute"]
        assert api.body_of("/v1/execute") == {"pipe_code": "review_receipt", "files": {"data/big.txt": _LARGE.decode(), "main.mthds": _MAIN}}
        assert not api.uploads

    def test_validate_sends_a_directory_as_its_files_tree(self, mocker: MockerFixture, tmp_path: Path) -> None:
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "inputs.json": b"{}"})

        report = asyncio.run(client.validate(tree=method_dir, views=["input_form"]))

        assert isinstance(report, PipelexValidationReport)
        assert api.paths() == ["/v1/version", "/v1/validate"]
        assert api.body_of("/v1/validate") == {
            "files": {"main.mthds": _MAIN},
            "allow_signatures": False,
            "render": ["markdown"],
            "views": ["input_form"],
        }

    def test_validate_sends_a_large_tree_by_hash(self, mocker: MockerFixture) -> None:
        api = _Api()
        client = _client(api, mocker)

        asyncio.run(client.validate(contents={"main.mthds": _MAIN, "data/big.txt": _LARGE}, allow_signatures=True))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/validate"]
        assert len(api.uploads) == 2
        assert api.body_of("/v1/validate") == {
            "files": _by_hash(("data/big.txt", _LARGE), ("main.mthds", _MAIN.encode())),
            "allow_signatures": True,
            "render": ["markdown"],
        }

    def test_start_and_wait_sends_the_prepared_tree_to_the_start(self, mocker: MockerFixture) -> None:
        api = _Api()
        client = _client(api, mocker)

        asyncio.run(client.start_and_wait(contents={"data/big.txt": _LARGE}))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/version", "/v1/start", f"/v1/runs/{_RUN_ID}/results"]
        assert api.body_of("/v1/start") == {"files": _by_hash(("data/big.txt", _LARGE))}

    def test_start_and_wait_prepares_the_tree_once_for_the_blocking_fallback(self, mocker: MockerFixture) -> None:
        """A runner with no run store refuses the start, and the blocking execute sends the same map, uploading nothing again."""
        api = _Api(start_route=False)
        client = _client(api, mocker)

        asyncio.run(client.start_and_wait(contents={"data/big.txt": _LARGE}))

        assert api.paths() == ["/v1/version", "/v1/blobs/missing", "/v1/version", "/v1/start", "/v1/execute"]
        assert len(api.uploads) == 1
        assert api.body_of("/v1/start") == api.body_of("/v1/execute") == {"files": _by_hash(("data/big.txt", _LARGE))}

    @pytest.mark.parametrize("route", ["start", "execute", "start_and_wait"])
    def test_an_upload_storage_refuses_starts_no_run(self, mocker: MockerFixture, route: str) -> None:
        """A failed upload says the run was not started, carries no link, and sends neither run route."""
        api = _Api(storage_status=403)
        client = _client(api, mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(getattr(client, route)(contents={"data/big.txt": _LARGE}))

        error = caught.value
        assert (error.operation, error.reason, error.sha256, error.status) == (
            MethodFileTransferOperation.UPLOAD,
            MethodFileTransferReason.REFUSED,
            _sha256(_LARGE),
            403,
        )
        assert str(error).endswith("so the run was not started.")
        assert "fixture-signature" not in str(error)
        assert not error.problem.outcome_is_unknown
        assert api.paths() == ["/v1/version", "/v1/blobs/missing"]

    def test_an_upload_storage_refuses_sends_no_validation(self, mocker: MockerFixture) -> None:
        api = _Api(storage_status=403)
        client = _client(api, mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(client.validate(contents={"data/big.txt": _LARGE}))

        assert str(caught.value).endswith("so the request was not sent.")
        assert "/v1/validate" not in api.paths()

    @pytest.mark.parametrize("route", ["start", "execute", "start_and_wait", "validate"])
    def test_a_refused_pairing_lists_and_uploads_nothing(self, mocker: MockerFixture, tmp_path: Path, route: str) -> None:
        """The sources are checked before the tree is listed or prepared, so a refusal costs no request."""
        api = _Api()
        client = _client(api, mocker)
        method_dir = _tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode()})

        with pytest.raises(RequestArgumentError, match="method_ref"):
            asyncio.run(getattr(client, route)(tree=method_dir, method_ref="github.com/Pipelex/methods/documents@v0.1.0"))

        assert not api.requests
