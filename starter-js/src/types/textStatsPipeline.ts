// Scaffolded by `make add-method` — yours to edit from here on.
//
// The output shape is NOT written here: `npm run codegen` projects it from
// the method `methods/text-stats/method.json` names, and this module is the thin
// adapter over that projection. If you find yourself declaring fields, the
// method already declares them.

import type { RunResults } from "@pipelex/sdk";
import { parseText } from "@/generated/text-stats/binder";
import { TextSchema, type Text } from "@/generated/text-stats/types";
import { describeSchemaFailure, wireOutput } from "@/lib/wireOutput";
import { BadPipelineOutputError } from "@/types/pipelineError";

/** The pipe's output concept, re-exported under this slice's own name. */
export type TextStatsOutput = Text;

/**
 * Narrow a run's output into `TextStatsOutput` by handing `main_stuff` to the
 * generated binder. Throws `BadPipelineOutputError` on a shape mismatch — this is
 * a system boundary (model output → typed app), so a failure is a real bug we
 * want surfaced; the blocking/poll catch classifies it.
 */
export function parseTextStatsOutput(results: RunResults): TextStatsOutput {
  try {
    return parseText(wireOutput(results, TextSchema));
  } catch (err) {
    throw new BadPipelineOutputError(describeSchemaFailure(err, "Text"));
  }
}
