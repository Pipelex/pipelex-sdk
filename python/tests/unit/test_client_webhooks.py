"""The caller side of a caller webhook: a run's `callback_urls`, sent by `execute`, `start` and `start_and_wait` with
its blocking fallback, refused before anything is sent when it is no list of strings, and never a run source; the
acknowledgement's echo of it; and the routes of the hosted delivery log and of an organization's signing secret.
`@pipelex/sdk` holds its client to the same tests in `tests/webhook-routes.test.ts`. Every request goes through an
`httpx.MockTransport`, below the client's `_send`, so what is asserted is what goes on the wire.
"""

from __future__ import annotations

import asyncio
import json
from collections import UserList
from typing import Any, cast

import httpx
import pytest

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.webhooks import WebhookAttemptFailure, WebhookDeliveryState
from tests.unit.conftest import BASE_URL, problem_document
from tests.unit.test_data import WebhookData

_HEADER = "idempotency-key"


class _RecordingServer:
    """A server answering each path from a queue and recording every request it receives."""

    def __init__(self, answers: dict[str, list[httpx.Response]]) -> None:
        self.answers = answers
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.answers[request.url.path].pop(0)

    def client(self) -> PipelexAPIClient:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        client.client = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        return client


def _sent_body(request: httpx.Request) -> Any:
    return json.loads(request.content) if request.content else None


