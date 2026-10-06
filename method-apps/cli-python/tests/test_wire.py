"""`lib/wire.py`: the form kernel's payload rules, function by function.

`test_wire_table.py` holds the whole pipeline to a recording of the TypeScript kernel; these pin the
rules one at a time, so a regression names the rule it broke.
"""

from typing import Any

import pytest
from mthds.protocol.pipe_io_contracts import PipeInputContract

from pipelex_method_cli_python.lib.wire import (
    as_calendar_date,
    collect_defs,
    content_key,
    envelope,
    file_content,
    heal_string_wrappers,
    is_acceptable_date_time,
    is_filled,
    is_plural_input,
    prepare,
    prune_empty_optionals,
    resolve_schema_indirection,
    resolve_schema_node,
    runs_schema,
    schema_type,
    wrap_content,
)
from tests.support import TEXT_SCHEMA


def _contract(schema: dict[str, Any], *, presence: str = "plain", plural: bool = False) -> PipeInputContract:
    return PipeInputContract.model_validate(
        {
            "concept_ref": "native.Text",
            "presence": presence,
            "multiplicity": "variable" if plural else "single",
            "item_count": None,
            "json_schema": {"type": "array", "items": schema} if plural else schema,
        }
    )


class TestSchemaResolution:
    def test_definitions_are_collected_from_any_depth(self):
        schema = {"$defs": {"A": {"type": "string"}}, "properties": {"x": {"$defs": {"B": {"type": "number"}}}}}
        assert collect_defs(schema, traverse_arrays=False) == {"A": {"type": "string"}, "B": {"type": "number"}}

    def test_arrays_are_entered_only_when_asked(self):
        schema = {"anyOf": [{"$defs": {"C": {"type": "string"}}}]}
        assert collect_defs(schema, traverse_arrays=False) == {}
        assert collect_defs(schema, traverse_arrays=True) == {"C": {"type": "string"}}

    def test_a_node_resolves_through_a_reference_and_a_nullable_union_keeping_its_own_keys(self):
        defs = {"Text": {"type": "object", "title": "Text"}}
        node = {"anyOf": [{"$ref": "#/$defs/Text"}, {"type": "null"}], "description": "kept"}
        assert resolve_schema_node(node, defs) == {"type": "object", "title": "Text", "description": "kept"}

    def test_indirection_resolves_by_replacement(self):
        defs = {"Text": {"type": "object"}}
        node = {"anyOf": [{"$ref": "#/$defs/Text"}, {"type": "null"}], "description": "dropped"}
        assert resolve_schema_indirection(node, defs) == {"type": "object"}

    def test_a_reference_cycle_stops_after_a_bounded_number_of_hops(self):
        defs = {"A": {"$ref": "#/$defs/A"}}
        assert resolve_schema_node({"$ref": "#/$defs/A"}, defs) == {"$ref": "#/$defs/A"}

    @pytest.mark.parametrize(
        ("schema", "expected"),
        [
            ({"type": "string"}, "string"),
            ({"type": ["null", "integer"]}, "integer"),
            ({"anyOf": [{"type": "string"}, {"type": "null"}]}, "string"),
            ({"anyOf": [{"type": "string", "format": "date"}, {"type": "null"}]}, None),
            ({}, None),
        ],
    )
    def test_the_type_is_read_as_the_kernel_reads_it(self, schema: dict[str, Any], expected: str | None):
        assert schema_type(schema) == expected


class TestContent:
    def test_a_one_property_content_model_is_a_wrapper(self):
        assert content_key(TEXT_SCHEMA) == "text"

    @pytest.mark.parametrize(
        "schema",
        [None, {"type": "string"}, {"type": "object", "properties": {"date": {}, "time": {}}}],
    )
    def test_anything_else_travels_bare(self, schema: dict[str, Any] | None):
        assert content_key(schema) is None

    def test_a_value_is_wrapped_under_its_key_or_left_bare(self):
        assert wrap_content("text", "hi") == {"text": "hi"}
        assert wrap_content(None, "hi") == "hi"

    def test_a_file_carries_its_name_only_when_it_has_one(self):
        assert file_content("https://x/a.pdf") == {"url": "https://x/a.pdf"}
        assert file_content("a.pdf", "a.pdf") == {"url": "a.pdf", "filename": "a.pdf"}


