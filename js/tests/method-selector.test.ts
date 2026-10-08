import { describe, expect, it } from "vitest";
import { RequestArgumentError } from "../src/errors.js";
import { parseMethodSelector } from "../src/method-selector.js";
import { parseMethodSelector as parseFromBarrel } from "../src/index.js";

describe("parseMethodSelector", () => {
  it.each([
    ["mt_abc", { method_id: "mt_abc", version: null }],
    ["mt_abc@3", { method_id: "mt_abc", version: 3 }],
    ["mt_abc@10", { method_id: "mt_abc", version: 10 }],
    ["mt_abc@draft", { method_id: "mt_abc", version: "draft" }],
    [
      "mt_0b9f5e1c-2d3a-4f6b-8c7d-9e0a1b2c3d4e@12",
      { method_id: "mt_0b9f5e1c-2d3a-4f6b-8c7d-9e0a1b2c3d4e", version: 12 },
    ],
    ["mt_a_b-c@9007199254740991", { method_id: "mt_a_b-c", version: 9007199254740991 }],
  ] as const)("splits %s into its bare id and version", (selector, expected) => {
    expect(parseMethodSelector(selector)).toEqual(expected);
  });

  it.each([
    ["an empty suffix", "mt_abc@"],
    ["version zero", "mt_abc@0"],
    ["a leading zero", "mt_abc@03"],
    ["a sign", "mt_abc@+3"],
    ["a negative number", "mt_abc@-3"],
    ["a decimal", "mt_abc@1.5"],
    ["a word other than draft", "mt_abc@latest"],
    ["draft in another case", "mt_abc@Draft"],
    ["two suffixes", "mt_abc@3@4"],
    ["a space", "mt_abc@ 3"],
    ["a number too large to address exactly", "mt_abc@9007199254740993"],
  ])("refuses %s", (_, selector) => {
    expect(() => parseMethodSelector(selector)).toThrow(RequestArgumentError);
  });

  it.each([
    ["no catalog prefix", "abc@3"],
    ["an empty id", "mt_@3"],
    ["a bare prefix", "mt_"],
    ["a dot in the id", "mt_a.b"],
    ["a path", "mt_a/b"],
    ["an empty string", ""],
  ])("refuses %s, naming what a catalog id is", (_, selector) => {
    expect(() => parseMethodSelector(selector)).toThrow(/a catalog id is mt_ followed by/);
  });

  it("says what a suffix may be when it refuses one", () => {
    expect(() => parseMethodSelector("mt_abc@v3")).toThrow(
      '"mt_abc@v3" names no version: the suffix of a catalog id is @<version>, a positive ' +
        "number without a leading zero, or @draft.",
    );
  });

  it("refuses a value that is not a string, as an untyped caller may pass", () => {
    expect(() => parseMethodSelector(3 as unknown as string)).toThrow(RequestArgumentError);
  });

  it("refuses with an input verdict, not retryable", () => {
    const err = (() => {
      try {
        parseMethodSelector("mt_abc@0");
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })() as RequestArgumentError;
    expect(err.errorDomain).toBe("input");
    expect(err.retryable).toBe(false);
  });

  it("is on the public barrel", () => {
    expect(parseFromBarrel).toBe(parseMethodSelector);
  });
});
