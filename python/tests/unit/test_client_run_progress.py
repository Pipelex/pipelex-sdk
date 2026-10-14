"""Tests for the progress snapshot: `get_run_progress` and `WaitForResultOptions.on_progress`, httpx mocked.

The Python twin of `@pipelex/sdk`'s `tests/run-progress.test.ts`, on the snapshot the contract's worked
example draws (`RunProgressBodies`), plus what the Python wait adds: the progress read is bounded by the time
the wait has left.
"""

import asyncio
import copy
from time import monotonic
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    RequestArgumentError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunTimeoutError,
)
from pipelex_sdk.runs import (
    DegradationReason,
    PipelexRunResultStart,
    PollInfo,
    ProgressBatch,
    ProgressInvocationStatus,
    RunProgress,
    RunProgressStatus,
    RunResultRunning,
    RunResults,
    WaitForResultOptions,
)
from tests.unit.conftest import BASE_URL, SendPatcher
from tests.unit.test_data import RunProgressBodies

_RESULTS_URL = f"{BASE_URL}/v1/runs/run-1/results"
_PROGRESS_URL = f"{BASE_URL}/v1/runs/run-1/progress"

#: What a route answers: a response, or the transport failure the request meets instead.
_Answer = httpx.Response | type[httpx.TransportError]


