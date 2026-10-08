"""The `pipelex-sdk` command against its recorded case table, `tests/fixtures/cli-cases.json`.

The table's source is `js/tests/fixtures/cli-cases.json`, which `@pipelex/sdk`'s command runs too; this
copy is written by `make shared-files` at the repository root and never edited here. Each case runs
the command in-process, in a fresh working directory holding the case's files, with the case's
environment and stdin, and with every `httpx.AsyncClient` answering from the case's recorded routes
through an `httpx.MockTransport`. So the command runs on the SDK's real client: what is checked is
what it sends and what it prints, never which client method it called.

A case that uses a field this suite does not know fails rather than being skipped, so a case added to
the table for the other language reaches this one. An interrupt case raises a real `SIGINT` while the
named request is in flight, which `asyncio.run` turns into a cancellation of the command's wait, as
Ctrl-C would.
"""

from __future__ import annotations

import asyncio
import base64
import errno
import json
import os
import signal
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from enum import StrEnum
from itertools import starmap
from pathlib import Path
from typing import TYPE_CHECKING, Any, Self, cast

import httpx
import pytest

from pipelex_sdk.command.io import CommandIO
from pipelex_sdk.command.main import run_command
from pipelex_sdk.command.script import _write_script
from pipelex_sdk.version import __version__

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from pytest_mock import MockerFixture

    from pipelex_sdk.command.io import Progress

# ── The table's shape ─────────────────────────────────────────────────────────────────────────────

_TABLE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "cli-cases.json"
_TABLE: dict[str, Any] = json.loads(_TABLE_PATH.read_text(encoding="utf-8"))
_CASES: list[dict[str, Any]] = _TABLE["cases"]


def _case_named(name: str) -> dict[str, Any]:
    """The table's case of that name, for a test that lands an interrupt the table cannot express."""
    return next(case for case in _CASES if case["name"] == name)


_ANSWERS: dict[str, dict[str, Any]] = _TABLE["answers"]
_BASE_URL = httpx.URL(_TABLE["base_url"])
_BASE_ORIGIN = f"{_BASE_URL.scheme}://{_BASE_URL.netloc.decode('ascii')}"

# Every field this suite knows how to run. Anything else in the table is a case it cannot run.
_TABLE_FIELDS = ["about", "base_url", "env", "placeholders", "answers", "cases"]
_CASE_FIELDS = ["name", "summary", "argv", "env", "files", "stdin", "stdin_error", "routes", "interrupt", "expect"]
_EXPECT_FIELDS = ["exit_code", "stdout", "stdout_includes", "stderr", "stderr_excludes", "files", "absent_files"]
_FILE_FIELDS = ["path", "text", "base64", "symlink", "directory"]
_FILE_KINDS = ["text", "base64", "symlink", "directory"]
_EXCHANGE_FIELDS = ["request_body", "answer", "status", "headers", "body", "text", "base64", "unreachable", "lost", "elapsed_ms"]
_PLACEHOLDER_LANGUAGE = "python"
# How long a command interrupted during a blocked read may take to end: far more than it needs, far less
# than a command left waiting for the read.
_BLOCKED_READ_BUDGET_SECONDS = 5.0


def _unknown_fields(value: Mapping[str, Any], known: list[str]) -> list[str]:
    return [key for key in value if key not in known]


def _unrunnable(case: dict[str, Any]) -> list[str]:
    """Every reason this suite cannot run a case as written; empty when it can."""
    problems = [f'case field "{field}"' for field in _unknown_fields(case, _CASE_FIELDS)]
    expect: dict[str, Any] = case["expect"]
    problems.extend(f'expect field "{field}"' for field in _unknown_fields(expect, _EXPECT_FIELDS))
    if ("stdout" in expect) == ("stdout_includes" in expect):
        problems.append("expect needs exactly one of stdout and stdout_includes")
    for file in case.get("files", []):
        problems.extend(f'file field "{field}"' for field in _unknown_fields(file, _FILE_FIELDS))
        if len([kind for kind in _FILE_KINDS if kind in file]) != 1:
            problems.append(f'file "{file["path"]}" needs exactly one kind')
    for key, exchanges in case.get("routes", {}).items():
        for exchange in exchanges:
            problems.extend(f'exchange field "{field}" on {key}' for field in _unknown_fields(exchange, _EXCHANGE_FIELDS))
            if "answer" in exchange and exchange["answer"] not in _ANSWERS:
                problems.append(f'unknown answer "{exchange["answer"]}" on {key}')
    return problems