class TestClientWebhooks:
    def test_callback_urls_ride_starts_body_and_the_ack_echoes_them_redacted(self) -> None:
        server = _RecordingServer({"/v1/start": [httpx.Response(202, json={**WebhookData.ACK, "callback_urls": WebhookData.REDACTED})]})

        started = asyncio.run(server.client().start(method_id="mt_abc123", callback_urls=WebhookData.URLS))

        [request] = server.requests
        assert str(request.url) == f"{BASE_URL}/v1/start"
        assert _sent_body(request) == {"method_id": "mt_abc123", "callback_urls": WebhookData.URLS}
        assert started.callback_urls == WebhookData.REDACTED

    def test_callback_urls_ride_executes_body_given_as_a_tuple(self) -> None:
        server = _RecordingServer({"/v1/execute": [httpx.Response(200, json=WebhookData.EXECUTE_BODY)]})

        asyncio.run(server.client().execute(pipe_code="summarize", callback_urls=tuple(WebhookData.URLS)))

        [request] = server.requests
        assert _sent_body(request) == {"pipe_code": "summarize", "callback_urls": WebhookData.URLS}

    def test_callback_urls_survive_the_blocking_fallback(self) -> None:
        server = _RecordingServer(
            {
                "/v1/version": [httpx.Response(200, json={"protocol_version": "0.6.0", "implementation": "pipelex-api"})],
                "/v1/execute": [httpx.Response(200, json=WebhookData.EXECUTE_BODY)],
            }
        )

        asyncio.run(server.client().start_and_wait(pipe_code="summarize", callback_urls=WebhookData.URLS))

        execute = server.requests[-1]
        assert execute.url.path == "/v1/execute"
        assert _sent_body(execute)["callback_urls"] == WebhookData.URLS

    def test_callback_urls_ride_starts_body_given_as_any_sequence(self) -> None:
        server = _RecordingServer({"/v1/start": [httpx.Response(202, json=WebhookData.ACK)]})

        asyncio.run(server.client().start(method_id="mt_abc123", callback_urls=UserList(WebhookData.URLS)))

        [request] = server.requests
        assert _sent_body(request) == {"method_id": "mt_abc123", "callback_urls": WebhookData.URLS}

    def test_callback_urls_ride_beside_an_extension_of_extra(self) -> None:
        server = _RecordingServer({"/v1/start": [httpx.Response(202, json=WebhookData.ACK)]})

        asyncio.run(server.client().start(pipe_code="summarize", extra={"custom": {"depth": 2}}, callback_urls=WebhookData.URLS))

        [request] = server.requests
        assert _sent_body(request) == {"pipe_code": "summarize", "custom": {"depth": 2}, "callback_urls": WebhookData.URLS}

    @pytest.mark.parametrize("urls", [None, [], ()], ids=["none", "empty-list", "empty-tuple"])
    def test_callback_urls_are_not_sent_when_there_are_none(self, urls: list[str] | tuple[str, ...] | None) -> None:
        server = _RecordingServer({"/v1/start": [httpx.Response(202, json=WebhookData.ACK)]})

        started = asyncio.run(server.client().start(method_id="mt_abc123", callback_urls=urls))

        [request] = server.requests
        assert _sent_body(request) == {"method_id": "mt_abc123"}
        assert started.callback_urls is None

    @pytest.mark.parametrize(("topic", "urls", "reason"), WebhookData.REFUSED_URLS, ids=[case[0] for case in WebhookData.REFUSED_URLS])
    def test_refuses_callback_urls_that_are_no_list_of_strings(self, topic: str, urls: object, reason: str) -> None:
        server = _RecordingServer({})

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(server.client().start(method_id="mt_abc123", callback_urls=cast("list[str]", urls)))

        assert str(caught.value).startswith("start() takes "), topic
        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"argument": "callback_urls", "reason": reason}
        assert server.requests == []

    @pytest.mark.parametrize("call", ["execute", "start", "start_and_wait"])
    def test_callback_urls_alone_name_nothing_to_run(self, call: str) -> None:
        # `start_and_wait` asks the version handshake before it starts the run, as with no argument at all, once per client.
        version = {"protocol_version": "0.6.0", "implementation": "pipelex-api"}
        server = _RecordingServer({"/v1/version": [httpx.Response(200, json=version), httpx.Response(200, json=version)]})
        client = server.client()

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(getattr(client, call)(callback_urls=WebhookData.URLS))
        with pytest.raises(RequestArgumentError) as naming_nothing:
            asyncio.run(getattr(server.client(), call)())

        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"argument": "pipe_code", "reason": "nothing_to_run"}
        # The webhooks are no run source: the run meets the refusal of a run naming nothing.
        assert str(caught.value) == str(naming_nothing.value)
        assert [request.url.path for request in server.requests if request.url.path != "/v1/version"] == []

    def test_refuses_callback_urls_smuggled_through_extra(self) -> None:
        server = _RecordingServer({})

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(server.client().start(pipe_code="summarize", extra={"callback_urls": WebhookData.URLS}))

        assert "reserved request args ['callback_urls']" in str(caught.value)
        assert server.requests == []

    def test_surfaces_the_platforms_refusal_of_a_url_by_its_code_and_field(self) -> None:
        refusal = problem_document("request.invalid", 422, params={"field": "callback_urls.1"})
        server = _RecordingServer({"/v1/start": [httpx.Response(422, json=refusal, headers={"content-type": "application/problem+json"})]})

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(server.client().start(method_id="mt_abc123", callback_urls=WebhookData.URLS))

        assert caught.value.problem.code == "request.invalid"
        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"field": "callback_urls.1"}

    def test_lists_a_runs_deliveries(self) -> None:
        path = f"/v1/runs/{WebhookData.RUN_ID}/webhook-deliveries"
        answer = {"pipeline_run_id": WebhookData.RUN_ID, "deliveries": [WebhookData.DELIVERY]}
        server = _RecordingServer({path: [httpx.Response(200, json=answer)]})

        listing = asyncio.run(server.client().list_run_webhook_deliveries(WebhookData.RUN_ID))

        [request] = server.requests
        assert (request.method, request.url.path) == ("GET", path)
        assert listing.model_dump(mode="json") == answer
        [delivery] = listing.deliveries
        assert delivery.state == WebhookDeliveryState.FAILED
        assert delivery.attempts[1].failure == WebhookAttemptFailure.TIMEOUT

    def test_reads_a_delivery_state_it_does_not_name_as_its_raw_string(self) -> None:
        path = f"/v1/runs/{WebhookData.RUN_ID}/webhook-deliveries"
        delivery = {**WebhookData.DELIVERY, "state": "abandoned"}
        server = _RecordingServer({path: [httpx.Response(200, json={"pipeline_run_id": WebhookData.RUN_ID, "deliveries": [delivery]})]})

        listing = asyncio.run(server.client().list_run_webhook_deliveries(WebhookData.RUN_ID))

        assert listing.deliveries[0].state == "abandoned"

    def test_refuses_an_answer_whose_deliveries_is_not_a_list(self) -> None:
        path = f"/v1/runs/{WebhookData.RUN_ID}/webhook-deliveries"
        server = _RecordingServer({path: [httpx.Response(200, json={"pipeline_run_id": WebhookData.RUN_ID, "deliveries": None})]})

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(server.client().list_run_webhook_deliveries(WebhookData.RUN_ID))

        assert caught.value.problem.code == "client.response_unreadable"

    def test_reads_one_delivery_with_its_event_as_sent(self) -> None:
        path = f"/v1/runs/{WebhookData.RUN_ID}/webhook-deliveries/{WebhookData.DELIVERY_ID}"
        server = _RecordingServer({path: [httpx.Response(200, json={**WebhookData.DELIVERY, "event": WebhookData.EVENT})]})

        detail = asyncio.run(server.client().get_run_webhook_delivery(WebhookData.RUN_ID, WebhookData.DELIVERY_ID))

        [request] = server.requests
        assert (request.method, request.url.path) == ("GET", path)
        assert detail.event == WebhookData.EVENT

    def test_replays_a_delivery_with_no_body_and_no_idempotency_key(self) -> None:
        path = f"/v1/runs/{WebhookData.RUN_ID}/webhook-deliveries/{WebhookData.DELIVERY_ID}/replay"
        answer = {"pipeline_run_id": WebhookData.RUN_ID, "delivery_id": WebhookData.DELIVERY_ID, "attempt": 3}
        server = _RecordingServer({path: [httpx.Response(202, json=answer)]})

        accepted = asyncio.run(server.client().replay_run_webhook_delivery(WebhookData.RUN_ID, WebhookData.DELIVERY_ID))

        [request] = server.requests
        assert (request.method, request.url.path) == ("POST", path)
        assert request.content == b""
        assert _HEADER not in request.headers
        assert accepted.model_dump() == answer

    @pytest.mark.parametrize("reason", ["webhook_delivery_pending", "webhook_delivery_attempts_exhausted"])
    def test_surfaces_a_replay_refused_by_its_code_and_reason(self, reason: str) -> None:
        path = f"/v1/runs/{WebhookData.RUN_ID}/webhook-deliveries/{WebhookData.DELIVERY_ID}/replay"
        refusal = problem_document("pipelex.org.not_manageable", 409, params={"reason": reason})
        server = _RecordingServer({path: [httpx.Response(409, json=refusal, headers={"content-type": "application/problem+json"})]})

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(server.client().replay_run_webhook_delivery(WebhookData.RUN_ID, WebhookData.DELIVERY_ID))

        assert caught.value.problem.code == "pipelex.org.not_manageable"
        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire() == {"reason": reason}

    def test_reads_the_organizations_secret_and_keeps_it_out_of_the_models_repr(self) -> None:
        path = "/v1/organizations/org-1/webhook-secret"
        server = _RecordingServer({path: [httpx.Response(200, json=WebhookData.SECRET)]})

        secret = asyncio.run(server.client().get_webhook_secret("org-1"))

        [request] = server.requests
        assert (request.method, request.url.path) == ("GET", path)
        assert secret.model_dump() == WebhookData.SECRET
        assert WebhookData.SECRET["secret"] not in repr(secret)

    def test_rotates_the_secret_under_the_idempotency_key_given(self) -> None:
        path = "/v1/organizations/org-1/webhook-secret/rotate"
        server = _RecordingServer({path: [httpx.Response(200, json=WebhookData.ROTATED)]})

        secret = asyncio.run(server.client().rotate_webhook_secret("org-1", idempotency_key=WebhookData.KEY))

        [request] = server.requests
        assert (request.method, request.url.path) == ("POST", path)
        assert request.content == b""
        assert request.headers[_HEADER] == WebhookData.KEY
        assert secret.model_dump() == WebhookData.ROTATED

    def test_rotates_with_no_idempotency_key_when_none_is_given(self) -> None:
        path = "/v1/organizations/org-1/webhook-secret/rotate"
        server = _RecordingServer({path: [httpx.Response(200, json=WebhookData.SECRET)]})

        asyncio.run(server.client().rotate_webhook_secret("org-1"))

        [request] = server.requests
        assert _HEADER not in request.headers

    def test_refuses_a_malformed_idempotency_key_before_anything_is_sent(self) -> None:
        server = _RecordingServer({})

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(server.client().rotate_webhook_secret("org-1", idempotency_key="two words"))

        assert caught.value.problem.params is not None
        assert caught.value.problem.params.as_wire()["argument"] == "idempotency_key"
        assert server.requests == []

    def test_surfaces_a_key_sent_again_by_request_already_executed(self) -> None:
        path = "/v1/organizations/org-1/webhook-secret/rotate"
        refusal = problem_document("request.already_executed", 409)
        server = _RecordingServer({path: [httpx.Response(409, json=refusal, headers={"content-type": "application/problem+json"})]})

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(server.client().rotate_webhook_secret("org-1", idempotency_key=WebhookData.KEY))

        assert caught.value.problem.code == "request.already_executed"
