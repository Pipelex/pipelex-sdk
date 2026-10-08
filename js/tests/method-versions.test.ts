/**
 * A saved method's draft and published versions: the draft write, the rename, the publish and
 * its outcome union, the version reads, the run fields that say which version ran, and the
 * method error codes — all against a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, errorVerdictOf, RequestArgumentError } from "../src/errors.js";
import type { MethodErrorCode } from "../src/errors.js";
import type {
  MethodData,
  MethodDeletionState,
  MethodPublishResult,
  MethodSummary,
  MethodVersionSummary,
  PipelineRun,
  RunHistoryItem,
} from "../src/product-models.js";
import type { PipelexRunResultStart } from "../src/models.js";
import type { RunPublic } from "../src/runs.js";

const BASE_URL = "http://localhost:8081";
const DIGEST = "5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47";
const OTHER_DIGEST = "0d1c2b3a49586776a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f1e";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The URL, method and parsed body of the one fetch call the spy recorded. */
function onlyRequest(spy: ReturnType<typeof vi.spyOn>): {
  url: string;
  method: string;
  body: unknown;
} {
  expect(spy).toHaveBeenCalledTimes(1);
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
  };
}

const SUMMARY: MethodVersionSummary = {
  version: 3,
  source_digest: DIGEST,
  crate_fingerprint: "a1b2c3",
  runner_version: "0.80.0",
  description: "Review a receipt",
  published_at: "2026-10-08T09:00:00+00:00",
  published_by: "user_1",
};

/** A method as the platform serializes it: `python` is the catalog string. */
const WIRE_METHOD = {
  method_id: "mt_receipts01",
  org_id: "org_1",
  created_by_user_id: "user_1",
  name: "Receipt review",
  mthds: '[{"name":"main.mthds","content":"domain = \\"receipts\\""}]',
  python: '[{"name":"helper.py","content":"x = 1"}]',
  input_data: { total: 1 },
  pipe_output: null,
  description: "Review a receipt",
  created_at: "2026-10-01T09:00:00+00:00",
  updated_at: "2026-10-08T09:00:00.123456+00:00",
  deletion_state: null,
  draft_digest: DIGEST,
  latest_version: 3,
  latest_published: SUMMARY,
};

