"""Tests for `start_and_wait`'s hosted/bare self-healing — the version handshake + blocking fallback.

No equivalent exists in `mthds-python` (whose `start_and_wait` raises on a bare runner); this is the
SDK's own enhancement (`supports_run_lifecycle` + `execute_blocking`), mirroring `pipelex-sdk-js`.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, cast

import httpx
import pytest
from mthds.protocol.pipe_io_contracts import PipeIOContract

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError, MissingMainStuffError, RunLifecycleUnavailableError
from pipelex_sdk.runs import PipelexRunResultStart, TokensUsageRecord, WaitForResultOptions

if TYPE_CHECKING:
    from pytest_mock import MockerFixture

    from tests.unit.conftest import UnreachableClientBuilder

_BASE_URL = "http://localhost:8081"

_HOSTED_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-hosted", "runner_version": "0.9.0"}
_BARE_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-api", "runner_version": "1.2.3"}
# A spec-compliant runner may report only the protocol base fields — `implementation` is an
# optional extension. Such a base-only response cannot be classified by name; the client must
# discover the missing lifecycle at runtime (start 404s) and self-heal to the blocking path.
_BASE_ONLY_VERSION = {"protocol_version": "0.6.0", "runner_version": "9.9.9"}

# A completed blocking-execute response: `main_stuff_name` (an extension field) names the
# working-memory root key of the main stuff, which the SDK resolves into `RunResults.main_stuff`.
_EXECUTE_BODY: dict[str, object] = {
    "pipeline_run_id": "run-x",
    "main_stuff_name": "result",
    "pipe_output": {
        "working_memory": {
            "root": {"result": {"concept": "native.Text", "content": {"text": "hello"}}},
            "aliases": {"main_stuff": "result"},
        },
        "pipeline_run_id": "run-x",
    },
}

# The executed graph as the runner returns it inside `pipe_output` — the same document a local run
# writes as `graphspec.json`.
_GRAPH_SPEC: dict[str, Any] = {
    "meta": {"format": "mthds", "mode": "live"},
    "nodes": [{"id": "pipe_1", "status": "COMPLETED"}],
    "edges": [],
}

# The runner's `pipe_io_artifacts` envelope: the three I/O artifacts together, since they share a
# key set and are built in one pass. The hosted results body relays them as three siblings instead.
_PIPE_IO_ARTIFACTS: dict[str, Any] = {
    "pipe_io_contracts": {
        "x.greet": {
            "inputs": {},
            "output": {
                "concept_ref": "native.Text",
                "multiplicity": "single",
                "item_count": None,
                "optional": False,
                "json_schema": {"type": "object", "properties": {"text": {"type": "string"}}},
            },
        },
    },
    "input_form": {"x.greet": {"fields": []}},
    "output_form": {"x.greet": {"field": {"name": "text", "kind": "prose", "required": True}}},
}


def _execute_body_with(**pipe_output_extension_fields: object) -> dict[str, object]:
    """The completed blocking body with Pipelex extension fields added onto its `pipe_output`."""
    base_pipe_output = cast("dict[str, object]", _EXECUTE_BODY["pipe_output"])
    return {**_EXECUTE_BODY, "pipe_output": {**base_pipe_output, **pipe_output_extension_fields}}


def _response(status_code: int, *, json: object = None, headers: dict[str, str] | None = None) -> httpx.Response:
    request = httpx.Request("GET", f"{_BASE_URL}/x")
    if json is None:
        return httpx.Response(status_code, headers=headers or {}, request=request)
    return httpx.Response(status_code, json=json, headers=headers or {}, request=request)


class _Server:
    """A server answering each path from a queue, and recording each request's path and read timeout,
    the limit the client gave it; an answer that is an exception class is raised as no answer at all.
    """

    def __init__(self, answers: dict[str, list[httpx.Response | type[httpx.TransportError]]]) -> None:
        self.answers = answers
        self.requests: list[tuple[str, float | None]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        timeout = cast("dict[str, float | None]", request.extensions["timeout"])
        self.requests.append((request.url.path, timeout["read"]))
        answer = self.answers[request.url.path].pop(0)
        if isinstance(answer, httpx.Response):
            return answer
        msg = f"simulated {answer.__name__}"
        raise answer(msg, request=request)

    def client(self) -> PipelexAPIClient:
        client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
        client.client = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        return client


def _hosted_run(run_id: str) -> dict[str, list[httpx.Response | type[httpx.TransportError]]]:
    return {
        "/v1/start": [httpx.Response(202, json={"pipeline_run_id": run_id, "state": "STARTED", "created_at": "t0"})],
        f"/v1/runs/{run_id}/results": [httpx.Response(200, json={"pipeline_run_id": run_id, "main_stuff": {}})],
    }


def _urls(send_mock: Any) -> list[str]:
    """The URL (second positional arg) of every `_send` call, in order."""
    return [call.args[1] for call in send_mock.call_args_list]


class TestClientRunFallback:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    # ── Hosted (durable start + poll) ────────────────────────────

    def test_hosted_handshakes_then_starts_then_polls(self, mocker: MockerFixture) -> None:
        """Version (hosted) → start (202) → results (200); the durable path maps the result verbatim."""
        client = self._client()
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_HOSTED_VERSION),
                    _response(202, json={"pipeline_run_id": "run-1", "state": "STARTED", "created_at": "t0"}),
                    _response(200, json={"pipeline_run_id": "run-1", "main_stuff": {"answer": 42}, "graph_spec": {"n": 1}}),
                ]
            ),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.pipeline_run_id == "run-1"
        assert result.main_stuff == {"answer": 42}
        assert result.graph_spec == {"n": 1}
        assert _urls(send) == [f"{_BASE_URL}/v1/version", f"{_BASE_URL}/v1/start", f"{_BASE_URL}/v1/runs/run-1/results"]

    def test_caches_the_version_handshake_across_calls(self, mocker: MockerFixture) -> None:
        """The /v1/version handshake is performed once and cached for the client's lifetime."""
        client = self._client()
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_HOSTED_VERSION),
                    _response(202, json={"pipeline_run_id": "r1", "state": "STARTED", "created_at": "t0"}),
                    _response(200, json={"pipeline_run_id": "r1", "main_stuff": {}}),
                    _response(202, json={"pipeline_run_id": "r2", "state": "STARTED", "created_at": "t1"}),
                    _response(200, json={"pipeline_run_id": "r2", "main_stuff": {}}),
                ]
            ),
        )

        asyncio.run(client.start_and_wait(pipe_code="p"))
        asyncio.run(client.start_and_wait(pipe_code="p"))
        assert _urls(send).count(f"{_BASE_URL}/v1/version") == 1

    def test_hosted_completed_with_null_main_stuff_raises(self, mocker: MockerFixture) -> None:
        """A hosted 200 whose `main_stuff` is null is a completed run that delivered nothing — hard fail."""
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_HOSTED_VERSION),
                    _response(202, json={"pipeline_run_id": "run-1", "state": "STARTED", "created_at": "t0"}),
                    _response(200, json={"pipeline_run_id": "run-1", "main_stuff": None, "graph_spec": {"n": 1}}),
                ]
            ),
        )

        with pytest.raises(MissingMainStuffError):
            asyncio.run(client.start_and_wait(pipe_code="p"))

    # ── `on_started`: the run's id while the wait goes on ────────

    def test_on_started_hands_over_the_ack_once_before_the_first_poll(self, mocker: MockerFixture) -> None:
        """The callback gets the start acknowledgement whole, a `method_ref` run's provenance included,
        once, after the start and before any results read.
        """
        client = self._client()
        events: list[str] = []
        acks: list[PipelexRunResultStart] = []
        responses = iter(
            [
                _response(200, json=_HOSTED_VERSION),
                _response(
                    202,
                    json={
                        "pipeline_run_id": "run-1",
                        "state": "STARTED",
                        "created_at": "t0",
                        "method_provenance": {"address": "github.com/acme/methods", "tag": "v1.0.0", "commit_sha": "abc123"},
                    },
                ),
                _response(202, headers={"Retry-After": "0"}),
                _response(200, json={"pipeline_run_id": "run-1", "main_stuff": {"answer": 42}}),
            ]
        )

        def _send(method: str, url: str, **_kwargs: object) -> httpx.Response:
            events.append(f"{method} {url.removeprefix(_BASE_URL)}")
            return next(responses)

        def _on_started(ack: PipelexRunResultStart) -> None:
            events.append("on_started")
            acks.append(ack)

        mocker.patch.object(client, "_send", side_effect=_send)

        result = asyncio.run(
            client.start_and_wait(
                method_ref="github.com/acme/methods@v1.0.0",
                wait_options=WaitForResultOptions(interval_seconds=0),
                on_started=_on_started,
            )
        )
        assert result.main_stuff == {"answer": 42}
        assert events == [
            "GET /v1/version",
            "POST /v1/start",
            "on_started",
            "GET /v1/runs/run-1/results",
            "GET /v1/runs/run-1/results",
        ]
        assert len(acks) == 1
        assert acks[0].pipeline_run_id == "run-1"
        assert acks[0].method_provenance is not None
        assert acks[0].method_provenance.commit_sha == "abc123"

    def test_on_started_is_never_called_on_a_bare_runner(self, mocker: MockerFixture) -> None:
        """The blocking execute has no run id to give before it answers, so the callback is not called."""
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=_EXECUTE_BODY)]),
        )
        on_started = mocker.Mock()

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"], on_started=on_started))
        assert result.main_stuff == {"text": "hello"}
        on_started.assert_not_called()

    def test_on_started_is_never_called_on_the_fallback_to_blocking(self, mocker: MockerFixture) -> None:
        """A start refused for want of a run store creates no run, so the fallback has nothing to announce."""
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_BASE_ONLY_VERSION),
                    _response(404, json={"detail": "Not Found"}),
                    _response(200, json=_EXECUTE_BODY),
                ]
            ),
        )
        on_started = mocker.Mock()

        result = asyncio.run(client.start_and_wait(pipe_code="p", on_started=on_started))
        assert result.pipeline_run_id == "run-x"
        on_started.assert_not_called()

    def test_an_exception_from_on_started_propagates_before_any_poll(self, mocker: MockerFixture) -> None:
        """The callback runs synchronously: what it raises leaves `start_and_wait` at once, nothing polled."""
        client = self._client()
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_HOSTED_VERSION),
                    _response(202, json={"pipeline_run_id": "run-1", "state": "STARTED", "created_at": "t0"}),
                ]
            ),
        )

        def _on_started(_ack: PipelexRunResultStart) -> None:
            msg = "the caller's own failure"
            raise ValueError(msg)

        with pytest.raises(ValueError, match="the caller's own failure"):
            asyncio.run(client.start_and_wait(pipe_code="p", on_started=_on_started))
        assert _urls(send) == [f"{_BASE_URL}/v1/version", f"{_BASE_URL}/v1/start"]

    # ── Bare runner (blocking execute fallback) ──────────────────

    def test_bare_runner_falls_back_to_blocking_execute(self, mocker: MockerFixture) -> None:
        """A bare runner (`implementation == pipelex-api`) skips start and runs the blocking POST /v1/execute."""
        client = self._client()
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=_EXECUTE_BODY)]),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.pipeline_run_id == "run-x"
        # The SDK resolves `main_stuff` out of the working memory via `main_stuff_name` ("result") —
        # its content, the same shape the hosted path relays; the full working memory rides pipe_output.
        assert result.main_stuff == {"text": "hello"}
        # `pipe_output` is the already-parsed protocol model, carried over without a dump round-trip.
        assert result.pipe_output is not None
        assert result.pipe_output.working_memory.root["result"].content == {"text": "hello"}
        assert _urls(send) == [f"{_BASE_URL}/v1/version", f"{_BASE_URL}/v1/execute"]

    def test_blocking_fallback_unpacks_usage_pair_from_pipe_output(self, mocker: MockerFixture) -> None:
        """The blocking execute response carries usage inside `pipe_output` (extension-open); the SDK
        unpacks it onto `RunResults.tokens_usages` / `.usage_assembly_error` so the accessor reads the
        same on both paths. A body without the pair (usage off) leaves both None.
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
        usage_body: dict[str, object] = {
            "pipeline_run_id": "run-x",
            "main_stuff_name": "result",
            "pipe_output": {
                "working_memory": {
                    "root": {"result": {"concept": "native.Text", "content": {"text": "hello"}}},
                    "aliases": {"main_stuff": "result"},
                },
                "pipeline_run_id": "run-x",
                "tokens_usages": tokens_usages,
                "usage_assembly_error": None,
            },
        }
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=usage_body)]),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.tokens_usages is not None
        record = result.tokens_usages[0]
        # Same typed record the durable path yields — the pair is validated, not passed through raw.
        assert isinstance(record, TokensUsageRecord)
        assert record.inference_model_name == "test-model"
        assert record.pipe_code == "test_domain.summarize"
        assert record.nb_tokens_by_category == {"input": 15, "output": 4}
        assert record.cost == 0.000105
        assert result.usage_assembly_error is None

    def test_blocking_fallback_without_usage_pair_defaults_to_none(self, mocker: MockerFixture) -> None:
        """A blocking response whose pipe_output carries no usage fields (usage off, or an older
        runner) maps to None on both fields — never a validation error.
        """
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=_EXECUTE_BODY)]),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.tokens_usages is None
        assert result.usage_assembly_error is None

    def test_blocking_fallback_lifts_the_working_memory_off_pipe_output(self, mocker: MockerFixture) -> None:
        """The standard declares `pipe_output.working_memory` required, so the SDK lifts it onto
        `RunResults.working_memory` and the field always carries a value on this path — set in
        `model_fields_set` like every other lifted field, where the hosted path may leave it unset.
        """
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=_EXECUTE_BODY)]),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.working_memory is not None
        assert "working_memory" in result.model_fields_set
        assert result.working_memory.root["result"].content == {"text": "hello"}
        assert result.working_memory.aliases == {"main_stuff": "result"}
        # The same memory the runner's own envelope carries — lifted, not copied or re-parsed.
        assert result.pipe_output is not None
        assert result.working_memory is result.pipe_output.working_memory

    def test_blocking_fallback_lifts_the_executed_graph_off_pipe_output(self, mocker: MockerFixture) -> None:
        """The runner returns the executed graph inside `pipe_output`; the SDK lifts it onto
        `RunResults.graph_spec` so the field carries the same document whichever path ran.
        Regression: this path used to write `graph_spec=None` and drop the graph the runner had
        already returned.
        """
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_BARE_VERSION),
                    _response(200, json=_execute_body_with(graph_spec=_GRAPH_SPEC, graph_assembly_error=None)),
                ]
            ),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.graph_spec == _GRAPH_SPEC
        assert result.graph_assembly_error is None

    def test_blocking_fallback_lifts_a_graph_assembly_failure_off_pipe_output(self, mocker: MockerFixture) -> None:
        """A broken assembly and a run with no graph both leave `graph_spec` None; the lifted
        `graph_assembly_error` is what separates them.
        """
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_BARE_VERSION),
                    _response(200, json=_execute_body_with(graph_spec=None, graph_assembly_error="failed to assemble the graph for the run")),
                ]
            ),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.graph_spec is None
        assert result.graph_assembly_error == "failed to assemble the graph for the run"

    def test_blocking_fallback_unwraps_the_io_artifacts_envelope_off_pipe_output(self, mocker: MockerFixture) -> None:
        """The runner carries the three I/O artifacts in one `pipe_io_artifacts` envelope; the SDK
        unwraps it onto the hosted shape's three sibling fields, typed from the standard, so each
        artifact has one accessor whichever path ran.
        """
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_BARE_VERSION),
                    _response(200, json=_execute_body_with(pipe_io_artifacts=_PIPE_IO_ARTIFACTS, pipe_io_artifacts_error=None)),
                ]
            ),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.pipe_io_contracts is not None
        assert isinstance(result.pipe_io_contracts["x.greet"], PipeIOContract)
        assert result.pipe_io_contracts["x.greet"].output.concept_ref == "native.Text"
        assert result.input_form is not None
        assert result.input_form["x.greet"].fields == []
        assert result.output_form is not None
        assert result.output_form["x.greet"].field.name == "text"
        assert result.pipe_io_artifacts_error is None
        # The dumped artifacts are the envelope's members, verbatim: unwrapping moved them, nothing else.
        dumped = result.model_dump(mode="json")
        assert dumped["pipe_io_contracts"] == _PIPE_IO_ARTIFACTS["pipe_io_contracts"]
        assert dumped["input_form"] == _PIPE_IO_ARTIFACTS["input_form"]
        # The envelope itself is not a field of `RunResults`: it stays on the runner's own output.
        assert "pipe_io_artifacts" not in dumped
        assert result.pipe_output is not None
        assert (result.pipe_output.model_extra or {})["pipe_io_artifacts"] == _PIPE_IO_ARTIFACTS

    def test_blocking_fallback_lifts_an_io_artifacts_build_failure_off_pipe_output(self, mocker: MockerFixture) -> None:
        """A null envelope leaves all three artifacts None, and the lifted `pipe_io_artifacts_error`
        is what separates a broken build from a run that described nothing.
        """
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_BARE_VERSION),
                    _response(
                        200,
                        json=_execute_body_with(pipe_io_artifacts=None, pipe_io_artifacts_error="failed to build the I/O artifacts for the run"),
                    ),
                ]
            ),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.pipe_io_contracts is None
        assert result.input_form is None
        assert result.output_form is None
        assert result.pipe_io_artifacts_error == "failed to build the I/O artifacts for the run"

    def test_blocking_fallback_without_graph_or_artifacts_sets_every_lifted_field_to_none(self, mocker: MockerFixture) -> None:
        """A blocking response whose `pipe_output` carries neither the graph pair nor the artifacts
        (tracing off, or an older runner) maps every lifted field to None — never a validation
        error — and, unlike a hosted body missing the keys, marks each as set: on the blocking path
        the SDK always answers, as the JS twin writes `null` there.
        """
        client = self._client()
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=_EXECUTE_BODY)]),
        )

        result = asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))
        assert result.graph_spec is None
        assert result.graph_assembly_error is None
        assert result.pipe_io_contracts is None
        assert result.input_form is None
        assert result.output_form is None
        assert result.pipe_io_artifacts_error is None
        assert {
            "graph_spec",
            "graph_assembly_error",
            "pipe_io_contracts",
            "input_form",
            "output_form",
            "pipe_io_artifacts_error",
        } <= result.model_fields_set

    def test_blocking_fallback_raises_when_main_stuff_unlocatable(self, mocker: MockerFixture) -> None:
        """A completed blocking response whose `main_stuff_name` names no root stuff is a hard fail."""
        client = self._client()
        # `main_stuff_name` points at "answer", but the working-memory root has no such stuff.
        bad_body: dict[str, object] = {
            "pipeline_run_id": "run-y",
            "main_stuff_name": "answer",
            "pipe_output": {
                "working_memory": {"root": {"other": {"concept": "native.Text", "content": {}}}, "aliases": {}},
                "pipeline_run_id": "run-y",
            },
        }
        mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=bad_body)]),
        )

        with pytest.raises(MissingMainStuffError):
            asyncio.run(client.start_and_wait(pipe_code="p", mthds_contents=["x"]))

    def test_fallback_forwards_extra_extension_args(self, mocker: MockerFixture) -> None:
        """An `extra` extension arg rides the blocking execute body as a top-level field — not dropped."""
        client = self._client()
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(side_effect=[_response(200, json=_BARE_VERSION), _response(200, json=_EXECUTE_BODY)]),
        )

        asyncio.run(client.start_and_wait(inputs={"topic": "demo"}, extra={"some_vendor_selector": "sel_123"}))
        execute_call = send.call_args_list[1]
        assert execute_call.args[1] == f"{_BASE_URL}/v1/execute"
        assert '"some_vendor_selector":"sel_123"' in execute_call.kwargs["content"].decode("utf-8")

    def test_self_heals_when_base_only_version_hides_missing_run_store(self, mocker: MockerFixture) -> None:
        """A base-only version looks hosted → start 404s (no run created) → fall back; the negative is cached."""
        client = self._client()
        send = mocker.patch.object(
            client,
            "_send",
            mocker.AsyncMock(
                side_effect=[
                    _response(200, json=_BASE_ONLY_VERSION),
                    _response(404, json={"detail": "Not Found"}),
                    _response(200, json=_EXECUTE_BODY),
                    _response(200, json={**_EXECUTE_BODY, "pipeline_run_id": "run-x2"}),
                ]
            ),
        )

        first = asyncio.run(client.start_and_wait(pipe_code="p"))
        assert first.pipeline_run_id == "run-x"
        assert _urls(send) == [f"{_BASE_URL}/v1/version", f"{_BASE_URL}/v1/start", f"{_BASE_URL}/v1/execute"]

        # Second call: negative cached — no version re-handshake, no start retry, straight to execute.
        second = asyncio.run(client.start_and_wait(pipe_code="p"))
        assert second.pipeline_run_id == "run-x2"
        assert _urls(send) == [
            f"{_BASE_URL}/v1/version",
            f"{_BASE_URL}/v1/start",
            f"{_BASE_URL}/v1/execute",
            f"{_BASE_URL}/v1/execute",
        ]

    @pytest.mark.parametrize(
        "body",
        [
            {"type": "about:blank", "title": "Not Found", "status": 404, "error_type": "MethodPackageNotFoundError", "detail": "No package."},
            {"type": "https://pipelex.com/errors/not_found", "title": "Not found", "status": 404, "code": "not_found", "detail": "No method."},
        ],
    )
    def test_a_404_answered_on_purpose_neither_falls_back_nor_demotes_the_client(self, mocker: MockerFixture, body: dict[str, Any]) -> None:
        """A runner's or the platform's own 404 on start is a refusal: raised as is, with the lifecycle still believed served."""
        client = self._client()
        send = mocker.patch.object(client, "_send", mocker.AsyncMock(side_effect=[_response(200, json=_HOSTED_VERSION), _response(404, json=body)]))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.start_and_wait(pipe_code="p"))
        assert not isinstance(exc_info.value, RunLifecycleUnavailableError)
        assert exc_info.value.status == 404
        assert _urls(send) == [f"{_BASE_URL}/v1/version", f"{_BASE_URL}/v1/start"]
        assert client._lifecycle_available is True

    def test_handshake_failure_assumes_hosted(self, mocker: MockerFixture) -> None:
        """When the /v1/version handshake itself fails, assume hosted and let start surface the real error."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(500, json={"detail": "boom"})))

        # version 500 → assume hosted → start hits the same 500 → ApiResponseError, naming the start.
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.start_and_wait(pipe_code="p"))
        assert str(exc_info.value) == "API POST /v1/start failed (500): boom"
        assert client._lifecycle_available is True

    def test_lifecycle_primitives_raise_unavailable_on_bare_404(self, mocker: MockerFixture) -> None:
        """The poll primitives surface a clear RunLifecycleUnavailableError on the bare-runner 404."""
        client = self._client()
        mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=_response(404, json={"detail": "Not Found"})))

        with pytest.raises(RunLifecycleUnavailableError):
            asyncio.run(client.get_run_status("r"))
        with pytest.raises(RunLifecycleUnavailableError):
            asyncio.run(client.get_run_result("r"))
        with pytest.raises(RunLifecycleUnavailableError):
            asyncio.run(client.wait_for_result("r"))

    def test_unreachable_host_maps_to_api_unreachable_on_poll(self, unreachable_client: UnreachableClientBuilder) -> None:
        """A transport failure on a lifecycle GET maps to ApiUnreachableError (the richer transport layer)."""
        client = unreachable_client(httpx.ConnectError)

        with pytest.raises(ApiUnreachableError):
            asyncio.run(client.get_run_result("r"))

    # ── Time limits and an unanswered handshake ──────────────────

    def test_the_handshake_and_a_plain_start_take_the_poll_budget(self) -> None:
        """Both answer fast, so neither waits the blocking ceiling: a host that accepts the connection and never
        answers costs the poll budget, not twenty minutes, before anything is known.
        """
        server = _Server({"/v1/version": [httpx.Response(200, json=_HOSTED_VERSION)], **_hosted_run("r1")})

        asyncio.run(server.client().start_and_wait(pipe_code="p", mthds_contents=["x"]))

        assert server.requests == [("/v1/version", 30.0), ("/v1/start", 30.0), ("/v1/runs/r1/results", 30.0)]

    @pytest.mark.parametrize(
        "selection",
        [
            {"method_ref": "github.com/acme/methods/receipt-review@v1.0.0"},
            {"pipe_code": "p", "extra": {"files": {"main.mthds": 'domain = "d"'}}},
            {"pipe_code": "p", "extra": {"bundle_b64": "UEsDBA=="}},
        ],
        ids=["method_ref", "files", "bundle_b64"],
    )
    def test_a_start_that_fetches_or_uploads_a_method_takes_the_blocking_ceiling(self, selection: dict[str, Any]) -> None:
        """A `method_ref` start makes the server fetch the package before it answers, and a bundle can make the body
        multi-megabyte, so each gets the client's blocking ceiling, as `@pipelex/sdk`'s start does.
        """
        server = _Server({"/v1/version": [httpx.Response(200, json=_HOSTED_VERSION)], **_hosted_run("r1")})
        client = server.client()

        asyncio.run(client.start_and_wait(**selection))

        assert server.requests[1] == ("/v1/start", client.request_timeout_seconds)
        assert client.request_timeout_seconds == 1200.0

    def test_an_unanswered_handshake_sends_no_start_and_is_asked_again(self) -> None:
        server = _Server(
            {
                "/v1/version": [httpx.ConnectTimeout, httpx.Response(200, json=_HOSTED_VERSION)],
                **_hosted_run("r1"),
            }
        )
        client = server.client()

        with pytest.raises(ApiUnreachableError) as exc_info:
            asyncio.run(client.start_and_wait(pipe_code="p"))
        assert exc_info.value.code == "ConnectTimeout"
        assert [path for path, _ in server.requests] == ["/v1/version"]
        assert client._lifecycle_available is None

        # Nothing was cached, so the next call asks again, and runs once the server answers.
        asyncio.run(client.start_and_wait(pipe_code="p"))
        assert [path for path, _ in server.requests] == ["/v1/version", "/v1/version", "/v1/start", "/v1/runs/r1/results"]

    # ── The moment a run may start: on_starting, and a cancellation before it ──

    def test_on_starting_is_called_right_before_the_start(self) -> None:
        server = _Server({"/v1/version": [httpx.Response(200, json=_HOSTED_VERSION)], **_hosted_run("r1")})
        seen_at: list[int] = []

        asyncio.run(server.client().start_and_wait(pipe_code="p", on_starting=lambda: seen_at.append(len(server.requests))))

        # Once, after the handshake and before the start.
        assert seen_at == [1]
        assert server.requests[1][0] == "/v1/start"

    def test_on_starting_is_called_before_each_blocking_execute(self) -> None:
        bare = _Server(
            {
                "/v1/version": [httpx.Response(200, json=_BARE_VERSION)],
                "/v1/execute": [httpx.Response(200, json=_EXECUTE_BODY)],
            }
        )
        seen_at: list[int] = []
        asyncio.run(bare.client().start_and_wait(pipe_code="p", on_starting=lambda: seen_at.append(len(bare.requests))))
        assert seen_at == [1]
        assert [path for path, _ in bare.requests] == ["/v1/version", "/v1/execute"]

        # A runner that looked hosted refuses the start before any run exists, then gets the blocking execute:
        # both requests may create a run, so each is announced.
        misdetected = _Server(
            {
                "/v1/version": [httpx.Response(200, json=_BASE_ONLY_VERSION)],
                "/v1/start": [httpx.Response(404, json={"detail": "Not Found"})],
                "/v1/execute": [httpx.Response(200, json=_EXECUTE_BODY)],
            }
        )
        seen_at = []
        asyncio.run(misdetected.client().start_and_wait(pipe_code="p", on_starting=lambda: seen_at.append(len(misdetected.requests))))
        assert seen_at == [1, 2]
        assert [path for path, _ in misdetected.requests] == ["/v1/version", "/v1/start", "/v1/execute"]

    def test_a_cancellation_during_the_handshake_starts_no_run(self) -> None:
        """Cancelled while the version answer is read, the task never sends the start, nor announces one."""
        server = _Server({"/v1/version": [httpx.Response(200, json=_HOSTED_VERSION)], **_hosted_run("r1")})
        handle = server.handle

        def cancel_while_answering(request: httpx.Request) -> httpx.Response:
            task = asyncio.current_task()
            assert task is not None
            task.cancel()
            return handle(request)

        server.handle = cancel_while_answering  # type: ignore[method-assign]
        announced: list[bool] = []

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(server.client().start_and_wait(pipe_code="p", on_starting=lambda: announced.append(True)))
        assert [path for path, _ in server.requests] == ["/v1/version"]
        assert announced == []
