import { describe, it, expect } from "vitest";
import type { RunResults, TokensUsageRecord } from "@pipelex/sdk";
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
          pipe_code: "extract_entities",
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
        pipeCode: "extract_entities",
        tokensByCategory: { input: 1200, input_cached: 200, output: 340 },
        costUsd: 0.0042,
      },
    ]);
    // The category map is carried through verbatim — never summed (non-additive).
    expect(report.calls[0].tokensByCategory).toEqual({
      input: 1200,
      input_cached: 200,
      output: 340,
    });
  });

  it("sums only the non-null costs; a null cost is skipped and a 0 cost is kept", () => {
    const report = buildUsageReport(
      resultsWith([
        { inference_model_name: "a", cost: 0.01 },
        { inference_model_name: "b", cost: null }, // unpriced (own-GPU/mock) — skipped
        { inference_model_name: "c", cost: 0 }, // priced at zero — a real $0.00, kept
      ]),
    );

    expect(report.state).toBe("records");
    expect(report.hasCost).toBe(true);
    expect(report.totalCostUsd).toBeCloseTo(0.01);
    expect(report.calls.map((c) => c.costUsd)).toEqual([0.01, null, 0]);
  });

  it("returns a null total (not 0) when NO record carried a numeric cost", () => {
    const report = buildUsageReport(
      resultsWith([
        { inference_model_name: "a", cost: null },
        { inference_model_name: "b" }, // cost absent entirely
      ]),
    );

    expect(report.state).toBe("records");
    expect(report.hasCost).toBe(false);
    expect(report.totalCostUsd).toBeNull();
  });

  it("maps an empty list to state 'no-inference'", () => {
    const report = buildUsageReport(resultsWith([]));
    expect(report).toEqual({
      calls: [],
      totalCostUsd: null,
      hasCost: false,
      state: "no-inference",
      assemblyError: null,
    });
  });

  it("maps a null list to state 'unavailable'", () => {
    const report = buildUsageReport(resultsWith(null));
    expect(report).toEqual({
      calls: [],
      totalCostUsd: null,
      hasCost: false,
      state: "unavailable",
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
