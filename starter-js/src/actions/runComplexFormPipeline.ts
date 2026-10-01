"use server";

import { PIPE_IO_CONTRACTS } from "@/generated/complex-form/contracts";
import { loadMethodBundles } from "@/lib/loadBundle";
import { parseExtractionBriefResult, type ExtractionBrief } from "@/types/complexFormPipeline";
import { executeBlockingRun, type BlockingOutcome } from "@/lib/blockingRun";
import {
  pollDurableRun,
  startDurableRun,
  type PollOutcome,
  type StartOutcome,
} from "@/lib/durableRun";
import { gateRunInputs, requireContract } from "@/lib/runInputs";
import type { StartOptions } from "@pipelex/sdk";

const PIPE_CODE = "extract_brief";
/**
 * What the run names the pipe by: the qualified `<domain>.<pipe_code>`, an exact
 * key. A bare code is searched for across every domain of the method, and
 * refused as ambiguous once two domains declare it.
 */
const PIPE_REF = "complex_form.extract_brief";

// The same generated contract the browser rendered the form from. One gate, two
// call sites, zero drift — and the server's copy is the one that's trusted.
// Nothing below names an input: this method has an optional structured input
// and a plural one, and the gate applies both rules from the contract alone.
const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "complex_form", PIPE_CODE);

/** SDK options shared by both paths — `execute` and `start` take the same shape. */
async function buildOptions(inputs: Record<string, unknown>): Promise<StartOptions> {
  return {
    pipe_code: PIPE_REF,
    mthds_contents: await loadMethodBundles("complex-form"),
    inputs,
  };
}

/**
 * BLOCKING path: run the complex-form pipeline synchronously (`POST /v1/execute`).
 * Behind the hosted gateway this is cut off at ~30s. Returns a structured
 * outcome (never throws across the server→client boundary).
 */
export async function runComplexFormBlocking(
  data: Record<string, unknown>,
): Promise<BlockingOutcome<ExtractionBrief>> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return executeBlockingRun(() => buildOptions(gated.inputs), parseExtractionBriefResult);
}

/** DURABLE path — start the run (`POST /v1/start`) and return its id to poll. */
export async function startComplexFormRun(data: Record<string, unknown>): Promise<StartOutcome> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return startDurableRun(() => buildOptions(gated.inputs));
}

/** DURABLE path — poll one tick of a started run by id. */
export async function pollComplexFormRun(runId: string): Promise<PollOutcome<ExtractionBrief>> {
  return pollDurableRun(runId, parseExtractionBriefResult);
}
