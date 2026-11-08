/**
 * A method's stored layouts: the write that stores a layout beside a published version
 * (`storeMethodLayout`, `POST /v1/methods/{id}/versions/{n}/layouts`), its closed body, its
 * refusals and its answer, the direct read of a version's layouts (`listMethodLayouts`), the switch
 * that turns a method's pages off (`setMethodLayoutsOff`), and the `layouts` a validate by
 * `method_id` carries when `views` names `layouts` — all against a mocked fetch. The type-level assertions bite in
 * `npm run typecheck:test`, which `make check` runs.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import type {
  LayoutProvenance,
  MethodData,
  MethodLayout,
  MethodLayoutInput,
  MethodLayoutList,
  MethodLayoutListOptions,
  MethodLayoutsOffOptions,
  MethodLayoutWriteOptions,
  PipelexValidationReport,
  ValidateOptions,
  ValidateView,
} from "../src/index.js";
import { problemResponse } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const METHOD_ID = "mt_receipts01";
const LAYOUTS_URL = `${BASE_URL}/v1/methods/${METHOD_ID}/versions/3/layouts`;
const LAYOUTS_PATH = `/v1/methods/${METHOD_ID}/versions/3/layouts`;
const LAYOUTS_OFF_URL = `${BASE_URL}/v1/methods/${METHOD_ID}/layouts-off`;
const DIGEST = "sha256:5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47";

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

async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => {
      throw new Error("expected the call to fail");
    },
    (thrown: unknown) => thrown,
  );
}

/** The layout a producer writes: two JSON patch lines over the composer catalog. */
const JSONL =
  '{"op":"add","path":"/root","value":"page"}\n' +
  '{"op":"add","path":"/elements/page","value":{"type":"Stack","children":[]}}';

const LAYOUT_INPUT: MethodLayoutInput = {
  tree_digest: DIGEST,
  pipe_ref: "receipts.review_receipt",
  catalog: "composer",
  prompt_hash: "a1b2c3d4e5f6",
  jsonl: JSONL,
  provenance: {
    producer: "pipelex-method",
    model: "claude-4.8-opus",
    seed: "a quiet ledger",
    style: "editorial",
    repair_rounds: 1,
  },
};

/** The layout as the platform answers the write and carries it on a validate. */
const STORED: MethodLayout = {
  pipe_ref: "receipts.review_receipt",
  catalog: "composer",
  prompt_hash: "a1b2c3d4e5f6",
  tree_digest: DIGEST,
  jsonl: JSONL,
  provenance: {
    producer: "pipelex-method",
    model: "claude-4.8-opus",
    seed: "a quiet ledger",
    style: "editorial",
    repair_rounds: 1,
  },
  stored_at: "2026-11-08T09:00:00.123456+00:00",
  sample_json: null,
};

/** A written sample of the result, as one JSON text. */
const SAMPLE_JSON = '{"merchant":"Corner Bakery","total":12.5}';

/** The method as the platform answers the switch: its own fields and the list as held. */
const SWITCHED_METHOD = {
  method_id: METHOD_ID,
  org_id: "org_team",
  created_by_user_id: "user_1",
  name: "Receipts",
  created_at: "2026-11-01T09:00:00+00:00",
  updated_at: "2026-11-02T09:00:00+00:00",
  draft_digest: DIGEST,
  latest_version: 3,
  latest_published: null,
  layouts_off: ["composer"],
};

/** An older layout of the same content, written under another prompt and no style. */
const OLDER: MethodLayout = {
  ...STORED,
  prompt_hash: "0f0e0d0c0b0a",
  provenance: { ...STORED.provenance, seed: null, style: null, repair_rounds: 0 },
  stored_at: "2026-11-07T09:00:00+00:00",
};

