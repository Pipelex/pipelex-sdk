"""The `pipelex-sdk` executable, which `pyproject.toml` declares as the package's one console script,
so that `uvx pipelex-sdk run …` runs it. It hands the command the real process — its arguments, its
environment and its streams — and exits with the command's code (`docs/cli.md`).

Nothing in the SDK imports this module or `pipelex_sdk.command`, so importing the SDK as a library
never loads the command (`tests/unit/test_cli_packaging.py` holds it).
"""

from __future__ import annotations

import os
import re
import sys
from typing import TYPE_CHECKING

from pipelex_sdk.command.io import CommandIO
from pipelex_sdk.command.main import run_command

if TYPE_CHECKING:
    from typing import BinaryIO

# A lone surrogate, which a string can hold and no UTF-8 stream can carry: written as U+FFFD, as Node
# writes one, so the two commands put the same bytes on a stream.
_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


class _Stream:
    """One of the process's output streams, written as UTF-8 whatever the locale says.

    A reader that stops early (`| head`) closes the pipe, and there is nothing left to tell it: the
    stream then points at the null device, so neither a later write nor the interpreter's own flush
    at exit reports the broken pipe.
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
    return sys.stdin.buffer.read()


def main() -> None:
    """Run the command on the process's arguments and exit with its code."""
    stdout = _Stream(sys.stdout.buffer)
    stderr = _Stream(sys.stderr.buffer)
    io = CommandIO(env=os.environ, read_stdin=_read_stdin, write_stdout=stdout.write, write_stderr=stderr.write)
    sys.exit(run_command(sys.argv[1:], io))


if __name__ == "__main__":
    main()