/** The same method as the SDK hands it back: `python` parsed into `MethodFile[]`. */
const METHOD: MethodData = {
  ...WIRE_METHOD,
  python: [{ name: "helper.py", content: "x = 1" }],
} as MethodData;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("writeDraft", () => {
  it("PUTs /v1/methods/{id}/draft with the draft and its token, and returns the method", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, WIRE_METHOD));

    const method = await client.writeDraft("mt_receipts01", {
      mthds: "src",
      input_data: { total: 1 },
      expected_updated_at: "2026-10-08T08:00:00.000001+00:00",
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${BASE_URL}/v1/methods/mt_receipts01/draft`);
    expect(req.body).toEqual({
      mthds: "src",
      input_data: { total: 1 },
      expected_updated_at: "2026-10-08T08:00:00.000001+00:00",
    });
    expect(method).toEqual(METHOD);
    expect(method.updated_at).toBe("2026-10-08T09:00:00.123456+00:00");
    expect(method.draft_digest).toBe(DIGEST);
  });

  it("omits what the caller omitted, and sends an explicit null that clears the form inputs", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, WIRE_METHOD)));

    await client.writeDraft("mt_receipts01", { mthds: "src" });
    expect(onlyRequest(spy).body).toEqual({ mthds: "src" });

    spy.mockClear();
    await client.writeDraft("mt_receipts01", { mthds: "src", input_data: null });
    expect(onlyRequest(spy).body).toEqual({ mthds: "src", input_data: null });
  });

  it("surfaces a stale token as a 409 method_update_conflict naming the field", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, {
        type: "https://pipelex.com/errors/method_update_conflict",
        title: "Conflict",
        status: 409,
        code: "method_update_conflict",
        detail: "The method was updated since 2026-10-08T08:00:00+00:00.",
        errors: [{ field: "expected_updated_at", code: "stale", detail: "moved" }],
      }),
    );

    const err = await client
      .writeDraft("mt_receipts01", { mthds: "src", expected_updated_at: "t0" })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refused = err as ApiResponseError;
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("method_update_conflict");
    expect(refused.errors?.[0]?.field).toBe("expected_updated_at");
    expect(errorVerdictOf(refused)).toEqual({ errorDomain: "input", retryable: false });
  });
});

describe("renameMethod", () => {
  it("PATCHes /v1/methods/{id} with the name alone", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ...WIRE_METHOD, name: "Renamed" }));

    const method = await client.renameMethod("mt_receipts01", { name: "Renamed" });

    const req = onlyRequest(spy);
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe(`${BASE_URL}/v1/methods/mt_receipts01`);
    expect(req.body).toEqual({ name: "Renamed" });
    expect(method.name).toBe("Renamed");
    // A rename moves no token: the platform answers the method's unchanged updated_at.
    expect(method.updated_at).toBe(WIRE_METHOD.updated_at);
  });

  it("sends only the name, whatever else an untyped caller passes", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, WIRE_METHOD));

    await client.renameMethod("mt_receipts01", {
      name: "Renamed",
      mthds: "src",
    } as unknown as { name: string });

    expect(onlyRequest(spy).body).toEqual({ name: "Renamed" });
  });
});

describe("publishMethod", () => {
  it("POSTs the token to /v1/methods/{id}/publish and hands back a published outcome", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { outcome: "published", version: SUMMARY, method: WIRE_METHOD }),
      );

    const result = await client.publishMethod("mt_receipts01", {
      expected_draft_updated_at: WIRE_METHOD.updated_at,
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/v1/methods/mt_receipts01/publish`);
    expect(req.body).toEqual({ expected_draft_updated_at: WIRE_METHOD.updated_at });
    expect(result).toEqual({ outcome: "published", version: SUMMARY, method: METHOD });
  });

  it("hands back an unchanged outcome with the existing latest version", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { outcome: "unchanged", version: SUMMARY, method: WIRE_METHOD }),
    );

    const result = await client.publishMethod("mt_receipts01", {
      expected_draft_updated_at: WIRE_METHOD.updated_at,
    });

    expect(result.outcome).toBe("unchanged");
    if (result.outcome !== "unchanged") throw new Error("narrowed above");
    expect(result.version.version).toBe(3);
    expect(result.method.python).toEqual([{ name: "helper.py", content: "x = 1" }]);
  });

  it.each([
    ["invalid", { is_valid: false, validation_errors: [], message: "bad" }],
    ["not_runnable", { is_valid: true, bundle_blueprint: {} }],
  ] as const)(
    "hands back a refused outcome, reason %s, with the runner's verdict verbatim",
    async (reason, validation) => {
      const client = makeClient();
      const message =
        reason === "not_runnable" ? "The draft is valid but does not run yet." : "Invalid.";
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(200, {
          outcome: "refused",
          reason,
          message,
          validation,
          method: { ...WIRE_METHOD, draft_digest: OTHER_DIGEST },
        }),
      );

      const result = await client.publishMethod("mt_receipts01", {
        expected_draft_updated_at: WIRE_METHOD.updated_at,
      });

      expect(result.outcome).toBe("refused");
      if (result.outcome !== "refused") throw new Error("narrowed above");
      expect(result.reason).toBe(reason);
      expect(result.message).toBe(message);
      expect(result.validation).toEqual(validation);
      expect(result.method.draft_digest).toBe(OTHER_DIGEST);
    },
  );

  it("narrows on outcome", () => {
    expectTypeOf<Extract<MethodPublishResult, { outcome: "refused" }>>().toHaveProperty("reason");
    expectTypeOf<Extract<MethodPublishResult, { outcome: "published" }>>().toHaveProperty(
      "version",
    );
    expectTypeOf<MethodPublishResult["outcome"]>().toEqualTypeOf<
      "published" | "unchanged" | "refused"
    >();
  });

  it.each([
    ["an outcome it does not know", { outcome: "queued", method: WIRE_METHOD }, "outcome"],
    ["no outcome", { version: SUMMARY, method: WIRE_METHOD }, "outcome"],
    ["no method", { outcome: "published", version: SUMMARY }, "method"],
  ])("throws a typed ApiResponseError for a publish result with %s", async (_, body, member) => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await client
      .publishMethod("mt_receipts01", { expected_draft_updated_at: "t0" })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toContain(
      `API POST /v1/methods/mt_receipts01/publish answered 200 with a publish result whose \`${member}\``,
    );
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: false });
  });

  it("refuses a call with no token before sending anything", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await client
      .publishMethod("mt_receipts01", {} as unknown as { expected_draft_updated_at: string })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain("expected_draft_updated_at");
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a stale token as a 409 method_update_conflict, publishing nothing", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, {
        code: "method_update_conflict",
        detail: "The draft moved.",
        errors: [{ field: "expected_draft_updated_at", code: "stale", detail: "moved" }],
      }),
    );

    const err = await client
      .publishMethod("mt_receipts01", { expected_draft_updated_at: "t0" })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("method_update_conflict");
    expect((err as ApiResponseError).errors?.[0]?.field).toBe("expected_draft_updated_at");
  });
});

