"""The live legs' account, checked once before the first live case runs (`tests/e2e/live_account.py`).

The check runs once collection is done, before any case and whatever the cases' skip marks say, so a hosted run with
no key or no expectations stops however the cases were selected, a single file included. It runs only when a live
case was collected, never under `--collect-only`, and a run with no `PIPELEX_E2E_BASE_URL` has no target to check. A
refusal stops the whole session there, with its one message, before any case reaches the platform.
"""

import asyncio
from pathlib import Path

import pytest

from tests.e2e.live_account import PYTHON_E2E_TARGET, check_live_account

LIVE_DIR = Path(__file__).parent


def pytest_collection_finish(session: pytest.Session) -> None:
    """Check the account the live legs act for, and stop the session on a refusal."""
    if session.config.option.collectonly or not any(LIVE_DIR in item.path.parents for item in session.items):
        return
    verdict = asyncio.run(check_live_account(PYTHON_E2E_TARGET))
    if verdict.verdict == "refused":
        pytest.exit(verdict.said, returncode=1)
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    if reporter is not None:
        reporter.write_line(verdict.said)
