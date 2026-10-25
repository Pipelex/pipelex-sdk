"""Tests for a run the plane refuses: `start`, `execute` and `start_and_wait` raise the typed `ApiResponseError`.

Each case replays a refusal the hosted API answers (`RefusedRunBodies`), and checks that the error's message carries
the reason and its problem carries the code, the failing pipe and the next step — where the inherited
`httpx.HTTPStatusError` regime said only "Client error '422 Unprocessable Entity'". The SDK's error is `mthds`'s own
`ApiResponseError` narrowed, so a handler written against the standard's client catches it too.
"""

from __future__ import annotations

import asyncio
import copy
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from mthds.runners.api.exceptions import ApiResponseError as MthdsApiResponseError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError
from tests.unit.test_data import RefusedRunBodies

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from pytest_mock import MockerFixture, MockType

_BASE_URL = "http://localhost:8081"

_HOSTED_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-hosted", "runner_version": "0.9.0"}


def _start(client: PipelexAPIClient) -> Coroutine[Any, Any, object]:
    return client.start(pipe_code="pitch_product", files={"main.mthds": 'domain = "sales_copy"'})


def _execute(client: PipelexAPIClient) -> Coroutine[Any, Any, object]:
    return client.execute(pipe_code="pitch_product", files={"main.mthds": 'domain = "sales_copy"'})


# Each run route, called with arguments that name something to run: (route, call).
_RUN_ROUTE_CALLS = [pytest.param("start", _start, id="start"), pytest.param("execute", _execute, id="execute")]

# Each refusal: (body, its code, its detail, its next step). The message says the detail alone: the next step rides
# the problem.
_REFUSALS = [
    pytest.param(
        RefusedRunBodies.UNKNOWN_MODEL_AT_LOAD,
        "method.invalid",
        "The method does not validate.",
        RefusedRunBodies.UNKNOWN_MODEL_NEXT_STEP,
        id="unknown-model-at-load",
    ),
    pytest.param(
        RefusedRunBodies.COMBINE_FAILURE_AT_RUN,
        "pipe.output_multiplicity",
        RefusedRunBodies.COMBINE_FAILURE_DETAIL,
        RefusedRunBodies.COMBINE_FAILURE_NEXT_STEP,
        id="combine-failure-at-run",
    ),
    pytest.param(
        RefusedRunBodies.UNSERVED_MODEL_AT_RUN,
        "model.unknown",
        RefusedRunBodies.UNSERVED_MODEL_DETAIL,
        RefusedRunBodies.UNSERVED_MODEL_NEXT_STEP,
        id="unserved-model-at-run",
    ),
]


def _response(status_code: int, *, text: str | None = None, json_body: object | None = None) -> httpx.Response:
    """A wire response: the refusal's raw bytes as `text`, or a JSON body."""
    request = httpx.Request("POST", f"{_BASE_URL}/v1/x")
    if json_body is not None:
        return httpx.Response(status_code, json=json_body, request=request)
    return httpx.Response(status_code, text=text or "", headers={"content-type": "application/problem+json"}, request=request)


