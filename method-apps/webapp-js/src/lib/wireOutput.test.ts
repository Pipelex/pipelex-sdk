import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { RunResults } from "@pipelex/sdk";
import { describeSchemaFailure, wireListOutput, wireOutput } from "./wireOutput";

/**
 * A structured concept as the ts-zod projection emits one: a non-required field
 * is `.nullish()`, so the runtime's explicit `null` for an unset field parses
 * without any normalization in between.
 */
const ImageLike = z.object({
  url: z.string(),
  public_url: z.string().nullish(),
  caption: z.string().nullish(),
});

describe("wireOutput", () => {
  it("hands main_stuff to the binder unchanged", () => {
    const main_stuff = { url: "https://x", caption: null };
    const results: RunResults = { pipeline_run_id: "run-1", main_stuff };
    expect(wireOutput(results)).toBe(main_stuff);
  });

  it("is enough for the projection to accept the runtime's own nulls", () => {
    // The hosted runtime emits `"caption": null` for an unset optional field,
    // and `.nullish()` accepts it — the reason no strip step sits here.
    const results: RunResults = {
      pipeline_run_id: "run-1",
      main_stuff: { url: "https://x/y.png", caption: null, public_url: null },
    };
    expect(ImageLike.safeParse(wireOutput(results)).success).toBe(true);
  });

  it("reads only main_stuff — a matching pipe_output entry must not rescue it", () => {
    const results = {
      pipeline_run_id: "run-1",
      main_stuff: { caption: "no url here" },
      pipe_output: { working_memory: { root: { e: { content: { url: "https://ignored" } } } } },
    } as unknown as RunResults;
    expect(wireOutput(results)).toEqual({ caption: "no url here" });
    expect(ImageLike.safeParse(wireOutput(results)).success).toBe(false);
  });

  it.each([0, false, ""])("passes a falsy scalar main_stuff through: %s", (main_stuff) => {
    const results = { pipeline_run_id: "run-1", main_stuff } as unknown as RunResults;
    expect(wireOutput(results)).toBe(main_stuff);
    expect(ImageLike.safeParse(wireOutput(results)).success).toBe(false);
  });
});

describe("wireListOutput", () => {
  // The two renderings of one ListContent the runtime sends, measured live on
  // 2026-09-05: `{ items }` from the blocking response and from a durable run
  // whose concept class the worker could hydrate; a bare array from a durable
  // run of a method-declared concept, which falls back to the transport dump.
  it("unwraps the { items: [...] } envelope", () => {
    const items = [{ url: "https://a", caption: null }, { url: "https://b" }];
    const results = { pipeline_run_id: "run-1", main_stuff: { items } } as unknown as RunResults;
    expect(wireListOutput(results)).toBe(items);
  });

  it("passes a bare array through", () => {
    const items = [{ url: "https://a" }, { url: "https://b" }];
    const results = { pipeline_run_id: "run-1", main_stuff: items } as unknown as RunResults;
    expect(wireListOutput(results)).toBe(items);
  });

  it("hands both shapes to the same array schema with the same verdict", () => {
    const schema = z.array(ImageLike);
    const items = [{ url: "https://a", caption: null }];
    const enveloped = { pipeline_run_id: "r", main_stuff: { items } } as unknown as RunResults;
    const bare = { pipeline_run_id: "r", main_stuff: items } as unknown as RunResults;
    expect(schema.parse(wireListOutput(enveloped))).toEqual(schema.parse(wireListOutput(bare)));
  });

  it("leaves anything else untouched so z.array() names what it got", () => {
    const single = {
      pipeline_run_id: "r",
      main_stuff: { url: "https://a" },
    } as unknown as RunResults;
    expect(wireListOutput(single)).toEqual({ url: "https://a" });
    expect(z.array(ImageLike).safeParse(wireListOutput(single)).success).toBe(false);

    // An `items` key that is not an array is a field, not the envelope.
    const notEnvelope = {
      pipeline_run_id: "r",
      main_stuff: { items: "x" },
    } as unknown as RunResults;
    expect(wireListOutput(notEnvelope)).toEqual({ items: "x" });
  });
});

describe("describeSchemaFailure", () => {
  it("renders a ZodError field-by-field rather than as a JSON issue dump", () => {
    const result = ImageLike.safeParse({ public_url: 12 });
    const message = describeSchemaFailure(result.error, "Image");
    expect(message).toContain("did not match Image");
    expect(message).toContain("public_url");
    expect(message).not.toContain('"code":');
  });

  it("passes a non-Zod error's message through unchanged", () => {
    expect(describeSchemaFailure(new Error("socket hang up"), "Image")).toBe("socket hang up");
    expect(describeSchemaFailure("plain string", "Image")).toBe("plain string");
  });
});
