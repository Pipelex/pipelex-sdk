/**
 * The output half of the same idea as `runInputs.ts`: one lookup that turns a
 * method's committed contract into the single `RunField` its result is
 * rendered from.
 *
 * An output is a concept ref exactly like an input is — same concepts, same
 * kinds, same nesting — so the kernel maps an output node through the very
 * function it walks an input descriptor with, and `<RunResult>` renders the
 * result with the same vocabulary `<RunInputsForm>` renders the form. Nothing
 * in this template inspects a payload to decide how to show it.
 *
 * Pure module — kernel core only, no `process.env`, no Node built-ins — so a
 * client component may build its result field at module load, beside its
 * `CONTRACT` and `DESCRIPTOR`.
 */
import {
  buildResultField,
  getPipeOutputForm,
  type OutputForm,
  type PipeIOContract,
  type RunField,
} from "@pipelex/mthds-form";

/**
 * One pipe's output-form descriptor paired with its payload schema, or throw.
 *
 * **Both artifacts are required, and they answer different questions.** The
 * descriptor says what the result IS — its kind, its nesting, whether it is
 * plural; the contract's `output.json_schema` states the shape the payload
 * arrives in and names the property it sits under (`TextContent {text}` for a
 * `native.Text` result, the concept's own object for a structured one). A
 * renderer holding one but not the other is back to inferring the missing half
 * from the value, which is the guessing this whole pattern removes.
 *
 * It throws for the same reason `requireContract` and `requireInputForm` do: a
 * missed lookup is a build-time mistake — the generated artifact and the code
 * disagree about a domain or a pipe code — and the alternative is a result
 * panel that renders nothing, which reads as a styling bug. Same argument
 * order as its two siblings: **the artifact, then domain, then pipe code**, with
 * the contract carried alongside because the schema is read off it rather than
 * looked up a second time.
 *
 * All three of the kernel's preconditions are checked here rather than left to
 * fail inside it, and that is the point of the function. Every caller builds its
 * result field at **module scope of a `"use client"` component**, so an
 * unchecked `undefined` reaching `buildResultField` takes the whole tab chunk
 * down with a bare `TypeError` naming neither the pipe nor the artifact — the
 * same unreadable failure the descriptor guard exists to prevent, one line
 * further on. The reachable cases are an engine serving `output_form` but no
 * `json_schema` on the output contract (a recent addition to the standard), and
 * a `contracts.ts` committed before either member existed.
 */
export function requireResultField(
  outputForm: OutputForm,
  contract: PipeIOContract,
  domain: string,
  pipeCode: string,
): RunField {
  const descriptor = getPipeOutputForm(outputForm, domain, pipeCode);
  if (!descriptor) {
    throw new Error(
      `No output-form descriptor for "${domain}.${pipeCode}" in the generated OUTPUT_FORM ` +
        `(found: ${Object.keys(outputForm ?? {}).join(", ") || "none"}). ` +
        `Check the domain and pipe code against methods/<name>/main.mthds, then run \`npm run codegen\`.`,
    );
  }
  if (!descriptor.field) {
    throw new Error(
      `The output-form descriptor for "${domain}.${pipeCode}" carries no \`field\` node, so there ` +
        `is nothing to render. Regenerate with \`npm run codegen\`; if it comes back the same, the ` +
        `API served a malformed output_form view — report upstream.`,
    );
  }
  const schema = contract.output?.json_schema;
  if (!schema) {
    throw new Error(
      `The IO contract for "${domain}.${pipeCode}" carries no \`output.json_schema\`, so the ` +
        `descriptor has no payload shape to pair with. Check PIPELEX_BASE_URL serves an API that ` +
        `states an output schema, then run \`npm run codegen\`.`,
    );
  }
  return buildResultField(descriptor, schema);
}