def _fill(text: str) -> str:
    """The table's placeholders filled with this language's values, then the SDK's version."""
    filled = text
    for name, values in cast("dict[str, dict[str, str]]", _TABLE["placeholders"]).items():
        if name != "SDK_VERSION":
            filled = filled.replace(f"{{{{{name}}}}}", values[_PLACEHOLDER_LANGUAGE])
    filled = filled.replace("{{SDK_VERSION}}", __version__)
    if "{{" in filled:
        msg = f"an unknown placeholder is left in: {filled}"
        raise AssertionError(msg)
    return filled


# ── The recorded API ──────────────────────────────────────────────────────────────────────────────


def _json_equal(left: Any, right: Any) -> bool:
    """JSON equality: numbers by value whatever their spelling, booleans never equal to numbers."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, list) and isinstance(right, list):
        left_items = cast("list[Any]", left)
        right_items = cast("list[Any]", right)
        return len(left_items) == len(right_items) and all(starmap(_json_equal, zip(left_items, right_items, strict=True)))
    if isinstance(left, dict) and isinstance(right, dict):
        left_members = cast("dict[str, Any]", left)
        right_members = cast("dict[str, Any]", right)
        return left_members.keys() == right_members.keys() and all(_json_equal(member, right_members[key]) for key, member in left_members.items())
    # What is left is a string or `null`, each equal only to itself.
    return bool(left == right)


def _sent_body(content: bytes) -> Any:
    """A request body as JSON, without the top-level keys sent as `null`, which mean "absent"."""
    if not content:
        return None
    parsed: Any = json.loads(content)
    if not isinstance(parsed, dict):
        return parsed
    members = cast("dict[str, Any]", parsed)
    return {key: value for key, value in members.items() if value is not None}


def _caused(failure: httpx.TransportError, cause: BaseException) -> httpx.TransportError:
    """`failure` raised from `cause`, as httpx chains the transport's own error under its."""
    failure.__cause__ = cause
    return failure


def _connect_error(message: str, cause: BaseException) -> Callable[[httpx.Request], httpx.TransportError]:
    """A connection that failed while it was set up, as httpx reports it: its `ConnectError`, over the cause."""
    return lambda request: _caused(httpx.ConnectError(message, request=request), cause)


# Each kind of `unreachable` exchange, a request that never got a connection to answer it, as httpx
# reports it, its cause chained: each was read off httpx against a local server, a closed port, a listener
# that never accepts and certificates of a local authority, but for no route to the host or the network,
# which take the shape every failed connect call takes (`docs/cli.md`).
_UNREACHABLE: dict[str, Callable[[httpx.Request], httpx.TransportError]] = {
    "refused": _connect_error("All connection attempts failed", ConnectionRefusedError(errno.ECONNREFUSED, "Connect call failed")),
    "refused-every-address": _connect_error("All connection attempts failed", ConnectionRefusedError(errno.ECONNREFUSED, "Connect call failed")),
    "unknown-host": _connect_error(
        "[Errno 8] nodename nor servname provided, or not known", socket.gaierror(socket.EAI_NONAME, "nodename nor servname provided, or not known")
    ),
    "no-route": _connect_error("All connection attempts failed", OSError(errno.EHOSTUNREACH, "Connect call failed")),
    "no-network": _connect_error("All connection attempts failed", OSError(errno.ENETUNREACH, "Connect call failed")),
    # httpx has no connect time limit of its own below the request's, so the transport's is the system's.
    "connect-timeout": _connect_error("All connection attempts failed", TimeoutError(errno.ETIMEDOUT, "Connect call failed")),
    "system-connect-timeout": _connect_error("All connection attempts failed", TimeoutError(errno.ETIMEDOUT, "Connect call failed")),
    # The client's own time limit, run out before the connection was made or while it waited for one.
    "timeout-before-connecting": lambda request: _caused(httpx.ConnectTimeout("", request=request), TimeoutError()),
    "pool-timeout": lambda request: httpx.PoolTimeout("", request=request),
    "certificate": _connect_error(
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: certificate has expired",
        ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: certificate has expired"),
    ),
    "certificate-unnamed": _connect_error(
        "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unhandled critical extension",
        ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unhandled critical extension"),
    ),
    # A server that drops the connection during the TLS handshake, which httpx reads as the pipe it broke.
    "handshake-dropped": _connect_error("", BrokenPipeError(errno.EPIPE, "Broken pipe")),
}

