// @vitest-environment node
//
// The handshake is the difference between "403 Forbidden" and a line that says
// which base URL is missing which capability, so what it does when it cannot
// tell is as load-bearing as what it does when it can: a refusal on a
// handshake that failed would replace the real call's error with a guess.

import { describe, expect, it, vi } from "vitest";

import { ApiResponseError, buildProblem, type PipelexApiClient } from "@pipelex/sdk";

import {
  assertSelectorSupport,
  describeRequestFailure,
  explainSelectorFailure,
  selectorKindsOf,
} from "./api.mts";
import { methodNotFoundBody } from "./fixtures/problems.mts";

/** A client whose `version()` answers with the given body, or throws. */
function versionClient(
  body: Record<string, unknown> | Error,
): Pick<PipelexApiClient, "version"> & { version: ReturnType<typeof vi.fn> } {
  const version = vi.fn();
  if (body instanceof Error) version.mockRejectedValue(body);
  else version.mockResolvedValue(body);
  return { version } as unknown as Pick<PipelexApiClient, "version"> & {
    version: ReturnType<typeof vi.fn>;
  };
}

const DEV = { protocol_version: "1", extensions: ["runs", "method_id", "method_ref"] };
const PROD = { protocol_version: "1", extensions: ["runs", "method_id"] };

describe("assertSelectorSupport", () => {
  it("does not call the API at all when no selector is in play", async () => {
    const client = versionClient(PROD);

    expect(await assertSelectorSupport(client, "https://api.example", new Set())).toBeNull();
    expect(client.version).not.toHaveBeenCalled();
  });

  it("passes when every needed kind is advertised", async () => {
    const kinds = new Set(["method_ref", "method_id"] as const);

    expect(
      await assertSelectorSupport(versionClient(DEV), "https://api.example", kinds),
    ).toBeNull();
  });

  it("refuses a base URL that advertises method_id but not method_ref", async () => {
    const message = await assertSelectorSupport(
      versionClient(PROD),
      "https://api.example",
      new Set(["method_ref"] as const),
    );

    expect(message).toContain("method_ref");
    expect(message).toContain("https://api.example");
    expect(message).toContain("It advertises: runs, method_id");
    expect(message).toContain("PIPELEX_BASE_URL");
  });

  it("names every missing kind, not just the first", async () => {
    const message = await assertSelectorSupport(
      versionClient({ protocol_version: "1", extensions: ["runs"] }),
      "https://api.example",
      new Set(["method_ref", "method_id"] as const),
    );

    expect(message).toContain("method_id, method_ref");
  });

  // Both of these deliberately proceed: the handshake has no verdict to give,
  // and the real call's own error is the better message. Refusing here would
  // turn "the API is down" into "the API lacks a capability".
  it("proceeds when the handshake itself fails", async () => {
    const client = versionClient(new Error("connect ECONNREFUSED"));

    expect(
      await assertSelectorSupport(client, "https://api.example", new Set(["method_ref"] as const)),
    ).toBeNull();
  });

  it("proceeds when the response advertises no capabilities at all", async () => {
    const client = versionClient({ protocol_version: "1" });

    expect(
      await assertSelectorSupport(client, "https://api.example", new Set(["method_ref"] as const)),
    ).toBeNull();
  });

  it("proceeds when extensions is not an array of strings", async () => {
    const client = versionClient({ protocol_version: "1", extensions: [1, 2] });

    expect(
      await assertSelectorSupport(client, "https://api.example", new Set(["method_ref"] as const)),
    ).toBeNull();
  });
});

describe("selectorKindsOf", () => {
  it("collapses a mixed set to the distinct kinds", () => {
    expect(
      selectorKindsOf([
        { method_ref: "github.com/o/a" },
        { method_ref: "github.com/o/b" },
        { method_id: "mt_x" },
      ]),
    ).toEqual(new Set(["method_ref", "method_id"]));
  });

  it("is empty for no selectors, which is what skips the handshake", () => {
    expect(selectorKindsOf([]).size).toBe(0);
  });
});

