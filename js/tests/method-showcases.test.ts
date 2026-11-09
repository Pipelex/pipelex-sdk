/**
 * A method's showcases: the freeze and its verdict (`freezeMethodShowcase`), the withdrawal
 * (`withdrawMethodShowcase`), the holder's reads (`listMethodShowcases`, `getMethodShowcase`), every
 * reader's reads of a published version (`listMethodVersionShowcases`, `getMethodVersionShowcase`),
 * and the read of the draft's layouts (`listMethodDraftLayouts`), all against a mocked fetch. The
 * type-level assertions bite in `npm run typecheck:test`, which `make check` runs.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import type {
  MethodLayoutList,
  MethodShowcaseDetail,
  MethodShowcaseFreezeResult,
  MethodShowcaseInput,
  MethodShowcaseList,
  MethodShowcaseRefusalReason,
  MethodShowcaseRefused,
  MethodShowcaseWriteOptions,
} from "../src/index.js";
import { problemResponse } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const METHOD_ID = "mt_receipts01";
const SHOWCASE_ID = "sc_0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6a7b";
const DIGEST = "sha256:5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47";
const SHOWCASES_URL = `${BASE_URL}/v1/methods/${METHOD_ID}/showcases`;
const VERSION_SHOWCASES_URL = `${BASE_URL}/v1/methods/${METHOD_ID}/versions/3/showcases`;
const DRAFT_LAYOUTS_URL = `${BASE_URL}/v1/methods/${METHOD_ID}/draft/layouts`;
const SIGNATURE = "X-Amz-Signature=fixture-signature";
const SIGNED_URL = `https://app-bucket.s3.amazonaws.com/org_1/${METHOD_ID}/showcases/${SHOWCASE_ID}/files/abc.pdf?${SIGNATURE}`;

/** A freeze's body, every member given. */
const FREEZE_INPUT: MethodShowcaseInput = { run_id: "run_1", name: "March receipt" };

/** A showcase as a list reads it. */
const SUMMARY = {
  showcase_id: SHOWCASE_ID,
  name: "March receipt",
  pipe_ref: "receipts.review_receipt",
  tree_digest: DIGEST,
  frozen_at: "2026-11-09T09:00:00+00:00",
};

/** An older showcase of another tree, as the holder's list reads it. */
const OLDER = {
  ...SUMMARY,
  showcase_id: "sc_0192b3c4-d5e6-7f80-9a1b-000000000000",
  name: "February receipt",
};

/** One stored file of a detail, with a link signed for that read. */
const FILE = {
  address: `pipelex-storage://org_1/${METHOD_ID}/showcases/${SHOWCASE_ID}/files/abc.pdf`,
  file_name: "abc.pdf",
  media_type: "application/pdf",
  size_bytes: 2048,
  url: SIGNED_URL,
};

/** A showcase in full, as a detail read answers it. */
const DETAIL = {
  ...SUMMARY,
  document: {
    inputs: { receipt: { url: FILE.address }, total: 3 },
    main_stuff: { merchant: "Corner Bakery" },
    input_form: { "receipts.review_receipt": {} },
    output_form: { "receipts.review_receipt": {} },
    pipe_io_contracts: { "receipts.review_receipt": {} },
  },
  files: [FILE],
};

/** A stored layout as the draft's read answers it. */
const LAYOUT = {
  tree_digest: DIGEST,
  pipe_ref: "receipts.review_receipt",
  catalog: "composer",
  prompt_hash: "a1b2c3d4e5f6",
  jsonl: '{"op":"add","path":"/root","value":"page"}',
  provenance: { producer: "pipelex-method", model: "claude-4.8-opus" },
  stored_at: "2026-11-08T09:00:00+00:00",
};

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

function headersOf(spy: ReturnType<typeof vi.spyOn>): Record<string, string> {
  return (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
}

async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => {
      throw new Error("expected the call to fail");
    },
    (thrown: unknown) => thrown,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the showcase types", () => {
  it("types each call and the freeze's verdict", () => {
    expectTypeOf<PipelexApiClient["freezeMethodShowcase"]>().toEqualTypeOf<
      (
        methodId: string,
        input: MethodShowcaseInput,
        options?: MethodShowcaseWriteOptions,
      ) => Promise<MethodShowcaseFreezeResult>
    >();
    expectTypeOf<ReturnType<PipelexApiClient["withdrawMethodShowcase"]>>().toEqualTypeOf<
      Promise<void>
    >();
    expectTypeOf<ReturnType<PipelexApiClient["listMethodShowcases"]>>().toEqualTypeOf<
      Promise<MethodShowcaseList>
    >();
    expectTypeOf<ReturnType<PipelexApiClient["getMethodVersionShowcase"]>>().toEqualTypeOf<
      Promise<MethodShowcaseDetail>
    >();
    expectTypeOf<ReturnType<PipelexApiClient["listMethodDraftLayouts"]>>().toEqualTypeOf<
      Promise<MethodLayoutList>
    >();
    expectTypeOf<MethodShowcaseRefusalReason>().toEqualTypeOf<
      "run_not_usable" | "tree_not_current" | "file_not_readable" | "too_large" | "too_many"
    >();
    // Read open: a reason this SDK knows completes, and one it does not still assigns.
    const later: MethodShowcaseRefused["reason"] = "a_later_reason";
    expect(later).toBe("a_later_reason");
  });
});

