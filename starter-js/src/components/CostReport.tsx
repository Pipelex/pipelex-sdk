import type { UsageReport } from "@/lib/usageReport";

interface CostReportProps {
  usage: UsageReport;
}

/** `$0.00` for a priced call (including a real zero), trimming trailing noise for tiny costs. */
function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/** A priced cost renders as USD; an unpriced (`null`) one renders as an em dash. */
function formatCost(costUsd: number | null): string {
  return costUsd === null ? "—" : formatUsd(costUsd);
}

/**
 * Render the raw token categories verbatim (`input 1,200 · output 340`). Never
 * summed — `input` already includes `input_cached`, so a total would double-count.
 */
function formatTokens(tokensByCategory: Record<string, number> | null): string {
  const entries = Object.entries(tokensByCategory ?? {});
  if (entries.length === 0) return "—";
  return entries.map(([cat, n]) => `${cat} ${n.toLocaleString("en-US")}`).join(" · ");
}

/**
 * Show a run's token usage and computed cost — the `RunResults.tokens_usages`
 * sibling, projected by `buildUsageReport`. Pure server component; renders one of
 * three shapes keyed off `usage.state`:
 *
 * - `records`      → a compact per-call table + a total-cost row.
 * - `no-inference` → a subtle "nothing was billed" note.
 * - `unavailable`  → nothing at all, UNLESS assembly *broke* (`assemblyError` set),
 *                    in which case a muted "usage unavailable" note carries the
 *                    technical detail — demonstrating the broke-vs-off distinction.
 */
export function CostReport({ usage }: CostReportProps) {
  if (usage.state === "unavailable") {
    // Assembly was off or the run predated the artifact — stay quiet. Only when it
    // *broke* (an assembly error) do we surface a muted note with the detail.
    if (!usage.assemblyError) return null;
    return (
      <section
        aria-label="Cost report"
        className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600"
      >
        <p className="font-medium text-slate-700">Usage reporting is unavailable for this run.</p>
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer select-none font-medium">Technical details</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono">
            {usage.assemblyError}
          </pre>
        </details>
      </section>
    );
  }

  if (usage.state === "no-inference") {
    return (
      <section
        aria-label="Cost report"
        className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600"
      >
        <p>No billable inference in this run.</p>
      </section>
    );
  }

  return (
    <section
      aria-label="Cost report"
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
    >
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Token usage &amp; cost
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="py-1 pr-3 font-medium">Model</th>
              <th className="py-1 pr-3 font-medium">Pipe</th>
              <th className="py-1 pr-3 font-medium">Tokens</th>
              <th className="py-1 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {usage.calls.map((call, index) => (
              <tr
                key={`${call.pipeCode ?? "?"}-${call.modelName ?? "?"}-${index}`}
                className="border-b border-slate-100"
              >
                <td className="py-1 pr-3 font-mono">{call.modelName ?? "—"}</td>
                <td className="py-1 pr-3">{call.pipeCode ?? "—"}</td>
                <td className="py-1 pr-3 text-slate-500">{formatTokens(call.tokensByCategory)}</td>
                <td className="py-1 text-right tabular-nums">{formatCost(call.costUsd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-medium text-slate-800">
              <td className="py-1 pr-3" colSpan={3}>
                Total
              </td>
              <td className="py-1 text-right tabular-nums">
                {usage.totalCostUsd === null ? "Not priced" : formatUsd(usage.totalCostUsd)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {usage.totalCostUsd === null && (
        <p className="text-xs text-slate-500">
          No model in this run had a rate table (e.g. own-GPU, mock, or dry run), so cost is not
          priced.
        </p>
      )}
    </section>
  );
}
