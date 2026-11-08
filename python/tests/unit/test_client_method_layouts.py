"""Tests for a method's stored layouts — `store_method_layout`, its closed body, its refusals and its answer, the direct
read of a version's layouts (`list_method_layouts`), the switch that turns a method's pages off
(`set_method_layouts_off`), and the `layouts` a validate by `method_id` carries when `views` names `layouts`.

The twin of `pipelex-sdk-js/tests/method-layouts.test.ts`. `_send` is mocked; the bodies are the platform's own
serialized shapes (`MethodLayoutBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, cast

import pytest
from pydantic import ValidationError

from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.method_layout_models import LayoutProvenanceInput, MethodLayout, MethodLayoutInput, MethodLayoutList, read_method_layouts
from pipelex_sdk.product_models import MethodData, MethodDetail, PublicMethodDetail, read_method
from pipelex_sdk.validation_models import (
    VALIDATION_VIEW_INPUT_FORM,
    VALIDATION_VIEW_LAYOUTS,
    PipelexInvalidReport,
    PipelexValidationReport,
)
from tests.unit.conftest import BASE_URL, problem_document, refused_argument
from tests.unit.test_data import MethodLayoutBodies

if TYPE_CHECKING:
    import httpx
    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import RecordingClientBuilder, ResponseBuilder, SendPatcher

_METHOD_ID = "mt_receipts01"
_LAYOUTS_PATH = f"/v1/methods/{_METHOD_ID}/versions/3/layouts"
_LAYOUTS_OFF_PATH = f"/v1/methods/{_METHOD_ID}/layouts-off"
_REQUIRED_PROVENANCE: dict[str, Any] = {"producer": "pipelex-method", "model": "claude-4.8-opus"}


def _sent_method(send: MockType) -> str:
    return cast("str", send.call_args.args[0])


def _sent_url(send: MockType) -> str:
    return cast("str", send.call_args.args[1])


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


def _layout_input(**provenance: Any) -> MethodLayoutInput:
    """The write of `MethodLayoutBodies.INPUT`, its provenance replaced by `provenance` when one is given."""
    fields = dict(MethodLayoutBodies.INPUT)
    if provenance:
        fields["provenance"] = provenance
    return MethodLayoutInput.model_validate(fields)


class TestClientMethodLayouts:
    # ----- the write -----------------------------------------------------------------------------

    def test_store_method_layout_posts_the_layout_and_returns_it_as_stored(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.STORED))

        stored = asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, _layout_input()))

        assert _sent_method(send) == "POST"
        assert _sent_url(send) == f"{BASE_URL}{_LAYOUTS_PATH}"
        assert _sent_body(send) == MethodLayoutBodies.INPUT
        assert isinstance(stored, MethodLayout)
        assert stored.model_dump() == MethodLayoutBodies.STORED
        assert stored.stored_at == "2026-11-08T09:00:00.123456+00:00"
        assert stored.provenance.style == "editorial"

    @pytest.mark.parametrize(
        "provenance",
        [
            pytest.param(_REQUIRED_PROVENANCE, id="omitted"),
            pytest.param({**_REQUIRED_PROVENANCE, "seed": None, "style": None, "repair_rounds": None}, id="none"),
        ],
    )
    def test_store_method_layout_leaves_out_each_optional_provenance_field_that_is_none(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, provenance: dict[str, Any]
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.OLDER))

        asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, _layout_input(**provenance)))

        assert _sent_body(send)["provenance"] == _REQUIRED_PROVENANCE

    def test_store_method_layout_sends_a_repair_count_of_zero(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """Zero is a count, not an omission, so it is sent."""
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.OLDER))

        asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, _layout_input(**_REQUIRED_PROVENANCE, repair_rounds=0)))

        assert _sent_body(send)["provenance"] == {**_REQUIRED_PROVENANCE, "repair_rounds": 0}

    @pytest.mark.parametrize(
        ("model", "fields"),
        [
            pytest.param(MethodLayoutInput, {**MethodLayoutBodies.STORED}, id="a-layout-read-back-with-its-stored-at"),
            pytest.param(MethodLayoutInput, {**MethodLayoutBodies.INPUT, "note": "not a field"}, id="an-unknown-field"),
            pytest.param(LayoutProvenanceInput, {**_REQUIRED_PROVENANCE, "extra": True}, id="an-unknown-provenance-field"),
        ],
    )
    def test_the_write_is_closed_at_both_levels(self, model: type[MethodLayoutInput | LayoutProvenanceInput], fields: dict[str, Any]) -> None:
        """The route refuses a field it does not take, so the input refuses it when it is built."""
        with pytest.raises(ValidationError) as exc_info:
            model.model_validate(fields)

        assert exc_info.value.errors()[0]["type"] == "extra_forbidden"

    @pytest.mark.parametrize(
        "stored",
        [
            pytest.param(MethodLayoutBodies.STORED, id="as-the-platform-stores-it"),
            pytest.param(
                {
                    **MethodLayoutBodies.STORED,
                    "generation": 3,
                    "provenance": {**MethodLayoutBodies.STORED["provenance"], "temperature": 0.7},
                },
                id="with-a-field-a-later-platform-adds-at-each-level",
            ),
        ],
    )
    def test_a_layout_read_back_is_written_again_with_only_the_fields_the_write_takes(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, stored: dict[str, Any]
    ) -> None:
        """`from_layout` drops `stored_at` and every extension field the reader kept, at both levels."""
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.STORED))
        read_back = MethodLayout.model_validate(stored)

        asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, MethodLayoutInput.from_layout(read_back)))

        assert _sent_body(send) == MethodLayoutBodies.INPUT

    @pytest.mark.parametrize("repair_rounds", [True, 1.0, "1"])
    def test_the_write_refuses_a_repair_rounds_that_is_not_an_int(self, repair_rounds: object) -> None:
        """A strict `int`, so a value pydantic would coerce is refused rather than sent as an altered count."""
        with pytest.raises(ValidationError) as exc_info:
            LayoutProvenanceInput.model_validate({**_REQUIRED_PROVENANCE, "repair_rounds": repair_rounds})

        assert exc_info.value.errors()[0]["type"] == "int_type"

    @pytest.mark.parametrize("key", [MethodLayoutBodies.KEY, None], ids=["keyed", "unkeyed"])
    def test_store_method_layout_sends_its_key_as_the_idempotency_key_header_never_in_the_body(
        self, recording_client: RecordingClientBuilder, key: str | None
    ) -> None:
        """A write sent again without a key runs again, so the key is what makes a retry answer as the first write."""
        sent: list[httpx.Request] = []
        client = recording_client(sent, 200, json_body=MethodLayoutBodies.STORED)

        asyncio.run(client.store_method_layout(_METHOD_ID, 3, _layout_input(), idempotency_key=key))

        [request] = sent
        assert request.headers.get("idempotency-key") == key
        assert json.loads(request.content) == MethodLayoutBodies.INPUT

    @pytest.mark.parametrize(
        ("key", "fault"),
        [
            pytest.param("", "this one is empty", id="empty"),
            pytest.param("layout 42", "this one holds a character outside visible ASCII", id="space"),
            pytest.param("k" * 256, "this one is 256 characters long", id="too-long"),
            pytest.param(42, "this one is not a string", id="int"),
        ],
    )
    def test_store_method_layout_refuses_a_malformed_key_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, key: object, fault: str
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.STORED))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, _layout_input(), idempotency_key=cast("str", key)))

        message = str(exc_info.value)
        assert fault in message
        assert message.endswith("Leave it out to store the layout without one.")
        send.assert_not_called()

    @pytest.mark.parametrize("version", [0, -1, True, 2.0, "3", None])
    def test_store_method_layout_refuses_a_version_that_is_not_a_positive_integer(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, version: object
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.STORED))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.store_method_layout(_METHOD_ID, cast("int", version), _layout_input()))

        assert str(exc_info.value) == (
            f"store_method_layout() takes a version number, the published version the layout was designed for, a positive integer; got {version!r}."
        )
        assert refused_argument(exc_info.value) == {"argument": "version", "reason": "not_a_positive_integer"}
        send.assert_not_called()

    def test_store_method_layout_refuses_a_suffixed_method_id(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.STORED))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.store_method_layout(f"{_METHOD_ID}@3", 3, _layout_input()))

        assert refused_argument(exc_info.value) == {"argument": "method_id", "reason": "version_suffix"}
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("status", "code", "params"),
        [
            pytest.param(422, "request.invalid", {"field": "tree_digest"}, id="a-tree-that-is-not-the-versions"),
            pytest.param(422, "request.invalid", {"field": "provenance.style"}, id="a-provenance-field-off-its-shape"),
            pytest.param(403, "auth.forbidden", {"requirement": "member"}, id="a-runner"),
            pytest.param(404, "pipelex.catalog.not_found", {"resource": "method", "method_id": _METHOD_ID, "version": None}, id="an-unknown-method"),
            pytest.param(
                404, "pipelex.catalog.not_found", {"resource": "version", "method_id": _METHOD_ID, "version": 3}, id="a-version-never-published"
            ),
            pytest.param(409, "pipelex.catalog.being_deleted", None, id="a-method-being-erased"),
        ],
    )
    def test_store_method_layout_raises_each_refusal_as_its_problem(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        status: int,
        code: str,
        params: dict[str, Any] | None,
    ) -> None:
        members: dict[str, Any] = {} if params is None else {"params": params}
        if params is not None and "field" in params:
            members["location"] = {"field": params["field"]}
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status, **members)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, _layout_input()))

        refusal = exc_info.value
        assert refusal.status == status
        assert refusal.problem.code == code
        assert (refusal.problem.params.as_wire() if refusal.problem.params is not None else None) == params

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({**MethodLayoutBodies.STORED, "stored_at": None}, id="no-stored-at"),
            pytest.param({**MethodLayoutBodies.STORED, "jsonl": []}, id="a-parsed-jsonl"),
            pytest.param({**MethodLayoutBodies.STORED, "provenance": None}, id="no-provenance"),
            pytest.param(
                {**MethodLayoutBodies.STORED, "provenance": {**MethodLayoutBodies.PROVENANCE, "model": 4}}, id="a-model-that-is-not-a-string"
            ),
            pytest.param(["layout"], id="not-an-object"),
        ],
    )
    def test_store_method_layout_refuses_an_answer_that_is_not_a_layout(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: object
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, _layout_input()))

        unreadable = exc_info.value
        assert str(unreadable).startswith(f"API POST {_LAYOUTS_PATH} answered 200 with ")
        assert (unreadable.problem.code, unreadable.problem.domain, unreadable.problem.retry) == ("client.response_unreadable", "runtime", "no")

    def test_a_provenances_optional_fields_read_as_the_platforms_defaults_when_they_do_not_fit(self) -> None:
        provenance = {key: value for key, value in MethodLayoutBodies.PROVENANCE.items() if key != "seed"}
        layout = MethodLayout.model_validate({**MethodLayoutBodies.STORED, "provenance": {**provenance, "style": 7, "repair_rounds": "2"}})

        assert (layout.provenance.seed, layout.provenance.style, layout.provenance.repair_rounds) == (None, None, 0)

    @pytest.mark.parametrize("rounds", [-1, 1.5, True, None])
    def test_a_repair_count_that_is_not_a_non_negative_integer_reads_as_zero(self, rounds: object) -> None:
        layout = MethodLayout.model_validate({**MethodLayoutBodies.STORED, "provenance": {**MethodLayoutBodies.PROVENANCE, "repair_rounds": rounds}})

        assert layout.provenance.repair_rounds == 0

    # ----- the written sample --------------------------------------------------------------------

    def test_store_method_layout_sends_a_written_sample_and_returns_it_as_stored(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        answer = {**MethodLayoutBodies.STORED, "sample_json": MethodLayoutBodies.SAMPLE_JSON}
        send = patch_send(api_client, wire_response(200, json_body=answer))
        layout = MethodLayoutInput.model_validate({**MethodLayoutBodies.INPUT, "sample_json": MethodLayoutBodies.SAMPLE_JSON})

        stored = asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, layout))

        assert _sent_body(send) == {**MethodLayoutBodies.INPUT, "sample_json": MethodLayoutBodies.SAMPLE_JSON}
        assert stored.sample_json == MethodLayoutBodies.SAMPLE_JSON

    def test_store_method_layout_leaves_out_a_sample_that_is_none(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.STORED))

        asyncio.run(api_client.store_method_layout(_METHOD_ID, 3, _layout_input()))

        assert "sample_json" not in _sent_body(send)

    def test_a_layout_read_back_keeps_its_sample_when_written_again(self) -> None:
        read_back = MethodLayout.model_validate({**MethodLayoutBodies.STORED, "sample_json": MethodLayoutBodies.SAMPLE_JSON})

        assert MethodLayoutInput.from_layout(read_back).sample_json == MethodLayoutBodies.SAMPLE_JSON

    @pytest.mark.parametrize(
        "sample",
        [pytest.param(None, id="none"), pytest.param({"total": 12.5}, id="of-another-type"), pytest.param(4, id="a-number")],
    )
    def test_a_sample_that_does_not_fit_reads_as_none(self, sample: object) -> None:
        assert MethodLayout.model_validate({**MethodLayoutBodies.STORED, "sample_json": sample}).sample_json is None

    def test_a_sample_a_platform_that_predates_it_leaves_out_reads_as_none(self) -> None:
        answer = {key: value for key, value in MethodLayoutBodies.STORED.items() if key != "sample_json"}

        assert MethodLayout.model_validate(answer).sample_json is None

    # ----- the direct read ------------------------------------------------------------------------

    def test_list_method_layouts_gets_the_versions_layouts_newest_first(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        newest = {**MethodLayoutBodies.STORED, "sample_json": MethodLayoutBodies.SAMPLE_JSON}
        send = patch_send(api_client, wire_response(200, json_body={"items": [newest, MethodLayoutBodies.OLDER]}))

        answer = asyncio.run(api_client.list_method_layouts(_METHOD_ID, 3))

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == f"{BASE_URL}{_LAYOUTS_PATH}"
        assert _sent_body(send) is None
        assert isinstance(answer, MethodLayoutList)
        assert [layout.prompt_hash for layout in answer.items] == ["a1b2c3d4e5f6", "0f0e0d0c0b0a"]
        assert answer.items[0].sample_json == MethodLayoutBodies.SAMPLE_JSON

    def test_list_method_layouts_answers_an_empty_list_when_none_is_stored(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"items": []}))

        assert asyncio.run(api_client.list_method_layouts(_METHOD_ID, 3)).items == []

    def test_list_method_layouts_leaves_out_an_entry_that_does_not_read_keeping_the_others_in_order(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        items = [MethodLayoutBodies.STORED, {**MethodLayoutBodies.OLDER, "jsonl": 4}, "no layout", MethodLayoutBodies.OLDER]
        patch_send(api_client, wire_response(200, json_body={"items": items}))

        answer = asyncio.run(api_client.list_method_layouts(_METHOD_ID, 3))

        assert [layout.prompt_hash for layout in answer.items] == ["a1b2c3d4e5f6", "0f0e0d0c0b0a"]

    def test_list_method_layouts_holding_no_readable_entry_is_an_empty_list(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"items": ["no layout"]}))

        assert asyncio.run(api_client.list_method_layouts(_METHOD_ID, 3)).items == []

    @pytest.mark.parametrize(
        "body",
        [pytest.param({}, id="no-items"), pytest.param({"items": {"first": MethodLayoutBodies.STORED}}, id="items-that-are-not-a-list")],
    )
    def test_list_method_layouts_refuses_an_answer_it_cannot_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_layouts(_METHOD_ID, 3))

        assert exc_info.value.problem.code == "client.response_unreadable"

    @pytest.mark.parametrize("version", [0, -1, True, 2.0, "3", None])
    def test_list_method_layouts_refuses_a_version_that_is_not_a_positive_integer(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, version: object
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={"items": []}))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.list_method_layouts(_METHOD_ID, cast("int", version)))

        assert str(exc_info.value) == (
            f"list_method_layouts() takes a version number, the published version whose layouts to read, a positive integer; got {version!r}."
        )
        assert refused_argument(exc_info.value) == {"argument": "version", "reason": "not_a_positive_integer"}
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(404, "pipelex.catalog.not_found", id="unknown-method-or-version"),
            pytest.param(409, "pipelex.catalog.being_deleted", id="being-erased"),
            pytest.param(500, "runtime.unexpected", id="a-version-that-predates-trees"),
        ],
    )
    def test_list_method_layouts_raises_each_refusal_as_its_problem(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_layouts(_METHOD_ID, 3))

        assert exc_info.value.status == status
        assert exc_info.value.problem.code == code

    # ----- the off switch -------------------------------------------------------------------------

    def test_set_method_layouts_off_puts_the_whole_list_and_returns_the_method(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.SWITCHED_METHOD))

        method = asyncio.run(api_client.set_method_layouts_off(_METHOD_ID, ["composer"]))

        assert _sent_method(send) == "PUT"
        assert _sent_url(send) == f"{BASE_URL}{_LAYOUTS_OFF_PATH}"
        assert _sent_body(send) == {"catalogs": ["composer"]}
        assert isinstance(method, MethodData)
        assert method.layouts_off == ["composer"]

    def test_set_method_layouts_off_sends_an_empty_list_which_switches_every_design_on(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={**MethodLayoutBodies.SWITCHED_METHOD, "layouts_off": []}))

        method = asyncio.run(api_client.set_method_layouts_off(_METHOD_ID, []))

        assert _sent_body(send) == {"catalogs": []}
        assert method.layouts_off == []

    def test_set_method_layouts_off_sends_entries_as_given_for_the_platform_to_refuse(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.SWITCHED_METHOD))

        asyncio.run(api_client.set_method_layouts_off(_METHOD_ID, ["composer", "composer", "Not A Slug"]))

        assert _sent_body(send) == {"catalogs": ["composer", "composer", "Not A Slug"]}

    @pytest.mark.parametrize(
        ("catalogs", "got"),
        [
            pytest.param("composer", "str", id="a-string"),
            pytest.param(None, "NoneType", id="none"),
            pytest.param(("composer",), "tuple", id="a-tuple"),
        ],
    )
    def test_set_method_layouts_off_refuses_catalogs_that_are_not_a_list(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, catalogs: object, got: str
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.SWITCHED_METHOD))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.set_method_layouts_off(_METHOD_ID, cast("list[str]", catalogs)))

        assert (
            str(exc_info.value)
            == f"set_method_layouts_off() takes the ids of the catalogs to switch off as a list, the whole list, empty for none; got {got}."
        )
        assert refused_argument(exc_info.value) == {"argument": "catalogs", "reason": "not_a_list"}
        send.assert_not_called()

    @pytest.mark.parametrize("key", [MethodLayoutBodies.OFF_KEY, None], ids=["keyed", "unkeyed"])
    def test_set_method_layouts_off_sends_its_key_as_the_idempotency_key_header_never_in_the_body(
        self, recording_client: RecordingClientBuilder, key: str | None
    ) -> None:
        sent: list[httpx.Request] = []
        client = recording_client(sent, 200, json_body=MethodLayoutBodies.SWITCHED_METHOD)

        asyncio.run(client.set_method_layouts_off(_METHOD_ID, ["composer"], idempotency_key=key))

        assert sent[0].headers.get("Idempotency-Key") == key
        assert json.loads(sent[0].content) == {"catalogs": ["composer"]}

    def test_set_method_layouts_off_refuses_a_malformed_key_before_any_request(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.SWITCHED_METHOD))

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(api_client.set_method_layouts_off(_METHOD_ID, [], idempotency_key=""))

        assert str(exc_info.value).endswith("Leave it out to set the layouts off without one.")
        send.assert_not_called()

    @pytest.mark.parametrize(
        ("status", "code"),
        [
            pytest.param(403, "auth.forbidden", id="a-runner"),
            pytest.param(404, "pipelex.catalog.not_found", id="unknown-method"),
            pytest.param(409, "pipelex.catalog.being_deleted", id="being-erased"),
            pytest.param(413, "request.too_large", id="a-list-that-would-not-fit"),
            pytest.param(422, "request.invalid", id="a-catalog-named-twice"),
        ],
    )
    def test_set_method_layouts_off_raises_each_refusal_as_its_problem(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, status: int, code: str
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=problem_document(code, status)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.set_method_layouts_off(_METHOD_ID, ["composer"]))

        assert exc_info.value.status == status
        assert exc_info.value.problem.code == code

    def test_layouts_off_reads_on_every_method_shape_and_defaults_to_none_off(self) -> None:
        base = dict(MethodLayoutBodies.SWITCHED_METHOD)
        without = {key: value for key, value in base.items() if key != "layouts_off"}

        assert MethodData.model_validate(base).layouts_off == ["composer"]
        assert MethodData.model_validate(without).layouts_off == []

    def test_layouts_off_reads_on_an_owners_and_a_public_read(self) -> None:
        owner = read_method({**MethodLayoutBodies.SWITCHED_METHOD, "files": []})
        public = read_method(
            {
                "method_id": _METHOD_ID,
                "org_id": "org_owner",
                "name": "Receipts",
                "created_at": "2026-11-01T09:00:00+00:00",
                "latest_version": 3,
                "latest_published": {
                    "version": 3,
                    "tree_digest": MethodLayoutBodies.DIGEST,
                    "crate_fingerprint": "a1b2c3",
                    "runner_version": "0.80.0",
                    "published_at": "2026-11-01T09:00:00+00:00",
                },
                "visibility": "public",
                "layouts_off": ["result"],
                "files": [],
            }
        )

        assert isinstance(owner, MethodDetail)
        assert owner.layouts_off == ["composer"]
        assert isinstance(public, PublicMethodDetail)
        assert public.layouts_off == ["result"]

    # ----- the layouts view ----------------------------------------------------------------------

    def test_validate_asks_for_the_layouts_beside_the_descriptor_and_reads_them_newest_first(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {**MethodLayoutBodies.VALID_VERDICT, "layouts": [MethodLayoutBodies.STORED, MethodLayoutBodies.OLDER]}
        send = patch_send(api_client, wire_response(200, json_body=body))

        report = asyncio.run(api_client.validate(method_id=f"{_METHOD_ID}@3", views=[VALIDATION_VIEW_INPUT_FORM, VALIDATION_VIEW_LAYOUTS]))

        assert _sent_body(send)["views"] == ["input_form", "layouts"]
        assert _sent_body(send)["method_id"] == f"{_METHOD_ID}@3"
        assert isinstance(report, PipelexValidationReport)
        assert report.input_form == {}
        assert report.layouts is not None
        assert [layout.model_dump() for layout in report.layouts] == [MethodLayoutBodies.STORED, MethodLayoutBodies.OLDER]
        assert report.layouts[0].provenance.style == "editorial"

    def test_a_layout_entry_that_does_not_read_is_left_out_and_the_others_kept_in_order(self) -> None:
        body = {
            **MethodLayoutBodies.VALID_VERDICT,
            "layouts": [MethodLayoutBodies.STORED, "a layout", {**MethodLayoutBodies.STORED, "jsonl": None}, MethodLayoutBodies.OLDER],
        }

        report = PipelexValidationReport.model_validate(body)

        assert report.layouts is not None
        assert [layout.prompt_hash for layout in report.layouts] == ["a1b2c3d4e5f6", "0f0e0d0c0b0a"]

    @pytest.mark.parametrize(
        "layouts",
        [
            pytest.param([], id="an-empty-list"),
            pytest.param([None, 3], id="a-list-holding-no-layout"),
            pytest.param({"0": MethodLayoutBodies.STORED}, id="a-value-that-is-not-a-list"),
            pytest.param(None, id="none"),
        ],
    )
    def test_a_layouts_value_holding_no_layout_reads_as_none(self, layouts: object) -> None:
        report = PipelexValidationReport.model_validate({**MethodLayoutBodies.VALID_VERDICT, "layouts": layouts})

        assert report.layouts is None
        assert report.is_runnable is True
        assert report.rendered_markdown == "# Valid"

    def test_a_verdict_without_the_view_carries_no_layouts(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=MethodLayoutBodies.VALID_VERDICT))

        report = asyncio.run(api_client.validate(method_id=_METHOD_ID))

        assert "views" not in _sent_body(send)
        assert isinstance(report, PipelexValidationReport)
        assert report.layouts is None
        assert "layouts" not in report.model_fields_set

    def test_an_invalid_verdict_carries_no_layouts(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        invalid = {
            "is_valid": False,
            "errors": [{"code": "method.signature_mismatch", "detail": "Pipe 'review' has no output."}],
            "pending_signatures": [],
            "is_runnable": False,
            "message": "Invalid",
        }
        patch_send(api_client, wire_response(200, json_body=invalid))

        verdict = asyncio.run(api_client.validate(method_id=_METHOD_ID, views=[VALIDATION_VIEW_LAYOUTS]))

        assert isinstance(verdict, PipelexInvalidReport)
        assert not hasattr(verdict, "layouts")

    def test_read_method_layouts_keeps_a_layout_already_built(self) -> None:
        built = MethodLayout.model_validate(MethodLayoutBodies.STORED)

        assert read_method_layouts([built, MethodLayoutBodies.OLDER]) == [built, MethodLayout.model_validate(MethodLayoutBodies.OLDER)]
