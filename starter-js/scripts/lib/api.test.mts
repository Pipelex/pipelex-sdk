// @vitest-environment node
//
// The handshake is the difference between "403 Forbidden" and a line that says
// which base URL is missing which capability, so what it does when it cannot
// tell is as load-bearing as what it does when it can: a refusal on a
// handshake that failed would replace the real call's error with a guess.

import { describe, expect, it, vi } from "vitest";

import { ApiResponseError, type PipelexApiClient } from "@pipelex/sdk";

import { assertSelectorSupport, explainSelectorFailure, selectorKindsOf } from "./api.mts";

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
  function apiError(status: number, serverMessage: string): ApiResponseError {
    return new ApiResponseError(
      `API POST /v1/codegen failed (${status})`,
      "https://api.example/v1/codegen",
      status,
      "Not Found",
      "{}",
      "MethodPackageNotFoundError",
      serverMessage,
      undefined,
      undefined,
    );
  }

  it("prints the server's own message verbatim under the selector it names", () => {
    const line = explainSelectorFailure(apiError(404, "Packages it contains: a, b."), {
      method_ref: "github.com/Pipelex/methods/nope",
    });

    expect(line).toContain("method_ref github.com/Pipelex/methods/nope");
    expect(line).toContain("Packages it contains: a, b.");
  });

  // Anything but a 404 is a different failure with a different remedy — a 403 is
  // the capability question the handshake answers, a 5xx is the API's problem.
  it("declines a non-404, leaving the general explanation in charge", () => {
    expect(explainSelectorFailure(apiError(403, "Forbidden"), { method_id: "mt_x" })).toBeNull();
  });

  it("declines a thrown value that is not an API response at all", () => {
    expect(explainSelectorFailure(new Error("socket hang up"), { method_id: "mt_x" })).toBeNull();
  });
});
