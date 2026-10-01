import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { RunResults } from "@pipelex/sdk";
import {
  describeSchemaFailure,
  dropWireNulls,
  MAX_WIRE_DEPTH,
  wireListOutput,
  wireOutput,
} from "./wireOutput";
import { ImageSchema } from "@/generated/generate-image/types";

/**
 * What the ts-zod emitter projected a non-required concept field as before
 * pipelex 0.54.0: `.optional()`, which in zod means `| undefined` and *rejects*
 * `null`. That is the mismatch `dropWireNulls` exists to bridge, and it has to
 * be built by hand now: the committed schemas are `.nullish()` since the trees
 * were regenerated on engine 0.56.0 (the pair of tests below records both
 * halves of that). The helper stays because an older engine is still what some
 * deployments serve, and regenerating against one brings `.optional()` back.
 */
const LEGACY_IMAGE = z.object({
  url: z.string(),
  public_url: z.string().optional(),
  caption: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});

describe("dropWireNulls", () => {
  it("drops a null on an .optional() field so it reads as absent", () => {
    expect(dropWireNulls({ url: "https://x", caption: null }, LEGACY_IMAGE)).toEqual({
      url: "https://x",
    });
  });

  it("keeps every non-null value, including falsy ones", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number(),
      c: z.boolean(),
      d: z.array(z.string()),
    });
    expect(dropWireNulls({ a: "", b: 0, c: false, d: [] }, schema)).toEqual({
      a: "",
      b: 0,
      c: false,
      d: [],
    });
  });

  it("recurses into declared nested objects and through arrays of them", () => {
    const inner = z.object({ inner: z.string().optional(), kept: z.number() });
    const schema = z.object({
      outer: inner,
      list: z.array(z.object({ x: z.string().optional(), y: z.number() })),
    });
    expect(
      dropWireNulls({ outer: { inner: null, kept: 1 }, list: [{ x: null, y: 2 }] }, schema),
    ).toEqual({ outer: { kept: 1 }, list: [{ y: 2 }] });
  });

  it("leaves a null list *item* alone — only object keys are optional on the wire", () => {
    const schema = z.object({ items: z.array(z.number().nullable()) });
    expect(dropWireNulls({ items: [1, null, 3] }, schema)).toEqual({ items: [1, null, 3] });
  });

  it("passes a non-object through untouched, so a bad payload still fails the schema", () => {
    expect(dropWireNulls(null, ImageSchema)).toBeNull();
    expect(dropWireNulls("text", ImageSchema)).toBe("text");
    expect(dropWireNulls(7, ImageSchema)).toBe(7);
  });

  it("is what lets an .optional() schema accept the runtime's own wire payload", () => {
    // The regression this whole helper exists for: the hosted runtime emits
    // `"caption": null` for an unset optional field, and `.optional()` rejects
    // null. Without the normalization the schema rejects a perfectly good run.
    const wire = { url: "https://x/y.png", caption: null, width: null, height: null };
    expect(LEGACY_IMAGE.safeParse(wire).success).toBe(false);
    expect(LEGACY_IMAGE.safeParse(dropWireNulls(wire, LEGACY_IMAGE)).success).toBe(true);
  });

  it("is a no-op against today's generated schema, which accepts the null itself", () => {
    // The workaround's expiry condition, recorded rather than assumed: the
    // emitter projects a non-required field as `.nullish()` since pipelex
    // 0.54.0, so the schema accepts the runtime's own payload unaided and the
    // strip has nothing to do. Deleting the helper waits until no engine this
    // template can be regenerated against still emits `.optional()`.
    const wire = { url: "https://x/y.png", caption: null, width: null, height: null };
    expect(ImageSchema.safeParse(wire).success).toBe(true);
    expect(dropWireNulls(wire, ImageSchema)).toEqual(wire);
  });

  // The reason the walk is schema-guided rather than blind. Inside these shapes a
  // `null` is data, and a blind deep strip would delete it before the schema —
  // silently, with a green check.
  it("never strips a null inside a z.record() — the keys there are data", () => {
    const schema = z.object({ meta: z.record(z.string(), z.unknown()) });
    expect(dropWireNulls({ meta: { discount: null, tax: 0 } }, schema)).toEqual({
      meta: { discount: null, tax: 0 },
    });
  });

  it("never strips a null inside an opaque z.unknown() field", () => {
    const schema = z.object({ blob: z.unknown() });
    expect(dropWireNulls({ blob: { a: null, b: 1 } }, schema)).toEqual({ blob: { a: null, b: 1 } });
  });

  it("keeps a null on a .nullable() field, which declares null a legal value", () => {
    const schema = z.object({ note: z.string().nullable() });
    expect(dropWireNulls({ note: null }, schema)).toEqual({ note: null });
  });

  it("keeps a null on a .default() field rather than inventing the default", () => {
    const schema = z.object({ n: z.number().default(3) });
    expect(dropWireNulls({ n: null }, schema)).toEqual({ n: null });
  });

  it("leaves an undeclared key alone — Schema.parse is what strips it", () => {
    const schema = z.object({ url: z.string() });
    expect(dropWireNulls({ url: "https://x", extra: null }, schema)).toEqual({
      url: "https://x",
      extra: null,
    });
  });
});

