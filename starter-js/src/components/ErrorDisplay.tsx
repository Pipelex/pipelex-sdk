import type { PipelineError } from "@/lib/errors";

interface ErrorDisplayProps {
  error: PipelineError;
  /**
   * The run this failure belongs to, when one had started. A run that failed
   * is the one a person most needs to look up, and a durable run's id is the
   * only handle on it once the page is closed.
   */
  runId?: string | null;
}

/**
 * A classified error, as the person using the app reads it: what happened,
 * the next step, whether running it again can help, and what to quote to
 * support — the run's id alone, or the error's own support line when it has
 * one, which names the run with what failed and when.
 */
export function ErrorDisplay({ error, runId }: ErrorDisplayProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-900"
    >
      <div>
        <h2 className="text-base font-semibold">{error.title}</h2>
        <p className="mt-1 text-red-800">{error.message}</p>
      </div>

      {error.apiMessage && (
        <figure className="rounded-md border border-red-200 bg-white/70 p-3">
          <figcaption className="text-xs font-medium uppercase tracking-wide text-red-700">
            What the Pipelex API returned
          </figcaption>
          <blockquote className="mt-1 border-l-2 border-red-300 pl-3 italic text-red-800">
            {error.apiMessage}
          </blockquote>
        </figure>
      )}

      {error.hint && (
        <div className="rounded-md border border-red-200 bg-white p-3">
          <p className="font-medium text-slate-800">{error.hint.summary}</p>
          {error.hint.code && (
            <pre
              className="mt-2 overflow-x-auto rounded bg-slate-900 p-3 text-xs leading-relaxed text-slate-100"
              data-language={error.hint.codeLanguage}
            >
              <code>{error.hint.code}</code>
            </pre>
          )}
          {error.hint.docs && (
            <a
              href={error.hint.docs.href}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-block text-xs font-medium text-blue-700 underline"
            >
              {error.hint.docs.label} →
            </a>
          )}
        </div>
      )}

      {error.retry && (
        <p className={error.retry.retryable ? "font-medium text-red-900" : "text-red-800"}>
          {error.retry.summary}
        </p>
      )}

      {error.support ? (
        <p className="text-xs text-red-700">
          For support: <span className="select-all font-mono">{error.support}</span>
        </p>
      ) : (
        runId && (
          <p className="text-xs text-red-700">
            Run <span className="select-all font-mono">{runId}</span>
          </p>
        )
      )}

      <details className="text-xs text-red-700">
        <summary className="cursor-pointer select-none font-medium">Technical details</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono">
          {error.details}
        </pre>
      </details>
    </div>
  );
}
