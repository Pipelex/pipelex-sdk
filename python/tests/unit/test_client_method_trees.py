"""Tests for a method's tree in the catalog: a save's `files`, `tree` and `contents`, the uploads of the blobs
the platform lacks, the deployment's tree limits, and `write_method_tree`.

The twin of `pipelex-sdk-js/tests/method-trees.test.ts`. The API and storage both answer through an
`httpx.MockTransport` below the clients, so what each test checks is the request httpx would send: the
API client's `client`, and the storage clients `_make_upload_client` and `_make_download_client` build.
Every answer that holds a signed link is checked to reach no error, whether its message, its members, its
chain or its formatted traceback.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import threading
import traceback
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from mthds.method_tree.exceptions import TreeLimitError
from mthds.method_tree.file_entry import HashFileEntry
from mthds.method_tree.models import TreeLimits
from pydantic import ValidationError
from typing_extensions import override

from pipelex_sdk import client as client_module
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import (
    ApiResponseError,
    MethodFileTransferCode,
    MethodFileTransferError,
    MethodFileTransferOperation,
    RequestArgumentError,
)
from pipelex_sdk.product_models import MethodDraftInput, MethodWriteInput, SavedMethodFile
from tests.unit.conftest import BASE_URL, refused_argument
from tests.unit.test_data import MethodVersionBodies

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

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
_UNREADABLE_VERDICT = ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)

#: The signature every link of `MethodVersionBodies.FILES` carries.
_LISTING_SIGNATURE = "X-Amz-Signature="


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
    request with, and `storage_failure` a transport failure it raises instead. `refused` names blobs
    storage refuses alone, `stalled` blobs whose body stalls after its first byte (setting `stall_started`),
    and `broken_encoding` makes storage answer a gzip body that is not gzip. `missing_answer` is the raw
    body `POST /v1/blobs/missing` answers instead of its own. `problem_refusal` makes a refusal a problem
    document quoting the signed request, as a runner signing its own upload targets answers one.
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
        refused: frozenset[str] | None = None,
        stalled: frozenset[str] | None = None,
        broken_encoding: bool = False,
        missing_answer: bytes | None = None,
        problem_refusal: bool = False,
    ) -> None:
        self.blob_store = blob_store
        self.limits = limits
        self.held = held or frozenset()
        self.extra_missing = extra_missing
        self.blobs = blobs or {}
        self.storage_status = storage_status
        self.storage_failure = storage_failure
        self.refused = refused or frozenset()
        self.stalled = stalled or frozenset()
        self.broken_encoding = broken_encoding
        self.missing_answer = missing_answer
        self.problem_refusal = problem_refusal
        self.stall_started: asyncio.Event | None = None
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
            if self.missing_answer is not None:
                return httpx.Response(200, content=self.missing_answer, request=request)
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
        name = request.url.path.rsplit("/", 1)[-1]
        if self.storage_status >= 300 or name in self.refused:
            if self.problem_refusal:
                problem = {
                    "type": "https://mthds.ai/problems/blob.upload_refused",
                    "title": "Upload refused",
                    "status": self.storage_status,
                    "detail": f"AccessDenied for {request.url}",
                    "instance": str(request.url),
                    "code": "blob.upload_refused",
                    "domain": "runtime",
                    "retry": "never",
                    "next_step": {"kind": "contact_support", "detail": f"Quote {request.url}."},
                }
                return httpx.Response(self.storage_status, json=problem, headers={"Content-Type": "application/problem+json"}, request=request)
            # Storage's error body can echo the signed request, which no message may repeat.
            refusal = f"<Error><Code>AccessDenied</Code><CanonicalRequest>{request.url}</CanonicalRequest></Error>"
            return httpx.Response(self.storage_status if self.storage_status >= 300 else 403, text=refusal, request=request)
        if self.broken_encoding:
            return httpx.Response(200, content=b"not gzip at all", headers={"Content-Encoding": "gzip"}, request=request)
        if name in self.stalled:
            return httpx.Response(200, stream=_StallingBody(self), request=request)
        if request.method == "PUT":
            self.blobs[request.url.path.rsplit("/", 1)[-1]] = request.content
            return httpx.Response(200, request=request)
        return httpx.Response(200, content=self.blobs.get(request.url.path.rsplit("/", 1)[-1], b""), request=request)

    def sent(self, method: str, path: str) -> list[httpx.Request]:
        return [request for request in self.api_requests if request.method == method and request.url.path == path]

    def saved_files(self, method: str, path: str) -> object:
        (save,) = self.sent(method, path)
        return json.loads(save.content).get("files")


class _StallingBody(httpx.AsyncByteStream):
    """A body that sends its first byte and then nothing more, ever, telling its platform it started."""

    def __init__(self, platform: _Platform) -> None:
        self.platform = platform

    @override
    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield b"x"
        if self.platform.stall_started is not None:
            self.platform.stall_started.set()
        await asyncio.Event().wait()


def _client(platform: _Platform, mocker: MockerFixture, *, request_timeout_seconds: float | None = None) -> PipelexAPIClient:
    client = (
        PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        if request_timeout_seconds is None
        else PipelexAPIClient(api_key="test-token", base_url=BASE_URL, request_timeout_seconds=request_timeout_seconds)
    )
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
    """The error raised, checked to carry neither the link nor storage's body, in its message, its members or its chain."""
    error = caught.value
    assert error.__cause__ is None
    assert error.__context__ is None
    shown = _everything_shown(error)
    assert "fixture-signature" not in shown
    assert "AccessDenied" not in shown
    return error


