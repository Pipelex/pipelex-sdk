// Import from the `@pipelex/sdk` barrel. This module is bundled into the client
// (client components import `classifyTransportError` and the `PipelineError`
// type from here), so it must carry no Node built-ins. The barrel is
// client-safe: `PipelexApiClient` is fetch-based and nothing in the graph pulls
// `node:fs`/`node:path`, so a client bundler handles it without breaking
// `make build`. Only `pipelexClient.ts` (server-only) constructs the client
// itself.
import {
  ApiResponseError,
  ApiUnreachableError,
  DEFAULT_API_BASE_URL,
  PipelineExecuteTimeoutError,
  RejectedAssetError,
  RunTimeoutError,
  UploadTransportError,
  formatItem,
  formatSuggestedFix,
  isProblem,
  isProblemError,
  problemDomain,
  problemRequestId,
  problemRetry,
  problemStepKind,
  readProblemBody,
  type Problem,
  type ProblemDomain,
  type ProblemError,
  type ProblemItem,
  type RetryVerdict,
} from "@pipelex/sdk";
import { BadImageOutputError, BadPipelineOutputError } from "@/types/pipelineError";

export type PipelineErrorKind =
  | "api_unreachable"
  | "config_invalid"
  | "auth_missing"
  | "auth_invalid"
  // A request the API refused, or the SDK refused before sending it, for a
  // fault on the caller's side: its problem's `domain` is `input`, `method` or
  // `account`. A local gate also builds it inline (`gateRunInputs`).
  | "bad_request"
  // A request the API refused for a fault on its own side: its problem's
  // `domain` is `runtime` or `operator`.
  | "server_error"
  | "bundle_load_failed"
  | "bad_response"
  | "bad_image_output"
  | "transport_error"
  // Dual-mode run-lifecycle kinds. `execute_timeout` / `run_still_running`
  // come from the **blocking** path (the hosted gateway's ~30s cap); the rest
  // from the **durable** path (start + poll). All are produced by
  // `classifyPipelineError` from the problem's code, except `run_timeout`,
  // which is also built inline by the client poll ceiling
  // (`buildClientTimeoutError`).
  | "execute_timeout"
  | "run_still_running"
  | "run_failed"
  | "run_timeout"
  | "lifecycle_unavailable"
  // A durable start failed after it left, so the run may have started without
  // its id reaching this app (`client.outcome_unknown`).
  | "outcome_unknown"
  // A file input's upload failed. The browser sends a dropped file straight to
  // Pipelex storage with an upload grant (`useFileInputs`), and that can fail in
  // a few distinct, actionable ways — read by `classifyUploadError` from the
  // SDK's `reason` — or by `buildFilePreparationError`, when the host's own
  // `prepareFile` throws or the file cannot be read to compute its SHA-256.
  | "upload_failed"
  // The configured API does not serve `POST /v1/upload/grant`, or upload at
  // all, so a file cannot be stored.
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
   * The verbatim words of the Pipelex API's problem document, when our
   * `message` is a *re-framing* of them (e.g. a runtime-vocabulary refusal we
   * restate in the starter's own terms). Rendered as its own block next to our
   * interpretation so the template demonstrates raw-API-response vs.
   * handled-error UX side by side. Omitted when our `message` already is the
   * API's text (no value in showing it twice).
   */
  apiMessage?: string;
  /** The next step, chosen from the problem's `next_step.kind`. */
  hint?: ErrorHint;
  /**
   * Who must act, read from the problem's `domain`: the person's inputs
   * (`input`), the method's author (`method`), the account's owner (`account`),
   * whoever runs the deployment (`operator`), or nobody beforehand, a fault in
   * the service (`runtime`). `<ErrorDisplay>` takes its tone from it. Absent
   * for a failure that carries no problem, such as a Server Action call the
   * browser could not deliver, and for a call this app built wrong, which no
   * one using the app can fix.
   */
  domain?: ProblemDomain;
  /**
   * Whether running it again can succeed, from the problem's `retry`, so it is
   * set whenever the failure carries a problem and absent otherwise: the
   * display never claims either way on a guess.
   */
  retry?: RetryAdvice;
  /** The problem's registered code, the value a program branches on. */
  code?: string;
  /** The id of the request that failed, when the API gave one: what support looks it up by. */
  requestId?: string;
  /**
   * One line a person quotes to support: the run's id or the request's, the
   * code of what failed, and when. `<ErrorDisplay>` shows it selectable, where
   * it can be copied, in place of the bare run id.
   */
  support?: string;
  /** Raw technical info for the collapsible "Technical details" section. */
  details: string;
}

export interface RetryAdvice {
  /**
   * The problem's verdict: `yes` when running it again can succeed, `no` when
   * it fails the same way, and `outcome_unknown` when the run may already have
   * started, so it is looked up before anything is started again.
   */
  verdict: RetryVerdict;
  /** The sentence that says so. */
  summary: string;
  /** The seconds to wait first, when the problem gives them (`retry_after`). */
  afterSeconds?: number;
}

export interface ClassifyEnv {
  apiUrl: string | undefined;
  hasApiKey: boolean;
}

