"use client";

import { useState } from "react";
import {
  pollTextStatsRun,
  runTextStatsBlocking,
  startTextStatsRun,
} from "@/actions/runTextStatsPipeline";
import { DEFAULT_EXECUTION_MODE, type ExecutionMode } from "@/config";
import { INPUT_FORM, OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/text-stats/contracts";
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

// Scaffolded by `make add-method` — yours to edit from here on.
//
// Both halves are derived from the method's own contract, committed by
// `npm run codegen`: the form from the input-form descriptor, the result view
// from the output-form descriptor paired with the payload schema. There is
// nothing hand-written to keep in step — change what the method takes or
// produces, regenerate, and both follow.
const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "text_stats", "analyze_text");
const DESCRIPTOR = requireInputForm(INPUT_FORM, "text_stats", "analyze_text");
const RESULT_FIELD = requireResultField(OUTPUT_FORM, CONTRACT, "text_stats", "analyze_text");

export function TextStatsForm() {
  const { fields, values, setValues, ready, toData } = useRunInputs(CONTRACT, DESCRIPTOR);
  const [mode, setMode] = useState<ExecutionMode>(DEFAULT_EXECUTION_MODE);
  // `useRun` presents one state machine and dispatches to the blocking or
  // durable Server Actions by `mode`. The form never branches on mode itself.
  const { state, run } = useRun({
    mode,
    blocking: runTextStatsBlocking,
    start: startTextStatsRun,
    poll: pollTextStatsRun,
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
          {running ? "Running…" : "Run text stats"}
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
          {/* The result, rendered from the method's own output contract — the
              scaffold has no design decision to make about a shape it has never
              seen, because there is none left to make. Swap it for a component
              of your own if this output deserves a bespoke view; the value is
              already typed by the narrower. */}
          <RunResult field={RESULT_FIELD} value={state.output} name="text_stats" />
          {/* The run's id, which a user quotes, and what it cost, folded away for
              whoever built the app. */}
          <RunDetails runId={state.runId} usage={state.usage} />
        </>
      )}
    </div>
  );
}
