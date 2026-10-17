"""Tests for a method's tree in the catalog: a save's `files`, `tree` and `contents`, the uploads of the blobs
the platform lacks, the deployment's tree limits, and `write_method_tree`.

The twin of `pipelex-sdk-js/tests/method-trees.test.ts`. The API and storage both answer through an
`httpx.MockTransport` below the clients, so what each test checks is the request httpx would send: the
API client's `client`, and the storage clients `_make_upload_client` and `_make_download_client` build.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from mthds.method_tree.exceptions import TreeLimitError
from mthds.method_tree.file_entry import HashFileEntry
from mthds.method_tree.models import TreeLimits

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import (
    MethodFileTransferCode,
    MethodFileTransferError,
    MethodFileTransferOperation,
    RequestArgumentError,
)
from pipelex_sdk.product_models import MethodDraftInput, MethodWriteInput, SavedMethodFile
from tests.unit.conftest import BASE_URL
from tests.unit.test_data import MethodVersionBodies

if TYPE_CHECKING:
    from pathlib import Path

    from mthds.method_tree.file_entry import FileEntry
    from pytest_mock import MockerFixture

_STORAGE = "https://app-bucket.s3.amazonaws.com"

#: The query of every link and upload target, a bearer credential no message may carry.
_SIGNATURE = "X-Amz-Signature=fixture-signature"

#: The headers every upload target names, which an upload carries exactly.
_TARGET_HEADERS = {"Content-Type": "application/octet-stream", "If-None-Match": "*"}

_MAIN = 'domain = "receipts"\nmain_pipe = "review_receipt"\n'

#: A file past the inline threshold on its own, so a tree holding it travels by hash.
_LARGE = b"x" * (300 * 1024)

#: Bytes no UTF-8 decoder takes, so an inline map carries them in Base64.
_BINARY = b"\x89PNG\r\n\x1a\n\x00\xff\xfe"

_ARGUMENT_VERDICT = ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _tree_digest(contents: dict[str, bytes]) -> str:
    listing = "".join(f"{_sha256(contents[tree_path])}  {tree_path}\n" for tree_path in sorted(contents, key=lambda path: path.encode()))
    return f"sha256:{_sha256(listing.encode())}"


def _link(sha256: str) -> str:
    return f"{_STORAGE}/org_1/blobs/{sha256}?{_SIGNATURE}"


def _listing(contents: dict[str, bytes]) -> list[SavedMethodFile]:
    return [
        SavedMethodFile(path=tree_path, sha256=_sha256(data), size=len(data), url=_link(_sha256(data)), expires_at="2026-10-08T09:15:00+00:00")
        for tree_path, data in contents.items()
    ]


class _Platform:
    """The API and its storage: the version handshake, `POST /v1/blobs/missing`, the saves, and the links.

    `held` names the blobs the organization already holds, which `POST /v1/blobs/missing` leaves out;
    `blobs` holds the bytes storage serves by SHA-256; `storage_status` is what storage answers every
    request with, and `storage_failure` a transport failure it raises instead.
    """

    def __init__(
        self,
        *,
        blob_store: bool = True,
        limits: object = None,
        held: frozenset[str] | None = None,
        extra_missing: tuple[str, ...] = (),
        blobs: dict[str, bytes] | None = None,
        storage_status: int = 200,
        storage_failure: type[httpx.TransportError] | None = None,
    ) -> None:
        self.blob_store = blob_store
        self.limits = limits
        self.held = held or frozenset()
        self.extra_missing = extra_missing
        self.blobs = blobs or {}
        self.storage_status = storage_status
        self.storage_failure = storage_failure
        self.api_requests: list[httpx.Request] = []
        self.storage_requests: list[httpx.Request] = []

    def api(self, request: httpx.Request) -> httpx.Response:
        self.api_requests.append(request)
        path = request.url.path
        if path == "/v1/version":
            version: dict[str, Any] = {"protocol_version": "1", "runner_version": "0.80.0", "blob_store": self.blob_store}
            if self.limits is not None:
                version["limits"] = self.limits
            return httpx.Response(200, json=version, request=request)
        if path == "/v1/blobs/missing":
            blobs = json.loads(request.content)["blobs"]
            missing = [
                {
                    "sha256": blob["sha256"],
                    "size": blob["size"],
                    "upload": {"method": "PUT", "url": _link(blob["sha256"]), "headers": _TARGET_HEADERS},
                }
                for blob in blobs
                if blob["sha256"] not in self.held
            ]
            missing.extend(
                {"sha256": sha256, "size": 1, "upload": {"method": "PUT", "url": _link(sha256), "headers": _TARGET_HEADERS}}
                for sha256 in self.extra_missing
            )
            return httpx.Response(200, json={"missing": missing}, request=request)
        return httpx.Response(200, json=MethodVersionBodies.METHOD, request=request)

    def storage(self, request: httpx.Request) -> httpx.Response:
        self.storage_requests.append(request)
        if self.storage_failure is not None:
            msg = "simulated storage failure"
            raise self.storage_failure(msg, request=request)
        if self.storage_status >= 300:
            # Storage's error body can echo the signed request, which no message may repeat.
            refusal = f"<Error><Code>AccessDenied</Code><CanonicalRequest>{request.url}</CanonicalRequest></Error>"
            return httpx.Response(self.storage_status, text=refusal, request=request)
        if request.method == "PUT":
            self.blobs[request.url.path.rsplit("/", 1)[-1]] = request.content
            return httpx.Response(200, request=request)
        return httpx.Response(200, content=self.blobs.get(request.url.path.rsplit("/", 1)[-1], b""), request=request)

    def sent(self, method: str, path: str) -> list[httpx.Request]:
        return [request for request in self.api_requests if request.method == method and request.url.path == path]

    def saved_files(self, method: str, path: str) -> object:
        (save,) = self.sent(method, path)
        return json.loads(save.content).get("files")


def _client(platform: _Platform, mocker: MockerFixture) -> PipelexAPIClient:
    client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(platform.api), headers={"Authorization": "Bearer test-token"})

    def storage_client() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(platform.storage))

    mocker.patch.object(client, "_make_upload_client", side_effect=storage_client)
    mocker.patch.object(client, "_make_download_client", side_effect=storage_client)
    return client


def _tree_dir(root: Path, contents: dict[str, bytes]) -> Path:
    for tree_path, data in contents.items():
        target = root.joinpath(*tree_path.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return root


def _written(root: Path) -> dict[str, bytes]:
    """Every file under `root`, by its path relative to it."""
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}


def _transfer_error(caught: pytest.ExceptionInfo[MethodFileTransferError]) -> MethodFileTransferError:
    """The error raised, checked to carry neither the link nor storage's body, in its message or as a cause."""
    error = caught.value
    assert error.__cause__ is None
    assert _SIGNATURE not in str(error)
    assert "fixture-signature" not in str(error)
    assert "AccessDenied" not in str(error)
    return error