export interface ClassifyOptions {
  /**
   * Set by the blocking path (`executeBlockingRun`). Behind the hosted gateway a
   * synchronous `execute` that overruns the ~30s cap is cut off, and the SDK
   * reads every such ending (its own `PipelineExecuteTimeoutError`, a gateway
   * `502`/`504` with no problem document, a connection lost after the request
   * left) as `client.outcome_unknown`: the run may still be going. Only on the
   * blocking path is that the cap, whose remedy is durable runs; on the durable
   * path it is a start whose outcome is unknown, and the flag scopes the
   * reading.
   */
  blocking?: boolean;
  /**
   * Set by `grantFileUpload`, whose one request is `POST /v1/upload/grant`. A
   * `request.not_found` there means the configured API does not serve upload
   * grants, and a `request.too_large` is the platform refusing a declared size
   * over its limit, which is the authority on "too large".
   */
  uploadGrant?: boolean;
  /**
   * Set by `pollDurableRun` for a run that ended without a result: when it
   * ended, from the run's status read (`finished_at`). A failed run's support
   * line carries it, because it is what finds the run in the server's logs.
   */
  finishedAt?: string | null;
}

/**
 * Classify a failure into what the person reads. Every error the SDK throws
 * carries its failure as a problem document, so the classification reads the
 * problem: its `code` for the few failures this app words in its own terms,
 * its `domain` for who must act, its `next_step.kind` for what to do, its
 * `retry` for whether running it again can help, and its `request_id` for
 * support. It never branches on an SDK error's class name, an HTTP status or
 * a message: a class is read with `instanceof` only for data it alone carries,
 * such as the network code of an API out of reach.
 */
export function classifyPipelineError(
  err: unknown,
  env: ClassifyEnv,
  opts?: ClassifyOptions,
): PipelineError {
  if (isProblemError(err)) return classifyProblem(err, env, opts ?? {});
  if (err instanceof BadPipelineOutputError) return classifyBadOutput(err);
  if (err instanceof BadImageOutputError) return classifyBadImageOutput(err);
  if (isFsNotFound(err)) return classifyBundleMissing(err);
  return classifyUnknown(err);
}

function classifyProblem(
  err: ProblemError,
  env: ClassifyEnv,
  opts: ClassifyOptions,
): PipelineError {
  // What a code means here can depend on which call this app was making.
  if (opts.uploadGrant && err.code === "request.not_found") {
    return classifyUploadUnavailable(err, env);
  }
  if (opts.uploadGrant && err.code === "request.too_large") return classifyGrantTooLarge(err);
  if (opts.blocking && err.code === "client.outcome_unknown") return classifyBlockingCutOff(err);
  if (opts.blocking && err.code === "client.follow_failed") return classifyRunStillRunning(err);

  switch (err.code) {
    case "client.unreachable":
    case "client.timeout":
      return classifyUnreachable(err, env);
    case "client.not_configured":
      return classifyConfigRefusal(err, env);
    case "client.argument_invalid":
      return classifyRefusedCall(err);
    case "client.outcome_unknown":
      return classifyOutcomeUnknown(err);
    case "client.follow_failed":
      return classifyRunTimeout(err);
    case "client.response_unreadable":
      return classifyUnreadableAnswer(err);
    case "run.failed":
      return classifyRunFailed(err, opts.finishedAt);
    case "runtime.unsupported":
      return classifyUnsupported(err, env);
  }
  if (
    err.code === "auth.missing_credential" ||
    err.code === "auth.invalid_credential" ||
    err.code === "auth.credential_expired" ||
    problemStepKind(err.problem) === "check_credentials"
  ) {
    return classifyCredentials(err, env);
  }
  return classifyRefusal(err);
}

// ── Reading a problem ────────────────────────────────────────────────

/**
 * The parts every classified problem carries, read from it whole: who must
 * act, whether running it again can help, its code, the request's id and the
 * line to quote to support. Each arm adds its title, message and hint.
 */
function problemParts(
  problem: Problem,
  requestId?: string,
): Pick<PipelineError, "domain" | "retry" | "code" | "requestId" | "support"> {
  const id = requestId ?? problemRequestId(problem);
  return {
    domain: problemDomain(problem),
    retry: retryAdvice(problem),
    code: problem.code,
    ...(id !== undefined ? { requestId: id } : {}),
    support: [runIdOf(problem) && `run ${runIdOf(problem)}`, problem.code]
      .concat(id !== undefined ? [`request ${id}`] : [])
      .filter(Boolean)
      .join(" · "),
  };
}

/** The parts of the problem a ProblemError carries, with the request id it knows. */
function errorParts(err: ProblemError) {
  return problemParts(err.problem, err.requestId);
}

/**
 * The next step, from the problem's `next_step.kind`. A `retry` or `wait`
 * step is the retry line's to say, which knows the delay, so it brings no
 * hint of its own; every other step is its own sentence.
 */
function nextStepHint(problem: Problem): ErrorHint | undefined {
  const kind = problemStepKind(problem);
  if (kind === "retry" || kind === "wait") return undefined;
  const summary = nonEmpty(problem.next_step?.detail);
  return summary === undefined ? undefined : { summary };
}

/** Whether running it again can succeed, in the problem's own verdict. */
function retryAdvice(problem: Problem): RetryAdvice {
  const verdict = problemRetry(problem);
  const afterSeconds =
    typeof problem.retry_after === "number" && problem.retry_after > 0
      ? problem.retry_after
      : undefined;
  switch (verdict) {
    case "yes":
      return {
        verdict,
        summary:
          afterSeconds === undefined
            ? "This failure can pass on a second try: run it again."
            : `This failure can pass on a second try: run it again in ${Math.ceil(afterSeconds)} seconds.`,
        ...(afterSeconds !== undefined ? { afterSeconds } : {}),
      };
    case "outcome_unknown":
      return {
        verdict,
        summary:
          "The run may already have started: look it up by its id before running it again, so it is not paid for twice.",
      };
    case "no":
      return { verdict, summary: "Running it again unchanged will fail the same way." };
  }
}

/** The answer a refusal came on, when the failure is one: its status, its URL and its raw body. */
function answerOf(err: ProblemError): ApiResponseError | undefined {
  return err instanceof ApiResponseError ? err : undefined;
}

