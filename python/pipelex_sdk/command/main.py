"""The `pipelex-sdk` command: `run` runs a method and prints its main output, `script` writes the
per-method shell script. `docs/cli.md` describes both, and `tests/fixtures/cli-cases.json` records
what each prints for every case, which `@pipelex/sdk`'s command of the same name answers too.

Nothing in the SDK imports this package, and `pipelex_sdk/cli.py`, the executable, is its only
caller: the command sits at the top of the dependency graph, and reaches the SDK only through its
public modules, as any other caller would.
"""

from __future__ import annotations

import asyncio
import ssl
from typing import TYPE_CHECKING

from pipelex_sdk.client import is_gateway_cut_off
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
    from collections.abc import Iterator, Sequence

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
        starting_seconds = progress.starting_seconds()
        if progress.waiting_on_run is not None and not isinstance(exc, (RunFailedError, MissingMainStuffError)):
            lines = [*lines, run_still_going_line(progress.waiting_on_run)]
        elif starting_seconds is not None and _may_have_started(exc, starting_seconds):
            lines = [*lines, RUN_MAY_HAVE_STARTED_LINE]
        write_lines(io, lines)
        return presented.exit_code


#: The transport failures that can only come before the request leaves, as the `ApiUnreachableError`'s
#: `code` names httpx's: a connection whose set-up failed (`ConnectError`: an unknown host, a refused
#: connection, no route to the host or the network, the system giving up connecting, a server certificate
#: the TLS handshake refused), a connection not made within httpx's connect timeout, which covers the TCP
#: connect and the TLS handshake (`ConnectTimeout`), a request whose time limit ran out while it waited for a
#: connection from the pool (`PoolTimeout`), and a URL the client cannot send to (`UnsupportedProtocol`). Each
#: comes from the request's one attempt: the client's transport retries nothing, and httpx's pool moves a
#: request to another connection only when the first proved unavailable before anything was written on it.
#:
#: A host that drops packets is a connection that never comes, and each command meets its transport's connect
#: time limit first, which proves nothing was sent. Here it is httpx's connect timeout, which the one `timeout`
#: the client passes bounds: 30 seconds for a start that carries neither a bundle nor a `method_ref`, well
#: before the system gives up connecting, while a start given a longer limit may meet the system's first, a
#: `ConnectError` then. In `@pipelex/sdk` it is undici's own ten seconds (`UND_ERR_CONNECT_TIMEOUT`), which run
#: out before the time limit of any request that SDK's command sends, so the one failure its fetch cannot place
#: before or after the connection, that SDK's own time limit (`ABORT_TIMEOUT`), comes only once the request
#: has left.
_NOTHING_SENT_CODES = frozenset({"ConnectError", "ConnectTimeout", "PoolTimeout", "UnsupportedProtocol"})

#: The one code whose causes can show a failed TLS handshake that `@pipelex/sdk`'s command cannot tell from a
#: failure once the request had left.
_CONNECT_ERROR_CODE = "ConnectError"

#: What, under a `ConnectError`, says the TLS handshake failed for another reason than the server
#: certificate, or the connection dropped during it. Nothing was sent then either, yet `@pipelex/sdk`'s fetch
#: reports a dropped handshake as the same `ECONNRESET` a connection dropped once the request had left gives,
#: and another TLS failure as one that can come after the handshake, so both commands read these as they must
#: read those: a run may have started.
_HANDSHAKE_FAILURES: tuple[type[BaseException], ...] = (ssl.SSLError, ConnectionResetError, ConnectionAbortedError, BrokenPipeError)

#: The gateway statuses that say the server's answer was lost or never came (RFC 9110).
_GATEWAY_LOST_ANSWER = frozenset({502, 504})


def _may_have_started(exc: Exception, elapsed_seconds: float) -> bool:
    """Whether a failure met `elapsed_seconds` after a request that may create a run was sent, and before the
    API named the run, leaves it unknown whether one was created: its answer was lost to a time limit, a
    connection that closed once the request had left or a gateway that cut the request off, or it came back
    unreadable, or a gateway answered that it lost or never got the server's answer (`502`, `504`, RFC 9110).
    A gateway cuts a request off at ~30 seconds, whether a blocking execute or a start the server is still
    handling, such as one fetching a `method_ref`'s package: the SDK's `is_gateway_cut_off` tells it, past its
    threshold, from the time since `on_starting`. Any other answer from the API, a `503` that came back before
    that saying the request was not handled included, and a failure that proves nothing was sent, say no run
    was created.
    """
    if isinstance(exc, PipelineExecuteTimeoutError):
        return True
    if isinstance(exc, ApiUnreachableError):
        return not _proves_nothing_sent(exc)
    if isinstance(exc, ApiResponseError):
        return 200 <= exc.status < 300 or exc.status in _GATEWAY_LOST_ANSWER or is_gateway_cut_off(exc, elapsed_seconds)
    return False


def _proves_nothing_sent(exc: ApiUnreachableError) -> bool:
    """Whether a transport failure proves the request never left, so that no run was created by it: it names
    a step of the connection's set-up, which no request follows, and one `@pipelex/sdk`'s command can tell
    from a failure that came once the request had left, so that both commands print the same for it.

    Only a `ConnectError` is searched for a failed handshake. A `ConnectTimeout` that ran out during the
    handshake carries the `ssl.SSLWantReadError` of the read it interrupted, and proves nothing was sent all
    the same, as undici's connect time limit, which covers the handshake too, does in `@pipelex/sdk`.
    """
    if exc.code not in _NOTHING_SENT_CODES:
        return False
    if exc.code != _CONNECT_ERROR_CODE:
        return True
    return not any(isinstance(cause, _HANDSHAKE_FAILURES) and not isinstance(cause, ssl.SSLCertVerificationError) for cause in _causes(exc))


def _causes(exc: BaseException) -> Iterator[BaseException]:
    """The exceptions `exc` was raised from, nearest first: httpx's own, then the transport's under it."""
    seen: set[int] = set()
    cause = exc.__cause__ or exc.__context__
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        yield cause
        cause = cause.__cause__ or cause.__context__


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
