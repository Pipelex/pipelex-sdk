"use client";

import { useState } from "react";
import {
  pollExtractEntitiesRun,
  runExtractEntitiesBlocking,
  startExtractEntitiesRun,
} from "@/actions/runExtractEntitiesPipeline";
import { DEFAULT_EXECUTION_MODE, type ExecutionMode } from "@/config";
import { INPUT_FORM, OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/extract-entities/contracts";
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

// Both halves are derived from the method's own contract, committed by
// `npm run codegen`: the form from the input-form descriptor, the result view
// from the output-form descriptor paired with the payload schema.
const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "extract_entities", "extract_entities");
const DESCRIPTOR = requireInputForm(INPUT_FORM, "extract_entities", "extract_entities");
const RESULT_FIELD = requireResultField(
  OUTPUT_FORM,
  CONTRACT,
  "extract_entities",
  "extract_entities",
);

const SAMPLE_TEXT =
  "Apple announced new products in Cupertino on March 5th, 2026, with Tim Cook presenting alongside Jony Ive.";

export function EntityForm() {
  const { fields, values, setValues, ready, toData } = useRunInputs(CONTRACT, DESCRIPTOR, {
    initialValues: { text: SAMPLE_TEXT },
  });
  const [mode, setMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE);
  // `useRun` presents one state machine and dispatches to the blocking or
  // durable Server Actions by `mode`. The form never branches on mode itself.
  const { state, run } = useRun({
    mode,
    blocking: runExtractEntitiesBlocking,
    start: startExtractEntitiesRun,
    poll: pollExtractEntitiesRun,
  });

  const running = state.phase === "running";

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The action gates the same contract server-side, applying the kernel's
    // rules in full — that is the trust boundary; `ready` below is only UX.
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
          {running ? "Extracting…" : "Extract entities"}
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
          <RunResult field={RESULT_FIELD} value={state.output} name="extracted_entities" />
          <RunDetails runId={state.runId} usage={state.usage} />
        </>
      )}
    </div>
  );
}
