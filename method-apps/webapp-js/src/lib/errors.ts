// Import the SDK error classes from the `@pipelex/sdk` barrel. This module is
// bundled into the client (client components import `classifyTransportError`
// and the `PipelineError` type from here), so it must carry no Node built-ins.
// The barrel is client-safe: `PipelexApiClient` is fetch-based and nothing in
// the graph pulls `node:fs`/`node:path`, so a client bundler handles it without
// breaking `make build`. Only `pipelexClient.ts` (server-only) constructs the
// client itself.
import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  DEFAULT_API_BASE_URL,
  InputPreparationError,
  PipelineExecuteTimeoutError,
  RejectedAssetError,
  RunFailedError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
  RunTimeoutError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
  type RunErrorReport,
  type UserAction,
  type ValidationErrorItem,
} from "@pipelex/sdk";
import { BadPipelineOutputError } from "@/types/pipelineError";

export type PipelineErrorKind =
  | "api_unreachable"
  | "config_missing"
  | "auth_missing"
  | "auth_invalid"
  | "bad_request"
  | "server_error"
  | "bundle_load_failed"
  | "bad_response"
  | "transport_error"
  // Dual-mode run-lifecycle kinds. `execute_timeout` / `run_still_running`
  // come from the **blocking** path (the hosted gateway's ~30s cap); the rest
  // from the **durable** path (start + poll). All are produced by
  // `classifyPipelineError` from the matching SDK error class, except
  // `run_timeout`, which is also built inline by the client poll ceiling
  // (`buildClientTimeoutError`).
  | "execute_timeout"
  | "run_still_running"
  | "run_failed"
  | "run_timeout"
  | "lifecycle_unavailable"
  // A file input's upload failed. The browser sends a dropped file straight to
  // Pipelex storage with an upload grant (`useFileInputs`), and that can fail in
  // a few distinct, actionable ways — classified from `InputPreparationError` and
  // its subclasses into one kind with subclass-tailored copy, on the server by
  // `classifyPipelineError` and in the browser by `classifyUploadError` — or by
  // `buildFilePreparationError`, when the host's own `prepareFile` throws.
  | "upload_failed"
  // The configured API does not serve `POST /v1/upload/grant`, so a file cannot
  // be stored at all. Classified by `classifyPipelineError` with `uploadGrant`.
  | "upload_unavailable"
  // Pre-flight validation kinds: built inline before the SDK call (see
  // `checkUploadRequest` / `fileInputErrorToPipelineError`), never produced by
  // `classifyPipelineError` from a thrown error — except a grant request the
  // API itself refuses as too large, which is the same fact from its authority.
  // They are valid kinds so `<ErrorDisplay>` renders them.
  | "file_too_large"
  | "unsupported_file_type"
  | "invalid_file"
  // The run's inputs, files aside, are past what one Server Action body may
  // carry. Built inline by `useRun` before it calls the action
  // (`buildInputsTooLargeError`), because Next refuses such a body before the
  // action runs and the browser would see only a transport error.
  | "inputs_too_large"
  | "unknown";

export interface ErrorHint {
  summary: string;
  /** Optional inline code/command snippet rendered in a `<pre>` block. */
  code?: string;
  codeLanguage?: "bash" | "env" | "json";
  docs?: { label: string; href: string };
}

export interface PipelineError {
  kind: PipelineErrorKind;
  /** Headline, e.g. "Pipelex API not reachable". */
  title: string;
  /** 1–2 sentences explaining what happened in plain language. */
  message: string;
  /**
   * The verbatim message the Pipelex API returned, when our `message` is a
   * *re-framing* of it (e.g. a runtime-vocabulary error we restate in the
   * app's own terms). Rendered as its own block next to our interpretation
   * so the template demonstrates raw-API-response vs. handled-error UX side by
   * side. Omitted when our `message` already is the server's text (no value in
   * showing it twice).
   */
  apiMessage?: string;
  hint?: ErrorHint;
  /**
   * Whether running it again can succeed, as the runtime judged it. Set only
   * from a verdict — a failed run's report carries `retryable` — and absent
   * when nobody said, so the display never claims either way on a guess.
   */
  retry?: RetryAdvice;
  /**
   * One line a person quotes to support: the run's id, what failed and when.
   * `<ErrorDisplay>` shows it selectable in place of the bare run id.
   */
  support?: string;
  /** Raw technical info for the collapsible "Technical details" section. */
  details: string;
}

export interface RetryAdvice {
  /** True when running it again can succeed: the display offers a re-run. */
  retryable: boolean;
  /** The sentence that says so. */
  summary: string;
}

export interface ClassifyEnv {
  apiUrl: string | undefined;
  hasApiKey: boolean;
}

export interface ClassifyOptions {
  /**
   * Set by the blocking path (`executeBlockingRun`). Behind the hosted gateway a
   * synchronous `execute` that overruns the ~30s cap comes back as a 502/504
   * "the runner did not complete the request" — a *response*, so the SDK raises
   * `ApiResponseError`, not its own `PipelineExecuteTimeoutError` (the SDK's
   * client-side timeout is longer than the gateway's). Only on the blocking path
   * is that gateway error the cap; on the durable poll path a 502/504 is a
   * transient server hiccup, so this flag scopes the mapping correctly.
   */
  blocking?: boolean;
  /**
   * Set by `grantFileUpload`, whose one request is `POST /v1/upload/grant`. A
   * `404` there means the configured API does not serve upload grants — every
   * other 404 on that route is impossible — and a `413` is the platform refusing
   * a declared size over its limit, which is the authority on "too large".
   */
  uploadGrant?: boolean;
  /**
   * Set by `pollDurableRun` for a run that ended without a result: when it
   * ended, from the run's status read (`finished_at`). A failed run's support
   * line carries it, because it is what finds the run in the server's logs.
   */
  finishedAt?: string | null;
}