describe("freezeMethodShowcase", () => {
  it("POSTs the closed body and answers the frozen verdict with its showcase", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { outcome: "frozen", showcase: SUMMARY }));

    const result = await makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT);

    const { url, method, body } = onlyRequest(spy);
    expect(url).toBe(SHOWCASES_URL);
    expect(method).toBe("POST");
    expect(body).toEqual({ run_id: "run_1", name: "March receipt" });
    expect(result).toEqual({ outcome: "frozen", showcase: SUMMARY });
  });

  it("answers `unchanged` with the showcase that stands", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { outcome: "unchanged", showcase: SUMMARY }),
    );

    const result = await makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT);

    expect(result).toEqual({ outcome: "unchanged", showcase: SUMMARY });
  });

  it.each(["run_not_usable", "tree_not_current", "file_not_readable", "too_large", "too_many"])(
    "answers a refusal naming %s as a verdict, never a throw",
    async (reason) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(200, { outcome: "refused", reason, message: "Why it was refused." }),
      );

      const result = await makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT);

      expect(result).toEqual({ outcome: "refused", reason, message: "Why it was refused." });
    },
  );

  it("reads a refusal this SDK does not know as its raw string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { outcome: "refused", reason: "a_later_reason", message: "Later." }),
    );

    const result = await makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT);

    expect(result).toMatchObject({ outcome: "refused", reason: "a_later_reason" });
  });

  it.each([
    [
      "an unknown outcome",
      { outcome: "maybe" },
      "`outcome` is not `frozen`, `unchanged` or `refused`",
    ],
    ["no showcase", { outcome: "frozen" }, "`showcase` is one that is not an object"],
    [
      "a showcase missing a member",
      { outcome: "unchanged", showcase: { ...SUMMARY, name: 4 } },
      "`showcase` is one whose `name` is not a string",
    ],
    [
      "a refusal with no reason",
      { outcome: "refused", message: "Why." },
      "`refused` freeze result whose `reason` is not a string",
    ],
    [
      "a refusal with no message",
      { outcome: "refused", reason: "too_many" },
      "`refused` freeze result whose `message` is not a string",
    ],
  ])("refuses an answer with %s as one it cannot read", async (_name, body, fault) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await failureOf(() => makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
    expect((err as Error).message).toContain(fault);
  });

  it.each([
    ["no run id", { name: "n" }, "run_id", "not_a_string"],
    ["an empty run id", { run_id: "", name: "n" }, "run_id", "empty"],
    ["no name", { run_id: "run_1" }, "name", "not_a_string"],
    ["an empty name", { run_id: "run_1", name: "" }, "name", "empty"],
  ])("refuses %s before sending anything", async (_name, input, argument, reason) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().freezeMethodShowcase(METHOD_ID, input as MethodShowcaseInput),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as ProblemError).problem.params).toEqual({ argument, reason });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().freezeMethodShowcase(`${METHOD_ID}@3`, FREEZE_INPUT),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends the key as the Idempotency-Key header, never in the body", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { outcome: "frozen", showcase: SUMMARY }));

    await makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT, { idempotencyKey: "f-1" });

    expect(headersOf(spy)["Idempotency-Key"]).toBe("f-1");
    expect(onlyRequest(spy).body).toEqual(FREEZE_INPUT);
  });

  it("refuses a malformed key before any request, naming what it does", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT, { idempotencyKey: "" }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain("Leave it out to freeze the showcase without one.");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["a runner", 403, "auth.forbidden"],
    ["an unknown method", 404, "pipelex.catalog.not_found"],
    ["a method being erased", 409, "pipelex.catalog.being_deleted"],
    ["a body that does not validate", 422, "request.invalid"],
    ["a freeze past its deadline", 503, "runtime.unavailable"],
  ])("throws the platform's refusal of %s", async (_name, status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(code, status));

    const err = await failureOf(() => makeClient().freezeMethodShowcase(METHOD_ID, FREEZE_INPUT));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(status);
    expect((err as ApiResponseError).problem.code).toBe(code);
  });
});