class TestClientMethodTrees:
    # ── Saving: the three forms of a tree ─────────────────────────────

    def test_files_are_sent_as_given_with_no_round_trip(self, mocker: MockerFixture) -> None:
        platform = _Platform()
        client = _client(platform, mocker)
        files: dict[str, FileEntry] = {"main.mthds": _MAIN, "data/big.txt": HashFileEntry(sha256=_sha256(_LARGE), size=len(_LARGE))}

        asyncio.run(client.create_method(MethodWriteInput(name="Receipts", files=files)))

        assert [request.url.path for request in platform.api_requests] == ["/v1/methods"]
        assert platform.saved_files("POST", "/v1/methods") == {"main.mthds": _MAIN, "data/big.txt": {"sha256": _sha256(_LARGE), "size": len(_LARGE)}}

    def test_a_small_tree_listed_from_a_directory_is_sent_inline(self, mocker: MockerFixture, tmp_path: Path) -> None:
        platform = _Platform()
        client = _client(platform, mocker)
        tree = asyncio.run(client.list_method_tree(_tree_dir(tmp_path / "method", {"main.mthds": _MAIN.encode(), "assets/logo.png": _BINARY})))

        asyncio.run(client.create_method(MethodWriteInput(name="Receipts", tree=tree)))

        assert platform.saved_files("POST", "/v1/methods") == {
            "assets/logo.png": {"base64": base64.b64encode(_BINARY).decode()},
            "main.mthds": _MAIN,
        }
        assert not platform.sent("POST", "/v1/blobs/missing")
        assert not platform.storage_requests

    def test_a_large_tree_is_sent_by_hash_after_uploading_the_blobs_the_platform_lacks(self, mocker: MockerFixture) -> None:
        main = _MAIN.encode()
        platform = _Platform(held=frozenset({_sha256(main)}))
        client = _client(platform, mocker)

        asyncio.run(client.write_draft("mt_receipts01", MethodDraftInput(contents={"main.mthds": _MAIN, "data/big.txt": _LARGE})))

        (asked,) = platform.sent("POST", "/v1/blobs/missing")
        assert json.loads(asked.content) == {
            "blobs": [{"sha256": _sha256(_LARGE), "size": len(_LARGE)}, {"sha256": _sha256(main), "size": len(main)}],
            "digest": _tree_digest({"main.mthds": main, "data/big.txt": _LARGE}),
        }
        (upload,) = platform.storage_requests
        assert upload.method == "PUT"
        assert str(upload.url) == _link(_sha256(_LARGE))
        assert upload.content == _LARGE
        assert {name.lower() for name in upload.headers} == {"content-type", "if-none-match", "host", "content-length"}
        assert platform.saved_files("PUT", "/v1/methods/mt_receipts01/draft") == {
            "data/big.txt": {"sha256": _sha256(_LARGE), "size": len(_LARGE)},
            "main.mthds": {"sha256": _sha256(main), "size": len(main)},
        }

    def test_a_large_tree_travels_inline_to_a_platform_with_no_blob_store(self, mocker: MockerFixture) -> None:
        platform = _Platform(blob_store=False)
        client = _client(platform, mocker)

        asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"main.mthds": _MAIN, "data/big.txt": _LARGE})))

        assert platform.saved_files("POST", "/v1/methods") == {"data/big.txt": _LARGE.decode(), "main.mthds": _MAIN}
        assert not platform.sent("POST", "/v1/blobs/missing")

    def test_a_save_with_no_tree_sends_no_files(self, mocker: MockerFixture) -> None:
        platform = _Platform()
        client = _client(platform, mocker)

        asyncio.run(client.create_method(MethodWriteInput(name="Receipts", input_data={"total": 1})))

        (save,) = platform.sent("POST", "/v1/methods")
        assert json.loads(save.content) == {"name": "Receipts", "input_data": {"total": 1}}

    def test_an_explicit_none_empties_the_draft(self, mocker: MockerFixture) -> None:
        platform = _Platform()
        client = _client(platform, mocker)

        asyncio.run(client.write_draft("mt_receipts01", MethodDraftInput(files=None, expected_updated_at=MethodVersionBodies.TOKEN)))

        (save,) = platform.sent("PUT", "/v1/methods/mt_receipts01/draft")
        assert json.loads(save.content) == {"files": None, "expected_updated_at": MethodVersionBodies.TOKEN}

    @pytest.mark.parametrize(
        ("forms", "named"),
        [
            ({"files": {"main.mthds": _MAIN}, "contents": {"main.mthds": _MAIN}}, "files and contents"),
            ({"files": None, "contents": {"main.mthds": _MAIN}}, "files and contents"),
        ],
    )
    def test_two_forms_of_a_tree_are_refused_before_sending(self, mocker: MockerFixture, forms: dict[str, Any], named: str) -> None:
        platform = _Platform()
        client = _client(platform, mocker)

        with pytest.raises(RequestArgumentError, match=f"got {named}") as caught:
            asyncio.run(client.write_draft("mt_receipts01", MethodDraftInput(**forms)))

        assert error_verdict_of(caught.value) == _ARGUMENT_VERDICT
        assert not platform.api_requests

    def test_a_tree_and_contents_together_are_refused_before_sending(self, mocker: MockerFixture, tmp_path: Path) -> None:
        platform = _Platform()
        client = _client(platform, mocker)
        tree = asyncio.run(client.list_method_tree(_tree_dir(tmp_path, {"main.mthds": _MAIN.encode()})))
        platform.api_requests.clear()

        with pytest.raises(RequestArgumentError, match="got tree and contents"):
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", tree=tree, contents={"main.mthds": _MAIN})))

        assert not platform.api_requests

    @pytest.mark.parametrize(
        ("contents", "refusal"),
        [
            ({}, "holding no file"),
            ({"main.mthds": "lone \ud800 surrogate"}, "lone surrogate"),
        ],
    )
    def test_contents_no_tree_can_hold_are_refused_before_sending(self, mocker: MockerFixture, contents: dict[str, str], refusal: str) -> None:
        platform = _Platform()
        client = _client(platform, mocker)

        with pytest.raises(RequestArgumentError, match=refusal):
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents=dict(contents))))

        assert not platform.api_requests

    def test_a_blob_the_tree_does_not_hold_is_refused_as_an_argument(self, mocker: MockerFixture) -> None:
        platform = _Platform(extra_missing=("0" * 64,))
        client = _client(platform, mocker)

        with pytest.raises(RequestArgumentError, match="does not hold"):
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        assert not platform.sent("POST", "/v1/methods")

    # ── Saving: an upload that fails ──────────────────────────────────

    @pytest.mark.parametrize(
        ("status", "code", "retryable"),
        [
            (403, MethodFileTransferCode.REFUSED, False),
            (503, MethodFileTransferCode.STORAGE_ERROR, True),
        ],
    )
    def test_an_upload_storage_refuses_fails_the_save_without_the_link(
        self, mocker: MockerFixture, status: int, code: MethodFileTransferCode, retryable: bool
    ) -> None:
        platform = _Platform(storage_status=status)
        client = _client(platform, mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        error = _transfer_error(caught)
        assert (error.operation, error.code, error.sha256, error.status, error.path) == (
            MethodFileTransferOperation.UPLOAD,
            code,
            _sha256(_LARGE),
            status,
            None,
        )
        assert "app-bucket.s3.amazonaws.com" in str(error)
        # The standard's error quotes storage's body, so it is not kept as the cause.
        assert error.__cause__ is None
        assert error.__suppress_context__
        assert error_verdict_of(error) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=retryable)
        assert not platform.sent("POST", "/v1/methods")

    def test_an_upload_that_gets_no_answer_fails_the_save(self, mocker: MockerFixture) -> None:
        platform = _Platform(storage_failure=httpx.ConnectError)
        client = _client(platform, mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        error = _transfer_error(caught)
        assert (error.operation, error.code, error.sha256, error.status) == (
            MethodFileTransferOperation.UPLOAD,
            MethodFileTransferCode.UNREACHABLE,
            None,
            None,
        )
        assert error_verdict_of(error) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)
        assert not platform.sent("POST", "/v1/methods")

    def test_an_upload_storage_already_holds_counts_as_uploaded(self, mocker: MockerFixture) -> None:
        platform = _Platform(storage_status=412)
        client = _client(platform, mocker)

        asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        assert platform.saved_files("POST", "/v1/methods") == {"data/big.txt": {"sha256": _sha256(_LARGE), "size": len(_LARGE)}}

    # ── The deployment's limits ───────────────────────────────────────

    @pytest.mark.parametrize(
        ("announced", "expected"),
        [
            (
                {"method_tree": {"max_files": 1000, "max_file_bytes": 33_554_432, "max_total_bytes": 67_108_864, "max_inline_bytes": 7_340_032}},
                TreeLimits(max_files=1000, max_file_bytes=33_554_432, max_total_bytes=67_108_864),
            ),
            ({"method_tree": {"max_files": 3}}, TreeLimits(max_files=3)),
            ({"method_tree": {"max_files": True, "max_file_bytes": -1, "max_total_bytes": "64"}}, TreeLimits()),
            ({"method_tree": "unlimited"}, TreeLimits()),
            ("unlimited", TreeLimits()),
            (None, TreeLimits()),
        ],
    )
    def test_the_tree_limits_are_the_ones_the_deployment_announces(self, mocker: MockerFixture, announced: object, expected: TreeLimits) -> None:
        client = _client(_Platform(limits=announced), mocker)

        assert asyncio.run(client.method_tree_limits()) == expected

    def test_a_tree_past_an_announced_limit_is_refused_when_listed(self, mocker: MockerFixture, tmp_path: Path) -> None:
        client = _client(_Platform(limits={"method_tree": {"max_files": 1}}), mocker)
        method_dir = _tree_dir(tmp_path, {"main.mthds": _MAIN.encode(), "helper.py": b"x = 1\n"})

        with pytest.raises(TreeLimitError):
            asyncio.run(client.list_method_tree(method_dir))

    def test_a_tree_within_the_limits_lists_with_its_digest(self, mocker: MockerFixture, tmp_path: Path) -> None:
        contents = {"main.mthds": _MAIN.encode(), "lib/helper.py": b"x = 1\n"}
        client = _client(_Platform(limits={"method_tree": {"max_files": 2}}), mocker)

        tree = asyncio.run(client.list_method_tree(_tree_dir(tmp_path, contents)))

        assert [tree_file.path for tree_file in tree.files] == ["lib/helper.py", "main.mthds"]
        assert tree.digest == _tree_digest(contents)

    # ── Writing a saved tree to disk ──────────────────────────────────

    def test_a_saved_tree_is_written_at_its_tree_paths(self, mocker: MockerFixture, tmp_path: Path) -> None:
        contents = {"main.mthds": _MAIN.encode(), "lib/helper.py": b"x = 1\n", "assets/img/logo.png": _BINARY}
        platform = _Platform(blobs={_sha256(data): data for data in contents.values()})
        client = _client(platform, mocker)
        destination = tmp_path / "copies" / "receipts"

        asyncio.run(client.write_method_tree(_listing(contents), destination=destination))

        assert _written(destination) == contents
        assert [path.name for path in destination.parent.iterdir()] == ["receipts"]
        assert all("authorization" not in request.headers for request in platform.storage_requests)
        assert not platform.api_requests

    def test_an_empty_listing_writes_an_empty_directory(self, mocker: MockerFixture, tmp_path: Path) -> None:
        client = _client(_Platform(), mocker)

        asyncio.run(client.write_method_tree([], destination=tmp_path / "receipts"))

        assert (tmp_path / "receipts").is_dir()
        assert not any((tmp_path / "receipts").iterdir())

    def test_an_empty_directory_takes_the_tree(self, mocker: MockerFixture, tmp_path: Path) -> None:
        contents = {"main.mthds": _MAIN.encode()}
        client = _client(_Platform(blobs={_sha256(data): data for data in contents.values()}), mocker)
        destination = tmp_path / "receipts"
        destination.mkdir()

        asyncio.run(client.write_method_tree(_listing(contents), destination=destination))

        assert (destination / "main.mthds").read_bytes() == contents["main.mthds"]

    @pytest.mark.parametrize("occupant", ["a directory holding a file", "a file"])
    def test_an_occupied_destination_is_refused_before_downloading(self, mocker: MockerFixture, tmp_path: Path, occupant: str) -> None:
        platform = _Platform()
        client = _client(platform, mocker)
        destination = tmp_path / "receipts"
        if occupant == "a file":
            destination.write_text("mine")
        else:
            destination.mkdir()
            (destination / "notes.txt").write_text("mine")

        with pytest.raises(RequestArgumentError, match="already exists"):
            asyncio.run(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=destination))

        assert not platform.storage_requests

    @pytest.mark.parametrize(
        ("paths", "refusal"),
        [
            (["../escape.txt"], "not a tree path"),
            (["/etc/passwd"], "not a tree path"),
            (["lib//helper.py"], "not a tree path"),
            (["main.mthds", "main.mthds"], "twice"),
            (["Main.mthds", "main.mthds"], "collide"),
            (["lib", "lib/helper.py"], "collide"),
        ],
    )
    def test_a_listing_that_cannot_be_written_is_refused_before_downloading(
        self, mocker: MockerFixture, tmp_path: Path, paths: list[str], refusal: str
    ) -> None:
        platform = _Platform()
        client = _client(platform, mocker)
        listing = [file.model_copy(update={"path": tree_path}) for tree_path, file in zip(paths, _listing({"a": b"a"}) * len(paths), strict=True)]

        with pytest.raises(RequestArgumentError, match=refusal) as caught:
            asyncio.run(client.write_method_tree(listing, destination=tmp_path / "receipts"))

        assert error_verdict_of(caught.value) == _ARGUMENT_VERDICT
        assert not platform.storage_requests
        assert not any(tmp_path.iterdir())

    @pytest.mark.parametrize(
        ("served", "came_back"),
        [
            (b'domain = "receipts"\nmain_pipe = "review_invoice"\n'[: len(_MAIN)], "hashing to"),
            (_MAIN.encode() + b"# more\n", "more than that"),
            (b"", "0 bytes"),
        ],
    )
    def test_bytes_that_are_not_the_listed_file_fail_the_write_and_leave_nothing(
        self, mocker: MockerFixture, tmp_path: Path, served: bytes, came_back: str
    ) -> None:
        contents = {"main.mthds": _MAIN.encode(), "helper.py": b"x = 1\n"}
        platform = _Platform(blobs={_sha256(_MAIN.encode()): served, _sha256(b"x = 1\n"): b"x = 1\n"})
        client = _client(platform, mocker)

        with pytest.raises(MethodFileTransferError, match=came_back) as caught:
            asyncio.run(client.write_method_tree(_listing(contents), destination=tmp_path / "receipts"))

        error = _transfer_error(caught)
        assert (error.operation, error.code, error.sha256, error.path) == (
            MethodFileTransferOperation.DOWNLOAD,
            MethodFileTransferCode.MISMATCH,
            _sha256(_MAIN.encode()),
            "main.mthds",
        )
        assert error_verdict_of(error) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)
        assert not any(tmp_path.iterdir())

    @pytest.mark.parametrize(
        ("status", "code", "retryable"),
        [
            (403, MethodFileTransferCode.REFUSED, False),
            (404, MethodFileTransferCode.REFUSED, False),
            (503, MethodFileTransferCode.STORAGE_ERROR, True),
            (429, MethodFileTransferCode.STORAGE_ERROR, True),
        ],
    )
    def test_a_download_storage_refuses_fails_the_write_without_the_link(
        self, mocker: MockerFixture, tmp_path: Path, status: int, code: MethodFileTransferCode, retryable: bool
    ) -> None:
        platform = _Platform(storage_status=status)
        client = _client(platform, mocker)
        destination = tmp_path / "receipts"
        destination.mkdir()

        with pytest.raises(MethodFileTransferError, match="read the method again for fresh links") as caught:
            asyncio.run(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=destination))

        error = _transfer_error(caught)
        assert (error.operation, error.code, error.status, error.path) == (MethodFileTransferOperation.DOWNLOAD, code, status, "main.mthds")
        assert error_verdict_of(error) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=retryable)
        assert [path.name for path in tmp_path.iterdir()] == ["receipts"]
        assert not any(destination.iterdir())

    @pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.ReadTimeout])
    def test_a_download_that_gets_no_answer_fails_the_write(self, mocker: MockerFixture, tmp_path: Path, failure: type[httpx.TransportError]) -> None:
        client = _client(_Platform(storage_failure=failure), mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=tmp_path / "receipts"))

        error = _transfer_error(caught)
        assert (error.operation, error.code, error.status) == (MethodFileTransferOperation.DOWNLOAD, MethodFileTransferCode.UNREACHABLE, None)
        assert error_verdict_of(error) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)
        assert not any(tmp_path.iterdir())

    def test_a_saved_tree_round_trips_through_a_save_and_a_write(self, mocker: MockerFixture, tmp_path: Path) -> None:
        contents = {"main.mthds": _MAIN.encode(), "data/big.txt": _LARGE, "assets/logo.png": _BINARY}
        platform = _Platform()
        client = _client(platform, mocker)
        tree = asyncio.run(client.list_method_tree(_tree_dir(tmp_path / "source", contents)))

        asyncio.run(client.create_method(MethodWriteInput(name="Receipts", tree=tree)))
        asyncio.run(client.write_method_tree(_listing(contents), destination=tmp_path / "copy"))

        assert _written(tmp_path / "copy") == contents
        assert {request.url.path.rsplit("/", 1)[-1] for request in platform.storage_requests if request.method == "PUT"} == {
            _sha256(data) for data in contents.values()
        }