# Each kind of `lost` exchange, a request that left and whose answer never came back, as httpx reports it.
_LOST: dict[str, Callable[[httpx.Request], httpx.TransportError]] = {
    "timeout": lambda request: httpx.ReadTimeout("timed out", request=request),
    "closed": lambda request: httpx.RemoteProtocolError("Server disconnected without sending a response.", request=request),
    "reset": lambda request: _caused(
        httpx.ReadError("[Errno 54] Connection reset by peer", request=request), ConnectionResetError(errno.ECONNRESET, "Connection reset by peer")
    ),
    "no-route": lambda request: _caused(
        httpx.ReadError("[Errno 65] No route to host", request=request), OSError(errno.EHOSTUNREACH, "No route to host")
    ),
}


class _RecordedApi:
    """The API answering from a case's routes. A route is `METHOD /path?query` on the table's base URL;
    its exchanges answer its calls in order, each once. A request the case did not record, to another
    origin or without the case's key, is a problem the case reports.
    """

    def __init__(self, case: dict[str, Any], env: dict[str, str], *, interrupt_while_answering: str | None = None) -> None:
        self.case = case
        self.env = env
        # A route whose first answer lands with an interrupt, as Ctrl-C pressed while that answer is read.
        self.interrupt_while_answering = interrupt_while_answering
        self.problems: list[str] = []
        self.calls: dict[str, int] = {}
        #: The time the case's exchanges have taken (`elapsed_ms`), which the case's clock adds to the real one.
        self.elapsed_seconds = 0.0

    async def handle(self, request: httpx.Request) -> httpx.Response:
        key = f"{request.method} {request.url.raw_path.decode('ascii')}"
        origin = f"{request.url.scheme}://{request.url.netloc.decode('ascii')}"
        if origin != _BASE_ORIGIN:
            self.problems.append(f"a request to another origin: {key} on {origin}")
            return httpx.Response(599)
        if request.headers.get("authorization") != f"Bearer {self.env.get('PIPELEX_API_KEY')}":
            self.problems.append(f"{key} was sent without the case's key")
        call = self.calls.get(key, 0) + 1
        self.calls[key] = call

        interrupt: dict[str, Any] | None = self.case.get("interrupt")
        if interrupt is not None and interrupt["route"] == key and interrupt["call"] == call:
            # Interrupt instead of answering, as Ctrl-C would while this request is in flight: under
            # `asyncio.run` the signal cancels the command's task, which wakes this wait.
            signal.raise_signal(signal.SIGINT)
            await asyncio.Event().wait()

        exchanges: list[dict[str, Any]] = self.case.get("routes", {}).get(key, [])
        if call > len(exchanges):
            self.problems.append(f"an unrecorded request: {key}, call {call}")
            return httpx.Response(599, json={"detail": "unrecorded"})
        exchange = exchanges[call - 1]
        if "request_body" in exchange:
            sent: Any = _sent_body(request.content)
            if not _json_equal(sent, exchange["request_body"]):
                self.problems.append(f"{key}, call {call}, sent {json.dumps(sent)} where the case records {json.dumps(exchange['request_body'])}")
        answer: dict[str, Any] = {**_ANSWERS.get(exchange.get("answer", ""), {}), **exchange}
        # The exchange takes this long on the clock the command and the SDK read, at once.
        self.elapsed_seconds += cast("int", answer.get("elapsed_ms", 0)) / 1000
        unreachable: str | None = answer.get("unreachable")
        if unreachable is not None:
            if unreachable not in _UNREACHABLE:
                self.problems.append(f'{key}, call {call}: unreachable is "{unreachable}", no kind')
            else:
                raise _UNREACHABLE[unreachable](request)
        # The request went out and its answer never came back: the time limit ran out, or the
        # connection closed or failed, each as httpx reports it.
        lost: str | None = answer.get("lost")
        if lost is not None:
            if lost not in _LOST:
                self.problems.append(f'{key}, call {call}: lost is "{lost}", no kind')
            else:
                raise _LOST[lost](request)
        headers: dict[str, str] = dict(answer.get("headers", {}))
        content = b""
        if "body" in answer:
            content = json.dumps(answer["body"], ensure_ascii=False).encode("utf-8")
            if "content-type" not in {name.lower() for name in headers}:
                headers["content-type"] = "application/json"
        elif "text" in answer:
            content = cast("str", answer["text"]).encode("utf-8")
        if key == self.interrupt_while_answering and call == 1:
            # The signal lands while the command's task runs, so it is delivered at the task's next wait.
            signal.raise_signal(signal.SIGINT)
        if "base64" in answer:
            # Raw bytes, served as a stream so that the client decodes them as it reads them, a
            # `Content-Encoding` included, as it would off the network.
            raw = base64.b64decode(answer["base64"])
            return httpx.Response(answer.get("status", 200), headers=headers, stream=httpx.ByteStream(raw))
        return httpx.Response(answer.get("status", 200), headers=headers, content=content)

    def unserved(self) -> list[str]:
        """Every recorded exchange the command never asked for."""
        left: list[str] = []
        for key, exchanges in cast("dict[str, list[Any]]", self.case.get("routes", {})).items():
            served = self.calls.get(key, 0)
            if served < len(exchanges):
                left.append(f"{key}: {len(exchanges) - served} never asked for")
        return left