/**
 * Whether the API answered with a problem document of its own. When it did
 * not, an edge or a proxy answered with a bare status, and the problem is the
 * SDK's reading of that status, which the details say.
 */
function apiAnsweredProblem(err: ProblemError): boolean {
  const answer = answerOf(err);
  return answer !== undefined && readProblemBody(answer.responseBody) !== undefined;
}

/**
 * The problem as a developer places it, for the "Technical details" section:
 * the answer it came on, its code and verdict, the request and the run it
 * names, its parameters, and each of its items with where it is, its close
 * matches and its suggested fix. The raw body closes the list, after the
 * items, since its truncation could cut one off.
 */
function problemDetails(err: ProblemError, problem: Problem = err.problem): string {
  const answer = answerOf(err);
  const lines: (string | null)[] = [
    answer
      ? `${err.name}: HTTP ${answer.status} ${answer.statusText}`.trim()
      : `${err.name}: ${err.message}`,
    // Always surface which endpoint was hit — URLs change often in dev, and an
    // answer otherwise gives no hint about *which* backend sent it.
    answer?.apiUrl ? `API URL: ${answer.apiUrl}` : null,
    answer && !apiAnsweredProblem(err)
      ? "problem: the SDK's reading of the HTTP status, not a document the API sent"
      : null,
    ...problemLines(problem, err.requestId),
    answer?.responseBody ? `body: ${truncate(answer.responseBody, 2000)}` : null,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

/** A problem's members as lines of technical details, one per member it carries. */
function problemLines(problem: Problem, requestId?: string): string[] {
  const id = requestId ?? problemRequestId(problem);
  return [
    `code: ${problem.code}`,
    `domain: ${problemDomain(problem)}`,
    `retry: ${problemRetry(problem)}${typeof problem.retry_after === "number" ? ` (after ${problem.retry_after}s)` : ""}`,
    `next_step: ${problemStepKind(problem)}`,
    id !== undefined ? `request_id: ${id}` : null,
    runIdOf(problem) ? `run: ${runIdOf(problem)}` : null,
    problem.params && Object.keys(problem.params).length > 0
      ? `params: ${JSON.stringify(problem.params)}`
      : null,
    ...itemLines(problem.errors),
  ].filter((line): line is string => line !== null);
}

/**
 * A problem's items as lines of technical details, one per fault: its code,
 * what is wrong and where (`formatItem`), then its close matches and its
 * suggested fix when it has them.
 */
function itemLines(items: readonly ProblemItem[] | undefined): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const extras = [
      Array.isArray(item.suggestions) && item.suggestions.length > 0
        ? `suggestions: ${item.suggestions.join(", ")}`
        : null,
      item.suggested_fix ? `fix: ${formatSuggestedFix(item.suggested_fix)}` : null,
    ].filter(Boolean);
    return `item: ${formatItem(item)}${extras.length > 0 ? ` [${extras.join("; ")}]` : ""}`;
  });
}

// ── The arms ─────────────────────────────────────────────────────────

/**
 * Any problem this app has no copy of its own for: a refusal of the API, or a
 * failure the SDK detected. The problem says it all: its title is the
 * headline, its detail what happened, its next step the hint, and its verdict
 * the retry line. The kind follows who must act: a fault on the caller's side
 * (`input`, `method`, `account`) is a rejected request, and one on the
 * service's (`runtime`, `operator`) a server error.
 */