class TestIsFilled:
    @pytest.mark.parametrize("value", [None, "", "   ", [], {}, {"text": " "}, [{}], {"url": ""}, {"url": "", "filename": "a.png"}])
    def test_nothing_held(self, value: object):
        assert not is_filled(value)

    @pytest.mark.parametrize("value", [False, 0, "x", {"text": "x"}, [None, "x"], {"url": "a.png"}])
    def test_something_held(self, value: object):
        assert is_filled(value)

    def test_a_structure_deeper_than_the_cap_is_not_filled(self):
        nested: object = "x"
        for _ in range(100):
            nested = [nested]
        assert not is_filled(nested)


class TestDates:
    @pytest.mark.parametrize(
        ("value", "day"),
        [
            ("2026-07-06", "2026-07-06"),
            ("2026-07-06T00:00:00Z", "2026-07-06"),
            ("2026-07-06T00:00+02:00", "2026-07-06"),
            ("2026-07-06T15:40:00Z", None),
            ("2026-02-30", None),
            ("July 6", None),
        ],
    )
    def test_a_calendar_date_is_a_day_or_a_midnight_timestamp(self, value: str, day: str | None):
        assert as_calendar_date(value) == day

    @pytest.mark.parametrize(
        ("value", "acceptable"),
        [("2026-07-06T15:40:00Z", True), ("2026-07-06 15:40", True), ("2026-07-06", True), ("2026-07-06T24:00:00Z", False), ("15:40", False)],
    )
    def test_a_date_time_is_a_real_point_in_time(self, value: str, acceptable: bool):
        assert is_acceptable_date_time(value) is acceptable


class TestRepair:
    def test_a_lone_text_wrapper_where_a_string_is_wanted_is_unwrapped(self):
        schema = {"type": "object", "properties": {"label": {"type": "string"}}}
        assert heal_string_wrappers({"label": {"text": "A"}}, schema, {}) == {"label": "A"}

    def test_a_midnight_timestamp_where_a_date_is_wanted_is_cut_to_its_day(self):
        schema = {"type": "object", "properties": {"day": {"type": "string", "format": "date"}}}
        assert heal_string_wrappers({"day": "2026-07-06T00:00:00Z"}, schema, {}) == {"day": "2026-07-06"}

    def test_an_optional_property_left_empty_is_dropped_and_a_required_one_kept(self):
        schema = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}, "c": {"type": "array"}}, "required": ["a"]}
        assert prune_empty_optionals({"a": "", "b": "", "c": []}, schema, {}) == {"a": "", "c": []}

    def test_an_object_emptied_by_pruning_is_dropped_too(self):
        inner = {"type": "object", "properties": {"x": {"type": "string"}}}
        schema = {"type": "object", "properties": {"inner": inner}}
        assert prune_empty_optionals({"inner": {"x": ""}}, schema, {}) == {}

    def test_a_runs_inputs_are_repaired_against_one_schema_whose_required_are_the_gating_ones(self):
        contracts = {"name": _contract(TEXT_SCHEMA), "mood": _contract(TEXT_SCHEMA, presence="optional")}
        schema = runs_schema(contracts, frozenset({"name"}))
        assert schema["required"] == ["name"]
        assert prepare({"name": {"text": "Marie"}, "mood": ""}, schema) == {"name": {"text": "Marie"}}
        # A content model's own required property is kept, however empty: the envelope decides presence.
        assert prepare({"name": {"text": ""}, "mood": {"text": ""}}, schema) == {"name": {"text": ""}, "mood": {"text": ""}}


class TestEnvelope:
    def test_a_filled_input_travels_in_its_envelope(self):
        assert envelope(_contract(TEXT_SCHEMA), {"text": "hi"}) == (True, {"concept": "native.Text", "content": {"text": "hi"}})

    def test_an_optional_input_holding_nothing_is_not_sent(self):
        assert envelope(_contract(TEXT_SCHEMA, presence="optional"), {"text": ""}) == (False, None)

    def test_a_plural_input_holding_nothing_is_a_bare_empty_list(self):
        assert envelope(_contract(TEXT_SCHEMA, plural=True), []) == (True, [])

    def test_a_plural_input_is_read_off_its_schema(self):
        assert is_plural_input(_contract(TEXT_SCHEMA, plural=True))
        assert not is_plural_input(_contract(TEXT_SCHEMA))