export function classifyPipelineError(
  err: unknown,
  env: ClassifyEnv,
  opts?: ClassifyOptions,
): PipelineError {
  if (err instanceof ApiUnreachableError) return classifyUnreachable(err, env);
  if (err instanceof ApiResponseError) {
    if (opts?.blocking && (err.status === 502 || err.status === 504)) {
      return classifyBlockingGatewayTimeout(err);
    }
    if (opts?.uploadGrant && err.status === 404) return classifyUploadUnavailable(err, env);
    if (opts?.uploadGrant && err.status === 413) return classifyGrantTooLarge(err);
    return classifyResponse(err, env);
  }
  if (err instanceof ClientAuthenticationError) return classifyClientAuth(err, env);
  // Run-lifecycle errors (both extend the protocol's PipelineRequestError, but
  // are distinct concrete classes, so order among them is irrelevant).
  if (err instanceof PipelineExecuteTimeoutError) return classifyExecuteTimeout(err);
  if (err instanceof RunStillRunningError) return classifyRunStillRunning(err);
  if (err instanceof RunFailedError) return classifyRunFailed(err, opts?.finishedAt);
  if (err instanceof RunTimeoutError) return classifyRunTimeout(err);
  if (err instanceof RunLifecycleUnavailableError) return classifyLifecycleUnavailable(err, env);
  if (err instanceof InputPreparationError) return classifyInputPreparationError(err, env);
  if (err instanceof BadPipelineOutputError) return classifyBadOutput(err);
  if (isFsNotFound(err)) return classifyBundleMissing(err);
  return classifyUnknown(err);
}

/**
 * True when PIPELEX_BASE_URL names something other than the SDK's own default.
 *
 * "The variable is set" is not the same question: the quick start is
 * `cp .env.example .env.local`, and that file pins the default hosted URL
 * explicitly, so the variable is set on the ordinary path without the user ever
 * choosing a URL. Only a genuinely customized value makes the URL a suspect —
 * telling someone to replace a correct value with itself is worse than saying
 * nothing. Trailing slashes are normalized away, the same way the e2e specs
 * compare this value.
 */
function isCustomApiUrl(apiUrl: string | undefined): boolean {
  if (apiUrl === undefined) return false;
  const normalize = (url: string) => url.trim().replace(/\/+$/, "");
  return normalize(apiUrl) !== normalize(DEFAULT_API_BASE_URL);
}

function classifyUnreachable(err: ApiUnreachableError, env: ClassifyEnv): PipelineError {
  const url = err.apiUrl || env.apiUrl || "(unknown)";
  const codeSuffix = err.code ? ` (${err.code})` : "";
  const baseDetails = `${err.name}: ${err.message}${err.cause instanceof Error ? `\nCaused by: ${err.cause.message}` : ""}`;

  // Split on whether PIPELEX_BASE_URL was *customized*, not merely set — see
  // `isCustomApiUrl`. With a custom URL in play it is the first suspect; on the
  // default hosted URL there is nothing for the user to fix in their config, so
  // point at the network instead.
  if (isCustomApiUrl(env.apiUrl)) {
    return {
      kind: "api_unreachable",
      title: "Pipelex API not reachable",
      message: `Tried to reach ${url}${codeSuffix}, but the request did not get a response. PIPELEX_BASE_URL is set, so start there: make sure it targets a Pipelex API environment.`,
      hint: {
        summary:
          "Verify PIPELEX_BASE_URL in .env.local targets a Pipelex API environment, or remove the override to fall back to the default:",
        code: "PIPELEX_BASE_URL=https://api.pipelex.com",
        codeLanguage: "env",
      },
      details: baseDetails,
    };
  }

  return {
    kind: "api_unreachable",
    title: "Pipelex API not reachable",
    message: `Tried to reach the Pipelex API at its default URL, ${url}${codeSuffix}, but the request did not get a response. Check your network connection.`,
    hint: {
      summary: "Check your network connection, then retry. The URL the app is using is:",
      code: `PIPELEX_BASE_URL=${url}`,
      codeLanguage: "env",
    },
    details: baseDetails,
  };
}

