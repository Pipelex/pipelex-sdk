"""`lib/narrow.py`: a run's result is checked strictly against the generated output model, and printed as it came."""

from datetime import date, datetime, time
from typing import Any

import pytest
from pydantic import BaseModel

from pipelex_method_cli_python.lib.narrow import MAX_LISTED_ERRORS, NarrowedOutput, OutputValidationError, narrow_output
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
