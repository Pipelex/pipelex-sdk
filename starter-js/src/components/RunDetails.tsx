"use client";

import { useState } from "react";
import type { UsageReport } from "@/lib/usageReport";
import { CostReport } from "./CostReport";

interface RunDetailsProps {
  /** The finished run's id. */
  runId: string;
  /** What the run consumed, as `buildUsageReport` projected it. */
  usage: UsageReport;
}

/**
 * Whether `<CostReport>` has anything to say. It renders nothing for usage that
 * was off or predates the artifact, and a disclosure that opens onto nothing is
 * a control that lies about what it holds.
 */
function hasUsageToShow(usage: UsageReport): boolean {
  return usage.state !== "unavailable" || usage.assemblyError !== null;
}

/**
 * What a finished run leaves under its result: its id, and what it cost.
 *
 * The id is for the person using the app. It is what they quote when they ask
 * about a run, and once this page is closed it is the only way back to a run
 * started from an inline bundle, which has no catalog id — in the back office,
 * through the API, or in the server's log, which prints the same id. So it is
 * shown, selectable in one click, with a Copy button beside it. A clipboard the
 * browser refuses leaves nothing to report: the id is still one click from
 * selected.
 *
 * The cost is for the developer. The token table names the inference models and
 * the pipes that called them, which an end user has no use for, so it sits in a
 * disclosure that starts closed, one click away for whoever built the app.
 */
export function RunDetails({ runId, usage }: RunDetailsProps) {
  const [copied, setCopied] = useState(false);

  async function copyRunId() {
    try {
      await navigator.clipboard.writeText(runId);
      setCopied(true);
    } catch {
      // Refused (no permission, an insecure context): the id stays selectable.
    }
  }

  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>Run</span>
        <span className="select-all font-mono text-slate-700">{runId}</span>
        <button
          type="button"
          onClick={() => void copyRunId()}
          aria-label={copied ? "Run id copied" : "Copy the run id"}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </p>
      {hasUsageToShow(usage) && (
        <details className="rounded-lg border border-slate-200 bg-white">
          <summary className="cursor-pointer select-none px-4 py-2 text-xs font-medium text-slate-600">
            Usage and cost
          </summary>
          <div className="border-t border-slate-200 p-2">
            <CostReport usage={usage} />
          </div>
        </details>
      )}
    </div>
  );
}
