import { describe, it, expect } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  PipelineExecuteTimeoutError,
  RejectedAssetError,
  RequestArgumentError,
  RunFailedError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
  RunTimeoutError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
  buildProblem,
  type Problem,
  type UploadTransportReason,
} from "@pipelex/sdk";
import {
  MODEL_NOT_SERVED,
  MODEL_NOT_SERVED_PROVIDER_TEXT,
  RATE_LIMITED,
  WRONG_ITEM_COUNT,
  runFailedAnswer,
} from "@/test/fixtures/runProblems";
import { REFUSAL_BODY, refusedStart } from "@/test/fixtures/refusals";
import { BadImageOutputError, BadPipelineOutputError } from "@/types/pipelineError";
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

const API_URL = "https://api.pipelex.com";

/**
 * An answer the API refused, as the SDK's client throws it: the route, the
 * status and the body as received, the SDK reading the body as its problem
 * (the document itself, or the reading of a bare status).
 */
function refusal(
  status: number,
  body: string | Problem,
  options: { route?: string; mayStartRun?: boolean; headers?: Record<string, string> } = {},
): ApiResponseError {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new ApiResponseError(
    `API POST ${options.route ?? "/v1/start"} failed (${status}): ${text}`,
    API_URL,
    status,
    "",
    text,
    { mayStartRun: options.mayStartRun, headers: options.headers },
  );
}

describe("classifyPipelineError — no answer from the API", () => {
  it("steers to PIPELEX_BASE_URL when an override is set", () => {
    const err = new ApiUnreachableError(
      "fetch failed",
      "https://api.unreachable.example",
      "ECONNREFUSED",
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.message).toContain("https://api.unreachable.example");
    expect(result.message).toContain("ECONNREFUSED");
    expect(result.message).toMatch(/PIPELEX_BASE_URL is set/);
    expect(result.hint?.code).toBe("PIPELEX_BASE_URL=https://api.pipelex.com");
    expect(result.code).toBe("client.unreachable");
    // The SDK found no answer to read: blaming the service would contradict
    // a message that suspects the URL, so no domain is claimed.
    expect(result.domain).toBeUndefined();
    expect(result.retry?.verdict).toBe("yes");
    expect(result.details).toContain("code: client.unreachable");
  });

  it("steers to the network when no override is set (default hosted URL)", () => {
    const err = new ApiUnreachableError("fetch failed", API_URL, "ENOTFOUND");
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.message).toMatch(/default URL/);
    expect(result.message).toMatch(/network connection/);
    expect(result.hint?.code).toBe(`PIPELEX_BASE_URL=${API_URL}`);
  });

  it("steers to the network when PIPELEX_BASE_URL is set to the SDK default", () => {
    const err = new ApiUnreachableError("fetch failed", API_URL, "ENOTFOUND");
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.message).toMatch(/default URL/);
    expect(result.message).not.toMatch(/PIPELEX_BASE_URL is set/);
  });

  it("ignores a trailing slash when comparing against the SDK default", () => {
    const err = new ApiUnreachableError("fetch failed", API_URL, "ENOTFOUND");
    const result = classifyPipelineError(err, { apiUrl: `${API_URL}/`, hasApiKey: true });
    expect(result.message).toMatch(/default URL/);
  });

  it("handles a failure with no network code", () => {
    const err = new ApiUnreachableError("fetch failed", API_URL, undefined);
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.message).not.toContain("(undefined)");
  });

  it("says the answer did not come in time when the SDK's own time limit ran out", () => {
    // `ABORT_TIMEOUT` is the network code the SDK gives its own time limit.
    const err = new ApiUnreachableError("timed out", API_URL, "ABORT_TIMEOUT", {
      timeoutMs: 30_000,
    });
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("api_unreachable");
    expect(result.code).toBe("client.timeout");
    expect(result.message).toMatch(/did not get a response in time/);
    expect(result.domain).toBeUndefined();
    expect(result.retry?.verdict).toBe("yes");
  });
});

