import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { RunField } from "@pipelex/mthds-form";
import { RunInputsForm } from "./RunInputsForm";

/**
 * Fields as `useRunInputs` derives them from a contract. Written inline rather
 * than taken from a generated contract on purpose: no method in `methods/` has
 * an optional input, so the case this file exists for is unreachable from the
 * committed artifacts — and it is the case adopters inherit.
 */
function textField(name: string, required: boolean): RunField {
  return { name, kind: "text", required };
}

const FIELDS = [textField("subject", true), textField("note", false)];

/** Render with controlled values, the way the forms do. */
function Harness({ initial }: { initial: Record<string, unknown> }) {
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  return (
    <RunInputsForm fields={FIELDS} values={values} onValuesChange={setValues} disabled={false} />
  );
}

describe("RunInputsForm", () => {
  it("opens with an empty optional input folded away, behind a toggle", () => {
    render(<Harness initial={{}} />);
    expect(screen.getByRole("textbox", { name: /subject/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /note/i })).not.toBeInTheDocument();
    // Folded, never stranded: anything hidden puts the toggle on screen.
    expect(screen.getByRole("button", { name: /optional/i })).toBeInTheDocument();
  });

  it("shows a seeded optional input, and keeps it mounted when it is cleared", () => {
    // A `kind: "text"` field's run-value is a bare string — `{text: "seeded"}`
    // is the *wire* shape, and seeding it renders "[object Object]". Same
    // mistake the integration log records catching in the plural case.
    render(<Harness initial={{ note: "seeded" }} />);
    const note = screen.getByRole("textbox", { name: /note/i });
    note.focus();

    // The regression this guards: foldability recomputed from the live value
    // makes clearing the last character move the field into the folded set,
    // unmounting the control mid-edit and dropping focus to <body>. Decided
    // once at mount, the field stays put — so it is still the same DOM node,
    // and the caret is still in it.
    fireEvent.change(note, { target: { value: "" } });

    expect(screen.getByRole("textbox", { name: /note/i })).toBe(note);
    expect(document.activeElement).toBe(note);
  });

  it("keeps an optional input the user filled on screen after collapsing", () => {
    render(<Harness initial={{}} />);
    fireEvent.click(screen.getByRole("button", { name: /optional/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /note/i }), {
      target: { value: "written by hand" },
    });

    // Collapsing must not pull a filled control off the page while its value
    // still goes out on the run — and the toggle must stop counting it as one
    // of the empty ones it is offering to reveal.
    fireEvent.click(screen.getByRole("button", { name: /optional/i }));

    const note = screen.getByRole("textbox", { name: /note/i });
    expect((note as HTMLInputElement | HTMLTextAreaElement).value).toBe("written by hand");
    expect(screen.queryByRole("button", { name: /optional/i })).not.toBeInTheDocument();
  });
});