/** A valid verdict of a validate by `method_id`, before the platform adds any layout. */
const VALID_VERDICT = {
  is_valid: true,
  bundle_blueprint: { domain: "receipts" },
  pipe_io_contracts: {},
  input_form: {},
  liftable_pipes: [],
  graph_spec: null,
  validated_pipes: [{ pipe_ref: "receipts.review_receipt", status: "SUCCESS" }],
  warnings: [],
  pending_signatures: [],
  is_runnable: true,
  message: "MTHDS content validated successfully",
  rendered_markdown: "# Valid",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the layout types", () => {
  it("types the write, the stored layout and the views tokens", () => {
    expectTypeOf<PipelexApiClient["storeMethodLayout"]>().toEqualTypeOf<
      (
        methodId: string,
        version: number,
        layout: MethodLayoutInput,
        options?: MethodLayoutWriteOptions,
      ) => Promise<MethodLayout>
    >();
    expectTypeOf<MethodLayout["provenance"]>().toEqualTypeOf<LayoutProvenance>();
    expectTypeOf<LayoutProvenance["seed"]>().toEqualTypeOf<string | null>();
    expectTypeOf<LayoutProvenance["style"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PipelexValidationReport["layouts"]>().toEqualTypeOf<MethodLayout[] | undefined>();
    expectTypeOf<ValidateView>().toEqualTypeOf<"input_form" | "output_form" | "layouts">();
    // Read open: a token this SDK knows completes, and one it does not still assigns.
    const options: ValidateOptions = { views: ["input_form", "layouts", "a_later_view"] };
    expect(options.views).toHaveLength(3);
    // A layout read back is a valid write: its `stored_at` is left out when it is sent.
    const resent: MethodLayoutInput = STORED;
    expect(resent.catalog).toBe("composer");
  });
});

