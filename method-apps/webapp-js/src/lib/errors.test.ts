import { describe, it, expect } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  ClientAuthenticationError,
  InputPreparationError,
  InvalidLocalSourceError,
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
  type UploadTransportCode,
} from "@pipelex/sdk";
import {
  MODEL_NOT_ENABLED,
  MODEL_NOT_ENABLED_PROVIDER_TEXT,
  RATE_LIMITED,
  RATE_LIMITED_PROVIDER_TEXT,
  WRONG_ITEM_COUNT,
} from "@/test/fixtures/runReports";
import { refusedStart } from "@/test/fixtures/refusals";
import { BadPipelineOutputError } from "@/types/pipelineError";
import {
  buildClientTimeoutError,
  buildInputsTooLargeError,
  classifyPipelineError,
  classifyTransportError,
  classifyUploadError,
  type ClassifyEnv,
} from "./errors";

// An explicitly-set PIPELEX_BASE_URL override pointing somewhere that isn't
// the hosted API (a neutral fixture URL — nothing here documents a runnable
// setup), and the no-override default where the SDK falls back to the hosted
// URL on its own.
const OVERRIDE_ENV: ClassifyEnv = { apiUrl: "https://api.unreachable.example", hasApiKey: true };
const DEFAULT_ENV: ClassifyEnv = { apiUrl: undefined, hasApiKey: true };
const CLOUD_ENV: ClassifyEnv = { apiUrl: "https://api.pipelex.com", hasApiKey: true };

describe("classifyPipelineError — ApiUnreachableError", () => {
  it("steers to PIPELEX_BASE_URL when an override is set", () => {
    const err = new ApiUnreachableError(
      "Could not reach Pipelex API at https://api.unreachable.example (ECONNREFUSED)",
      "https://api.unreachable.example",
      "ECONNREFUSED",
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.title).toBe("Pipelex API not reachable");
    expect(result.message).toContain("ECONNREFUSED");
    expect(result.message).toContain("https://api.unreachable.example");
    expect(result.message).toMatch(/PIPELEX_BASE_URL/);
    expect(result.hint?.summary).toMatch(/PIPELEX_BASE_URL/);
    expect(result.hint?.code).toBe("PIPELEX_BASE_URL=https://api.pipelex.com");
    expect(result.hint?.codeLanguage).toBe("env");
  });

  it("steers to the network when no override is set (default hosted URL)", () => {
    const err = new ApiUnreachableError(
      "Could not reach Pipelex API at https://api.pipelex.com (ENOTFOUND)",
      "https://api.pipelex.com",
      "ENOTFOUND",
    );
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.message).toContain("https://api.pipelex.com");
    expect(result.message).toContain("ENOTFOUND");
    expect(result.message).toMatch(/default URL/);
    expect(result.message).toMatch(/network/i);
    // No override to check — the copy must not tell the user to verify a
    // variable they never set.
    expect(result.message).not.toMatch(/PIPELEX_BASE_URL is set/);
    expect(result.hint?.summary).toMatch(/network/i);
    expect(result.hint?.code).toContain("https://api.pipelex.com");
  });

  // The quick start is `cp .env.example .env.local`, and that file pins the
  // default hosted URL explicitly — so PIPELEX_BASE_URL being *set* is the
  // ordinary case, not a signal that the user chose this URL. Both of these
  // must land on the network branch.
  it("steers to the network when PIPELEX_BASE_URL is set to the SDK default", () => {
    const err = new ApiUnreachableError(
      "Could not reach Pipelex API at https://api.pipelex.com (ENOTFOUND)",
      "https://api.pipelex.com",
      "ENOTFOUND",
    );
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.message).toMatch(/network/i);
    expect(result.message).not.toMatch(/PIPELEX_BASE_URL is set/);
    expect(result.hint?.summary).toMatch(/network/i);
    expect(result.hint?.summary).not.toMatch(/Verify PIPELEX_BASE_URL/);
  });

  it("ignores a trailing slash when comparing against the SDK default", () => {
    const err = new ApiUnreachableError(
      "Could not reach Pipelex API at https://api.pipelex.com (ENOTFOUND)",
      "https://api.pipelex.com",
      "ENOTFOUND",
    );
    const result = classifyPipelineError(err, {
      apiUrl: "https://api.pipelex.com/",
      hasApiKey: true,
    });
    expect(result.hint?.summary).toMatch(/network/i);
  });

  it("handles missing error code", () => {
    const err = new ApiUnreachableError(
      "Could not reach Pipelex API at https://api.unreachable.example (network error)",
      "https://api.unreachable.example",
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.message).not.toContain("undefined");
  });
});

