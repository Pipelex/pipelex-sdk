"use server";

import { PIPE_IO_CONTRACTS } from "@/generated/extract-entities/contracts";
import { loadMethodBundles } from "@/lib/loadBundle";
import { parseEntities, type ExtractedEntities } from "@/types/extractEntitiesPipeline";
import { executeBlockingRun, type BlockingOutcome } from "@/lib/blockingRun";
import {
  pollDurableRun,
  startDurableRun,
  type PollOutcome,
  type StartOutcome,
} from "@/lib/durableRun";
import { gateRunInputs, requireContract } from "@/lib/runInputs";
import type { StartOptions } from "@pipelex/sdk";

const PIPE_CODE = "extract_entities";
/**
 * What the run names the pipe by: the qualified `<domain>.<pipe_code>`, an exact
 * key. A bare code is searched for across every domain of the method, and
 * refused as ambiguous once two domains declare it.
 */
const PIPE_REF = "extract_entities.extract_entities";

// The same generated contract the browser rendered the form from. One gate, two
// call sites, zero drift — and the server's copy is the one that's trusted.
const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "extract_entities", PIPE_CODE);

/** SDK options shared by both paths — `execute` and `start` take the same shape. */
async function buildOptions(inputs: Record<string, unknown>): Promise<StartOptions> {
  return {
    pipe_code: PIPE_REF,
    mthds_contents: await loadMethodBundles("extract-entities"),
    inputs,
  };
}

/**
 * BLOCKING path: run the extract-entities pipeline synchronously (`POST /v1/execute`).
 * Behind the hosted gateway this is cut off at ~30s — fine for short text, but
 * flip the example to Durable mode to survive long runs. Returns a structured
 * outcome (never throws across the server→client boundary).
 */
export async function runExtractEntitiesBlocking(
  data: Record<string, unknown>,
): Promise<BlockingOutcome<ExtractedEntities>> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return executeBlockingRun(() => buildOptions(gated.inputs), parseEntities);
}

/** DURABLE path — start the run (`POST /v1/start`) and return its id to poll. */
export async function startExtractEntitiesRun(
  data: Record<string, unknown>,
): Promise<StartOutcome> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return startDurableRun(() => buildOptions(gated.inputs));
}

/** DURABLE path — poll one tick of a started run by id. */
export async function pollExtractEntitiesRun(
  runId: string,
): Promise<PollOutcome<ExtractedEntities>> {
  return pollDurableRun(runId, parseEntities);
}
