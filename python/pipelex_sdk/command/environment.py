"""What the command reads from its environment, and the client it builds from it.

The key comes from `PIPELEX_API_KEY` and nowhere else: a flag would put it in the shell's history and
the process list. The API's address comes from `PIPELEX_BASE_URL`, the hosted API when it is not set. An
empty variable counts as unset, except `PIPELEX_BASE_URL`: an empty one, such as an unfilled CI secret,
reaches the SDK, which refuses it, rather than send the key to the hosted API by default. No `.env`
file is read: a command started through `uvx` from wherever the person stands would otherwise pick a
credential from whichever file it found there.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from pipelex_sdk.client import DEFAULT_API_BASE_URL, PipelexAPIClient
from pipelex_sdk.command.io import usage_error
from pipelex_sdk.errors import RequestArgumentError
from pipelex_sdk.user_agent import AppInfo
from pipelex_sdk.version import __version__

if TYPE_CHECKING:
    from pipelex_sdk.command.io import CommandIO

API_KEY_VARIABLE = "PIPELEX_API_KEY"
BASE_URL_VARIABLE = "PIPELEX_BASE_URL"

#: The poll interval in milliseconds, for tests only: the recorded case table sets it to `0`, so that a
#: run answered "still running" is polled again at once. A person has no reason to set it; unset, the
#: SDK's own interval applies. `@pipelex/sdk`'s command reads the same variable.
POLL_INTERVAL_VARIABLE = "PIPELEX_SDK_POLL_INTERVAL_MS"

#: The name the command gives itself in the `User-Agent` of every request, before the SDK's own.
CLIENT_APP_NAME = "pipelex-sdk-cli"

_WHOLE_NUMBER = re.compile(r"[0-9]+")
_MILLISECONDS_PER_SECOND = 1000


def _variable(io: CommandIO, name: str) -> str | None:
    return io.env.get(name) or None


def read_poll_interval(io: CommandIO) -> float | None:
    """The test-only poll interval, in seconds, or `None` for the SDK's own.

    Raises:
        CommandError: A usage error when it is set to anything but a whole number of milliseconds.
    """
    value = _variable(io, POLL_INTERVAL_VARIABLE)
    if value is None:
        return None
    if _WHOLE_NUMBER.fullmatch(value) is None:
        msg = f"{POLL_INTERVAL_VARIABLE} must be a whole number of milliseconds."
        raise usage_error(msg)
    return int(value) / _MILLISECONDS_PER_SECOND


def make_client(io: CommandIO) -> PipelexAPIClient:
    """The client every request goes through, built from the key and the base URL.

    Raises:
        CommandError: A usage error when the key is missing or the base URL is refused. The refusal
            never quotes the key, and the SDK's refusal of a base URL never quotes the parts of it
            that can carry a secret.
    """
    api_key = _variable(io, API_KEY_VARIABLE)
    if api_key is None:
        msg = f"{API_KEY_VARIABLE} is not set."
        raise usage_error(
            msg,
            [
                f"Get a key at https://app.pipelex.com and export it: export {API_KEY_VARIABLE}=<your key>",
                "This command reads no .env file; to load one into the shell, run: set -a; . ./.env; set +a",
            ],
        )
    # Absent, not empty, means the hosted API: the SDK refuses an empty base URL on purpose.
    base_url = io.env.get(BASE_URL_VARIABLE)
    try:
        return PipelexAPIClient(
            api_key=api_key,
            base_url=DEFAULT_API_BASE_URL if base_url is None else base_url,
            app_info=AppInfo(name=CLIENT_APP_NAME, version=__version__),
        )
    except RequestArgumentError as exc:
        msg = f"{BASE_URL_VARIABLE} is refused."
        raise usage_error(msg, [f"Reason: {exc}"]) from exc
