"""Tests for `PipelexAPIClient`'s durable run-lifecycle surface (start/status/results/wait), httpx mocked."""

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import httpx
import pytest
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.models import Problem
from pytest_mock import MockerFixture, MockType

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import (
    ApiResponseError,
    MissingMainStuffError,
    RequestArgumentError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunStillRunningError,
    RunTimeoutError,
)
from pipelex_sdk.runs import (
    DegradationReason,
    PollInfo,
    RunArtifact,
    RunResultCompleted,
    RunResultFailed,
    RunResultRunning,
    RunResults,
    RunStatus,
    TokensUsageRecord,
    WaitForResultOptions,
)
from tests.unit.conftest import problem_document, run_failed_document

_BASE_URL = "http://localhost:8081"

# A run's own problem as the platform stores it on the run row and serves it on the status read and nested in the
# results read's `run.failed` 409 — here the gateway refusing a model not enabled for the organization, with a member
# the standard does not name, which the SDK keeps as received.
_MODEL_REFUSED_PROBLEM: dict[str, Any] = problem_document(
    "model.unavailable",
    501,
    domain="operator",
    detail="The model 'gpt-6-astra' is not enabled for this organization.",
    next_step={"kind": "fix_configuration", "detail": "Configure a backend for the model 'gpt-6-astra' on this deployment."},
    params={"model": "gpt-6-astra", "model_type": "llm", "reason": "not_allowed"},
    location={"pipe": "draft_pitch"},
    provider="pipelex_gateway",
)

# A method fault, the problem's other shape: one problem item per fault.
_METHOD_FAULT_PROBLEM: dict[str, Any] = problem_document(
    "method.invalid",
    422,
    domain="method",
    detail="The method does not validate.",
    next_step={"kind": "change_method", "detail": "Fix each fault the problem's errors list, then validate the method again."},
    errors=[
        {
            "code": "method.concept_unresolved",
            "detail": "Pipe 'summarize' names an unknown concept 'Sumary'.",
            "params": {"concept": "Sumary", "suggestions": ["Summary"]},
            "location": {"pipe": "summarize"},
        }
    ],
)


# The status reads both SDKs must agree on. The file's source is `js/tests/fixtures/run-status-reads.json`,
# which `@pipelex/sdk`'s suite answers to its own status read; this copy is written by `make shared-files`
# at the repository's root and never edited.
_STATUS_READS_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "run-status-reads.json"
_STATUS_READS: list[dict[str, Any]] = json.loads(_STATUS_READS_PATH.read_text(encoding="utf-8"))["cases"]


def _failed_results_problem(run_status: str, run_error: dict[str, Any] | None) -> dict[str, Any]:
    """The results read's `run.failed` 409 as the platform renders it for a run that ended without completing."""
    return {**run_failed_document(run_id="run_1", run_status=run_status, run_error=run_error), "request_id": "req-409"}


def _response(status_code: int, *, json: object = None, headers: dict[str, str] | None = None) -> httpx.Response:
    """Build a constructed httpx.Response with a request attached (so raise_for_status works)."""
    request = httpx.Request("GET", f"{_BASE_URL}/x")
    if json is None:
        return httpx.Response(status_code, headers=headers or {}, request=request)
    return httpx.Response(status_code, json=json, headers=headers or {}, request=request)


