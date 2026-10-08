"""The `pipelex-sdk` command: `run` runs a method and prints its main output, `script` writes the
per-method shell script. `docs/cli.md` describes both, and `tests/fixtures/cli-cases.json` records
what each prints for every case, which `@pipelex/sdk`'s command of the same name answers too.

Nothing in the SDK imports this package, and `pipelex_sdk/cli.py`, the executable, is its only
caller: the command sits at the top of the dependency graph, and reaches the SDK only through its
public modules, as any other caller would.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from pydantic import ValidationError

from pipelex_sdk.command.help import MAIN_HELP
from pipelex_sdk.command.io import (
    EXIT_INTERRUPTED,
    EXIT_OK,
    RUN_MAY_HAVE_STARTED_LINE,
    Progress,
    run_still_going_line,
    usage_error,
    write_lines,
)
from pipelex_sdk.command.present import present_error
from pipelex_sdk.command.run import run_command_run
from pipelex_sdk.command.script import run_command_script
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    MissingMainStuffError,
    PipelineExecuteTimeoutError,
    RunFailedError,
)
from pipelex_sdk.version import __version__

if TYPE_CHECKING:
    from collections.abc import Sequence

    from pipelex_sdk.command.io import CommandIO


def run_command(argv: Sequence[str], io: CommandIO) -> int:
    """Run the command on `argv`, the arguments after the command's own name, and return its exit code:
    0 when it did what it was asked, 1 when the run failed or the API refused it, 2 for a usage error
    and 130 when interrupted. Every failure is printed on stderr before it returns; it never raises.

    An interrupt arrives as a `KeyboardInterrupt`: raised where the command stood while it did its
    local work, and raised by the command's event loop once it has cancelled the wait and the wait has
    unwound (`loop.py`). Either way the run, if one started, keeps going on the server, and `Progress`
    says which it was.
    """
    progress = Progress()
    try:
        return _dispatch(argv, io, progress)
    except (KeyboardInterrupt, asyncio.CancelledError):
        write_lines(io, [progress.interrupt_message])
        return EXIT_INTERRUPTED
    except Exception as exc:  # the command's top level: every failure is printed as sentences, never as a traceback
        presented = present_error(exc)
        lines = presented.lines
        # A failed run, or a completed one without its output, is the run's own outcome. Any other
        # failure while waiting on a run that exists, an unreachable API or a refused poll, says
        # nothing of the run, which goes on: a wrapper must not read it as a failed run and pay for
        # another.
        if progress.waiting_on_run is not None and not isinstance(exc, (RunFailedError, MissingMainStuffError)):
            lines = [*lines, run_still_going_line(progress.waiting_on_run)]
        elif progress.starting and _may_have_started(exc):
            lines = [*lines, RUN_MAY_HAVE_STARTED_LINE]
        write_lines(io, lines)
        return presented.exit_code


#: The transport failures that prove the request never left, no connection having been made, so that
#: no run was created by it.
_NOTHING_SENT_CODES = frozenset({"ConnectError", "ConnectTimeout", "PoolTimeout", "UnsupportedProtocol"})

#: The gateway statuses that say the server's answer was lost or never came (RFC 9110).
_GATEWAY_LOST_ANSWER = frozenset({502, 504})


def _may_have_started(exc: Exception) -> bool:
    """Whether a failure met once a request that may create a run was sent, and before the API named the
    run, leaves it unknown whether one was created: its answer was lost to a time limit, a connection that
    closed once the request had left or a gateway that cut a blocking execute off, or it came back
    unreadable, or a gateway answered that it lost or never got the server's answer (`502`, `504`, RFC 9110).
    Any other answer from the API, a `503` saying the request was not handled included, and a failure that
    proves nothing was sent, say no run was created.
    """
    if isinstance(exc, PipelineExecuteTimeoutError):
        return True
    if isinstance(exc, ApiUnreachableError):
        return exc.code not in _NOTHING_SENT_CODES
    if isinstance(exc, ApiResponseError):
        return 200 <= exc.status < 300 or exc.status in _GATEWAY_LOST_ANSWER
    return isinstance(exc, (ValidationError, json.JSONDecodeError, UnicodeDecodeError))


def _dispatch(argv: Sequence[str], io: CommandIO, progress: Progress) -> int:
    if not argv:
        msg = "name a command: run or script."
        raise usage_error(msg, ["Run 'pipelex-sdk --help' to see what each does."])
    command, rest = argv[0], argv[1:]
    match command:
        case "--help" | "-h":
            # The help wins whatever follows it, as it does in a subcommand.
            io.write_stdout(MAIN_HELP)
            return EXIT_OK
        case "--version":
            # Unlike the help, the version is not printed over a command line it does not answer.
            if rest:
                msg = f'unexpected argument "{rest[0]}" after --version.'
                raise usage_error(msg, ["Run 'pipelex-sdk --version' alone to print the version."])
            io.write_stdout(f"{__version__}\n")
            return EXIT_OK
        case "run":
            return run_command_run(rest, io, progress)
        case "script":
            return run_command_script(rest, io, progress)
        case _:
            msg = f"unknown option {command}." if command.startswith("-") else f'unknown command "{command}".'
            raise usage_error(msg, ["The commands are run and script. Run 'pipelex-sdk --help' to see what each does."])