describe("classifyPipelineError — ApiResponseError 401/403", () => {
  it("returns auth_missing when no key is set", () => {
    const err = new ApiResponseError(
      "API POST /endpoint failed (401): Invalid authentication token",
      "https://api.pipelex.com",
      401,
      "Unauthorized",
      JSON.stringify({ detail: "Invalid authentication token" }),
      undefined,
      "Invalid authentication token",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, {
      apiUrl: "https://api.pipelex.com",
      hasApiKey: false,
    });
    expect(result.kind).toBe("auth_missing");
    expect(result.title).toContain("missing");
    expect(result.hint?.code).toContain("PIPELEX_API_KEY");
  });

  it("returns auth_invalid when a key is present", () => {
    const err = new ApiResponseError(
      "API POST /endpoint failed (401): Invalid authentication token",
      "https://api.pipelex.com",
      401,
      "Unauthorized",
      JSON.stringify({ detail: "Invalid authentication token" }),
      undefined,
      "Invalid authentication token",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, {
      apiUrl: "https://api.pipelex.com",
      hasApiKey: true,
    });
    expect(result.kind).toBe("auth_invalid");
    expect(result.title).toContain("rejected");
  });

  it("treats 403 like 401", () => {
    const err = new ApiResponseError(
      "forbidden",
      "x",
      403,
      "Forbidden",
      "",
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, { apiUrl: "x", hasApiKey: true });
    expect(result.kind).toBe("auth_invalid");
  });
});

describe("classifyPipelineError — ApiResponseError 5xx with errorType", () => {
  it("special-cases CredentialsError", () => {
    const err = new ApiResponseError(
      "...",
      "https://api.unreachable.example",
      500,
      "Internal Server Error",
      "",
      "CredentialsError",
      "Missing OPENAI_API_KEY",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.title).toContain("LLM credentials");
    expect(result.message).toContain("Missing OPENAI_API_KEY");
    // The hosted API never lacks provider credentials — the hint steers to the URL.
    expect(result.hint?.summary).toMatch(/PIPELEX_BASE_URL/);
    expect(result.hint?.docs?.href).toContain("docs.pipelex.com");
  });

  it("special-cases PipeOperatorModelAvailabilityError", () => {
    const err = new ApiResponseError(
      "...",
      "x",
      500,
      "",
      "",
      "PipeOperatorModelAvailabilityError",
      "no backend",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.title).toContain("inference backend");
    expect(result.hint?.summary).toMatch(/PIPELEX_BASE_URL/);
  });

  it("special-cases bundle/pipe definition errors", () => {
    for (const errorType of [
      "PipeValidationError",
      "PipeFactoryError",
      "MthdsParserError",
      "MthdsDecodeError",
    ]) {
      const err = new ApiResponseError(
        "...",
        "x",
        500,
        "",
        "",
        errorType,
        `${errorType} message`,
        undefined,
        undefined,
      );
      const result = classifyPipelineError(err, OVERRIDE_ENV);
      expect(result.kind).toBe("server_error");
      expect(result.title).toContain("pipeline definition");
    }
  });

  it("falls through to generic server error for unknown errorType", () => {
    const err = new ApiResponseError(
      "...",
      "x",
      500,
      "",
      "",
      "MysteryError",
      "boom",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.title).toContain("HTTP 500");
    expect(result.message).toContain("boom");
  });

  it("includes the endpoint URL, errorType, and serverMessage in details", () => {
    const err = new ApiResponseError(
      "...",
      "https://api.unreachable.example",
      500,
      "Internal Server Error",
      '{"detail":{"error_type":"X","message":"y"}}',
      "X",
      "y",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.details).toContain("API URL: https://api.unreachable.example");
    expect(result.details).toContain("error_type: X");
    expect(result.details).toContain("server message: y");
  });
});