describe("classifyPipelineError — a credential the API refused", () => {
  it("returns auth_missing when no key is set", () => {
    const err = refusal(401, '{"detail":"Not authenticated"}');
    const result = classifyPipelineError(err, { apiUrl: undefined, hasApiKey: false });
    expect(result.kind).toBe("auth_missing");
    expect(result.hint?.code).toBe("PIPELEX_API_KEY=your-key-here");
    expect(result.domain).toBe("account");
    expect(result.retry?.verdict).toBe("no");
    // The body was no problem document: the problem is the SDK's reading of the status.
    expect(result.apiMessage).toBeUndefined();
    expect(result.details).toContain("the SDK's reading of the HTTP status");
  });

  it("returns auth_invalid when a key is present", () => {
    const err = refusal(403, "");
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.kind).toBe("auth_invalid");
    expect(result.message).toContain(API_URL);
    expect(result.code).toBe("auth.invalid_credential");
  });

  it("reads an expired key as a refused one, keeping the API's words", () => {
    const body = { ...buildProblem("auth.credential_expired", {}), status: 401 };
    const result = classifyPipelineError(refusal(401, body), CLOUD_ENV);
    expect(result.kind).toBe("auth_invalid");
    expect(result.hint?.code).toBe("PIPELEX_API_KEY=your-key-here");
    expect(result.apiMessage).toBe(body.detail);
  });

  it("shows the API's own words beside the app's when it sent a problem document", () => {
    const body = { ...buildProblem("auth.invalid_credential", {}), status: 401 };
    const result = classifyPipelineError(refusal(401, body), CLOUD_ENV);
    expect(result.kind).toBe("auth_invalid");
    expect(result.apiMessage).toBe(body.detail);
    expect(result.details).not.toContain("the SDK's reading of the HTTP status");
  });
});

describe("classifyPipelineError — a refusal's problem document", () => {
  it("presents a refused start from its problem: title, detail, next step, domain, verdict, request id", () => {
    const result = classifyPipelineError(refusedStart(), CLOUD_ENV);
    expect(result.kind).toBe("bad_request");
    expect(result.title).toBe(REFUSAL_BODY.title);
    expect(result.message).toBe(REFUSAL_BODY.detail);
    expect(result.hint?.summary).toBe(REFUSAL_BODY.next_step.detail);
    expect(result.domain).toBe("method");
    expect(result.retry).toEqual({
      verdict: "no",
      summary: "Running it again unchanged will fail the same way.",
    });
    expect(result.code).toBe("method.invalid");
    expect(result.requestId).toBe("req-run-422");
    expect(result.support).toBe("method.invalid · request req-run-422");
  });

  it("lists each item with where it is, its close matches, ahead of the raw body", () => {
    const { details } = classifyPipelineError(refusedStart(), CLOUD_ENV);
    expect(details).toContain("API URL: https://api.pipelex.com");
    expect(details).toContain("domain: method");
    expect(details).toContain("next_step: change_method");
    expect(details).toContain("request_id: req-run-422");
    const item = details.split("\n").find((line) => line.startsWith("item: "));
    expect(item).toContain("model.unknown");
    expect(item).toContain("'gpt-5.1'");
    expect(item).toContain("pipe 'summarize'");
    expect(item).toContain("suggestions: gpt-5");
    expect(details.indexOf("item: ")).toBeLessThan(details.indexOf("body: "));
  });

  it("reads a problem whose code this app has no copy for from its members alone", () => {
    const body: Problem = {
      type: "https://docs.pipelex.com/errors/pipelex.catalog.not_found",
      title: "No such method in the catalog",
      status: 404,
      detail: "No method mt_abc123 is in the catalog of this organization.",
      code: "pipelex.catalog.not_found",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input", detail: "Name a method the organization has saved." },
      request_id: "req_cat_1",
    };
    const result = classifyPipelineError(refusal(404, body), CLOUD_ENV);
    expect(result.kind).toBe("bad_request");
    expect(result.title).toBe(body.title);
    expect(result.message).toBe(body.detail);
    expect(result.hint?.summary).toBe("Name a method the organization has saved.");
    expect(result.domain).toBe("input");
    expect(result.requestId).toBe("req_cat_1");
  });

  it("shows a fault on the service's side as a server error, with the next step for the caller", () => {
    const body = {
      ...buildProblem(
        "model.unavailable",
        { model: "claude-4.8-opus", model_type: "llm", reason: "not_served" },
        { reader: "other" },
      ),
      status: 501,
    };
    const result = classifyPipelineError(refusal(501, body), CLOUD_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.domain).toBe("operator");
    expect(result.hint?.summary).toBe(body.next_step.detail);
    expect(result.retry?.verdict).toBe("no");
  });

  it("offers a re-run after the delay a retryable refusal asks for, and leaves the retry line to say it", () => {
    const body = { ...buildProblem("runtime.unavailable", {}, { retryAfter: 30 }), status: 503 };
    const result = classifyPipelineError(refusal(503, body), CLOUD_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.retry).toEqual({
      verdict: "yes",
      summary: "This failure can pass on a second try: run it again in 30 seconds.",
      afterSeconds: 30,
    });
    // The step is `retry`, which the retry line already says.
    expect(result.hint).toBeUndefined();
  });

  it("reads a bare 5xx by its status, with the delay its Retry-After header gives", () => {
    const err = refusal(503, "<html>Service Unavailable</html>", {
      headers: { "retry-after": "12" },
    });
    const result = classifyPipelineError(err, CLOUD_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.code).toBe("runtime.unavailable");
    expect(result.retry?.afterSeconds).toBe(12);
    expect(result.details).toContain("the SDK's reading of the HTTP status");
    expect(result.details).toContain("body: <html>Service Unavailable</html>");
  });

  it("truncates a very long body", () => {
    const huge = "x".repeat(5000);
    const result = classifyPipelineError(refusal(500, huge), OVERRIDE_ENV);
    expect(result.details).toContain("truncated");
    expect(result.details.length).toBeLessThan(huge.length + 1000);
  });
});

