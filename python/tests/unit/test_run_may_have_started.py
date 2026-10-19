"""`run_may_have_started`: whether a failed request that may create a run may still have started one.

The status rows both SDKs share are driven by `test_error_verdicts.py` through the case file's `run_start`
member. Here are the rest, which the two languages cannot share: the transport failures, read off the httpx
exception the request met; `start_and_wait`, whose start carries the reading and whose wait does not; a route
that starts nothing; and the structural reader.
"""

from __future__ import annotations

import asyncio
import ssl
from typing import TYPE_CHECKING, Any, TypeAlias

import httpx
import pytest
from mthds.protocol.problem.answers import read_answer
from mthds.runners.api.exceptions import ApiResponseError as MthdsApiResponseError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import run_may_have_started_of
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    PipelineExecuteTimeoutError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunStillRunningError,
    UploadTransportError,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

_BASE_URL = "http://localhost:8081"

_HOSTED_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-hosted", "implementation_version": "0.9.0"}
_BARE_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-api", "implementation_version": "1.2.3"}

#: How a request fails in the transport: the httpx exception, and what it was raised from.
_Failure = tuple[type[httpx.TransportError], BaseException | None]

#: What a route answers: a response, or a transport failure.
_Exchange = httpx.Response | _Failure


#: A call that sends one request through a client.
_Call: TypeAlias = "Callable[[PipelexAPIClient], Coroutine[Any, Any, object]]"

#: Requests that start nothing, each as the route it sends and a call that sends it.
_STARTS_NOTHING: list[tuple[str, str, _Call]] = [
    ("get_run_status", "GET /v1/runs/run-1/status", lambda client: client.get_run_status("run-1")),
    ("get_run_progress", "GET /v1/runs/run-1/progress", lambda client: client.get_run_progress("run-1")),
    ("get_me", "GET /v1/me", lambda client: client.get_me()),
    ("validate", "POST /v1/validate", lambda client: client.validate(mthds_contents=["domain = 'x'"])),
]


def _client(routes: dict[str, list[_Exchange]]) -> PipelexAPIClient:
    """A client whose requests are answered by method and path, each route's exchanges taken in order."""
    calls: dict[str, int] = {}

    def _respond(request: httpx.Request) -> httpx.Response:
        key = f"{request.method} {request.url.path}"
        call = calls.get(key, 0)
        calls[key] = call + 1
        exchanges = routes.get(key, [])
        if call >= len(exchanges):
            return httpx.Response(599, json={"detail": f"unrecorded {key}"}, request=request)
        exchange = exchanges[call]
        if isinstance(exchange, httpx.Response):
            return exchange
        failure, cause = exchange
        msg = f"simulated {failure.__name__}"
        raise failure(msg, request=request) from cause

    client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(_respond))
    return client


def _json(status: int, body: object, **headers: str) -> httpx.Response:
    return httpx.Response(status, json=body, headers=headers)


def _failure_of(call: Coroutine[Any, Any, object]) -> BaseException:
    """What the call raised: it must raise."""
    with pytest.raises(Exception) as caught:  # ruff: ignore[pytest-raises-too-broad] — the test reads what it was
        asyncio.run(call)
    return caught.value


