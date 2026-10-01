import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeToggle } from "./ModeToggle";

describe("ModeToggle", () => {
  it("renders a radiogroup with both modes and marks the selected one", () => {
    render(<ModeToggle value="durable" onChange={vi.fn()} />);
    const group = screen.getByRole("radiogroup", { name: /execution mode/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Blocking" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("radio", { name: /Durable/ })).toHaveAttribute("aria-checked", "true");
  });

  it("fires onChange with the clicked mode", () => {
    const onChange = vi.fn();
    render(<ModeToggle value="durable" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    expect(onChange).toHaveBeenCalledWith("blocking");
  });

  it("respects disabled", () => {
    const onChange = vi.fn();
    render(<ModeToggle value="durable" onChange={onChange} disabled />);
    const blocking = screen.getByRole("radio", { name: "Blocking" });
    expect(blocking).toBeDisabled();
    fireEvent.click(blocking);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses a roving tabindex — only the selected radio is tabbable", () => {
    render(<ModeToggle value="durable" onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: /Durable/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Blocking" })).toHaveAttribute("tabindex", "-1");
  });

  it("arrow keys select the other mode and move focus to it", () => {
    const onChange = vi.fn();
    render(<ModeToggle value="durable" onChange={onChange} />);
    const durable = screen.getByRole("radio", { name: /Durable/ });
    const blocking = screen.getByRole("radio", { name: "Blocking" });

    durable.focus();
    fireEvent.keyDown(durable, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("blocking");
    expect(blocking).toHaveFocus();

    fireEvent.keyDown(blocking, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("durable");
    expect(durable).toHaveFocus();
  });

  it("arrow keys wrap around the group", () => {
    const onChange = vi.fn();
    render(<ModeToggle value="blocking" onChange={onChange} />);
    const blocking = screen.getByRole("radio", { name: "Blocking" });
    blocking.focus();
    // Blocking is first; ArrowLeft wraps to the last option (Durable).
    fireEvent.keyDown(blocking, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("durable");
  });

  it("arrow keys do nothing when disabled", () => {
    const onChange = vi.fn();
    render(<ModeToggle value="durable" onChange={onChange} disabled />);
    fireEvent.keyDown(screen.getByRole("radio", { name: /Durable/ }), { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
