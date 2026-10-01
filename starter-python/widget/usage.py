"""Print what a run consumed — shared by every execution mode.

Cost reporting is orthogonal to *how* a run is executed, so — like input encoding
(`widget/inputs.py`) and error presentation (`widget/errors.py`) — it lives here rather than in one
of the mode packages.

**The reading belongs to the SDK; this module only renders it.** `pipelex_sdk.usage.summarize_usage`
folds a run's `tokens_usages` / `usage_assembly_error` pair into one `UsageSummary` under every rule
the SDK's `docs/run-usage.md` states: a call the runtime could not price (`cost` of `None`) is kept
apart from one priced at zero, only `input` and `output` are summed because the other token
categories are subsets of them, and an empty record list is a run that did no inference rather than
a run nothing is known about. Re-deriving any of that here would be a second implementation to keep
in step with the first, so the three-way `state` and the totals are read off the summary and nothing
is folded by hand.

Every mode holds a `RunResults`: the durable ones because that is what the lifecycle returns, and
the blocking one because `pipelex_sdk.execute_result.results_from_execute` lifts the blocking
response onto it. So one function serves all three.

`print_cost_report` renders a per-call table plus the run's total, always to *stderr*, so stdout
stays the clean, pipeable result. The per-call rows are the one thing the summary does not carry —
it rolls up per pipe — so they are read straight off `results.tokens_usages`.
"""

from pipelex_sdk.runs import RunResults, TokensUsageRecord
from pipelex_sdk.usage import UsageSummary, UsageSummaryState, summarize_usage
from rich.console import Console
from rich.table import Table


def print_cost_report(console: Console, results: RunResults) -> None:
    """Print a run's cost report to `console` (always stderr, so stdout stays the pipeable result).

    The three states the SDK's summary distinguishes each get their own rendering: a run that
    reported calls gets the table, a run that made no inference call says so, and a run nothing is
    known about says that instead — with the assembly error when there is one, which is the only
    thing that tells a broken usage assembly apart from usage that was simply off.
    """
    summary = summarize_usage(results)
    match summary.state:
        case UsageSummaryState.RECORDS:
            _print_call_table(console, results.tokens_usages or [])
            console.print(_total_line(summary))
        case UsageSummaryState.NO_INFERENCE:
            console.print("[dim]No inference calls — nothing to cost.[/dim]")
        case UsageSummaryState.UNAVAILABLE:
            if summary.assembly_error is None:
                console.print("[dim]No usage was reported for this run.[/dim]")
            else:
                console.print(f"[dim]Cost report unavailable — usage assembly failed: {summary.assembly_error}[/dim]")


def _print_call_table(console: Console, records: list[TokensUsageRecord]) -> None:
    """One row per inference call: the pipe that made it, the model, its tokens and its cost."""
    table = Table(title="Cost report", title_justify="left", title_style="bold", show_edge=False, pad_edge=False)
    table.add_column("pipe", style="cyan")
    table.add_column("model")
    table.add_column("tokens (in→out)", justify="right")
    table.add_column("cost (USD)", justify="right")

    for record in records:
        tokens = record.nb_tokens_by_category or {}
        # `input` is the joined total and `output` the generated tokens — never sum the categories.
        tokens_str = f"{tokens.get('input', 0)}→{tokens.get('output', 0)}"
        cost_str = "—" if record.cost is None else f"${record.cost:.4f}"
        model = record.inference_model_name or record.model_type or "—"
        table.add_row(record.pipe_code or "—", model, tokens_str, cost_str)

    console.print(table)


def _total_line(summary: UsageSummary) -> str:
    """The run's total, saying when it covers only part of what ran.

    A `None` total with records is a run whose every call was unrated — mock, own GPU, dry run —
    which is not the same as a run that cost nothing; `cost_partial` is the mixed case, where the
    total is a lower bound over the priced calls alone.
    """
    if summary.total_cost_usd is None:
        return f"[bold]Total: unpriced[/bold] [dim]({summary.calls} calls, none rated: mock / own-GPU / dry-run)[/dim]"
    total = f"[bold]Total: ${summary.total_cost_usd:.4f}[/bold]"
    if summary.cost_partial:
        total += " [dim](a lower bound — some calls are unrated: mock / own-GPU / dry-run)[/dim]"
    return total