class TestClientLifecycle:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    # ── start (inherited body-building + bare-runner 404 translation) ──

    def test_start_targets_v1_url_and_returns_run_result_start(self, mocker: MockerFixture) -> None:
        """Start posts to <base>/v1/start; a 202 parses into RunResultStart with the authoritative id."""
        client = PipelexAPIClient(api_key="t", base_url=f"{_BASE_URL}/")
        body = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-06-10T00:00:00Z"}
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json=body)))

        started = asyncio.run(client.start(pipe_code="answer"))
        assert client.base_url == _BASE_URL
        assert send_mock.call_args.args[1] == f"{_BASE_URL}/v1/start"
        assert started.pipeline_run_id == "run_1"

    def test_start_request_prunes_absent_fields_and_carries_extra(self, mocker: MockerFixture) -> None:
        """Absent fields are pruned (exclude_none); extension args ride the body as top-level properties."""
        client = self._client()
        body = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-06-10T00:00:00Z"}
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json=body)))

        asyncio.run(client.start(pipe_code="answer", extra={"some_vendor_arg": {"nested": True}}))
        sent = send_mock.call_args.kwargs["content"].decode("utf-8")
        assert '"pipe_code":"answer"' in sent
        assert '"some_vendor_arg":{"nested":true}' in sent
        assert "output_name" not in sent

    def test_start_extra_rejects_protocol_args(self) -> None:
        """`extra` is for extension args only — a protocol arg inside it raises a clear client-side error
        (raised by the inherited body-builder, before any request, so the override passes it through).
        """
        client = self._client()
        with pytest.raises(PipelineRequestError, match="pipe_code"):
            asyncio.run(client.start(files={"main.mthds": 'domain = "answer"'}, extra={"pipe_code": "smuggled"}))

    def test_start_bare_runner_missing_route_404_is_lifecycle_unavailable(self, mocker: MockerFixture) -> None:
        """A bare-runner 404 with Starlette's default body (no `code`) becomes RunLifecycleUnavailableError."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json={"detail": "Not Found"})))

        with pytest.raises(RunLifecycleUnavailableError) as exc_info:
            asyncio.run(client.start(pipe_code="answer"))
        assert exc_info.value.api_url == _BASE_URL
        assert f"{_BASE_URL}/v1/start returned 404" in str(exc_info.value)
        # Translated from the typed error the inherited route raised, which stays reachable.
        assert isinstance(exc_info.value.__context__, ApiResponseError)
        assert exc_info.value.__context__.status == 404

    def test_start_runner_refusal_404_stays_api_response_error(self, mocker: MockerFixture) -> None:
        """A runner's 404 relayed by the platform, a problem document, is a refusal, not a missing run store."""
        client = self._client()
        # The runner's answer to a `method_ref` with no package behind it, as the platform relays it.
        body = problem_document("method.not_found", 404, domain="method", detail="No method package at github.com/x/y/z.", request_id="req-404")
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json=body)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.start(pipe_code="p", method_ref="github.com/x/y/z"))
        assert not isinstance(exc_info.value, RunLifecycleUnavailableError)
        assert exc_info.value.problem.code == "method.not_found"
        assert exc_info.value.request_id == "req-404"
        assert str(exc_info.value) == "API POST /v1/start failed (404): No method package at github.com/x/y/z."

    def test_start_platform_404_stays_api_response_error(self, mocker: MockerFixture) -> None:
        """A platform 404 that is a problem document is a normal API error, not lifecycle-unavailable."""
        client = self._client()
        body = problem_document("pipelex.catalog.not_found", 404, detail="The requested resource does not exist.")
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json=body)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.start(pipe_code="answer"))
        assert not isinstance(exc_info.value, RunLifecycleUnavailableError)
        assert exc_info.value.status == 404
        assert exc_info.value.problem.code == "pipelex.catalog.not_found"
        assert str(exc_info.value) == "API POST /v1/start failed (404): The requested resource does not exist."

    def test_start_404_whose_body_is_no_problem_document_is_a_missing_run_store(self, mocker: MockerFixture) -> None:
        """A 404 is a missing route when its body is no problem document, whatever members it carries."""
        client = self._client()
        body = {"code": "NOT_FOUND", "detail": "The requested resource does not exist."}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json=body)))

        with pytest.raises(RunLifecycleUnavailableError):
            asyncio.run(client.start(pipe_code="answer"))

    # ── get_run_status ───────────────────────────────────────────

    def test_get_run_status_populates_degraded_and_retry_after(self, mocker: MockerFixture) -> None:
        """get_run_status hits /v1/runs/{id}/status, parses RunRead, and lifts Retry-After."""
        client = self._client()
        body = {"pipeline_run_id": "run_1", "status": "RUNNING", "created_at": "2026-06-10T00:00:00Z", "degraded": True}
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body, headers={"Retry-After": "7"})))

        run = asyncio.run(client.get_run_status("run_1"))
        assert send_mock.call_args.args[1] == f"{_BASE_URL}/v1/runs/run_1/status"
        assert run.degraded is True
        assert run.retry_after_seconds == 7

    def test_get_run_status_reads_the_runs_problem(self, mocker: MockerFixture) -> None:
        """A status read whose body carries `error` exposes the run's problem on `RunRead.error`, read whole."""
        client = self._client()
        body = {
            "pipeline_run_id": "run_1",
            "status": "FAILED",
            "created_at": "2026-06-10T00:00:00Z",
            "finished_at": "2026-06-10T00:01:00Z",
            "error": _METHOD_FAULT_PROBLEM,
            "degraded": False,
        }
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        run = asyncio.run(client.get_run_status("run_1"))
        assert run.status == RunStatus.FAILED
        assert run.error is not None
        assert run.error.code == "method.invalid"
        assert (run.error.domain, run.error.retry) == ("method", "no")
        assert run.error.errors is not None
        assert run.error.errors[0].code == "method.concept_unresolved"
        assert run.error.errors[0].location is not None
        assert run.error.errors[0].location.pipe == "summarize"
        assert run.error.as_wire() == _METHOD_FAULT_PROBLEM
        assert run.model_extra == {}

    @pytest.mark.parametrize(
        "error",
        [
            pytest.param(
                {"error_type": "ValidateBundleError", "message": "Pipe 'summarize' is invalid.", "error_domain": "input"}, id="an-old-report"
            ),
            pytest.param({**_METHOD_FAULT_PROBLEM, "next_step": None}, id="a-member-off-the-standard"),
            pytest.param("the runner crashed", id="a-string"),
        ],
    )
    def test_get_run_status_with_an_error_that_is_no_problem_document_still_answers(self, mocker: MockerFixture, error: object) -> None:
        """A stored `error` that is no problem document reads as None: the status read never fails on it."""
        client = self._client()
        body = {"pipeline_run_id": "run_1", "status": "FAILED", "created_at": "2026-06-10T00:00:00Z", "error": error}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        run = asyncio.run(client.get_run_status("run_1"))
        assert run.status == RunStatus.FAILED
        assert run.error is None

    def test_get_run_status_without_error_reads_none(self, mocker: MockerFixture) -> None:
        """A run that has not failed carries no report: `error` is None, whether absent or null."""
        client = self._client()
        body = {"pipeline_run_id": "run_1", "status": "RUNNING", "created_at": "2026-06-10T00:00:00Z", "error": None}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        run = asyncio.run(client.get_run_status("run_1"))
        assert run.error is None

    @pytest.mark.parametrize("status_read", _STATUS_READS, ids=[case["name"] for case in _STATUS_READS])
    def test_get_run_status_reads_each_shared_status_read(self, mocker: MockerFixture, status_read: dict[str, Any]) -> None:
        """Each shared status read yields what both SDKs agree on: `degraded`, `degradation`, `request_id`, the hint."""
        client = self._client()
        headers = {} if status_read["retry_after"] is None else {"Retry-After": status_read["retry_after"]}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=status_read["body"], headers=headers)))

        run = asyncio.run(client.get_run_status(status_read["body"]["pipeline_run_id"]))

        expected = status_read["expected"]
        assert run.degraded is expected["degraded"]
        assert run.request_id == expected["request_id"]
        assert run.retry_after_seconds == expected["retry_after_seconds"]
        assert (run.error.code if run.error is not None else None) == expected["error_code"]
        assert run.model_extra == {}
        if expected["degradation"] is None:
            assert run.degradation is None
            return
        assert run.degradation is not None
        kept = {key: value for key, value in run.degradation.model_dump().items() if value is not None}
        assert kept == {key: value for key, value in expected["degradation"].items() if value is not None}
        known_reasons = {reason.value for reason in DegradationReason}
        assert isinstance(run.degradation.reason, DegradationReason) is (expected["degradation"]["reason"] in known_reasons)

    def test_get_run_status_lifecycle_unavailable_on_missing_route(self, mocker: MockerFixture) -> None:
        """A bare-runner 404 on the status route becomes RunLifecycleUnavailableError."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json={"detail": "Not Found"})))

        with pytest.raises(RunLifecycleUnavailableError):
            asyncio.run(client.get_run_status("run_1"))

    def test_get_run_status_run_not_found_is_api_response_error(self, mocker: MockerFixture) -> None:
        """The platform's structured run-not-found 404 raises the typed error, naming the read and the problem's code."""
        client = self._client()
        body = problem_document("run.not_found", 404, detail="Run not found.", params={"pipeline_run_id": "run 1"})
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json=body)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.get_run_status("run 1"))
        exc = exc_info.value
        assert not isinstance(exc, RunLifecycleUnavailableError)
        assert exc.problem.code == "run.not_found"
        assert exc.problem.type == "https://docs.pipelex.com/errors/run.not_found"
        assert exc.request_url == f"{_BASE_URL}/v1/runs/run%201/status"
        assert str(exc) == "API GET /v1/runs/run%201/status failed (404): Run not found."

    # ── get_run_result status mapping ────────────────────────────

    def test_get_run_result_completed_keeps_polymorphic_main_stuff(self, mocker: MockerFixture) -> None:
        """A 200 maps to RunResultCompleted; a list main_stuff stays a top-level array; graph_spec is parsed."""
        client = self._client()
        body: dict[str, object] = {
            "pipeline_run_id": "run_1",
            "main_stuff": [{"color": "red"}, {"color": "blue"}],
            "graph_spec": {"nodes": []},
        }
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert send_mock.call_args.args[1] == f"{_BASE_URL}/v1/runs/run_1/results"
        assert isinstance(state, RunResultCompleted)
        assert state.result.main_stuff == [{"color": "red"}, {"color": "blue"}]
        assert state.result.graph_spec == {"nodes": []}

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"pipeline_run_id": "run_1"}, id="main_stuff_key_omitted"),
            pytest.param({"pipeline_run_id": "run_1", "main_stuff": None}, id="main_stuff_null"),
        ],
    )
    def test_get_run_result_completed_without_main_stuff_raises_typed_error(self, mocker: MockerFixture, body: dict[str, object]) -> None:
        """A 200 that omits main_stuff (or sends it null) raises MissingMainStuffError, not a raw Pydantic error."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        with pytest.raises(MissingMainStuffError) as exc_info:
            asyncio.run(client.get_run_result("run_1"))
        assert exc_info.value.run_id == "run_1"

    def test_get_run_result_completed_keeps_falsy_main_stuff(self, mocker: MockerFixture) -> None:
        """A present-but-falsy main_stuff (an empty list) is a valid output and does NOT raise."""
        client = self._client()
        body: dict[str, object] = {"pipeline_run_id": "run_1", "main_stuff": []}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultCompleted)
        assert state.result.main_stuff == []

    # ── get_run_result artifact selection ────────────────────────

    @pytest.mark.parametrize(
        ("artifacts", "expected_query"),
        [
            pytest.param([RunArtifact.MAIN_STUFF], "artifacts=main_stuff", id="one"),
            pytest.param(
                [RunArtifact.TOKENS_USAGES, RunArtifact.MAIN_STUFF, RunArtifact.GRAPH_SPEC],
                "artifacts=graph_spec,main_stuff,tokens_usages",
                id="declaration_order",
            ),
            pytest.param([RunArtifact.MAIN_STUFF, RunArtifact.MAIN_STUFF], "artifacts=main_stuff", id="deduplicated"),
            pytest.param(list(RunArtifact), "artifacts=" + ",".join(RunArtifact), id="all_named"),
        ],
    )
    def test_get_run_result_sends_the_selection_as_one_comma_separated_param(
        self, mocker: MockerFixture, artifacts: list[RunArtifact], expected_query: str
    ) -> None:
        """A selection is one `artifacts` param, in declaration order, each name once, commas unescaped."""
        client = self._client()
        body: dict[str, object] = {"pipeline_run_id": "run_1", "main_stuff": {"text": "hi"}}
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        asyncio.run(client.get_run_result("run_1", artifacts=artifacts))
        assert send_mock.call_args.args[1] == f"{_BASE_URL}/v1/runs/run_1/results?{expected_query}"

    def test_get_run_result_without_a_selection_sends_no_query(self, mocker: MockerFixture) -> None:
        """No selection reads everything, exactly as before: the URL carries no `artifacts` param."""
        client = self._client()
        body: dict[str, object] = {"pipeline_run_id": "run_1", "main_stuff": {"text": "hi"}}
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert send_mock.call_args.args[1] == f"{_BASE_URL}/v1/runs/run_1/results"
        assert isinstance(state, RunResultCompleted)
        assert state.result.carries(RunArtifact.MAIN_STUFF) is True

    def test_get_run_result_refuses_an_empty_selection_before_sending(self, mocker: MockerFixture) -> None:
        """An empty selection names nothing; it is refused client-side and no request is made."""
        client = self._client()
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(PipelineRequestError, match="at least one RunArtifact"):
            asyncio.run(client.get_run_result("run_1", artifacts=[]))
        send_mock.assert_not_called()

    @pytest.mark.parametrize(
        ("artifacts", "unknown"),
        [
            pytest.param(["graphspec"], "graphspec", id="alone"),
            pytest.param([RunArtifact.MAIN_STUFF, "graphspec", "forms"], "forms, graphspec", id="beside-a-known-one"),
        ],
    )
    def test_get_run_result_refuses_an_unknown_name_before_sending(self, mocker: MockerFixture, artifacts: list[str], unknown: str) -> None:
        """A plain string that names no `RunArtifact` is refused, never dropped into a narrower selection."""
        client = self._client()
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock())

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(client.get_run_result("run_1", artifacts=cast("list[RunArtifact]", artifacts)))
        assert str(exc_info.value).startswith(f"Unknown result artifact(s) {unknown}; valid artifacts are: graph_spec, ")
        assert (exc_info.value.problem.domain, exc_info.value.problem.retry) == ("input", "no")
        send_mock.assert_not_called()

    @pytest.mark.parametrize(
        "artifacts",
        [
            pytest.param("main_stuff", id="plain-string"),
            pytest.param(RunArtifact.MAIN_STUFF, id="single-enum-member"),
        ],
    )
    def test_a_bare_string_selection_is_a_type_error_before_sending(self, mocker: MockerFixture, artifacts: str) -> None:
        """A bare string, an enum member included, is no selection: it is never split into characters
        and refused as unknown names, and no run is read, polled or started for it.
        """
        client = self._client()
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock())
        selection = cast("list[RunArtifact]", artifacts)
        expected = (
            '"artifacts" must be a list or tuple naming one or more of graph_spec, pipe_io_contracts, input_form, output_form, '
            "main_stuff, working_memory, tokens_usages."
        )

        with pytest.raises(TypeError) as read_info:
            asyncio.run(client.get_run_result("run_1", artifacts=selection))
        with pytest.raises(TypeError) as wait_info:
            asyncio.run(client.wait_for_result("run_1", artifacts=selection))
        with pytest.raises(TypeError) as start_info:
            asyncio.run(client.start_and_wait(pipe_code="p", artifacts=selection))
        for exc_info in (read_info, wait_info, start_info):
            assert str(exc_info.value) == expected
            assert not isinstance(exc_info.value, PipelineRequestError)
        send_mock.assert_not_called()

    def test_get_run_result_takes_a_plain_string_that_names_an_artifact(self, mocker: MockerFixture) -> None:
        client = self._client()
        body: dict[str, object] = {"pipeline_run_id": "run_1", "graph_spec": {"nodes": []}}
        send_mock = mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        asyncio.run(client.get_run_result("run_1", artifacts=cast("list[RunArtifact]", ["graph_spec"])))
        assert send_mock.call_args.args[1] == f"{_BASE_URL}/v1/runs/run_1/results?artifacts=graph_spec"

    def test_get_run_result_selection_without_main_stuff_does_not_require_one(self, mocker: MockerFixture) -> None:
        """A selection that leaves `main_stuff` out reads a body without it, and that is the answer, not a fault."""
        client = self._client()
        body: dict[str, object] = {"pipeline_run_id": "run_1", "graph_spec": {"nodes": []}, "output_form": None}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        state = asyncio.run(client.get_run_result("run_1", artifacts=[RunArtifact.GRAPH_SPEC, RunArtifact.OUTPUT_FORM]))
        assert isinstance(state, RunResultCompleted)
        result = state.result
        assert result.graph_spec == {"nodes": []}
        assert result.main_stuff is None
        assert result.carries(RunArtifact.GRAPH_SPEC) is True
        assert result.carries(RunArtifact.OUTPUT_FORM) is True
        assert result.output_form is None
        assert result.carries(RunArtifact.MAIN_STUFF) is False
        assert result.carries(RunArtifact.WORKING_MEMORY) is False

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"pipeline_run_id": "run_1"}, id="main_stuff_key_omitted"),
            pytest.param({"pipeline_run_id": "run_1", "main_stuff": None}, id="main_stuff_null"),
        ],
    )
    def test_get_run_result_selection_naming_main_stuff_still_requires_one(self, mocker: MockerFixture, body: dict[str, object]) -> None:
        """A selection that asks for `main_stuff` keeps the invariant: none delivered is `MissingMainStuffError`."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        with pytest.raises(MissingMainStuffError) as exc_info:
            asyncio.run(client.get_run_result("run_1", artifacts=[RunArtifact.MAIN_STUFF, RunArtifact.TOKENS_USAGES]))
        assert exc_info.value.run_id == "run_1"

    def test_get_run_result_carries_the_usage_pair_only_when_both_fields_came(self, mocker: MockerFixture) -> None:
        """`TOKENS_USAGES` names the envelope: it is carried when the body holds both of its fields."""
        client = self._client()
        body: dict[str, object] = {"pipeline_run_id": "run_1", "main_stuff": {"text": "hi"}, "tokens_usages": None, "usage_assembly_error": None}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        state = asyncio.run(client.get_run_result("run_1", artifacts=[RunArtifact.MAIN_STUFF, RunArtifact.TOKENS_USAGES]))
        assert isinstance(state, RunResultCompleted)
        assert state.result.carries(RunArtifact.TOKENS_USAGES) is True
        assert state.result.tokens_usages is None
        partial = RunResults.model_validate({"pipeline_run_id": "run_1", "tokens_usages": []})
        assert partial.carries(RunArtifact.TOKENS_USAGES) is False

    def test_get_run_result_with_a_selection_maps_a_202_to_running(self, mocker: MockerFixture) -> None:
        """The in-flight body names the selected fields as null; the client still reads it as running."""
        client = self._client()
        body: dict[str, object] = {"pipeline_run_id": "run_1", "main_stuff": None}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json=body, headers={"Retry-After": "4"})))

        state = asyncio.run(client.get_run_result("run_1", artifacts=[RunArtifact.MAIN_STUFF]))
        assert isinstance(state, RunResultRunning)
        assert state.retry_after_seconds == 4

    def test_get_run_result_completed_parses_usage_pair(self, mocker: MockerFixture) -> None:
        """A 200 carrying the hosted usage pair validates the relayed records into
        `TokensUsageRecord`s; a body without them (older platform / pre-artifact run) defaults both
        to None.
        """
        client = self._client()
        tokens_usages = [
            {
                "model_type": "llm",
                "inference_model_name": "test-model",
                "inference_model_id": "test-model-2026-01-01",
                "pipe_code": "test_domain.summarize",
                "job_category": "llm_job",
                "unit_job_id": "llm_gen_text",
                "nb_tokens_by_category": {"input": 15, "output": 4},
                "cost": 0.000105,
                "started_at": "2026-06-20T10:00:01+00:00",
                "completed_at": "2026-06-20T10:00:03+00:00",
            }
        ]
        body: dict[str, object] = {
            "pipeline_run_id": "run_1",
            "main_stuff": {"answer": "42"},
            "tokens_usages": tokens_usages,
            "usage_assembly_error": None,
        }
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(200, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultCompleted)
        assert state.result.tokens_usages is not None
        record = state.result.tokens_usages[0]
        assert isinstance(record, TokensUsageRecord)
        assert record.inference_model_name == "test-model"
        assert record.pipe_code == "test_domain.summarize"
        assert record.nb_tokens_by_category == {"input": 15, "output": 4}
        assert record.cost == 0.000105
        assert state.result.usage_assembly_error is None

        bare = RunResults(pipeline_run_id="run_1", main_stuff={"answer": "42"})
        assert bare.tokens_usages is None
        assert bare.usage_assembly_error is None

    def test_get_run_result_running_honors_retry_after(self, mocker: MockerFixture) -> None:
        """A 202 maps to RunResultRunning with the server's Retry-After hint."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, headers={"Retry-After": "3"})))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultRunning)
        assert state.retry_after_seconds == 3

    def test_get_run_result_degraded_503_defaults_retry(self, mocker: MockerFixture) -> None:
        """A 503 (DynamoDB/Temporal degraded) maps to running with the default retry, never a failure."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(503)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultRunning)
        assert state.retry_after_seconds == 5

    def test_get_run_result_failed_carries_the_runs_problem(self, mocker: MockerFixture) -> None:
        """A 409 `run.failed` carrying the run's status and its own problem maps to RunResultFailed with both, read whole."""
        client = self._client()
        body = _failed_results_problem("FAILED", _MODEL_REFUSED_PROBLEM)
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultFailed)
        assert state.status == RunStatus.FAILED
        assert state.message == "The run 'run_1' ended FAILED."
        assert state.problem.code == "run.failed"
        assert (state.problem.model_extra or {})["request_id"] == "req-409"
        run_error = state.error
        assert run_error is not None
        assert run_error.code == "model.unavailable"
        assert (run_error.domain, run_error.retry) == ("operator", "no")
        assert run_error.next_step.kind == "fix_configuration"
        assert run_error.params is not None
        assert run_error.params.as_wire() == {"model": "gpt-6-astra", "model_type": "llm", "reason": "not_allowed"}
        # A member the standard does not name is kept as received.
        assert (run_error.model_extra or {})["provider"] == "pipelex_gateway"
        # Nothing is stripped: the problem dumps back to exactly what the platform stored.
        assert run_error.as_wire() == _MODEL_REFUSED_PROBLEM

    @pytest.mark.parametrize("run_status", [RunStatus.FAILED, RunStatus.CANCELLED, RunStatus.TERMINATED, RunStatus.TIMED_OUT])
    def test_get_run_result_failed_without_a_run_error_reads_its_status(self, mocker: MockerFixture, run_status: RunStatus) -> None:
        """A `run.failed` nesting no `run_error` is a failure with no problem of its own, with the status its parameters name."""
        client = self._client()
        body = _failed_results_problem(run_status, None)
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultFailed)
        assert state.status == run_status
        assert state.error is None
        assert state.message == f"The run 'run_1' ended {run_status}."

    def test_get_run_result_failed_reads_the_status_parameter_not_the_sentence(self, mocker: MockerFixture) -> None:
        """The status comes from the `run_status` parameter; the sentence is never parsed, so a detail naming another word does not win."""
        client = self._client()
        body = _failed_results_problem("CANCELLED", None)
        body["detail"] = "Run finished with status TIMED_OUT; no result available"
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultFailed)
        assert state.status == RunStatus.CANCELLED

    @pytest.mark.parametrize(
        "params",
        [
            pytest.param({"pipeline_run_id": "run_1"}, id="no-status"),
            pytest.param({"pipeline_run_id": "run_1", "run_status": "SOMETHING_NEW"}, id="a-status-from-tomorrow"),
            pytest.param({"pipeline_run_id": "run_1", "run_status": 7}, id="a-status-that-is-no-string"),
        ],
    )
    def test_get_run_result_failed_without_a_known_status_parameter_reads_failed(self, mocker: MockerFixture, params: dict[str, Any]) -> None:
        """A `run.failed` without a `run_status` this SDK knows reads as FAILED, the status every such answer shares."""
        client = self._client()
        body = {**_failed_results_problem("FAILED", None), "params": params}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultFailed)
        assert state.status == RunStatus.FAILED
        assert state.message == body["detail"]
        assert state.error is None

    @pytest.mark.parametrize(
        "run_error",
        [
            pytest.param({"message": "boom", "error_domain": "runtime"}, id="an-old-report"),
            pytest.param({**_MODEL_REFUSED_PROBLEM, "next_step": None}, id="a-member-off-the-standard"),
            pytest.param("the runner crashed", id="a-string"),
        ],
    )
    def test_get_run_result_failed_with_a_run_error_that_is_no_problem_document_reads_none(self, mocker: MockerFixture, run_error: object) -> None:
        """A `run_error` that is no problem document reads as None; the failed arm still answers."""
        client = self._client()
        body = {**_failed_results_problem("FAILED", None), "run_error": run_error}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultFailed)
        assert state.status == RunStatus.FAILED
        assert state.error is None

    def test_get_run_result_reads_run_not_finished_as_running(self, mocker: MockerFixture) -> None:
        """A 409 `run.not_finished` is the run still going, waiting the problem's own `retry_after`."""
        client = self._client()
        body = problem_document("run.not_finished", 409, domain="runtime", retry="yes", retry_after=3, params={"pipeline_run_id": "run_1"})
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        state = asyncio.run(client.get_run_result("run_1"))
        assert isinstance(state, RunResultRunning)
        assert state.retry_after_seconds == 3

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"code": "conflict", "run_status": "FAILED"}, id="no-problem-document"),
            pytest.param(problem_document("request.idempotency_conflict", 409), id="another-code"),
        ],
    )
    def test_get_run_result_raises_a_409_that_is_no_run_failed_or_run_not_finished(self, mocker: MockerFixture, body: dict[str, Any]) -> None:
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.get_run_result("run_1"))
        assert exc_info.value.status == 409

    def test_get_run_result_lifecycle_unavailable_on_missing_route(self, mocker: MockerFixture) -> None:
        """A bare-runner 404 on the results route becomes RunLifecycleUnavailableError."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json={"detail": "Not Found"})))

        with pytest.raises(RunLifecycleUnavailableError):
            asyncio.run(client.get_run_result("run_1"))

    def test_get_run_result_server_fault_is_api_response_error(self, mocker: MockerFixture) -> None:
        """A non-2xx the poll does not map to a state (here a 500) raises the typed error."""
        client = self._client()
        body = problem_document("runtime.unexpected", 500, domain="runtime", detail="boom", request_id="req-500")
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(500, json=body)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.get_run_result("run_1"))
        assert exc_info.value.status == 500
        assert exc_info.value.problem.code == "runtime.unexpected"
        assert exc_info.value.request_id == "req-500"
        assert str(exc_info.value) == "API GET /v1/runs/run_1/results failed (500): boom"

    # ── execute 202 degrade → re-exported RunStillRunningError ────

    def test_execute_202_raises_re_exported_still_running(self, mocker: MockerFixture) -> None:
        """A 202 on execute raises RunStillRunningError (re-exported from mthds) carrying run_id + hints."""
        client = self._client()
        body = {"pipeline_run_id": "run_1", "state": "RUNNING", "created_at": "2026-06-10T00:00:00Z"}
        headers = {"Retry-After": "10", "Location": "/v1/runs/run_1/results"}
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(202, json=body, headers=headers)))

        with pytest.raises(RunStillRunningError) as exc_info:
            asyncio.run(client.execute(pipe_code="answer"))
        assert exc_info.value.run_id == "run_1"
        assert exc_info.value.retry_after_seconds == 10

    # ── wait_for_result poll loop ────────────────────────────────

    def test_wait_for_result_polls_until_completed(self, mocker: MockerFixture) -> None:
        """The loop polls past a running state and returns the completed result; on_poll fires per wait."""
        client = self._client()
        result = RunResults(pipeline_run_id="run_1", main_stuff={"answer": "42"})
        mocker.patch.object(
            client,
            "get_run_result",
            mocker.AsyncMock(
                side_effect=[
                    RunResultRunning(pipeline_run_id="run_1", retry_after_seconds=0),
                    RunResultCompleted(pipeline_run_id="run_1", result=result),
                ]
            ),
        )
        mocker.patch("pipelex_sdk.client.asyncio.sleep", mocker.AsyncMock())
        polls: list[PollInfo] = []

        returned = asyncio.run(client.wait_for_result("run_1", WaitForResultOptions(interval_seconds=0.0, on_poll=polls.append)))
        assert returned.main_stuff == {"answer": "42"}
        assert len(polls) == 1
        assert polls[0].attempt == 1

    def test_wait_for_result_threads_the_selection_to_every_poll(self, mocker: MockerFixture) -> None:
        """Every results read of the loop carries the caller's selection."""
        client = self._client()
        result = RunResults(pipeline_run_id="run_1", main_stuff={"answer": "42"})
        get_mock = mocker.patch.object(
            client,
            "get_run_result",
            mocker.AsyncMock(
                side_effect=[
                    RunResultRunning(pipeline_run_id="run_1", retry_after_seconds=0),
                    RunResultCompleted(pipeline_run_id="run_1", result=result),
                ]
            ),
        )
        mocker.patch("pipelex_sdk.client.asyncio.sleep", mocker.AsyncMock())

        asyncio.run(client.wait_for_result("run_1", WaitForResultOptions(interval_seconds=0.0), artifacts=[RunArtifact.MAIN_STUFF]))
        assert [call.kwargs["artifacts"] for call in get_mock.call_args_list] == [[RunArtifact.MAIN_STUFF], [RunArtifact.MAIN_STUFF]]

    def test_wait_for_result_refuses_an_empty_selection_before_polling(self, mocker: MockerFixture) -> None:
        """An empty selection fails at once rather than after a poll."""
        client = self._client()
        get_mock = mocker.patch.object(client, "get_run_result", mocker.AsyncMock())

        with pytest.raises(PipelineRequestError):
            asyncio.run(client.wait_for_result("run_1", artifacts=[]))
        get_mock.assert_not_called()

    def test_start_and_wait_threads_the_selection_to_the_wait(self, mocker: MockerFixture) -> None:
        """On the hosted path the selection reaches `wait_for_result`; an empty one never starts a run."""
        client = self._client()
        mocker.patch.object(client, "_supports_run_lifecycle", mocker.AsyncMock(return_value=True))
        start_mock = mocker.patch.object(client, "start", mocker.AsyncMock(return_value=mocker.Mock(pipeline_run_id="run_1")))
        result = RunResults(pipeline_run_id="run_1", main_stuff={"answer": "42"})
        wait_mock = mocker.patch.object(client, "wait_for_result", mocker.AsyncMock(return_value=result))

        returned = asyncio.run(client.start_and_wait(pipe_code="p", artifacts=[RunArtifact.MAIN_STUFF]))
        assert returned is result
        assert wait_mock.call_args.kwargs["artifacts"] == [RunArtifact.MAIN_STUFF]

        with pytest.raises(PipelineRequestError):
            asyncio.run(client.start_and_wait(pipe_code="p", artifacts=[]))
        assert start_mock.call_count == 1

    def test_wait_for_result_raises_run_failed(self, mocker: MockerFixture) -> None:
        """A terminal non-COMPLETED state raises RunFailedError carrying the typed status."""
        client = self._client()
        mocker.patch.object(
            client,
            "get_run_result",
            mocker.AsyncMock(
                return_value=RunResultFailed(
                    pipeline_run_id="run_1",
                    status=RunStatus.CANCELLED,
                    message="cancelled",
                    problem=Problem.model_validate(run_failed_document(run_id="run_1", run_status="CANCELLED")),
                )
            ),
        )

        with pytest.raises(RunFailedError) as exc_info:
            asyncio.run(client.wait_for_result("run_1"))
        assert exc_info.value.run_id == "run_1"
        assert exc_info.value.status == RunStatus.CANCELLED
        assert exc_info.value.problem.code == "run.failed"
        assert exc_info.value.run_error is None

    def test_wait_for_result_raises_run_failed_with_the_runs_problem(self, mocker: MockerFixture) -> None:
        """Over the `run.failed` 409, wait_for_result raises RunFailedError carrying the status, the problem and the run's own."""
        client = self._client()
        body = _failed_results_problem("FAILED", _MODEL_REFUSED_PROBLEM)
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(409, json=body)))

        with pytest.raises(RunFailedError) as exc_info:
            asyncio.run(client.wait_for_result("run_1"))
        err = exc_info.value
        assert err.run_id == "run_1"
        assert err.status == RunStatus.FAILED
        assert str(err) == "The run 'run_1' ended FAILED."
        assert err.problem.code == "run.failed"
        assert err.run_error is not None
        assert err.run_error.code == "model.unavailable"
        assert err.run_error.next_step.detail == "Configure a backend for the model 'gpt-6-astra' on this deployment."
        assert err.run_error.as_wire() == _MODEL_REFUSED_PROBLEM

    def test_wait_for_result_times_out(self, mocker: MockerFixture) -> None:
        """When the run never terminates and the timeout elapses, RunTimeoutError is raised (run survives)."""
        client = self._client()
        mocker.patch.object(
            client,
            "get_run_result",
            mocker.AsyncMock(return_value=RunResultRunning(pipeline_run_id="run_1", retry_after_seconds=0)),
        )

        with pytest.raises(RunTimeoutError) as exc_info:
            asyncio.run(client.wait_for_result("run_1", WaitForResultOptions(timeout_seconds=0.0)))
        assert exc_info.value.run_id == "run_1"
        assert exc_info.value.timeout_seconds == 0.0

    def test_wait_for_result_propagates_cancellation(self, mocker: MockerFixture) -> None:
        """Cancellation surfaces as asyncio.CancelledError (the loop never swallows it; run stays resumable)."""
        client = self._client()
        mocker.patch.object(client, "get_run_result", mocker.AsyncMock(side_effect=asyncio.CancelledError()))

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(client.wait_for_result("run_1"))

    def test_wait_for_result_honours_a_cancellation_in_the_step_its_poll_answers(self, mocker: MockerFixture) -> None:
        """A cancellation arriving in the same loop step as a poll's answer stops the wait after that one poll.

        `asyncio.wait_for` on Python 3.11 returned the finished poll instead of raising here, so the loop
        polled on until its timeout; `asyncio.timeout` delivers the cancellation on every supported version.
        """
        client = self._client()
        options = WaitForResultOptions(interval_seconds=0.02, timeout_seconds=1.0)

        async def _scenario() -> MockType:
            first_answer: asyncio.Future[RunResultRunning] = asyncio.get_running_loop().create_future()
            first_poll_sent = asyncio.Event()

            async def _poll(run_id: str, **_options: object) -> RunResultRunning:
                if not first_poll_sent.is_set():
                    first_poll_sent.set()
                    return await first_answer
                return RunResultRunning(pipeline_run_id=run_id, retry_after_seconds=0)

            poll_mock = mocker.patch.object(client, "get_run_result", mocker.AsyncMock(side_effect=_poll))
            waiting = asyncio.create_task(client.wait_for_result("run_1", options))
            await first_poll_sent.wait()
            # Release the poll's answer and cancel the waiting task in one synchronous step.
            first_answer.set_result(RunResultRunning(pipeline_run_id="run_1", retry_after_seconds=0))
            waiting.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiting
            return poll_mock

        poll_mock = asyncio.run(_scenario())
        assert poll_mock.await_count == 1

    def test_wait_for_result_times_out_on_a_poll_that_outlasts_the_budget(self, mocker: MockerFixture) -> None:
        """A poll still unanswered when the budget runs out ends the wait with RunTimeoutError, not asyncio's TimeoutError."""
        client = self._client()

        async def _never_answers(run_id: str, **_options: object) -> RunResultRunning:
            await asyncio.Event().wait()
            return RunResultRunning(pipeline_run_id=run_id)

        mocker.patch.object(client, "get_run_result", mocker.AsyncMock(side_effect=_never_answers))

        with pytest.raises(RunTimeoutError) as exc_info:
            asyncio.run(client.wait_for_result("run_1", WaitForResultOptions(timeout_seconds=0.05)))
        assert exc_info.value.run_id == "run_1"
        assert exc_info.value.timeout_seconds == 0.05
        assert isinstance(exc_info.value.__cause__, TimeoutError)