def _write_interrupted(interrupts: int = 1) -> Callable[[int, bytes], int]:
    """An `os.write` whose first call stores the first bytes, then takes Ctrl-C, once or more, as a write the
    person interrupts; the calls after it write as `os.write` does.
    """
    real_write = os.write
    calls: list[int] = []

    def write(descriptor: int, data: bytes) -> int:
        if calls:
            return real_write(descriptor, data)
        calls.append(descriptor)
        written = real_write(descriptor, data[:8])
        # Outside the event loop, Python's own handler would raise `KeyboardInterrupt` right here.
        for _ in range(interrupts):
            signal.raise_signal(signal.SIGINT)
        return written

    return write


def _write_failing() -> Callable[[int, bytes], int]:
    """An `os.write` that stores the first bytes, then fails as a full disk fails it."""
    real_write = os.write

    def write(descriptor: int, data: bytes) -> int:
        real_write(descriptor, data[:20])
        raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))

    return write


# ── Running a case ────────────────────────────────────────────────────────────────────────────────

_REAL_MONOTONIC = time.monotonic


def _materialize(root: Path, files: list[dict[str, Any]]) -> None:
    for file in files:
        target = root / file["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if file.get("directory") is True:
            target.mkdir(parents=True, exist_ok=True)
        elif "symlink" in file:
            Path(target).symlink_to(file["symlink"])
        elif "base64" in file:
            target.write_bytes(base64.b64decode(file["base64"]))
        else:
            target.write_bytes(cast("str", file["text"]).encode("utf-8"))


def _case_env(case: dict[str, Any]) -> dict[str, str]:
    env: dict[str, str] = dict(_TABLE["env"])
    for name, value in cast("dict[str, str | None]", case.get("env", {})).items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
    return env


def _first_missing(text: str, needles: list[str]) -> str | None:
    """The first needle that does not appear in `text` after the end of the one before; `None` when all do."""
    start = 0
    for needle in needles:
        found_at = text.find(needle, start)
        if found_at < 0:
            return needle
        start = found_at + len(needle)
    return None


class _EarlyInterrupt(StrEnum):
    """Where an interrupt that the table cannot express lands, before any request the case records."""

    #: As the command opens its API client, the first thing it does on its event loop.
    CLIENT = "client"
    #: While the command reads stdin, before its event loop starts.
    STDIN = "stdin"


@dataclass(frozen=True)
class _Outcome:
    exit_code: int
    stdout: str
    stderr: str
    api: _RecordedApi

    @property
    def shown(self) -> str:
        return f"stdout:\n{self.stdout}\nstderr:\n{self.stderr}"


def _run_case(
    case: dict[str, Any],
    root: Path,
    mocker: MockerFixture,
    monkeypatch: pytest.MonkeyPatch,
    *,
    early: _EarlyInterrupt | None = None,
    interrupt_while_answering: str | None = None,
    interrupt_while_printing: bool = False,
) -> _Outcome:
    """Run the command on a case, in `root`, with every API client answering from the case's routes.

    With `interrupt_while_printing`, Ctrl-C lands as the command prints its first line on stdout, before
    the line is out.
    """
    _materialize(root, case.get("files", []))
    env = _case_env(case)
    api = _RecordedApi(case, env, interrupt_while_answering=interrupt_while_answering)
    real_async_client = httpx.AsyncClient

    def recorded_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        if early == _EarlyInterrupt.CLIENT:
            signal.raise_signal(signal.SIGINT)
        return real_async_client(*args, transport=httpx.MockTransport(api.handle), **kwargs)

    def read_stdin() -> bytes:
        if early == _EarlyInterrupt.STDIN:
            # Outside the event loop, Python's own handler raises `KeyboardInterrupt` right here.
            signal.raise_signal(signal.SIGINT)
        if "stdin_error" in case:
            code = cast("str", case["stdin_error"])
            raise OSError(getattr(errno, code), os.strerror(getattr(errno, code)))
        return cast("str", case.get("stdin", "")).encode("utf-8")

    def case_clock() -> float:
        # The clock the SDK times its requests with, and the command the request that may create a run:
        # it runs as it does, plus the time the case's exchanges have taken, so that a case can hold an
        # answer that came back half a minute later without waiting for it.
        return _REAL_MONOTONIC() + api.elapsed_seconds

    mocker.patch.object(httpx, "AsyncClient", recorded_client)
    mocker.patch("pipelex_sdk.client.monotonic", case_clock)
    mocker.patch("pipelex_sdk.command.io.monotonic", case_clock)
    monkeypatch.chdir(root)
    stdout: list[str] = []
    stderr: list[str] = []

    def write_stdout(text: str) -> None:
        if interrupt_while_printing and not stdout:
            # Outside the event loop, Python's own handler raises `KeyboardInterrupt` right here.
            signal.raise_signal(signal.SIGINT)
        stdout.append(text)

    io = CommandIO(env=env, read_stdin=read_stdin, write_stdout=write_stdout, write_stderr=stderr.append)

    exit_code = run_command(case["argv"], io)

    return _Outcome(exit_code=exit_code, stdout="".join(stdout), stderr="".join(stderr), api=api)


def _check(case: dict[str, Any], outcome: _Outcome, root: Path) -> None:
    """Hold an outcome to everything the case expects."""
    shown = outcome.shown
    assert outcome.api.problems == [], shown
    assert outcome.api.unserved() == [], shown
    expect: dict[str, Any] = case["expect"]
    assert outcome.exit_code == expect["exit_code"], shown
    if "stdout" in expect:
        assert outcome.stdout == _fill(expect["stdout"]), shown
    if "stdout_includes" in expect:
        assert _first_missing(outcome.stdout, [_fill(needle) for needle in expect["stdout_includes"]]) is None, shown
    assert _first_missing(outcome.stderr, [_fill(needle) for needle in expect.get("stderr", [])]) is None, shown
    for excluded in expect.get("stderr_excludes", []):
        assert _fill(excluded) not in outcome.stderr, shown
    for file in expect.get("files", []):
        target = root / file["path"]
        assert target.read_bytes().decode("utf-8") == _fill(file["text"])
        if file.get("executable") is True:
            assert target.stat().st_mode & 0o100, f"{file['path']} is not executable"
    for absent in expect.get("absent_files", []):
        assert not (root / absent).exists(), f"{absent} exists"


# An interrupt that lands before any request: each case records no route, so any request the command
# sent would fail it, as an unrecorded one. The scenarios of `@pipelex/sdk`'s suite, landing where a
# Python command meets them.
_NOTHING_WRITTEN = "Interrupted. Nothing was written.\n"


def _script_written_then_interrupted() -> dict[str, Any]:
    """`script/catalog-id`, whose file an interrupt lands on once it is written: the file is whole, the
    command says it was written and exits 130, and nothing reaches stdout.
    """
    written = _case_named("script/catalog-id")
    return {
        **written,
        "expect": {
            "exit_code": 130,
            "stdout": "",
            "stderr": ["Interrupted. ./resume-review-v2 was written.\n"],
            "files": written["expect"]["files"],
        },
    }


_BUNDLE = 'domain = "receipts"\nmain_pipe = "review_receipt"\n'
_NO_RUN = "Interrupted. No run was started.\n"
_EARLY_SCENARIOS: list[tuple[str, _EarlyInterrupt, dict[str, Any]]] = [
    (
        "run",
        _EarlyInterrupt.CLIENT,
        {
            "name": "early/run",
            "argv": ["run", "--method", "mt_receipts01"],
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NO_RUN], "stderr_excludes": ["Error"]},
        },
    ),
    (
        "run-with-inputs",
        _EarlyInterrupt.CLIENT,
        {
            "name": "early/run-with-inputs",
            "argv": ["run", "--method", "receipt-review.mthds", "--inputs", "inputs.json"],
            "files": [
                {"path": "receipt-review.mthds", "text": _BUNDLE},
                {"path": "inputs.json", "text": '{"receipt": "scans/receipt.pdf"}\n'},
                {"path": "scans/receipt.pdf", "text": "%PDF-1.4\n"},
            ],
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NO_RUN]},
        },
    ),
    (
        "stdin",
        _EarlyInterrupt.STDIN,
        {
            "name": "early/stdin",
            "argv": ["run", "--method", "mt_receipts01", "--inputs", "-"],
            "stdin": '{"note": "Team lunch"}',
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NO_RUN]},
        },
    ),
    (
        "template",
        _EarlyInterrupt.CLIENT,
        {
            "name": "early/template",
            "argv": ["run", "--method", "mt_receipts01", "--inputs-template"],
            "expect": {"exit_code": 130, "stdout": "", "stderr": ["Interrupted.\n"]},
        },
    ),
    (
        "script",
        _EarlyInterrupt.CLIENT,
        {
            "name": "early/script",
            "argv": ["script", "--method", "github.com/acme/methods/receipt-review@v1.0.0"],
            "expect": {
                "exit_code": 130,
                "stdout": "",
                "stderr": ["Interrupted. Nothing was written.\n"],
                "absent_files": ["receipt-review"],
            },
        },
    ),
]

