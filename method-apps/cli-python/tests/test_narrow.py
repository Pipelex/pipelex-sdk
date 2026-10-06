"""`lib/narrow.py`: a run's result is checked strictly against the generated output model, and printed as it came."""

from datetime import date, datetime, time
from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict

from pipelex_method_cli_python.lib.narrow import MAX_LISTED_ERRORS, NarrowedOutput, OutputValidationError, is_absence, narrow_output
from pipelex_method_cli_python.lib.output import OutputShapeError
from tests.support import ABSENCE_OUTPUT, RUN_ID, Greeting, run_results


class Measured(BaseModel):
    """A model standing in for a generated one whose fields JSON spells only as strings or as numbers."""

    count: int
    ratio: float
    agreed: bool
    day: date
    moment: datetime
    clock: time


#: A payload `Measured` accepts, each value as the runtime's JSON carries it.
MEASURED: dict[str, Any] = {"count": 12, "ratio": 2, "agreed": True, "day": "2026-07-06", "moment": "2026-07-06T15:40:00Z", "clock": "15:40:00"}


class Attendance(BaseModel):
    """A model standing in for a generated one that declares an `absent` field of its own."""

    absent: bool
    employee: str


class Opaque(BaseModel):
    """A model standing in for an opaque concept's, which takes any key."""

    model_config = ConfigDict(extra="allow")


class TestNarrowOutput:
    def test_an_accepted_result_is_the_payload_untouched(self):
        payload = {"extra": 1, "text": "hi"}
        narrowed = narrow_output(run_results(payload), output_model=Greeting, output_is_list=False, output_optional=False)
        assert narrowed == NarrowedOutput(payload=payload)
        # Never reordered and never filtered: the model is a check.
        assert list(narrowed.payload) == ["extra", "text"]

    def test_a_plural_result_is_checked_item_by_item(self):
        items = [{"text": "a"}, {"text": "b"}]
        assert narrow_output(run_results({"items": items}), output_model=Greeting, output_is_list=True, output_optional=False).payload == items

    def test_a_refused_result_names_each_field_that_failed(self):
        with pytest.raises(OutputValidationError) as caught:
            narrow_output(
                run_results([{"text": "a"}, {"text": 3}, {}]),
                output_model=Greeting,
                output_is_list=True,
                output_optional=False,
                resume_hint="cli --resume run-1",
            )
        error = caught.value
        assert error.message == f"Run {RUN_ID} returned a result that a list of Greeting refuses, first at [1].text, so it is not printed."
        assert error.details == ("[1].text: Input should be a valid string", "[2].text: Field required")
        assert error.hint is not None and error.hint.endswith("then fetch the result again with `cli --resume run-1`.")

    def test_a_result_that_is_not_an_object_is_refused_as_the_result(self):
        with pytest.raises(OutputValidationError, match="first at the result"):
            narrow_output(run_results("plain text"), output_model=Greeting, output_is_list=False, output_optional=False)

    def test_a_long_list_of_refusals_is_cut_and_counted(self):
        items: list[dict[str, Any]] = [{} for _ in range(MAX_LISTED_ERRORS + 3)]
        with pytest.raises(OutputValidationError) as caught:
            narrow_output(run_results(items), output_model=Greeting, output_is_list=True, output_optional=False)
        assert len(caught.value.details) == MAX_LISTED_ERRORS + 1
        assert caught.value.details[-1] == "…and 3 more."

    def test_a_plural_binding_over_a_single_result_is_a_shape_error_first(self):
        with pytest.raises(OutputShapeError):
            narrow_output(run_results({"text": "one"}), output_model=Greeting, output_is_list=True, output_optional=False)


