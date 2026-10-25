/**
 * E2E suite for the problem a refused request carries — exercised against a LIVE hosted
 * platform (no fetch mocks). Run with `make test-e2e` (or `npm run test:e2e`) against a
 * platform that answers problem documents, with `PIPELEX_API_KEY` set for it:
 *
 *     PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com PIPELEX_API_KEY=plx_sk_… npm run test:e2e
 *
 * What the unit suite cannot prove: that the problem on an `ApiResponseError` is the one the
 * server sent. The error reads a problem document as received, and builds one from the status by
 * the edge's rules when the body is none (`docs/errors.md`, "An answer that is no problem document"), and
 * `responseBody` keeps the body as the server sent it, so each case asserts which it was.
 *
 * Two cases provoke a refusal the platform renders itself, before any runner sees the request:
 * a run of a method id the catalog does not hold, and a request body the platform's own
 * validation refuses. The third, a rejected API key, never reaches the platform: the gateway's
 * authorizer refuses it with API Gateway's bare `403 {"message":"Forbidden"}`, which is no problem
 * document, so its problem is the SDK's reading of the status, `auth.invalid_credential`. It
 * changes when the edge answers that refusal with a problem document of its own.
 *
 * A bare runner cannot run it (no authentication, no catalog, no storage routes) and fails it
 * honestly rather than skipping.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readProblemBody } from "mthds/protocol";
import { PipelexApiClient } from "../../src/client.js";
import { ApiResponseError } from "../../src/errors.js";

const BASE_URL = process.env.PIPELEX_E2E_BASE_URL ?? "http://localhost:8081";

/**
 * A key in the platform's own format, `plx_sk_`, a 64-hex secret and its CRC32, that no
 * organization holds. The checksum is right, so the authorizer looks the key up rather than
 * refusing it as malformed: the refusal is the one a revoked or mistyped key meets.
 */
function unknownApiKey(): string {
  const secret = randomBytes(32).toString("hex");
  const checksum = crc32(secret).toString(16).padStart(8, "0");
  return `plx_sk_${secret}_${checksum}`;
}

/** A catalog id in the platform's own form, `mt_` and a UUID, that no method carries. */
const UNKNOWN_METHOD_ID = `mt_${randomUUID()}`;

/**
 * A storage reference longer than the 512 characters the platform's resolve route accepts. The
 * SDK sends it as given, and the platform's request validation refuses it before the route
 * reads it; no runner serves the route.
 */
const OVERLONG_STORAGE_URI = `pipelex-storage://${"a".repeat(600)}`;

/** The refusal a call ends in, read as the `ApiResponseError` the SDK throws for it. */
async function refusalOf(call: Promise<unknown>): Promise<ApiResponseError> {
  const error = await call.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiResponseError);
  return error as ApiResponseError;
}

describe("the problem of a platform refusal against a live platform", () => {
  const client = new PipelexApiClient({ baseUrl: BASE_URL });

  it("reads a rejected API key as auth.invalid_credential, read from the gateway's bare 403", async () => {
    const stranger = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: unknownApiKey() });

    const refusal = await refusalOf(stranger.getMe());

    expect(refusal.status).toBe(403);
    expect(refusal.code).toBe("auth.invalid_credential");
    expect(refusal.retry).toBe("no");
    // The authorizer refused the key before the platform saw it: the body is API Gateway's, no
    // problem document, so the problem above is the SDK's reading of the 403.
    expect(readProblemBody(refusal.responseBody)).toBeUndefined();
  });

  it("reads a run of a method id the catalog does not hold as the platform's problem", async () => {
    const refusal = await refusalOf(client.start({ method_id: UNKNOWN_METHOD_ID }));

    expect(refusal.status).toBe(404);
    expect(refusal.code).toBe("pipelex.catalog.not_found");
    expect(refusal.problem).toMatchObject({ domain: "input", retry: "no" });
    expect(readProblemBody(refusal.responseBody)).toMatchObject({ code: refusal.code });
  });

  it("reads a request body the platform's validation refuses as the platform's problem, its items naming the field", async () => {
    const refusal = await refusalOf(client.resolveStorageUrl({ uri: OVERLONG_STORAGE_URI }));

    expect(refusal.status).toBe(422);
    expect(refusal.code).toBe("request.malformed");
    expect(refusal.problem.errors?.map((item) => item.location?.field)).toEqual(["uri"]);
    expect(refusal.problem).toMatchObject({ domain: "input", retry: "no" });
    expect(readProblemBody(refusal.responseBody)).toMatchObject({ code: refusal.code });
  });
});