describe("classifyPipelineError — a refusal the SDK made itself", () => {
  // The SDK's own refusal of PIPELEX_BASE_URL, as its client raises it.
  const refuseBaseUrl = () =>
    new RequestArgumentError("Invalid API base URL with a path: it must be host-only.", {
      problem: buildProblem("client.not_configured", { setting: "base_url" }),
    });

  it("returns config_invalid for a base URL the SDK refused, steering to PIPELEX_BASE_URL", () => {
    const apiUrl = "https://api.pipelex.com/v1";
    const result = classifyPipelineError(refuseBaseUrl(), { apiUrl, hasApiKey: true });
    expect(result.kind).toBe("config_invalid");
    expect(result.message).toMatch(/PIPELEX_BASE_URL/);
    expect(result.hint?.code).toBe("PIPELEX_BASE_URL=https://api.pipelex.com");
    expect(result.details.split("\n").slice(0, 2)).toEqual([
      "RequestArgumentError: the SDK refused PIPELEX_BASE_URL",
      "PIPELEX_BASE_URL: https://api.pipelex.com, with a path (not shown)",
    ]);
    expect(result.code).toBe("client.not_configured");
    expect(result.retry?.verdict).toBe("no");
  });

  // The details reach every visitor, and a value is refused exactly when it
  // carries more than a host: none of what lies beyond the host is shown.
  it.each([
    [
      "https://user:secret@proxy.example.com/key-in-path?token=abc123#section-9",
      "PIPELEX_BASE_URL: https://proxy.example.com, with credentials, a path, a query and a fragment (not shown)",
    ],
    [
      "https://proxy.example.com?token=abc123",
      "PIPELEX_BASE_URL: https://proxy.example.com, with a query (not shown)",
    ],
    // Without a scheme, the user name parses as one.
    [
      "user:secret@proxy.example.com",
      "PIPELEX_BASE_URL: not an http or https URL (the value is not shown)",
    ],
    ["not a url secret", "PIPELEX_BASE_URL: not a URL (the value is not shown)"],
  ])("never shows a visitor what %s carries beyond its host", (apiUrl, line) => {
    const result = classifyPipelineError(refuseBaseUrl(), { apiUrl, hasApiKey: true });
    expect(result.kind).toBe("config_invalid");
    expect(result.details.split("\n")[1]).toBe(line);
    for (const secret of ["user", "secret", "abc123", "key-in-path", "section-9"]) {
      expect(result.details).not.toContain(secret);
    }
  });

  it("reports an argument the SDK refused as this app's fault, claiming no domain for the person", () => {
    const err = new RequestArgumentError("execute() needs a run source");
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("unknown");
    expect(result.domain).toBeUndefined();
    expect(result.code).toBe("client.argument_invalid");
    expect(result.details).toContain("RequestArgumentError: execute() needs a run source");
  });

  it("returns bad_response for a 2xx the SDK could not read, never a refusal", () => {
    const err = new ApiResponseError(
      "API POST /v1/execute answered 200 with a body that is not JSON",
      API_URL,
      200,
      "OK",
      "<html>gateway page</html>",
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV, { blocking: true });
    expect(result.kind).toBe("bad_response");
    expect(result.title).not.toMatch(/rejected/i);
    expect(result.message).toContain("HTTP 200");
    expect(result.retry?.verdict).toBe("no");
    expect(result.details).toContain(
      "ApiResponseError: API POST /v1/execute answered 200 with a body that is not JSON",
    );
    expect(result.details).toContain("body: <html>gateway page</html>");
  });
});

