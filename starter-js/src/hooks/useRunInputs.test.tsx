import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RunField } from "@pipelex/mthds-form";
import { INPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/summarize-pdf/contracts";
import { requireContract, requireInputForm } from "@/lib/runInputs";
import { ALLOWED_MIMES } from "@/types/summarizePdfUploads";
import { useRunInputs } from "./useRunInputs";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "summarize_pdf", "summarize_pdf");
const DESCRIPTOR = requireInputForm(INPUT_FORM, "summarize_pdf", "summarize_pdf");

/** The media types of a file field's formats, in the order the field lists them. */
function mimeTypesOf(field: RunField | undefined): string[] {
  if (field?.kind !== "document" && field?.kind !== "image") {
    throw new Error(`expected a file field, got ${field?.kind ?? "none"}`);
  }
  return field.formats.map((format) => format.mimeType);
}

describe("useRunInputs", () => {
  it("keeps every format the kernel knows for a file input when no list is given", () => {
    const { result } = renderHook(() => useRunInputs(CONTRACT, DESCRIPTOR));
    // A document slot takes PDF and the two image formats the extract model reads.
    expect(mimeTypesOf(result.current.fields[0])).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
    ]);
  });

  it("narrows a file input to the media types the upload action grants", () => {
    const { result } = renderHook(() =>
      useRunInputs(CONTRACT, DESCRIPTOR, { allowedMimes: ALLOWED_MIMES }),
    );
    // The PDF example's grant action takes PDF alone, so the dropzone must not
    // offer the PNG it would then refuse.
    expect(mimeTypesOf(result.current.fields[0])).toEqual(["application/pdf"]);
  });

  it("refuses a list that leaves a file input accepting nothing", () => {
    expect(() =>
      renderHook(() => useRunInputs(CONTRACT, DESCRIPTOR, { allowedMimes: ["text/csv"] })),
    ).toThrow();
  });

  it("seeds the values it is given", () => {
    const seed = { document: { url: "https://example.com/a.pdf", filename: "a.pdf" } };
    const { result } = renderHook(() =>
      useRunInputs(CONTRACT, DESCRIPTOR, { initialValues: seed }),
    );
    expect(result.current.values).toEqual(seed);
  });
});