function classifyResponse(err: ApiResponseError, env: ClassifyEnv): PipelineError {
  // `/start` reached a backend that *has* the route but whose orchestrator is
  // blocking-only (the in-process `direct` mode), so it refused the durable
  // start with a 400. Surface it in durable-execution terms — see
  // `classifyStartRequiresAsync` — instead of letting the raw runtime-vocabulary
  // server message fall through as a generic `bad_request`.
  if (err.errorType === START_REQUIRES_ASYNC_ORCHESTRATION) {
    return classifyStartRequiresAsync(err);
  }

  const detailsLines = [
    `${err.name}: HTTP ${err.status} ${err.statusText}`.trim(),
    // Always surface which endpoint was hit — URLs change often in dev, and a
    // 4xx/5xx otherwise gives no hint about *which* backend rejected the call.
    err.apiUrl ? `API URL: ${err.apiUrl}` : null,
    err.errorType ? `error_type: ${err.errorType}` : null,
    err.serverMessage ? `server message: ${err.serverMessage}` : null,
    // The refusal's own classification, when it came as a problem document:
    // ahead of the raw body, whose truncation could cut a validation item off.
    detailLine("error_domain", err.errorDomain),
    detailLine("retryable", err.retryable),
    detailLine("user_action", err.userAction?.kind),
    ...validationLines(err.validationErrors),
    err.responseBody ? `body: ${truncate(err.responseBody, 2000)}` : null,
  ].filter(Boolean) as string[];
  const details = detailsLines.join("\n");

  if (err.status === 401 || err.status === 403) {
    if (!env.hasApiKey) {
      return {
        kind: "auth_missing",
        title: "Pipelex API key missing",
        message: `${err.apiUrl} rejected the request because no PIPELEX_API_KEY was sent.`,
        hint: {
          summary: "Add your API key to .env.local and restart the dev server:",
          code: "PIPELEX_API_KEY=your-key-here",
          codeLanguage: "env",
        },
        details,
      };
    }
    return {
      kind: "auth_invalid",
      title: "Pipelex API key rejected",
      message: `${err.apiUrl} returned ${err.status} for the credentials you provided. The PIPELEX_API_KEY in .env.local is not valid for this API.`,
      hint: {
        summary: "Double-check the key and the API URL it's intended for.",
        code: "PIPELEX_API_KEY=your-key-here",
        codeLanguage: "env",
      },
      details,
    };
  }

  if (err.status >= 500) {
    return withRefusalAdvice(classifyServerError(err, details), err);
  }

  return withRefusalAdvice(
    {
      kind: "bad_request",
      title: `Pipelex API rejected the request (HTTP ${err.status})`,
      message:
        err.serverMessage ?? "The API returned a client error. Inspect the request and try again.",
      details,
    },
    err,
  );
}

/**
 * A refusal that came as a problem document carries the runtime's own advice:
 * `user_action`, the next step, and `retryable`, whether running it again can
 * succeed — at `/v1/start` in durable mode and at `/v1/execute` in blocking
 * mode alike. The message is already the refusal's reason (`serverMessage`,
 * its `detail`), and its validation items are in the details; this puts the
 * user action's detail in place of the hint the HTTP status chose, and the
 * retry verdict beside it. An answer without them is returned as it was.
 */
function withRefusalAdvice(error: PipelineError, err: ApiResponseError): PipelineError {
  const nextStep = nextStepOf(err.userAction);
  return {
    ...error,
    ...(nextStep ? { hint: { summary: nextStep } } : {}),
    ...(typeof err.retryable === "boolean" ? { retry: retryAdvice(err.retryable) } : {}),
  };
}

function classifyServerError(err: ApiResponseError, details: string): PipelineError {
  const baseTitle = `Pipelex API server error (HTTP ${err.status})`;
  switch (err.errorType) {
    case "CredentialsError":
      return {
        kind: "server_error",
        title: "Pipelex server is missing LLM credentials",
        message:
          err.serverMessage ??
          "The Pipelex backend tried to call an LLM provider but no API key was configured for it.",
        hint: {
          summary:
            "The Pipelex hosted API always has its providers configured, so this indicates the API at PIPELEX_BASE_URL isn't it (or a non-production environment is mid-configuration) — verify the URL.",
          docs: { label: "Pipelex inference setup docs", href: "https://docs.pipelex.com/" },
        },
        details,
      };
    case "PipeOperatorModelAvailabilityError":
      return {
        kind: "server_error",
        title: "No inference backend configured on the server",
        message:
          err.serverMessage ??
          "The Pipelex backend has no LLM inference backend wired up to handle this pipe.",
        hint: {
          summary:
            "The Pipelex hosted API always has an inference backend, so this indicates the API at PIPELEX_BASE_URL isn't it (or a non-production environment is mid-configuration) — verify the URL.",
          docs: { label: "Pipelex inference setup docs", href: "https://docs.pipelex.com/" },
        },
        details,
      };
    case "PipeValidationError":
    case "PipeFactoryError":
    case "MthdsParserError":
    case "MthdsDecodeError":
      return {
        kind: "server_error",
        title: "The pipeline definition has a problem",
        message:
          err.serverMessage ??
          "The Pipelex server rejected the bundle or pipe definition. The method's bundle may be out of sync with the server's version of the spec.",
        details,
      };
    default:
      return {
        kind: "server_error",
        title: baseTitle,
        message:
          err.serverMessage ??
          `The API returned an unexpected error${err.errorType ? ` (${err.errorType})` : ""}.`,
        details,
      };
  }
}

function classifyClientAuth(err: ClientAuthenticationError, env: ClassifyEnv): PipelineError {
  void env;
  return {
    kind: "config_missing",
    title: "Pipelex API URL not configured",
    message:
      "The @pipelex/sdk SDK needs PIPELEX_BASE_URL to know where to send pipeline requests, but it isn't set.",
    hint: {
      summary: "Copy .env.example to .env.local and fill it in:",
      code: "cp .env.example .env.local",
      codeLanguage: "bash",
    },
    details: `${err.name}: ${err.message}`,
  };
}

/**
 * The remedy for a run too long to await in one request. The page has no mode
 * switch: the mode is the deployment's (`EXECUTION_MODE` in `src/config.ts`), so
 * the hint is addressed to whoever runs the app and names what to change. These
 * errors only arise in blocking mode, so they only ever meet a deployment that
 * set the variable.
 */
