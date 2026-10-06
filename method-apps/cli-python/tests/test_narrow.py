"""`lib/narrow.py`: a run's result is checked against the generated output model, and printed as it came."""

from typing import Any

import pytest

from pipelex_method_cli_python.lib.narrow import MAX_LISTED_ERRORS, OutputValidationError, narrow_output
from pipelex_method_cli_python.lib.output import OutputShapeError
from tests.support import RUN_ID, Greeting, run_results


class TestNarrowOutput:
    def test_an_accepted_result_is_the_payload_untouched(self):
        payload = {"extra": 1, "text": "hi"}
        narrowed = narrow_output(run_results(payload), output_model=Greeting, output_is_list=False)
        assert narrowed == payload
        # Never reordered and never filtered: the model is a check.
        assert list(narrowed) == ["extra", "text"]

    def test_a_plural_result_is_checked_item_by_item(self):
        items = [{"text": "a"}, {"text": "b"}]
        assert narrow_output(run_results({"items": items}), output_model=Greeting, output_is_list=True) == items

    def test_a_refused_result_names_each_field_that_failed(self):
        with pytest.raises(OutputValidationError) as caught:
            narrow_output(run_results([{"text": "a"}, {"text": 3}, {}]), output_model=Greeting, output_is_list=True, resume_hint="cli --resume run-1")
        error = caught.value
        assert error.message == f"Run {RUN_ID} returned a result that a list of Greeting refuses, first at [1].text, so it is not printed."
        assert error.details == ("[1].text: Input should be a valid string", "[2].text: Field required")
        assert error.hint is not None and error.hint.endswith("then fetch the result again with `cli --resume run-1`.")

    def test_a_result_that_is_not_an_object_is_refused_as_the_result(self):
        with pytest.raises(OutputValidationError, match="first at the result"):
            narrow_output(run_results("plain text"), output_model=Greeting, output_is_list=False)

    def test_a_long_list_of_refusals_is_cut_and_counted(self):
        items: list[dict[str, Any]] = [{} for _ in range(MAX_LISTED_ERRORS + 3)]
        with pytest.raises(OutputValidationError) as caught:
            narrow_output(run_results(items), output_model=Greeting, output_is_list=True)
        assert len(caught.value.details) == MAX_LISTED_ERRORS + 1
        assert caught.value.details[-1] == "…and 3 more."

    def test_a_plural_binding_over_a_single_result_is_a_shape_error_first(self):
        with pytest.raises(OutputShapeError):
            narrow_output(run_results({"text": "one"}), output_model=Greeting, output_is_list=True)
