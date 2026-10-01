import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExampleTabs } from "./ExampleTabs";

// Stub every example form — this test covers tab switching only. A form left
// unmocked still renders (and passes), but it drags its whole action module in
// and the failure would then be attributed here rather than to that form.
vi.mock("./EntityForm", () => ({ EntityForm: () => <div>TEXT PANEL</div> }));
vi.mock("./PdfForm", () => ({ PdfForm: () => <div>PDF PANEL</div> }));
vi.mock("./ImageForm", () => ({ ImageForm: () => <div>IMAGE PANEL</div> }));
vi.mock("./ComplexForm", () => ({ ComplexForm: () => <div>COMPLEX PANEL</div> }));
vi.mock("./TextStatsForm", () => ({ TextStatsForm: () => <div>TEXT STATS PANEL</div> }));

describe("ExampleTabs", () => {
  it("shows the text example by default", () => {
    render(<ExampleTabs />);
    expect(screen.getByText("TEXT PANEL")).toBeVisible();
    expect(screen.getByText("PDF PANEL")).not.toBeVisible();
    expect(screen.getByRole("tab", { name: /text entities/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches to the PDF example when its tab is clicked", () => {
    render(<ExampleTabs />);
    fireEvent.click(screen.getByRole("tab", { name: /pdf summary/i }));

    expect(screen.getByText("PDF PANEL")).toBeVisible();
    expect(screen.getByText("TEXT PANEL")).not.toBeVisible();
    expect(screen.getByRole("tab", { name: /pdf summary/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches to the image example when its tab is clicked", () => {
    render(<ExampleTabs />);
    fireEvent.click(screen.getByRole("tab", { name: /image generation/i }));

    expect(screen.getByText("IMAGE PANEL")).toBeVisible();
    expect(screen.getByText("TEXT PANEL")).not.toBeVisible();
  });

  it("switches to the complex-inputs example when its tab is clicked", () => {
    render(<ExampleTabs />);
    fireEvent.click(screen.getByRole("tab", { name: /complex inputs/i }));

    expect(screen.getByText("COMPLEX PANEL")).toBeVisible();
    expect(screen.getByText("TEXT PANEL")).not.toBeVisible();
  });

  // The scaffolded tab is registered exactly like the four hand-written ones —
  // one entry in `TABS`, which is what `make add-method` inserted at the anchor.
  it("switches to the scaffolded text-stats example when its tab is clicked", () => {
    render(<ExampleTabs />);
    fireEvent.click(screen.getByRole("tab", { name: /text stats/i }));

    expect(screen.getByText("TEXT STATS PANEL")).toBeVisible();
    expect(screen.getByText("TEXT PANEL")).not.toBeVisible();
  });
});
