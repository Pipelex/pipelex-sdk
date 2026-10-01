import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunResult } from "./RunResult";
import { requireResultField } from "@/lib/resultField";
import { requireContract } from "@/lib/runInputs";
import { OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/test/fixtures/contracts/summarize-pdf";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "summarize_pdf", "summarize_pdf");
const FIELD = requireResultField(OUTPUT_FORM, CONTRACT, "summarize_pdf", "summarize_pdf");

const SUMMARY = {
  title: "Q3 invoice",
  doc_type: "invoice",
  key_points: ["Total $1,728", "Due 30 days"],
};

describe("RunResult", () => {
  it("renders the concept's own fields, labelled from the descriptor", () => {
    render(<RunResult field={FIELD} value={SUMMARY} name="document_summary" />);

    // No heading is written here for `Doc type` — the label is the field name
    // the method author wrote, humanized by the kernel's `app` presentation.
    // That is the whole claim: change what the method produces, regenerate, and
    // the view follows with nothing hand-written to keep in step.
    expect(screen.getByText("Doc type")).toBeInTheDocument();
    expect(screen.getByText("invoice")).toBeInTheDocument();
    expect(screen.getByText("Total $1,728")).toBeInTheDocument();
  });

  it("titles the panel with the stuff name the caller supplies", () => {
    // The descriptor's own name is the engine's `output` for every pipe there
    // has ever been — correct in the artifact, wrong on screen. Only the caller
    // knows what the reader is looking at.
    render(<RunResult field={FIELD} value={SUMMARY} name="document_summary" />);

    expect(screen.getByText("Document summary")).toBeInTheDocument();
    expect(screen.queryByText("output")).not.toBeInTheDocument();
  });

  it("offers the payload verbatim beside the rendered view", () => {
    // Two views, and they are not peers: the rendered one is the answer for a
    // person, the JSON one is the receipt for whoever is debugging the pipe.
    // Rendered opens first.
    render(<RunResult field={FIELD} value={SUMMARY} name="document_summary" />);

    expect(screen.getByRole("button", { name: "Result" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByText(/"doc_type"/)).toBeInTheDocument();
  });
});