def _json(status_code: int, body: object, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(status_code, json=body, headers=headers or {}, request=httpx.Request("GET", f"{BASE_URL}/x"))


def _running() -> httpx.Response:
    """A run still going, as the results route answers it while the run runs."""
    return httpx.Response(202, headers={"Retry-After": "0"})


def _completed() -> httpx.Response:
    return _json(200, {"pipeline_run_id": "run-1", "main_stuff": {"ok": True}})


def _failed() -> httpx.Response:
    return _json(
        409,
        {
            "type": "https://pipelex.com/errors/conflict",
            "title": "Conflict",
            "status": 409,
            "code": "conflict",
            "detail": "Run finished with status FAILED; no result available",
            "run_status": "FAILED",
            "error": None,
        },
    )


def _snapshot(**overrides: Any) -> dict[str, Any]:
    """A snapshot of the whole run, still going, with no invocation unless given."""
    snapshot: dict[str, Any] = {
        "pipeline_run_id": "run-1",
        "mode": "live",
        "status": "running",
        "version": 1,
        "assembled_at": "2026-10-12T09:30:00.000Z",
        "summary": "Running review_filings",
        "invocations": [],
    }
    snapshot.update(overrides)
    return snapshot


def _invocation(**overrides: Any) -> dict[str, Any]:
    """Item 3 of the worked example, stuck, with the given members replaced."""
    invocation: dict[str, Any] = copy.deepcopy(RunProgressBodies.WORKED_EXAMPLE["invocations"][13])
    invocation.update(overrides)
    return invocation


def _read_running(run_id: str, **_options: object) -> RunResultRunning:
    """The results read of a run still going, answered at once, as the side effect of an `AsyncMock`."""
    return RunResultRunning(pipeline_run_id=run_id, retry_after_seconds=0)


def _serving_client(routes: dict[str, list[_Answer]]) -> tuple[PipelexAPIClient, list[str]]:
    """A client whose requests are answered from the queue of the route their path ends with, in order.

    A transport failure in a queue is raised as the request's own, below the client's `_send`, so it meets
    the client's mapping to `ApiUnreachableError`. The URLs requested are recorded in order. A request no
    queue answers fails the test.
    """
    urls: list[str] = []

    def _answer(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        route = next((suffix for suffix in routes if request.url.path.endswith(suffix)), None)
        if route is None or not routes[route]:
            msg = f"No answer left for {request.url}"
            raise AssertionError(msg)
        answer = routes[route].pop(0)
        if isinstance(answer, httpx.Response):
            return answer
        msg = f"simulated {answer.__name__}"
        raise answer(msg, request=request)

    client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(_answer))
    return client, urls


class TestClientRunProgress:
    # ── get_run_progress ─────────────────────────────────────────

    def test_get_run_progress_reads_the_contracts_worked_example_member_for_member(self, mocker: MockerFixture) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_json(200, RunProgressBodies.WORKED_EXAMPLE)))

        progress = asyncio.run(client.get_run_progress("run_7Qd2kV"))

        assert send.call_args.args == ("GET", f"{BASE_URL}/v1/runs/run_7Qd2kV/progress")
        # Every member the platform sent is read back as sent, and none it left out is added.
        assert progress.model_dump(mode="json", exclude_unset=True) == RunProgressBodies.WORKED_EXAMPLE
        assert progress.pipeline_run_id == "run_7Qd2kV"
        assert progress.mode == "live"
        assert progress.status is RunProgressStatus.RUNNING
        assert progress.version == 26
        assert progress.assembled_at == "2026-10-12T09:31:20.512Z"
        assert progress.summary == RunProgressBodies.WORKED_EXAMPLE["summary"]
        assert progress.root_path is None
        assert progress.chain is None
        assert progress.degradation is not None
        assert progress.degradation.reason is DegradationReason.WORKFLOW_TASK_FAILING
        assert progress.degradation.message == RunProgressBodies.STUCK_MESSAGE
        assert progress.degradation.failed_attempts == 4
        assert progress.degradation.failing_since == "2026-10-12T09:30:33.480Z"
        assert progress.degradation.ends_at == "2026-10-12T09:45:33.480Z"
        assert [invocation.path for invocation in progress.invocations] == [
            invocation["path"] for invocation in RunProgressBodies.WORKED_EXAMPLE["invocations"]
        ]

        root, step_1, step_2, deep_checks = progress.invocations[0:4]
        assert (root.pipe_code, root.pipe_ref, root.pipe_type) == ("review_filings", "filings.review_filings", "PipeSequence")
        assert root.status is ProgressInvocationStatus.RUNNING
        assert root.started_at == "2026-10-12T09:30:00.104Z"
        assert root.ended_at is None
        assert root.step_count == 4
        assert step_1.status is ProgressInvocationStatus.SUCCEEDED
        assert step_1.ended_at == "2026-10-12T09:30:06.870Z"
        assert step_1.step_count is None
        assert step_2.condition is not None
        assert step_2.condition.selected_outcome == "detailed"
        assert deep_checks.branch_count == 2

        batch = progress.invocations[6]
        assert batch.pipe_type == "PipeBatch"
        assert batch.batch == ProgressBatch(total=3, done=1, running=2, failed=0)

        retried = progress.invocations[12]
        assert retried.path == "filings.review_filings/step_3/item_2/step_2"
        assert retried.attempts == 2
        assert retried.last_failure is not None
        assert retried.last_failure.message == "An internal error occurred."
        assert retried.last_failure.at == "2026-10-12T09:30:52.317Z"
        assert retried.degradation is None

        stuck = progress.invocations[13]
        assert stuck.path == "filings.review_filings/step_3/item_3"
        assert stuck.degradation == progress.degradation
        assert stuck.attempts is None
        assert stuck.last_failure is None

    def test_get_run_progress_reads_a_pending_run_with_no_invocation(self, patch_send: SendPatcher) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(200, {**RunProgressBodies.PENDING, "later": 1}))

        progress = asyncio.run(client.get_run_progress("run-1"))

        assert progress.status is RunProgressStatus.PENDING
        assert progress.summary == "Waiting to start"
        assert progress.version == 0
        assert progress.invocations == []
        assert progress.degradation is None
        assert progress.root_path is None
        # A member the SDK does not name rides `model_extra`.
        assert progress.model_extra == {"later": 1}

    def test_get_run_progress_keeps_a_status_it_does_not_know_as_its_raw_string(self, patch_send: SendPatcher) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(200, _snapshot(status="paused", invocations=[_invocation(status="waiting")])))

        progress = asyncio.run(client.get_run_progress("run-1"))

        assert progress.status == "paused"
        assert not isinstance(progress.status, RunProgressStatus)
        assert progress.invocations[0].status == "waiting"
        assert not isinstance(progress.invocations[0].status, ProgressInvocationStatus)

    def test_get_run_progress_reads_a_degradation_it_cannot_read_as_none(self, patch_send: SendPatcher) -> None:
        """On the snapshot and on an invocation alike, an unreadable degradation never fails the read."""
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(200, _snapshot(degradation="stuck", invocations=[_invocation(degradation={"message": "no reason"})])))

        progress = asyncio.run(client.get_run_progress("run-1"))

        assert progress.degradation is None
        assert progress.invocations[0].degradation is None
        assert progress.invocations[0].step_count == 2

    def test_get_run_progress_reads_a_degradation_field_by_field_as_the_status_read_does(self, patch_send: SendPatcher) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(200, _snapshot(degradation={**RunProgressBodies.STUCK, "failed_attempts": "four"})))

        progress = asyncio.run(client.get_run_progress("run-1"))

        assert progress.degradation is not None
        assert progress.degradation.reason is DegradationReason.WORKFLOW_TASK_FAILING
        assert progress.degradation.ends_at == RunProgressBodies.STUCK["ends_at"]
        assert progress.degradation.failed_attempts is None

    @pytest.mark.parametrize(
        ("member", "value"),
        [
            pytest.param("step_count", "2", id="a-step-count-that-is-a-string"),
            pytest.param("branch_count", 2.5, id="a-branch-count-that-is-a-fraction"),
            pytest.param("skip_reason", 3, id="a-skip-reason-that-is-not-a-string"),
            pytest.param("batch", {"total": "3", "done": 1, "running": 2, "failed": 0}, id="a-batch-with-a-count-that-is-a-string"),
            pytest.param("condition", {}, id="a-condition-without-its-outcome"),
            pytest.param("attempts", True, id="attempts-that-are-a-boolean"),
            pytest.param("last_failure", "An internal error occurred.", id="a-last-failure-that-is-not-an-object"),
        ],
    )
    def test_get_run_progress_reads_an_optional_invocation_member_that_does_not_fit_as_none(
        self, patch_send: SendPatcher, member: str, value: object
    ) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(200, _snapshot(invocations=[_invocation(**{member: value})])))

        progress = asyncio.run(client.get_run_progress("run-1"))

        invocation = progress.invocations[0]
        assert getattr(invocation, member) is None
        assert invocation.path == "filings.review_filings/step_3/item_3"
        assert invocation.degradation is not None

    @pytest.mark.parametrize(
        ("member", "value"),
        [
            pytest.param("root_path", 3, id="a-root-path-that-is-not-a-string"),
            pytest.param("chain", [{"execution": "exec-run"}], id="a-chain-with-an-attempt-missing-its-number"),
        ],
    )
    def test_get_run_progress_reads_an_optional_snapshot_member_that_does_not_fit_as_none(
        self, patch_send: SendPatcher, member: str, value: object
    ) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(200, _snapshot(**{member: value})))

        progress = asyncio.run(client.get_run_progress("run-1"))

        assert getattr(progress, member) is None
        assert progress.version == 1

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({key: value for key, value in _snapshot().items() if key != "version"}, id="no-version"),
            pytest.param(_snapshot(version=-1), id="a-negative-version"),
            pytest.param(_snapshot(version=1.5), id="a-fractional-version"),
            pytest.param(_snapshot(version="26"), id="a-version-that-is-a-string"),
            pytest.param(_snapshot(version=True), id="a-version-that-is-a-boolean"),
            pytest.param(_snapshot(status=3), id="a-status-that-is-not-a-string"),
            pytest.param(_snapshot(summary=None), id="a-summary-that-is-null"),
            pytest.param({key: value for key, value in _snapshot().items() if key != "assembled_at"}, id="no-assembly-time"),
            pytest.param(_snapshot(invocations={}), id="invocations-that-are-not-a-list"),
            pytest.param(_snapshot(invocations=[1]), id="an-invocation-that-is-not-an-object"),
            pytest.param(
                _snapshot(invocations=[{key: value for key, value in _invocation().items() if key != "path"}]), id="an-invocation-without-a-path"
            ),
            pytest.param(_snapshot(invocations=[_invocation(started_at=0)]), id="an-invocation-whose-start-is-not-a-string-or-null"),
            pytest.param(
                _snapshot(invocations=[{key: value for key, value in _invocation().items() if key != "ended_at"}]), id="an-invocation-without-its-end"
            ),
        ],
    )
    def test_get_run_progress_refuses_a_snapshot_missing_what_a_reader_leans_on(self, patch_send: SendPatcher, body: dict[str, Any]) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(200, body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.get_run_progress("run-1"))

        assert str(exc_info.value) == "API GET /v1/runs/run-1/progress answered 200 with a body that is not the answer the route returns"
        assert isinstance(exc_info.value.__cause__, ValidationError)
        assert error_verdict_of(exc_info.value) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)

    def test_get_run_progress_raises_the_platforms_run_not_found_as_api_response_error(self, patch_send: SendPatcher) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        not_found = {
            "type": "https://pipelex.com/errors/not-found",
            "code": "not_found",
            "title": "Not found",
            "status": 404,
            "detail": "Run not found",
        }
        patch_send(client, _json(404, not_found))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.get_run_progress("run-1"))

        assert exc_info.value.status == 404
        assert exc_info.value.code == "not_found"

    def test_get_run_progress_maps_a_route_absent_404_to_lifecycle_unavailable(self, patch_send: SendPatcher) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        patch_send(client, _json(404, {"detail": "Not Found"}))

        with pytest.raises(RunLifecycleUnavailableError) as exc_info:
            asyncio.run(client.get_run_progress("run-1"))

        assert str(exc_info.value).endswith("the server is a bare runner, or a hosted API older than the progress route.")

    def test_get_run_progress_refuses_a_run_id_the_url_would_resolve_before_any_request(self, mocker: MockerFixture) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        send = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError):
            asyncio.run(client.get_run_progress(".."))

        send.assert_not_called()

    # ── wait_for_result's on_progress ────────────────────────────

    def test_wait_for_result_reads_no_progress_without_on_progress(self) -> None:
        client, urls = _serving_client({"/results": [_running(), _running(), _completed()]})

        asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(interval_seconds=0.0)))

        assert urls == [_RESULTS_URL, _RESULTS_URL, _RESULTS_URL]

    def test_wait_for_result_delivers_each_fresher_snapshot_and_only_those(self) -> None:
        first = _snapshot(version=1)
        same = _snapshot(version=1)
        later = _snapshot(version=3)
        lagging = _snapshot(version=2, assembled_at="2026-10-12T09:35:00Z")
        reassembled = _snapshot(version=3, assembled_at="2026-10-12T09:36:00Z")
        client, urls = _serving_client(
            {
                "/results": [_running(), _running(), _running(), _running(), _running(), _completed()],
                "/progress": [_json(200, snapshot) for snapshot in (first, same, later, lagging, reassembled)],
            }
        )
        delivered: list[RunProgress] = []

        result = asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(interval_seconds=0.0, on_progress=delivered.append)))

        assert result.main_stuff == {"ok": True}
        assert [progress.model_dump(mode="json", exclude_unset=True) for progress in delivered] == [first, later, reassembled]
        # One progress read per poll that found the run running, after its results read; none once the
        # results read finds the run ended.
        assert urls == [*[_RESULTS_URL, _PROGRESS_URL] * 5, _RESULTS_URL]

    def test_wait_for_result_reads_no_progress_once_the_run_has_failed(self) -> None:
        client, urls = _serving_client({"/results": [_running(), _failed()], "/progress": [_json(200, _snapshot())]})
        delivered: list[RunProgress] = []

        with pytest.raises(RunFailedError):
            asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(interval_seconds=0.0, on_progress=delivered.append)))

        assert len(delivered) == 1
        assert urls == [_RESULTS_URL, _PROGRESS_URL, _RESULTS_URL]

    def test_wait_for_result_never_trades_a_delivered_snapshot_of_the_ended_run_for_one_still_going(self) -> None:
        ended = _snapshot(status="failed", version=9, summary="Failed at check_figures")
        stale = _snapshot(status="running", version=12)
        client, _ = _serving_client({"/results": [_running(), _running(), _completed()], "/progress": [_json(200, ended), _json(200, stale)]})
        delivered: list[RunProgress] = []

        asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(interval_seconds=0.0, on_progress=delivered.append)))

        assert [progress.model_dump(mode="json", exclude_unset=True) for progress in delivered] == [ended]

    def test_wait_for_result_skips_a_poll_whose_progress_read_fails_and_never_fails_the_wait(self) -> None:
        later = _snapshot(version=4)
        client, _ = _serving_client(
            {
                "/results": [_running(), _running(), _running(), _running(), _completed()],
                "/progress": [
                    _json(503, {"code": "service_unavailable", "detail": "Read it again later."}),
                    httpx.ConnectError,
                    _json(200, _snapshot(version="four")),
                    _json(200, later),
                ],
            }
        )
        delivered: list[RunProgress] = []
        polls: list[PollInfo] = []
        options = WaitForResultOptions(interval_seconds=0.0, on_progress=delivered.append, on_poll=polls.append)

        result = asyncio.run(client.wait_for_result("run-1", options))

        assert result.main_stuff == {"ok": True}
        assert [progress.model_dump(mode="json", exclude_unset=True) for progress in delivered] == [later]
        assert [poll.attempt for poll in polls] == [1, 2, 3, 4]

    def test_wait_for_result_stops_reading_progress_once_the_server_answers_it_has_no_progress_route(self, mocker: MockerFixture) -> None:
        client, urls = _serving_client(
            {"/results": [_running(), _running(), _running(), _completed()], "/progress": [_json(404, {"detail": "Not Found"})]}
        )
        on_progress = mocker.Mock()

        asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(interval_seconds=0.0, on_progress=on_progress)))

        on_progress.assert_not_called()
        assert urls.count(_PROGRESS_URL) == 1

    def test_wait_for_result_propagates_an_exception_on_progress_raises(self) -> None:
        client, _ = _serving_client({"/results": [_running()], "/progress": [_json(200, _snapshot())]})

        def _buggy(progress: RunProgress) -> None:
            msg = f"the caller's own bug at version {progress.version}"
            raise ValueError(msg)

        with pytest.raises(ValueError, match="the caller's own bug at version 1"):
            asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(interval_seconds=0.0, on_progress=_buggy)))

    def test_wait_for_result_ends_with_a_cancellation_during_a_progress_read(self, mocker: MockerFixture) -> None:
        client, _ = _serving_client({"/results": [_running()]})
        mocker.patch.object(client, "get_run_progress", mocker.AsyncMock(side_effect=asyncio.CancelledError()))
        on_progress = mocker.Mock()

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(interval_seconds=0.0, on_progress=on_progress)))

        on_progress.assert_not_called()

    # ── the progress read never holds the wait past its timeout ──

    def test_wait_for_result_times_out_on_a_progress_read_that_outlasts_the_budget(self, mocker: MockerFixture) -> None:
        """A progress read still unanswered when the budget runs out ends the wait at its timeout, not at the read's own."""
        client, _ = _serving_client({"/results": [_running()]})

        async def _never_answers(run_id: str) -> RunProgress:
            await asyncio.Event().wait()
            return RunProgress.model_validate(_snapshot(pipeline_run_id=run_id))

        mocker.patch.object(client, "get_run_progress", mocker.AsyncMock(side_effect=_never_answers))
        on_progress = mocker.Mock()
        started_at = monotonic()

        with pytest.raises(RunTimeoutError) as exc_info:
            asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(timeout_seconds=0.05, on_progress=on_progress)))

        # Far below the progress read's own 30-second request timeout.
        assert monotonic() - started_at < 5.0
        assert exc_info.value.timeout_seconds == 0.05
        assert isinstance(exc_info.value.__cause__, TimeoutError)
        on_progress.assert_not_called()

    def test_wait_for_result_checks_the_deadline_again_before_the_progress_read(self, mocker: MockerFixture) -> None:
        """A results read that used up the budget leaves no time for a progress read: the wait ends without one."""
        clock = [0.0]
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=lambda: clock[0])
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)

        def _slow_results(run_id: str, **_options: object) -> RunResultRunning:
            clock[0] += 1.5
            return _read_running(run_id)

        mocker.patch.object(client, "get_run_result", mocker.AsyncMock(side_effect=_slow_results))
        progress_read = mocker.patch.object(client, "get_run_progress", mocker.AsyncMock())

        with pytest.raises(RunTimeoutError):
            asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(timeout_seconds=1.0, interval_seconds=1.0, on_progress=mocker.Mock())))

        progress_read.assert_not_awaited()

    def test_wait_for_result_takes_the_progress_reads_time_off_the_next_sleep(self, mocker: MockerFixture) -> None:
        """A slow progress read that fails leaves the wait its remaining time to sleep, not a whole interval past the deadline."""
        clock = [0.0]
        mocker.patch("pipelex_sdk.client.monotonic", side_effect=lambda: clock[0])
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        mocker.patch.object(client, "get_run_result", mocker.AsyncMock(side_effect=_read_running))

        def _slow_failure(run_id: str) -> RunProgress:
            clock[0] += 0.9
            msg = f"no answer for {run_id}"
            raise ApiUnreachableError(msg, api_url=BASE_URL, code="ReadError")

        mocker.patch.object(client, "get_run_progress", mocker.AsyncMock(side_effect=_slow_failure))
        sleeps: list[float] = []

        def _sleep(seconds: float) -> None:
            sleeps.append(seconds)
            clock[0] += seconds

        mocker.patch("pipelex_sdk.client.asyncio.sleep", new=mocker.AsyncMock(side_effect=_sleep))

        with pytest.raises(RunTimeoutError):
            asyncio.run(client.wait_for_result("run-1", WaitForResultOptions(timeout_seconds=1.0, interval_seconds=1.0, on_progress=mocker.Mock())))

        assert sleeps == [pytest.approx(0.1)]
        assert clock[0] == pytest.approx(1.0)

    # ── start_and_wait ───────────────────────────────────────────

    def test_start_and_wait_delivers_progress_on_the_hosted_path(self, mocker: MockerFixture) -> None:
        client, _ = _serving_client({"/results": [_running(), _completed()], "/progress": [_json(200, RunProgressBodies.WORKED_EXAMPLE)]})
        mocker.patch.object(client, "_supports_run_lifecycle", mocker.AsyncMock(return_value=True))
        ack = PipelexRunResultStart.model_validate({"pipeline_run_id": "run-1", "state": "STARTED", "created_at": "t0"})
        mocker.patch.object(client, "start", mocker.AsyncMock(return_value=ack))
        delivered: list[RunProgress] = []

        asyncio.run(client.start_and_wait(pipe_code="p", wait_options=WaitForResultOptions(interval_seconds=0.0, on_progress=delivered.append)))

        assert [progress.model_dump(mode="json", exclude_unset=True) for progress in delivered] == [RunProgressBodies.WORKED_EXAMPLE]

    def test_start_and_wait_never_calls_on_progress_on_the_blocking_path(self, mocker: MockerFixture) -> None:
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
        mocker.patch.object(client, "_supports_run_lifecycle", mocker.AsyncMock(return_value=False))
        mocker.patch.object(client, "_execute_blocking", mocker.AsyncMock(return_value=RunResults(pipeline_run_id="run-1", main_stuff={"ok": True})))
        progress_read = mocker.patch.object(client, "get_run_progress", mocker.AsyncMock())
        on_progress = mocker.Mock()

        result = asyncio.run(client.start_and_wait(pipe_code="p", wait_options=WaitForResultOptions(on_progress=on_progress)))

        assert result.main_stuff == {"ok": True}
        progress_read.assert_not_awaited()
        on_progress.assert_not_called()