describe("storeMethodLayout", () => {
  it("POSTs the layout to the version's layouts and answers it as stored", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, STORED));

    const stored = await makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT);

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(LAYOUTS_URL);
    expect(req.body).toEqual(LAYOUT_INPUT);
    expect(stored).toEqual(STORED);
    expect(stored.stored_at).toBe("2026-11-08T09:00:00.123456+00:00");
  });

  it("leaves out each optional provenance member that is null or omitted", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, OLDER)));
    const required = { producer: "pipelex-method", model: "claude-4.8-opus" };

    await makeClient().storeMethodLayout(METHOD_ID, 3, { ...LAYOUT_INPUT, provenance: required });
    expect((onlyRequest(spy).body as MethodLayoutInput).provenance).toEqual(required);

    spy.mockClear();
    await makeClient().storeMethodLayout(METHOD_ID, 3, {
      ...LAYOUT_INPUT,
      provenance: { ...required, seed: null, style: null, repair_rounds: null },
    });
    expect((onlyRequest(spy).body as MethodLayoutInput).provenance).toEqual(required);
  });

  it("sends a repair count of zero, which is a count and not an omission", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, OLDER));

    await makeClient().storeMethodLayout(METHOD_ID, 3, {
      ...LAYOUT_INPUT,
      provenance: { producer: "pipelex-method", model: "claude-4.8-opus", repair_rounds: 0 },
    });

    expect((onlyRequest(spy).body as MethodLayoutInput).provenance).toEqual({
      producer: "pipelex-method",
      model: "claude-4.8-opus",
      repair_rounds: 0,
    });
  });

  it("sends the closed body alone: a layout read back goes without its stored_at", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, STORED));
    const readBack = {
      ...STORED,
      note: "not a member",
      provenance: { ...STORED.provenance, extra: true },
    };

    await makeClient().storeMethodLayout(METHOD_ID, 3, readBack);

    expect(onlyRequest(spy).body).toEqual(LAYOUT_INPUT);
  });

  it("sends a member of another type as given, for the platform to refuse naming it", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("request.invalid", 422, {
        detail: "prompt_hash: String should match pattern '^[0-9a-f]{12,64}$'",
        params: { field: "prompt_hash" },
        location: { field: "prompt_hash" },
      }),
    );

    const err = await failureOf(() =>
      makeClient().storeMethodLayout(METHOD_ID, 3, {
        ...LAYOUT_INPUT,
        prompt_hash: 12 as unknown as string,
      }),
    );

    expect((onlyRequest(spy).body as Record<string, unknown>).prompt_hash).toBe(12);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("request.invalid");
    expect((err as ApiResponseError).problem.params).toEqual({ field: "prompt_hash" });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses the version %s before sending anything",
    async (version) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await failureOf(() =>
        makeClient().storeMethodLayout(METHOD_ID, version, LAYOUT_INPUT),
      );

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as ProblemError).problem.params).toEqual({
        argument: "version",
        reason: "not_a_positive_integer",
      });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("refuses a version given as a string in the wording every argument refusal has", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().storeMethodLayout(METHOD_ID, "3" as unknown as number, LAYOUT_INPUT),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "storeMethodLayout() takes a version number, the published version the layout was " +
        "designed for, a positive integer; got string.",
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["no layout", undefined, "layout", "undefined"],
    ["a null layout", null, "layout", "null"],
    ["a layout that is a list", [LAYOUT_INPUT], "layout", "an array"],
    [
      "a layout with no provenance",
      { ...LAYOUT_INPUT, provenance: undefined },
      "provenance",
      "undefined",
    ],
    [
      "a provenance that is a string",
      { ...LAYOUT_INPUT, provenance: "pipelex-method" },
      "provenance",
      "string",
    ],
  ])("refuses %s before sending anything", async (_label, layout, argument, got) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().storeMethodLayout(METHOD_ID, 3, layout as unknown as MethodLayoutInput),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as ProblemError).problem.params).toEqual({ argument, reason: "not_an_object" });
    expect((err as Error).message).toMatch(
      new RegExp(`^storeMethodLayout\\(\\) takes .*; got ${got}\\.$`),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().storeMethodLayout(`${METHOD_ID}@3`, 3, LAYOUT_INPUT),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain(`"${METHOD_ID}@3" carries a version suffix`);
    expect((err as ProblemError).problem.params).toEqual({
      argument: "method_id",
      reason: "version_suffix",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a tree that is not the version's",
      422,
      "request.invalid",
      { params: { field: "tree_digest" }, location: { field: "tree_digest" } },
      { field: "tree_digest" },
    ],
    [
      "a provenance member off its shape",
      422,
      "request.invalid",
      { params: { field: "provenance.style" }, location: { field: "provenance.style" } },
      { field: "provenance.style" },
    ],
    [
      "a runner",
      403,
      "auth.forbidden",
      { params: { requirement: "member" } },
      { requirement: "member" },
    ],
    [
      "an unknown method",
      404,
      "pipelex.catalog.not_found",
      { params: { resource: "method", method_id: METHOD_ID, version: null } },
      { resource: "method", method_id: METHOD_ID, version: null },
    ],
    [
      "a version never published",
      404,
      "pipelex.catalog.not_found",
      { params: { resource: "version", method_id: METHOD_ID, version: 3 } },
      { resource: "version", method_id: METHOD_ID, version: 3 },
    ],
    ["a method being erased", 409, "pipelex.catalog.being_deleted", {}, undefined],
  ])("surfaces %s as a %s %s", async (_label, status, code, members, params) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(code, status, members));

    const err = await failureOf(() => makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(status);
    expect((err as ApiResponseError).code).toBe(code);
    expect((err as ApiResponseError).problem.params).toEqual(params);
  });

  it.each([
    ["an answer that is not an object", ["layout"], "a body that is not an object"],
    [
      "a layout with no stored_at",
      { ...STORED, stored_at: undefined },
      "a layout whose `stored_at` is not a string",
    ],
    [
      "a layout whose jsonl is parsed",
      { ...STORED, jsonl: [] },
      "a layout whose `jsonl` is not a string",
    ],
    [
      "a layout with no provenance",
      { ...STORED, provenance: null },
      "a layout whose `provenance` is not an object",
    ],
    [
      "a provenance with no model",
      { ...STORED, provenance: { ...STORED.provenance, model: 4 } },
      "a layout whose `provenance.model` is not a string",
    ],
  ])("throws a typed ApiResponseError for %s", async (_label, body, words) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await failureOf(() => makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API POST ${LAYOUTS_PATH} answered 200 with ${words}`,
    );
    expect((err as ProblemError).problem).toMatchObject({
      code: "client.response_unreadable",
      domain: "runtime",
      retry: "no",
    });
  });

  it("reads a provenance's optional members as the platform's defaults when they do not fit", async () => {
    const { seed: _seed, ...withoutSeed } = STORED.provenance;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        ...STORED,
        provenance: { ...withoutSeed, style: 7, repair_rounds: "2" },
      }),
    );

    const stored = await makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT);

    expect(stored.provenance).toEqual({
      producer: "pipelex-method",
      model: "claude-4.8-opus",
      seed: null,
      style: null,
      repair_rounds: 0,
    });
  });

  it.each([-1, 1.5, true])("reads a repair count of %s as zero", async (rounds) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...STORED, provenance: { ...STORED.provenance, repair_rounds: rounds } }),
    );

    const stored = await makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT);

    expect(stored.provenance.repair_rounds).toBe(0);
  });
});

describe("storeMethodLayout — the written sample", () => {
  it("sends sample_json when given and answers it as stored", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ...STORED, sample_json: SAMPLE_JSON }));

    const stored = await makeClient().storeMethodLayout(METHOD_ID, 3, {
      ...LAYOUT_INPUT,
      sample_json: SAMPLE_JSON,
    });

    expect(onlyRequest(spy).body).toEqual({ ...LAYOUT_INPUT, sample_json: SAMPLE_JSON });
    expect(stored.sample_json).toBe(SAMPLE_JSON);
  });

  it.each([
    ["omitted", {}],
    ["null", { sample_json: null }],
  ])("leaves out a sample that is %s", async (_name, sample) => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, STORED));

    await makeClient().storeMethodLayout(METHOD_ID, 3, { ...LAYOUT_INPUT, ...sample });

    expect(onlyRequest(spy).body).not.toHaveProperty("sample_json");
  });

  it("sends the sample of a layout read back", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ...STORED, sample_json: SAMPLE_JSON }));

    await makeClient().storeMethodLayout(METHOD_ID, 3, { ...STORED, sample_json: SAMPLE_JSON });

    expect(onlyRequest(spy).body).toEqual({ ...LAYOUT_INPUT, sample_json: SAMPLE_JSON });
  });

  it.each([
    ["absent, as a platform that predates it answers", undefined],
    ["null", null],
    ["of another type", { total: 12.5 }],
  ])("reads a sample that is %s as null", async (_name, sample) => {
    const { sample_json: _dropped, ...answer } = STORED;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, sample === undefined ? answer : { ...answer, sample_json: sample }),
    );

    const stored = await makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT);

    expect(stored.sample_json).toBeNull();
  });
});

describe("listMethodLayouts", () => {
  it("GETs the version's layouts and reads them newest first", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { items: [{ ...STORED, sample_json: SAMPLE_JSON }, OLDER] }),
      );

    const list = await makeClient().listMethodLayouts(METHOD_ID, 3);

    const { url, method } = onlyRequest(spy);
    expect(url).toBe(LAYOUTS_URL);
    expect(method).toBe("GET");
    expect(list.items).toEqual([{ ...STORED, sample_json: SAMPLE_JSON }, OLDER]);
  });

  it("answers an empty list when none is stored", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: [] }));

    await expect(makeClient().listMethodLayouts(METHOD_ID, 3)).resolves.toEqual({ items: [] });
  });

  it("leaves out an entry that does not read as a layout, keeping the others in order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [STORED, { ...OLDER, jsonl: 4 }, "no layout", OLDER] }),
    );

    const list = await makeClient().listMethodLayouts(METHOD_ID, 3);

    expect(list.items).toEqual([STORED, OLDER]);
  });

  it("reads each entry's optional members as the platform's defaults", async () => {
    const { sample_json: _dropped, ...withoutSample } = STORED;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        items: [
          {
            ...withoutSample,
            provenance: {
              producer: "pipelex-method",
              model: "claude-4.8-opus",
              repair_rounds: "x",
            },
          },
        ],
      }),
    );

    const list = await makeClient().listMethodLayouts(METHOD_ID, 3);

    expect(list.items[0]?.sample_json).toBeNull();
    expect(list.items[0]?.provenance).toEqual({
      producer: "pipelex-method",
      model: "claude-4.8-opus",
      seed: null,
      style: null,
      repair_rounds: 0,
    });
  });

  it.each([
    ["no items", {}],
    ["items that are not an array", { items: { first: STORED } }],
  ])("refuses an answer with %s as one it cannot read", async (_name, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await failureOf(() => makeClient().listMethodLayouts(METHOD_ID, 3));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
    expect((err as Error).message).toContain("`items` is not an array");
  });

  it.each([0, -1, 1.5, Number.NaN, "3", null])(
    "refuses the version %s before sending anything",
    async (version) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await failureOf(() =>
        makeClient().listMethodLayouts(METHOD_ID, version as number),
      );

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as Error).message).toContain(
        "listMethodLayouts() takes a version number, the published version whose layouts to read",
      );
      expect((err as ProblemError).problem.params).toEqual({
        argument: "version",
        reason: "not_a_positive_integer",
      });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() => makeClient().listMethodLayouts(`${METHOD_ID}@3`, 3));

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["a method never published or unknown", 404, "pipelex.catalog.not_found"],
    ["a method being erased", 409, "pipelex.catalog.being_deleted"],
    ["a version that predates trees", 500, "runtime.unexpected"],
  ])("throws the platform's refusal of %s", async (_name, status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(code, status));

    const err = await failureOf(() => makeClient().listMethodLayouts(METHOD_ID, 3));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(status);
    expect((err as ApiResponseError).problem.code).toBe(code);
  });

  it("passes the caller's signal to the request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      });
    });
    const controller = new AbortController();
    const reason = new Error("the page moved on");

    const pending = failureOf(() =>
      makeClient().listMethodLayouts(METHOD_ID, 3, { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
  });

  it("types its answer and its option", () => {
    expectTypeOf<ReturnType<PipelexApiClient["listMethodLayouts"]>>().toEqualTypeOf<
      Promise<MethodLayoutList>
    >();
    expectTypeOf<MethodLayoutListOptions["signal"]>().toEqualTypeOf<AbortSignal | undefined>();
  });
});

describe("setMethodLayoutsOff", () => {
  it("PUTs the whole list, closed, and answers the method", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, SWITCHED_METHOD));

    const method = await makeClient().setMethodLayoutsOff(METHOD_ID, ["composer"]);

    const { url, method: verb, body } = onlyRequest(spy);
    expect(url).toBe(LAYOUTS_OFF_URL);
    expect(verb).toBe("PUT");
    expect(body).toEqual({ catalogs: ["composer"] });
    expect(method.layouts_off).toEqual(["composer"]);
  });

  it("sends an empty list, which switches every design on", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ...SWITCHED_METHOD, layouts_off: [] }));

    const method = await makeClient().setMethodLayoutsOff(METHOD_ID, []);

    expect(onlyRequest(spy).body).toEqual({ catalogs: [] });
    expect(method.layouts_off).toEqual([]);
  });

  it("sends entries as given, for the platform to refuse naming them", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, SWITCHED_METHOD));

    await makeClient().setMethodLayoutsOff(METHOD_ID, ["composer", "composer", "Not A Slug"]);

    expect(onlyRequest(spy).body).toEqual({ catalogs: ["composer", "composer", "Not A Slug"] });
  });

  it.each([
    ["a string", "composer", "string"],
    ["null", null, "null"],
    ["an object", { catalogs: ["composer"] }, "object"],
  ])("refuses %s before sending anything", async (_name, catalogs, got) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().setMethodLayoutsOff(METHOD_ID, catalogs as unknown as string[]),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "setMethodLayoutsOff() takes the ids of the catalogs to switch off as an array, the whole list, " +
        `empty for none; got ${got}.`,
    );
    expect((err as ProblemError).problem.params).toEqual({
      argument: "catalogs",
      reason: "not_a_list",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() => makeClient().setMethodLayoutsOff(`${METHOD_ID}@3`, []));

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends the key as the Idempotency-Key header, never in the body", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, SWITCHED_METHOD));

    await makeClient().setMethodLayoutsOff(METHOD_ID, ["composer"], { idempotencyKey: "off-1" });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("off-1");
    expect(onlyRequest(spy).body).toEqual({ catalogs: ["composer"] });
  });

  it.each([
    ["absent", {}],
    ["null", { idempotencyKey: null }],
  ])("sends no header when the key is %s", async (_name, options) => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, SWITCHED_METHOD));

    await makeClient().setMethodLayoutsOff(METHOD_ID, ["composer"], options);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
  });

  it("refuses a malformed key before any request, naming what it does", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().setMethodLayoutsOff(METHOD_ID, [], { idempotencyKey: "" }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain("Leave it out to set the layouts off without one.");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["a runner", 403, "auth.forbidden"],
    ["an unknown method", 404, "pipelex.catalog.not_found"],
    ["a method being erased", 409, "pipelex.catalog.being_deleted"],
    ["a list that would not fit", 413, "request.too_large"],
    ["a catalog named twice", 422, "request.invalid"],
  ])("throws the platform's refusal of %s", async (_name, status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(code, status));

    const err = await failureOf(() => makeClient().setMethodLayoutsOff(METHOD_ID, ["composer"]));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(status);
    expect((err as ApiResponseError).problem.code).toBe(code);
  });

  it("refuses an answer that is not an object as one it cannot read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, ["composer"]));

    const err = await failureOf(() => makeClient().setMethodLayoutsOff(METHOD_ID, []));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
  });

  it("types the method's field and the option", () => {
    expectTypeOf<MethodData["layouts_off"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<MethodLayoutsOffOptions["idempotencyKey"]>().toEqualTypeOf<
      string | null | undefined
    >();
  });
});

describe("storeMethodLayout — the idempotency key", () => {
  const KEY = "layout-write-7f3a";

  /** The headers of the fetch call the spy recorded at `index`. */
  function headersOf(spy: ReturnType<typeof vi.spyOn>, index = 0): Record<string, string> {
    return (spy.mock.calls[index]![1] as RequestInit).headers as Record<string, string>;
  }

  it("sends the key as the Idempotency-Key header, never in the body", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, STORED));

    await makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT, { idempotencyKey: KEY });

    expect(headersOf(spy)["Idempotency-Key"]).toBe(KEY);
    expect(onlyRequest(spy).body).not.toHaveProperty("idempotency_key");
  });

  it.each([
    ["absent", undefined],
    ["empty options", {}],
    ["null", { idempotencyKey: null }],
  ])("sends no Idempotency-Key header when the key is %s", async (_, options) => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, STORED));

    await makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT, options);

    const names = Object.keys(headersOf(spy)).map((name) => name.toLowerCase());
    expect(names).not.toContain("idempotency-key");
  });

  it("sends the same key and the same body on a caller's retry after a lost answer", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        problemResponse("runtime.unavailable", 503, { domain: "runtime", retry: "yes" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, STORED));
    const client = makeClient();

    await failureOf(() =>
      client.storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT, { idempotencyKey: KEY }),
    );
    await client.storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT, { idempotencyKey: KEY });

    expect(headersOf(spy, 0)["Idempotency-Key"]).toBe(KEY);
    expect(headersOf(spy, 1)["Idempotency-Key"]).toBe(KEY);
    const [first, retry] = spy.mock.calls.map((call) => (call[1] as RequestInit).body);
    expect(retry).toBe(first);
  });

  it.each([
    ["is empty", "", "this one is empty"],
    ["holds a space", "layout 42", "this one holds a character outside visible ASCII"],
    ["is longer than 255 characters", "k".repeat(256), "this one is 256 characters long"],
    ["is not a string", 42 as unknown as string, "this one is not a string"],
  ])("refuses a key that %s before anything is sent", async (_, idempotencyKey, fault) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().storeMethodLayout(METHOD_ID, 3, LAYOUT_INPUT, { idempotencyKey }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    const message = (err as Error).message;
    expect(message).toContain(fault);
    expect(message).toContain("Leave it out to store the layout without one.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("types the option as an optional string or null", () => {
    expectTypeOf<MethodLayoutWriteOptions["idempotencyKey"]>().toEqualTypeOf<
      string | null | undefined
    >();
  });
});

describe("validate — the layouts view", () => {
  async function validateAnswering(
    body: unknown,
    options: ValidateOptions = { views: ["input_form", "layouts"] },
  ): Promise<{ report: PipelexValidationReport; sent: Record<string, unknown> }> {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));
    const verdict = await makeClient().validate({ method_id: `${METHOD_ID}@3` }, false, options);
    if (verdict.is_valid === false) throw new Error("expected a valid verdict");
    return { report: verdict, sent: onlyRequest(spy).body as Record<string, unknown> };
  }

  it("asks for the layouts beside the descriptor and reads them newest first", async () => {
    const { report, sent } = await validateAnswering({
      ...VALID_VERDICT,
      layouts: [STORED, OLDER],
    });

    expect(sent.method_id).toBe(`${METHOD_ID}@3`);
    expect(sent.views).toEqual(["input_form", "layouts"]);
    expect(report.input_form).toEqual({});
    expect(report.layouts).toEqual([STORED, OLDER]);
    expect(report.layouts?.[0]?.provenance.style).toBe("editorial");
  });

  it("leaves out an entry that does not read as a layout, keeping the others in order", async () => {
    const { report } = await validateAnswering({
      ...VALID_VERDICT,
      layouts: [STORED, "a layout", { ...STORED, jsonl: null }, OLDER],
    });

    expect(report.layouts).toEqual([STORED, OLDER]);
  });

  it("reads each entry's optional provenance members as the platform's defaults", async () => {
    const { report } = await validateAnswering({
      ...VALID_VERDICT,
      layouts: [
        { ...STORED, provenance: { producer: "pipelex-method", model: "claude-4.8-opus" } },
      ],
    });

    expect(report.layouts?.[0]?.provenance).toEqual({
      producer: "pipelex-method",
      model: "claude-4.8-opus",
      seed: null,
      style: null,
      repair_rounds: 0,
    });
  });

  it.each([
    ["no layouts member", VALID_VERDICT],
    ["an empty list", { ...VALID_VERDICT, layouts: [] }],
    ["a list holding no layout", { ...VALID_VERDICT, layouts: [null, 3] }],
    ["a member that is not a list", { ...VALID_VERDICT, layouts: { 0: STORED } }],
    ["a null member", { ...VALID_VERDICT, layouts: null }],
  ])("reads %s as no layout, the member absent", async (_label, body) => {
    const { report } = await validateAnswering(body);

    expect(report.layouts).toBeUndefined();
    expect("layouts" in report).toBe(false);
    // The rest of the verdict is the runner's, as it came.
    expect(report.is_runnable).toBe(true);
    expect(report.rendered_markdown).toBe("# Valid");
  });

  it("sends views only when asked, so a validate without the token carries no layouts", async () => {
    const { report, sent } = await validateAnswering(VALID_VERDICT, {});

    expect("views" in sent).toBe(false);
    expect(report.layouts).toBeUndefined();
  });

  it("leaves an invalid verdict as the runner answered it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        errors: [{ code: "method.signature_mismatch", detail: "Pipe 'review' has no output." }],
        pending_signatures: [],
        is_runnable: false,
        message: "Invalid",
      }),
    );

    const verdict = await makeClient().validate({ method_id: METHOD_ID }, false, {
      views: ["layouts"],
    });

    expect(verdict.is_valid).toBe(false);
    expect("layouts" in verdict).toBe(false);
  });
});
