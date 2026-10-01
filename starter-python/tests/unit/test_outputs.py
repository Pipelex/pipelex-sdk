"""Offline gates for `widget/outputs.py` — the one shape a plural output is read through."""

from __future__ import annotations

import pytest

from widget.outputs import list_items


class TestListItems:
    def test_a_bare_array_is_its_own_element_sequence(self):
        assert list_items([{"word": "fox"}, {"word": "tree"}]) == [{"word": "fox"}, {"word": "tree"}]

    def test_an_items_envelope_is_unwrapped(self):
        """The shape the blocking path returns for the same method the durable path returns bare."""
        assert list_items({"items": [{"word": "fox"}]}) == [{"word": "fox"}]

    def test_an_empty_plural_output_reads_as_no_elements(self):
        assert list_items([]) == []
        assert list_items({"items": []}) == []

    @pytest.mark.parametrize("main_stuff", [{"word": "fox"}, "fox", 3, None, {"items": "fox"}])
    def test_anything_else_is_raised_rather_than_coerced(self, main_stuff: object):
        """Wrapping a single object in a list would turn a protocol surprise into a field error."""
        with pytest.raises(TypeError):
            list_items(main_stuff)