class TestClientRefusedRun:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    def _patch_send(self, mocker: MockerFixture, client: PipelexAPIClient, *responses: httpx.Response) -> MockType:
        return mocker.patch.object(client, "_send", mocker.AsyncMock(side_effect=list(responses)))

    def _raised(self, mocker: MockerFixture, body: str, call: Callable[[PipelexAPIClient], Coroutine[Any, Any, object]]) -> ApiResponseError:
        client = self._client()
        self._patch_send(mocker, client, _response(422, text=body))
        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(call(client))
        return exc_info.value

    @pytest.mark.parametrize(("route", "call"), _RUN_ROUTE_CALLS)
    @pytest.mark.parametrize(("body", "code", "detail", "next_step"), _REFUSALS)
    def test_a_refused_run_raises_the_typed_error_with_its_problem(
        self,
        mocker: MockerFixture,
        route: str,
        call: Callable[[PipelexAPIClient], Coroutine[Any, Any, object]],
        body: str,
        code: str,
        detail: str,
        next_step: str,
    ) -> None:
        exc = self._raised(mocker, body, call)

        assert isinstance(exc, MthdsApiResponseError)
        assert not isinstance(exc, httpx.HTTPStatusError)
        assert str(exc) == f"API POST /v1/{route} failed (422): {detail}"
        assert exc.status == 422
        assert exc.status_text == "Unprocessable Entity"
        assert exc.api_url == _BASE_URL
        assert exc.request_url == f"{_BASE_URL}/v1/{route}"
        assert exc.headers["content-type"] == "application/problem+json"
        assert exc.problem.code == code
        assert exc.problem.detail == detail
        assert exc.problem.next_step.detail == next_step
        assert (exc.problem.domain, exc.problem.retry) == ("method", "no")
        assert exc.response_body == body

    def test_a_method_refused_at_load_names_the_failing_pipe_in_its_problem_items(self, mocker: MockerFixture) -> None:
        exc = self._raised(mocker, RefusedRunBodies.UNKNOWN_MODEL_AT_LOAD, _start)

        assert exc.problem.type == "https://mthds.ai/errors/method.invalid"
        assert exc.problem.title == "The method does not validate"
        assert exc.request_id == "req_a3dd6900-7909-48d3-b551-0140e73ac7fc"
        assert exc.problem.next_step.kind == "change_method"
        assert exc.problem.errors is not None
        assert len(exc.problem.errors) == 1
        item = exc.problem.errors[0]
        assert item.code == "model.unknown"
        assert item.detail == RefusedRunBodies.UNKNOWN_MODEL_DETAIL
        assert item.location is not None
        assert (item.location.pipe, item.location.field) == ("draft_pitch", "model")
        assert item.params is not None
        assert item.params.as_wire() == {"model": "gpt-5.1", "model_type": "llm", "suggestions": RefusedRunBodies.UNKNOWN_MODEL_SUGGESTIONS}

    def test_a_run_failed_at_a_combine_step_names_the_pipe_and_leaves_absent_members_none(self, mocker: MockerFixture) -> None:
        exc = self._raised(mocker, RefusedRunBodies.COMBINE_FAILURE_AT_RUN, _execute)

        assert exc.request_id == "req_d4212542-63a6-4ddb-87c9-4b968785c8c5"
        assert exc.problem.detail.startswith("Pipe 'analyze_topics' failed (review_topics → analyze_topics)")
        assert exc.problem.location is not None
        assert exc.problem.location.pipe == "analyze_topics"
        assert exc.problem.next_step.kind == "change_method"
        assert exc.problem.errors is None
        assert exc.problem.retry_after is None

    def test_a_run_failed_on_an_unserved_model_advises_changing_the_model(self, mocker: MockerFixture) -> None:
        exc = self._raised(mocker, RefusedRunBodies.UNSERVED_MODEL_AT_RUN, _execute)

        assert exc.problem.code == "model.unknown"
        assert exc.problem.title == "The model is unknown"
        assert exc.problem.retry == "no"
        assert exc.problem.next_step.kind == "change_model"
        assert exc.problem.errors is None

    def test_start_and_wait_on_a_refused_method_raises_the_typed_error_without_falling_back(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._patch_send(
            mocker, client, _response(200, json_body=_HOSTED_VERSION), _response(422, text=RefusedRunBodies.UNKNOWN_MODEL_AT_LOAD)
        )

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.start_and_wait(pipe_code="pitch_product", files={"main.mthds": 'domain = "sales_copy"'}))

        exc = exc_info.value
        assert str(exc) == "API POST /v1/start failed (422): The method does not validate."
        assert exc.problem.errors is not None
        assert exc.problem.errors[0].location is not None
        assert exc.problem.errors[0].location.pipe == "draft_pitch"
        # A refusal is no missing run store: the durable path stops here, with no blocking retry of the same method.
        assert [call.args[1] for call in send.call_args_list] == [f"{_BASE_URL}/v1/version", f"{_BASE_URL}/v1/start"]

    @pytest.mark.parametrize("duplicate", [copy.copy, copy.deepcopy], ids=["copy", "deepcopy"])
    def test_the_error_survives_copying_with_its_pipelex_members(
        self, mocker: MockerFixture, duplicate: Callable[[ApiResponseError], ApiResponseError]
    ) -> None:
        """Copying goes through the base's `__reduce__`, as pickling across a process boundary does."""
        exc = self._raised(mocker, RefusedRunBodies.UNKNOWN_MODEL_AT_LOAD, _start)

        clone = duplicate(exc)

        assert type(clone) is ApiResponseError
        assert str(clone) == str(exc)
        assert clone.problem == exc.problem
        assert clone.request_url == exc.request_url
