import type { RunResults } from "@pipelex/sdk";
import { parseDocumentSummary as parseDocumentSummaryWire } from "@/generated/summarize-pdf/binder";
import { DocumentSummarySchema, type DocumentSummary } from "@/generated/summarize-pdf/types";
import { describeSchemaFailure, wireOutput } from "@/lib/wireOutput";
import { BadPipelineOutputError } from "@/types/pipelineError";

/**
 * Generated from `methods/summarize-pdf/main.mthds` by `npm run codegen`. The
 * field names are the bundle's own — `doc_type`, `key_points` — and stay
 * snake_case all the way to the components: a camelCase mapping layer would be
 * exactly the hand-written duplicate of the bundle that codegen removes.
 */
export type { DocumentSummary };

/**
 * Narrow a run's output into `DocumentSummary` via the generated binder. Throws
 * `BadPipelineOutputError` on shape mismatch — a system boundary (model output
 * → typed app).
 */
export function parseDocumentSummary(results: RunResults): DocumentSummary {
  try {
    return parseDocumentSummaryWire(wireOutput(results, DocumentSummarySchema));
  } catch (err) {
    throw new BadPipelineOutputError(describeSchemaFailure(err, "DocumentSummary"));
  }
}