describe("withdrawMethodShowcase", () => {
  it("DELETEs the showcase and answers nothing on a 204", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(makeClient().withdrawMethodShowcase(METHOD_ID, SHOWCASE_ID)).resolves.toBe(
      undefined,
    );

    const { url, method, body } = onlyRequest(spy);
    expect(url).toBe(`${SHOWCASES_URL}/${SHOWCASE_ID}`);
    expect(method).toBe("DELETE");
    expect(body).toBeUndefined();
  });

  it("sends the key as the Idempotency-Key header", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await makeClient().withdrawMethodShowcase(METHOD_ID, SHOWCASE_ID, { idempotencyKey: "w-1" });

    expect(headersOf(spy)["Idempotency-Key"]).toBe("w-1");
  });

  it("throws the 404 of a showcase already withdrawn", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("pipelex.catalog.not_found", 404, { params: { resource: "example" } }),
    );

    const err = await failureOf(() => makeClient().withdrawMethodShowcase(METHOD_ID, SHOWCASE_ID));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.code).toBe("pipelex.catalog.not_found");
    expect((err as ApiResponseError).problem.params).toEqual({ resource: "example" });
  });
});

describe("listMethodShowcases", () => {
  it("GETs the holder's showcases, oldest first", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [OLDER, SUMMARY] }));

    const list = await makeClient().listMethodShowcases(METHOD_ID);

    const { url, method } = onlyRequest(spy);
    expect(url).toBe(SHOWCASES_URL);
    expect(method).toBe("GET");
    expect(list.items).toEqual([OLDER, SUMMARY]);
  });

  it("leaves out an entry that does not read as a summary, keeping the others in order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [OLDER, { ...SUMMARY, tree_digest: 4 }, "not one", SUMMARY] }),
    );

    const list = await makeClient().listMethodShowcases(METHOD_ID);

    expect(list.items).toEqual([OLDER, SUMMARY]);
  });

  it.each([
    ["no items", {}],
    ["items that are not an array", { items: { first: SUMMARY } }],
  ])("refuses an answer with %s as one it cannot read", async (_name, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await failureOf(() => makeClient().listMethodShowcases(METHOD_ID));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
    expect((err as Error).message).toContain("`items` is not an array");
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
      makeClient().listMethodShowcases(METHOD_ID, { signal: controller.signal }),
    );
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
  });
});

describe("listMethodVersionShowcases", () => {
  it("GETs the showcases of the tree the version holds", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [SUMMARY] }));

    const list = await makeClient().listMethodVersionShowcases(METHOD_ID, 3);

    expect(onlyRequest(spy).url).toBe(VERSION_SHOWCASES_URL);
    expect(list.items).toEqual([SUMMARY]);
  });

  it("answers an empty list when none is frozen", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: [] }));

    await expect(makeClient().listMethodVersionShowcases(METHOD_ID, 3)).resolves.toEqual({
      items: [],
    });
  });

  it.each([0, -1, 1.5, Number.NaN, "3", null])(
    "refuses the version %s before sending anything",
    async (version) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await failureOf(() =>
        makeClient().listMethodVersionShowcases(METHOD_ID, version as number),
      );

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as Error).message).toContain(
        "listMethodVersionShowcases() takes a version number, the published version whose showcases to read",
      );
      expect((err as ProblemError).problem.params).toEqual({
        argument: "version",
        reason: "not_a_positive_integer",
      });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a method never published or unknown", 404, "pipelex.catalog.not_found"],
    ["a method being erased", 409, "pipelex.catalog.being_deleted"],
  ])("throws the platform's refusal of %s", async (_name, status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(code, status));

    const err = await failureOf(() => makeClient().listMethodVersionShowcases(METHOD_ID, 3));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(status);
    expect((err as ApiResponseError).problem.code).toBe(code);
  });
});

