/**
 * A saved method's examples: the create, the paged list and its iterator, the read, the edit,
 * the latest-run write and its `recorded` / `stale` verdict, and the delete — the requests each
 * method builds and the answers it reads, all against a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError, errorVerdictOf } from "../src/errors.js";
import type {
  MethodExample,
  MethodExampleLatestRunInput,
  MethodExampleLatestRunResult,
  MethodExampleUpdateInput,
} from "../src/product-models.js";

const BASE_URL = "http://localhost:8081";
const METHOD_ID = "mt_receipts01";
const EXAMPLE_ID = "ex_0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6a7b";
const EXAMPLE_PATH = `${BASE_URL}/v1/methods/${METHOD_ID}/examples/${EXAMPLE_ID}`;

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

/** An example as the platform serializes it, its inputs holding an integer and a float. */
const EXAMPLE: MethodExample = {
  example_id: EXAMPLE_ID,
  method_id: METHOD_ID,
  name: "March receipt",
  inputs: { receipt: { url: "pipelex-storage://org_1/receipt.pdf" }, total: 3, rate: 3.5 },
  input_revision: 2,
  latest_run_id: "run_1",
  created_by_user_id: "user_1",
  created_at: "2026-10-12T09:00:00+00:00",
  updated_at: "2026-10-12T10:00:00+00:00",
};