describe("listMethodVersions", () => {
  it("GETs /v1/methods/{id}/versions and maps the page envelope", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [SUMMARY], next_cursor: "c2" }));

    const page = await client.listMethodVersions("mt_receipts01");

    expect(onlyRequest(spy).url).toBe(`${BASE_URL}/v1/methods/mt_receipts01/versions`);
    expect(page).toEqual({ items: [SUMMARY], nextCursor: "c2" });
  });

  it("forwards limit and cursor, an explicit empty cursor included", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [], next_cursor: null })),
      );

    await client.listMethodVersions("mt_receipts01", { limit: 5, cursor: "c1" });
    expect(onlyRequest(spy).url).toBe(
      `${BASE_URL}/v1/methods/mt_receipts01/versions?limit=5&cursor=c1`,
    );

    spy.mockClear();
    await client.listMethodVersions("mt_receipts01", { cursor: "" });
    expect(onlyRequest(spy).url).toBe(`${BASE_URL}/v1/methods/mt_receipts01/versions?cursor=`);
  });

  it("reads a never-published method's empty last page", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [], next_cursor: null }),
    );

    await expect(client.listMethodVersions("mt_receipts01")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("throws a typed ApiResponseError on a page it cannot walk", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: [SUMMARY] }));

    const err = await client.listMethodVersions("mt_receipts01").catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      "API GET /v1/methods/mt_receipts01/versions answered 200 with a page whose " +
        "`next_cursor` is neither a string nor null",
    );
  });
});

describe("getMethodVersion", () => {
  it("GETs /v1/methods/{id}/versions/{n} and parses the version's python", async () => {
    const client = makeClient();
    const wire = {
      ...SUMMARY,
      method_id: "mt_receipts01",
      mthds: "domain = 'receipts'",
      python: '[{"name":"helper.py","content":"x = 1"}]',
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, wire));

    const version = await client.getMethodVersion("mt_receipts01", 3);

    expect(onlyRequest(spy).url).toBe(`${BASE_URL}/v1/methods/mt_receipts01/versions/3`);
    expect(version).toEqual({ ...wire, python: [{ name: "helper.py", content: "x = 1" }] });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses the version %s before sending anything",
    async (version) => {
      const client = makeClient();
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await client
        .getMethodVersion("mt_receipts01", version)
        .catch((thrown: unknown) => thrown);

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("surfaces an unknown version as a 404 method_version_not_found", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { code: "method_version_not_found", detail: "No version 9." }),
    );

    const err = await client
      .getMethodVersion("mt_receipts01", 9)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("method_version_not_found");
    // A named 404 is the caller's: no retry turns version 9 into one that exists.
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
  });

  it("throws a typed ApiResponseError for a version whose python it cannot read", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...SUMMARY, method_id: "m1", mthds: "src", python: '[{"name": 1}]' }),
    );

    const err = await client.getMethodVersion("m1", 3).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      "API GET /v1/methods/m1/versions/3 answered 200 with a published version whose " +
        "`python` field could not be read",
    );
  });
});

