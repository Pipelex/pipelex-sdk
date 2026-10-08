"""The `pipelex-sdk` executable, which `pyproject.toml` declares as the package's one console script,
so that `uvx pipelex-sdk run …` runs it. It hands the command the real process — its arguments, its
environment and its streams — and exits with the command's code (`docs/cli.md`), or, after Ctrl-C, by
the signal itself.

Nothing in the SDK imports this module or `pipelex_sdk.command`, so importing the SDK as a library
never loads the command (`tests/unit/test_cli_packaging.py` holds it).
"""

from __future__ import annotations

import errno
import os
import re
import signal
import sys
from typing import TYPE_CHECKING, cast

from pipelex_sdk.command.io import EXIT_INTERRUPTED, CommandIO
from pipelex_sdk.command.main import run_command

if TYPE_CHECKING:
    from typing import BinaryIO, TextIO

# A lone surrogate, which a string can hold and no UTF-8 stream can carry: written as U+FFFD, as Node
# writes one, so both commands put the same bytes on a stream.
_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


class _Stream:
    """One of the process's output streams, written as UTF-8 whatever the locale says.

    A reader that stops early (`| head`, `2>&1 | head -1`) closes the pipe, on stdout or on stderr,
    and there is nothing left to tell it: the stream then points at the null device, so neither a
    later write nor the interpreter's own flush at exit reports the broken pipe, and the command,
    a run it started included, carries on.
    """

    def __init__(self, binary: BinaryIO) -> None:
        self._binary = binary
        self._closed = False

    def write(self, text: str) -> None:
        if self._closed:
            return
        try:
            self._binary.write(_LONE_SURROGATE.sub("\ufffd", text).encode("utf-8"))
            self._binary.flush()
        except BrokenPipeError:
            self._closed = True
            null_device = os.open(os.devnull, os.O_WRONLY)
            os.dup2(null_device, self._binary.fileno())
            os.close(null_device)


def _read_stdin() -> bytes:
    """All of stdin, raising the system's `OSError` when it cannot be read, as `CommandIO.read_stdin` does.

    A process started with its stdin closed has no `sys.stdin`. It reads as empty, as it does in the
    JavaScript command, whose Node opens the null device on a standard stream it starts without, so
    `--inputs -` then says stdin is not valid JSON in both. A `sys.stdin` this process closed or detached
    before the command ran has no descriptor left to read from, which is the system's `EBADF`: the command
    then says it cannot read stdin, as the JavaScript command does for a stream Node can no longer read.
    """
    stdin: TextIO | None = sys.stdin
    if stdin is None:
        return b""
    # `None` once the stream was detached, which the stream's declared type does not say.
    buffer = cast("BinaryIO | None", stdin.buffer)
    try:
        if buffer is not None:
            return buffer.read()
    except ValueError as exc:  # the stream was closed
        raise OSError(errno.EBADF, os.strerror(errno.EBADF)) from exc
    raise OSError(errno.EBADF, os.strerror(errno.EBADF))


def main() -> None:
    """Run the command on the process's arguments and exit with its code.

    After Ctrl-C the process ends by the signal itself, as Python ends one an uncaught
    `KeyboardInterrupt` stops, which a POSIX shell reports as the same status, 130, and which tells a
    calling shell loop that the person interrupted. Ending by the signal also skips the interpreter's
    wait for its threads, one of which can be blocked for good in a read the command stopped waiting
    for. Windows has no such signal to end by, and exits with 130.
    """
    stdout = _Stream(sys.stdout.buffer)
    stderr = _Stream(sys.stderr.buffer)
    io = CommandIO(env=os.environ, read_stdin=_read_stdin, write_stdout=stdout.write, write_stderr=stderr.write)
    code = run_command(sys.argv[1:], io)
    if code == EXIT_INTERRUPTED and os.name == "posix":
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        os.kill(os.getpid(), signal.SIGINT)
    sys.exit(code)


if __name__ == "__main__":
    main()
