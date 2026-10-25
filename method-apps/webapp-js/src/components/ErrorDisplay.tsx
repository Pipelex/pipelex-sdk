import type { ProblemDomain } from "@pipelex/sdk";
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
 * Who must act, by the problem's `domain`: the line that tells a person
 * whether the fix is theirs. A failure that carries no domain names nobody.
 */
const WHO_ACTS: Record<ProblemDomain, string> = {
  input: "The inputs need to change before this can run.",
  method: "The method needs a change from whoever authors it.",
  account: "The account needs attention from whoever owns it.",
  operator: "Whoever runs this deployment needs to fix its configuration.",
  runtime: "The service failed on its side; nothing you entered caused it.",
};

/**
 * The tone of the card, by who must act. A fault on the caller's side (the
 * inputs, the method, the account) is something someone can fix, shown as a
 * caution; a fault in the service or its deployment, or one that carries no
 * domain, is shown as an error. The class names are whole literals so
 * Tailwind finds them.
 */
const CAUTION = {
  card: "border-amber-200 bg-amber-50 text-amber-950",
  muted: "text-amber-800",
  faint: "text-amber-700",
  rule: "border-amber-200",
  quote: "border-amber-300",
};
const ALARM = {
  card: "border-red-200 bg-red-50 text-red-900",
  muted: "text-red-800",
  faint: "text-red-700",
  rule: "border-red-200",
  quote: "border-red-300",
};

function toneOf(domain: ProblemDomain | undefined) {
  return domain === "input" || domain === "method" || domain === "account" ? CAUTION : ALARM;
}

/**
 * The line to quote to support: the error's own, which names what failed and
 * the request's id, with the run's id ahead of it when the line does not
 * already carry it, or the run's id alone.
 */
function supportLine(error: PipelineError, runId: string | null | undefined): string | undefined {
  if (error.support === undefined) return undefined;
  if (runId && !error.support.includes(runId)) return `run ${runId} · ${error.support}`;
  return error.support;
}

/**
 * A classified error, as the person using the app reads it: what happened,
 * who must act, the next step, whether running it again can help, and what to
 * quote to support — the run's id alone, or the error's own support line when
 * it has one, which names the run with what failed, when, and the request's id.
 */
export function ErrorDisplay({ error, runId }: ErrorDisplayProps) {
  const tone = toneOf(error.domain);
  const support = supportLine(error, runId);
  return (
    <div
      role="alert"
      aria-live="polite"
      data-domain={error.domain}
      className={`space-y-3 rounded-lg border p-5 text-sm ${tone.card}`}
    >
      <div>
        <h2 className="text-base font-semibold">{error.title}</h2>
        <p className={`mt-1 ${tone.muted}`}>{error.message}</p>
        {error.domain && <p className={`mt-1 ${tone.muted}`}>{WHO_ACTS[error.domain]}</p>}
      </div>

      {error.apiMessage && (
        <figure className={`rounded-md border bg-white/70 p-3 ${tone.rule}`}>
          <figcaption className={`text-xs font-medium uppercase tracking-wide ${tone.faint}`}>
            What the Pipelex API returned
          </figcaption>
          <blockquote className={`mt-1 border-l-2 pl-3 italic ${tone.quote} ${tone.muted}`}>
            {error.apiMessage}
          </blockquote>
        </figure>
      )}

      {error.hint && (
        <div className={`rounded-md border bg-white p-3 ${tone.rule}`}>
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
        <p className={error.retry.verdict === "no" ? tone.muted : "font-medium"}>
          {error.retry.summary}
        </p>
      )}

      {support ? (
        <p className={`text-xs ${tone.faint}`}>
          For support: <span className="select-all font-mono">{support}</span>
        </p>
      ) : (
        runId && (
          <p className={`text-xs ${tone.faint}`}>
            Run <span className="select-all font-mono">{runId}</span>
          </p>
        )
      )}

      <details className={`text-xs ${tone.faint}`}>
        <summary className="cursor-pointer select-none font-medium">Technical details</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-2 font-mono">
          {error.details}
        </pre>
      </details>
    </div>
  );
}