describe("wireOutput", () => {
  it("reads main_stuff and normalizes it in one step", () => {
    const results: RunResults = {
      pipeline_run_id: "run-1",
      main_stuff: { url: "https://x", caption: null },
    };
    expect(wireOutput(results, LEGACY_IMAGE)).toEqual({ url: "https://x" });
  });

  it("reads only main_stuff — a matching pipe_output entry must not rescue it", () => {
    const results = {
      pipeline_run_id: "run-1",
      main_stuff: { caption: "no url here" },
      pipe_output: { working_memory: { root: { e: { content: { url: "https://ignored" } } } } },
    } as unknown as RunResults;
    expect(wireOutput(results, ImageSchema)).toEqual({ caption: "no url here" });
  });

  it.each([0, false, ""])("passes a falsy scalar main_stuff through: %s", (main_stuff) => {
    const results = { pipeline_run_id: "run-1", main_stuff } as unknown as RunResults;
    expect(wireOutput(results, ImageSchema)).toBe(main_stuff);
    expect(ImageSchema.safeParse(wireOutput(results, ImageSchema)).success).toBe(false);
  });
});

describe("wireListOutput", () => {
  // The two renderings of one ListContent the runtime sends, measured live on
  // 2026-09-05: `{ items }` from the blocking response and from a durable run
  // whose concept class the worker could hydrate; a bare array from a durable
  // run of a method-declared concept, which falls back to the transport dump.
  it("unwraps the { items: [...] } envelope and normalizes each item", () => {
    const results = {
      pipeline_run_id: "run-1",
      main_stuff: { items: [{ url: "https://a", caption: null }, { url: "https://b" }] },
    } as unknown as RunResults;
    expect(wireListOutput(results, LEGACY_IMAGE)).toEqual([
      { url: "https://a" },
      { url: "https://b" },
    ]);
  });

  it("passes a bare array through, normalizing each item the same way", () => {
    const results = {
      pipeline_run_id: "run-1",
      main_stuff: [{ url: "https://a", caption: null }, { url: "https://b" }],
    } as unknown as RunResults;
    expect(wireListOutput(results, LEGACY_IMAGE)).toEqual([
      { url: "https://a" },
      { url: "https://b" },
    ]);
  });

  it("hands both shapes to the same array schema with the same verdict", () => {
    const schema = z.array(ImageSchema);
    const items = [{ url: "https://a" }];
    const enveloped = { pipeline_run_id: "r", main_stuff: { items } } as unknown as RunResults;
    const bare = { pipeline_run_id: "r", main_stuff: items } as unknown as RunResults;
    expect(schema.parse(wireListOutput(enveloped, ImageSchema))).toEqual(
      schema.parse(wireListOutput(bare, ImageSchema)),
    );
  });

  it("leaves anything else untouched so z.array() names what it got", () => {
    const single = {
      pipeline_run_id: "r",
      main_stuff: { url: "https://a" },
    } as unknown as RunResults;
    expect(wireListOutput(single, ImageSchema)).toEqual({ url: "https://a" });
    expect(z.array(ImageSchema).safeParse(wireListOutput(single, ImageSchema)).success).toBe(false);

    // An `items` key that is not an array is a field, not the envelope.
    const notEnvelope = {
      pipeline_run_id: "r",
      main_stuff: { items: "x" },
    } as unknown as RunResults;
    expect(wireListOutput(notEnvelope, ImageSchema)).toEqual({ items: "x" });
  });
});

describe("describeSchemaFailure", () => {
  it("renders a ZodError field-by-field rather than as a JSON issue dump", () => {
    const result = ImageSchema.safeParse({ public_url: 12 });
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

describe("dropWireNulls recursion depth", () => {
  // A self-referential concept — `z.lazy()` is how a concept reference projects,
  // and the walk resolves it, so the schema stops bounding the descent and the
  // payload starts driving it.
  interface Node {
    label: string;
    caption?: string;
    child?: Node;
  }
  const NodeSchema: z.ZodType<Node> = z.lazy(() =>
    z.object({
      label: z.string(),
      caption: z.string().optional(),
      child: NodeSchema.optional(),
    }),
  );

  /** A chain `depth` levels deep, every level carrying a `null` caption. */
  function chain(depth: number): Record<string, unknown> {
    let node: Record<string, unknown> = { label: "leaf", caption: null };
    for (let i = 0; i < depth; i += 1) {
      node = { label: `n${i}`, caption: null, child: node };
    }
    return node;
  }

  it("strips nulls through a recursive concept, below the cap", () => {
    const result = dropWireNulls(chain(3), NodeSchema) as Record<string, unknown>;
    expect(NodeSchema.safeParse(result).success).toBe(true);
    expect(result).not.toHaveProperty("caption");
  });

  it("returns the value untouched past the cap instead of recursing forever", () => {
    // The generated schema still owns the verdict — this only stops the walk.
    const deep = chain(MAX_WIRE_DEPTH + 10);
    expect(() => dropWireNulls(deep, NodeSchema)).not.toThrow();
  });

  it("survives a pathologically deep payload without overflowing the stack", () => {
    expect(() => dropWireNulls(chain(50_000), NodeSchema)).not.toThrow();
  });
});