_PIPE_IO_FOR_ADDRESS: dict[str, Any] = {
    "request_body": {"method_ref": "github.com/acme/methods/receipt-review@v1.0.0"},
    "answer": "pipe-io/receipt-review",
}


class _BlockedRead:
    """A named pipe the command reads and nobody writes to, so the read blocks, and Ctrl-C pressed then.

    The writer's end is opened as soon as the command has the pipe open for reading, which leaves the
    command blocked in its read, and the main thread is then interrupted as Ctrl-C would. Closing the
    writer's end ends the read; it is closed once the command has returned, or after the budget, so
    that a command left waiting for the read fails its test rather than hang it.
    """

    def __init__(self, fifo: Path) -> None:
        os.mkfifo(fifo)
        self._fifo = fifo
        self._lock = threading.Lock()
        self._writer: int | None = None
        self._thread = threading.Thread(target=self._interrupt, daemon=True)
        self._watchdog = threading.Timer(_BLOCKED_READ_BUDGET_SECONDS, self.release)

    def __enter__(self) -> Self:
        self._thread.start()
        self._watchdog.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._watchdog.cancel()
        self._thread.join(timeout=_BLOCKED_READ_BUDGET_SECONDS)
        self.release()

    def _interrupt(self) -> None:
        while True:
            try:
                writer = os.open(self._fifo, os.O_WRONLY | os.O_NONBLOCK)
            except OSError as exc:
                if exc.errno != errno.ENXIO:
                    raise
                time.sleep(0.01)
            else:
                with self._lock:
                    self._writer = writer
                break
        time.sleep(0.05)
        signal.pthread_kill(threading.main_thread().ident or 0, signal.SIGINT)

    def release(self) -> None:
        with self._lock:
            if self._writer is not None:
                os.close(self._writer)
                self._writer = None