describe.each([
  [
    "getMethodShowcase",
    (client: PipelexApiClient) => client.getMethodShowcase(METHOD_ID, SHOWCASE_ID),
    `${SHOWCASES_URL}/${SHOWCASE_ID}`,
  ],
  [
    "getMethodVersionShowcase",
    (client: PipelexApiClient) => client.getMethodVersionShowcase(METHOD_ID, 3, SHOWCASE_ID),
    `${VERSION_SHOWCASES_URL}/${SHOWCASE_ID}`,
  ],
] as const)("%s", (_name, read, url) => {
  it("GETs the showcase in full, its document and its files", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, DETAIL));

    const detail = await read(makeClient());

    expect(onlyRequest(spy).url).toBe(url);
    expect(detail).toEqual(DETAIL);
    expect(detail.files[0]!.url).toBe(SIGNED_URL);
  });

  it("reads an integer past the safe range in the document as a bigint", async () => {
    const text = JSON.stringify(DETAIL).replace('"total":3', '"total":12345678901234567891');
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(text, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const detail = await read(makeClient());

    expect(detail.document.inputs.total).toBe(12345678901234567891n);
  });

  it.each(["main_stuff", "input_form", "output_form", "pipe_io_contracts"] as const)(
    "reads a document stating %s as null",
    async (member) => {
      const body = { ...DETAIL, document: { ...DETAIL.document, [member]: null } };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

      const detail = await read(makeClient());

      expect(detail.document[member]).toBeNull();
    },
  );

  it.each([
    ["a summary member that is not a string", { ...DETAIL, name: 4 }, "`name` is not a string"],
    ["no document", { ...DETAIL, document: "x" }, "`document` is not an object"],
    [
      "a document with no inputs",
      { ...DETAIL, document: { ...DETAIL.document, inputs: null } },
      "`document.inputs` is not an object",
    ],
    ["files that are not an array", { ...DETAIL, files: {} }, "`files` is not an array"],
    [
      "a file with no address",
      { ...DETAIL, files: [{ ...FILE, address: 4 }] },
      "`files` holds an entry whose `address` is not a string, at [0]",
    ],
    [
      "a file with a negative size",
      { ...DETAIL, files: [FILE, { ...FILE, size_bytes: -1 }] },
      "`files` holds an entry whose `size_bytes` is not a non-negative integer, at [1]",
    ],
  ])("refuses an answer with %s, its links redacted", async (_label, body, fault) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await failureOf(() => read(makeClient()));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
    expect((err as Error).message).toContain(fault);
    expect((err as ApiResponseError).responseBody).not.toContain(SIGNATURE);
  });

  it.each(["main_stuff", "input_form", "output_form", "pipe_io_contracts"] as const)(
    "refuses a document that leaves out %s, its links redacted",
    async (member) => {
      const body = { ...DETAIL, document: { ...DETAIL.document, [member]: undefined } };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

      const err = await failureOf(() => read(makeClient()));

      expect(err).toBeInstanceOf(ApiResponseError);
      expect((err as ApiResponseError).problem.code).toBe("client.response_unreadable");
      expect((err as Error).message).toContain(`\`document.${member}\` is left out`);
      expect((err as ApiResponseError).responseBody).not.toContain(SIGNATURE);
    },
  );

  it("throws the 404 of a showcase it does not have", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("pipelex.catalog.not_found", 404, { params: { resource: "example" } }),
    );

    const err = await failureOf(() => read(makeClient()));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).problem.params).toEqual({ resource: "example" });
  });
});

describe("listMethodDraftLayouts", () => {
  it("GETs the draft's layouts and reads them as a version's are read", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        items: [LAYOUT, { ...LAYOUT, jsonl: 4 }],
      }),
    );

    const list = await makeClient().listMethodDraftLayouts(METHOD_ID);

    const { url, method } = onlyRequest(spy);
    expect(url).toBe(DRAFT_LAYOUTS_URL);
    expect(method).toBe("GET");
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ catalog: "composer", sample_json: null });
  });

  it("answers an empty list for a draft none was designed for", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: [] }));

    await expect(makeClient().listMethodDraftLayouts(METHOD_ID)).resolves.toEqual({ items: [] });
  });

  it("refuses a suffixed method id before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() => makeClient().listMethodDraftLayouts(`${METHOD_ID}@draft`));

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an answer whose items is not an array as one it cannot read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: "x" }));

    const err = await failureOf(() => makeClient().listMethodDraftLayouts(METHOD_ID));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as Error).message).toContain("`items` is not an array");
  });

  it.each([
    ["a method it does not hold", 404, "pipelex.catalog.not_found"],
    ["a method being erased", 409, "pipelex.catalog.being_deleted"],
  ])("throws the platform's refusal of %s", async (_name, status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(problemResponse(code, status));

    const err = await failureOf(() => makeClient().listMethodDraftLayouts(METHOD_ID));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(status);
    expect((err as ApiResponseError).problem.code).toBe(code);
  });
});