describe("classifyPipelineError — failures that carry no problem", () => {
  it("returns bad_response for a narrower's BadPipelineOutputError", () => {
    const err = new BadPipelineOutputError("expected a summary");
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("bad_response");
    expect(result.retry).toBeUndefined();
    expect(result.domain).toBeUndefined();
  });

  it("returns bundle_load_failed for a missing bundle", () => {
    const err = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    expect(classifyPipelineError(err, DEFAULT_ENV).kind).toBe("bundle_load_failed");
  });

  it("returns unknown for a plain Error", () => {
    const result = classifyPipelineError(new Error("boom"), DEFAULT_ENV);
    expect(result.kind).toBe("unknown");
    expect(result.details).toBe("Error: boom");
  });

  it("returns unknown for a non-Error throw", () => {
    const result = classifyPipelineError("oops", DEFAULT_ENV);
    expect(result.kind).toBe("unknown");
    expect(result.details).toContain("oops");
  });
});

describe("classifyPipelineError — BadImageOutputError", () => {
  it("returns bad_image_output", () => {
    const err = new BadImageOutputError("no image url");
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("bad_image_output");
    expect(result.title).toMatch(/image/i);
    expect(result.details).toContain("BadImageOutputError");
    expect(result.details).toContain("no image url");
  });

  it("steers to the hosted API when the image URL isn't web-accessible", () => {
    const err = new BadImageOutputError(
      'The pipeline returned an image at "file:///tmp/storage/abc.png", but a browser cannot load a file: URL.',
      { nonWebUrl: "file:///tmp/storage/abc.png" },
    );
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("bad_image_output");
    expect(result.title).toMatch(/web-accessible/i);
    expect(result.message).toMatch(/PIPELEX_BASE_URL/);
    expect(result.hint?.code).toContain("PIPELEX_BASE_URL=https://api.pipelex.com");
    expect(result.details).toContain("file:///tmp/storage/abc.png");
  });
});

describe("classifyPipelineError — the blocking path", () => {
  it("reads the SDK's own execute timeout as the ~30s cap, pointing at Durable mode", () => {
    const result = classifyPipelineError(new PipelineExecuteTimeoutError(31_000), DEFAULT_ENV, {
      blocking: true,
    });
    expect(result.kind).toBe("execute_timeout");
    expect(result.message).toContain("~31s");
    expect(result.hint?.summary).toMatch(/Durable mode/);
    expect(result.retry?.verdict).toBe("outcome_unknown");
  });

  it.each([502, 504])(
    "reads a gateway %s with no problem document on execute as the cap",
    (status) => {
      const err = refusal(status, "<html>Gateway Timeout</html>", {
        route: "/v1/execute",
        mayStartRun: true,
      });
      const result = classifyPipelineError(err, DEFAULT_ENV, { blocking: true });
      expect(result.kind).toBe("execute_timeout");
      expect(result.code).toBe("client.outcome_unknown");
    },
  );

  it("reads a run the API answered with its id instead of its result as still running", () => {
    const err = new RunStillRunningError("still running", "run-42", 5);
    const result = classifyPipelineError(err, DEFAULT_ENV, { blocking: true });
    expect(result.kind).toBe("run_still_running");
    expect(result.message).toContain("run-42");
    expect(result.hint?.summary).toMatch(/Durable mode/);
  });
});

