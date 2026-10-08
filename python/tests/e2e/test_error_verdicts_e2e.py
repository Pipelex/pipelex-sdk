"""The verdict of a platform refusal, exercised against a LIVE hosted platform (no mocks).

Run it with `make e2e-test` against a platform whose own problem documents carry `retryable` and
`error_domain`, with an API key set for it:

    PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com PIPELEX_API_KEY=plx_sk_… make e2e-test

The whole module skips when either variable is unset, so the unit suite's `make agent-test` never
reaches it — and `make agent-test` does not collect this directory at all.

What the unit suite cannot prove: that the verdict on an `ApiResponseError` is the one the server
sent. The error takes each member from the problem document when the server sent it, and from the
fallback table when it did not, and nothing on the error says which (`docs/errors.md`, "A refused
request's verdict"). For every refusal here the two agree, so the error alone reads the same either
way. `problem` keeps the document as the server sent it, so each case asserts the verdict there as
well as on the error. The cases are the JS twin's (`js/tests/e2e/error-verdicts.e2e.ts`).

Two cases provoke a refusal the platform renders itself, before any runner sees the request: a run of
a method id the catalog does not hold, a named `404`, and a request body the platform's own validation
refuses, a `422`. The third, a rejected API key, never reaches the platform: the gateway's authorizer
refuses it with API Gateway's bare `403 {"message":"Forbidden"}`, which carries no verdict, so its
verdict is the SDK's fallback alone, and the case asserts that the document says nothing. It changes
when the edge answers that refusal with a problem document of its own.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import uuid
import zlib
from typing import TYPE_CHECKING, Any

import pytest

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


def _sent_verdict(problem: dict[str, Any] | None) -> dict[str, Any]:
    """The verdict members the problem document carried, as the server sent them; empty when it sent neither."""
    document = problem or {}
    return {key: document[key] for key in ("retryable", "error_domain") if key in document}


class TestPlatformRefusalVerdictLive:
    def test_reads_a_rejected_api_key_as_config_a_verdict_the_gateways_403_does_not_carry(self) -> None:
        refusal = _refusal_of(lambda client: client.get_me(), api_key=_unknown_api_key())

        assert refusal.status == 403
        assert refusal.retryable is False
        assert refusal.error_domain == "config"
        # The authorizer refused the key before the platform saw it: the body is API Gateway's, with no
        # `code` and no verdict, so the verdict above is the fallback's reading of the 403.
        assert refusal.code is None
        assert refusal.problem is not None
        assert _sent_verdict(refusal.problem) == {}

    def test_reads_a_run_of_an_unknown_method_id_as_input_as_the_platform_sent_it(self) -> None:
        refusal = _refusal_of(lambda client: client.start(method_id=_UNKNOWN_METHOD_ID))

        assert refusal.status == 404
        assert refusal.code == "not_found"
        assert refusal.retryable is False
        assert refusal.error_domain == "input"
        assert _sent_verdict(refusal.problem) == {"retryable": False, "error_domain": "input"}

    def test_reads_a_body_the_platforms_validation_refuses_as_input_as_the_platform_sent_it(self) -> None:
        refusal = _refusal_of(lambda client: client.resolve_storage_url(_OVERLONG_STORAGE_URI))

        assert refusal.status == 422
        assert refusal.code == "validation_failed"
        # The platform's field-level list names the field its own validation refused.
        assert [item.field for item in refusal.errors or []] == ["uri"]
        assert refusal.retryable is False
        assert refusal.error_domain == "input"
        assert _sent_verdict(refusal.problem) == {"retryable": False, "error_domain": "input"}