class TestStrictValidation:
    """The result is read as the JSON it arrived as, and never coerced into the type a field declares."""

    def test_what_json_spells_for_each_type_is_accepted(self):
        assert narrow_output(run_results(MEASURED), output_model=Measured, output_is_list=False, output_optional=False).payload == MEASURED

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            pytest.param("count", "12", id="a numeric string for an int"),
            pytest.param("agreed", "yes", id="a word for a bool"),
            pytest.param("day", 0, id="a number for a date"),
            pytest.param("count", 12.5, id="a fraction for an int"),
        ],
    )
    def test_a_value_a_lax_validation_would_coerce_is_refused(self, field: str, value: object):
        with pytest.raises(OutputValidationError, match=f"first at {field}"):
            narrow_output(run_results({**MEASURED, field: value}), output_model=Measured, output_is_list=False, output_optional=False)


class TestAbsentOutput:
    """An optional output a successful run left absent is printed as `null`; a required one is refused."""

    def test_the_absence_document_of_an_optional_output_is_null_with_its_reason(self):
        narrowed = narrow_output(run_results(ABSENCE_OUTPUT), output_model=Greeting, output_is_list=False, output_optional=True)
        assert narrowed == NarrowedOutput(payload=None, absent=True, absence_reason="The condition chose no branch.")

    def test_no_main_output_at_all_is_an_absence_too(self):
        narrowed = narrow_output(run_results(None), output_model=Greeting, output_is_list=False, output_optional=True)
        assert narrowed == NarrowedOutput(payload=None, absent=True)

    def test_an_optional_output_that_is_there_is_checked_as_any_other(self):
        narrowed = narrow_output(run_results({"text": "hi"}), output_model=Greeting, output_is_list=False, output_optional=True)
        assert narrowed == NarrowedOutput(payload={"text": "hi"})

    def test_the_absence_document_of_an_output_that_is_not_optional_is_refused(self):
        with pytest.raises(OutputValidationError, match="Greeting refuses"):
            narrow_output(run_results(ABSENCE_OUTPUT), output_model=Greeting, output_is_list=False, output_optional=False)

    def test_a_payload_whose_own_absent_field_is_true_is_data(self):
        payload = {"absent": True, "employee": "Alice"}
        narrowed = narrow_output(run_results(payload), output_model=Attendance, output_is_list=False, output_optional=True)
        assert narrowed == NarrowedOutput(payload=payload)

    def test_the_absence_document_is_an_absence_even_where_the_model_would_take_it(self):
        # An opaque model allows any key, so validating first would print the document as data.
        narrowed = narrow_output(run_results(ABSENCE_OUTPUT), output_model=Opaque, output_is_list=False, output_optional=True)
        assert narrowed == NarrowedOutput(payload=None, absent=True, absence_reason="The condition chose no branch.")

    def test_the_absence_document_with_one_more_key_is_data(self):
        payload = {**ABSENCE_OUTPUT, "employee": "Alice"}
        narrowed = narrow_output(run_results(payload), output_model=Opaque, output_is_list=False, output_optional=True)
        assert narrowed == NarrowedOutput(payload=payload)

    def test_an_absence_chained_to_an_upstream_one_is_an_absence(self):
        upstream = {key: value for key, value in ABSENCE_OUTPUT.items() if key != "absent"}
        assert is_absence({**ABSENCE_OUTPUT, "kind": "declared_absent", "producing_pipe": "greetings.pick", "upstream": upstream})

    @pytest.mark.parametrize(
        ("key", "value"),
        [
            pytest.param("absent", "true", id="absent as a string"),
            pytest.param("variable_name", None, id="no variable name"),
            pytest.param("kind", "forgotten", id="a kind the runtime never writes"),
            pytest.param("kind", ["skipped"], id="a kind that is not a string"),
            pytest.param("reason", None, id="no reason"),
            pytest.param("producing_pipe", 3, id="a producing pipe that is not a string"),
            pytest.param("upstream", "greeting", id="an upstream that is not a record"),
        ],
    )
    def test_the_absence_document_with_a_value_of_another_type_is_not_one(self, key: str, value: object):
        assert not is_absence({**ABSENCE_OUTPUT, key: value})

    def test_the_absence_document_missing_a_key_is_not_one(self):
        assert not is_absence({key: value for key, value in ABSENCE_OUTPUT.items() if key != "upstream"})
