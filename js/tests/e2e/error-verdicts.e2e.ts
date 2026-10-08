/**
 * E2E suite for the verdict a refused request carries — exercised against a LIVE hosted
 * platform (no fetch mocks). Run with `make test-e2e` (or `npm run test:e2e`) against a
 * platform whose own problem documents carry `retryable` and `error_domain`, with
 * `PIPELEX_API_KEY` set for it:
 *
 *     PIPELEX_E2E_BASE_URL=https://api-dev.pipelex.com PIPELEX_API_KEY=plx_sk_… npm run test:e2e
 *
 * What the unit suite cannot prove: that the verdict on an `ApiResponseError` is the one the
 * server sent. The error takes each member from the problem document when the server sent it,
 * and from the fallback table when it did not, and nothing on the error says which
 * (`docs/errors.md`, "A refused request's verdict"). For every refusal here the two agree, so
 * the error alone reads the same either way. `problemDocument` keeps the document as the
 * server sent it, so each case asserts the verdict there as well as on the error.
 *
 * Two cases provoke a refusal the platform renders itself, before any runner sees the request:
 * a run of a method id the catalog does not hold, a named `404`, and a request body the
 * platform's own validation refuses, a `422`. The third, a rejected API key, never reaches the
 * platform: the gateway's authorizer refuses it with API Gateway's bare
 * `403 {"message":"Forbidden"}`, which carries no verdict, so its verdict is the SDK's fallback
 * alone, and the case asserts that the document says nothing. It changes when the edge answers
 * that refusal with a problem document of its own.
 *
 * A bare runner cannot run it (no authentication, no catalog, no storage routes) and fails it
 * honestly rather than skipping.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
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

describe("the verdict of a platform refusal against a live platform", () => {
  const client = new PipelexApiClient({ baseUrl: BASE_URL });

  it("reads a rejected API key as config and not retryable, a verdict the gateway's 403 does not carry", async () => {
    const stranger = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: unknownApiKey() });

    const refusal = await refusalOf(stranger.getMe());

    expect(refusal.status).toBe(403);
    expect(refusal.retryable).toBe(false);
    expect(refusal.errorDomain).toBe("config");
    // The authorizer refused the key before the platform saw it: the body is API Gateway's,
    // with no `code` and no verdict, so the verdict above is the fallback's reading of the 403.
    expect(refusal.code).toBeUndefined();
    expect(refusal.problemDocument).toBeDefined();
    expect(refusal.problemDocument).not.toHaveProperty("retryable");
    expect(refusal.problemDocument).not.toHaveProperty("error_domain");
  });

  it("reads a run of a method id the catalog does not hold as input and not retryable, as the platform sent it", async () => {
    const refusal = await refusalOf(client.start({ method_id: UNKNOWN_METHOD_ID }));

    expect(refusal.status).toBe(404);
    expect(refusal.code).toBe("not_found");
    expect(refusal.retryable).toBe(false);
    expect(refusal.errorDomain).toBe("input");
    expect(refusal.problemDocument).toMatchObject({ retryable: false, error_domain: "input" });
  });

  it("reads a request body the platform's validation refuses as input and not retryable, as the platform sent it", async () => {
    const refusal = await refusalOf(client.resolveStorageUrl({ uri: OVERLONG_STORAGE_URI }));

    expect(refusal.status).toBe(422);
    expect(refusal.code).toBe("validation_failed");
    // The platform's field-level list names the field its own validation refused.
    expect(refusal.errors?.map((item) => item.field)).toEqual(["uri"]);
    expect(refusal.retryable).toBe(false);
    expect(refusal.errorDomain).toBe("input");
    expect(refusal.problemDocument).toMatchObject({ retryable: false, error_domain: "input" });
  });
});
