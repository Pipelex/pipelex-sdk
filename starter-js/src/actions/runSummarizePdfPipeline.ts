"use server";

import { getPipelexClient } from "@/lib/pipelexClient";
import { loadMethodBundles } from "@/lib/loadBundle";
import { MAX_FILE_BYTES, checkFileInputs, type UploadRequest } from "@/lib/fileInputs";
import { parseDocumentSummary, type DocumentSummary } from "@/types/summarizePipeline";
import { executeBlockingRun, type BlockingOutcome } from "@/lib/blockingRun";
import {
  pollDurableRun,
  startDurableRun,
  type PollOutcome,
  type StartOutcome,
} from "@/lib/durableRun";
import { gateRunInputs, requireContract, requireInputForm } from "@/lib/runInputs";
import { INPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/summarize-pdf/contracts";
import { grantFileUpload, type GrantOutcome } from "@/lib/uploadGrant";
import type { PipelineError } from "@/lib/errors";
import { ALLOWED_MIMES } from "@/types/summarizePdfUploads";
import type { StartOptions } from "@pipelex/sdk";

const PIPE_CODE = "summarize_pdf";
/**
 * What `prepareInputs` and the run name the pipe by: the qualified
 * `<domain>.<pipe_code>`, an exact key. `prepareInputs` refuses a bare code, and
 * the run searches every domain of the method for one, refusing it as ambiguous
 * once two domains declare it.
 */
const PIPE_REF = "summarize_pdf.summarize_pdf";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "summarize_pdf", PIPE_CODE);
// The file gate walks the same wire descriptor the browser rendered the form
// from, and the SDK's `prepareInputs` resolves file positions by — so the three
// agree on where the files are.
const DESCRIPTOR = requireInputForm(INPUT_FORM, "summarize_pdf", PIPE_CODE);

/**
 * Shape gate, then file gate, in that order. Shared by both execution paths.
 *
 * The kernel gate proves the shape a contract can declare; `checkFileInputs`
 * proves what it cannot — that the `url` at every file position the descriptor
 * declares is a reference we accept. The browser stored the PDF before the run,
 * so a run carries a reference and never bytes. The check is the
 * security-relevant one: `prepareInputs` reads an unrecognised string as a local
 * filesystem path, and a Server Action is a public endpoint. See its docstring.
 */
function gatePdfInputs(
  data: Record<string, unknown>,
): { ok: true; inputs: Record<string, unknown> } | { ok: false; error: PipelineError } {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated;
  const error = checkFileInputs(DESCRIPTOR, gated.inputs);
  return error ? { ok: false, error } : gated;
}

/**
 * UPLOAD — a grant for the browser to store one dropped PDF straight in Pipelex
 * storage, before any run. Only the file's name, type and size reach this
 * action, never its bytes; it refuses a type outside `ALLOWED_MIMES` and a size
 * past `MAX_FILE_BYTES`, then asks the platform for a create-only `PUT` signed
 * for exactly that file. `PdfForm`'s `useFileInputs` sends the file with it and
 * keeps the `pipelex-storage://` reference the run then carries.
 *
 * It is open to anyone who can reach the app, like the run actions: see
 * `grantFileUpload` in `src/lib/uploadGrant.ts`.
 */
export async function requestSummarizePdfUpload(request: UploadRequest): Promise<GrantOutcome> {
  return grantFileUpload(request, { allowedMimes: ALLOWED_MIMES, maxBytes: MAX_FILE_BYTES });
}

/**
 * Build the run options through the SDK's signature-driven `prepareInputs`
 * instead of hand-rolling a `Document` envelope.
 *
 * `prepareInputs` reads the method's declared signature (`document` is a
 * `Document` input) and shapes the file position as the run expects it. The PDF
 * itself is already in Pipelex storage — the browser stored it with a grant from
 * `requestSummarizePdfUpload` — so the `pipelex-storage://` reference at
 * `document` passes through untouched, and the run request carries that
 * reference, never the bytes. It takes the kernel's explicit `{concept, content}`
 * envelope as readily as a bare value — verified live against the hosted API —
 * and preserves the envelope on output, so the gate's payload goes straight in.
 * `pipe_ref` names the pipe rather than leaving it to the closure's `main_pipe`.
 * Since SDK 0.19.0 a validation report stating `default_pipe_ref: null` is the
 * server saying it determined no entry pipe, and preparation refuses there
 * instead of falling back — so the ref is stated, exactly as `make add-method`
 * scaffolds it, and the run is sent the same ref.
 *
 * On failure `prepareInputs` throws *before any run starts* (a typed
 * `InputPreparationError` — see `classifyInputPreparationError`). Because this
 * closure runs inside `executeBlockingRun` / `startDurableRun`'s try/catch, that
 * error is classified like any other SDK error — no new try/catch here. On the
 * durable path the preparation happens once, at start; `poll` never rebuilds
 * options.
 */
async function buildOptions(inputs: Record<string, unknown>): Promise<StartOptions> {
  const bundles = await loadMethodBundles("summarize-pdf");
  const prepared = await getPipelexClient().prepareInputs({
    files: bundles.map((content) => ({ content })),
    pipe_ref: PIPE_REF,
    inputs,
  });
  return { pipe_code: PIPE_REF, mthds_contents: bundles, inputs: prepared.inputs };
}

/** BLOCKING path: summarize a stored PDF synchronously (`POST /v1/execute`). */
export async function runSummarizePdfBlocking(
  data: Record<string, unknown>,
): Promise<BlockingOutcome<DocumentSummary>> {
  const gated = gatePdfInputs(data);
  if (!gated.ok) return gated;
  return executeBlockingRun(() => buildOptions(gated.inputs), parseDocumentSummary);
}

/** DURABLE path — start the summarize run and return its id to poll. */
export async function startSummarizePdfRun(data: Record<string, unknown>): Promise<StartOutcome> {
  const gated = gatePdfInputs(data);
  if (!gated.ok) return gated;
  return startDurableRun(() => buildOptions(gated.inputs));
}

/** DURABLE path — poll one tick of a started summarize run by id. */
export async function pollSummarizePdfRun(runId: string): Promise<PollOutcome<DocumentSummary>> {
  return pollDurableRun(runId, parseDocumentSummary);
}
