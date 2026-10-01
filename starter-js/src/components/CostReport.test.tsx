import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostReport } from "./CostReport";
import type { UsageReport } from "@/lib/usageReport";

const RECORDS: UsageReport = {
  state: "records",
  calls: [
    {
      modelName: "gpt-4o",
      modelType: "llm",
      pipeCode: "extract_entities",
      tokensByCategory: { input: 1200, output: 340 },
      costUsd: 0.0042,
    },
    {
      modelName: "own-gpu-model",
      modelType: "llm",
      pipeCode: "classify",
      tokensByCategory: { input: 50 },
      costUsd: null, // unpriced
    },
  ],
  totalCostUsd: 0.0042,
  hasCost: true,
  assemblyError: null,
};

describe("CostReport", () => {
  it("renders a per-call table with model, pipe, tokens, and cost, plus a total", () => {
    render(<CostReport usage={RECORDS} />);

    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("extract_entities")).toBeInTheDocument();
    // Raw token categories are shown verbatim, never summed.
    expect(screen.getByText("input 1,200 · output 340")).toBeInTheDocument();
    // The cost shows on both the per-call row and the total row (one priced call).
    expect(screen.getAllByText("$0.0042")).toHaveLength(2);
    // The total row carries the summed cost.
    expect(screen.getByText("Total")).toBeInTheDocument();
  });

  it("renders an unpriced call's cost as an em dash (not $0.00)", () => {
    render(<CostReport usage={RECORDS} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows 'Not priced' as the total when no call carried a numeric cost", () => {
    render(
      <CostReport
        usage={{
          state: "records",
          calls: [
            {
              modelName: "own-gpu",
              modelType: "llm",
              pipeCode: "p",
              tokensByCategory: { input: 10 },
              costUsd: null,
            },
          ],
          totalCostUsd: null,
          hasCost: false,
          assemblyError: null,
        }}
      />,
    );
    expect(screen.getByText("Not priced")).toBeInTheDocument();
    expect(screen.getByText(/no model in this run had a rate table/i)).toBeInTheDocument();
  });

  it("renders a subtle note for a no-inference run", () => {
    render(
      <CostReport
        usage={{
          state: "no-inference",
          calls: [],
          totalCostUsd: null,
          hasCost: false,
          assemblyError: null,
        }}
      />,
    );
    expect(screen.getByText(/no billable inference/i)).toBeInTheDocument();
  });

  it("renders nothing when usage is unavailable and assembly did not break", () => {
    const { container } = render(
      <CostReport
        usage={{
          state: "unavailable",
          calls: [],
          totalCostUsd: null,
          hasCost: false,
          assemblyError: null,
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces the assembly error when usage assembly broke", () => {
    render(
      <CostReport
        usage={{
          state: "unavailable",
          calls: [],
          totalCostUsd: null,
          hasCost: false,
          assemblyError: "assembler exploded",
        }}
      />,
    );
    expect(screen.getByText(/usage reporting is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText("assembler exploded")).toBeInTheDocument();
  });
});