class TestRunMayHaveStarted:
    # ── A transport failure of a start ──

    @pytest.mark.parametrize(
        "failure",
        [
            pytest.param((httpx.ConnectError, ConnectionRefusedError(61, "Connection refused")), id="a refused connection"),
            pytest.param((httpx.ConnectError, OSError(8, "nodename nor servname provided")), id="an unknown host"),
            pytest.param(
                (httpx.ConnectError, ssl.SSLCertVerificationError(1, "certificate verify failed")),
                id="a refused certificate",
            ),
            pytest.param((httpx.ConnectTimeout, None), id="a connection not made in time"),
            pytest.param((httpx.ConnectTimeout, ssl.SSLWantReadError(2, "read")), id="a connect timeout during the handshake"),
            pytest.param((httpx.PoolTimeout, None), id="no connection from the pool in time"),
            pytest.param((httpx.UnsupportedProtocol, None), id="a URL the client cannot send to"),
        ],
    )
    def test_a_start_whose_failure_proves_nothing_was_sent_started_nothing_and_stays_retryable(self, failure: _Failure) -> None:
        client = _client({"POST /v1/start": [failure]})

        err = _failure_of(client.start(pipe_code="p"))

        assert isinstance(err, ApiUnreachableError)
        assert err.run_may_have_started is False
        assert err.retryable is True

    @pytest.mark.parametrize(
        "failure",
        [
            pytest.param((httpx.ReadTimeout, None), id="the SDK's own time limit"),
            pytest.param((httpx.WriteTimeout, None), id="the time limit while sending"),
            pytest.param((httpx.RemoteProtocolError, None), id="a connection closed once the request had left"),
            pytest.param((httpx.ReadError, ConnectionResetError(54, "Connection reset by peer")), id="a reset"),
            pytest.param((httpx.ConnectError, ConnectionResetError(54, "Connection reset by peer")), id="a handshake dropped"),
            pytest.param((httpx.ConnectError, ssl.SSLError(1, "unexpected eof")), id="another TLS failure"),
        ],
    )
    def test_a_start_whose_failure_proves_nothing_may_have_started_a_run_and_is_not_retryable(self, failure: _Failure) -> None:
        client = _client({"POST /v1/start": [failure]})

        err = _failure_of(client.start(pipe_code="p"))

        assert isinstance(err, ApiUnreachableError)
        assert err.run_may_have_started is True
        assert err.retryable is False

    def test_a_start_whose_accepted_answer_could_not_be_decoded_may_have_started_a_run(self) -> None:
        answer = httpx.Response(202, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(b"not gzip at all"))
        client = _client({"POST /v1/start": [answer]})

        err = _failure_of(client.start(pipe_code="p"))

        assert isinstance(err, ApiUnreachableError)
        assert err.code == "DecodingError"
        assert err.run_may_have_started is True
        assert err.retryable is False

    def test_a_blocking_execute_reads_its_transport_failure_the_same_way(self) -> None:
        reset = _client({"POST /v1/execute": [(httpx.ReadError, ConnectionResetError(54, "reset"))]})
        refused = _client({"POST /v1/execute": [(httpx.ConnectError, ConnectionRefusedError(61, "refused"))]})

        assert run_may_have_started_of(_failure_of(reset.execute(pipe_code="p"))) is True
        assert run_may_have_started_of(_failure_of(refused.execute(pipe_code="p"))) is False

    # ── A blocking execute ──

    def test_a_blocking_execute_cut_off_by_the_gateway_may_have_started_a_run(self, mocker: Any) -> None:
        client = _client({"POST /v1/execute": [_json(503, {"detail": "cut off"})]})
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=[0.0, 31.0])

        err = _failure_of(client.execute(pipe_code="p"))

        assert isinstance(err, PipelineExecuteTimeoutError)
        assert err.run_may_have_started is True
        assert err.retryable is False

    def test_a_blocking_execute_degraded_to_a_202_names_its_run(self) -> None:
        client = _client({"POST /v1/execute": [_json(202, {"pipeline_run_id": "run-1"})]})

        err = _failure_of(client.execute(pipe_code="p"))

        assert isinstance(err, RunStillRunningError)
        assert run_may_have_started_of(err) is False

    @pytest.mark.parametrize(
        "extension",
        [
            pytest.param({"method_provenance": {"address": 5}}, id="malformed_provenance"),
            pytest.param({"method_version": "latest"}, id="unknown_method_version"),
        ],
    )
    def test_a_202_naming_its_run_stays_followable_whatever_its_extensions(self, extension: dict[str, object]) -> None:
        client = _client({"POST /v1/execute": [_json(202, {"pipeline_run_id": "run-1", **extension})]})

        err = _failure_of(client.execute(pipe_code="p"))

        assert isinstance(err, RunStillRunningError)
        assert err.run_id == "run-1"
        assert run_may_have_started_of(err) is False

    # ── start_and_wait ──

    def test_start_and_wait_carries_the_reading_on_an_error_from_its_start(self) -> None:
        client = _client({"GET /v1/version": [_json(200, _HOSTED_VERSION)], "POST /v1/start": [_json(502, {"detail": "bad gateway"})]})
        started: list[object] = []

        err = _failure_of(client.start_and_wait(pipe_code="p", on_started=started.append))

        assert isinstance(err, ApiResponseError)
        assert err.run_may_have_started is True
        assert err.retryable is False
        assert started == []

    def test_start_and_wait_does_not_carry_it_on_an_error_from_its_wait(self) -> None:
        client = _client(
            {
                "GET /v1/version": [_json(200, _HOSTED_VERSION)],
                "POST /v1/start": [_json(202, {"pipeline_run_id": "run-1"})],
                "GET /v1/runs/run-1/results": [_json(500, {"detail": "the run store failed"})],
            }
        )
        started: list[object] = []

        err = _failure_of(client.start_and_wait(pipe_code="p", on_started=started.append))

        assert len(started) == 1
        assert isinstance(err, ApiResponseError)
        assert err.run_may_have_started is False
        # Waiting again on the named run can succeed.
        assert err.retryable is True

    def test_start_and_wait_does_not_carry_it_on_a_failed_run(self) -> None:
        failed = {
            "detail": "Run finished with status FAILED: capacity.",
            "run_status": "FAILED",
            "error": {"error_type": "InferenceCapacityError", "error_domain": "runtime", "retryable": True},
        }
        client = _client(
            {
                "GET /v1/version": [_json(200, _HOSTED_VERSION)],
                "POST /v1/start": [_json(202, {"pipeline_run_id": "run-1"})],
                "GET /v1/runs/run-1/results": [_json(409, failed)],
            }
        )

        err = _failure_of(client.start_and_wait(pipe_code="p"))

        assert isinstance(err, RunFailedError)
        assert run_may_have_started_of(err) is False
        assert err.retryable is True

    def test_start_and_wait_carries_the_reading_on_an_error_from_its_blocking_fallback(self) -> None:
        client = _client({"GET /v1/version": [_json(200, _BARE_VERSION)], "POST /v1/execute": [_json(500, {"detail": "the runner failed"})]})

        err = _failure_of(client.start_and_wait(pipe_code="p"))

        assert isinstance(err, ApiResponseError)
        assert err.run_may_have_started is True

    def test_start_and_wait_carries_it_on_a_fallback_after_a_start_the_runner_does_not_serve(self) -> None:
        client = _client(
            {
                "GET /v1/version": [_json(200, {"protocol_version": "0.6.0"})],
                "POST /v1/start": [_json(404, {"detail": "Not Found"})],
                "POST /v1/execute": [_json(504, {"detail": "gateway timeout"})],
            }
        )

        err = _failure_of(client.start_and_wait(pipe_code="p"))

        assert isinstance(err, ApiResponseError)
        assert err.status == 504
        assert err.run_may_have_started is True

    def test_start_and_wait_starts_nothing_when_the_version_handshake_gets_no_answer(self) -> None:
        client = _client({"GET /v1/version": [(httpx.ReadError, ConnectionResetError(54, "reset"))]})

        err = _failure_of(client.start_and_wait(pipe_code="p"))

        assert isinstance(err, ApiUnreachableError)
        assert err.run_may_have_started is False

    # ── A request that starts nothing ──

    @pytest.mark.parametrize(("label", "route", "call"), _STARTS_NOTHING, ids=[label for label, _, _ in _STARTS_NOTHING])
    def test_a_request_that_starts_nothing_answered_a_500_is_false_and_keeps_the_fallback_retryable(
        self, label: str, route: str, call: _Call
    ) -> None:
        client = _client({route: [_json(500, {"detail": "boom"})]})

        err = _failure_of(call(client))

        assert isinstance(err, ApiResponseError), label
        assert err.run_may_have_started is False
        assert err.retryable is True

    def test_an_upload_answered_a_500_is_false(self) -> None:
        client = _client({"POST /v1/upload": [_json(500, {"detail": "boom"})]})

        err = _failure_of(client.upload_file(b"\x01\x02", filename="a.pdf"))

        assert isinstance(err, UploadTransportError)
        assert run_may_have_started_of(err) is False
        assert run_may_have_started_of(err.__cause__) is False

    def test_a_status_read_that_meets_a_reset_is_false_and_stays_retryable(self) -> None:
        client = _client({"GET /v1/runs/run-1/status": [(httpx.ReadError, ConnectionResetError(54, "reset"))]})

        err = _failure_of(client.get_run_status("run-1"))

        assert isinstance(err, ApiUnreachableError)
        assert err.run_may_have_started is False
        assert err.retryable is True

    def test_a_start_a_bare_runner_does_not_serve_started_nothing(self) -> None:
        client = _client({"POST /v1/start": [_json(404, {"detail": "Not Found"})]})

        err = _failure_of(client.start(pipe_code="p"))

        assert isinstance(err, RunLifecycleUnavailableError)
        assert run_may_have_started_of(err) is False

    # ── The errors built by hand ──

    def test_api_unreachable_error_reads_its_failure_only_when_told_the_request_may_create_a_run(self) -> None:
        request = httpx.Request("POST", f"{_BASE_URL}/v1/start")
        timeout = httpx.ReadTimeout("timed out", request=request)
        refused = httpx.ConnectError("refused", request=request)

        assert ApiUnreachableError("x", _BASE_URL, "ABORT_TIMEOUT", failure=timeout).run_may_have_started is False
        flagged = ApiUnreachableError("x", _BASE_URL, "ABORT_TIMEOUT", may_start_run=True, failure=timeout)
        assert flagged.run_may_have_started is True
        assert flagged.retryable is False
        assert ApiUnreachableError("x", _BASE_URL, "ConnectError", may_start_run=True, failure=refused).run_may_have_started is False
        # With no failure to read, nothing proves the request never left.
        assert ApiUnreachableError("x", _BASE_URL, may_start_run=True).run_may_have_started is True

    def test_api_response_error_keeps_the_server_s_members_on_its_problem(self) -> None:
        sent = {"code": "service_unavailable", "error_domain": "runtime", "retryable": True}
        err = ApiResponseError(
            "refused",
            api_url=_BASE_URL,
            status=503,
            status_text="Service Unavailable",
            response_body="",
            code="service_unavailable",
            error_domain="runtime",
            retryable=True,
            problem_document=sent,
            may_start_run=True,
        )

        assert err.run_may_have_started is True
        assert err.retryable is False
        assert err.problem_document == sent
        # The standard's reading of the same answer stands beside it, reading a run that may have started.
        assert err.problem.code == "client.outcome_unknown"

    # ── run_may_have_started_of ──

    def test_run_may_have_started_of_reads_any_exception_carrying_it_as_true(self) -> None:
        foreign = Exception("from another copy")
        foreign.run_may_have_started = True  # type: ignore[attr-defined]
        mistyped = Exception("mistyped")
        mistyped.run_may_have_started = "yes"  # type: ignore[attr-defined]

        assert run_may_have_started_of(foreign) is True
        assert run_may_have_started_of(mistyped) is False

    def test_run_may_have_started_of_is_false_for_an_mthds_error_a_plain_one_and_what_is_not_an_exception(self) -> None:
        mthds = MthdsApiResponseError(
            "refused",
            problem=read_answer(status=500, body="", headers={}, creates_run=False).problem,
            api_url=_BASE_URL,
            status=500,
            status_text="",
            response_body="",
        )

        class _Shaped:
            run_may_have_started = True

        assert run_may_have_started_of(mthds) is False
        assert run_may_have_started_of(Exception("plain")) is False
        assert run_may_have_started_of(_Shaped()) is False
        assert run_may_have_started_of(None) is False
