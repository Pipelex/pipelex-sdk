import {
  summarizeUsage,
  type RunResults,
  type TokensUsageRecord,
  type UsageSummaryState,
} from "@pipelex/sdk";

/**
 * One inference call's usage, projected from a `TokensUsageRecord` for display.
 * A flat, render-ready view of the fields the template shows — the raw wire
 * record carries more (timing, job ids, legacy fields) that we deliberately drop.
 */
export interface UsageCall {
  /** Human model name (e.g. `gpt-4o`), or null when the record omits it. */
  modelName: string | null;
  /** Kind of inference: `llm` / `img_gen` / `extract` / `search`, or null. */
  modelType: string | null;
  /** The pipe that made the call — what makes per-pipe attribution possible. */
  pipeCode: string | null;
  /**
   * Raw provider-reported token counts keyed by category (`input`, `input_cached`,
   * `output`, …). Carried through verbatim and **never summed**: the categories are
   * NOT additive (`input` already includes `input_cached`), so a total would double-count.
   */
  tokensByCategory: Record<string, number> | null;
  /**
   * Computed USD cost of this call. `null` when the model has no rate table at all
   * (own-GPU, mock, dry run); `0` means a rate table priced it at zero — a real,
   * displayable "$0.00", distinct from "not priced".
   */
  costUsd: number | null;
}

/**
 * A run's usage, ready to render: the SDK's run-level summary, plus one row per
 * inference call for the table.
 *
 * The totals and the three-way reading of `tokens_usages` are the SDK's
 * `summarizeUsage`, not re-derived here — `docs/run-usage.md` in the SDK states
 * the rules, and every consumer reads the same figures. `state` is its verdict,
 * read first:
 * - `"records"`      — a non-empty list of inference calls to tabulate.
 * - `"no_inference"` — `[]`: assembly ran but no inference happened, which costs
 *                      `0`, not `null`.
 * - `"unavailable"`  — `null`: assembly was off, broke, or the run predated the
 *                      artifact. `assemblyError` (non-null) is the ONLY signal that
 *                      it *broke*, as opposed to being off — all three leave
 *                      `tokens_usages` null.
 */
export interface UsageReport {
  state: UsageSummaryState;
  /** One row per inference call, in the order the calls completed. Empty outside `records`. */
  calls: UsageCall[];
  /**
   * Sum of the priced calls' costs in USD. `0` for a run that did no inference.
   * `null` under `records` when no call was priced — the UI then says "not priced"
   * rather than a misleading "$0.00" — and under `unavailable`, where nothing is known.
   */
  totalCostUsd: number | null;
  /**
   * True when priced and unrated calls are mixed, so `totalCostUsd` covers the
   * priced calls only and is a lower bound. A sum that is partial must not be
   * labelled a total. Never true outside `records`.
   */
  costPartial: boolean;
  /** The runner's usage-assembly error, set only when `tokens_usages` is null because it broke. */
  assemblyError: string | null;
}

/**
 * Project a run's usage pair (`tokens_usages` / `usage_assembly_error`) into a
 * render-ready `UsageReport`. Pure — no React, no `process.env` — so it is safe to
 * call from either the server helpers or a component.
 *
 * Usage is a **sibling** of `main_stuff` on `RunResults`, not part of it, so it is
 * built here (where the whole `RunResults` is in hand) rather than in the `parseXxx`
 * narrowers, which stay focused on the single main output.
 */
export function buildUsageReport(results: RunResults): UsageReport {
  const summary = summarizeUsage(results);
  return {
    state: summary.state,
    calls: summary.state === "records" ? (results.tokens_usages ?? []).map(toUsageCall) : [],
    totalCostUsd: summary.total_cost_usd,
    costPartial: summary.cost_partial,
    assemblyError: summary.assembly_error,
  };
}

function toUsageCall(record: TokensUsageRecord): UsageCall {
  return {
    modelName: record.inference_model_name ?? null,
    modelType: record.model_type ?? null,
    pipeCode: record.pipe_code ?? null,
    tokensByCategory: record.nb_tokens_by_category ?? null,
    // `typeof`, as the SDK's fold reads it: a legitimate `0` survives, and a
    // malformed record's non-numeric cost counts as unrated rather than as a figure.
    costUsd: typeof record.cost === "number" ? record.cost : null,
  };
}
