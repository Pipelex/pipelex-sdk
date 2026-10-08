"""What the `pipelex-sdk` command reads from and writes to, and the ways it stops early.

The command never touches `sys` or `os.environ` directly, apart from the current directory that
relative paths resolve against: `pipelex_sdk/cli.py`, the executable, hands it the real streams and
environment, and the test suite hands it its own. That is what lets one recorded case table drive
the command in-process, in this SDK and in its JavaScript twin (`docs/cli.md`).

An interrupt is not part of this world: Ctrl-C reaches the command as Python delivers it, a
`KeyboardInterrupt` while the command does its local work, and, once the command's event loop waits
on the API, a cancellation of the waiting task that the loop turns into a `KeyboardInterrupt` when
the task has unwound (`loop.py`). `Progress` holds what the command says when that happens.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

#: The command's exit codes (`docs/cli.md`): a script reads stdout, and these are presentation.
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_INTERRUPTED = 130


@dataclass(frozen=True)
class CommandIO:
    """The command's world: its environment and its three streams."""

    #: The environment the command reads: `PIPELEX_API_KEY`, `PIPELEX_BASE_URL` and the test-only
    #: `PIPELEX_SDK_POLL_INTERVAL_MS`. Nothing else is read from it, and no `.env` file is read.
    env: Mapping[str, str]
    #: All of stdin, as bytes. Read only for `--inputs -`.
    read_stdin: Callable[[], bytes]
    #: Write to stdout, which carries the result and nothing else.
    write_stdout: Callable[[str], None]
    #: Write to stderr, which carries everything that is not the result.
    write_stderr: Callable[[str], None]


class Progress:
    """Where the command stands, which decides what an interrupt and a failure say.

    Each stage sets the sentence an interrupt would print there, before the stage begins: nothing
    started yet, a run requested but not acknowledged, a run that exists and keeps going.
    `waiting_on_run` is the id of a run that exists and whose outcome the command is waiting for: a
    failure then, other than the run's own, leaves the run going on the server, and the command says
    so rather than let it read as a failed run.
    """

    def __init__(self) -> None:
        self.interrupt_message = "Interrupted."
        self.waiting_on_run: str | None = None


def run_still_going_line(run_id: str) -> str:
    """The line under a failure met while waiting on a run that exists: the run is not over, and a
    second one would be paid for again.
    """
    return f"Run {run_id} may still be going on the server, so do not start it again."


class CommandError(Exception):
    """A failure the command words itself: a usage error (exit code 2) or a refusal it reads off an
    answer (exit code 1).

    `message` is the sentence printed after `Error: `, and `details` are the lines printed under it,
    as they are.
    """

    def __init__(self, message: str, *, exit_code: int, details: list[str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code
        self.details: list[str] = details or []


def usage_error(message: str, details: list[str] | None = None) -> CommandError:
    """A usage error: something the person can fix on the command line or in the environment."""
    return CommandError(message, exit_code=EXIT_USAGE, details=details)


def write_lines(io: CommandIO, lines: list[str]) -> None:
    """Write each line to stderr, each ended by a newline."""
    io.write_stderr("".join(f"{line}\n" for line in lines))