describe("classifyPipelineError — ApiResponseError 4xx (non-auth)", () => {
  it("returns bad_request for 422", () => {
    const err = new ApiResponseError(
      "...",
      "x",
      422,
      "Unprocessable Entity",
      "",
      undefined,
      "missing field 'foo'",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("bad_request");
    expect(result.title).toContain("HTTP 422");
    expect(result.message).toBe("missing field 'foo'");
  });

  it("reframes a 400 StartRequiresAsyncOrchestration as a durable-execution error, keeping the API's own message", () => {
    const apiMsg =
      "Orchestration mode 'direct' cannot honor fire-and-forget delivery: /start requires an async-capable orchestration, and this deployment has none. Use /execute (synchronous) instead.";
    const err = new ApiResponseError(
      "...",
      "https://api.unreachable.example",
      400,
      "Bad Request",
      "",
      "StartRequiresAsyncOrchestration",
      apiMsg,
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    // Re-framed into this app's vocabulary (durable execution), not a generic bad_request.
    expect(result.kind).toBe("lifecycle_unavailable");
    expect(result.title).toContain("Durable");
    expect(result.message).toContain("https://api.unreachable.example");
    expect(result.message).toMatch(/durable start/i);
    // The remedy is the URL, not a mode switch.
    expect(result.message).toMatch(/PIPELEX_BASE_URL/);
    // The API's verbatim message is preserved separately for the template to show.
    expect(result.apiMessage).toBe(apiMsg);
    expect(result.hint?.code).toContain("PIPELEX_BASE_URL");
    expect(result.details).toContain("error_type: StartRequiresAsyncOrchestration");
  });
});

describe("classifyPipelineError — ClientAuthenticationError", () => {
  it("returns config_missing", () => {
    const err = new ClientAuthenticationError("API base URL is required for API execution");
    const result = classifyPipelineError(err, { apiUrl: undefined, hasApiKey: false });
    expect(result.kind).toBe("config_missing");
    expect(result.hint?.code).toBe("cp .env.example .env.local");
  });
});

describe("classifyPipelineError — BadPipelineOutputError", () => {
  it("returns bad_response", () => {
    const err = new BadPipelineOutputError("missing field");
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("bad_response");
    expect(result.title).toContain("output");
    expect(result.details).toContain("BadPipelineOutputError");
    expect(result.details).toContain("missing field");
  });
});

describe("classifyPipelineError — fs ENOENT", () => {
  it("returns bundle_load_failed", () => {
    const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("bundle_load_failed");
    expect(result.title).toContain("bundle");
    expect(result.message).toContain("ENOENT");
  });
});

describe("classifyPipelineError — unknown fallback", () => {
  it("returns unknown for plain Error", () => {
    const err = new Error("???");
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("unknown");
    expect(result.details).toContain("???");
  });

  it("returns unknown for non-Error throws", () => {
    const result = classifyPipelineError("a string was thrown", OVERRIDE_ENV);
    expect(result.kind).toBe("unknown");
    expect(result.details).toContain("a string was thrown");
  });
});

describe("classifyPipelineError — run-lifecycle errors", () => {
  it("classifies PipelineExecuteTimeoutError into execute_timeout, pointing the deployment at durable runs", () => {
    const result = classifyPipelineError(new PipelineExecuteTimeoutError(31_000), OVERRIDE_ENV);
    expect(result.kind).toBe("execute_timeout");
    expect(result.title).toMatch(/30s/);
    // The page has no mode switch: the remedy is the deployment's variable.
    expect(result.hint?.summary).not.toMatch(/Switch to Durable mode/);
    expect(result.hint?.code).toBe("NEXT_PUBLIC_EXECUTION_MODE=durable");
  });

  it("maps a blocking-path 502/504 gateway response to execute_timeout", () => {
    for (const status of [502, 504]) {
      const err = new ApiResponseError(
        `API POST /v1/execute failed (${status})`,
        "https://api.pipelex.com",
        status,
        status === 502 ? "Bad Gateway" : "Gateway Timeout",
        "",
        undefined,
        "The runner did not complete the request (/execute).",
        undefined,
        undefined,
      );
      const result = classifyPipelineError(err, CLOUD_ENV, { blocking: true });
      expect(result.kind).toBe("execute_timeout");
      expect(result.message).toMatch(/30s/);
      expect(result.hint?.summary).toMatch(/Durable/i);
      expect(result.details).toContain("The runner did not complete the request");
    }
  });

  it("leaves a durable-path (non-blocking) 502 as a generic server_error", () => {
    const err = new ApiResponseError(
      "API GET /v1/runs/run-1/status failed (502)",
      "https://api.pipelex.com",
      502,
      "Bad Gateway",
      "",
      undefined,
      "Bad Gateway",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.kind).toBe("server_error");
  });

  it("classifies RunStillRunningError into run_still_running", () => {
    const result = classifyPipelineError(
      new RunStillRunningError("still running", "run-1", 5, "/v1/runs/run-1"),
      OVERRIDE_ENV,
    );
    expect(result.kind).toBe("run_still_running");
    expect(result.message).toContain("run-1");
    expect(result.details).toContain("Retry-After: 5s");
    expect(result.details).toContain("/v1/runs/run-1");
  });

  it("classifies RunFailedError into run_failed with the failure message", () => {
    const result = classifyPipelineError(
      new RunFailedError("boom", "run-1", "FAILED"),
      OVERRIDE_ENV,
    );
    expect(result.kind).toBe("run_failed");
    expect(result.message).toContain("boom");
    expect(result.details).toContain("run run-1 ended FAILED");
  });

  it("classifies RunTimeoutError into run_timeout", () => {
    const result = classifyPipelineError(
      new RunTimeoutError("timed out", "run-1", 1_200_000),
      OVERRIDE_ENV,
    );
    expect(result.kind).toBe("run_timeout");
    expect(result.message).toContain("run-1");
  });

  it("classifies RunLifecycleUnavailableError into lifecycle_unavailable pointing at the hosted API", () => {
    const result = classifyPipelineError(
      new RunLifecycleUnavailableError("no run store", "https://api.unreachable.example"),
      OVERRIDE_ENV,
    );
    expect(result.kind).toBe("lifecycle_unavailable");
    expect(result.message).toContain("https://api.unreachable.example");
    expect(result.message).toMatch(/PIPELEX_BASE_URL/);
    expect(result.hint?.summary).toMatch(/hosted Pipelex API/);
    expect(result.hint?.code).toContain("PIPELEX_BASE_URL");
  });
});

describe("classifyPipelineError — a failed run's stored error report", () => {
  // The results read's `detail`, as a platform serving the report writes it:
  // the status, then the report's message — provider text included — and the
  // sentence it writes for a run with no report.
  const detailFor = (report: RunErrorReport) =>
    `Run finished with status FAILED: ${report.message}`;
  const NO_REPORT_SENTENCE = "Run finished with status FAILED; no result available";
  const failed = (report: RunErrorReport | null) =>
    new RunFailedError(report ? detailFor(report) : NO_REPORT_SENTENCE, "run-1", "FAILED", {
      error: report,
    });

  it("reads a change_input failure from its report: reason, next step, no re-run, support line", () => {
    const result = classifyPipelineError(failed(WRONG_ITEM_COUNT), OVERRIDE_ENV, {
      finishedAt: "2026-09-26T10:01:00.482913+00:00",
    });
    expect(result.kind).toBe("run_failed");
    expect(result.title).toBe("The pipeline run failed: Multiplicity count mismatch");
    expect(result.message).toBe(WRONG_ITEM_COUNT.message);
    expect(result.hint).toEqual({ summary: "Provide exactly 2 items for input 'pages'." });
    expect(result.retry).toEqual({
      retryable: false,
      summary: "Running it again unchanged will fail the same way.",
    });
    expect(result.support).toBe(
      "run run-1 · MultiplicityCountMismatchError · failed 2026-09-26T10:01:00Z",
    );
    expect(result.details).toContain("run run-1 ended FAILED");
    expect(result.details).toContain("error_domain: input");
    expect(result.details).toContain("user_action: change_input");
    expect(result.message).not.toContain("no result available");
  });

  it("offers a re-run when the report says the failure is retryable", () => {
    const result = classifyPipelineError(failed(RATE_LIMITED), OVERRIDE_ENV);
    expect(result.retry).toEqual({
      retryable: true,
      summary: "This failure can pass on a second try: run it again.",
    });
    // "The system will retry automatically" is untrue of a run that ended, so
    // the retry line is the only advice.
    expect(result.hint).toBeUndefined();
  });

  it("keeps the provider's raw text out of everything the person can read", () => {
    const result = classifyPipelineError(failed(MODEL_NOT_ENABLED), OVERRIDE_ENV);
    expect(result.title).toBe("The pipeline run failed: LLM completion");
    // What remains of the runtime's message still names the pipe, the model and the status.
    expect(result.message).toBe(
      "Pipe 'summarize' (path: two_steps > summarize) failed: openai inference failed for model 'claude-4.8-opus' (HTTP 412)",
    );
    expect(result.hint?.summary).toBe(
      "This model is not enabled on the inference gateway; choose another model for the pipe.",
    );
    expect(result.retry?.retryable).toBe(false);
    const shown = JSON.stringify(result);
    expect(shown).not.toContain(MODEL_NOT_ENABLED_PROVIDER_TEXT);
    expect(shown).not.toContain("not allowed for this integration");
    expect(shown).not.toContain("req_gw_5f1c");
    expect(result.details).toContain("model: claude-4.8-opus");
  });

  it("claims nothing about retrying when the report has no verdict", () => {
    // `null` and an absent field both mean unknown, never "no".
    const result = classifyPipelineError(
      failed({ ...WRONG_ITEM_COUNT, retryable: null }),
      OVERRIDE_ENV,
    );
    expect(result.retry).toBeUndefined();
    expect(result.details).not.toContain("retryable");
  });

  it("leaves the time out of the support line when the run's end is unknown", () => {
    const result = classifyPipelineError(failed(WRONG_ITEM_COUNT), OVERRIDE_ENV);
    expect(result.support).toBe("run run-1 · MultiplicityCountMismatchError");
  });

  it("says the report is silent rather than showing the provider's text when nothing else is left", () => {
    const bare: RunErrorReport = {
      error_type: "LLMCompletionError",
      message: RATE_LIMITED_PROVIDER_TEXT,
      provider_metadata: { message: RATE_LIMITED_PROVIDER_TEXT },
    };
    const result = classifyPipelineError(failed(bare), OVERRIDE_ENV);
    expect(result.title).toBe("The pipeline run failed");
    expect(result.message).toBe("The run ended FAILED, and its error report does not say why.");
    expect(result.hint).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("rate_limit_exceeded");
  });

  it("lists a method's validation items under the technical details", () => {
    const report: RunErrorReport = {
      error_type: "PipeValidationError",
      message: "The method failed validation.",
      title: "Pipe validation",
      validation_errors: [
        {
          category: "pipe_validation",
          message: "Output multiplicity does not match the parallel branches.",
          pipe_code: "fan_out",
        },
      ],
    };
    const result = classifyPipelineError(failed(report), OVERRIDE_ENV);
    expect(result.details).toContain(
      "validation: fan_out: Output multiplicity does not match the parallel branches.",
    );
  });

  it("keeps today's wording for a failed run with no stored report", () => {
    const result = classifyPipelineError(failed(null), OVERRIDE_ENV, {
      finishedAt: "2026-09-26T10:01:00+00:00",
    });
    expect(result).toEqual({
      kind: "run_failed",
      title: "The pipeline run failed",
      message: NO_REPORT_SENTENCE,
      details: `RunFailedError: run run-1 ended FAILED\n${NO_REPORT_SENTENCE}`,
    });
  });
});

describe("classifyPipelineError — a refusal's problem document", () => {
  it("classifies a refused start from its problem document: reason, next step, validation items, no re-run", () => {
    const result = classifyPipelineError(refusedStart(), OVERRIDE_ENV);
    expect(result.kind).toBe("bad_request");
    expect(result.message).toBe("The method is invalid.");
    expect(result.hint).toEqual({ summary: "Fix the bundle, then run it again." });
    expect(result.retry).toEqual({
      retryable: false,
      summary: "Running it again unchanged will fail the same way.",
    });
    expect(result.details).toContain("error_domain: input");
    expect(result.details).toContain("user_action: change_input");
    expect(result.details).toContain(
      "validation: summarize: Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5? (model reference: gpt-5.1; suggestions: gpt-5)",
    );
  });

  it("puts the validation items ahead of the raw body, which is truncated", () => {
    const { details } = classifyPipelineError(refusedStart(), OVERRIDE_ENV);
    expect(details.indexOf("validation: summarize")).toBeLessThan(details.indexOf("body: "));
  });

  it("offers a re-run when the refusal says it is retryable", () => {
    const err = new ApiResponseError(
      "API POST /v1/execute failed (503): The inference provider is overloaded.",
      "https://api.pipelex.com",
      503,
      "Service Unavailable",
      "{}",
      "LLMCompletionError",
      "The inference provider is overloaded.",
      undefined,
      undefined,
      {
        problem: {
          retryable: true,
          userAction: {
            kind: "wait_and_retry",
            detail: "Transient provider error — the system will retry automatically.",
          },
        },
      },
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.retry?.retryable).toBe(true);
    // Nothing retries a refused request, so the stale promise is not the hint.
    expect(result.hint).toBeUndefined();
  });

  it("keeps the status's hint when the runtime's advice is its unknown fallback", () => {
    const err = new ApiResponseError(
      "API POST /v1/execute failed (500)",
      "http://localhost:8081",
      500,
      "Internal Server Error",
      "{}",
      "PipelineExecutionError",
      "Pipe 'summarize' failed.",
      undefined,
      undefined,
      {
        problem: {
          userAction: { kind: "unknown", detail: "Check pipe_stack to identify which pipe failed" },
        },
      },
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.hint).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Check pipe_stack");
  });

  it("keeps its curated hint for a server error whose document advises nothing", () => {
    const err = new ApiResponseError(
      "API POST /v1/execute failed (500)",
      "https://api.pipelex.com",
      500,
      "Internal Server Error",
      "{}",
      "CredentialsError",
      "No API key for the provider.",
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.hint?.summary).toMatch(/verify the URL/);
    expect(result.retry).toBeUndefined();
  });

  it("keeps today's wording for an answer with no problem document", () => {
    const err = new ApiResponseError(
      "API POST /v1/start failed (400): Bad Request",
      "https://api.pipelex.com",
      400,
      "Bad Request",
      "<html>Bad Request</html>",
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(classifyPipelineError(err, OVERRIDE_ENV)).toEqual({
      kind: "bad_request",
      title: "Pipelex API rejected the request (HTTP 400)",
      message: "The API returned a client error. Inspect the request and try again.",
      details:
        "ApiResponseError: HTTP 400 Bad Request\nAPI URL: https://api.pipelex.com\nbody: <html>Bad Request</html>",
    });
  });
});

describe("classifyPipelineError — input-preparation (upload) errors", () => {
  it("classifies UnsupportedUploadCapabilityError into upload_failed pointing at the hosted API", () => {
    const err = new UnsupportedUploadCapabilityError("no /v1/upload route");
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("upload_failed");
    expect(result.title).toMatch(/isn't available/i);
    expect(result.message).toContain("https://api.unreachable.example");
    expect(result.message).toMatch(/PIPELEX_BASE_URL/);
    expect(result.hint?.code).toContain("PIPELEX_BASE_URL");
  });

  it("classifies RejectedAssetError into upload_failed, surfacing the server's verbatim message", () => {
    const cause = new ApiResponseError(
      "...",
      "https://api.pipelex.com",
      413,
      "Payload Too Large",
      "",
      undefined,
      "asset exceeds the 50 MiB service limit",
      undefined,
      undefined,
    );
    const err = new RejectedAssetError("rejected big.pdf", "big.pdf", 413, { cause });
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.kind).toBe("upload_failed");
    expect(result.title).toMatch(/rejected/i);
    expect(result.message).toContain("413");
    expect(result.apiMessage).toBe("asset exceeds the 50 MiB service limit");
    expect(result.details).toContain("big.pdf");
  });

  it("classifies UploadAuthenticationError into upload_failed with the API-key hint", () => {
    const err = new UploadAuthenticationError("upload not authorized", 401);
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.kind).toBe("upload_failed");
    expect(result.title).toMatch(/not authorized/i);
    expect(result.hint?.code).toContain("PIPELEX_API_KEY");
  });

  it("classifies InvalidLocalSourceError and UploadTransportError as generic upload_failed", () => {
    for (const err of [
      new InvalidLocalSourceError("cannot read path", "/tmp/x.pdf"),
      new UploadTransportError("network fault"),
    ]) {
      const result = classifyPipelineError(err, CLOUD_ENV);
      expect(result.kind).toBe("upload_failed");
      expect(result.title).toMatch(/Preparing the file/i);
    }
  });

  it("falls back to generic upload_failed for the base InputPreparationError (e.g. a malformed data URL)", () => {
    const err = new InputPreparationError("Malformed data URL payload (invalid base64)");
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.kind).toBe("upload_failed");
    expect(result.details).toContain("Malformed data URL");
  });
});

describe("classifyUploadError — a file's upload, in the browser", () => {
  it.each([
    ["grant_expired", /permission ran out/i, /expired/],
    ["grant_used", /permission ran out/i, /already been used/],
    ["signature_mismatch", /changed before it was stored/i, /no longer matches/],
    ["too_large", /too large/i, /size limit/],
  ] as const)("says what a storage refusal coded %s means", (code, title, message) => {
    const err = new RejectedAssetError("refused", "receipt.jpg", 403, { code });
    const result = classifyUploadError(err);
    expect(result.kind).toBe("upload_failed");
    expect(result.title).toMatch(title);
    expect(result.message).toMatch(message);
    expect(result.message).toContain("receipt.jpg");
    expect(result.details).toContain(`code: ${code}`);
  });

  // Every code the SDK can set, so one it adds fails the type check here until
  // someone decides what it tells the user. The hint is the retry advice, which
  // only the codes a second drop can cure carry.
  const TRANSPORT_CODES = {
    timeout: ["The upload took too long", true],
    storage_timeout: ["The upload took too long", true],
    unreachable: ["Could not reach Pipelex storage", true],
    server_error: ["Pipelex storage could not store the file", true],
    conflict: ["Uploading the file failed", false],
    redirected: ["Uploading the file failed", false],
    invalid_grant_url: ["Uploading the file failed", false],
    unexpected: ["Uploading the file failed", false],
  } satisfies Record<UploadTransportCode, readonly [string, boolean]>;

  it.each([
    ...Object.entries(TRANSPORT_CODES).map(
      ([code, [title, retry]]) => [code as UploadTransportCode, title, retry] as const,
    ),
    [undefined, "Uploading the file failed", false] as const,
  ])("says what an upload that failed in transit with code %s means", (code, title, retry) => {
    const result = classifyUploadError(new UploadTransportError("upload failed", { code }));
    expect(result.kind).toBe("upload_failed");
    expect(result.title).toBe(title);
    expect(result.hint !== undefined).toBe(retry);
    expect(result.details).toContain(`code: ${code ?? "(none)"}`);
  });

  it("keeps the status storage answered with, and claims no outcome the SDK calls unknown", () => {
    const err = new UploadTransportError("storage answered 503", {
      status: 503,
      code: "server_error",
    });
    const result = classifyUploadError(err);
    expect(result.details).toContain("status: 503");
    // Storage may have written the object before it failed, so the SDK cannot
    // say whether the file was stored, and neither can the message.
    expect(result.message).not.toMatch(/not stored|could not be stored/);
  });

  it("treats anything else as the grant request failing to reach this app", () => {
    const result = classifyUploadError(new TypeError("Failed to fetch"));
    expect(result.kind).toBe("transport_error");
  });
});

describe("buildClientTimeoutError", () => {
  it("builds a run_timeout error from the client poll ceiling", () => {
    const result = buildClientTimeoutError(150_000);
    expect(result.kind).toBe("run_timeout");
    expect(result.title).toMatch(/Stopped waiting/i);
    expect(result.message).toContain("150s");
  });
});

describe("buildInputsTooLargeError", () => {
  it("says how large the inputs are and what the limit is, and that files do not count", () => {
    const result = buildInputsTooLargeError(1_534_000, 1_000_000);
    expect(result.kind).toBe("inputs_too_large");
    expect(result.title).toMatch(/too large/i);
    expect(result.message).toContain("1.5 MB");
    expect(result.message).toContain("at most 1 MB");
    expect(result.message).toMatch(/Files don't count/);
    expect(result.details).toBe("inputs_too_large: 1534000 bytes, limit 1000000 bytes");
  });
});

describe("classifyTransportError", () => {
  it("returns transport_error for fetch-style TypeError rejections", () => {
    const err = new TypeError("Failed to fetch");
    const result = classifyTransportError(err);
    expect(result.kind).toBe("transport_error");
    expect(result.title).toMatch(/server/i);
    expect(result.details).toContain("TypeError");
    expect(result.details).toContain("Failed to fetch");
    expect(result.hint?.summary).toMatch(/[Rr]eload/);
  });

  it("includes the original Error name and message in details", () => {
    const err = Object.assign(new Error("connection reset"), { name: "AbortError" });
    const result = classifyTransportError(err);
    expect(result.details).toBe("AbortError: connection reset");
  });

  it("handles non-Error throws", () => {
    const result = classifyTransportError("disconnected");
    expect(result.kind).toBe("transport_error");
    expect(result.details).toContain("disconnected");
    expect(result.details).toContain("Unknown");
  });
});

describe("classifyPipelineError — details truncation", () => {
  it("truncates very long response bodies", () => {
    const huge = "x".repeat(5000);
    const err = new ApiResponseError(
      "...",
      "x",
      500,
      "",
      huge,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.details).toContain("truncated");
    expect(result.details.length).toBeLessThan(huge.length + 200);
  });
});