describe("classifyPipelineError — the durable path", () => {
  it("leaves a 502 on a status read as a server error a second read can pass", () => {
    const err = refusal(502, "<html>Bad Gateway</html>", { route: "/v1/runs/run-1/status" });
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("server_error");
    expect(result.retry?.verdict).toBe("yes");
  });

  it("says a start that failed after it left may have started the run", () => {
    const err = new ApiUnreachableError("socket hang up", API_URL, "ECONNRESET", {
      mayStartRun: true,
    });
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("outcome_unknown");
    expect(result.title).toBe("The run may have started");
    expect(result.retry?.verdict).toBe("outcome_unknown");
    expect(result.retry?.summary).toMatch(/look it up by its id before running it again/);
    expect(result.hint?.summary).toMatch(/run history/);
  });

  it("reads a run the SDK stopped following as a timeout, naming the run", () => {
    const err = new RunTimeoutError("gave up", "run-7", 600_000);
    const result = classifyPipelineError(err, DEFAULT_ENV);
    expect(result.kind).toBe("run_timeout");
    expect(result.message).toContain("run-7");
    expect(result.message).toContain("~600s");
    expect(result.retry?.verdict).toBe("outcome_unknown");
  });

  it("reads an API without the durable run lifecycle as lifecycle_unavailable, pointing at the hosted API", () => {
    const err = new RunLifecycleUnavailableError("no lifecycle", OVERRIDE_ENV.apiUrl as string);
    const result = classifyPipelineError(err, OVERRIDE_ENV);
    expect(result.kind).toBe("lifecycle_unavailable");
    expect(result.message).toContain("https://api.unreachable.example");
    expect(result.hint?.code).toBe("PIPELEX_BASE_URL=https://api.pipelex.com");
    expect(result.apiMessage).toBeUndefined();
    expect(result.domain).toBe("operator");
  });

  it("reads a runtime that refuses asynchronous execution as lifecycle_unavailable, keeping its words", () => {
    const body = {
      ...buildProblem("runtime.unsupported", { capability: "asynchronous execution" }),
      status: 501,
    };
    const result = classifyPipelineError(refusal(501, body, { mayStartRun: true }), OVERRIDE_ENV);
    expect(result.kind).toBe("lifecycle_unavailable");
    expect(result.apiMessage).toBe(body.detail);
  });
});

describe("classifyPipelineError — a failed run", () => {
  const FINISHED_AT = "2026-09-26T10:01:00+00:00";
  const failed = (runError: Problem | null, finishedAt: string | null = FINISHED_AT) => {
    const problem = runFailedAnswer(runError);
    return classifyPipelineError(
      new RunFailedError(problem.detail, "run-1", "FAILED", { problem }),
      DEFAULT_ENV,
      { finishedAt },
    );
  };

  it("presents the run's own problem: title, detail, next step, domain, verdict and support line", () => {
    const result = failed(WRONG_ITEM_COUNT);
    expect(result.kind).toBe("run_failed");
    expect(result.title).toBe(`The pipeline run failed: ${WRONG_ITEM_COUNT.title}`);
    expect(result.message).toBe(WRONG_ITEM_COUNT.detail);
    expect(result.hint?.summary).toBe(WRONG_ITEM_COUNT.next_step.detail);
    expect(result.domain).toBe("input");
    expect(result.retry?.verdict).toBe("no");
    expect(result.code).toBe("input.wrong_multiplicity");
    expect(result.support).toBe(
      "run run-1 · input.wrong_multiplicity · failed 2026-09-26T10:01:00Z · request req_results_409",
    );
    expect(result.details).toContain("params: ");
    expect(result.details).toContain('"provided_count":3');
  });

  it("offers a re-run after the delay a retryable run problem asks for", () => {
    const result = failed(RATE_LIMITED);
    expect(result.domain).toBe("runtime");
    expect(result.retry).toEqual({
      verdict: "yes",
      summary: "This failure can pass on a second try: run it again in 20 seconds.",
      afterSeconds: 20,
    });
    // The step is `wait`, which the retry line already says.
    expect(result.hint).toBeUndefined();
  });

  it("quotes the results read's request when the run's problem names none", () => {
    const result = failed(WRONG_ITEM_COUNT);
    expect(WRONG_ITEM_COUNT.request_id).toBeUndefined();
    expect(result.requestId).toBe("req_results_409");
    expect(result.support).toContain("request req_results_409");
    expect(result.details).toContain("request_id: req_results_409");
  });

  it("names the request the run's problem carries in the support line", () => {
    const result = failed(MODEL_NOT_SERVED);
    expect(result.domain).toBe("operator");
    expect(result.support).toBe(
      "run run-1 · model.unavailable · failed 2026-09-26T10:01:00Z · request req_gw_5f1c",
    );
  });

  it("never shows the operator's diagnostics, which quote the provider's raw text", () => {
    const result = failed(MODEL_NOT_SERVED);
    expect(JSON.stringify(result)).not.toContain(MODEL_NOT_SERVED_PROVIDER_TEXT);
    expect(JSON.stringify(result)).not.toContain("not allowed for this integration");
  });

  it("leaves the time out of the support line when the run's end is unknown", () => {
    expect(failed(WRONG_ITEM_COUNT, null).support).toBe(
      "run run-1 · input.wrong_multiplicity · request req_results_409",
    );
  });

  it("keeps the lookup's sentence and the bare run id for a run with no problem of its own", () => {
    const result = failed(null);
    expect(result.kind).toBe("run_failed");
    expect(result.title).toBe("The pipeline run failed");
    expect(result.message).toBe("The run 'run-1' ended as 'FAILED', without success.");
    expect(result.support).toBeUndefined();
    // Reading the run again only finds it over: nothing says whether it would pass again.
    expect(result.retry).toBeUndefined();
    expect(result.details).toContain("code: run.failed");
  });
});

