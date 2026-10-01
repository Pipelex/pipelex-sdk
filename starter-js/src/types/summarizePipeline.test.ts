import { describe, it, expect } from "vitest";
import type { RunResults } from "@pipelex/sdk";
import { parseDocumentSummary } from "./summarizePipeline";

/** Both paths deliver the resolved output on `main_stuff` (the SDK digs it out on the blocking path too). */
function mainStuff(content: unknown): RunResults {
  return { pipeline_run_id: "run-123", main_stuff: content };
}

describe("parseDocumentSummary", () => {
  it("extracts a DocumentSummary from main_stuff, keeping the bundle's field names", () => {
    const summary = {
      title: "Q1 Revenue Report",
      doc_type: "report",
      key_points: ["Revenue up 12%", "Costs flat"],
    };
    expect(parseDocumentSummary(mainStuff(summary))).toEqual(summary);
  });

  it("accepts an empty key_points list", () => {
    const result = parseDocumentSummary(
      mainStuff({ title: "Memo", doc_type: "memo", key_points: [] }),
    );
    expect(result.key_points).toEqual([]);
  });

  it("throws when main_stuff is not the expected object (a list output / scalar)", () => {
    expect(() => parseDocumentSummary(mainStuff(null))).toThrow();
    expect(() => parseDocumentSummary(mainStuff([{ title: "T" }]))).toThrow();
  });

  it("throws when no output content matches the DocumentSummary shape", () => {
    expect(() => parseDocumentSummary(mainStuff({ foo: "bar" }))).toThrow();
  });

  it("names the offending field in the error, so a bundle edit is diagnosable", () => {
    expect(() =>
      parseDocumentSummary(mainStuff({ title: 42, doc_type: "report", key_points: [] })),
    ).toThrow(/title/);
    expect(() =>
      parseDocumentSummary(mainStuff({ title: "T", doc_type: "report", key_points: ["ok", 7] })),
    ).toThrow(/key_points/);
  });
});
