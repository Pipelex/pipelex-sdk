// Build-time boundary guard: a consumer importing a `parseXxx` narrower from a
// "use client" component gets a Next build error instead of silently shipping
// zod plus every generated schema to the browser. (Unit tests alias this to a
// stub — see vitest.server-only-stub.ts.)
import "server-only";

import { z } from "zod";
import type { RunResults } from "@pipelex/sdk";

/**
 * The two adapters every `parseXxx()` narrower needs between a run's wire
 * output and a generated zod binder. There is no shape-checking here on
 * purpose: the generated `Schema.parse` does all of it, rejecting arrays,
 * primitives and `null` with far better messages than a hand-rolled predicate.
 *
 * Both paths deliver the main output the same way — `RunResults.main_stuff` is
 * the single main output's *content* directly (not a `{ concept, content }`
 * wrapper, not a working-memory map). The SDK resolves it out of the working
 * memory on the blocking `execute` path too, so there is one shape to read.
 */

/**
 * Peel `.optional()` / `.nullable()` / `.default()` / `.readonly()` wrappers off a
 * field and report what was underneath, so the caller can tell "may be absent"
 * from "has a value to invent".
 */
function unwrap(schema: z.ZodType): { core: z.ZodType; hasFallback: boolean } {
  let core = schema;
  let hasFallback = false;
  // The wrapper chain is finite, but guard anyway: a hand-built schema could nest
  // these arbitrarily and a malformed one must not hang a Server Action.
  for (let depth = 0; depth < 32; depth += 1) {
    const def = core.def as { type: string; innerType?: z.ZodType; getter?: () => z.ZodType };
    if (def.type === "default" || def.type === "prefault" || def.type === "catch") {
      hasFallback = true;
    }
    if (def.type === "lazy" && def.getter) {
      // Concept references project as `z.lazy(() => XSchema)`, so resolving one
      // is how the walk sees through to the referenced concept's shape. It also
      // makes descent payload-driven again — a self-referential concept has an
      // unbounded schema — which is why `dropWireNulls` carries a depth cap.
      core = def.getter();
      continue;
    }
    if (def.innerType === undefined) break;
    core = def.innerType;
  }
  return { core, hasFallback };
}

/**
 * Whether a wire `null` on this field means "unset" — i.e. the field accepts
 * `undefined` and rejects `null`, and has no default that dropping would invent.
 *
 * Asked of the schema rather than pattern-matched on it, so `.nullish()`,
 * `.nullable()` and `.default(v)` all answer correctly without this file
 * enumerating zod's wrapper vocabulary.
 */
function nullMeansAbsent(field: z.ZodType): boolean {
  if (unwrap(field).hasFallback) return false;
  return field.safeParse(undefined).success && !field.safeParse(null).success;
}

/**
 * Turn the wire's explicit `null`s back into absence, but only where the schema
 * says absence is what `null` meant.
 *
 * Pipelex concepts are pydantic models, and an unset optional field is `None`
 * that the runtime serializes as an explicit `"caption": null` rather than
 * omitting the key. Confirmed live against api-dev: the `main_stuff` of a
 * hosted `PipeImgGen` run carries `source_negative_prompt`, `caption` and
 * `filename` as `null`. The ts-zod projection models the same field as
 * `.optional()` — which means `| undefined` and *rejects* `null` — so without
 * this step `parseImage` throws on every real image run.
 *
 * **The walk is schema-guided, and that is the whole point.** An earlier version
 * stripped every null-valued key at every depth, which is precisely the "blind
 * deep key transform" the ts-zod emitter's own design note rules out: inside a
 * `z.record()` or a `z.unknown()` a `null` is *data*, and a blind strip deletes
 * it before the schema can object — silently, with a green check. So descent
 * follows declared shapes only: object fields are considered individually,
 * arrays and record *values* are descended for their declared element type, and
 * anything opaque (`z.unknown()`, `z.any()`, a union) is passed through
 * untouched. A field carrying `.default(v)` is passed through too, because
 * dropping the key there would substitute the default for a `null` the pipeline
 * actually sent.
 *
 * Descent is depth-capped. Resolving `z.lazy()` lets a self-referential concept
 * (a tree node whose children are tree nodes) describe an unbounded shape, so
 * depth follows the payload — and this runs inside a Server Action on
 * attacker-influenceable pipeline output, where a stack overflow is a crash
 * rather than an error. Past the cap the value is returned untouched: the
 * generated schema still owns the verdict, and a payload that deep will fail
 * it on its own terms with a message naming the field.
 *
 * It exists only until the emitter projects a non-required field as
 * `.nullish()` (or the transport dump stops serializing unset fields) —
 * reported upstream to pipelex; see docs/codegen.md for the evidence trail.
 */
