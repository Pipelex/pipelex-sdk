"""The idempotency key of a run start, on the request the client builds.

`start` and `start_and_wait` send `idempotency_key` as the `Idempotency-Key` header of `POST /v1/start` and
send none without it, keep it and the body identical across a caller's retry, refuse a malformed key before
anything is sent, and read the hosted API's refusals of a key by their code. A keyed start carries exactly
the headers of an unkeyed one plus the key, which holds `_send_with_idempotency_key` to the base's `_send`.
`@pipelex/sdk` holds its client to the same tests in `tests/start-idempotency-key.test.ts`. Every request goes
through an `httpx.MockTransport`, below the client's `_send`, so the headers asserted are the ones on the wire.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import ErrorDomain
from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError, IdempotencyErrorCode, RequestArgumentError
from tests.unit.test_data import IdempotencyKeyData

_BASE_URL = "http://localhost:8081"
_HOSTED_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-hosted"}
_BARE_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-api"}
_EXECUTE_BODY: dict[str, Any] = {
    "pipeline_run_id": "run-2",
    "main_stuff_name": "result",
    "pipe_output": {
        "working_memory": {
            "root": {"result": {"concept": "native.Text", "content": {"text": "hello"}}},
            "aliases": {"main_stuff": "result"},
        },
        "pipeline_run_id": "run-2",
    },
}
_HEADER = "idempotency-key"


class _RecordingServer:
    """A server answering each path from a queue and recording every request it receives; an answer that is
    an exception class is raised as no answer at all, as a dropped connection is.
    """

    def __init__(self, answers: dict[str, list[httpx.Response | type[httpx.TransportError]]]) -> None:
        self.answers = answers
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self.answers[request.url.path].pop(0)
        if isinstance(answer, httpx.Response):
            return answer
        msg = f"simulated {answer.__name__}"
        raise answer(msg, request=request)

    def client(self) -> PipelexAPIClient:
        """A client over this server, its httpx client carrying the default headers `start_client` gives it."""
        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        client.client = httpx.AsyncClient(
            headers={"Authorization": "Bearer test-token", "User-Agent": client.user_agent},
            transport=httpx.MockTransport(self.handle),
        )
        return client


def _ack() -> httpx.Response:
    return httpx.Response(202, json=IdempotencyKeyData.ACK)


class TestStartIdempotencyKey:
    def test_sends_the_key_as_the_idempotency_key_header_of_post_v1_start(self) -> None:
        server = _RecordingServer({"/v1/start": [_ack()]})

        started = asyncio.run(server.client().start(method_id="mt_abc123", idempotency_key=IdempotencyKeyData.KEY))

        assert started.pipeline_run_id == "run-1"
        [request] = server.requests
        assert request.method == "POST"
        assert str(request.url) == f"{_BASE_URL}/v1/start"
        assert request.headers[_HEADER] == IdempotencyKeyData.KEY
        assert request.headers["authorization"] == "Bearer test-token"
        assert request.headers["content-type"] == "application/json"
        assert request.headers["accept"] == "application/json"
        # A header, never a run argument: the body is the run request alone.
        assert json.loads(request.content) == {"method_id": "mt_abc123"}

    def test_sends_no_idempotency_key_header_without_a_key(self) -> None:
        server = _RecordingServer({"/v1/start": [_ack(), _ack()]})
        client = server.client()

        async def scenario() -> None:
            await client.start(method_id="mt_abc123")
            await client.start(method_id="mt_abc123", idempotency_key=None)

        asyncio.run(scenario())

        assert [_HEADER in request.headers for request in server.requests] == [False, False]
        assert [json.loads(request.content) for request in server.requests] == [{"method_id": "mt_abc123"}] * 2

    def test_a_keyed_start_carries_the_headers_of_an_unkeyed_one_plus_the_key(self) -> None:
        server = _RecordingServer({"/v1/start": [_ack(), _ack()]})
        client = server.client()

        async def scenario() -> None:
            await client.start(pipe_code="p", mthds_contents=['domain = "d"'])
            await client.start(pipe_code="p", mthds_contents=['domain = "d"'], idempotency_key=IdempotencyKeyData.KEY)

        asyncio.run(scenario())

        unkeyed, keyed = (dict(request.headers) for request in server.requests)
        assert keyed.pop(_HEADER) == IdempotencyKeyData.KEY
        assert keyed == unkeyed

    def test_sends_the_same_key_and_body_on_a_callers_retry_of_a_start_that_may_have_started_a_run(self) -> None:
        server = _RecordingServer(
            {"/v1/start": [httpx.ReadError, httpx.Response(202, json=IdempotencyKeyData.ACK, headers={"Idempotent-Replayed": "true"})]}
        )
        client = server.client()

        async def attempt() -> object:
            return await client.start(
                method_id="mt_abc123@3",
                inputs={"text": {"concept": "native.Text", "content": {"text": "hello"}}},
                idempotency_key=IdempotencyKeyData.KEY,
            )

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(attempt())
        # The key changes what the caller can do, not the verdict: the run may have started, so the error
        # stays not retryable, and the caller that sent a key sends the same start again.
        assert exc_info.value.run_may_have_started is True
        assert exc_info.value.retryable is False
        asyncio.run(attempt())

        first, retry = server.requests
        assert retry.headers[_HEADER] == IdempotencyKeyData.KEY
        assert dict(retry.headers) == dict(first.headers)
        # The hosted API refuses the same key with another body, so the retry's bytes must match.
        assert retry.content == first.content

    def test_the_key_rides_the_start_alone(self) -> None:
        server = _RecordingServer(
            {
                "/v1/start": [_ack()],
                "/v1/runs/run-1/status": [
                    httpx.Response(200, json={"pipeline_run_id": "run-1", "status": "RUNNING", "created_at": "2026-10-13T00:00:00Z"})
                ],
            }
        )
        client = server.client()

        async def scenario() -> None:
            await client.start(method_id="mt_abc123", idempotency_key=IdempotencyKeyData.KEY)
            await client.get_run_status("run-1")

        asyncio.run(scenario())

        start, status = server.requests
        assert start.headers[_HEADER] == IdempotencyKeyData.KEY
        assert _HEADER not in status.headers

    @pytest.mark.parametrize(
        ("idempotency_key", "fault"),
        [(key, fault) for _, key, fault in IdempotencyKeyData.MALFORMED_KEYS],
        ids=[name for name, _, _ in IdempotencyKeyData.MALFORMED_KEYS],
    )
    def test_refuses_a_malformed_key_before_anything_is_sent(self, idempotency_key: object, fault: str) -> None:
        server = _RecordingServer({})

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(server.client().start(method_id="mt_abc123", idempotency_key=idempotency_key))  # type: ignore[arg-type]

        refused = exc_info.value
        assert fault in str(refused)
        assert "1 to 255 visible ASCII characters" in str(refused)
        assert refused.error_domain == ErrorDomain.INPUT
        assert refused.retryable is False
        assert refused.run_may_have_started is False
        assert server.requests == []

    def test_never_quotes_the_refused_key(self) -> None:
        server = _RecordingServer({})

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(server.client().start(method_id="mt_abc123", idempotency_key="user-4711 xxxxxxxxxx"))

        assert "user-4711" not in str(exc_info.value)

    @pytest.mark.parametrize("idempotency_key", IdempotencyKeyData.VALID_KEYS)
    def test_sends_a_valid_key_as_it_is(self, idempotency_key: str) -> None:
        server = _RecordingServer({"/v1/start": [_ack()]})

        asyncio.run(server.client().start(method_id="mt_abc123", idempotency_key=idempotency_key))

        assert server.requests[0].headers[_HEADER] == idempotency_key

    def test_reads_a_key_an_earlier_start_still_holds_as_a_retryable_refusal_that_started_nothing(self) -> None:
        server = _RecordingServer({"/v1/start": [httpx.Response(409, json=IdempotencyKeyData.KEY_IN_USE, headers={"Retry-After": "2"})]})

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(server.client().start(method_id="mt_abc123", idempotency_key=IdempotencyKeyData.KEY))

        refused = exc_info.value
        assert refused.code == "idempotency_key_in_use"
        assert refused.status == 409
        assert (refused.error_domain, refused.retryable, refused.run_may_have_started) == (ErrorDomain.RUNTIME, True, False)

    def test_reads_a_key_used_before_with_another_body_as_a_conflict_that_is_not_retryable(self) -> None:
        server = _RecordingServer({"/v1/start": [httpx.Response(409, json=IdempotencyKeyData.KEY_USED_WITH_ANOTHER_BODY)]})

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(server.client().start(method_id="mt_abc123", idempotency_key=IdempotencyKeyData.KEY))

        refused = exc_info.value
        assert refused.code == "conflict"
        assert (refused.error_domain, refused.retryable, refused.run_may_have_started) == (ErrorDomain.INPUT, False, False)

    def test_names_the_one_idempotency_code(self) -> None:
        assert [code.value for code in IdempotencyErrorCode] == ["idempotency_key_in_use"]

    def test_start_and_wait_sends_the_key_on_the_durable_start_and_on_no_other_request(self) -> None:
        server = _RecordingServer(
            {
                "/v1/version": [httpx.Response(200, json=_HOSTED_VERSION)],
                "/v1/start": [_ack()],
                "/v1/runs/run-1/results": [httpx.Response(200, json={"pipeline_run_id": "run-1", "main_stuff": {}})],
            }
        )

        results = asyncio.run(server.client().start_and_wait(method_id="mt_abc123", idempotency_key=IdempotencyKeyData.KEY))

        assert results.pipeline_run_id == "run-1"
        assert [request.url.path for request in server.requests] == ["/v1/version", "/v1/start", "/v1/runs/run-1/results"]
        assert [request.headers.get(_HEADER) for request in server.requests] == [None, IdempotencyKeyData.KEY, None]

    def test_start_and_wait_sends_no_key_on_a_bare_runners_blocking_execute(self) -> None:
        server = _RecordingServer(
            {
                "/v1/version": [httpx.Response(200, json=_BARE_VERSION)],
                "/v1/execute": [httpx.Response(200, json=_EXECUTE_BODY)],
            }
        )

        results = asyncio.run(server.client().start_and_wait(pipe_code="p", mthds_contents=['domain = "d"'], idempotency_key=IdempotencyKeyData.KEY))

        assert results.pipeline_run_id == "run-2"
        execute = server.requests[1]
        assert execute.url.path == "/v1/execute"
        assert _HEADER not in execute.headers
        assert "idempotency_key" not in json.loads(execute.content)

    def test_start_and_wait_refuses_a_malformed_key_before_the_version_handshake(self) -> None:
        server = _RecordingServer({})

        with pytest.raises(RequestArgumentError):
            asyncio.run(server.client().start_and_wait(method_id="mt_abc123", idempotency_key=""))

        assert server.requests == []
