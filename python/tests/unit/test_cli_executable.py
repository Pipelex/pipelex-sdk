"""The `pipelex-sdk` executable as a process: its streams and its end.

Each test runs `pipelex_sdk.cli.main` in a child interpreter whose environment holds no key and names a
base URL nothing listens on, so no case can reach a real API, and each one stops before any request.
"""

from __future__ import annotations

import errno
import os
import signal
import subprocess  # ruff: ignore[suspicious-subprocess-import]
import sys
import time
from pathlib import Path

import pytest

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent
_RUN_MAIN = "from pipelex_sdk.cli import main; main()"
# Port 9 is the discard port: nothing answers there, and no case gets as far as a request anyway.
_ENV = {"PATH": os.environ.get("PATH", ""), "PIPELEX_BASE_URL": "http://127.0.0.1:9"}
_BUDGET_SECONDS = 20.0


def _closed_pipe() -> int:
    """A pipe's writing end whose reader is already gone, as `| head` leaves one."""
    reader, writer = os.pipe()
    os.close(reader)
    return writer


def _spawn(argv: list[str], *, stdout: int, stderr: int) -> subprocess.Popen[bytes]:
    return subprocess.Popen(  # ruff: ignore[subprocess-without-shell-equals-true]
        [sys.executable, "-c", _RUN_MAIN, *argv], stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL, env=_ENV, cwd=_PACKAGE_ROOT
    )


class TestCliExecutable:
    def test_a_closed_stdout_ends_nothing(self) -> None:
        writer = _closed_pipe()
        try:
            child = _spawn(["--help"], stdout=writer, stderr=subprocess.PIPE)
        finally:
            os.close(writer)
        _, err = child.communicate(timeout=_BUDGET_SECONDS)

        assert child.returncode == 0, err.decode()
        assert err == b""

    def test_a_closed_stderr_ends_nothing(self) -> None:
        # The usage error goes to stderr, whose reader is gone: the command still ends as it would have,
        # with the usage error's code, rather than with a traceback about the broken pipe.
        writer = _closed_pipe()
        try:
            child = _spawn(["run"], stdout=subprocess.PIPE, stderr=writer)
        finally:
            os.close(writer)
        out, _ = child.communicate(timeout=_BUDGET_SECONDS)

        assert child.returncode == 2
        assert out == b""

    @pytest.mark.skipif(os.name != "posix", reason="a shell closes the stdin here")
    def test_a_closed_stdin_reads_as_empty(self) -> None:
        # Started with no stdin at all, as `<&-` leaves it, the interpreter has no `sys.stdin`: `--inputs -`
        # reads it as empty, as Node does, rather than failing on the missing stream.
        child = subprocess.run(  # ruff: ignore[subprocess-without-shell-equals-true]
            ["/bin/sh", "-c", 'exec "$0" -c "$1" run --method mt_receipts01 --inputs - <&-', sys.executable, _RUN_MAIN],
            capture_output=True,
            env=_ENV,
            cwd=_PACKAGE_ROOT,
            timeout=_BUDGET_SECONDS,
            check=False,
        )

        assert child.returncode == 2, child.stderr.decode()
        assert child.stderr.decode().startswith("Error: stdin is not valid JSON.\nReason: ")
        assert child.stdout == b""

    @pytest.mark.skipif(os.name != "posix", reason="named pipes and SIGINT are POSIX")
    def test_ctrl_c_during_a_blocked_read_says_so_and_ends_by_the_signal(self, tmp_path: Path) -> None:
        inputs = tmp_path / "inputs.json"
        os.mkfifo(inputs)
        child = _spawn(["run", "--method", "mt_receipts01", "--inputs", str(inputs)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        writer: int | None = None
        try:
            # Opening the writer's end succeeds once the command has the pipe open for reading, which
            # leaves it blocked in the read, since nothing is written.
            deadline = time.monotonic() + _BUDGET_SECONDS
            while writer is None and time.monotonic() < deadline:
                try:
                    writer = os.open(inputs, os.O_WRONLY | os.O_NONBLOCK)
                except OSError as exc:
                    if exc.errno != errno.ENXIO:
                        raise
                    time.sleep(0.01)
            assert writer is not None, "the command never opened the inputs file"
            time.sleep(0.1)
            child.send_signal(signal.SIGINT)
            out, err = child.communicate(timeout=_BUDGET_SECONDS)
        finally:
            if writer is not None:
                os.close(writer)
            if child.poll() is None:
                child.kill()

        assert child.returncode == -signal.SIGINT, err.decode()
        assert out == b""
        assert err.decode() == "Interrupted. No run was started.\n"
