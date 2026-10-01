import { describe, it, expect } from "vitest";
import { requireResultField } from "./resultField";
import { requireContract } from "./runInputs";
import { OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/extract-entities/contracts";
import {
  OUTPUT_FORM as IMAGE_OUTPUT_FORM,
  PIPE_IO_CONTRACTS as IMAGE_CONTRACTS,
} from "@/generated/generate-image/contracts";
import {
  OUTPUT_FORM as TEXT_STATS_OUTPUT_FORM,
  PIPE_IO_CONTRACTS as TEXT_STATS_CONTRACTS,
} from "@/generated/text-stats/contracts";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "extract_entities", "extract_entities");

describe("requireResultField", () => {
  it("builds a structured result from the descriptor and the payload schema", () => {
    const field = requireResultField(OUTPUT_FORM, CONTRACT, "extract_entities", "extract_entities");

    // An `object` output IS its content model, so nothing is unwrapped and the
    // concept's own fields are the field tree the view renders.
    expect(field.kind).toBe("object");
    expect(field.contentKey).toBeUndefined();
    expect(field.kind === "object" && field.fields.map((f) => f.name)).toEqual([
      "people",
      "orgs",
      "dates",
    ]);
  });

  it("carries the wrapper property name for a scalar concept's content model", () => {
    // `native.Text` arrives as `TextContent {text}`, and the property the payload
    // sits under is read off the schema rather than guessed at by counting the
    // value's keys. Without it the view renders `[object Object]`.
    const contract = requireContract(TEXT_STATS_CONTRACTS, "text_stats", "analyze_text");
    const field = requireResultField(
      TEXT_STATS_OUTPUT_FORM,
      contract,
      "text_stats",
      "analyze_text",
    );

    expect(field.kind).toBe("prose");
    expect(field.contentKey).toBe("text");
  });

  it("leaves a multi-property content model alone", () => {
    // `native.Image` declares `url`, `public_url`, `caption` and more, so it is
    // not a single-property wrapper and the payload is the value itself. The
    // rule is read off the schema's shape, which is what keeps a one-field
    // structured concept from being mistaken for a wrapper.
    const contract = requireContract(IMAGE_CONTRACTS, "generate_image", "generate_image");
    const field = requireResultField(
      IMAGE_OUTPUT_FORM,
      contract,
      "generate_image",
      "generate_image",
    );

    expect(field.kind).toBe("image");
    expect(field.contentKey).toBeUndefined();
  });

  it("throws naming the available keys when the lookup misses", () => {
    // Same failure mode as a missed contract or input descriptor: the kernel
    // answers `undefined`, and a result panel with no field renders nothing at
    // all — which reads as a styling bug rather than as a wiring mistake.
    expect(() => requireResultField(OUTPUT_FORM, CONTRACT, "extract_entities", "nope")).toThrow(
      /extract_entities\.nope/,
    );
    expect(() => requireResultField(OUTPUT_FORM, CONTRACT, "extract_entities", "nope")).toThrow(
      /extract_entities\.extract_entities/,
    );
  });
});
