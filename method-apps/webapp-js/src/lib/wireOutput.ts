// Build-time boundary guard: a consumer importing a `parseXxx` narrower from a
// "use client" component gets a Next build error instead of silently shipping
// zod plus every generated schema to the browser. (Unit tests alias this to a
// stub — see vitest.server-only-stub.ts.)
import "server-only";

import { z } from "zod";
import type { RunResults } from "@pipelex/sdk";

/**
 * The adapters every `parseXxx()` narrower needs between a run's wire output and
 * a generated zod binder. There is no shape-checking here on purpose: the
 * generated `Schema.parse` does all of it, rejecting arrays, primitives and
 * `null` with far better messages than a hand-rolled predicate.
 *
 * Both paths deliver the main output the same way — `RunResults.main_stuff` is
 * the single main output's *content* directly (not a `{ concept, content }`
 * wrapper, not a working-memory map). The SDK resolves it out of the working
 * memory on the blocking `execute` path too, so there is one shape to read.
 *
 * The runtime serializes an unset optional concept field as an explicit `null`,
 * and the ts-zod projection emits such a field as `.nullish()`, so the generated
 * schema accepts the runtime's own payload unaided — nothing here normalizes
 * values for a single output.
 */

/** A JSON object — not an array, not null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The wire payload a narrower should hand to its generated binder: the run's main output. */
export function wireOutput(results: RunResults): unknown {
  return results.main_stuff;
}

/**
 * The wire payload a narrower for a **plural** output should hand to
 * `z.array(<Code>Schema)`: the run's main output as the array it is.
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
 *   which is every concept a method declares itself.
 *
 * So one method answers `{ items }` in Blocking mode and a bare array in
 * Durable mode, and this accepts both until the runtime settles on one. The
 * unwrap is confined to the top level and to this function, which only a plural
 * output's narrower calls: at that position the value is a `ListContent`, and
 * `{ items }` cannot be anything else. It validates nothing: a payload that is
 * neither shape passes through untouched for `z.array(...)` to reject with a
 * message naming what it got.
 */
export function wireListOutput(results: RunResults): unknown {
  const wire = results.main_stuff;
  return isPlainObject(wire) && Array.isArray(wire.items) ? wire.items : wire;
}

/**
 * Render a binder failure as a message for `BadPipelineOutputError`. A
 * `ZodError`'s own `.message` is a JSON dump of its issue array;
 * `z.prettifyError` turns it into the field-by-field list a developer can act
 * on, which is what `<ErrorDisplay>` shows under "Details".
 */
export function describeSchemaFailure(err: unknown, typeName: string): string {
  if (err instanceof z.ZodError) {
    return `The run output did not match ${typeName}:\n${z.prettifyError(err)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
