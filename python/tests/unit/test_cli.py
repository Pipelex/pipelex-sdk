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
import json
import signal
from itertools import starmap
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import httpx
import pytest

from pipelex_sdk.command.io import CommandIO
from pipelex_sdk.command.main import run_command
from pipelex_sdk.version import __version__

if TYPE_CHECKING:
    from collections.abc import Mapping

    from pytest_mock import MockerFixture

# ── The table's shape ─────────────────────────────────────────────────────────────────────────────

_TABLE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "cli-cases.json"
_TABLE: dict[str, Any] = json.loads(_TABLE_PATH.read_text(encoding="utf-8"))
_CASES: list[dict[str, Any]] = _TABLE["cases"]
_ANSWERS: dict[str, dict[str, Any]] = _TABLE["answers"]
_BASE_URL = httpx.URL(_TABLE["base_url"])
_BASE_ORIGIN = f"{_BASE_URL.scheme}://{_BASE_URL.netloc.decode('ascii')}"

# Every field this suite knows how to run. Anything else in the table is a case it cannot run.
_TABLE_FIELDS = ["about", "base_url", "env", "placeholders", "answers", "cases"]
_CASE_FIELDS = ["name", "summary", "argv", "env", "files", "stdin", "routes", "interrupt", "expect"]
_EXPECT_FIELDS = ["exit_code", "stdout", "stdout_includes", "stderr", "stderr_excludes", "files", "absent_files"]
_FILE_FIELDS = ["path", "text", "base64", "symlink", "directory"]
_FILE_KINDS = ["text", "base64", "symlink", "directory"]
_EXCHANGE_FIELDS = ["request_body", "answer", "status", "headers", "body", "text", "unreachable"]
_PLACEHOLDER_LANGUAGE = "python"


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
    """A request body as JSON, without the top-level keys sent as `null` or `false`, which mean "absent"."""
    if not content:
        return None
    parsed: Any = json.loads(content)
    if not isinstance(parsed, dict):
        return parsed
    members = cast("dict[str, Any]", parsed)
    return {key: value for key, value in members.items() if value is not None and value is not False}


class _RecordedApi:
    """The API answering from a case's routes. A route is `METHOD /path?query` on the table's base URL;
    its exchanges answer its calls in order, each once. A request the case did not record, to another
    origin or without the case's key, is a problem the case reports.
    """

    def __init__(self, case: dict[str, Any], env: dict[str, str]) -> None:
        self.case = case
        self.env = env
        self.problems: list[str] = []
        self.calls: dict[str, int] = {}

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
        if answer.get("unreachable") is True:
            msg = "connect ECONNREFUSED"
            raise httpx.ConnectError(msg, request=request)
        headers: dict[str, str] = dict(answer.get("headers", {}))
        content = b""
        if "body" in answer:
            content = json.dumps(answer["body"], ensure_ascii=False).encode("utf-8")
            if "content-type" not in {name.lower() for name in headers}:
                headers["content-type"] = "application/json"
        elif "text" in answer:
            content = cast("str", answer["text"]).encode("utf-8")
        return httpx.Response(answer.get("status", 200), headers=headers, content=content)

    def unserved(self) -> list[str]:
        """Every recorded exchange the command never asked for."""
        left: list[str] = []
        for key, exchanges in cast("dict[str, list[Any]]", self.case.get("routes", {})).items():
            served = self.calls.get(key, 0)
            if served < len(exchanges):
                left.append(f"{key}: {len(exchanges) - served} never asked for")
        return left


# ── Running a case ────────────────────────────────────────────────────────────────────────────────


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
            # `asyncio.run` turns SIGINT into a cancellation only when it finds Python's own handler.
            assert signal.getsignal(signal.SIGINT) is signal.default_int_handler
        root = tmp_path.resolve()
        _materialize(root, case.get("files", []))
        env = _case_env(case)
        api = _RecordedApi(case, env)
        real_async_client = httpx.AsyncClient

        def recorded_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
            return real_async_client(*args, transport=httpx.MockTransport(api.handle), **kwargs)

        mocker.patch.object(httpx, "AsyncClient", recorded_client)
        monkeypatch.chdir(root)
        stdout: list[str] = []
        stderr: list[str] = []
        stdin = cast("str", case.get("stdin", "")).encode("utf-8")
        io = CommandIO(env=env, read_stdin=lambda: stdin, write_stdout=stdout.append, write_stderr=stderr.append)

        exit_code = run_command(case["argv"], io)

        out = "".join(stdout)
        err = "".join(stderr)
        shown = f"stdout:\n{out}\nstderr:\n{err}"
        assert api.problems == [], shown
        assert api.unserved() == [], shown
        assert exit_code == case["expect"]["exit_code"], shown
        expect: dict[str, Any] = case["expect"]
        if "stdout" in expect:
            assert out == _fill(expect["stdout"]), shown
        if "stdout_includes" in expect:
            assert _first_missing(out, [_fill(needle) for needle in expect["stdout_includes"]]) is None, shown
        assert _first_missing(err, [_fill(needle) for needle in expect.get("stderr", [])]) is None, shown
        for excluded in expect.get("stderr_excludes", []):
            assert _fill(excluded) not in err, shown
        for file in expect.get("files", []):
            target = root / file["path"]
            assert target.read_bytes().decode("utf-8") == _fill(file["text"])
            if file.get("executable") is True:
                assert target.stat().st_mode & 0o100, f"{file['path']} is not executable"
        for absent in expect.get("absent_files", []):
            assert not (root / absent).exists(), f"{absent} exists"
