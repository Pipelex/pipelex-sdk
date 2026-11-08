/**
 * A method's stored layouts: the write that stores a layout beside a published version
 * (`storeMethodLayout`, `POST /v1/methods/{id}/versions/{n}/layouts`), its closed body, its
 * refusals and its answer, and the `layouts` a validate by `method_id` carries when `views` names
 * `layouts` — all against a mocked fetch. The type-level assertions bite in
 * `npm run typecheck:test`, which `make check` runs.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import type {
  LayoutProvenance,
  MethodLayout,
  MethodLayoutInput,
  PipelexValidationReport,
  ValidateOptions,
  ValidateView,
} from "../src/index.js";
import { problemResponse } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const METHOD_ID = "mt_receipts01";
const LAYOUTS_URL = `${BASE_URL}/v1/methods/${METHOD_ID}/versions/3/layouts`;
const LAYOUTS_PATH = `/v1/methods/${METHOD_ID}/versions/3/layouts`;
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
      (methodId: string, version: number, layout: MethodLayoutInput) => Promise<MethodLayout>
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
    ["a layout that is a list", [LAYOUT_INPUT], "layout", "object"],
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
