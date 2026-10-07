"""What every module of the CLI shares: its name, its run modes and the base of the errors it raises itself.

The names are the project's own: the distribution's and the console script's, which are named after
the method, as the import package is.
"""

import os
import shlex
import shutil
import subprocess
import sys
from enum import StrEnum
from pathlib import Path

#: The console script, which is the name a person types and the one the hints print.
COMMAND_NAME = "pipelex-method-cli-python"

#: The distribution, whose installed version the `User-Agent` names.
DISTRIBUTION_NAME = "pipelex-method-cli-python"


def command_name(argv0: str | None = None) -> str:
    """The command as a hint prints it, so that the line pasted back runs the same command.

    A command found on the `PATH` prints as its bare name. One run by a path, as `.venv/bin/<name>`
    is until `uv tool install .` puts it on the `PATH`, prints as that path, quoted for the shell the
    platform runs it from (`shell_quote`), since its bare name would answer "command not found".
    `argv0` is `sys.argv[0]` unless a caller passes another; when it is not this console script at
    all, as under a test runner, the bare name is the answer.
    """
    invoked = sys.argv[0] if argv0 is None else argv0
    script = Path(invoked)
    # A console script on Windows is `<name>.exe`, so the stem is compared as well as the name.
    if COMMAND_NAME not in (script.name, script.stem):
        return COMMAND_NAME
    on_path = shutil.which(COMMAND_NAME)
    if on_path is not None and _same_file(Path(on_path), script):
        return COMMAND_NAME
    return shell_quote(invoked)


def is_windows() -> bool:
    """Whether the command runs on Windows, whose shell quotes an argument its own way."""
    return os.name == "nt"


def shell_quote(argument: str) -> str:
    """An argument as the platform's shell reads it back whole: in double quotes for cmd.exe on Windows, POSIX quoting elsewhere.

    `shlex.quote` writes POSIX single quotes, which cmd.exe passes through as part of the argument,
    so a quoted path pasted there names no file.
    """
    if is_windows():
        return subprocess.list2cmdline([argument])
    return shlex.quote(argument)


def _same_file(first: Path, second: Path) -> bool:
    """Whether two paths name one file, `False` when either cannot be resolved."""
    try:
        return first.resolve() == second.resolve()
    except OSError:
        return False


class RunMode(StrEnum):
    """How one invocation runs the method, chosen by the command's lifecycle flags."""

    #: The default: start a durable run, print its id on stderr, and wait here for its result.
    ATTENDED = "attended"
    #: `--blocking`: one request that returns the result, cut off at about 30 seconds behind the hosted gateway.
    BLOCKING = "blocking"
    #: `--detach`: start a durable run, print its id alone on stdout, and exit.
    DETACH = "detach"
    #: `--resume <run-id>`: wait for a run started earlier and print its result as an attended run would.
    RESUME = "resume"


class AppError(Exception):
    """A failure the CLI detects itself rather than one the SDK raises: a message and what to do about it.

    The command's error boundary presents it exactly as it presents an SDK error, on stderr with a
    non-zero exit, so a missing key or an unreadable inputs file reads like a refusal from the API.
    `details` are the lines printed under the message, such as each field of a result its model
    refused.
    """

    def __init__(self, message: str, *, hint: str | None = None, details: tuple[str, ...] = ()) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.details = details