function classifyRefusal(err: ProblemError): PipelineError {
  const parts = errorParts(err);
  const callersSide =
    parts.domain === "input" || parts.domain === "method" || parts.domain === "account";
  const hint = nextStepHint(err.problem);
  return {
    kind: callersSide ? "bad_request" : "server_error",
    title:
      nonEmpty(err.problem.title) ??
      (callersSide ? "The request was refused" : "The service failed"),
    message: nonEmpty(err.problem.detail) ?? err.message,
    ...(hint ? { hint } : {}),
    ...parts,
    details: problemDetails(err),
  };
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

/** The base URL a problem names, else the one the app is configured with. */
function baseUrlOf(err: ProblemError, env: ClassifyEnv): string {
  const named = err.problem.params?.base_url;
  return nonEmpty(named) ?? nonEmpty(answerOf(err)?.apiUrl) ?? env.apiUrl ?? DEFAULT_API_BASE_URL;
}

/**
 * `client.unreachable` or `client.timeout`: the request got no answer from the
 * API, or none in time.
 */
function classifyUnreachable(err: ProblemError, env: ClassifyEnv): PipelineError {
  const url = baseUrlOf(err, env);
  const networkCode = err instanceof ApiUnreachableError ? err.networkCode : undefined;
  const codeSuffix = networkCode ? ` (${networkCode})` : "";
  const noAnswer =
    err.code === "client.timeout"
      ? "the request did not get a response in time"
      : "the request did not get a response";
  const details = `${err.name}: ${err.message}${err.cause instanceof Error ? `\nCaused by: ${err.cause.message}` : ""}\n${problemLines(err.problem, err.requestId).join("\n")}`;
  // The SDK detected this itself, with no answer to read: the problem's
  // `runtime` domain would tell the person the service failed, beside a
  // message that suspects the URL or the network, so no domain is claimed.
  const { domain: _clientDetected, ...parts } = errorParts(err);

  // Split on whether PIPELEX_BASE_URL was *customized*, not merely set — see
  // `isCustomApiUrl`. With a custom URL in play it is the first suspect; on the
  // default hosted URL there is nothing for the user to fix in their config, so
  // point at the network instead.
  if (isCustomApiUrl(env.apiUrl)) {
    return {
      kind: "api_unreachable",
      title: "Pipelex API not reachable",
      message: `Tried to reach ${url}${codeSuffix}, but ${noAnswer}. PIPELEX_BASE_URL is set, so start there: make sure it targets a Pipelex API environment.`,
      hint: {
        summary:
          "Verify PIPELEX_BASE_URL in .env.local targets a Pipelex API environment, or remove the override to fall back to the default:",
        code: "PIPELEX_BASE_URL=https://api.pipelex.com",
        codeLanguage: "env",
      },
      ...parts,
      details,
    };
  }

  return {
    kind: "api_unreachable",
    title: "Pipelex API not reachable",
    message: `Tried to reach the Pipelex API at its default URL, ${url}${codeSuffix}, but ${noAnswer}. Check your network connection.`,
    hint: {
      summary: "Check your network connection, then retry. The URL the app is using is:",
      code: `PIPELEX_BASE_URL=${url}`,
      codeLanguage: "env",
    },
    ...parts,
    details,
  };
}

/**
 * A credential the API refused or did not receive: `auth.missing_credential`,
 * `auth.invalid_credential`, `auth.credential_expired`, or any problem whose
 * next step is `check_credentials`. The key is the deployment's, so the copy speaks to
 * whoever runs the app, whatever step the API wrote for a caller who does not
 * own the account. Whether a key was sent at all is what this app knows and
 * the answer may not say, so it decides the copy.
 */
function classifyCredentials(err: ProblemError, env: ClassifyEnv): PipelineError {
  const url = baseUrlOf(err, env);
  if (!env.hasApiKey) {
    return {
      kind: "auth_missing",
      title: "Pipelex API key missing",
      message: `${url} rejected the request because no PIPELEX_API_KEY was sent.`,
      apiMessage: apiAnsweredProblem(err) ? nonEmpty(err.problem.detail) : undefined,
      hint: {
        summary: "Add your API key to .env.local and restart the dev server:",
        code: "PIPELEX_API_KEY=your-key-here",
        codeLanguage: "env",
      },
      ...errorParts(err),
      details: problemDetails(err),
    };
  }
  return {
    kind: "auth_invalid",
    title: "Pipelex API key rejected",
    message: `${url} refused the credentials you provided. The PIPELEX_API_KEY in .env.local is not valid for this API.`,
    apiMessage: apiAnsweredProblem(err) ? nonEmpty(err.problem.detail) : undefined,
    hint: {
      summary: "Double-check the key and the API URL it's intended for.",
      code: "PIPELEX_API_KEY=your-key-here",
      codeLanguage: "env",
    },
    ...errorParts(err),
    details: problemDetails(err),
  };
}

/**
 * `client.response_unreadable`: an answer the SDK could not read, a `2xx`
 * whose body is not JSON or not the object the route answers among them. The
 * API took the request, so nothing about it was refused; what came back is
 * unusable, and the SDK's message says how. Its verdict is `no`: the same
 * request meets the same answer.
 */
function classifyUnreadableAnswer(err: ProblemError): PipelineError {
  const answer = answerOf(err);
  return {
    kind: "bad_response",
    title: "Pipelex API sent an answer the app could not read",
    message: answer
      ? `The API answered HTTP ${answer.status}, but not with what the route returns, so its answer could not be read. The technical details below show what it sent.`
      : "The API answered, but not with what this app can use. The technical details below say what was wrong.",
    ...errorParts(err),
    details: [
      `${err.name}: ${err.message}`,
      answer?.apiUrl ? `API URL: ${answer.apiUrl}` : null,
      ...problemLines(err.problem, err.requestId),
      answer?.responseBody ? `body: ${truncate(answer.responseBody, 2000)}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * `client.not_configured`: the SDK refused its own configuration before
 * sending any request. The one such refusal is PIPELEX_BASE_URL naming more
 * than a host: endpoints compose as `{base}/v1/{endpoint}`, so a value ending
 * in `/v1` would double the prefix. An unset variable is no refusal, since the
 * SDK falls back to the hosted API. A value is refused exactly when it carries
 * more than a host, which may be credentials or a token, and the details reach
 * every visitor, so they name the parts beyond the host without their text
 * (`describeRefusedBaseUrl`) and never relay a message that might quote it.
 */
function classifyConfigRefusal(err: ProblemError, env: ClassifyEnv): PipelineError {
  return {
    kind: "config_invalid",
    title: "Pipelex API URL not usable",
    message:
      "The SDK refused PIPELEX_BASE_URL before sending any request: it must name only the API's host, with no path such as /v1, no query and no credentials.",
    hint: {
      summary:
        "Set PIPELEX_BASE_URL in .env.local to the API's host alone, or remove it to use the hosted API, then restart the dev server:",
      code: "PIPELEX_BASE_URL=https://api.pipelex.com",
      codeLanguage: "env",
    },
    ...errorParts(err),
    details: [
      `${err.name}: the SDK refused PIPELEX_BASE_URL`,
      describeRefusedBaseUrl(env.apiUrl),
      ...problemLines(err.problem, err.requestId),
    ].join("\n"),
  };
}

/**
 * What a refused PIPELEX_BASE_URL may show a visitor: its scheme and host, and
 * the names of the parts beyond them, never their content, since a password, a
 * token in the query or a key in the path is a secret all the same.
 */
function describeRefusedBaseUrl(value: string | undefined): string {
  if (value === undefined) return "PIPELEX_BASE_URL: not set";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "PIPELEX_BASE_URL: not a URL (the value is not shown)";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "PIPELEX_BASE_URL: not an http or https URL (the value is not shown)";
  }
  const extras = [
    parsed.username || parsed.password ? "credentials" : null,
    parsed.pathname.replace(/\/+$/, "") ? "a path" : null,
    parsed.search ? "a query" : null,
    parsed.hash ? "a fragment" : null,
  ].filter((part): part is string => part !== null);
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (extras.length === 0) return `PIPELEX_BASE_URL: ${origin}`;
  const parts =
    extras.length === 1
      ? extras[0]
      : `${extras.slice(0, -1).join(", ")} and ${extras[extras.length - 1]}`;
  return `PIPELEX_BASE_URL: ${origin}, with ${parts} (not shown)`;
}

/**
 * `client.argument_invalid`: the SDK refused an argument this app passed
 * before sending anything. The problem's `domain` is `input` because the SDK's
 * caller must change the call, and that caller is this app's code, not the
 * person using it, so no tone is claimed for them: the details name the
 * argument and the SDK's own sentence, for whoever maintains the app.
 */
function classifyRefusedCall(err: ProblemError): PipelineError {
  const { domain: _callersDomain, ...parts } = errorParts(err);
  return {
    kind: "unknown",
    title: "This app made a call the SDK refused",
    message:
      "The SDK refused a call this app made before sending anything, which is a fault in this app's code rather than in what you entered. The technical details below name the argument.",
    ...parts,
    details: `${err.name}: ${err.message}\n${problemLines(err.problem, err.requestId).join("\n")}`,
  };
}

/**
 * The remedy for a run too long to await in one request: each example offers
 * both modes, so the hint points at the Durable one, which starts the run and
 * polls for its result.
 */
const USE_DURABLE_RUNS_HINT: ErrorHint = {
  summary:
    "Switch this example to Durable mode. It starts the run and polls for the result, so long pipelines survive the cap.",
};

/**
 * `client.outcome_unknown` on the blocking path: the synchronous `execute`
 * ended without the run's result, cut off at the hosted gateway's ~30s cap
 * (the SDK's `PipelineExecuteTimeoutError`, or the gateway's own `502`/`504`),
 * or a connection lost once the request had left. The run may have started and
 * still be going, which the retry line says; durable runs are the remedy.
 */
function classifyBlockingCutOff(err: ProblemError): PipelineError {
  const seconds =
    err instanceof PipelineExecuteTimeoutError ? Math.round(err.elapsedMs / 1000) : undefined;
  return {
    kind: "execute_timeout",
    title: "Pipeline exceeded the ~30s blocking limit",
    message:
      seconds !== undefined
        ? `The blocking request ran for ~${seconds}s before timing out at the hosted gateway's ~30s synchronous limit. The pipeline isn't broken — it's just too long to await synchronously behind the hosted gateway, and the run may still be going.`
        : "The blocking request ended without the run's result, as it does when it outlasts the hosted gateway's ~30s synchronous limit. The pipeline isn't broken — it's just too long to await synchronously, and the run may still be going.",
    hint: USE_DURABLE_RUNS_HINT,
    ...errorParts(err),
    details: problemDetails(err),
  };
}

/**
 * `client.follow_failed` on the blocking path: the API accepted the
 * synchronous `execute` but answered with the run's id instead of its result
 * (the SDK's `RunStillRunningError`). The run exists and keeps going.
 */
function classifyRunStillRunning(err: ProblemError): PipelineError {
  const runId = runIdOf(err.problem) ?? "(unknown)";
  return {
    kind: "run_still_running",
    title: "The run is still going",
    message: `The blocking request was accepted, but the run hasn't finished — the server returned run id ${runId} instead of a result. Behind the hosted gateway, a long run can't be awaited synchronously.`,
    hint: {
      summary: "Switch this example to Durable mode to start the run and poll it to completion.",
    },
    ...errorParts(err),
    details: problemDetails(err),
  };
}

/**
 * `client.outcome_unknown` on the durable path: the start failed after it
 * left, so the run may have started without its id reaching this app. The
 * next step is `read_run`: look the run up before starting another, which
 * would be paid for twice.
 */
function classifyOutcomeUnknown(err: ProblemError): PipelineError {
  const runId = runIdOf(err.problem);
  return {
    kind: "outcome_unknown",
    title: "The run may have started",
    message: runId
      ? `The start request failed after it reached the API, and the run ${runId} may have started anyway.`
      : "The start request failed after it reached the API, so the run may have started without its id reaching this app.",
    hint: {
      summary: runId
        ? "Look the run up by its id below before running the method again."
        : "Look for the run in the organization's run history before running the method again.",
    },
    ...errorParts(err),
    details: problemDetails(err),
  };
}

/**
 * `client.follow_failed` on the durable path: the SDK stopped waiting for a
 * run that keeps going server-side (`RunTimeoutError`). It was not cancelled,
 * and it is read again by its id, never started again.
 */
function classifyRunTimeout(err: ProblemError): PipelineError {
  const runId = runIdOf(err.problem) ?? "(unknown)";
  const seconds = err instanceof RunTimeoutError ? Math.round(err.timeoutMs / 1000) : undefined;
  return {
    kind: "run_timeout",
    title: "Stopped waiting for the run",
    message: `The run for ${runId} didn't finish${seconds !== undefined ? ` within ~${seconds}s` : ""}, so the app stopped polling for its result. The run keeps executing on the server — it wasn't cancelled.`,
    hint: {
      summary:
        "Allow more time for very long pipelines. The run continues server-side and can be read by its id.",
    },
    ...errorParts(err),
    details: problemDetails(err),
  };
}

/**
 * `run.failed`: a run that ended without a result. Why is the run's own
 * problem, which `run.failed` nests as `run_error` (`RunFailedError.runError`),
 * and the classification reads it: its title in the headline, its detail as
 * what happened, its next step as the hint, its domain as who must act, its
 * verdict as the retry line, and a support line naming the run, the problem's
 * code and when the run ended.
 *
 * A run with no problem of its own keeps the `run.failed` document's sentence,
 * which names the run and its status: one whose start failed, one cancelled or
 * terminated with nothing recorded, and any failed run on a platform that
 * stores no problem. It shows no retry line: the `run.failed` document's
 * verdict judges reading the run again, which only finds it over, and says
 * nothing about whether the run would pass a second time, which nothing
 * recorded decides.
 */
function classifyRunFailed(err: ProblemError, finishedAt?: string | null): PipelineError {
  const nested = err.problem.run_error;
  const runId = runIdOf(err.problem) ?? "(unknown)";
  const endedAt = formatInstant(finishedAt);
  if (!isProblem(nested)) {
    const { retry: _readVerdict, ...parts } = errorParts(err);
    return {
      kind: "run_failed",
      title: "The pipeline run failed",
      message:
        nonEmpty(err.problem.detail) ??
        nonEmpty(err.message) ??
        "The run finished in a non-successful state. Check the technical details below.",
      ...parts,
      // The run's id alone is what to quote: nothing more is recorded.
      support: undefined,
      details: [`${err.name}: run ${runId}`, ...problemLines(err.problem, err.requestId)].join(
        "\n",
      ),
    };
  }

  const title = nonEmpty(nested.title);
  const hint = nextStepHint(nested);
  // The run's own problem names a request when it has one; else the results
  // read that answered `run.failed` is the request to quote.
  const requestId = problemRequestId(nested) ?? err.requestId;
  return {
    kind: "run_failed",
    title: title ? `The pipeline run failed: ${title}` : "The pipeline run failed",
    message: nonEmpty(nested.detail) ?? "The run failed, and its problem does not say why.",
    ...(hint ? { hint } : {}),
    ...problemParts(nested, requestId),
    support: [`run ${runId}`, nested.code, endedAt && `failed ${endedAt}`]
      .concat(requestId !== undefined ? [`request ${requestId}`] : [])
      .filter(Boolean)
      .join(" · "),
    details: [
      `${err.name}: run ${runId} ended ${String(err.problem.params?.run_status ?? "without success")}`,
      ...problemLines(nested, requestId),
    ].join("\n"),
  };
}

/**
 * `runtime.unsupported`: the configured API lacks a capability this app
 * needs. File upload is the upload's; any other, the durable run lifecycle
 * (start + poll) a bare runner does not serve or the asynchronous execution a
 * blocking-only deployment refuses a start for, is durable runs'. The hosted
 * Pipelex API offers both, so the URL is the suspect. When the API said it in
 * its own words, they are shown beside this app's (`apiMessage`).
 */
function classifyUnsupported(err: ProblemError, env: ClassifyEnv): PipelineError {
  const url = baseUrlOf(err, env);
  const apiMessage = apiAnsweredProblem(err) ? nonEmpty(err.problem.detail) : undefined;
  if (err.problem.params?.capability === "file upload") {
    return {
      kind: "upload_unavailable",
      title: "File upload isn't available on this API",
      message: `Preparing a file input means uploading it to Pipelex storage first, but ${url} has no upload route, so it isn't the Pipelex hosted API — check PIPELEX_BASE_URL.`,
      apiMessage,
      hint: {
        summary: "Point PIPELEX_BASE_URL at the hosted Pipelex API, which supports upload:",
        code: "PIPELEX_BASE_URL=https://api.pipelex.com",
        codeLanguage: "env",
      },
      ...errorParts(err),
      details: problemDetails(err),
    };
  }
  return {
    kind: "lifecycle_unavailable",
    title: "Durable runs aren't available on this API",
    message: `${url} doesn't serve durable runs (start, then poll for the result), which the Pipelex hosted API always does, so this URL isn't it — check PIPELEX_BASE_URL.`,
    apiMessage,
    hint: {
      summary: "Point PIPELEX_BASE_URL at the hosted Pipelex API:",
      code: "PIPELEX_BASE_URL=https://api.pipelex.com",
      codeLanguage: "env",
    },
    ...errorParts(err),
    details: problemDetails(err),
  };
}

/**
 * A grant request answered `request.not_found`: the configured API does not
 * serve `POST /v1/upload/grant`, so no file input can be stored. The URL is
 * the suspect, as for `lifecycle_unavailable`; no replacement URL is
 * suggested, since which deployments serve the route is theirs to say, not
 * this app's.
 */
function classifyUploadUnavailable(err: ProblemError, env: ClassifyEnv): PipelineError {
  const url = baseUrlOf(err, env);
  return {
    kind: "upload_unavailable",
    title: "File upload isn't available on this API",
    message: `${url} doesn't serve upload grants (POST /v1/upload/grant), which this app needs to store a file before a run. Check PIPELEX_BASE_URL.`,
    hint: {
      summary:
        "Point PIPELEX_BASE_URL at a Pipelex API that serves upload grants, then restart the dev server.",
    },
    ...errorParts(err),
    details: problemDetails(err),
  };
}

/** A grant request the platform refused as too large (`request.too_large`): its limit, in its words. */
function classifyGrantTooLarge(err: ProblemError): PipelineError {
  return {
    kind: "file_too_large",
    title: "File too large",
    message: nonEmpty(err.problem.detail) ?? "The file is past the size limit of Pipelex storage.",
    ...errorParts(err),
    details: problemDetails(err),
  };
}

// ── Uploads, in the browser ──────────────────────────────────────────

/** The API's own words about a refused file, when the refusal came as its problem document. */
function causeApiMessage(err: ProblemError): string | undefined {
  return err.cause instanceof ApiResponseError && apiAnsweredProblem(err.cause)
    ? nonEmpty(err.cause.problem.detail)
    : undefined;
}

/**
 * What a refused asset means, by the `reason` the SDK sets on every one it
 * raises, the closed vocabulary of what storage refused. A grant writes one
 * object, once, within minutes, and only the file it was requested for — so
 * every refusal of an upload with a grant is fixed the same way from the
 * user's side: drop the file again, which asks for a new grant.
 */
function classifyRejectedAsset(err: RejectedAssetError): PipelineError {
  const details = `${err.name}: ${err.message}\nstatus: ${err.status}\nreason: ${err.reason ?? "(none)"}\nfilename: ${err.filename}\n${problemLines(err.problem, err.requestId).join("\n")}`;
  const again = "Drop the file again to upload it with a new permission.";
  const parts = errorParts(err);
  switch (err.reason) {
    case "too_large":
      return {
        kind: "upload_failed",
        title: "The file is too large to store",
        message: `Pipelex storage refused "${err.filename}" because it is past the service's size limit. Try a smaller file.`,
        apiMessage: causeApiMessage(err),
        ...parts,
        details,
      };
    case "grant_expired":
    case "grant_used":
      return {
        kind: "upload_failed",
        title: "The upload's permission ran out",
        message: `Pipelex storage refused "${err.filename}" because the permission to store it had ${err.reason === "grant_expired" ? "expired" : "already been used"}. ${again}`,
        ...parts,
        details,
      };
    case "signature_mismatch":
    case "unsigned_header":
      return {
        kind: "upload_failed",
        title: "The file changed before it was stored",
        message: `Pipelex storage refused "${err.filename}" because it no longer matches the size and type the upload was granted for — it may have changed on disk after it was picked. ${again}`,
        ...parts,
        details,
      };
    default:
      return {
        kind: "upload_failed",
        title: "The file was rejected by storage",
        message: `Pipelex storage refused "${err.filename}" (HTTP ${err.status}). ${again}`,
        apiMessage: causeApiMessage(err),
        ...parts,
        details,
      };
  }
}

/**
 * The problems the SDK builds itself for an upload that never got storage's
 * verdict: `client.timeout` and `client.unreachable` from `uploadWithGrant`,
 * and `runtime.unavailable`, its reading of a timeout or an unreachable
 * storage by the reason alone. None says who failed.
 */
const CONNECTION_READINGS: ReadonlySet<string> = new Set([
  "client.timeout",
  "client.unreachable",
  "runtime.unavailable",
]);

/**
 * What a transport failure of an upload means, by the `reason` the SDK sets on
 * every one it raises. The time limit is the SDK's own, which grows with the
 * file's size. Dropping the file again asks for a new grant, so that is the
 * retry, offered wherever the problem's verdict says a retry can succeed.
 */
function classifyUploadTransport(err: UploadTransportError): PipelineError {
  const status = err.status === undefined ? "" : `\nstatus: ${err.status}`;
  const details = `${err.name}: ${err.message}\nreason: ${err.reason ?? "(none)"}${status}\n${problemLines(err.problem, err.requestId).join("\n")}`;
  const parts = errorParts(err);
  const canPass = parts.retry?.verdict === "yes";
  // A timeout or storage out of reach is the connection's, not the service's
  // failure, and the messages say so. When the problem is the SDK's own reading
  // of it, which knows no more than that, no domain is claimed; a problem
  // storage or the API answered with keeps its domain, so whoever must act is
  // still named.
  const { domain: _connection, ...withoutDomain } = parts;
  const connectionParts = CONNECTION_READINGS.has(err.code) ? withoutDomain : parts;
  switch (err.reason) {
    case "timeout":
      return {
        kind: "upload_failed",
        title: "The upload took too long",
        message:
          "The file did not finish uploading in the time allowed for its size, so it was abandoned. A slow connection is the usual cause.",
        ...(canPass ? { hint: { summary: "Drop the file again, or try a smaller one." } } : {}),
        ...connectionParts,
        details,
      };
    case "storage_timeout":
      return {
        kind: "upload_failed",
        title: "The upload stalled",
        message:
          "Pipelex storage stopped waiting for the rest of the file and stored nothing. A slow or interrupted connection is the usual cause.",
        ...(canPass ? { hint: { summary: "Drop the file again." } } : {}),
        ...connectionParts,
        details,
      };
    case "unreachable":
      // In a browser this includes a cross-origin request the bucket or a
      // content-security policy refused.
      return {
        kind: "upload_failed",
        title: "Could not reach Pipelex storage",
        message:
          "The browser couldn't send the file to Pipelex storage. The network may have dropped, or a browser extension or the page's security policy may have blocked the request.",
        ...(canPass
          ? {
              hint: {
                summary: "Drop the file again. If it keeps failing, check the browser console.",
              },
            }
          : {}),
        ...connectionParts,
        details,
      };
    case "server_error":
      // Storage's `501`, a request it does not implement, is the one server
      // error whose problem is final: it stored nothing, and the same upload
      // meets the same answer.
      if (!canPass) {
        return {
          kind: "upload_failed",
          title: "Pipelex storage can't take this upload",
          message: `Pipelex storage answered that it does not support this upload${err.status === undefined ? "" : ` (HTTP ${err.status})`}, so nothing was stored, and dropping the file again meets the same answer.`,
          ...parts,
          details,
        };
      }
      return {
        kind: "upload_failed",
        title: "Pipelex storage had a problem",
        message: `Pipelex storage answered with a server error${err.status === undefined ? "" : ` (HTTP ${err.status})`}, so the file may not have been stored. This is usually temporary.`,
        hint: { summary: "Drop the file again in a moment." },
        ...parts,
        details,
      };
    default:
      // `conflict`, `redirected`, `invalid_grant_url` and `unexpected`: none has a
      // cause the user can act on beyond a retry, so the SDK's message says which,
      // and the retry is offered only where the problem's verdict says it can
      // help (storage timing out or throttling the upload, or two writes colliding).
      return {
        kind: "upload_failed",
        title: "Uploading the file failed",
        message:
          "The browser couldn't finish sending the file to Pipelex storage. The technical details below name the cause.",
        ...(canPass ? { hint: { summary: "Drop the file again." } } : {}),
        ...parts,
        details,
      };
  }
}

/**
 * Classify a failure of a file's upload **in the browser**, where the upload
 * runs: `uploadWithGrant` throws the SDK's own errors there, unlike an error
 * that crossed the Server Action boundary.
 *
 * - A refusal from storage (`RejectedAssetError`), by its `reason`.
 * - An upload that never got storage's verdict (`UploadTransportError`), by its
 *   `reason`: the SDK's own time limit, which grows with the file's size,
 *   storage out of reach (in a browser, a cross-origin request the bucket or a
 *   content-security policy refused too), or storage failing.
 * - Any other problem, read from the problem as any refusal is.
 * - Anything else is the grant request itself failing to reach this app's
 *   server, which is the transport error every Server Action call can meet.
 *
 * The two upload errors are told apart only to read their `reason`, which
 * each words from its own closed vocabulary; what to do is the problem's.
 */
export function classifyUploadError(err: unknown): PipelineError {
  if (err instanceof RejectedAssetError) return classifyRejectedAsset(err);
  if (err instanceof UploadTransportError) return classifyUploadTransport(err);
  if (isProblemError(err)) {
    const hint = nextStepHint(err.problem);
    return {
      kind: "upload_failed",
      title: "Uploading the file failed",
      message:
        nonEmpty(err.problem.detail) ??
        "The starter couldn't store the file in Pipelex storage. The technical details below should help track it down.",
      ...(hint ? { hint } : {}),
      ...errorParts(err),
      details: problemDetails(err),
    };
  }
  return classifyTransportError(err);
}

/**
 * The file could not be prepared for its upload, so nothing was sent: a host's
 * `prepareFile` (see `useFileInputs`) threw, or the SDK's `describeUpload` could
 * not read the file to compute its SHA-256, as when it changed on disk since it
 * was picked. Not a transport error: the browser never tried to reach anything,
 * and saying so would send the user after the wrong cause.
 */
export function buildFilePreparationError(err: unknown): PipelineError {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "Unknown";
  return {
    kind: "upload_failed",
    title: "The file could not be prepared",
    message:
      "The starter could not prepare the file for upload, so nothing was sent. The technical details below should help track it down.",
    hint: { summary: "Try another file, or the same file saved again." },
    details: `${name}: ${message}`,
  };
}

// ── Failures that carry no problem ───────────────────────────────────

function classifyBadOutput(err: BadPipelineOutputError): PipelineError {
  return {
    kind: "bad_response",
    title: "Pipeline output didn't match the expected shape",
    message:
      "The pipeline ran but its output didn't match the shape this example expects. This usually means the bundle was edited or the LLM produced something unexpected.",
    details: `${err.name}: ${err.message}`,
  };
}

function classifyBadImageOutput(err: BadImageOutputError): PipelineError {
  if (err.nonWebUrl) {
    return {
      kind: "bad_image_output",
      title: "Generated image isn't web-accessible",
      message:
        "The pipeline generated an image, but the API returned a URL a browser can't load. The Pipelex hosted API returns signed web URLs, so check that PIPELEX_BASE_URL targets it.",
      hint: {
        summary: "Point PIPELEX_BASE_URL at the hosted Pipelex API:",
        code: "PIPELEX_BASE_URL=https://api.pipelex.com",
        codeLanguage: "env",
      },
      details: `${err.name}: ${err.message}`,
    };
  }
  return {
    kind: "bad_image_output",
    title: "Image generation returned no usable image",
    message:
      "The pipeline ran but its output didn't contain an image URL. The image model may have refused the prompt or returned an unexpected shape.",
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
 * Server Action IDs no longer resolve. The SDK's errors only exist
 * server-side and are stripped to opaque digests when crossing the boundary in
 * production, so no problem survives to be read here. Without this helper,
 * rejections inside `startTransition` bypass `<ErrorDisplay>` and bubble to
 * React's nearest error boundary instead.
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
 * Distinct from the `client.follow_failed` arm of `classifyPipelineError`:
 * that one classifies an SDK error thrown server-side; this one is built
 * inline on the client when `useRun` stops its own poll loop after
 * `maxDurationMs`. There is no thrown error to classify — the client just
 * stopped waiting. The run keeps executing server-side and can be re-polled by
 * its id.
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
  const megabytes = (tenths: number) => {
    const value = tenths / 10;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  };
  // The size rounds up and the limit rounds down, so an input only just past
  // the limit still reads as larger than it (1.1 MB, never 1.0 MB).
  const size = megabytes(Math.ceil(bytes / 100_000));
  const limit = megabytes(Math.floor(maxBytes / 100_000));
  return {
    kind: "inputs_too_large",
    title: "The inputs are too large to send",
    message: `The inputs come to ${size} MB, and the starter sends at most ${limit} MB in one run. Files don't count toward it: the limit is on text and other values typed or pasted into the form.`,
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
      "The starter caught an unexpected error. The technical details below should help track it down.",
    details: `${name}: ${message}`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** The run a problem names: its `pipeline_run_id`, else the parameter of that name. */
function runIdOf(problem: Problem): string | undefined {
  return nonEmpty(problem.pipeline_run_id) ?? nonEmpty(problem.params?.pipeline_run_id);
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