def _everything_shown(error: BaseException) -> str:
    """Everything an error shows of itself: its text, its `repr`, its members and its formatted traceback, chain included."""
    return "\n".join([str(error), repr(error), repr(vars(error)), "".join(traceback.format_exception(error))])


def _unreadable(caught: pytest.ExceptionInfo[ApiResponseError], *, signature: str) -> ApiResponseError:
    """The unreadable answer raised, checked to show no link's signature anywhere, its body redacted rather than dropped."""
    error = caught.value
    assert signature not in _everything_shown(error)
    assert error.__context__ is None
    assert error_verdict_of(error) == _UNREADABLE_VERDICT
    return error


def _listing_answer(files: list[dict[str, Any]], body: dict[str, Any]) -> dict[str, Any]:
    return {**copy.deepcopy(body), "files": files}


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
        assert refused_argument(caught.value) == {"argument": "files", "reason": "mutually_exclusive"}
        assert not platform.api_requests

    def test_a_tree_and_contents_together_are_refused_before_sending(self, mocker: MockerFixture, tmp_path: Path) -> None:
        platform = _Platform()
        client = _client(platform, mocker)
        tree = asyncio.run(client.list_method_tree(_tree_dir(tmp_path, {"main.mthds": _MAIN.encode()})))
        platform.api_requests.clear()

        with pytest.raises(RequestArgumentError, match="got tree and contents") as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", tree=tree, contents={"main.mthds": _MAIN})))

        assert refused_argument(caught.value) == {"argument": "files", "reason": "mutually_exclusive"}

        assert not platform.api_requests

    @pytest.mark.parametrize(
        ("contents", "refusal", "reason"),
        [
            ({}, "holding no file", "empty"),
            ({"main.mthds": "lone \ud800 surrogate"}, "lone surrogate", "lone_surrogate"),
        ],
    )
    def test_contents_no_tree_can_hold_are_refused_before_sending(
        self, mocker: MockerFixture, contents: dict[str, str], refusal: str, reason: str
    ) -> None:
        platform = _Platform()
        client = _client(platform, mocker)

        with pytest.raises(RequestArgumentError, match=refusal) as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents=dict(contents))))

        assert refused_argument(caught.value) == {"argument": "contents", "reason": reason}

        assert not platform.api_requests

    def test_an_answer_asking_for_a_blob_the_tree_does_not_hold_is_one_the_sdk_cannot_read(self, mocker: MockerFixture) -> None:
        """The platform's fault, not the caller's: the standard's client refuses an answer naming a blob it did not
        ask about, nothing is uploaded, and the answer travels redacted.
        """
        platform = _Platform(extra_missing=("0" * 64,))
        client = _client(platform, mocker)

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        error = _unreadable(caught, signature="fixture-signature")
        assert str(error) == "API POST /v1/blobs/missing answered 200 with a body that is not the answer the route returns"
        assert error.status == 200
        assert error.__cause__ is None
        assert json.loads(error.response_body)["missing"][0]["upload"]["url"] == "[redacted]"
        assert not platform.storage_requests
        assert not platform.sent("POST", "/v1/methods")

    @pytest.mark.parametrize(
        ("answer", "what", "chained"),
        [
            pytest.param(
                json.dumps(
                    {"missing": [{"sha256": "a" * 64, "size": "big", "upload": {"method": "PUT", "url": _link("a" * 64), "headers": {}}}]}
                ).encode(),
                "a body that is not the answer the route returns",
                True,
                id="wrong-shape",
            ),
            pytest.param(f"<html>{_link('a' * 64)}".encode(), "a body that is not JSON", False, id="not-json"),
        ],
    )
    def test_an_unreadable_answer_to_which_blobs_are_missing_fails_the_save_redacted(
        self, mocker: MockerFixture, answer: bytes, what: str, chained: bool
    ) -> None:
        platform = _Platform(missing_answer=answer)
        client = _client(platform, mocker)

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        error = _unreadable(caught, signature="fixture-signature")
        assert str(error) == f"API POST /v1/blobs/missing answered 200 with {what}"
        assert "[redacted]" in error.response_body
        # A pydantic refusal is chained as a copy whose links are redacted, which still names what it refused.
        assert isinstance(error.__cause__, ValidationError) is chained
        if isinstance(error.__cause__, ValidationError):
            assert [failure["loc"] for failure in error.__cause__.errors()] == [("missing", 0, "size")]
        assert not platform.storage_requests
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
        # The standard's error quotes storage's body, so it is kept neither as the cause nor as the context.
        assert error_verdict_of(error) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=retryable)
        assert not platform.sent("POST", "/v1/methods")

    def test_a_problem_document_an_upload_target_answers_with_is_not_kept(self, mocker: MockerFixture) -> None:
        """A target answering a problem document of its own, which quotes the signed request, leaves only its status's reading."""
        platform = _Platform(storage_status=403, problem_refusal=True)
        client = _client(platform, mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        error = _transfer_error(caught)
        assert (error.code, error.status, error.problem.code) == (MethodFileTransferCode.REFUSED, 403, "client.response_unreadable")
        assert not platform.sent("POST", "/v1/methods")

    @pytest.mark.parametrize(
        "platform",
        [
            pytest.param(_Platform(storage_failure=httpx.ConnectError), id="no-answer"),
            pytest.param(_Platform(broken_encoding=True), id="undecodable-body"),
        ],
    )
    def test_an_upload_that_gets_no_answer_fails_the_save(self, mocker: MockerFixture, platform: _Platform) -> None:
        client = _client(platform, mocker)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        error = _transfer_error(caught)
        # The standard's client names the blob whose upload got no answer.
        assert (error.operation, error.code, error.sha256, error.status) == (
            MethodFileTransferOperation.UPLOAD,
            MethodFileTransferCode.UNREACHABLE,
            _sha256(_LARGE),
            None,
        )
        assert error_verdict_of(error) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)
        assert not platform.sent("POST", "/v1/methods")

    def test_an_upload_storage_already_holds_counts_as_uploaded(self, mocker: MockerFixture) -> None:
        platform = _Platform(storage_status=412)
        client = _client(platform, mocker)

        asyncio.run(client.create_method(MethodWriteInput(name="Receipts", contents={"data/big.txt": _LARGE})))

        assert platform.saved_files("POST", "/v1/methods") == {"data/big.txt": {"sha256": _sha256(_LARGE), "size": len(_LARGE)}}

    # ── Reading a listing the SDK cannot read ─────────────────────────

    @pytest.mark.parametrize(
        ("route", "body"),
        [
            pytest.param("get_method", MethodVersionBodies.METHOD_DETAIL, id="get_method"),
            pytest.param("get_method_version", MethodVersionBodies.VERSION, id="get_method_version"),
        ],
    )
    @pytest.mark.parametrize(
        ("fault", "member"),
        [
            # Refused at the member, whose value is the hash alone.
            pytest.param("uppercase-sha256", "sha256", id="uppercase-sha256"),
            # Refused at the file, whose value pydantic holds is the whole file, its link included.
            pytest.param("missing-path", "path", id="missing-path"),
        ],
    )
    def test_a_listing_that_is_not_the_answer_reaches_no_error_with_its_links(
        self, route: str, body: dict[str, Any], fault: str, member: str
    ) -> None:
        files = copy.deepcopy(MethodVersionBodies.FILES)
        if fault == "uppercase-sha256":
            files[1]["sha256"] = files[1]["sha256"].upper()
        else:
            del files[1]["path"]
        client = _answering_client(json.dumps(_listing_answer(files, body)).encode())

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(_read_listing(client, route))

        error = _unreadable(caught, signature=_LISTING_SIGNATURE)
        assert str(error).endswith("answered 200 with a body that is not the answer the route returns")
        assert [file["url"] for file in json.loads(error.response_body)["files"]] == ["[redacted]", "[redacted]"]
        assert isinstance(error.__cause__, ValidationError)
        assert [failure["loc"] for failure in error.__cause__.errors()] == [("files", 1, member)]

    @pytest.mark.parametrize("route", ["get_method", "get_method_version"])
    def test_a_truncated_listing_reaches_no_error_with_its_links(self, route: str) -> None:
        whole = json.dumps(MethodVersionBodies.METHOD_DETAIL if route == "get_method" else MethodVersionBodies.VERSION)
        client = _answering_client(whole[: whole.index("X-Amz-Signature=def") + 20].encode())

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(_read_listing(client, route))

        error = _unreadable(caught, signature=_LISTING_SIGNATURE)
        assert str(error).endswith("answered 200 with a body that is not JSON")
        assert "?[redacted]" in error.response_body
        # A `JSONDecodeError` holds the whole document, so nothing is chained.
        assert error.__cause__ is None

    def test_a_listing_s_links_are_left_out_of_its_files_repr(self) -> None:
        (saved_file,) = _listing({"main.mthds": _MAIN.encode()})

        assert "fixture-signature" not in repr(saved_file)
        assert saved_file.url == _link(_sha256(_MAIN.encode()))

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

        with pytest.raises(RequestArgumentError, match="already exists") as caught:
            asyncio.run(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=destination))

        assert refused_argument(caught.value) == {"argument": "destination", "reason": "not_empty"}

        assert not platform.storage_requests

    @pytest.mark.parametrize(
        ("paths", "refusal", "reason"),
        [
            (["../escape.txt"], "not a tree path", "not_a_tree_path"),
            (["/etc/passwd"], "not a tree path", "not_a_tree_path"),
            (["lib//helper.py"], "not a tree path", "not_a_tree_path"),
            (["main.mthds", "main.mthds"], "twice", "duplicate_path"),
            (["Main.mthds", "main.mthds"], "collide", "colliding_paths"),
            (["lib", "lib/helper.py"], "collide", "colliding_paths"),
        ],
    )
    def test_a_listing_that_cannot_be_written_is_refused_before_downloading(
        self, mocker: MockerFixture, tmp_path: Path, paths: list[str], refusal: str, reason: str
    ) -> None:
        platform = _Platform()
        client = _client(platform, mocker)
        listing = [file.model_copy(update={"path": tree_path}) for tree_path, file in zip(paths, _listing({"a": b"a"}) * len(paths), strict=True)]

        with pytest.raises(RequestArgumentError, match=refusal) as caught:
            asyncio.run(client.write_method_tree(listing, destination=tmp_path / "receipts"))

        assert error_verdict_of(caught.value) == _ARGUMENT_VERDICT
        assert refused_argument(caught.value) == {"argument": "files", "reason": reason}
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

    def test_a_download_whose_body_httpx_cannot_decode_fails_the_write(self, mocker: MockerFixture, tmp_path: Path) -> None:
        client = _client(_Platform(broken_encoding=True), mocker)

        with pytest.raises(MethodFileTransferError, match=r"\(DecodingError\)") as caught:
            asyncio.run(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=tmp_path / "receipts"))

        error = _transfer_error(caught)
        assert (error.operation, error.code) == (MethodFileTransferOperation.DOWNLOAD, MethodFileTransferCode.UNREACHABLE)
        assert not any(tmp_path.iterdir())

    def test_a_body_that_stalls_times_out_with_the_whole_exchange(self, mocker: MockerFixture, tmp_path: Path) -> None:
        contents = {"main.mthds": _MAIN.encode()}
        client = _client(_Platform(stalled=frozenset({_sha256(_MAIN.encode())})), mocker, request_timeout_seconds=0.2)

        with pytest.raises(MethodFileTransferError, match=r"\(TimeoutError\)") as caught:
            asyncio.run(client.write_method_tree(_listing(contents), destination=tmp_path / "receipts"))

        error = _transfer_error(caught)
        assert (error.operation, error.code, error.path) == (MethodFileTransferOperation.DOWNLOAD, MethodFileTransferCode.UNREACHABLE, "main.mthds")
        assert not any(tmp_path.iterdir())

    def test_the_first_failure_stops_the_downloads_still_running(self, mocker: MockerFixture, tmp_path: Path) -> None:
        contents = {"main.mthds": _MAIN.encode(), "helper.py": b"x = 1\n"}
        platform = _Platform(stalled=frozenset({_sha256(_MAIN.encode())}), refused=frozenset({_sha256(b"x = 1\n")}))
        client = _client(platform, mocker)

        async def write() -> None:
            # Bounded, so a write that waited for the stalled download fails the test rather than hanging it.
            await asyncio.wait_for(client.write_method_tree(_listing(contents), destination=tmp_path / "receipts"), timeout=10)

        with pytest.raises(MethodFileTransferError) as caught:
            asyncio.run(write())

        error = _transfer_error(caught)
        assert (error.code, error.path) == (MethodFileTransferCode.REFUSED, "helper.py")
        assert not any(tmp_path.iterdir())

    def test_a_cancelled_write_leaves_nothing_behind(self, mocker: MockerFixture, tmp_path: Path) -> None:
        platform = _Platform(stalled=frozenset({_sha256(_MAIN.encode())}))
        client = _client(platform, mocker)

        async def cancel_mid_write() -> None:
            platform.stall_started = asyncio.Event()
            writing = asyncio.create_task(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=tmp_path / "receipts"))
            await platform.stall_started.wait()
            assert [path.name.endswith(".writing") for path in tmp_path.iterdir()] == [True]
            writing.cancel()
            with pytest.raises(asyncio.CancelledError):
                await writing

        asyncio.run(cancel_mid_write())

        assert not any(tmp_path.iterdir())

    def test_a_write_cancelled_while_its_hidden_directory_is_made_leaves_nothing_behind(self, mocker: MockerFixture, tmp_path: Path) -> None:
        """The hidden directory a cancelled write was making when the cancellation came is removed once it is made."""
        client = _client(_Platform(), mocker)
        making = threading.Event()
        proceed = threading.Event()
        make_staging_directory = client_module._make_staging_directory

        def make_when_told(target: Path, staging: Path) -> None:
            making.set()
            proceed.wait()
            make_staging_directory(target, staging)

        mocker.patch.object(client_module, "_make_staging_directory", side_effect=make_when_told)

        async def cancel_while_making() -> None:
            writing = asyncio.create_task(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=tmp_path / "receipts"))
            await asyncio.to_thread(making.wait)
            writing.cancel()
            await asyncio.sleep(0)
            proceed.set()
            with pytest.raises(asyncio.CancelledError):
                await writing

        asyncio.run(cancel_while_making())

        assert not any(tmp_path.iterdir())

    def test_a_file_holds_its_download_slot_until_it_is_written(self, mocker: MockerFixture, tmp_path: Path) -> None:
        contents = {"a.txt": b"a\n", "b.txt": b"b\n"}
        platform = _Platform(blobs={_sha256(data): data for data in contents.values()})
        client = _client(platform, mocker)
        events: list[str] = []
        name_of = {_sha256(data): tree_path for tree_path, data in contents.items()}
        serve = platform.storage

        def recording_storage(request: httpx.Request) -> httpx.Response:
            events.append(f"download {name_of[request.url.path.rsplit('/', 1)[-1]]}")
            return serve(request)

        write_new_file = client_module._write_new_file

        def recording_write(target: Path, data: bytes) -> None:
            events.append(f"write {target.name}")
            write_new_file(target, data)

        mocker.patch.object(client_module, "_MAX_CONCURRENT_DOWNLOADS", 1)
        mocker.patch.object(client_module, "_write_new_file", side_effect=recording_write)
        mocker.patch.object(client, "_make_download_client", side_effect=lambda: httpx.AsyncClient(transport=httpx.MockTransport(recording_storage)))

        asyncio.run(client.write_method_tree(_listing(contents), destination=tmp_path / "receipts"))

        assert events == ["download a.txt", "write a.txt", "download b.txt", "write b.txt"]
        assert _written(tmp_path / "receipts") == contents

    def test_a_relative_destination_names_the_directory_it_means(
        self, mocker: MockerFixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        contents = {"main.mthds": _MAIN.encode(), "lib/helper.py": b"x = 1\n"}
        client = _client(_Platform(blobs={_sha256(data): data for data in contents.values()}), mocker)
        destination = tmp_path / "receipts"
        destination.mkdir()
        monkeypatch.chdir(destination)

        asyncio.run(client.write_method_tree(_listing(contents), destination=Path()))

        assert _written(destination) == contents
        assert [path.name for path in tmp_path.iterdir()] == ["receipts"]

    def test_the_root_of_a_filesystem_is_refused_before_downloading(self, mocker: MockerFixture) -> None:
        platform = _Platform()
        client = _client(platform, mocker)

        with pytest.raises(RequestArgumentError, match="root of a filesystem") as caught:
            asyncio.run(client.write_method_tree(_listing({"main.mthds": _MAIN.encode()}), destination=Path("/")))

        assert refused_argument(caught.value) == {"argument": "destination", "reason": "filesystem_root"}

        assert not platform.storage_requests

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


def _answering_client(answer: bytes) -> PipelexAPIClient:
    """A client whose API answers every request `200` with `answer`."""
    client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=answer, request=request)))
    return client


async def _read_listing(client: PipelexAPIClient, route: str) -> object:
    if route == "get_method":
        return await client.get_method("mt_receipts01")
    return await client.get_method_version("mt_receipts01", 3)