const USE_DURABLE_RUNS_HINT: ErrorHint = {
  summary:
    "This app runs in blocking mode, which waits for the whole run in one request. Whoever runs the app can switch it to durable runs, which start the run and poll for its result so long pipelines survive the cap: against an API that serves them, remove NEXT_PUBLIC_EXECUTION_MODE or set it as below, then rebuild or restart the app.",
  code: "NEXT_PUBLIC_EXECUTION_MODE=durable",
  codeLanguage: "env",
};

function classifyExecuteTimeout(err: PipelineExecuteTimeoutError): PipelineError {
  const seconds = Math.round(err.elapsedMs / 1000);
  return {
    kind: "execute_timeout",
    title: "Pipeline exceeded the ~30s blocking limit",
    message: `The blocking request ran for ~${seconds}s before timing out at the hosted gateway's ~30s synchronous limit. The pipeline isn't broken — it's just too long to await synchronously behind the hosted gateway.`,
    hint: USE_DURABLE_RUNS_HINT,
    details: `${err.name}: ${err.message}`,
  };
}

/**
 * The blocking cap as the hosted gateway actually surfaces it: a synchronous
 * `execute` that overruns ~30s returns a 502/504 ("the runner did not complete
 * the request") rather than dropping the connection — so the SDK raises
 * `ApiResponseError`, not `PipelineExecuteTimeoutError`. Same user meaning as
 * `classifyExecuteTimeout` (kind `execute_timeout`): blocking is too long here,
 * and durable runs are the remedy. Only reached on the blocking path (see `ClassifyOptions`).
 */
function classifyBlockingGatewayTimeout(err: ApiResponseError): PipelineError {
  const detailsLines = [
    `${err.name}: HTTP ${err.status} ${err.statusText}`.trim(),
    err.serverMessage ? `server message: ${err.serverMessage}` : null,
  ].filter(Boolean) as string[];
  return {
    kind: "execute_timeout",
    title: "Pipeline exceeded the ~30s blocking limit",
    message: `The hosted gateway returned HTTP ${err.status} because the blocking request didn't finish in time — synchronous runs are cut off at ~30s here. The pipeline isn't broken; it's just too long to await synchronously.`,
    hint: USE_DURABLE_RUNS_HINT,
    details: detailsLines.join("\n"),
  };
}

function classifyRunStillRunning(err: RunStillRunningError): PipelineError {
  const retry = err.retryAfterSeconds != null ? `\nRetry-After: ${err.retryAfterSeconds}s` : "";
  const location = err.location ? `\nLocation: ${err.location}` : "";
  return {
    kind: "run_still_running",
    title: "The run is still going",
    message: `The blocking request was accepted, but the run hasn't finished — the server returned run id ${err.runId} instead of a result. Behind the hosted gateway, a long run can't be awaited synchronously.`,
    hint: USE_DURABLE_RUNS_HINT,
    details: `${err.name}: ${err.message}${retry}${location}`,
  };
}

/**
 * A run that ended without a result. Its stored error report, when it has one,
 * is the runtime's own account of the failure, and the classification is read
 * from it: the report's title in the headline, its message as what happened
 * (with the provider's raw text taken out, see `visibleReportMessage`), its
 * user action's detail as the next step, its `retryable` verdict as the retry
 * advice, and a support line naming the run, the error type and when it ended.
 *
 * A run with no report keeps the SDK's sentence, which is all there is: a
 * cancelled, terminated or timed-out run, one the platform finalized itself,
 * and any failed run on a platform that does not serve the report.
 */
function classifyRunFailed(err: RunFailedError, finishedAt?: string | null): PipelineError {
  const report = err.error;
  if (!report) {
    return {
      kind: "run_failed",
      title: "The pipeline run failed",
      message:
        err.message ||
        `The run finished in a non-successful state (${err.status}). Check the technical details below.`,
      details: `${err.name}: run ${err.runId} ended ${err.status}\n${err.message}`,
    };
  }

  const title = nonEmpty(report.title);
  const message =
    visibleReportMessage(report) ??
    `The run ended ${err.status}, and its error report does not say why.`;
  const nextStep = nextStepOf(report.user_action);
  const endedAt = formatInstant(finishedAt);
  return {
    kind: "run_failed",
    title: title ? `The pipeline run failed: ${title}` : "The pipeline run failed",
    message,
    ...(nextStep ? { hint: { summary: nextStep } } : {}),
    ...(typeof report.retryable === "boolean" ? { retry: retryAdvice(report.retryable) } : {}),
    support: [`run ${err.runId}`, nonEmpty(report.error_type), endedAt && `failed ${endedAt}`]
      .filter(Boolean)
      .join(" · "),
    details: reportDetails(err, report, message),
  };
}

const RETRYABLE: RetryAdvice = {
  retryable: true,
  summary: "This failure can pass on a second try: run it again.",
};

const NOT_RETRYABLE: RetryAdvice = {
  retryable: false,
  summary: "Running it again unchanged will fail the same way.",
};

function retryAdvice(retryable: boolean): RetryAdvice {
  return retryable ? RETRYABLE : NOT_RETRYABLE;
}

