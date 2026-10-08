"""The `pipelex-sdk` command: `run` runs a method and prints its main output, `script` writes the
per-method shell script. `docs/cli.md` describes both, and `tests/fixtures/cli-cases.json` records
what each prints for every case, which `@pipelex/sdk`'s command of the same name answers too.

Nothing in the SDK imports this package, and `pipelex_sdk/cli.py`, the executable, is its only
caller: the command sits at the top of the dependency graph, and reaches the SDK only through its
public modules, as any other caller would.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from pipelex_sdk.command.help import MAIN_HELP
from pipelex_sdk.command.io import EXIT_INTERRUPTED, EXIT_OK, Progress, usage_error, write_lines
from pipelex_sdk.command.present import present_error
from pipelex_sdk.command.run import run_command_run
from pipelex_sdk.command.script import run_command_script
from pipelex_sdk.version import __version__

if TYPE_CHECKING:
    from collections.abc import Sequence

    from pipelex_sdk.command.io import CommandIO


def run_command(argv: Sequence[str], io: CommandIO) -> int:
    """Run the command on `argv`, the arguments after the command's own name, and return its exit code:
    0 when it did what it was asked, 1 when the run failed or the API refused it, 2 for a usage error
    and 130 when interrupted. Every failure is printed on stderr before it returns; it never raises.

    An interrupt arrives as a `KeyboardInterrupt`: raised where the command stood while it did its
    local work, and raised by `asyncio.run` once it has cancelled the wait and the wait has unwound.
    Either way the run, if one started, keeps going on the server, and `Progress` says which it was.
    """
    progress = Progress()
    try:
        return _dispatch(argv, io, progress)
    except (KeyboardInterrupt, asyncio.CancelledError):
        write_lines(io, [progress.interrupt_message])
        return EXIT_INTERRUPTED
    except Exception as exc:  # the command's top level: every failure is printed as sentences, never as a traceback
        presented = present_error(exc)
        write_lines(io, presented.lines)
        return presented.exit_code


def _dispatch(argv: Sequence[str], io: CommandIO, progress: Progress) -> int:
    if not argv:
        msg = "name a command: run or script."
        raise usage_error(msg, ["Run 'pipelex-sdk --help' to see what each does."])
    command, rest = argv[0], argv[1:]
    match command:
        case "--help" | "-h":
            io.write_stdout(MAIN_HELP)
            return EXIT_OK
        case "--version":
            io.write_stdout(f"{__version__}\n")
            return EXIT_OK
        case "run":
            return run_command_run(rest, io, progress)
        case "script":
            return run_command_script(rest, io, progress)
        case _:
            msg = f"unknown option {command}." if command.startswith("-") else f'unknown command "{command}".'
            raise usage_error(msg, ["The commands are run and script. Run 'pipelex-sdk --help' to see what each does."])
