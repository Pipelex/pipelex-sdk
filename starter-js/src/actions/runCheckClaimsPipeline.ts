"use server";

import { loadMethodBundles } from "@/lib/loadBundle";
import { PIPE_IO_CONTRACTS } from "@/generated/check-claims/contracts";
import { parseCheckClaimsOutput, type CheckClaimsOutput } from "@/types/checkClaimsPipeline";
import { executeBlockingRun, type BlockingOutcome } from "@/lib/blockingRun";
import {
  pollDurableRun,
  startDurableRun,
  type PollOutcome,
  type StartOutcome,
} from "@/lib/durableRun";
import { gateRunInputs, requireContract } from "@/lib/runInputs";
import type { PipelexStartOptions } from "@pipelex/sdk";

// Scaffolded by `make add-method` — yours to edit from here on.
//
// The method's bundle is every `.mthds` file under
// `methods/check-claims/`, read at request time rather than copied
// here, so the run always sends the bundle the generated tree was projected
// from: edit the files, then run `npm run codegen`.
const METHOD_DIR = "check-claims";
const PIPE_CODE = "check_claims";
/**
 * What the run names the pipe by: the qualified `<domain>.<pipe_code>`, an exact
 * key. A bare code is searched for across every domain of the method, and
 * refused as ambiguous once two domains declare it.
 */
const PIPE_REF = "check_claims.check_claims";

// The same generated contract the browser rendered the form from. One gate, two
// call sites, zero drift — and the server's copy is the one that's trusted.
const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "check_claims", PIPE_CODE);

/**
 * SDK options shared by both paths — `execute` and `start` take the same shape.
 *
 * The bundle travels inline as `mthds_contents`, every file of it, in the
 * order `npm run codegen` read them.
 */
async function buildOptions(inputs: Record<string, unknown>): Promise<PipelexStartOptions> {
  return {
    mthds_contents: await loadMethodBundles(METHOD_DIR),
    pipe_code: PIPE_REF,
    inputs,
  };
}

/**
 * BLOCKING path (`POST /v1/execute`). Behind the hosted gateway a synchronous run
 * is cut off at ~30s; switch to Durable mode to survive a long one.
 */
export async function runCheckClaimsBlocking(
  data: Record<string, unknown>,
): Promise<BlockingOutcome<CheckClaimsOutput>> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return executeBlockingRun(() => buildOptions(gated.inputs), parseCheckClaimsOutput);
}

/** DURABLE path — start the run (`POST /v1/start`) and return its id to poll. */
export async function startCheckClaimsRun(data: Record<string, unknown>): Promise<StartOutcome> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return startDurableRun(() => buildOptions(gated.inputs));
}

/** DURABLE path — poll one tick of a started run by id. */
export async function pollCheckClaimsRun(runId: string): Promise<PollOutcome<CheckClaimsOutput>> {
  return pollDurableRun(runId, parseCheckClaimsOutput);
}
