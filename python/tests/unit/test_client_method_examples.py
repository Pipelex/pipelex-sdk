"""Tests for a saved method's examples — `create_method_example`, `list_method_examples`, `iterate_method_examples`,
`get_method_example`, `update_method_example`, `record_method_example_latest_run` and `delete_method_example`.

The twin of `pipelex-sdk-js/tests/method-examples.test.ts`. `_send` is mocked; the bodies are the platform's own
serialized shapes (`MethodExampleBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, TypeAlias, cast

import pytest
from pydantic import ValidationError

from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.product_models import (
    MethodExample,
    MethodExampleLatestRunRecorded,
    MethodExampleLatestRunStale,
)
from tests.unit.conftest import BASE_URL
from tests.unit.test_data import MethodExampleBodies

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import ResponseBuilder, SendPatcher


#: A call of one example route on a client, given an example id, as a coroutine `asyncio.run` drives.
ExampleRouteCall: TypeAlias = "Callable[[PipelexAPIClient, str], Coroutine[Any, Any, object]]"

#: A call of one route on a client, as a coroutine `asyncio.run` drives.
MethodRouteCall: TypeAlias = "Callable[[PipelexAPIClient], Coroutine[Any, Any, object]]"

_METHOD_ID = MethodExampleBodies.METHOD_ID
_EXAMPLE_ID = MethodExampleBodies.EXAMPLE_ID
_EXAMPLES_URL = f"{BASE_URL}/v1/methods/{_METHOD_ID}/examples"
_EXAMPLE_URL = f"{_EXAMPLES_URL}/{_EXAMPLE_ID}"

#: The verdict of an argument refused before anything is sent: the caller changes it, and asking again unchanged cannot pass.
_INPUT_VERDICT = ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)

#: One call of each route that addresses one example, by the example id it is given.
_EXAMPLE_ROUTES: list[tuple[str, ExampleRouteCall]] = [
    ("get_method_example", lambda client, example_id: client.get_method_example(_METHOD_ID, example_id)),
    ("update_method_example", lambda client, example_id: client.update_method_example(_METHOD_ID, example_id, name="n")),
    (
        "record_method_example_latest_run",
        lambda client, example_id: client.record_method_example_latest_run(_METHOD_ID, example_id, run_id="run_2", input_revision=1),
    ),
    ("delete_method_example", lambda client, example_id: client.delete_method_example(_METHOD_ID, example_id)),
]

#: Each route answering an example: its name, its status, the answer carrying a given example, and the call
#: reading it.
_EXAMPLE_READS: list[tuple[str, int, Callable[[dict[str, Any]], object], MethodRouteCall]] = [
    ("get_method_example", 200, lambda example: example, lambda client: client.get_method_example(_METHOD_ID, _EXAMPLE_ID)),
    (
        "list_method_examples",
        200,
        lambda example: {"items": [example], "next_cursor": None},
        lambda client: client.list_method_examples(_METHOD_ID),
    ),
    ("create_method_example", 201, lambda example: example, lambda client: client.create_method_example(_METHOD_ID, name="n", inputs={})),
    ("update_method_example", 200, lambda example: example, lambda client: client.update_method_example(_METHOD_ID, _EXAMPLE_ID, name="n")),
    (
        "record_method_example_latest_run",
        200,
        lambda example: {"outcome": "recorded", "example": example},
        lambda client: client.record_method_example_latest_run(_METHOD_ID, _EXAMPLE_ID, run_id="run_2", input_revision=2),
    ),
]

_EXAMPLE_READ_PARAMS = [pytest.param(status, answer, call, id=name) for name, status, answer, call in _EXAMPLE_READS]

#: One call of example routes addressed by a suffixed method id, which each refuses before sending.
_SUFFIXED_METHOD_ROUTES: list[tuple[str, MethodRouteCall]] = [
    ("create_method_example", lambda client: client.create_method_example("mt_x@3", name="n", inputs={})),
    ("list_method_examples", lambda client: client.list_method_examples("mt_x@3")),
    ("get_method_example", lambda client: client.get_method_example("mt_x@3", _EXAMPLE_ID)),
    ("delete_method_example", lambda client: client.delete_method_example("mt_x@3", _EXAMPLE_ID)),
]


def _sent_method(send: MockType) -> str:
    return cast("str", send.call_args.args[0])


def _sent_url(send: MockType) -> str:
    return cast("str", send.call_args.args[1])


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


async def _collect_examples(client: PipelexAPIClient, *, limit: int | None = None) -> list[MethodExample]:
    return [example async for example in client.iterate_method_examples(_METHOD_ID, limit=limit)]


class TestClientMethodExamples:
    # ----- create_method_example ---------------------------------------------------------------

    def test_create_posts_the_name_the_inputs_and_the_run(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        created = {**MethodExampleBodies.EXAMPLE, "input_revision": 1}
        send = patch_send(api_client, wire_response(201, json_body=created))

        example = asyncio.run(api_client.create_method_example(_METHOD_ID, name="March receipt", inputs=MethodExampleBodies.INPUTS, run_id="run_1"))

        assert _sent_method(send) == "POST"
        assert _sent_url(send) == _EXAMPLES_URL
        assert _sent_body(send) == {"name": "March receipt", "inputs": MethodExampleBodies.INPUTS, "run_id": "run_1"}
        assert isinstance(example, MethodExample)
        assert example.example_id == _EXAMPLE_ID
        assert example.input_revision == 1
        assert example.latest_run_id == "run_1"

    def test_create_without_a_run_sends_none(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        send = patch_send(api_client, wire_response(201, json_body={**MethodExampleBodies.EXAMPLE, "latest_run_id": None}))

        example = asyncio.run(api_client.create_method_example(_METHOD_ID, name="March receipt", inputs={"total": 3}))

        assert _sent_body(send) == {"name": "March receipt", "inputs": {"total": 3}}
        assert example.latest_run_id is None

    @pytest.mark.parametrize(
        ("run_id", "got"),
        [
            pytest.param("", "an empty string", id="empty"),
            pytest.param(7, "int", id="not-a-string"),
        ],
    )
    def test_create_refuses_a_run_id_that_names_no_run_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, run_id: object, got: str
    ) -> None:
        """The platform refuses an empty run id with a `422`, as the latest-run write refuses it before sending."""
        send = patch_send(api_client, wire_response(201, json_body=MethodExampleBodies.EXAMPLE))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.create_method_example(_METHOD_ID, name="n", inputs={}, run_id=cast("str", run_id)))

        assert str(exc_info.value) == (
            f"create_method_example() takes a run_id naming a run of this method that used these inputs, a non-empty string, or none; got {got}."
        )
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("name", "inputs", "got"),
        [
            pytest.param(None, {"total": 3}, "no name", id="no-name"),
            pytest.param("March receipt", None, "no inputs", id="no-inputs"),
            pytest.param(None, None, "neither", id="neither"),
        ],
    )
    def test_create_refuses_a_call_without_its_name_or_its_inputs_before_any_request(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        name: str | None,
        inputs: dict[str, Any] | None,
        got: str,
    ) -> None:
        """A `None` name or inputs would be sent as `null`, which the platform refuses; `@pipelex/sdk` refuses both before sending."""
        send = patch_send(api_client, wire_response(201, json_body=MethodExampleBodies.EXAMPLE))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.create_method_example(_METHOD_ID, name=cast("str", name), inputs=cast("dict[str, Any]", inputs)))

        assert str(exc_info.value) == f"create_method_example() needs the example's name and its inputs; got {got}."
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    def test_create_reads_the_inputs_exactly_as_saved(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """An integer stays an `int` and a float a `float`: a run of the example sends them as saved."""
        patch_send(api_client, wire_response(201, json_body=MethodExampleBodies.EXAMPLE))

        example = asyncio.run(api_client.create_method_example(_METHOD_ID, name="March receipt", inputs=MethodExampleBodies.INPUTS))

        assert example.inputs == MethodExampleBodies.INPUTS
        assert type(example.inputs["total"]) is int
        assert type(example.inputs["rate"]) is float

    def test_create_raises_run_not_found_for_a_run_not_the_methods(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body={"status": 404, "code": "run_not_found", "detail": "No run run_9."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.create_method_example(_METHOD_ID, name="n", inputs={}, run_id="run_9"))

        assert exc_info.value.status == 404
        assert exc_info.value.code == "run_not_found"
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT

    def test_create_raises_payload_too_large_for_an_example_too_large_to_store(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(413, json_body={"status": 413, "code": "payload_too_large", "detail": "Over 400 KB."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.create_method_example(_METHOD_ID, name="n", inputs={"blob": "x"}))

        assert exc_info.value.status == 413
        assert exc_info.value.code == "payload_too_large"
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT

    def test_create_refuses_an_answer_that_is_no_example(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {key: value for key, value in MethodExampleBodies.EXAMPLE.items() if key != "input_revision"}
        patch_send(api_client, wire_response(201, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.create_method_example(_METHOD_ID, name="n", inputs={}))

        unreadable = exc_info.value
        assert str(unreadable) == f"API POST /v1/methods/{_METHOD_ID}/examples answered 201 with a body that is not the answer the route returns"
        assert isinstance(unreadable.__cause__, ValidationError)
        assert error_verdict_of(unreadable) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)

    # ----- list_method_examples and iterate_method_examples ------------------------------------

    def test_list_reads_a_page_of_examples(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        body = {"items": [MethodExampleBodies.EXAMPLE, MethodExampleBodies.REVISED], "next_cursor": "c/2"}
        send = patch_send(api_client, wire_response(200, json_body=body))

        page = asyncio.run(api_client.list_method_examples(_METHOD_ID))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == _EXAMPLES_URL
        assert [example.input_revision for example in page.items] == [2, 3]
        assert page.items[1].latest_run_id is None
        assert page.next_cursor == "c/2"

    def test_list_passes_the_limit_and_cursor(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": [], "next_cursor": None}))

        page = asyncio.run(api_client.list_method_examples(_METHOD_ID, limit=5, cursor="c/2"))

        assert _sent_url(send) == f"{_EXAMPLES_URL}?limit=5&cursor=c%2F2"
        assert page.items == []
        assert page.next_cursor is None

    def test_list_sends_an_explicit_empty_cursor(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        """Presence, not truthiness: an empty cursor is bad input the API refuses, not an omission."""
        send = patch_send(api_client, wire_response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(api_client.list_method_examples(_METHOD_ID, cursor=""))

        assert _sent_url(send) == f"{_EXAMPLES_URL}?cursor="

    def test_list_refuses_a_page_without_its_cursor(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """A page missing `next_cursor` is unreadable, never the last page: read as one, the iterator would stop early without a word."""
        patch_send(api_client, wire_response(200, json_body={"items": [MethodExampleBodies.EXAMPLE]}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(_collect_examples(api_client))

        unreadable = exc_info.value
        assert str(unreadable) == f"API GET /v1/methods/{_METHOD_ID}/examples answered 200 with a body that is not the answer the route returns"
        assert isinstance(unreadable.__cause__, ValidationError)
        assert error_verdict_of(unreadable) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)

    def test_iterate_follows_the_cursor_through_a_short_and_an_empty_page(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        third = {**MethodExampleBodies.EXAMPLE, "example_id": "ex_3"}
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [MethodExampleBodies.EXAMPLE], "next_cursor": "c2"}),
            wire_response(200, json_body={"items": [], "next_cursor": "c3"}),
            wire_response(200, json_body={"items": [MethodExampleBodies.REVISED, third], "next_cursor": None}),
        )

        examples = asyncio.run(_collect_examples(api_client, limit=2))

        assert [example.example_id for example in examples] == [_EXAMPLE_ID, _EXAMPLE_ID, "ex_3"]
        assert [example.input_revision for example in examples] == [2, 3, 2]
        assert [call.args[1] for call in send.call_args_list] == [
            f"{_EXAMPLES_URL}?limit=2",
            f"{_EXAMPLES_URL}?limit=2&cursor=c2",
            f"{_EXAMPLES_URL}?limit=2&cursor=c3",
        ]

    @pytest.mark.parametrize(
        ("method_id", "got"),
        [
            pytest.param("", "got an empty string.", id="empty"),
            pytest.param("..", 'got "..", a dot segment', id="dot-segment"),
            pytest.param("mt_x@3", '"mt_x@3" carries a version suffix', id="suffixed"),
        ],
    )
    def test_iterate_refuses_a_method_id_at_the_call_before_it_is_iterated(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, method_id: str, got: str
    ) -> None:
        """Refused by the call itself, not at the first `__anext__`: an async generator's body runs only once it is iterated."""
        send = patch_send(api_client, wire_response(200, json_body={"items": [], "next_cursor": None}))

        with pytest.raises(RequestArgumentError) as exc_info:
            api_client.iterate_method_examples(method_id)

        assert got in str(exc_info.value)
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    def test_iterate_stops_on_a_cursor_the_server_did_not_advance(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """The no-progress guard of the loop `iterate_methods` and `iterate_runs` share, whose page ceiling
        `test_client_paging.py` covers: the repeated page is yielded once.
        """
        page = {"items": [MethodExampleBodies.EXAMPLE], "next_cursor": "c2"}
        patch_send(api_client, wire_response(200, json_body=page), wire_response(200, json_body=page))

        examples = asyncio.run(_collect_examples(api_client))

        assert [example.example_id for example in examples] == [_EXAMPLE_ID]

    # ----- get_method_example ------------------------------------------------------------------

    def test_get_reads_one_example(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodExampleBodies.EXAMPLE))

        example = asyncio.run(api_client.get_method_example(_METHOD_ID, _EXAMPLE_ID))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == _EXAMPLE_URL
        assert example.model_dump() == MethodExampleBodies.EXAMPLE

    def test_get_encodes_the_example_id(self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodExampleBodies.EXAMPLE))

        asyncio.run(api_client.get_method_example(_METHOD_ID, "ex/1?x"))

        assert _sent_url(send) == f"{_EXAMPLES_URL}/ex%2F1%3Fx"

    def test_get_raises_not_found_for_an_unknown_example(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body={"status": 404, "code": "not_found", "detail": "No example."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method_example(_METHOD_ID, _EXAMPLE_ID))

        assert exc_info.value.code == "not_found"
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT

    # ----- update_method_example ---------------------------------------------------------------

    def test_update_patches_new_inputs_and_reads_the_next_revision(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodExampleBodies.REVISED))

        example = asyncio.run(api_client.update_method_example(_METHOD_ID, _EXAMPLE_ID, inputs={"total": 4}))

        assert _sent_method(send) == "PATCH"
        assert _sent_url(send) == _EXAMPLE_URL
        assert _sent_body(send) == {"inputs": {"total": 4}}
        assert example.input_revision == 3
        assert example.latest_run_id is None

    @pytest.mark.parametrize(
        ("name", "inputs", "expected_body"),
        [
            pytest.param("April receipt", None, {"name": "April receipt"}, id="rename-alone"),
            pytest.param("April receipt", {"total": 4}, {"name": "April receipt", "inputs": {"total": 4}}, id="both"),
            pytest.param(None, {}, {"inputs": {}}, id="empty-inputs-are-inputs"),
        ],
    )
    def test_update_sends_the_fields_given(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        name: str | None,
        inputs: dict[str, Any] | None,
        expected_body: dict[str, Any],
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodExampleBodies.EXAMPLE))

        asyncio.run(api_client.update_method_example(_METHOD_ID, _EXAMPLE_ID, name=name, inputs=inputs))

        assert _sent_body(send) == expected_body

    def test_update_refuses_a_call_naming_no_change_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodExampleBodies.EXAMPLE))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.update_method_example(_METHOD_ID, _EXAMPLE_ID))

        assert str(exc_info.value) == "update_method_example() needs a new name, new inputs, or both; got neither."
        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    def test_update_sends_back_inputs_read_from_an_example_as_they_were_saved(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """Python reads an integer of any size as an `int` and `3.0` as a `float`, so inputs read and sent back
        unchanged are the inputs the platform holds, which `@pipelex/sdk` matches for the integer alone.
        """
        saved = {**MethodExampleBodies.EXAMPLE, "inputs": {"big": 12345678901234567891, "float": 3.0, "nested": [-98765432109876543210]}}
        send = patch_send(api_client, wire_response(200, json_body=saved), wire_response(200, json_body=saved))

        example = asyncio.run(api_client.get_method_example(_METHOD_ID, _EXAMPLE_ID))
        asyncio.run(api_client.update_method_example(_METHOD_ID, _EXAMPLE_ID, inputs=example.inputs))

        content = send.call_args.kwargs["content"]
        assert json.loads(content) == {"inputs": saved["inputs"]}
        assert b"12345678901234567891" in content
        assert b"3.0" in content
        assert b"-98765432109876543210" in content

    def test_update_takes_its_fields_by_keyword_only(self, api_client: PipelexAPIClient) -> None:
        with pytest.raises(TypeError):
            asyncio.run(api_client.update_method_example(_METHOD_ID, _EXAMPLE_ID, "April receipt"))  # type: ignore[misc]  # pyright: ignore[reportCallIssue]

    def test_update_raises_a_retryable_503_when_concurrent_edits_kept_landing(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(503, json_body={"status": 503, "code": "service_unavailable", "detail": "Try again."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.update_method_example(_METHOD_ID, _EXAMPLE_ID, inputs={"total": 5}))

        assert error_verdict_of(exc_info.value) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)

    # ----- record_method_example_latest_run ----------------------------------------------------

    def test_record_puts_the_run_and_its_revision_and_reads_a_recorded_verdict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        recorded = {**MethodExampleBodies.EXAMPLE, "latest_run_id": "run_2"}
        send = patch_send(api_client, wire_response(200, json_body={"outcome": "recorded", "example": recorded}))

        result = asyncio.run(api_client.record_method_example_latest_run(_METHOD_ID, _EXAMPLE_ID, run_id="run_2", input_revision=2))

        assert _sent_method(send) == "PUT"
        assert _sent_url(send) == f"{_EXAMPLE_URL}/latest-run"
        assert _sent_body(send) == {"run_id": "run_2", "input_revision": 2}
        match result:
            case MethodExampleLatestRunRecorded():
                assert result.example.latest_run_id == "run_2"
            case MethodExampleLatestRunStale():
                pytest.fail("A recorded verdict read as stale.")

    def test_record_reads_a_stale_verdict_rather_than_raising(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """A run that outlasted an edit is a verdict about the run: the example comes back as it now stands."""
        patch_send(api_client, wire_response(200, json_body={"outcome": "stale", "example": MethodExampleBodies.REVISED}))

        result = asyncio.run(api_client.record_method_example_latest_run(_METHOD_ID, _EXAMPLE_ID, run_id="run_2", input_revision=2))

        match result:
            case MethodExampleLatestRunStale():
                assert result.example.input_revision == 3
                assert result.example.latest_run_id is None
            case MethodExampleLatestRunRecorded():
                pytest.fail("A stale verdict read as recorded.")

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({"example": MethodExampleBodies.EXAMPLE}, id="no-outcome"),
            pytest.param({"outcome": "refused", "example": MethodExampleBodies.EXAMPLE}, id="unknown-outcome"),
            pytest.param({"outcome": "recorded"}, id="no-example"),
            pytest.param({"outcome": "stale", "example": "ex_1"}, id="example-not-an-object"),
        ],
    )
    def test_record_refuses_an_answer_off_the_union(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        """A body that names no known outcome, or breaks its arm, is never mistaken for a verdict: it is an
        answer the SDK cannot read, pydantic's refusal as its cause.
        """
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.record_method_example_latest_run(_METHOD_ID, _EXAMPLE_ID, run_id="run_2", input_revision=2))

        unreadable = exc_info.value
        assert str(unreadable) == (
            f"API PUT /v1/methods/{_METHOD_ID}/examples/{_EXAMPLE_ID}/latest-run answered 200 with a body that is not the answer the route returns"
        )
        assert isinstance(unreadable.__cause__, ValidationError)
        assert error_verdict_of(unreadable) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)

    @pytest.mark.parametrize(
        ("run_id", "input_revision", "field"),
        [
            pytest.param("", 2, "run_id", id="empty-run-id"),
            pytest.param(None, 2, "run_id", id="none-run-id"),
            pytest.param("run_2", 0, "input_revision", id="zero-revision"),
            pytest.param("run_2", True, "input_revision", id="bool-revision"),
            pytest.param("run_2", 2.0, "input_revision", id="float-revision"),
            pytest.param("run_2", "2", "input_revision", id="string-revision"),
            pytest.param("run_2", None, "input_revision", id="none-revision"),
        ],
    )
    def test_record_refuses_a_run_or_revision_that_names_none_before_any_request(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        run_id: object,
        input_revision: object,
        field: str,
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={}))

        with pytest.raises(RequestArgumentError, match=rf"^record_method_example_latest_run\(\) takes an? {field}[ ,].*; got .+\.$") as exc_info:
            asyncio.run(
                api_client.record_method_example_latest_run(
                    _METHOD_ID, _EXAMPLE_ID, run_id=cast("str", run_id), input_revision=cast("int", input_revision)
                )
            )

        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    def test_record_raises_not_found_for_an_example_deleted_since(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body={"status": 404, "code": "not_found", "detail": "No example."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.record_method_example_latest_run(_METHOD_ID, _EXAMPLE_ID, run_id="run_2", input_revision=2))

        assert exc_info.value.code == "not_found"

    # ----- delete_method_example ---------------------------------------------------------------

    def test_delete_sends_a_delete_and_reads_the_204(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(204))

        result = asyncio.run(api_client.delete_method_example(_METHOD_ID, _EXAMPLE_ID))

        assert result is None
        assert _sent_method(send) == "DELETE"
        assert _sent_url(send) == _EXAMPLE_URL
        assert _sent_body(send) is None

    def test_delete_raises_not_found_for_an_example_already_deleted(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(404, json_body={"status": 404, "code": "not_found", "detail": "No example."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.delete_method_example(_METHOD_ID, _EXAMPLE_ID))

        assert exc_info.value.status == 404

    # ----- the example routes' ids -------------------------------------------------------------

    @pytest.mark.parametrize("route", [pytest.param(route, id=name) for name, route in _EXAMPLE_ROUTES])
    def test_an_example_route_refuses_an_empty_example_id_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, route: ExampleRouteCall
    ) -> None:
        """An empty id would address the examples list rather than an example."""
        send = patch_send(api_client, wire_response(200, json_body={}))

        with pytest.raises(
            RequestArgumentError, match=r"takes an example id, the example's non-empty `example_id`; got an empty string\.$"
        ) as exc_info:
            asyncio.run(route(api_client, ""))

        assert error_verdict_of(exc_info.value) == _INPUT_VERDICT
        send.assert_not_called()

    def test_an_example_route_refuses_an_example_id_that_is_not_a_string(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={}))

        with pytest.raises(RequestArgumentError, match=r"^get_method_example\(\) takes an example id, .*; got None\.$"):
            asyncio.run(api_client.get_method_example(_METHOD_ID, cast("str", None)))

        send.assert_not_called()

    @pytest.mark.parametrize("route", [pytest.param(route, id=name) for name, route in _SUFFIXED_METHOD_ROUTES])
    def test_an_example_route_refuses_a_suffixed_method_id_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, route: MethodRouteCall
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={}))

        with pytest.raises(RequestArgumentError, match='"mt_x@3" carries a version suffix'):
            asyncio.run(route(api_client))

        send.assert_not_called()

    def test_an_example_route_raises_method_being_deleted(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(409, json_body={"status": 409, "code": "method_being_deleted", "detail": "Being deleted."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_examples(_METHOD_ID))

        assert exc_info.value.code == "method_being_deleted"

    @pytest.mark.parametrize(("status", "answer", "call"), _EXAMPLE_READ_PARAMS)
    def test_an_example_without_its_latest_run_is_an_answer_the_sdk_cannot_read(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        status: int,
        answer: Callable[[dict[str, Any]], object],
        call: MethodRouteCall,
    ) -> None:
        """The platform always sends `latest_run_id`, `None` when there is none, so an example without it is
        never read as one with no latest run, as `@pipelex/sdk` refuses it.
        """
        example = {key: value for key, value in MethodExampleBodies.EXAMPLE.items() if key != "latest_run_id"}
        patch_send(api_client, wire_response(status, json_body=answer(example)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(call(api_client))

        unreadable = exc_info.value
        assert str(unreadable).endswith(f"answered {status} with a body that is not the answer the route returns")
        assert isinstance(unreadable.__cause__, ValidationError)
        assert error_verdict_of(unreadable) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param("input_revision", "2", id="revision-as-a-string"),
            pytest.param("input_revision", 2.0, id="revision-as-a-float"),
            pytest.param("input_revision", True, id="revision-as-a-boolean"),
            pytest.param("input_revision", 2**53, id="revision-past-the-safe-range"),
            pytest.param("example_id", 7, id="numeric-example-id"),
            pytest.param("latest_run_id", 1, id="numeric-latest-run-id"),
            pytest.param("inputs", [3], id="inputs-as-a-list"),
        ],
    )
    @pytest.mark.parametrize(("status", "answer", "call"), _EXAMPLE_READ_PARAMS)
    def test_an_example_holding_a_field_of_another_type_is_an_answer_the_sdk_cannot_read(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        status: int,
        answer: Callable[[dict[str, Any]], object],
        call: MethodRouteCall,
        field: str,
        value: object,
    ) -> None:
        """Read strictly, as `@pipelex/sdk` reads it, so both SDKs refuse the same answers: a revision `"2"` is never coerced to `2`,
        and one past 2^53 - 1, which a JavaScript number cannot hold, is refused here too.
        """
        patch_send(api_client, wire_response(status, json_body=answer({**MethodExampleBodies.EXAMPLE, field: value})))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(call(api_client))

        unreadable = exc_info.value
        assert str(unreadable).endswith(f"answered {status} with a body that is not the answer the route returns")
        assert isinstance(unreadable.__cause__, ValidationError)
        assert error_verdict_of(unreadable) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)