describe("classifyPipelineError — file inputs on the server", () => {
  it("reads a grant route the API does not serve as upload_unavailable", () => {
    const err = refusal(404, '{"detail":"Not Found"}', { route: "/v1/upload/grant" });
    const result = classifyPipelineError(err, OVERRIDE_ENV, { uploadGrant: true });
    expect(result.kind).toBe("upload_unavailable");
    expect(result.message).toContain("POST /v1/upload/grant");
    expect(result.message).toContain("https://api.pipelex.com");
  });

  it("reads a grant the platform refused as too large in its own words", () => {
    const body = {
      ...buildProblem("request.too_large", { size: 60_000_000, limit: 52_428_800 }),
      status: 413,
    };
    const result = classifyPipelineError(
      refusal(413, body, { route: "/v1/upload/grant" }),
      CLOUD_ENV,
      {
        uploadGrant: true,
      },
    );
    expect(result.kind).toBe("file_too_large");
    expect(result.message).toBe(body.detail);
  });

  it("reads an API that offers no file upload as upload_unavailable, pointing at the hosted API", () => {
    const result = classifyPipelineError(
      new UnsupportedUploadCapabilityError("no upload route"),
      OVERRIDE_ENV,
    );
    expect(result.kind).toBe("upload_unavailable");
    expect(result.hint?.code).toBe("PIPELEX_BASE_URL=https://api.pipelex.com");
  });

  it("reads an upload credential the API refused as a credential problem", () => {
    const result = classifyPipelineError(new UploadAuthenticationError("refused", 401), CLOUD_ENV);
    expect(result.kind).toBe("auth_invalid");
  });
});

