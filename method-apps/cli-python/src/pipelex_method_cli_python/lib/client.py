"""The one place a `PipelexAPIClient` is constructed.

The key comes from `PIPELEX_API_KEY` and the base URL from `PIPELEX_BASE_URL`, in the shell or in a
`.env` file the command loads without overriding the shell. The base URL is left to the SDK to
resolve, so it keeps the SDK's rules: the hosted default, `https://api.pipelex.com`, when the
variable is unset, and a clear refusal when it is set but empty or carries a path. The key is read
here, because every route this CLI calls needs one and an anonymous request would only come back as
a `401` after the run's inputs were read: a missing key is refused before anything is sent.

Every module that talks to the API calls `make_client()` through this module rather than importing
the function, so a test replaces it in one place with a fake (`tests/conftest.py`) and never mocks
the `pipelex_sdk` package.
"""

import os
from importlib.metadata import PackageNotFoundError, version

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.user_agent import AppInfo

from pipelex_method_cli_python.lib.app import COMMAND_NAME, DISTRIBUTION_NAME, AppError

API_KEY_ENV = "PIPELEX_API_KEY"


class MissingApiKeyError(AppError):
    """`PIPELEX_API_KEY` is not set, in the shell or in a `.env` file."""


def app_info() -> AppInfo:
    """This CLI's own name and version, placed before the SDK's in the `User-Agent` every request carries."""
    try:
        installed = version(DISTRIBUTION_NAME)
    except PackageNotFoundError:
        installed = None
    return AppInfo(name=COMMAND_NAME, version=installed)


def make_client() -> PipelexAPIClient:
    """A client for the configured Pipelex API, used as `async with make_client() as client:`.

    Raises:
        MissingApiKeyError: `PIPELEX_API_KEY` is unset or blank.
        PipelineRequestError: `PIPELEX_BASE_URL` is set but is not a host-only http(s) URL.
    """
    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        msg = f"{API_KEY_ENV} is not set."
        raise MissingApiKeyError(msg, hint=f"Set {API_KEY_ENV} in your shell or in a .env file; get a key at https://app.pipelex.com.")
    return PipelexAPIClient(api_key=api_key, app_info=app_info())
