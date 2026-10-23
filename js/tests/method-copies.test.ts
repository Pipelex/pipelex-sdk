/**
 * A method copied into another organization and the copies a method lists: the copy's request,
 * its idempotency key, its two verdicts and every refusal the route answers, the copies page, and
 * the `copied_from` a copy's method reads carry — all against a mocked fetch. The Python SDK holds
 * the same routes to the same tests in `tests/unit/test_client_method_copies.py`.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import type { MethodCopyRequestOptions } from "../src/client.js";
import type { ProblemError } from "mthds/protocol";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import type { MethodErrorCode } from "../src/errors.js";
import type {
  MethodCopiedFrom,
  MethodCopyLimit,
  MethodCopyMarker,
  MethodCopyResult,
  MethodData,
} from "../src/product-models.js";
import { problemDocument } from "./helpers/problems.js";
import type { ProblemMembers } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const KEY = "0c7e1a4f-5b2d-4e8a-9f61-3d2c7b8a1e05";
const DIGEST = "sha256:5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47";
const COPY_PATH = "/v1/methods/mt_receipts01/copy";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The URL, method, headers and parsed body of the one fetch call the spy recorded. */
function onlyRequest(spy: { mock: { calls: unknown[][] } }): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
} {
  expect(spy.mock.calls).toHaveLength(1);
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    headers: init.headers as Record<string, string>,
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
  };
}

/** What a call rejected with. */
async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => expect.fail("expected the call to throw"),
    (thrown: unknown) => thrown,
  );
}

const COPIED_FROM: MethodCopiedFrom = {
  org_id: "org_personal",
  method_id: "mt_receipts01",
  draft_digest: DIGEST,
};

/** The copy as the platform serializes it: a new, unpublished method of the destination. */
const WIRE_COPY = {
  method_id: "mt_copy01",
  org_id: "org_team",
  created_by_user_id: "user_1",
  name: "Receipt review",
  input_data: { photo: { url: "pipelex-storage://org_team/assets/1b2c.png" } },
  pipe_output: null,
  description: "Review a receipt",
  created_at: "2026-10-23T09:00:00+00:00",
  updated_at: "2026-10-23T09:00:00+00:00",
  deletion_state: null,
  draft_digest: DIGEST,
  latest_version: null,
  latest_published: null,
  copied_from: COPIED_FROM,
};

const COPIED = {
  outcome: "copied",
  method: WIRE_COPY,
  examples_copied: 2,
  stored_files_copied: 1,
};

const REFUSED = {
  outcome: "refused",
  reason: "bundle_names_other_storage",
  message:
    "main.mthds names a stored file the destination cannot read; remove or replace it, then copy again.",
  references: [{ path: "main.mthds", uri: "pipelex-storage://org_personal/assets/logo.png" }],
};

const MARKER: MethodCopyMarker = {
  copy_method_id: "mt_copy01",
  destination_org_id: "org_team",
  copied_by_user_id: "user_1",
  copied_at: "2026-10-23T09:00:00+00:00",
};