describe("classifyUploadError — a file's upload, in the browser", () => {
  it.each([
    ["grant_expired", /permission ran out/i, /expired/],
    ["grant_used", /permission ran out/i, /already been used/],
    ["signature_mismatch", /changed before it was stored/i, /no longer matches/],
    ["too_large", /too large/i, /size limit/],
  ] as const)("says what a storage refusal for the reason %s means", (reason, title, message) => {
    const err = new RejectedAssetError("refused", "receipt.jpg", 403, { reason });
    const result = classifyUploadError(err);
    expect(result.kind).toBe("upload_failed");
    expect(result.title).toMatch(title);
    expect(result.message).toMatch(message);
    expect(result.message).toContain("receipt.jpg");
    expect(result.details).toContain(`reason: ${reason}`);
    expect(result.retry?.verdict).toBe("no");
  });

  // Every reason the SDK can set, so one it adds fails the type check here
  // until someone decides what it tells the user. The hint is the retry
  // advice, which only the reasons whose problem says a second drop can pass
  // carry: a `conflict` is two writes colliding.
  const TRANSPORT_REASONS = {
    timeout: ["The upload took too long", true],
    storage_timeout: ["The upload stalled", true],
    unreachable: ["Could not reach Pipelex storage", true],
    server_error: ["Pipelex storage had a problem", true],
    conflict: ["Uploading the file failed", true],
    redirected: ["Uploading the file failed", false],
    invalid_grant_url: ["Uploading the file failed", false],
    unexpected: ["Uploading the file failed", false],
  } satisfies Record<UploadTransportReason, readonly [string, boolean]>;

  it.each([
    ...Object.entries(TRANSPORT_REASONS).map(
      ([reason, [title, retry]]) => [reason as UploadTransportReason, title, retry] as const,
    ),
    [undefined, "Uploading the file failed", false] as const,
  ])(
    "says what an upload that failed in transit for the reason %s means",
    (reason, title, retry) => {
      const result = classifyUploadError(new UploadTransportError("upload failed", { reason }));
      expect(result.kind).toBe("upload_failed");
      expect(result.title).toBe(title);
      expect(result.hint !== undefined).toBe(retry);
      expect(result.details).toContain(`reason: ${reason ?? "(none)"}`);
    },
  );

  it.each(["timeout", "storage_timeout", "unreachable"] as const)(
    "blames no one for an upload that failed on the connection (%s)",
    (reason) => {
      const result = classifyUploadError(new UploadTransportError("upload failed", { reason }));
      expect(result.domain).toBeUndefined();
      expect(result.retry?.verdict).toBe("yes");
    },
  );

  it.each(["timeout", "storage_timeout", "unreachable"] as const)(
    "keeps the domain and verdict of a problem the server answered a %s failure with, offering no drop-again hint",
    (reason) => {
      // An operator-domain refusal: whoever runs the deployment must act, and
      // dropping the file again fails alike.
      const problem = buildProblem("runtime.unsupported", { capability: "this upload" });
      const result = classifyUploadError(
        new UploadTransportError("upload failed", { reason, problem }),
      );
      expect(result.domain).toBe("operator");
      expect(result.retry?.verdict).toBe("no");
      expect(result.hint).toBeUndefined();
    },
  );

  it.each([
    ["timeout", buildProblem("client.timeout", { seconds: 30 })],
    ["unreachable", buildProblem("client.unreachable", { base_url: "https://storage.example" })],
  ] as const)("claims no domain for the SDK's own reading of a %s failure", (reason, problem) => {
    const result = classifyUploadError(
      new UploadTransportError("upload failed", { reason, problem }),
    );
    expect(result.domain).toBeUndefined();
    expect(result.retry?.verdict).toBe("yes");
    expect(result.hint).toBeDefined();
  });

  it("keeps the status storage answered with, and claims no outcome the SDK calls unknown", () => {
    const err = new UploadTransportError("storage answered 503", {
      status: 503,
      reason: "server_error",
    });
    const result = classifyUploadError(err);
    expect(result.details).toContain("status: 503");
    expect(result.message).toContain("HTTP 503");
    // Storage may have written the object before it failed, so the SDK cannot
    // say whether the file was stored, and neither can the message.
    expect(result.message).not.toMatch(/not stored|could not be stored/);
    expect(result.retry?.verdict).toBe("yes");
  });

  it("says a request storage does not implement is final, and offers no retry", () => {
    const err = new UploadTransportError("storage answered 501", {
      status: 501,
      reason: "server_error",
    });
    const result = classifyUploadError(err);
    expect(result.title).toBe("Pipelex storage can't take this upload");
    expect(result.message).toContain("HTTP 501");
    expect(result.message).toMatch(/nothing was stored/);
    expect(result.hint).toBeUndefined();
    expect(result.retry?.verdict).toBe("no");
  });

  it.each([
    [429, true],
    [408, true],
    [418, false],
  ] as const)(
    "offers to drop the file again for an unexpected answer (HTTP %s) only when its problem says a retry can pass",
    (status, offered) => {
      const err = new UploadTransportError("upload failed", { reason: "unexpected", status });
      expect(classifyUploadError(err).hint !== undefined).toBe(offered);
    },
  );

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
    expect(result.message).toContain("1.6 MB");
    expect(result.message).toContain("at most 1 MB");
    expect(result.message).toMatch(/Files don't count/);
    expect(result.details).toBe("inputs_too_large: 1534000 bytes, limit 1000000 bytes");
  });

  it.each([1_000_001, 1_020_000, 1_049_999])(
    "never prints a size equal to the limit for %i bytes, just past it",
    (bytes) => {
      const result = buildInputsTooLargeError(bytes, 1_000_000);
      expect(result.message).toContain("come to 1.1 MB");
      expect(result.message).toContain("at most 1 MB");
    },
  );
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
    expect(result.retry).toBeUndefined();
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