/**
 * The runtime's next step, as a hint. Two kinds of advice are dropped. A
 * `wait_and_retry` advice is written while the runtime is still retrying ("the
 * system will retry automatically"); what this app shows has stopped, and
 * nothing retries it, so the retry line says what to do instead. An `unknown`
 * advice is the runtime's fallback when no cause advised anything, and it
 * points at developer fields the display never shows ("Check pipe_stack to
 * identify which pipe failed") or back at the message already shown.
 */
function nextStepOf(action: UserAction | null | undefined): string | undefined {
  if (action?.kind === "wait_and_retry" || action?.kind === "unknown") return undefined;
  return nonEmpty(action?.detail);
}

/**
 * The report's message as a person may read it. A failure that came back from
 * a model provider carries the provider SDK's own text inside the runtime's
 * message (`<provider> inference failed for model '<model>' (HTTP 412): <the
 * provider's text>`), and that text is raw: a repr of the provider's error
 * body, or a whole HTML page from an edge in front of it, naming the
 * deployment's own provider account. The report says which text is the
 * provider's (`provider_metadata.message`), so it is cut out wherever it
 * appears, with the separator before it; what remains names the failing pipe,
 * the provider, the model and the HTTP status. Undefined when nothing is left.
 */
function visibleReportMessage(report: RunErrorReport): string | undefined {
  const message = nonEmpty(report.message);
  if (!message) return undefined;
  const providerText = nonEmpty(report.provider_metadata?.message);
  if (!providerText) return message;
  const cut = message.split(`: ${providerText}`).join("").split(providerText).join("");
  return nonEmpty(cut.replace(/[\s:]+$/, ""));
}

/**
 * The report's classification for the "Technical details" section: every field
 * a developer reads to place the failure, and the validation items of a method
 * that failed validation. The provider's metadata is left out, for the reason
 * `visibleReportMessage` gives, and the message is the one shown above.
 */
function reportDetails(err: RunFailedError, report: RunErrorReport, message: string): string {
  return [
    `${err.name}: run ${err.runId} ended ${err.status}`,
    detailLine("error_type", report.error_type),
    detailLine("error_domain", report.error_domain),
    detailLine("error_category", report.error_category),
    detailLine("retryable", report.retryable),
    detailLine("user_action", report.user_action?.kind),
    detailLine("model", report.model),
    detailLine("type_uri", report.type_uri),
    `message: ${message}`,
    ...validationLines(report.validation_errors),
  ]
    .filter(Boolean)
    .join("\n");
}

/** One `name: value` line of technical details, or null when there is no value. */
function detailLine(name: string, value: unknown): string | null {
  const text = typeof value === "boolean" ? String(value) : nonEmpty(value);
  return text === undefined ? null : `${name}: ${text}`;
}

/**
 * The locators an `unknown_model` validation item carries beside the declared
 * fields: the model reference exactly as the method wrote it, and the model
 * deck's close matches. The runtime sends them; the SDK's `ValidationErrorItem`
 * does not name them yet, so they are read as optional extensions.
 */
type UnknownModelLocators = { model_reference?: unknown; suggestions?: unknown };

/**
 * A method's validation items as lines of technical details, one per item:
 * where it is (the pipe, else the concept), what is wrong, and for an unknown
 * model the reference the method wrote and the deck's suggestions.
 */
function validationLines(items: readonly ValidationErrorItem[] | null | undefined): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((item: ValidationErrorItem & UnknownModelLocators) => {
    const where = nonEmpty(item?.pipe_code) ?? nonEmpty(item?.concept_code);
    const model = nonEmpty(item?.model_reference);
    const suggestions = Array.isArray(item?.suggestions)
      ? item.suggestions.map(nonEmpty).filter((name) => name !== undefined)
      : [];
    const locators = [
      model && `model reference: ${model}`,
      suggestions.length > 0 && `suggestions: ${suggestions.join(", ")}`,
    ].filter(Boolean);
    const text = nonEmpty(item?.message) ?? "(no message)";
    return `validation: ${where ? `${where}: ` : ""}${text}${locators.length > 0 ? ` (${locators.join("; ")})` : ""}`;
  });
}

/** A string with something in it, trimmed; anything else is undefined. */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/**
 * An instant as a support desk reads it: UTC to the second when the value
 * carries its zone, and the value as given otherwise, since a timestamp
 * without one cannot be converted without guessing.
 */
function formatInstant(value: string | null | undefined): string | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const time = new Date(text);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text) || Number.isNaN(time.getTime())) return text;
  return time.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function classifyRunTimeout(err: RunTimeoutError): PipelineError {
  const seconds = Math.round(err.timeoutMs / 1000);
  return {
    kind: "run_timeout",
    title: "Stopped waiting for the run",
    message: `The run for ${err.runId} didn't finish within ~${seconds}s, so the app stopped polling for its result. The run keeps executing on the server — it wasn't cancelled.`,
    hint: {
      summary:
        "Re-run, or allow more time for very long pipelines. The run continues server-side and can be resumed by its id.",
    },
    details: `${err.name}: ${err.message}`,
  };
}

/**
 * The Pipelex API `error_type` for a `/start` refused because the deployment's
 * orchestrator can't run asynchronously (blocking-only `direct` mode). A
 * contract value on the problem body, surfaced by the SDK as `err.errorType`.
 */
const START_REQUIRES_ASYNC_ORCHESTRATION = "StartRequiresAsyncOrchestration";