/** A problem document as the platform renders one of its refusals of the copy. */
function problem(
  status: number,
  code: string,
  members: ProblemMembers = {},
): Record<string, unknown> {
  return problemDocument(code, status, { instance: COPY_PATH, ...members });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("copyMethod — the request", () => {
  it("POSTs the destination alone to /v1/methods/{id}/copy and hands back the copied verdict", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, COPIED));

    const result = await makeClient().copyMethod("mt_receipts01", {
      destination_org_id: "org_team",
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}${COPY_PATH}`);
    expect(req.body).toEqual({ destination_org_id: "org_team" });
    expect(result).toEqual(COPIED);
  });

  it("sends the name and the draft token when given", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, COPIED));

    await makeClient().copyMethod("mt_receipts01", {
      destination_org_id: "org_personal",
      name: "Receipt review (copy)",
      expected_draft_updated_at: "2026-10-08T09:00:00.123456+00:00",
    });

    expect(onlyRequest(spy).body).toEqual({
      destination_org_id: "org_personal",
      name: "Receipt review (copy)",
      expected_draft_updated_at: "2026-10-08T09:00:00.123456+00:00",
    });
  });

  it("reads a null name or token as not given, and sends nothing else an untyped caller passes", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, COPIED));

    await makeClient().copyMethod("mt_receipts01", {
      destination_org_id: "org_team",
      name: null,
      expected_draft_updated_at: null,
      examples: false,
    } as unknown as { destination_org_id: string });

    expect(onlyRequest(spy).body).toEqual({ destination_org_id: "org_team" });
  });

  it.each([
    ["no destination", {}, "got undefined"],
    ["an empty destination", { destination_org_id: "" }, "got an empty string"],
    ["a destination that is not a string", { destination_org_id: 42 }, "got number"],
  ])("refuses %s before sending anything", async (_, input, got) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().copyMethod("mt_receipts01", input as unknown as { destination_org_id: string }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "copyMethod() takes a destination_org_id, the canonical id of the organization to copy " +
        `into, a non-empty string; ${got}.`,
    );
    expect((err as ProblemError).problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["name", { name: 7 }, "a name for the copy, a string, or none; got 7."],
    [
      "expected_draft_updated_at",
      { expected_draft_updated_at: false },
      "an expected_draft_updated_at, the draft token the caller last read, the method's " +
        "`updated_at`, a string, or none; got boolean.",
    ],
  ])("refuses a %s that is not a string before sending anything", async (_, extra, words) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().copyMethod("mt_receipts01", {
        destination_org_id: "org_team",
        ...(extra as Record<string, unknown>),
      }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(`copyMethod() takes ${words}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().copyMethod("mt_receipts01@3", { destination_org_id: "org_team" }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain("carries a version suffix");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("copyMethod — the idempotency key", () => {
  it("sends the key as the Idempotency-Key header, beside the usual headers, never in the body", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, COPIED));

    await makeClient().copyMethod(
      "mt_receipts01",
      { destination_org_id: "org_team" },
      { idempotencyKey: KEY },
    );

    const req = onlyRequest(spy);
    expect(req.headers["Idempotency-Key"]).toBe(KEY);
    expect(req.headers["Authorization"]).toBe("Bearer test-token");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.headers["Accept"]).toBe("application/json");
    expect(req.body).toEqual({ destination_org_id: "org_team" });
  });

  it.each([
    ["absent", undefined],
    ["empty options", {}],
    ["null", { idempotencyKey: null }],
  ])("sends no Idempotency-Key header when the key is %s", async (_, options) => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, COPIED));

    await makeClient().copyMethod("mt_receipts01", { destination_org_id: "org_team" }, options);

    const names = Object.keys(onlyRequest(spy).headers).map((name) => name.toLowerCase());
    expect(names).not.toContain("idempotency-key");
  });

  it("sends the same key and the same body on a caller's retry", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(503, problem(503, "runtime.unavailable", { domain: "runtime", retry: "yes" })),
      )
      .mockResolvedValueOnce(jsonResponse(200, COPIED));
    const client = makeClient();
    const input = { destination_org_id: "org_team", name: "Receipts" };

    const err = await failureOf(() =>
      client.copyMethod("mt_receipts01", input, { idempotencyKey: KEY }),
    );
    expect((err as ProblemError).problem).toMatchObject({ domain: "runtime", retry: "yes" });
    const result = await client.copyMethod("mt_receipts01", input, { idempotencyKey: KEY });

    expect(result.outcome).toBe("copied");
    const [first, retry] = spy.mock.calls.map((call) => call[1] as RequestInit);
    expect((retry!.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY);
    expect((first!.headers as Record<string, string>)["Idempotency-Key"]).toBe(KEY);
    expect(retry!.body).toBe(first!.body);
  });

  it.each([
    ["is empty", "", "this one is empty"],
    ["holds a space", "copy 42", "this one holds a character outside visible ASCII"],
    ["is longer than 255 characters", "k".repeat(256), "this one is 256 characters long"],
    ["is not a string", 42 as unknown as string, "this one is not a string"],
  ])("refuses a key that %s before anything is sent", async (_, idempotencyKey, fault) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().copyMethod(
        "mt_receipts01",
        { destination_org_id: "org_team" },
        { idempotencyKey },
      ),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    const message = (err as Error).message;
    expect(message).toContain(fault);
    expect(message).toContain("1 to 255 visible ASCII characters");
    expect(message).toContain("Leave it out to copy the method without one.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads a key an earlier copy still holds as a refusal worth sending again", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        409,
        problem(409, "request.idempotency_key_in_use", { domain: "runtime", retry: "yes" }),
      ),
    );

    const err = await failureOf(() =>
      makeClient().copyMethod(
        "mt_receipts01",
        { destination_org_id: "org_team" },
        { idempotencyKey: KEY },
      ),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    const refused = err as ApiResponseError;
    expect(refused.code).toBe("request.idempotency_key_in_use");
    expect(refused.retry).toBe("yes");
  });

  it("types the option as an optional string or null", () => {
    expectTypeOf<MethodCopyRequestOptions["idempotencyKey"]>().toEqualTypeOf<
      string | null | undefined
    >();
  });
});

