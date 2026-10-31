"""The problem a refused request carries, exercised against a LIVE hosted platform (no mocks).

Run it with `make e2e-test` against a platform that answers problem documents, as the registered test account the
workspace's `test-account run` hands over, which `conftest.py` checks before the first case (`live_account.py`,
`docs/live-accounts.md` at the repository's root). From the repository's root:

    test-account run pipelex-sdk-python-e2e -- make -C python e2e-test

The whole module skips when `PIPELEX_E2E_BASE_URL` is unset, or names a local runner with no `PIPELEX_API_KEY`.
Against a hosted platform, a missing key or a missing expectation is no skip: `conftest.py` stops the whole run
before the first case. `make agent-test` does not collect this directory at all.

What the unit suite cannot prove: that the problem on an `ApiResponseError` is the one the server
sent. The error reads a problem document as received, and builds one from the status by the edge's
rules when the body is none (`docs/errors.md`, "An answer that is no problem document"), and `response_body`
keeps the body as the server sent it, so each case asserts which it was. The cases are the JS twin's
(`js/tests/e2e/problems.e2e.ts`).

Two cases provoke a refusal the platform renders itself, before any runner sees the request: a run of
a method id the catalog does not hold, and a request body the platform's own validation refuses. The
third, a rejected API key, never reaches the platform: the gateway's authorizer refuses it with API
Gateway's bare `403 {"message":"Forbidden"}`, which is no problem document, so its problem is the SDK's
reading of the status, `auth.invalid_credential`. It changes when the edge answers that refusal with a
problem document of its own.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import uuid
import zlib
from typing import TYPE_CHECKING

import pytest
from mthds.protocol.problem.answers import read_problem_document

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

_BASE_URL = os.environ.get("PIPELEX_E2E_BASE_URL", "")
_API_KEY = os.environ.get("PIPELEX_API_KEY", "")

pytestmark = pytest.mark.skipif(
    not _BASE_URL or not _API_KEY,
    reason="live leg: set PIPELEX_E2E_BASE_URL and PIPELEX_API_KEY to run it",
)

#: A catalog id in the platform's own form, `mt_` and a UUID, that no method carries.
_UNKNOWN_METHOD_ID = f"mt_{uuid.uuid4()}"

#: A storage reference longer than the 512 characters the platform's resolve route accepts. The SDK
#: sends it as given, and the platform's request validation refuses it before the route reads it; no
#: runner serves the route.
_OVERLONG_STORAGE_URI = "pipelex-storage://" + "a" * 600


def _unknown_api_key() -> str:
    """A key in the platform's own format, `plx_sk_`, a 64-hex secret and its CRC32, that no
    organization holds. The checksum is right, so the authorizer looks the key up rather than refusing
    it as malformed: the refusal is the one a revoked or mistyped key meets.
    """
    secret = secrets.token_hex(32)
    return f"plx_sk_{secret}_{zlib.crc32(secret.encode('ascii')):08x}"


def _refusal_of(call: Callable[[PipelexAPIClient], Awaitable[object]], *, api_key: str = _API_KEY) -> ApiResponseError:
    """The refusal `call` ends in, read as the `ApiResponseError` the SDK raises for it."""

    async def _call() -> None:
        async with PipelexAPIClient(api_key=api_key, base_url=_BASE_URL) as client:
            await call(client)

    with pytest.raises(ApiResponseError) as exc_info:
        asyncio.run(_call())
    return exc_info.value


class TestPlatformRefusalProblemLive:
    def test_reads_a_rejected_api_key_as_auth_invalid_credential_read_from_the_gateways_bare_403(self) -> None:
        refusal = _refusal_of(lambda client: client.get_me(), api_key=_unknown_api_key())

        assert refusal.status == 403
        assert refusal.problem.code == "auth.invalid_credential"
        assert refusal.problem.retry == "no"
        # The authorizer refused the key before the platform saw it: the body is API Gateway's, no problem
        # document, so the problem above is the SDK's reading of the 403.
        assert read_problem_document(refusal.response_body, status=refusal.status, headers={}) is None

    def test_reads_a_run_of_a_method_id_the_catalog_does_not_hold_as_the_platforms_problem(self) -> None:
        refusal = _refusal_of(lambda client: client.start(method_id=_UNKNOWN_METHOD_ID))

        assert refusal.status == 404
        assert refusal.problem.code == "pipelex.catalog.not_found"
        assert (refusal.problem.domain, refusal.problem.retry) == ("input", "no")
        sent = read_problem_document(refusal.response_body, status=refusal.status, headers={})
        assert sent is not None
        assert sent.code == refusal.problem.code

    def test_reads_a_body_the_platforms_validation_refuses_as_the_platforms_problem_its_location_naming_the_field(self) -> None:
        refusal = _refusal_of(lambda client: client.resolve_storage_url(_OVERLONG_STORAGE_URI))

        # The body parses and one of its fields fails the route's schema: `request.invalid`, not `request.malformed`,
        # which is a body that does not parse. A problem with a single fault names it in its own `location` and
        # `params` and carries no `errors`.
        assert refusal.status == 422
        assert refusal.problem.code == "request.invalid"
        assert refusal.problem.location is not None
        assert refusal.problem.location.field == "uri"
        assert refusal.problem.params is not None
        assert refusal.problem.params.as_wire() == {"field": "uri"}
        assert refusal.problem.errors is None
        assert (refusal.problem.domain, refusal.problem.retry) == ("input", "no")
        sent = read_problem_document(refusal.response_body, status=refusal.status, headers={})
        assert sent is not None
        assert sent.code == refusal.problem.code
