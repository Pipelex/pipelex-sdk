"""The live legs' account, checked once before the first live case runs (`tests/e2e/live_account.py`).

The check is a session fixture every live case takes, so it runs when the first case that is not skipped sets up and
never when every leg skips for want of `PIPELEX_E2E_BASE_URL`. A refusal stops the whole session there, with its one
message, before any case reaches the platform.
"""

import asyncio

import pytest

from tests.e2e.live_account import PYTHON_E2E_TARGET, check_live_account


@pytest.fixture(scope="session", autouse=True)
def live_account() -> str:
    """The account the live legs act for, confirmed; the session stops on a refusal."""
    verdict = asyncio.run(check_live_account(PYTHON_E2E_TARGET))
    if verdict.verdict == "refused":
        pytest.exit(verdict.said, returncode=1)
    return verdict.said
