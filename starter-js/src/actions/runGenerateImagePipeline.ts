"use server";

import { PIPE_IO_CONTRACTS } from "@/generated/generate-image/contracts";
import { loadMethodBundles } from "@/lib/loadBundle";
import { parseGeneratedImage, type GeneratedImage } from "@/types/generateImagePipeline";
import { executeBlockingRun, type BlockingOutcome } from "@/lib/blockingRun";
import {
  pollDurableRun,
  startDurableRun,
  type PollOutcome,
  type StartOutcome,
} from "@/lib/durableRun";
import { gateRunInputs, requireContract } from "@/lib/runInputs";
import type { StartOptions } from "@pipelex/sdk";

const PIPE_CODE = "generate_image";
/**
 * What the run names the pipe by: the qualified `<domain>.<pipe_code>`, an exact
 * key. A bare code is searched for across every domain of the method, and
 * refused as ambiguous once two domains declare it.
 */
const PIPE_REF = "generate_image.generate_image";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "generate_image", PIPE_CODE);

async function buildOptions(inputs: Record<string, unknown>): Promise<StartOptions> {
  return {
    pipe_code: PIPE_REF,
    mthds_contents: await loadMethodBundles("generate-image"),
    inputs,
  };
}

/**
 * BLOCKING path: generate an image synchronously (`POST /v1/execute`). Image
 * generation routinely outlives the hosted gateway's ~30s cap, so this is the
 * example that best demonstrates `execute_timeout` — flip to Durable mode to
 * actually get an image.
 */
export async function runGenerateImageBlocking(
  data: Record<string, unknown>,
): Promise<BlockingOutcome<GeneratedImage>> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return executeBlockingRun(() => buildOptions(gated.inputs), parseGeneratedImage);
}

/** DURABLE path — start the image run and return its id to poll. */
export async function startGenerateImageRun(data: Record<string, unknown>): Promise<StartOutcome> {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  return startDurableRun(() => buildOptions(gated.inputs));
}

/** DURABLE path — poll one tick of a started image run by id. */
export async function pollGenerateImageRun(runId: string): Promise<PollOutcome<GeneratedImage>> {
  return pollDurableRun(runId, parseGeneratedImage);
}
