import type { RunResults } from "@pipelex/sdk";
import { parseExtractionBrief } from "@/generated/complex-form/binder";
import { ExtractionBriefSchema, type ExtractionBrief } from "@/generated/complex-form/types";
import { describeSchemaFailure, wireOutput } from "@/lib/wireOutput";
import { BadPipelineOutputError } from "@/types/pipelineError";

/**
 * The shape is not written here — it is generated from
 * `methods/complex-form/main.mthds` by `npm run codegen`. Re-exported so the
 * rest of the app keeps importing its pipeline types from one place.
 */
export type { ExtractionBrief };

/**
 * Narrow a run's output into `ExtractionBrief` by handing `main_stuff` to the
 * generated binder. Throws `BadPipelineOutputError` on shape mismatch — this is
 * a system boundary (LLM output → typed app), so failures are real bugs we want
 * surfaced (the poll/blocking catch classifies them).
 */
export function parseExtractionBriefResult(results: RunResults): ExtractionBrief {
  try {
    return parseExtractionBrief(wireOutput(results, ExtractionBriefSchema));
  } catch (err) {
    throw new BadPipelineOutputError(describeSchemaFailure(err, "ExtractionBrief"));
  }
}