/**
 * `/start` hit a backend whose orchestrator is blocking-only (the in-process
 * `direct` mode), so the durable start is refused with a 400. Same consumer
 * meaning as the run-lifecycle routes missing outright
 * (`classifyLifecycleUnavailable`, a 404): the configured URL doesn't provide
 * durable execution, which the hosted Pipelex API always does — so the fix is
 * the URL. The server says it in runtime terms ("orchestration mode", "fire-and-forget");
 * we re-frame it as *durable execution* (the word this app uses) and route
 * it to the `lifecycle_unavailable` kind so the UI doesn't show the raw
 * runtime message as a generic bad request. The root cause differs from the
 * 404 case (the route exists; the orchestrator just can't go async), so the
 * copy is tailored rather than shared.
 */
function classifyStartRequiresAsync(err: ApiResponseError): PipelineError {
  const url = err.apiUrl || "(unknown)";
  return {
    kind: "lifecycle_unavailable",
    title: "Durable runs aren't available on this API",
    message: `${url} refused the durable start because it can only run pipelines synchronously — something the Pipelex hosted API never does, so this URL isn't it. Check PIPELEX_BASE_URL.`,
    // Show the runtime's own wording verbatim alongside our re-framing.
    apiMessage: err.serverMessage,
    hint: {
      summary: "Point PIPELEX_BASE_URL at the hosted Pipelex API:",
      code: "PIPELEX_BASE_URL=https://api.pipelex.com",
      codeLanguage: "env",
    },
    details: [
      `${err.name}: HTTP ${err.status} ${err.statusText}`.trim(),
      err.apiUrl ? `API URL: ${err.apiUrl}` : null,
      `error_type: ${err.errorType}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function classifyLifecycleUnavailable(
  err: RunLifecycleUnavailableError,
  env: ClassifyEnv,
): PipelineError {
  const url = err.apiUrl || env.apiUrl || "(unknown)";
  return {
    kind: "lifecycle_unavailable",
    title: "Durable runs aren't available on this API",
    message: `${url} doesn't serve the durable run lifecycle (start + poll), so it isn't the Pipelex hosted API — check PIPELEX_BASE_URL.`,
    hint: {
      summary: "Point PIPELEX_BASE_URL at the hosted Pipelex API:",
      code: "PIPELEX_BASE_URL=https://api.pipelex.com",
      codeLanguage: "env",
    },
    details: `${err.name}: ${err.message}`,
  };
}

/**
 * Classify an SDK input-preparation failure (`prepareInputs` / `uploadFile`) into
 * a single `upload_failed` kind with subclass-tailored copy — a method with a file input
 * uploads the file to Pipelex storage before the run, and that upload can fail in
 * a few distinct, actionable ways. Mirrors `classifyServerError`'s switch: branch
 * on the concrete subclass, then fall back to the base `InputPreparationError` so
 * any future subclass is still classified (never `unknown`).
 */
function classifyInputPreparationError(
  err: InputPreparationError,
  env: ClassifyEnv,
): PipelineError {
  const details = `${err.name}: ${err.message}`;

  // No upload route (404) — the configured URL doesn't provide the upload
  // capability, which the hosted Pipelex API always does. Steer to the URL.
  if (err instanceof UnsupportedUploadCapabilityError) {
    const url = env.apiUrl || "(unknown)";
    return {
      kind: "upload_failed",
      title: "File upload isn't available on this API",
      message: `Preparing a file input means uploading it to Pipelex storage first, but ${url} has no upload route, so it isn't the Pipelex hosted API — check PIPELEX_BASE_URL.`,
      hint: {
        summary: "Point PIPELEX_BASE_URL at the hosted Pipelex API, which supports upload:",
        code: "PIPELEX_BASE_URL=https://api.pipelex.com",
        codeLanguage: "env",
      },
      details,
    };
  }

  // The server or storage refused the asset; its `code` says why.
  if (err instanceof RejectedAssetError) return classifyRejectedAsset(err);

  // Upload not authorized (401/403) — same fix as run auth, framed for upload.
  if (err instanceof UploadAuthenticationError) {
    return {
      kind: "upload_failed",
      title: "File upload was not authorized",
      message: `Pipelex storage rejected the upload (HTTP ${err.status}) — the PIPELEX_API_KEY is missing or not valid for uploads on this API.`,
      hint: {
        summary: "Check the API key in .env.local and restart the dev server:",
        code: "PIPELEX_API_KEY=your-key-here",
        codeLanguage: "env",
      },
      details,
    };
  }

  // InvalidLocalSourceError, UploadTransportError, a malformed data URL (the base
  // InputPreparationError), or any future subclass — a generic upload failure.
  return {
    kind: "upload_failed",
    title: "Preparing the file for upload failed",
    message:
      "This app couldn't upload the file to Pipelex storage before running the pipeline. The technical details below should help track it down.",
    details,
  };
}

/** The verbatim server message from a preparation error's wrapped API response, if any. */
function causeServerMessage(err: { cause?: unknown }): string | undefined {
  return err.cause instanceof ApiResponseError ? err.cause.serverMessage : undefined;
}

/**
 * What a refused asset means, by the `code` the SDK sets on every one it raises.
 * A grant writes one object, once, within minutes, and only the file it was
 * requested for — so every refusal of an upload with a grant is fixed the same
 * way from the user's side: drop the file again, which asks for a new grant.
 */
