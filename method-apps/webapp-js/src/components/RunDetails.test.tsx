import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { RunDetails } from "./RunDetails";
import type { UsageReport } from "@/lib/usageReport";

const PRICED: UsageReport = {
  state: "records",
  calls: [
    {
      modelName: "gpt-4o",
      modelType: "llm",
      pipeCode: "extract_entities",
      tokensByCategory: { input: 1200, output: 340 },
      costUsd: 0.0042,
    },
  ],
  totalCostUsd: 0.0042,
  costPartial: false,
  assemblyError: null,
};

const OFF: UsageReport = {
  state: "unavailable",
  calls: [],
  totalCostUsd: null,
  costPartial: false,
  assemblyError: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("RunDetails", () => {
  it("shows the run id, selectable in one click", () => {
    render(<RunDetails runId="run_abc123" usage={PRICED} />);
    expect(screen.getByText("run_abc123")).toHaveClass("select-all");
  });

  it("copies the run id to the clipboard and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<RunDetails runId="run_abc123" usage={PRICED} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the run id" }));
    });

    expect(writeText).toHaveBeenCalledWith("run_abc123");
    expect(screen.getByRole("button", { name: "Run id copied" })).toHaveTextContent("Copied");
  });

  it("leaves the id selectable when the browser refuses the clipboard", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<RunDetails runId="run_abc123" usage={PRICED} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the run id" }));
    });

    expect(screen.getByRole("button", { name: "Copy the run id" })).toHaveTextContent("Copy");
    expect(screen.getByText("run_abc123")).toHaveClass("select-all");
  });

  it("keeps the cost report in a disclosure that starts closed", () => {
    render(<RunDetails runId="run_abc123" usage={PRICED} />);
    const disclosure = screen.getByText("Usage and cost").closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute("open");
    // The cost report is inside it, not beside it.
    expect(disclosure).toContainElement(screen.getByRole("region", { name: "Cost report" }));
  });

  it("offers no disclosure when there is no usage to show", () => {
    render(<RunDetails runId="run_abc123" usage={OFF} />);
    expect(screen.queryByText("Usage and cost")).not.toBeInTheDocument();
    expect(screen.getByText("run_abc123")).toBeInTheDocument();
  });
});
