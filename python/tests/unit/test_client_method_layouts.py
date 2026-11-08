"""Tests for a method's stored layouts — `store_method_layout`, its closed body, its refusals and its answer, and the
`layouts` a validate by `method_id` carries when `views` names `layouts`.

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
from pipelex_sdk.method_layout_models import LayoutProvenanceInput, MethodLayout, MethodLayoutInput, read_method_layouts
from pipelex_sdk.validation_models import (
    VALIDATION_VIEW_INPUT_FORM,
    VALIDATION_VIEW_LAYOUTS,
    PipelexInvalidReport,
    PipelexValidationReport,
)
from tests.unit.conftest import BASE_URL, problem_document, refused_argument
from tests.unit.test_data import MethodLayoutBodies

if TYPE_CHECKING:
    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import ResponseBuilder, SendPatcher

_METHOD_ID = "mt_receipts01"
_LAYOUTS_PATH = f"/v1/methods/{_METHOD_ID}/versions/3/layouts"
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
