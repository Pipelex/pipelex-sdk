import type { RunResults } from "@pipelex/sdk";
import { parseExtractedEntities } from "@/generated/extract-entities/binder";
import {
  ExtractedEntitiesSchema,
  type ExtractedEntities,
} from "@/generated/extract-entities/types";
import { describeSchemaFailure, wireOutput } from "@/lib/wireOutput";
import { BadPipelineOutputError } from "@/types/pipelineError";

/**
 * The shape is not written here — it is generated from
 * `methods/extract-entities/main.mthds` by `npm run codegen`. Re-exported so
 * the rest of the app keeps importing its pipeline types from one place.
 */
export type { ExtractedEntities };

/**
 * Narrow a run's output into `ExtractedEntities` by handing `main_stuff` to the
 * generated binder. Throws `BadPipelineOutputError` on shape mismatch — this is
 * a system boundary (LLM output → typed app), so failures are real bugs we want
 * surfaced (the poll/blocking catch classifies them).
 */
export function parseEntities(results: RunResults): ExtractedEntities {
  try {
    return parseExtractedEntities(wireOutput(results, ExtractedEntitiesSchema));
  } catch (err) {
    throw new BadPipelineOutputError(describeSchemaFailure(err, "ExtractedEntities"));
  }
}