describe("the method routes take a bare id", () => {
  const SELECTOR = "mt_receipts01@3";
  const calls: [string, (client: PipelexApiClient) => Promise<unknown>][] = [
    ["getMethod", (client) => client.getMethod(SELECTOR)],
    ["getMethodClosure", (client) => client.getMethodClosure(SELECTOR)],
    ["writeDraft", (client) => client.writeDraft(SELECTOR, { mthds: "src" })],
    ["renameMethod", (client) => client.renameMethod(SELECTOR, { name: "Receipts" })],
    [
      "publishMethod",
      (client) => client.publishMethod(SELECTOR, { expected_draft_updated_at: "t" }),
    ],
    ["listMethodVersions", (client) => client.listMethodVersions(SELECTOR)],
    ["getMethodVersion", (client) => client.getMethodVersion(SELECTOR, 3)],
    ["deleteMethod", (client) => client.deleteMethod(SELECTOR)],
  ];

  it.each(calls)(
    "%s refuses a suffixed id before sending anything, saying how to read what it names",
    async (_name, call) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await call(makeClient()).catch((thrown: unknown) => thrown);

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as RequestArgumentError).message).toBe(
        '"mt_receipts01@3" carries a version suffix, and the method routes take a bare catalog ' +
          "id: they address the method itself, never one of its versions. Strip the suffix " +
          "with parseMethodSelector, and read a published version with getMethodVersion.",
      );
      expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
      expect(spy).not.toHaveBeenCalled();
    },
  );
});

describe("the run routes' linkage form takes a bare id", () => {
  const INLINE_SOURCES: [string, Record<string, unknown>][] = [
    ["mthds_contents", { mthds_contents: ['domain = "receipts"'] }],
    ["files", { files: { "main.mthds": 'domain = "receipts"' } }],
    ["bundle_b64", { bundle_b64: "UEsDBA==" }],
  ];
  const ROUTES: [string, (client: PipelexApiClient, options: object) => Promise<unknown>][] = [
    ["start", (client, options) => client.start(options)],
    ["execute", (client, options) => client.execute(options)],
  ];
  const cases = ROUTES.flatMap(([route, call]) =>
    INLINE_SOURCES.flatMap(([source, inline]) =>
      ["mt_receipts01@3", "mt_receipts01@draft"].map(
        (selector) => [route, source, selector, call, inline] as const,
      ),
    ),
  );

  it.each(cases)(
    "%s refuses %s beside %s before sending anything",
    async (_route, _source, selector, call, inline) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await call(makeClient(), { ...inline, method_id: selector }).catch(
        (thrown: unknown) => thrown,
      );

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as RequestArgumentError).message).toBe(
        `method_id "${selector}" beside an inline source is run-history linkage and must be a ` +
          "bare catalog id: the inline source is what runs, so a version suffix would claim a " +
          "version that did not. Send the bare id (parseMethodSelector(...).method_id), or drop " +
          "the inline source to run the version the selector names.",
      );
      expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("sends a suffixed id beside empty mthds_contents, which carry no source to link", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "run-9", state: "STARTED", created_at: "t0" }),
      );

    await client.start({ method_id: "mt_receipts01@draft", mthds_contents: [] });

    expect((onlyRequest(spy).body as { method_id?: string }).method_id).toBe("mt_receipts01@draft");
  });

  it("sends a bare id beside an inline source, the linkage the history is filed under", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(202, { pipeline_run_id: "run-9", state: "STARTED", created_at: "t0" }),
      );

    await client.start({ method_id: "mt_receipts01", bundle_b64: "UEsDBA==" });

    expect(onlyRequest(spy).body).toEqual({ method_id: "mt_receipts01", bundle_b64: "UEsDBA==" });
  });
});