function classifyRejectedAsset(err: RejectedAssetError): PipelineError {
  const details = `${err.name}: ${err.message}\nstatus: ${err.status}\ncode: ${err.code ?? "(none)"}\nfilename: ${err.filename}`;
  const again = "Drop the file again to upload it with a new permission.";
  switch (err.code) {
    case "too_large":
      return {
        kind: "upload_failed",
        title: "The file is too large to store",
        message: `Pipelex storage refused "${err.filename}" because it is past the service's size limit. Try a smaller file.`,
        apiMessage: causeServerMessage(err),
        details,
      };
    case "grant_expired":
    case "grant_used":
      return {
        kind: "upload_failed",
        title: "The upload's permission ran out",
        message: `Pipelex storage refused "${err.filename}" because the permission to store it had ${err.code === "grant_expired" ? "expired" : "already been used"}. ${again}`,
        details,
      };
    case "signature_mismatch":
    case "unsigned_header":
      return {
        kind: "upload_failed",
        title: "The file changed before it was stored",
        message: `Pipelex storage refused "${err.filename}" because it no longer matches the size and type the upload was granted for — it may have changed on disk after it was picked. ${again}`,
        details,
      };
    default:
      return {
        kind: "upload_failed",
        title: "The file was rejected by storage",
        message: `Pipelex storage refused "${err.filename}" (HTTP ${err.status}). ${again}`,
        apiMessage: causeServerMessage(err),
        details,
      };
  }
}

/**
 * What an upload that never got storage's verdict means, by the `code` the SDK
 * sets on it. The codes fold by what the user can do: wait on a faster
 * connection, check what blocks the request, try again in a moment, or nothing
 * but report it. The `code:` line in `details` keeps the finer distinction.
 */
function classifyUploadTransport(err: UploadTransportError): PipelineError {
  const details = `${err.name}: ${err.message}${err.status === undefined ? "" : `\nstatus: ${err.status}`}\ncode: ${err.code ?? "(none)"}`;
  switch (err.code) {
    case "timeout":
    case "storage_timeout":
      return {
        kind: "upload_failed",
        title: "The upload took too long",
        message:
          err.code === "timeout"
            ? "The file did not finish uploading in the time allowed for its size, so it was abandoned. A slow connection is the usual cause."
            : "Pipelex storage stopped waiting for the file's bytes, so nothing was stored. A slow connection is the usual cause.",
        hint: { summary: "Drop the file again, or try a smaller one." },
        details,
      };
    case "unreachable":
      return {
        kind: "upload_failed",
        title: "Could not reach Pipelex storage",
        message:
          "The browser couldn't send the file to Pipelex storage. The network may have dropped, or a browser extension or the page's security policy may have blocked the request.",
        hint: { summary: "Drop the file again. If it keeps failing, check the browser console." },
        details,
      };
    case "server_error":
      return {
        kind: "upload_failed",
        title: "Pipelex storage could not store the file",
        message:
          "Pipelex storage answered with a server error, so the upload may not have completed. This is usually temporary.",
        hint: { summary: "Drop the file again in a moment." },
        details,
      };
    default:
      // `conflict`, `redirected`, `invalid_grant_url`, `unexpected`, or no code:
      // a deployment fault or a path this app never takes, which dropping the
      // file again cures none of reliably.
      return {
        kind: "upload_failed",
        title: "Uploading the file failed",
        message:
          "The upload to Pipelex storage failed. The technical details below should help track it down.",
        details,
      };
  }
}

/**
 * A grant request answered `404`: the configured API does not serve
 * `POST /v1/upload/grant`, so no file input can be stored. The URL is the
 * suspect, as for `lifecycle_unavailable`; no replacement URL is suggested,
 * since which deployments serve the route is theirs to say, not this app's.
 */
function classifyUploadUnavailable(err: ApiResponseError, env: ClassifyEnv): PipelineError {
  const url = err.apiUrl || env.apiUrl || DEFAULT_API_BASE_URL;
  return {
    kind: "upload_unavailable",
    title: "File upload isn't available on this API",
    message: `${url} doesn't serve upload grants (POST /v1/upload/grant), which this app needs to store a file before a run. Check PIPELEX_BASE_URL.`,
    hint: {
      summary:
        "Point PIPELEX_BASE_URL at a Pipelex API that serves upload grants, then restart the dev server.",
    },
    details: `${err.name}: HTTP ${err.status} ${err.statusText}`.trim() + `\nAPI URL: ${url}`,
  };
}

/** A grant request the platform refused as too large (`413`): its limit, in its words. */
function classifyGrantTooLarge(err: ApiResponseError): PipelineError {
  return {
    kind: "file_too_large",
    title: "File too large",
    message: err.serverMessage ?? "The file is past the size limit of Pipelex storage.",
    details: `${err.name}: HTTP ${err.status} ${err.statusText}`.trim(),
  };
}

/**
 * Classify a failure of a file's upload **in the browser**, where the upload
 * runs: `uploadWithGrant` throws the SDK's own classes there, so `instanceof`
 * holds, unlike for an error that crossed the Server Action boundary.
 *
 * - A refusal from storage (`RejectedAssetError`), by its `code`.
 * - An upload that never got storage's verdict (`UploadTransportError`), by its
 *   `code`: the SDK's own time limit, which grows with the file's size, storage
 *   out of reach (in a browser, a cross-origin request the bucket or a
 *   content-security policy refused too), or storage failing.
 * - Anything else is the grant request itself failing to reach this app's
 *   server, which is the transport error every Server Action call can meet.
 */