describe("explainSelectorFailure", () => {
  /** A refused codegen call, as the SDK's client throws it: the body as received. */
  function apiError(status: number, body: string): ApiResponseError {
    return new ApiResponseError(
      `API POST /v1/codegen failed (${status})`,
      "https://api.example/v1/codegen",
      status,
      "",
      body,
    );
  }

  it("prints the problem's detail and next step verbatim under the selector it names", () => {
    const line = explainSelectorFailure(
      apiError(404, methodNotFoundBody("github.com/Pipelex/methods/nope")),
      { method_ref: "github.com/Pipelex/methods/nope" },
    );

    expect(line).toContain("method_ref github.com/Pipelex/methods/nope");
    expect(line).toContain(
      "No method is found at 'github.com/Pipelex/methods/nope'. (method.not_found)",
    );
    expect(line).toContain("Next step: Correct the method's address");
  });

  // A bare 404 is the route missing, which the SDK reads as `request.not_found`:
  // the method was never looked for, so the general explanation names the route.
  it("declines a route the base URL does not serve", () => {
    expect(
      explainSelectorFailure(apiError(404, '{"detail":"Not Found"}'), { method_id: "mt_x" }),
    ).toBeNull();
  });

  // Anything but a not-found is a different failure with a different remedy — a
  // 403 is the capability question the handshake answers, a 5xx is the API's problem.
  it("declines a failure other than a not-found, leaving the general explanation in charge", () => {
    expect(explainSelectorFailure(apiError(403, ""), { method_id: "mt_x" })).toBeNull();
  });

  it("declines a thrown value that is not an API response at all", () => {
    expect(explainSelectorFailure(new Error("socket hang up"), { method_id: "mt_x" })).toBeNull();
  });
});

describe("describeRequestFailure", () => {
  it("prints a refusal from its problem: status, route, detail, code, next step and request id", () => {
    const err = new ApiResponseError(
      "API POST /v1/codegen failed (404)",
      "https://api.example/v1/codegen",
      404,
      "",
      methodNotFoundBody("github.com/Pipelex/methods/nope"),
    );
    expect(describeRequestFailure(err, "POST /v1/codegen")).toBe(
      [
        "HTTP 404 from POST /v1/codegen — No method is found at 'github.com/Pipelex/methods/nope'. (method.not_found)",
        "  Next step: Correct the method's address, then send the request again.",
        "  Request id: req_method_404",
      ].join("\n"),
    );
  });

  it("prints a bare answer by the SDK's reading of its status, never its body", () => {
    const err = new ApiResponseError("API POST /v1/codegen failed (503)", "x", 503, "", "<html>");
    const line = describeRequestFailure(err, "POST /v1/codegen");
    expect(line).toContain("HTTP 503 from POST /v1/codegen");
    expect(line).toContain("(runtime.unavailable)");
    expect(line).not.toContain("<html>");
  });

  it("names both the key and the base URL for a bare 403, which a gateway answers to either", () => {
    const err = new ApiResponseError(
      "API POST /v1/pipe-io failed (403)",
      "x",
      403,
      "Forbidden",
      "",
      {
        headers: { "x-request-id": "req_gw_1" },
      },
    );
    // The SDK reads the bare status as a refused key, which the answer cannot prove.
    expect(err.code).toBe("auth.invalid_credential");
    const text = describeRequestFailure(err, "POST /v1/pipe-io", "https://proxy.example");
    expect(text).toContain("HTTP 403 from POST /v1/pipe-io, with no problem document");
    expect(text).toContain(
      "either the API key was refused, or the base URL does not serve this route",
    );
    expect(text).toContain("PIPELEX_API_KEY");
    expect(text).toContain("PIPELEX_BASE_URL (https://proxy.example)");
    expect(text).not.toContain("auth.invalid_credential");
    expect(text).toContain("  Request id: req_gw_1");
  });

  it("reads a 403 that carried a problem document from that problem", () => {
    const body = JSON.stringify({ ...buildProblem("auth.invalid_credential", {}), status: 403 });
    const err = new ApiResponseError("API POST /v1/codegen failed (403)", "x", 403, "", body);
    const text = describeRequestFailure(err, "POST /v1/codegen", "https://api.pipelex.com");
    expect(text).toContain("(auth.invalid_credential)");
    expect(text).not.toContain("with no problem document");
  });

  it("keeps a thrown value with no problem as its message", () => {
    expect(describeRequestFailure(new Error("socket hang up"), "POST /v1/codegen")).toBe(
      "socket hang up",
    );
  });
});