describe("the removed whole-method write", () => {
  it("is gone from the client: the draft write and the rename replace it", () => {
    const client = makeClient();
    expect("updateMethod" in client).toBe(false);
    expectTypeOf<PipelexApiClient>().not.toHaveProperty("updateMethod");
  });
});

describe("the method resource", () => {
  it("types deletion_state on MethodData, optional, as MethodSummary types it", () => {
    expectTypeOf<MethodData["deletion_state"]>().toEqualTypeOf<
      MethodDeletionState | null | undefined
    >();
    expectTypeOf<MethodData["deletion_state"]>().toEqualTypeOf<MethodSummary["deletion_state"]>();
  });

  it("hands back the deletion_state a method read carries", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...WIRE_METHOD, deletion_state: "pending" }),
    );

    const method = await client.getMethod("mt_receipts01");

    expect(method.deletion_state).toBe("pending");
  });
});

describe("the method error codes", () => {
  it("names the codes a method caller branches on", () => {
    expectTypeOf<MethodErrorCode>().toEqualTypeOf<
      | "method_update_conflict"
      | "method_being_deleted"
      | "method_not_published"
      | "method_version_not_found"
    >();
  });

  it("surfaces a never-published bare id's 409 method_not_published, not retryable", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, {
        code: "method_not_published",
        detail:
          "mt_receipts01 has no published version; run mt_receipts01@draft or publish it first.",
      }),
    );

    const err = await client
      .validate({ method_id: "mt_receipts01" })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refused = err as ApiResponseError;
    expect(refused.code satisfies string | undefined).toBe("method_not_published");
    expect(refused.serverMessage).toContain("@draft");
    expect(errorVerdictOf(refused)).toEqual({ errorDomain: "input", retryable: false });
  });
});

describe("which version a run ran", () => {
  it("types method_version and source_digest on every run record, optional", () => {
    expectTypeOf<RunPublic["method_version"]>().toEqualTypeOf<
      number | "draft" | null | undefined
    >();
    expectTypeOf<RunPublic["source_digest"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<PipelineRun["method_version"]>().toEqualTypeOf<
      number | "draft" | null | undefined
    >();
    expectTypeOf<RunHistoryItem["method_version"]>().toEqualTypeOf<
      number | "draft" | null | undefined
    >();
    expectTypeOf<RunHistoryItem["source_digest"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<PipelexRunResultStart["method_version"]>().toEqualTypeOf<
      number | "draft" | null | undefined
    >();
  });

  it("passes a selector through to start untouched, and hands back the ack's method_version", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(202, {
        pipeline_run_id: "run-9",
        state: "STARTED",
        created_at: "t0",
        method_version: 3,
      }),
    );

    const ack = await client.start({ method_id: "mt_receipts01@3" });

    const req = onlyRequest(spy);
    expect(req.url).toBe(`${BASE_URL}/v1/start`);
    expect((req.body as { method_id?: string }).method_id).toBe("mt_receipts01@3");
    expect(ack.method_version).toBe(3);
  });

  it("hands the recorded version and digest back on the run detail and the history", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, {
          pipeline_run_id: "run-1",
          method_id: "mt_receipts01",
          pipe_code: null,
          status: "COMPLETED",
          created_at: "t0",
          method_version: "draft",
          source_digest: DIGEST,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          items: [
            {
              pipeline_run_id: "run-2",
              status: "COMPLETED",
              created_at: "t1",
              method_version: 3,
              source_digest: DIGEST,
            },
            { pipeline_run_id: "run-3", status: "FAILED", created_at: "t2" },
          ],
          next_cursor: null,
        }),
      );

    const detail = await client.getRunDetail("run-1");
    const page = await client.listRuns("mt_receipts01");

    expect(detail.method_version).toBe("draft");
    expect(detail.source_digest).toBe(DIGEST);
    expect(page.items[0]?.method_version).toBe(3);
    // A row a platform recorded before versions existed carries neither, and still reads.
    expect(page.items[1]?.method_version).toBeUndefined();
    expect(page.items[1]?.source_digest).toBeUndefined();
  });
});