export const MAX_WIRE_DEPTH = 64;

export function dropWireNulls(value: unknown, schema: z.ZodType, depth = 0): unknown {
  if (depth >= MAX_WIRE_DEPTH) return value;
  const { core } = unwrap(schema);
  const def = core.def as {
    type: string;
    shape?: Record<string, z.ZodType>;
    element?: z.ZodType;
    valueType?: z.ZodType;
  };

  if (def.type === "array" && def.element && Array.isArray(value)) {
    // A null list *item* is data, never absence — only object keys are optional
    // on the wire — so items are descended, never dropped.
    return value.map((item) => dropWireNulls(item, def.element as z.ZodType, depth + 1));
  }

  if (!isPlainObject(value)) return value;

  if (def.type === "record" && def.valueType) {
    // Keys are data here, so none are removed; values are still normalized in
    // case the record's declared value type is itself a concept.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        dropWireNulls(item, def.valueType as z.ZodType, depth + 1),
      ]),
    );
  }

  if (def.type !== "object" || !def.shape) return value;
  const shape = def.shape;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const field = shape[key];
    // An undeclared key is not ours to reshape — `Schema.parse` strips it.
    if (field === undefined) {
      out[key] = item;
      continue;
    }
    if (item === null) {
      if (nullMeansAbsent(field)) continue;
      out[key] = item;
      continue;
    }
    out[key] = dropWireNulls(item, field, depth + 1);
  }
  return out;
}

/** A JSON object — not an array, not null. Arrays are handled by their own branch. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The wire payload a narrower should hand to its generated binder: the run's
 * main output, with the wire's `null`s normalized away per `schema`.
 */
export function wireOutput(results: RunResults, schema: z.ZodType): unknown {
  return dropWireNulls(results.main_stuff, schema);
}

/**
 * The wire payload a narrower for a **plural** output should hand to
 * `z.array(<Code>Schema)`: the run's main output as the array it is, with the
 * wire's `null`s normalized away per `elementSchema` for every item.
 *
 * A plural output is one `ListContent` in the runtime, and the runtime renders
 * it two ways — **which one depends on the execution path and on whether the
 * deliverer could hydrate the concept's class, not on the method** (measured
 * live against api-dev, engine 0.56.0, on 2026-09-05):
 *
 * - `{ "items": [ … ] }` — the pydantic dump of `ListContent`. The blocking
 *   `execute` response carries it (its working memory is hydrated before it
 *   is serialized), and so does the durable `main_stuff.json` when the worker
 *   knows the concept's class — a native concept such as `native.Page`.
 * - `[ … ]` — the transport dump, which serializes a `ListContent` as a plain
 *   list. The durable `main_stuff.json` carries it when the worker could NOT
 *   hydrate the concept's class and fell back to the raw working memory —
 *   which is every concept a method declares itself (`CandidateMatch`, …).
 *
 * So one method answers `{ items }` in Blocking mode and a bare array in
 * Durable mode. Reported upstream to pipelex as L-260905-403fb6 (the fork is
 * the delivery executor's hydrated-vs-raw render); this accepts both until the
 * runtime settles on one. The unwrap is confined to the top level and to this
 * function, which only a plural output's narrower calls: at that position the
 * value is a `ListContent`, and `{ items }` cannot be anything else. It
 * normalizes values, never names — no field is re-declared here — and it
 * validates nothing: a payload that is neither shape passes through untouched
 * for `z.array(...)` to reject with a message naming what it got.
 */
export function wireListOutput(results: RunResults, elementSchema: z.ZodType): unknown {
  const wire = results.main_stuff;
  const list = isPlainObject(wire) && Array.isArray(wire.items) ? wire.items : wire;
  return dropWireNulls(list, z.array(elementSchema));
}

/**
 * Render a binder failure as a message for `BadPipelineOutputError` /
 * `BadImageOutputError`. A `ZodError`'s own `.message` is a JSON dump of its
 * issue array; `z.prettifyError` turns it into the field-by-field list a
 * developer can act on, which is what `<ErrorDisplay>` shows under "Details".
 */
export function describeSchemaFailure(err: unknown, typeName: string): string {
  if (err instanceof z.ZodError) {
    return `The run output did not match ${typeName}:\n${z.prettifyError(err)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