class TestCli:
    def test_the_table_is_one_this_suite_can_read(self) -> None:
        assert _unknown_fields(_TABLE, _TABLE_FIELDS) == []
        names = [case["name"] for case in _CASES]
        assert len(set(names)) == len(names)
        for name, answer in _ANSWERS.items():
            assert _unknown_fields(answer, _EXCHANGE_FIELDS) == [], name

    @pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
    def test_case(self, case: dict[str, Any], tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        # A case this suite cannot run fails here, naming what it does not know.
        assert _unrunnable(case) == []
        if "interrupt" in case:
            # The event loop turns SIGINT into a cancellation only when it finds Python's own handler.
            assert signal.getsignal(signal.SIGINT) is signal.default_int_handler
        root = tmp_path.resolve()

        outcome = _run_case(case, root, mocker, monkeypatch)

        _check(case, outcome, root)

    # ── An interrupt the table cannot express ─────────────────────────────────────────────────────

    @pytest.mark.parametrize(("early", "case"), [(early, case) for _, early, case in _EARLY_SCENARIOS], ids=[name for name, _, _ in _EARLY_SCENARIOS])
    def test_an_interrupt_before_any_request_sends_nothing(
        self, early: _EarlyInterrupt, case: dict[str, Any], tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        root = tmp_path.resolve()

        outcome = _run_case(case, root, mocker, monkeypatch, early=early)

        _check(case, outcome, root)
        assert outcome.api.calls == {}, outcome.shown

    def test_an_interrupt_while_the_pipe_io_answer_is_read_uploads_nothing(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        case: dict[str, Any] = {
            "name": "between/pipe-io",
            "argv": ["run", "--method", "github.com/acme/methods/receipt-review@v1.0.0", "--inputs", "inputs.json"],
            "files": [
                {"path": "inputs.json", "text": '{"receipt": "scans/receipt.pdf", "note": "Team lunch"}\n'},
                {"path": "scans/receipt.pdf", "text": "%PDF-1.4 a receipt\n"},
            ],
            "routes": {"POST /v1/pipe-io": [_PIPE_IO_FOR_ADDRESS]},
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NO_RUN]},
        }
        root = tmp_path.resolve()

        outcome = _run_case(case, root, mocker, monkeypatch, interrupt_while_answering="POST /v1/pipe-io")

        _check(case, outcome, root)
        assert outcome.api.calls == {"POST /v1/pipe-io": 1}, outcome.shown

    def test_an_interrupt_while_the_version_answer_is_read_sends_no_start(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        case: dict[str, Any] = {
            "name": "between/version",
            "argv": ["run", "--method", "mt_receipts01"],
            "routes": {"GET /v1/version": [{"answer": "version/hosted"}]},
            # No request that may create a run was about to leave, so none was started, and the command says so.
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NO_RUN], "stderr_excludes": ["may or may not"]},
        }
        root = tmp_path.resolve()

        outcome = _run_case(case, root, mocker, monkeypatch, interrupt_while_answering="GET /v1/version")

        _check(case, outcome, root)
        assert outcome.api.calls == {"GET /v1/version": 1}, outcome.shown

    def test_an_interrupt_during_a_blocked_read_of_the_inputs_ends_the_command(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        root = tmp_path.resolve()
        case: dict[str, Any] = {
            "name": "blocked/inputs",
            "argv": ["run", "--method", "mt_receipts01", "--inputs", "inputs.json"],
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NO_RUN]},
        }
        started_at = time.monotonic()
        with _BlockedRead(root / "inputs.json"):
            outcome = _run_case(case, root, mocker, monkeypatch)

        assert time.monotonic() - started_at < _BLOCKED_READ_BUDGET_SECONDS, outcome.shown
        _check(case, outcome, root)
        assert outcome.api.calls == {}, outcome.shown

    def test_an_interrupt_during_a_blocked_read_of_a_file_to_upload_ends_the_command(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The file is read on a worker thread, which an interrupt cannot stop: the command must not wait for it."""
        root = tmp_path.resolve()
        (root / "scans").mkdir()
        case: dict[str, Any] = {
            "name": "blocked/upload",
            "argv": ["run", "--method", "github.com/acme/methods/receipt-review@v1.0.0", "--inputs", "inputs.json"],
            "files": [{"path": "inputs.json", "text": '{"receipt": "scans/receipt.pdf", "note": "Team lunch"}\n'}],
            "routes": {"POST /v1/pipe-io": [_PIPE_IO_FOR_ADDRESS]},
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NO_RUN]},
        }
        started_at = time.monotonic()
        # Leaving the block closes the writer, which ends the read the command abandoned, and its thread.
        with _BlockedRead(root / "scans" / "receipt.pdf"):
            outcome = _run_case(case, root, mocker, monkeypatch)

        assert time.monotonic() - started_at < _BLOCKED_READ_BUDGET_SECONDS, outcome.shown
        _check(case, outcome, root)
        assert outcome.api.calls == {"POST /v1/pipe-io": 1}, outcome.shown

    def test_an_interrupt_during_the_last_check_before_the_write_writes_nothing(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ctrl-C while `script` checks that the name its catalog entry gave is free: nothing is written, and it says so."""
        case: dict[str, Any] = {
            **_case_named("script/catalog-id"),
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NOTHING_WRITTEN], "absent_files": ["resume-review-v2"]},
        }
        root = tmp_path.resolve()

        def interrupted(*_: object) -> None:
            # Outside the event loop, Python's own handler raises `KeyboardInterrupt` right here.
            signal.raise_signal(signal.SIGINT)

        check_free = mocker.patch("pipelex_sdk.command.script._check_free", side_effect=interrupted)
        outcome = _run_case(case, root, mocker, monkeypatch)

        _check(case, outcome, root)
        check_free.assert_called_once_with(".", "resume-review-v2")
        assert list(root.iterdir()) == [], outcome.shown

    def test_an_interrupt_during_the_write_is_held_until_the_file_is_whole(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ctrl-C while the script is written waits for the file to be whole, then says it was written."""
        case = _script_written_then_interrupted()
        root = tmp_path.resolve()
        mocker.patch("pipelex_sdk.command.script.os.write", side_effect=_write_interrupted())

        outcome = _run_case(case, root, mocker, monkeypatch)

        _check(case, outcome, root)

    def test_a_second_interrupt_during_the_write_stops_it_and_removes_the_file(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A second Ctrl-C is not held, so a write that blocks can still be stopped: what it wrote is removed."""
        case: dict[str, Any] = {
            **_case_named("script/catalog-id"),
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NOTHING_WRITTEN], "absent_files": ["resume-review-v2"]},
        }
        root = tmp_path.resolve()
        mocker.patch("pipelex_sdk.command.script.os.write", side_effect=_write_interrupted(interrupts=2))

        outcome = _run_case(case, root, mocker, monkeypatch)

        _check(case, outcome, root)
        assert list(root.iterdir()) == [], outcome.shown

    def test_an_interrupt_held_once_the_file_is_whole_says_it_was_written(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ctrl-C once the file is whole, while the interrupt is still held, says it was written."""
        case = _script_written_then_interrupted()
        root = tmp_path.resolve()

        def write_then_interrupt(target: str, body: str, progress: Progress) -> None:
            _write_script(target, body, progress)
            signal.raise_signal(signal.SIGINT)

        mocker.patch("pipelex_sdk.command.script._write_script", side_effect=write_then_interrupt)

        outcome = _run_case(case, root, mocker, monkeypatch)

        _check(case, outcome, root)

    def test_an_interrupt_after_the_hold_says_the_file_was_written(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ctrl-C once the hold is over, as the command prints the script's path, says the file was written."""
        case = _script_written_then_interrupted()
        root = tmp_path.resolve()

        outcome = _run_case(case, root, mocker, monkeypatch, interrupt_while_printing=True)

        _check(case, outcome, root)

    def test_an_ignored_interrupt_stays_ignored_during_the_write(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Started with SIGINT ignored, as a background job may be, the command is not stopped by one meanwhile."""
        case = _case_named("script/catalog-id")
        root = tmp_path.resolve()
        mocker.patch("pipelex_sdk.command.script.os.write", side_effect=_write_interrupted())
        previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            outcome = _run_case(case, root, mocker, monkeypatch)
        finally:
            signal.signal(signal.SIGINT, previous)

        _check(case, outcome, root)

    def test_a_write_that_fails_once_the_file_exists_removes_it(self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        """A disk that fills up during the write leaves no truncated script, which would run half a command."""
        case: dict[str, Any] = {
            **_case_named("script/catalog-id"),
            "expect": {
                "exit_code": 2,
                "stdout": "",
                "stderr": ['Error: cannot write "./resume-review-v2".\nReason: ENOSPC\n'],
                "absent_files": ["resume-review-v2"],
            },
        }
        root = tmp_path.resolve()
        mocker.patch("pipelex_sdk.command.script.os.write", side_effect=_write_failing())

        outcome = _run_case(case, root, mocker, monkeypatch)

        _check(case, outcome, root)
        assert list(root.iterdir()) == [], outcome.shown

    def test_an_interrupt_while_the_last_answer_is_read_writes_nothing(
        self, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ctrl-C while the catalog entry, the last answer `script` needs, is read: the task is cancelled, not finished."""
        case: dict[str, Any] = {
            **_case_named("script/catalog-id"),
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NOTHING_WRITTEN], "absent_files": ["resume-review-v2"]},
        }
        root = tmp_path.resolve()

        outcome = _run_case(case, root, mocker, monkeypatch, interrupt_while_answering="GET /v1/methods/mt_receipts01")

        _check(case, outcome, root)
        assert list(root.iterdir()) == [], outcome.shown

    @pytest.mark.parametrize("moment", ["while-closing", "once-the-task-is-done"])
    def test_an_interrupt_after_the_last_answer_writes_nothing(
        self, moment: str, tmp_path: Path, mocker: MockerFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Ctrl-C while the API client closes, or once the command's task is done and the loop is winding down: the
        interrupt is not lost, and the loop's close does not fail over it.
        """
        case: dict[str, Any] = {
            **_case_named("script/catalog-id"),
            "expect": {"exit_code": 130, "stdout": "", "stderr": [_NOTHING_WRITTEN], "absent_files": ["resume-review-v2"]},
        }
        root = tmp_path.resolve()
        real_aclose = httpx.AsyncClient.aclose

        async def aclose(client: httpx.AsyncClient) -> None:
            await real_aclose(client)
            if moment == "while-closing":
                signal.raise_signal(signal.SIGINT)
            else:
                # Queued ahead of the task's own completion, so it runs once the task is done.
                asyncio.get_running_loop().call_soon(signal.raise_signal, signal.SIGINT)

        mocker.patch.object(httpx.AsyncClient, "aclose", aclose)
        outcome = _run_case(case, root, mocker, monkeypatch)

        _check(case, outcome, root)
        assert list(root.iterdir()) == [], outcome.shown