const REVISED: MethodExample = {
  ...EXAMPLE,
  inputs: { total: 4 },
  input_revision: 3,
  latest_run_id: null,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMethodExample", () => {
  it("POSTs the name, the inputs and the run to /v1/methods/{id}/examples and returns the example", async () => {
    const client = makeClient();
    const created = { ...EXAMPLE, input_revision: 1 };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const example = await client.createMethodExample(METHOD_ID, {
      name: "March receipt",
      inputs: EXAMPLE.inputs,
      run_id: "run_1",
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE_URL}/v1/methods/${METHOD_ID}/examples`);
    expect(req.body).toEqual({ name: "March receipt", inputs: EXAMPLE.inputs, run_id: "run_1" });
    expect(example).toEqual(created);
  });

  it("omits the run when none is given, and sends nothing an untyped caller adds", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(201, { ...EXAMPLE, latest_run_id: null }));

    await client.createMethodExample(METHOD_ID, {
      name: "March receipt",
      inputs: { total: 3 },
      input_revision: 1,
    } as unknown as { name: string; inputs: Record<string, unknown> });

    expect(onlyRequest(spy).body).toEqual({ name: "March receipt", inputs: { total: 3 } });
  });

  it("surfaces a run that is not the method's as a 404 run_not_found", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { status: 404, code: "run_not_found", detail: "No run run_9." }),
    );

    const err = await client
      .createMethodExample(METHOD_ID, { name: "n", inputs: {}, run_id: "run_9" })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("run_not_found");
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
  });

  it("surfaces an example too large to store as a 413 payload_too_large", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(413, { status: 413, code: "payload_too_large", detail: "Over 400 KB." }),
    );

    const err = await client
      .createMethodExample(METHOD_ID, { name: "n", inputs: { blob: "x" } })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(413);
    expect((err as ApiResponseError).code).toBe("payload_too_large");
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
  });

  it("throws a typed ApiResponseError for an answer that is not an object", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, [EXAMPLE]));

    const err = await client
      .createMethodExample(METHOD_ID, { name: "n", inputs: {} })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: false });
  });
});

describe("listMethodExamples", () => {
  it("GETs /v1/methods/{id}/examples and maps the page envelope", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [EXAMPLE, REVISED], next_cursor: "c2" }));

    const page = await client.listMethodExamples(METHOD_ID);

    const req = onlyRequest(spy);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE_URL}/v1/methods/${METHOD_ID}/examples`);
    expect(page).toEqual({ items: [EXAMPLE, REVISED], nextCursor: "c2" });
  });

  it("forwards limit and cursor, an explicit empty cursor included", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [], next_cursor: null })),
      );

    await client.listMethodExamples(METHOD_ID, { limit: 5, cursor: "c/1" });
    expect(onlyRequest(spy).url).toBe(
      `${BASE_URL}/v1/methods/${METHOD_ID}/examples?limit=5&cursor=c%2F1`,
    );

    spy.mockClear();
    await client.listMethodExamples(METHOD_ID, { cursor: "" });
    expect(onlyRequest(spy).url).toBe(`${BASE_URL}/v1/methods/${METHOD_ID}/examples?cursor=`);
  });

  it("throws a typed ApiResponseError on a page it cannot walk", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items: [EXAMPLE] }));

    const err = await client.listMethodExamples(METHOD_ID).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API GET /v1/methods/${METHOD_ID}/examples answered 200 with a page whose ` +
        "`next_cursor` is neither a string nor null",
    );
  });
});

describe("iterateMethodExamples", () => {
  it("follows the cursor through a short and an empty page, oldest first, until it is null", async () => {
    const client = makeClient();
    const third = { ...EXAMPLE, example_id: "ex_3" };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [EXAMPLE], next_cursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c3" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [REVISED, third], next_cursor: null }));

    const seen: MethodExample[] = [];
    for await (const example of client.iterateMethodExamples(METHOD_ID, { limit: 2 })) {
      seen.push(example);
    }

    expect(seen).toEqual([EXAMPLE, REVISED, third]);
    const urls = spy.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      `${BASE_URL}/v1/methods/${METHOD_ID}/examples?limit=2`,
      `${BASE_URL}/v1/methods/${METHOD_ID}/examples?limit=2&cursor=c2`,
      `${BASE_URL}/v1/methods/${METHOD_ID}/examples?limit=2&cursor=c3`,
    ]);
  });

  it("stops when the server hands back the cursor it was sent, yielding that page once", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [EXAMPLE], next_cursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [EXAMPLE], next_cursor: "c2" }));

    const seen: MethodExample[] = [];
    for await (const example of client.iterateMethodExamples(METHOD_ID)) seen.push(example);

    // The no-progress guard of the loop `iterateMethods` and `iterateRuns` share, whose page
    // ceiling `product.test.ts` covers.
    expect(seen).toEqual([EXAMPLE]);
  });
});

describe("getMethodExample", () => {
  it("GETs /v1/methods/{id}/examples/{example_id} and returns the example as served", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, EXAMPLE));

    const example = await client.getMethodExample(METHOD_ID, EXAMPLE_ID);

    const req = onlyRequest(spy);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(EXAMPLE_PATH);
    expect(example).toEqual(EXAMPLE);
    // The inputs come back exactly as saved: an integer stays an integer.
    expect(Number.isInteger(example.inputs.total)).toBe(true);
  });

  it("encodes the example id into the path", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, EXAMPLE));

    await client.getMethodExample(METHOD_ID, "ex/1?x");

    expect(onlyRequest(spy).url).toBe(`${BASE_URL}/v1/methods/${METHOD_ID}/examples/ex%2F1%3Fx`);
  });

  it("surfaces an unknown example as a 404 not_found", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { status: 404, code: "not_found", detail: "No example." }),
    );

    const err = await client
      .getMethodExample(METHOD_ID, EXAMPLE_ID)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("not_found");
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
  });
});

describe("updateMethodExample", () => {
  it("PATCHes new inputs and hands back the next revision with no latest run", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, REVISED));

    const example = await client.updateMethodExample(METHOD_ID, EXAMPLE_ID, {
      inputs: { total: 4 },
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe(EXAMPLE_PATH);
    expect(req.body).toEqual({ inputs: { total: 4 } });
    expect(example.input_revision).toBe(3);
    expect(example.latest_run_id).toBeNull();
  });

  it("sends a rename alone, and both fields together", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, EXAMPLE)));

    await client.updateMethodExample(METHOD_ID, EXAMPLE_ID, { name: "April receipt" });
    expect(onlyRequest(spy).body).toEqual({ name: "April receipt" });

    spy.mockClear();
    await client.updateMethodExample(METHOD_ID, EXAMPLE_ID, {
      name: "April receipt",
      inputs: { total: 4 },
    });
    expect(onlyRequest(spy).body).toEqual({ name: "April receipt", inputs: { total: 4 } });
  });

  it("drops a null field and anything an untyped caller adds", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, EXAMPLE));

    await client.updateMethodExample(METHOD_ID, EXAMPLE_ID, {
      name: null,
      inputs: { total: 4 },
      input_revision: 2,
    } as unknown as MethodExampleUpdateInput);

    expect(onlyRequest(spy).body).toEqual({ inputs: { total: 4 } });
  });

  it.each([
    ["an empty input", {}],
    ["two null fields", { name: null, inputs: null }],
    ["no input at all", undefined],
  ])("refuses %s before sending anything", async (_label, input) => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await client
      .updateMethodExample(METHOD_ID, EXAMPLE_ID, input as unknown as MethodExampleUpdateInput)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "updateMethodExample() needs a new name, new inputs, or both; got neither.",
    );
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a retryable 503 when concurrent edits kept landing", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(503, { status: 503, code: "service_unavailable", detail: "Try again." }),
    );

    const err = await client
      .updateMethodExample(METHOD_ID, EXAMPLE_ID, { inputs: { total: 5 } })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: true });
  });
});

describe("recordMethodExampleLatestRun", () => {
  it("PUTs the run and its revision to …/latest-run and hands back a recorded verdict", async () => {
    const client = makeClient();
    const recorded = { ...EXAMPLE, latest_run_id: "run_2" };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { outcome: "recorded", example: recorded }));

    const result = await client.recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, {
      run_id: "run_2",
      input_revision: 2,
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${EXAMPLE_PATH}/latest-run`);
    expect(req.body).toEqual({ run_id: "run_2", input_revision: 2 });
    expect(result).toEqual({ outcome: "recorded", example: recorded });
  });

  it("hands back a stale verdict, never an error, with the example as it now stands", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { outcome: "stale", example: REVISED }),
    );

    const result = await client.recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, {
      run_id: "run_2",
      input_revision: 2,
    });

    expect(result.outcome).toBe("stale");
    if (result.outcome !== "stale") throw new Error("narrowed above");
    expect(result.example.input_revision).toBe(3);
    expect(result.example.latest_run_id).toBeNull();
  });

  it("narrows on outcome", () => {
    expectTypeOf<MethodExampleLatestRunResult["outcome"]>().toEqualTypeOf<"recorded" | "stale">();
    expectTypeOf<
      Extract<MethodExampleLatestRunResult, { outcome: "stale" }>["example"]
    >().toEqualTypeOf<MethodExample>();
    expectTypeOf<
      Extract<MethodExampleLatestRunResult, { outcome: "recorded" }>["example"]
    >().toEqualTypeOf<MethodExample>();
  });

  it.each([
    ["an outcome it does not know", { outcome: "refused", example: EXAMPLE }, "outcome"],
    ["no outcome", { example: EXAMPLE }, "outcome"],
    ["no example", { outcome: "recorded" }, "example"],
    ["an example that is not an object", { outcome: "stale", example: "ex_1" }, "example"],
  ])("throws a typed ApiResponseError for a verdict with %s", async (_label, body, member) => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await client
      .recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, { run_id: "run_2", input_revision: 2 })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toContain(
      `API PUT /v1/methods/${METHOD_ID}/examples/${EXAMPLE_ID}/latest-run answered 200 with a ` +
        `latest-run result whose \`${member}\``,
    );
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: false });
  });

  it.each([
    ["no run id", { input_revision: 2 }, "run_id"],
    ["an empty run id", { run_id: "", input_revision: 2 }, "run_id"],
    ["no revision", { run_id: "run_2" }, "input_revision"],
    ["a zero revision", { run_id: "run_2", input_revision: 0 }, "input_revision"],
    ["a fractional revision", { run_id: "run_2", input_revision: 1.5 }, "input_revision"],
    ["a revision as a string", { run_id: "run_2", input_revision: "2" }, "input_revision"],
  ])("refuses %s before sending anything", async (_label, input, field) => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await client
      .recordMethodExampleLatestRun(
        METHOD_ID,
        EXAMPLE_ID,
        input as unknown as MethodExampleLatestRunInput,
      )
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toContain(`needs ${field}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces an example deleted since as a 404, not as a verdict", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { status: 404, code: "not_found", detail: "No example." }),
    );

    const err = await client
      .recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, { run_id: "run_2", input_revision: 2 })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("not_found");
  });
});

describe("deleteMethodExample", () => {
  it("DELETEs /v1/methods/{id}/examples/{example_id} and reads the 204", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(client.deleteMethodExample(METHOD_ID, EXAMPLE_ID)).resolves.toBeUndefined();

    const req = onlyRequest(spy);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe(EXAMPLE_PATH);
    expect(req.body).toBeUndefined();
  });

  it("surfaces an example already deleted as a 404 not_found", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(404, { status: 404, code: "not_found", detail: "No example." }),
    );

    const err = await client
      .deleteMethodExample(METHOD_ID, EXAMPLE_ID)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(404);
  });
});

describe("the example routes' ids", () => {
  const calls: [string, (client: PipelexApiClient, exampleId: string) => Promise<unknown>][] = [
    ["getMethodExample", (client, id) => client.getMethodExample(METHOD_ID, id)],
    [
      "updateMethodExample",
      (client, id) => client.updateMethodExample(METHOD_ID, id, { name: "n" }),
    ],
    [
      "recordMethodExampleLatestRun",
      (client, id) =>
        client.recordMethodExampleLatestRun(METHOD_ID, id, { run_id: "r", input_revision: 1 }),
    ],
    ["deleteMethodExample", (client, id) => client.deleteMethodExample(METHOD_ID, id)],
  ];

  it.each(calls)(
    "%s refuses an empty example id, which would address the list, before sending anything",
    async (name, call) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await call(makeClient(), "").catch((thrown: unknown) => thrown);

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as Error).message).toBe(
        `${name}() takes an example id, the example's non-empty \`example_id\`; got an empty string.`,
      );
      expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  const methodCalls: [string, (client: PipelexApiClient) => Promise<unknown>][] = [
    [
      "createMethodExample",
      (client) => client.createMethodExample("mt_x@3", { name: "n", inputs: {} }),
    ],
    ["listMethodExamples", (client) => client.listMethodExamples("mt_x@3")],
    ["getMethodExample", (client) => client.getMethodExample("mt_x@3", EXAMPLE_ID)],
    ["deleteMethodExample", (client) => client.deleteMethodExample("mt_x@3", EXAMPLE_ID)],
  ];

  it.each(methodCalls)(
    "%s refuses a suffixed method id before sending anything",
    async (_name, call) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const err = await call(makeClient()).catch((thrown: unknown) => thrown);

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as Error).message).toContain('"mt_x@3" carries a version suffix');
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("surfaces a method being deleted as a 409 method_being_deleted", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, { status: 409, code: "method_being_deleted", detail: "Being deleted." }),
    );

    const err = await client.listMethodExamples(METHOD_ID).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("method_being_deleted");
  });
});
