import type { RunResults, TokensUsageRecord } from "@pipelex/sdk";

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
 * A run's usage, ready to render. `state` distinguishes the three nullness cases
 * of `RunResults.tokens_usages` that the render must tell apart:
 * - `"records"`      — a non-empty list of inference calls to tabulate.
 * - `"no-inference"` — `[]`: assembly ran but no inference happened (all-cached / mock).
 * - `"unavailable"`  — `null`: assembly was off, broke, or the run predated the artifact.
 *                      `assemblyError` (non-null) is the ONLY signal that it *broke*,
 *                      as opposed to being off — all three leave `tokens_usages` null.
 */
export interface UsageReport {
  calls: UsageCall[];
  /**
   * Sum of the non-null per-call costs; `null` when NO record carried a numeric cost.
   * Null lets the UI say "cost not priced" rather than a misleading "$0.00".
   */
  totalCostUsd: number | null;
  /** Whether any record carried a numeric cost (mirrors `totalCostUsd !== null`). */
  hasCost: boolean;
  state: "records" | "no-inference" | "unavailable";
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
  const records = results.tokens_usages ?? null;
  const assemblyError = results.usage_assembly_error ?? null;

  if (records === null) {
    return { calls: [], totalCostUsd: null, hasCost: false, state: "unavailable", assemblyError };
  }
  if (records.length === 0) {
    return { calls: [], totalCostUsd: null, hasCost: false, state: "no-inference", assemblyError };
  }

  const calls = records.map(toUsageCall);
  // Keep `0` — a priced-at-zero call is a real cost — and drop only the unpriced
  // (`null`) ones. `null` total (no numeric cost anywhere) reads as "not priced".
  const numericCosts = calls.map((c) => c.costUsd).filter((c): c is number => c !== null);
  const hasCost = numericCosts.length > 0;
  const totalCostUsd = hasCost ? numericCosts.reduce((sum, c) => sum + c, 0) : null;
  return { calls, totalCostUsd, hasCost, state: "records", assemblyError };
}

function toUsageCall(record: TokensUsageRecord): UsageCall {
  return {
    modelName: record.inference_model_name ?? null,
    modelType: record.model_type ?? null,
    pipeCode: record.pipe_code ?? null,
    tokensByCategory: record.nb_tokens_by_category ?? null,
    // `?? null` (not `|| null`) so a legitimate `0` cost survives.
    costUsd: record.cost ?? null,
  };
}
