import { describe, it, expect } from "vitest";
import { summarizeUsage, type RunResults, type TokensUsageRecord } from "@pipelex/sdk";
import { buildUsageReport } from "./usageReport";

function resultsWith(
  tokens_usages: TokensUsageRecord[] | null,
  usage_assembly_error: string | null = null,
): RunResults {
  return { pipeline_run_id: "r", main_stuff: {}, tokens_usages, usage_assembly_error };
}

describe("buildUsageReport", () => {
  it("maps a non-empty record list to state 'records' and projects each call", () => {
    const report = buildUsageReport(
      resultsWith([
        {
          model_type: "llm",
          inference_model_name: "gpt-4o",
          pipe_code: "fixture_pipe",
          nb_tokens_by_category: { input: 1200, input_cached: 200, output: 340 },
          cost: 0.0042,
        },
      ]),
    );

    expect(report.state).toBe("records");
    expect(report.calls).toEqual([
      {
        modelName: "gpt-4o",
        modelType: "llm",
        pipeCode: "fixture_pipe",
        tokensByCategory: { input: 1200, input_cached: 200, output: 340 },
        costUsd: 0.0042,
      },
    ]);
    expect(report.costPartial).toBe(false);
    // The category map is carried through verbatim — never summed (non-additive).
    expect(report.calls[0].tokensByCategory).toEqual({
      input: 1200,
      input_cached: 200,
      output: 340,
    });
  });

  it("is a projection of the SDK's summarizeUsage: the totals are its, not re-derived", () => {
    const results = resultsWith([
      { inference_model_name: "a", cost: 0.01 },
      { inference_model_name: "b", cost: null }, // unpriced (own-GPU/mock)
      { inference_model_name: "c", cost: 0 }, // priced at zero — a real $0.00
    ]);
    const summary = summarizeUsage(results);
    const report = buildUsageReport(results);

    expect(report.state).toBe(summary.state);
    expect(report.totalCostUsd).toBe(summary.total_cost_usd);
    expect(report.costPartial).toBe(summary.cost_partial);
    expect(report.assemblyError).toBe(summary.assembly_error);
  });

  it("flags a partial cost when priced and unrated calls are mixed, and sums the priced ones", () => {
    const report = buildUsageReport(
      resultsWith([
        { inference_model_name: "a", cost: 0.01 },
        { inference_model_name: "b", cost: null },
        { inference_model_name: "c", cost: 0 },
      ]),
    );

    expect(report.totalCostUsd).toBeCloseTo(0.01);
    expect(report.costPartial).toBe(true);
    expect(report.calls.map((c) => c.costUsd)).toEqual([0.01, null, 0]);
  });

  it("returns a null total (not 0), and no partial flag, when NO record carried a numeric cost", () => {
    const report = buildUsageReport(
      resultsWith([
        { inference_model_name: "a", cost: null },
        { inference_model_name: "b" }, // cost absent entirely
      ]),
    );

    expect(report.state).toBe("records");
    expect(report.totalCostUsd).toBeNull();
    expect(report.costPartial).toBe(false);
  });

  it("maps an empty list to state 'no_inference', which costs 0 rather than null", () => {
    const report = buildUsageReport(resultsWith([]));
    expect(report).toEqual({
      state: "no_inference",
      calls: [],
      totalCostUsd: 0,
      costPartial: false,
      assemblyError: null,
    });
  });

  it("maps a null list to state 'unavailable', where nothing is known", () => {
    const report = buildUsageReport(resultsWith(null));
    expect(report).toEqual({
      state: "unavailable",
      calls: [],
      totalCostUsd: null,
      costPartial: false,
      assemblyError: null,
    });
  });

  it("carries the assembly error through — the only signal that usage broke vs was off", () => {
    const report = buildUsageReport(resultsWith(null, "assembler exploded"));
    expect(report.state).toBe("unavailable");
    expect(report.assemblyError).toBe("assembler exploded");
  });

  it("treats an absent tokens_usages field the same as null (unavailable)", () => {
    const report = buildUsageReport({ pipeline_run_id: "r", main_stuff: {} });
    expect(report.state).toBe("unavailable");
    expect(report.assemblyError).toBeNull();
  });
});
