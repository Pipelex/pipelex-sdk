"""Print what a run consumed, on stderr, so stdout stays the result alone.

**The reading belongs to the SDK; this module only renders it.** `pipelex_sdk.usage.summarize_usage`
folds a run's `tokens_usages` and `usage_assembly_error` pair into one `UsageSummary` under every
rule the SDK's `docs/run-usage.md` states: a call the runtime could not price (`cost` of `None`) is
kept apart from one priced at zero, only `input` and `output` are summed because the other token
categories are subsets of them, and an empty record list is a run that did no inference rather than
a run nothing is known about. Re-deriving any of that here would be a second implementation to keep
in step with the first, so the summary's `state` and its totals are read off the summary and nothing
is folded by hand.

Every mode holds a `RunResults`: the durable ones because that is what the lifecycle returns, and
the blocking one because `pipelex_sdk.execute_result.results_from_execute` lifts the blocking
response onto it. So one function serves all of them.

`print_cost_report` renders a per-call table and the run's total. The per-call rows are the one
thing the summary does not carry, since it rolls up per pipe, so they are read straight off
`results.tokens_usages`.

The report never fails a run that succeeded. The SDK refuses to summarize results whose body did not
carry `tokens_usages` at all, since that is a gap in the read rather than a fact about the run; the
CLI reads every artifact, so that only happens when the platform left the key out, and the report
then says so in place of the table. Every string the server wrote, the assembly error and each
call's pipe and model, goes through `rich.markup.escape` before Rich reads it: a pydantic error
quoted in an assembly error carries `[type=missing, …]`, which Rich would otherwise swallow, and an
unmatched closing tag such as `[/usage]` would raise after the result was already printed.
"""

from pipelex_sdk.errors import FieldNotIncludedError
from pipelex_sdk.runs import RunResults, TokensUsageRecord
from pipelex_sdk.usage import UsageSummary, UsageSummaryState, summarize_usage
from rich.console import Console
from rich.markup import escape
from rich.table import Table


def print_cost_report(console: Console, results: RunResults) -> None:
    """Print a run's cost report to `console`, which is stderr, so stdout stays the pipeable result.

    Each state the SDK's summary distinguishes gets its own rendering: a run that reported calls
    gets the table, a run that made no inference call says so, and a run nothing is known about
    says that instead, with the assembly error when there is one, which is the only thing that
    tells a broken usage assembly apart from usage that was simply off.
    """
    try:
        summary = summarize_usage(results)
    except FieldNotIncludedError:
        console.print("[dim]No cost report: the run's results did not carry its usage records.[/dim]")
        return
    match summary.state:
        case UsageSummaryState.RECORDS:
            _print_call_table(console, results.tokens_usages or [])
            console.print(_total_line(summary))
        case UsageSummaryState.NO_INFERENCE:
            console.print("[dim]No inference calls, so nothing to cost.[/dim]")
        case UsageSummaryState.UNAVAILABLE:
            if summary.assembly_error is None:
                console.print("[dim]No usage was reported for this run.[/dim]")
            else:
                console.print(f"[dim]Cost report unavailable: usage assembly failed: {escape(summary.assembly_error)}[/dim]")


def _print_call_table(console: Console, records: list[TokensUsageRecord]) -> None:
    """One row per inference call: the pipe that made it, the model, its tokens and its cost."""
    table = Table(title="Cost report", title_justify="left", title_style="bold", show_edge=False, pad_edge=False)
    table.add_column("pipe", style="cyan")
    table.add_column("model")
    table.add_column("tokens (in→out)", justify="right")
    table.add_column("cost (USD)", justify="right")

    for record in records:
        tokens = record.nb_tokens_by_category or {}
        # `input` is the joined total and `output` the generated tokens: never sum the categories.
        tokens_str = f"{tokens.get('input', 0)}→{tokens.get('output', 0)}"
        cost_str = "—" if record.cost is None else f"${record.cost:.4f}"
        model = record.inference_model_name or record.model_type or "—"
        # Rich reads a cell's string as markup too, and these two are the server's.
        table.add_row(escape(record.pipe_code or "—"), escape(model), tokens_str, cost_str)

    console.print(table)


def _total_line(summary: UsageSummary) -> str:
    """The run's total, saying when it covers only part of what ran.

    A `None` total with records is a run whose every call was unrated (a mock, an own GPU, a dry
    run), which is not the same as a run that cost nothing; `cost_partial` is the mixed case, where
    the total is a lower bound over the priced calls alone.
    """
    if summary.total_cost_usd is None:
        return f"[bold]Total: unpriced[/bold] [dim]({summary.calls} calls, none rated: mock, own GPU or dry run)[/dim]"
    total = f"[bold]Total: ${summary.total_cost_usd:.4f}[/bold]"
    if summary.cost_partial:
        total += " [dim](a lower bound: some calls are unrated, from a mock, an own GPU or a dry run)[/dim]"
    return total
