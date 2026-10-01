import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostReport } from "./CostReport";
import type { UsageCall, UsageReport } from "@/lib/usageReport";

const PRICED: UsageCall = {
  modelName: "gpt-4o",
  modelType: "llm",
  pipeCode: "extract_entities",
  tokensByCategory: { input: 1200, output: 340 },
  costUsd: 0.0042,
};

const UNPRICED: UsageCall = {
  modelName: "own-gpu-model",
  modelType: "llm",
  pipeCode: "classify",
  tokensByCategory: { input: 50 },
  costUsd: null,
};

const ALL_PRICED: UsageReport = {
  state: "records",
  calls: [PRICED, { ...PRICED, pipeCode: "summarize", costUsd: 0.001 }],
  totalCostUsd: 0.0052,
  costPartial: false,
  assemblyError: null,
};

const MIXED: UsageReport = {
  state: "records",
  calls: [PRICED, UNPRICED],
  totalCostUsd: 0.0042,
  costPartial: true,
  assemblyError: null,
};

describe("CostReport", () => {
  it("renders a per-call table with model, pipe, tokens, and cost, plus a total when every call was priced", () => {
    render(<CostReport usage={ALL_PRICED} />);

    expect(screen.getAllByText("gpt-4o")).toHaveLength(2);
    expect(screen.getByText("extract_entities")).toBeInTheDocument();
    // Raw token categories are shown verbatim, never summed.
    expect(screen.getAllByText("input 1,200 · output 340")).toHaveLength(2);
    expect(screen.getByText("$0.0042")).toBeInTheDocument();
    expect(screen.getByText("$0.0052")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.queryByText(/partial cost/i)).not.toBeInTheDocument();
  });

  it("renders an unpriced call's cost as an em dash (not $0.00)", () => {
    render(<CostReport usage={MIXED} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("does not label a partial sum 'Total': it names the priced calls and says the sum is a lower bound", () => {
    render(<CostReport usage={MIXED} />);

    expect(screen.queryByText("Total")).not.toBeInTheDocument();
    expect(screen.getByText("Priced calls only")).toBeInTheDocument();
    // The sum shows on the priced row and on the footer.
    expect(screen.getAllByText("$0.0042")).toHaveLength(2);
    expect(screen.getByText(/partial cost: 1 of 2 calls had no rate table/i)).toBeInTheDocument();
    expect(screen.getByText(/lower bound/i)).toBeInTheDocument();
  });

  it("shows 'Not priced' as the total when no call carried a numeric cost", () => {
    render(
      <CostReport
        usage={{
          state: "records",
          calls: [{ ...UNPRICED, modelName: "own-gpu", pipeCode: "p" }],
          totalCostUsd: null,
          costPartial: false,
          assemblyError: null,
        }}
      />,
    );
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Not priced")).toBeInTheDocument();
    expect(screen.getByText(/no model in this run had a rate table/i)).toBeInTheDocument();
  });

  it("renders a subtle note for a run that did no inference", () => {
    render(
      <CostReport
        usage={{
          state: "no_inference",
          calls: [],
          totalCostUsd: 0,
          costPartial: false,
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
          costPartial: false,
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
          costPartial: false,
          assemblyError: "assembler exploded",
        }}
      />,
    );
    expect(screen.getByText(/usage reporting is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText("assembler exploded")).toBeInTheDocument();
  });
});