describe("copyMethod — the verdict", () => {
  it("hands back the copy with copied_from naming the original", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, COPIED));

    const result = await makeClient().copyMethod("mt_receipts01", {
      destination_org_id: "org_team",
    });

    expect(result.outcome).toBe("copied");
    if (result.outcome !== "copied") throw new Error("narrowed above");
    expect(result.method.method_id).toBe("mt_copy01");
    expect(result.method.org_id).toBe("org_team");
    expect(result.method.copied_from).toEqual(COPIED_FROM);
    expect(result.method.latest_version).toBeNull();
    expect(result.examples_copied).toBe(2);
    expect(result.stored_files_copied).toBe(1);
  });

  it("hands back a refusal naming every reference the destination cannot read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, REFUSED));

    const result = await makeClient().copyMethod("mt_receipts01", {
      destination_org_id: "org_team",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("narrowed above");
    expect(result.reason).toBe("bundle_names_other_storage");
    expect(result.message).toBe(REFUSED.message);
    expect(result.references).toEqual(REFUSED.references);
  });

  it("narrows on outcome", () => {
    expectTypeOf<MethodCopyResult["outcome"]>().toEqualTypeOf<"copied" | "refused">();
    expectTypeOf<
      Extract<MethodCopyResult, { outcome: "copied" }>["method"]
    >().toEqualTypeOf<MethodData>();
    expectTypeOf<Extract<MethodCopyResult, { outcome: "refused" }>>().toHaveProperty("references");
    expectTypeOf<
      Extract<MethodCopyResult, { outcome: "refused" }>["reason"]
    >().toEqualTypeOf<"bundle_names_other_storage">();
  });

  it.each([
    [
      "an outcome it does not know",
      { outcome: "queued", method: WIRE_COPY },
      "a copy result whose `outcome` is not `copied` or `refused`",
    ],
    [
      "no outcome",
      { method: WIRE_COPY, examples_copied: 0, stored_files_copied: 0 },
      "a copy result whose `outcome` is not `copied` or `refused`",
    ],
    [
      "a copied outcome with no method",
      { outcome: "copied", examples_copied: 0, stored_files_copied: 0 },
      "a `copied` copy result whose `method` is not an object",
    ],
    [
      "a refused outcome whose references are not a list",
      { ...REFUSED, references: "main.mthds" },
      "a `refused` copy result whose `references` is not an array",
    ],
  ])("throws a typed ApiResponseError for %s", async (_, body, words) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await failureOf(() =>
      makeClient().copyMethod("mt_receipts01", { destination_org_id: "org_team" }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API POST ${COPY_PATH} answered 200 with ${words}`,
    );
    expect((err as ProblemError).problem).toMatchObject({
      code: "client.response_unreadable",
      domain: "runtime",
      retry: "no",
    });
  });
});

describe("copyMethod — the refusals", () => {
  it.each([
    ["a request that is not from a web session", 403, "auth.forbidden", "account", "no"],
    ["a role that changes no method, here or there", 403, "auth.forbidden", "account", "no"],
    ["a destination the caller does not belong to", 404, "pipelex.org.not_found", "input", "no"],
    ["an unknown method", 404, "pipelex.catalog.not_found", "input", "no"],
    ["a method being erased", 409, "pipelex.catalog.being_deleted", "input", "no"],
    ["a draft that moved since the token", 409, "pipelex.catalog.update_conflict", "input", "no"],
    ["an example too large for one item", 413, "request.too_large", "input", "no"],
    ["a body that does not validate", 422, "request.invalid", "input", "no"],
    ["a WorkOS read that failed", 502, "runtime.unavailable", "runtime", "yes"],
    ["a storage backend failure", 503, "pipelex.storage.unavailable", "runtime", "yes"],
    ["a copy past its deadline", 503, "runtime.unavailable", "runtime", "yes"],
  ] as const)(
    "throws %s as an ApiResponseError with its problem",
    async (_, status, code, domain, retry) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(status, problem(status, code, { domain, retry })),
      );

      const err = await failureOf(() =>
        makeClient().copyMethod("mt_receipts01", { destination_org_id: "org_team" }),
      );

      expect(err).toBeInstanceOf(ApiResponseError);
      const refused = err as ApiResponseError;
      expect(refused.status).toBe(status);
      expect(refused.problem).toMatchObject({ code, domain, retry });
    },
  );

  it.each([
    [404, "request.not_found"],
    [403, "auth.invalid_credential"],
    [422, "client.response_unreadable"],
  ] as const)(
    "reads a %i whose body is no problem document by its status, as %s",
    async (status, code) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(status, { status, code: "organization_not_found", detail: "Refused." }),
      );

      const err = await failureOf(() =>
        makeClient().copyMethod("mt_receipts01", { destination_org_id: "org_team" }),
      );

      expect((err as ApiResponseError).code).toBe(code);
    },
  );

  it("reads a copy past its bounds with the limit it names", async () => {
    const limit: MethodCopyLimit = { name: "max_stored_files", value: 200, reached: 201 };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, problem(422, "pipelex.catalog.copy_too_large", { limit })),
    );

    const err = await failureOf(() =>
      makeClient().copyMethod("mt_receipts01", { destination_org_id: "org_team" }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    const refused = err as ApiResponseError;
    const tooLarge: MethodErrorCode = "pipelex.catalog.copy_too_large";
    expect(refused.code).toBe(tooLarge);
    expect(refused.problem.limit as MethodCopyLimit).toEqual(limit);
    expect(refused.problem).toMatchObject({ domain: "input", retry: "no" });
  });

  it("reads a stale token as a 409 pipelex.catalog.update_conflict locating the field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        409,
        problem(409, "pipelex.catalog.update_conflict", {
          next_step: { kind: "refresh", detail: "Read the method again." },
          location: { field: "expected_draft_updated_at" },
        }),
      ),
    );

    const err = await failureOf(() =>
      makeClient().copyMethod("mt_receipts01", {
        destination_org_id: "org_team",
        expected_draft_updated_at: "t0",
      }),
    );

    expect((err as ApiResponseError).code).toBe("pipelex.catalog.update_conflict");
    expect((err as ApiResponseError).problem.location?.field).toBe("expected_draft_updated_at");
  });
});

describe("listMethodCopies", () => {
  it("GETs /v1/methods/{id}/copies and maps the page envelope", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [MARKER], next_cursor: "c2" }));

    const page = await makeClient().listMethodCopies("mt_receipts01");

    const req = onlyRequest(spy);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE_URL}/v1/methods/mt_receipts01/copies`);
    expect(page).toEqual({ items: [MARKER], nextCursor: "c2" });
  });

  it("forwards limit and cursor, an explicit empty cursor included", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [], next_cursor: null })),
      );
    const client = makeClient();

    await client.listMethodCopies("mt_receipts01", { limit: 5, cursor: "c1" });
    expect(onlyRequest(spy).url).toBe(
      `${BASE_URL}/v1/methods/mt_receipts01/copies?limit=5&cursor=c1`,
    );

    spy.mockClear();
    await client.listMethodCopies("mt_receipts01", { cursor: "" });
    expect(onlyRequest(spy).url).toBe(`${BASE_URL}/v1/methods/mt_receipts01/copies?cursor=`);
  });

  it("follows the cursor to the last page", async () => {
    const second: MethodCopyMarker = { ...MARKER, copy_method_id: "mt_copy02" };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [MARKER], next_cursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [second], next_cursor: null }));
    const client = makeClient();

    const first = await client.listMethodCopies("mt_receipts01", { limit: 1 });
    const last = await client.listMethodCopies("mt_receipts01", {
      limit: 1,
      cursor: first.nextCursor!,
    });

    expect([...first.items, ...last.items].map((marker) => marker.copy_method_id)).toEqual([
      "mt_copy01",
      "mt_copy02",
    ]);
    expect(last.nextCursor).toBeNull();
  });

  it("reads a method never copied as an empty last page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [], next_cursor: null }),
    );

    await expect(makeClient().listMethodCopies("mt_receipts01")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it.each([
    ["an unknown method", 404, "pipelex.catalog.not_found"],
    ["a method being erased", 409, "pipelex.catalog.being_deleted"],
    ["a cursor it did not issue", 422, "request.invalid"],
    ["a limit outside 1 to 100", 422, "request.invalid"],
  ] as const)("throws %s as an ApiResponseError with its problem", async (_, status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(status, problemDocument(code, status, { detail: "Refused." })),
    );

    const err = await failureOf(() => makeClient().listMethodCopies("mt_receipts01"));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ProblemError).problem).toMatchObject({ code, domain: "input", retry: "no" });
  });

  it("throws a typed ApiResponseError on a page it cannot walk", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: [MARKER] }));

    const err = await failureOf(() => makeClient().listMethodCopies("mt_receipts01"));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      "API GET /v1/methods/mt_receipts01/copies answered 200 with a page whose " +
        "`next_cursor` is neither a string nor null",
    );
  });

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() => makeClient().listMethodCopies("mt_receipts01@draft"));

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("copied_from on a method read", () => {
  it("hands back the original a copy names, and null on a method created afresh", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { ...WIRE_COPY, files: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { ...WIRE_COPY, copied_from: null, files: [] }));
    const client = makeClient();

    const copy = await client.getMethod("mt_copy01");
    const fresh = await client.getMethod("mt_copy01");

    expect(copy.copied_from).toEqual(COPIED_FROM);
    expect(fresh.copied_from).toBeNull();
  });

  it("types copied_from as optional and nullable, with a nullable digest", () => {
    expectTypeOf<MethodData["copied_from"]>().toEqualTypeOf<MethodCopiedFrom | null | undefined>();
    expectTypeOf<MethodCopiedFrom["draft_digest"]>().toEqualTypeOf<string | null>();
  });
});
