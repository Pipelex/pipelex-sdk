import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MethodPage } from "./MethodPage";
import type { RegisteredMethod } from "@/methods";

// The app's own registry is replaced by one stand-in, so the default-prop test
// pins the wiring without depending on which methods this checkout has added
// (and without importing their forms and Server Actions).
vi.mock("@/methods", () => ({
  METHODS: [
    { id: "registered", label: "Registered", Component: () => <div>REGISTERED PANEL</div> },
  ],
}));

// Stand-in method panels — this test covers the page's three shapes only, so a
// registry of its own is passed rather than the app's.
const FIRST: RegisteredMethod = {
  id: "first",
  label: "First method",
  Component: () => <div>FIRST PANEL</div>,
};
const SECOND: RegisteredMethod = {
  id: "second",
  label: "Second method",
  Component: () => <div>SECOND PANEL</div>,
};

describe("MethodPage", () => {
  it("names the gesture that adds a method when none is registered", () => {
    render(<MethodPage methods={[]} />);
    expect(screen.getByRole("heading", { name: "No method yet" })).toBeVisible();
    expect(screen.getByText(/make add-method/)).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("renders the one method as the page, with no tab bar and no label", () => {
    render(<MethodPage methods={[FIRST]} />);
    expect(screen.getByText("FIRST PANEL")).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByText("First method")).not.toBeInTheDocument();
  });

  it("renders a tab per method from the second one, the first selected", () => {
    render(<MethodPage methods={[FIRST, SECOND]} />);
    expect(screen.getByRole("tablist")).toBeVisible();
    expect(screen.getByText("FIRST PANEL")).toBeVisible();
    expect(screen.getByText("SECOND PANEL")).not.toBeVisible();
    expect(screen.getByRole("tab", { name: "First method" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches panels when a tab is clicked, keeping the other one mounted", () => {
    render(<MethodPage methods={[FIRST, SECOND]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Second method" }));

    expect(screen.getByText("SECOND PANEL")).toBeVisible();
    // Still in the document: a run in flight on the first panel survives the switch.
    expect(screen.getByText("FIRST PANEL")).not.toBeVisible();
    expect(screen.getByRole("tab", { name: "Second method" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders the app's own registry when given none", () => {
    render(<MethodPage />);
    expect(screen.getByText("REGISTERED PANEL")).toBeVisible();
  });
});
