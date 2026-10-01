"""Tests for `widget/usage.py` — the terminal rendering of the SDK's usage summary.

The folding rules themselves (what counts as unrated, which token categories are additive, the
three-way state) belong to `pipelex_sdk.usage.summarize_usage` and are tested there. What is pinned
here is the projection: that each state gets its own rendering, that the per-call rows show what a
reader needs, and that the total says when it covers only part of what ran.
"""

import io
from typing import Any

from pipelex_sdk.runs import RunResults, TokensUsageRecord
from rich.console import Console

from widget.usage import print_cost_report


def _render(results: RunResults) -> str:
    buffer = io.StringIO()
    # A wide, non-terminal console → plain text, no wrapping, no ANSI styling to assert around.
    print_cost_report(Console(file=buffer, width=200), results)
    return buffer.getvalue()


def _record(**fields: Any) -> TokensUsageRecord:
    return TokensUsageRecord.model_validate(fields)


def _results(**usage: Any) -> RunResults:
    """A completed run carrying the usage pair — validated from the wire, as a real one is."""
    return RunResults.model_validate({"pipeline_run_id": "run-1", "main_stuff": {"x": 1}, **usage})


class TestUsage:
    def test_reports_records_with_a_total(self):
        results = _results(
            tokens_usages=[
                _record(pipe_code="extract", inference_model_name="gpt-4o", cost=0.01, nb_tokens_by_category={"input": 100, "output": 50}),
                _record(pipe_code="summarize", inference_model_name="claude", cost=0.02, nb_tokens_by_category={"input": 200, "output": 80}),
            ],
            usage_assembly_error=None,
        )
        output = _render(results)
        assert "gpt-4o" in output
        assert "claude" in output
        assert "100→50" in output  # the joined `input` total → `output`, never a sum of categories
        assert "$0.0300" in output  # 0.01 + 0.02

    def test_marks_a_partial_total_when_priced_and_unrated_calls_are_mixed(self):
        results = _results(
            tokens_usages=[
                _record(pipe_code="gen", model_type="img_gen", cost=None, nb_tokens_by_category=None),
                _record(pipe_code="extract", inference_model_name="gpt-4o", cost=0.05, nb_tokens_by_category={"input": 10, "output": 5}),
            ],
            usage_assembly_error=None,
        )
        output = _render(results)
        assert "$0.0500" in output  # the total covers the priced call alone
        assert "lower bound" in output
        assert "unrated" in output

    def test_a_run_whose_every_call_is_unrated_says_so_instead_of_a_zero_total(self):
        # A `None` total with records is not a run that cost nothing — it is a run nothing was
        # priced in, which reading it as `$0.0000` would hide.
        results = _results(tokens_usages=[_record(pipe_code="gen", model_type="img_gen", cost=None)], usage_assembly_error=None)
        output = _render(results)
        assert "unpriced" in output
        assert "$" not in output.split("Total:")[1]

    def test_assembly_error_is_reported(self):
        output = _render(_results(tokens_usages=None, usage_assembly_error="event read failed"))
        assert "event read failed" in output
        assert "failed" in output.lower()

    def test_none_usage_says_nothing_reported(self):
        # None (off / pre-artifact) is distinct from the assembly-error case above.
        output = _render(_results(tokens_usages=None, usage_assembly_error=None))
        assert "No usage was reported" in output

    def test_empty_usage_says_no_inference(self):
        # [] (ran, but no inference happened) is distinct from None.
        output = _render(_results(tokens_usages=[], usage_assembly_error=None))
        assert "No inference calls" in output
