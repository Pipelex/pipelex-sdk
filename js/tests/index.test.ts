import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGGREGATES,
  CONTRACT_FORMATS,
  OPTION_TONES,
  SDK_VERSION,
  type EnumFieldNode,
  type NumberFieldNode,
  type TextFieldNode,
} from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("SDK_VERSION", () => {
  it("is exported as a semver string", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the version in package.json", () => {
    // The exported runtime constant must not drift from the published package
    // version — a stale value misreports the SDK to consumers doing diagnostics
    // or compatibility checks. The repository root's /release skill bumps both together.
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe("the MTHDS 9.2.0 descriptor facts", () => {
  it("reach the barrel with the standard's vocabularies", () => {
    expect(AGGREGATES).toEqual(["sum", "average"]);
    expect(OPTION_TONES).toEqual(["positive", "caution", "negative", "neutral"]);
    expect(CONTRACT_FORMATS).toContain("email");
  });

  it("type a number's unit and aggregate, an enum's options and a text's format", () => {
    // The nodes compile only while the barrel's types carry these members.
    const amount: NumberFieldNode = {
      kind: "number",
      required: true,
      integer: false,
      unit: "EUR",
      aggregate: "sum",
    };
    const verdict: EnumFieldNode = {
      kind: "enum",
      required: true,
      choices: ["approve", "reject"],
      options: [
        { value: "approve", tone: "positive" },
        { value: "reject", label: "Reject", tone: "negative" },
      ],
    };
    const contact: TextFieldNode = { kind: "text", required: false, format: "email" };
    expect([amount.unit, amount.aggregate, verdict.options?.[1]?.label, contact.format]).toEqual([
      "EUR",
      "sum",
      "Reject",
      "email",
    ]);
  });
});
