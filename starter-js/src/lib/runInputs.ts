/**
 * The run-input gate — the server half of the kernel's input rules.
 *
 * The two sides are not the same call, and it is worth being exact about that.
 * The browser runs `computeReadiness` to decide whether Run is live
 * (`useRunInputs`); this module runs the kernel's `gateRunInputs`, which
 * validates shapes, re-applies the readiness rules over the same derived
 * fields, and builds the wire envelope. So the rules are shared by
 * construction, not by resemblance, while this side stays a strict superset of
 * the browser's.
 *
 * That superset property is the invariant to preserve, because a Server Action
 * is a public endpoint and the browser's checks are trivially bypassed. This is
 * the trust boundary; readiness is UX. The kernel asserts the invariant in its
 * own suite by running both sides over one table of structured fixtures;
 * `runInputs.test.ts` re-asserts it over this repo's committed contracts, which
 * is what would catch a method redesign that reaches a shape the kernel's
 * fixtures do not.
 *
 * What remains here is presentation: the kernel returns a verdict
 * (`missingInputs`, raw ajv `errors`), and this module renders it as the
 * `bad_request` `PipelineError` the template's `<ErrorDisplay>` knows how to
 * show.
 *
 * Pure module — no `process.env`, no Node built-ins — so it is safe to import
 * from either side (same rule as `fileInputs.ts`).
 */
import {
  describeValidationError,
  gateRunInputs as kernelGateRunInputs,
  getPipeInputForm,
  getPipeIOContract,
  type InputForm,
  type PipeInputFormDescriptor,
  type PipeIOContract,
  type PipeIOContracts,
  type RunInputsGateResult,
  type Translate,
  type ValidationMessageKey,
} from "@pipelex/mthds-form";
import type { PipelineError } from "@/lib/errors";

/**
 * Look one pipe's contract up in a generated `PIPE_IO_CONTRACTS`, or throw.
 *
 * `getPipeIOContract` returns `undefined` on a miss, and an undefined contract
 * renders as an empty form with a live Run button — a silent failure that looks
 * like a styling bug. A typo in the domain or the pipe code is a build-time
 * mistake (the generated artifact and the code disagree), so failing loudly at
 * module load is the right volume. Note the argument order: **contracts, then
 * domain, then pipe code**.
 */
export function requireContract(
  contracts: PipeIOContracts,
  domain: string,
  pipeCode: string,
): PipeIOContract {
  const contract = getPipeIOContract(contracts, domain, pipeCode);
  if (!contract) {
    throw new Error(
      `No IO contract for "${domain}.${pipeCode}" in the generated contracts ` +
        `(found: ${Object.keys(contracts).join(", ") || "none"}). ` +
        `Check the domain and pipe code against methods/<name>/main.mthds, then run \`npm run codegen\`.`,
    );
  }
  return contract;
}

/**
 * Look one pipe's input-form descriptor up in a generated `INPUT_FORM`, or throw.
 *
 * `requireContract`'s twin, for the same reason at the same volume: the kernel's
 * `getPipeInputForm` returns `undefined` on a miss, and `fieldsForContract`
 * returns `[]` unless both artifacts are present — so a missed lookup renders as
 * an empty form with a live Run button. Same argument order too: **the artifact,
 * then domain, then pipe code**.
 */
export function requireInputForm(
  inputForm: InputForm,
  domain: string,
  pipeCode: string,
): PipeInputFormDescriptor {
  const descriptor = getPipeInputForm(inputForm, domain, pipeCode);
  if (!descriptor) {
    throw new Error(
      `No input-form descriptor for "${domain}.${pipeCode}" in the generated INPUT_FORM ` +
        `(found: ${Object.keys(inputForm).join(", ") || "none"}). ` +
        `Check the domain and pipe code against methods/<name>/main.mthds, then run \`npm run codegen\`.`,
    );
  }
  return descriptor;
}

export type GateOutcome =
  | { ok: true; inputs: Record<string, unknown> }
  | { ok: false; error: PipelineError };

/**
 * The kernel's gate, rendered for this template: validate the caller's data
 * against the contract, refuse anything the Run button would have refused, and
 * build the `{ concept, content }` map the run expects.
 *
 * Returns a classified error rather than throwing — a Server Action must never
 * throw across the server→client boundary, because Next.js strips the message
 * to an opaque digest in production builds. The kernel honours the same
 * contract (`data` is `unknown`, a hostile payload gets a verdict, never a
 * throw), so all that happens here is translating its refusal into the
 * `bad_request` shape `<ErrorDisplay>` renders.
 */
export function gateRunInputs(contract: PipeIOContract, data: unknown): GateOutcome {
  const verdict = kernelGateRunInputs(contract, data);
  if (verdict.ok) return verdict;
  return { ok: false, error: invalidInputsError(verdict) };
}

/**
 * The invalid verdict as a `bad_request` error the UI can render.
 *
 * `missingInputs` names the variables the user left empty, which is what almost
 * every failure is. The scan can come up empty on a genuinely malformed value
 * (a wrong shape, a nested mismatch), so `errors` is the fallback — never leave
 * a rejection undiagnosable.
 */
function invalidInputsError(verdict: Extract<RunInputsGateResult, { ok: false }>): PipelineError {
  const { missingInputs, errors, preparedData } = verdict;
  const lines = missingInputs.length
    ? missingInputs.map((name) => `Missing required input: ${name}`)
    : errors.map((error) => describeValidationError(error, translate, preparedData));

  return {
    kind: "bad_request",
    title: missingInputs.length ? "Input required" : "Invalid input",
    message: missingInputs.length
      ? `Fill in ${formatList(missingInputs)} before running this method.`
      : "The inputs did not match what this method declares.",
    details: lines.join("\n") || "The run inputs failed validation.",
  };
}

/** `["a"]` → `"a"`, `["a","b"]` → `"a and b"`, `["a","b","c"]` → `"a, b and c"`. */
function formatList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "the required inputs";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The kernel renders validation messages through an injected translator so it
 * stays i18n-agnostic. This app has no i18n, so it supplies the English wording
 * directly — typed on the kernel's key union, so a kernel release that adds a
 * key fails the build here instead of rendering `undefined`.
 */
const VALIDATION_MESSAGES: Record<ValidationMessageKey, (v: Record<string, string>) => string> = {
  "inputPanel.aDateField": () => "a date field",
  "inputPanel.pickValidDate": (v) => `${v.label}: “${v.value}” is not a valid date.`,
  "inputPanel.pickValidDateEmpty": (v) => `${v.label}: pick a valid date.`,
  "inputPanel.dateCarriesTime": (v) =>
    `${v.label}: “${v.value}” carries a time — use ${v.day} here and put the time in the matching time field.`,
  "inputPanel.invalidValue": () => "Invalid value.",
  "inputPanel.invalidValueWithData": (v) => `${v.stack} (received “${v.value}”)`,
};

const translate: Translate = (key, values) => VALIDATION_MESSAGES[key](values ?? {});