export function classifyUploadError(err: unknown): PipelineError {
  if (err instanceof RejectedAssetError) return classifyRejectedAsset(err);
  if (err instanceof UploadTransportError) return classifyUploadTransport(err);
  if (err instanceof InputPreparationError) {
    return {
      kind: "upload_failed",
      title: "Uploading the file failed",
      message:
        "This app couldn't store the file in Pipelex storage. The technical details below should help track it down.",
      details: `${err.name}: ${err.message}`,
    };
  }
  return classifyTransportError(err);
}

/**
 * A host's `prepareFile` (see `useFileInputs`) threw before the upload began, so
 * nothing was sent. Not a transport error: the browser never tried to reach
 * anything, and saying so would send the user after the wrong cause.
 */
export function buildFilePreparationError(err: unknown): PipelineError {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Unknown";
  return {
    kind: "upload_failed",
    title: "The file could not be prepared",
    message:
      "This app could not prepare the file for upload, so nothing was sent. The technical details below should help track it down.",
    hint: { summary: "Try another file, or the same file saved again." },
    details: `${name}: ${message}`,
  };
}

function classifyBadOutput(err: BadPipelineOutputError): PipelineError {
  return {
    kind: "bad_response",
    title: "Pipeline output didn't match the expected shape",
    message:
      "The pipeline ran but its output didn't match the shape this app expects. This usually means the bundle was edited or the LLM produced something unexpected.",
    details: `${err.name}: ${err.message}`,
  };
}

function classifyBundleMissing(err: unknown): PipelineError {
  const e = err as NodeJS.ErrnoException;
  return {
    kind: "bundle_load_failed",
    title: "Method bundle not found",
    message: `Could not read the .mthds bundle from disk (${e.code ?? "fs error"}). Each method reads its bundle from its own directory under methods/ — make sure the .mthds files are still there.`,
    details: `${e.name}: ${e.message}`,
  };
}

/**
 * Classify a client-side rejection of an awaited Server Action call.
 *
 * Distinct from `classifyPipelineError`: the Server Action's own try/catch
 * already routes every application-level failure into a structured
 * `{ ok: false, error }` result, so a rejected await here is by construction
 * a *transport* failure — the browser couldn't deliver the request, the dev
 * server died mid-call, or the page is running against a stale build whose
 * Server Action IDs no longer resolve. The SDK error classes referenced by
 * `classifyPipelineError` only exist server-side and are stripped to opaque
 * digests when crossing the boundary in production, so they would never
 * `instanceof`-match here. Without this helper, rejections inside
 * `startTransition` bypass `<ErrorDisplay>` and bubble to React's nearest
 * error boundary instead.
 */
export function classifyTransportError(err: unknown): PipelineError {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Unknown";
  return {
    kind: "transport_error",
    title: "Could not reach the server",
    message:
      "The browser couldn't deliver the request to the Next.js server. The dev server may have stopped, the network may have dropped, or this page may be running against a stale build whose Server Action IDs no longer exist on the deployed server.",
    hint: {
      summary:
        "Reload the page. If the problem persists, check your network and confirm the server is reachable.",
    },
    details: `${name}: ${message}`,
  };
}

/**
 * Build a `run_timeout` PipelineError for the client-side durable poll ceiling.
 *
 * Distinct from the `RunTimeoutError` branch in `classifyPipelineError`: that
 * one classifies an SDK error thrown server-side; this one is built inline on
 * the client when `useRun` stops its own poll loop after `maxDurationMs`. There
 * is no thrown error to classify — the client just stopped waiting. The run
 * keeps executing server-side and can be re-polled by its id.
 */
export function buildClientTimeoutError(elapsedMs: number): PipelineError {
  const seconds = Math.round(elapsedMs / 1000);
  return {
    kind: "run_timeout",
    title: "Stopped waiting for the run",
    message: `The run didn't finish within ~${seconds}s, so the app stopped polling for its result. The run keeps executing on the server — it wasn't cancelled.`,
    hint: {
      summary:
        "Re-run to start fresh. Very long pipelines may need a higher poll ceiling (the maxDurationMs passed to useRun).",
    },
    details: `Client poll ceiling reached after ~${seconds}s.`,
  };
}

/**
 * Build an `inputs_too_large` PipelineError for a run whose inputs, files aside,
 * are past `MAX_RUN_INPUT_BYTES` (`src/lib/runRequest.ts`). Built inline on the
 * client by `useRun`, before the Server Action is called: Next would refuse the
 * body before the action ran, and the browser would only see a rejected call.
 */
export function buildInputsTooLargeError(bytes: number, maxBytes: number): PipelineError {
  const megabytes = (n: number) => {
    const value = n / 1_000_000;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  };
  return {
    kind: "inputs_too_large",
    title: "The inputs are too large to send",
    message: `The inputs come to ${megabytes(bytes)} MB, and this app sends at most ${megabytes(maxBytes)} MB in one run. Files don't count toward it: the limit is on text and other values typed or pasted into the form.`,
    hint: { summary: "Shorten the longest text and run again." },
    details: `inputs_too_large: ${bytes} bytes, limit ${maxBytes} bytes`,
  };
}

function classifyUnknown(err: unknown): PipelineError {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Unknown";
  return {
    kind: "unknown",
    title: "Something went wrong",
    message:
      "This app caught an unexpected error. The technical details below should help track it down.",
    details: `${name}: ${message}`,
  };
}

function isFsNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (truncated)`;
}
