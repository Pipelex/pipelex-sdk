"use client";

import { useState } from "react";
import {
  pollComplexFormRun,
  runComplexFormBlocking,
  startComplexFormRun,
} from "@/actions/runComplexFormPipeline";
import { DEFAULT_EXECUTION_MODE, type ExecutionMode } from "@/config";
import { INPUT_FORM, OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/complex-form/contracts";
import { useRun } from "@/hooks/useRun";
import { useRunInputs } from "@/hooks/useRunInputs";
import { requireResultField } from "@/lib/resultField";
import { requireContract, requireInputForm } from "@/lib/runInputs";
import { ErrorDisplay } from "./ErrorDisplay";
import { ModeToggle } from "./ModeToggle";
import { RunDetails } from "./RunDetails";
import { RunInputsForm } from "./RunInputsForm";
import { RunResult } from "./RunResult";
import { RunStatus } from "./RunStatus";

const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "complex_form", "extract_brief");
const DESCRIPTOR = requireInputForm(INPUT_FORM, "complex_form", "extract_brief");
const RESULT_FIELD = requireResultField(OUTPUT_FORM, CONTRACT, "complex_form", "extract_brief");

const SAMPLE_TEXT =
  "Apple announced new products in Cupertino on March 5th, 2026, with Tim Cook presenting alongside Jony Ive.";

/**
 * The same composition as `EntityForm` — `useRunInputs` + `<RunInputsForm>` +
 * `useRun` — over a method that declares more than one plain text input.
 *
 * That is the entire point of this example, and it is best appreciated by
 * diffing it against `EntityForm.tsx`: this file is not longer, and it names no
 * input. The optional structured input (a nested card with an enum child and
 * its own optional-folding), the plural input (a repeater), the fold-away of
 * empty optionals and the readiness rule that ignores both all arrive from the
 * contract `npm run codegen` committed beside the bundle.
 */
export function ComplexForm() {
  const { fields, values, setValues, ready, toData } = useRunInputs(CONTRACT, DESCRIPTOR, {
    initialValues: { text: SAMPLE_TEXT },
  });
  const [mode, setMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE);
  const { state, run } = useRun({
    mode,
    blocking: runComplexFormBlocking,
    start: startComplexFormRun,
    poll: pollComplexFormRun,
  });

  const running = state.phase === "running";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(toData());
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        <RunInputsForm
          fields={fields}
          values={values}
          onValuesChange={setValues}
          disabled={running}
        />
        <ModeToggle value={mode} onChange={setMode} disabled={running} />
        <button
          type="submit"
          disabled={running || !ready}
          className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Extracting…" : "Extract brief"}
        </button>
      </form>

      {running && (
        <RunStatus
          status={state.status}
          elapsedMs={state.elapsedMs}
          health={state.health}
          runId={state.runId}
        />
      )}
      {state.phase === "error" && <ErrorDisplay error={state.error} runId={state.runId} />}
      {state.phase === "done" && (
        <>
          <RunResult field={RESULT_FIELD} value={state.output} name="extraction_brief" />
          <RunDetails runId={state.runId} usage={state.usage} />
        </>
      )}
    </div>
  );
}
