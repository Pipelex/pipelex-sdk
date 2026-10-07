"""`lib/output.py`: the JSON stdout carries, and the two wire shapes of a plural output."""

from typing import Any

import pytest

from pipelex_method_cli_python.lib.output import ITEMS_KEY, OutputShapeError, list_items, render_json, result_payload
from tests.support import run_results


class TestListItems:
    def test_a_bare_list_is_its_own_elements(self):
        assert list_items([{"a": 1}, {"a": 2}]) == [{"a": 1}, {"a": 2}]

    def test_the_items_envelope_yields_its_items(self):
        assert list_items({ITEMS_KEY: [{"a": 1}]}) == [{"a": 1}]

    def test_the_elements_are_a_fresh_list(self):
        # A caller that appends to the answer must not edit the run's results behind their back.
        elements: list[Any] = [1, 2]
        answered = list_items(elements)
        answered.append(3)
        assert elements == [1, 2]

    @pytest.mark.parametrize("main_stuff", [{"text": "hi"}, {ITEMS_KEY: "not a list"}, "text", None, 3])
    def test_any_other_shape_is_refused_naming_what_arrived(self, main_stuff: object):
        with pytest.raises(TypeError, match=type(main_stuff).__name__):
            list_items(main_stuff)


class TestResultPayload:
    def test_a_single_output_is_the_main_stuff_as_it_came(self):
        # An object with an `items` field of its own is not a plural output: the binding says which.
        main_stuff = {ITEMS_KEY: [1, 2], "total": 2}
        assert result_payload(run_results(main_stuff), output_is_list=False) == main_stuff

    def test_a_plural_output_is_the_list_of_its_elements(self):
        assert result_payload(run_results({ITEMS_KEY: [1, 2]}), output_is_list=True) == [1, 2]

    def test_a_plural_output_in_neither_shape_is_an_error_naming_the_run(self):
        with pytest.raises(OutputShapeError, match="run-1"):
            result_payload(run_results({"text": "hi"}), output_is_list=True)


class TestRenderJson:
    def test_indents_and_keeps_non_ascii_text_as_it_is(self):
        assert render_json({"text": "Bonjour, ça va ?"}) == '{\n  "text": "Bonjour, ça va ?"\n}'
