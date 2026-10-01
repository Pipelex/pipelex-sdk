import { describe, it, expect } from "vitest";
import type { RunResults } from "@pipelex/sdk";
import { parseEntities } from "./extractEntitiesPipeline";

/** Both paths deliver the resolved output on `main_stuff` (the SDK digs it out on the blocking path too). */
function mainStuff(content: unknown): RunResults {
  return { pipeline_run_id: "run-123", main_stuff: content };
}

const VALID = { people: ["Tim Cook"], orgs: ["Apple"], dates: ["March 5th, 2026"] };

describe("parseEntities", () => {
  it("extracts a valid ExtractedEntities from main_stuff", () => {
    expect(parseEntities(mainStuff(VALID))).toEqual(VALID);
  });

  it("accepts empty arrays for any field", () => {
    const empty = { people: [], orgs: [], dates: [] };
    expect(parseEntities(mainStuff(empty))).toEqual(empty);
  });

  it("throws when no output content matches the ExtractedEntities shape", () => {
    expect(() => parseEntities(mainStuff({ foo: "bar" }))).toThrow();
  });

  it("throws when main_stuff is not the expected object (a list output / scalar)", () => {
    expect(() => parseEntities(mainStuff([VALID]))).toThrow();
    expect(() => parseEntities(mainStuff(null))).toThrow();
  });

  it("names the offending field when it is not an array of strings", () => {
    expect(() => parseEntities(mainStuff({ people: "Tim", orgs: [], dates: [] }))).toThrow(
      /people/,
    );
    expect(() => parseEntities(mainStuff({ people: [1, 2], orgs: [], dates: [] }))).toThrow(
      /people/,
    );
  });
});
