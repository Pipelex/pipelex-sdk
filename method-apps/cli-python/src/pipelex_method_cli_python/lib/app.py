"""What every module of the CLI shares: its name, its run modes and the base of the errors it raises itself.

The names are the project's own. `make create` renames the distribution, the console script and the
import package after the method, so the two names here change with them.
"""

from enum import StrEnum

#: The console script, which is the name a person types and the one the hints print.
COMMAND_NAME = "pipelex-method-cli-python"

#: The distribution, whose installed version the `User-Agent` names.
DISTRIBUTION_NAME = "pipelex-method-cli-python"


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
    """

    def __init__(self, message: str, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
