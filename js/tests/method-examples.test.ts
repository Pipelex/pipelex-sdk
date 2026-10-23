/**
 * A saved method's examples: the create, the paged list and its iterator, the read, the edit,
 * the latest-run write and its `recorded` / `stale` verdict, and the delete — the requests each
 * method builds and the answers it reads, all against a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError, RequestArgumentError, errorVerdictOf } from "../src/errors.js";
import { stringifyExactJson } from "../src/exact-json.js";
import type {
  MethodExample,
  MethodExampleAssistantSaveInput,
  MethodExampleAssistantSaveResult,
  MethodExampleCreateInput,
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
  kept_by_assistant: false,
};

const REVISED: MethodExample = {
  ...EXAMPLE,
  inputs: { total: 4 },
  input_revision: 3,
  latest_run_id: null,
};

/**
 * Inputs another client saved, holding integers past `Number.MAX_SAFE_INTEGER` beside the ones
 * of `EXAMPLE`, as the platform serializes them: a double cannot hold them as saved.
 */
const BIG_INPUTS_TEXT =
  '{"receipt":{"url":"pipelex-storage://org_1/receipt.pdf"},"total":3,' +
  '"big":12345678901234567891,"nested":{"list":[-98765432109876543210]},"rate":3.5}';

/** `EXAMPLE` holding `BIG_INPUTS_TEXT` as its inputs, as the platform serializes it. */
const BIG_EXAMPLE_TEXT = JSON.stringify(EXAMPLE).replace(
  JSON.stringify(EXAMPLE.inputs),
  BIG_INPUTS_TEXT,
);

/** A JSON answer whose body is the text given, spelled as the platform spelled it. */
function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Each route answering an example: its name, how its route is named in a refusal, the answer
 * carrying a given example's text, where in that answer the example sits as a refusal names it,
 * and the call reading the example back.
 */
type ExampleRead = [
  name: string,
  route: string,
  answer: (exampleText: string) => Response,
  where: string,
  read: (client: PipelexApiClient) => Promise<MethodExample>,
];

const EXAMPLE_READS: ExampleRead[] = [
  [
    "getMethodExample",
    `GET /v1/methods/${METHOD_ID}/examples/${EXAMPLE_ID}`,
    (text) => textResponse(200, text),
    "an example",
    (client) => client.getMethodExample(METHOD_ID, EXAMPLE_ID),
  ],
  [
    "listMethodExamples",
    `GET /v1/methods/${METHOD_ID}/examples`,
    (text) =>
      textResponse(200, `{"items":[${JSON.stringify(REVISED)},${text}],"next_cursor":null}`),
    "a page item",
    async (client) => (await client.listMethodExamples(METHOD_ID)).items[1] as MethodExample,
  ],
  [
    "createMethodExample",
    `POST /v1/methods/${METHOD_ID}/examples`,
    (text) => textResponse(201, text),
    "an example",
    (client) => client.createMethodExample(METHOD_ID, { name: "March receipt", inputs: {} }),
  ],
  [
    "updateMethodExample",
    `PATCH /v1/methods/${METHOD_ID}/examples/${EXAMPLE_ID}`,
    (text) => textResponse(200, text),
    "an example",
    (client) => client.updateMethodExample(METHOD_ID, EXAMPLE_ID, { name: "March receipt" }),
  ],
  [
    "recordMethodExampleLatestRun",
    `PUT /v1/methods/${METHOD_ID}/examples/${EXAMPLE_ID}/latest-run`,
    (text) => textResponse(200, `{"outcome":"recorded","example":${text}}`),
    "a latest-run result's `example`",
    async (client) =>
      (
        await client.recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, {
          run_id: "run_1",
          input_revision: 2,
        })
      ).example,
  ],
  [
    "saveAssistantMethodExample",
    `POST /v1/methods/${METHOD_ID}/examples/assistant-save`,
    (text) => textResponse(200, `{"outcome":"kept","example":${text}}`),
    "an assistant save result's `example`",
    async (client) =>
      (
        await client.saveAssistantMethodExample(METHOD_ID, {
          name: "Assistant's test inputs",
          inputs: { total: 3 },
          example_id: EXAMPLE_ID,
          input_revision: 2,
        })
      ).example,
  ],
];

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

  it("reads a null run as no run, sending none to the closed body", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(201, { ...EXAMPLE, latest_run_id: null }));

    await client.createMethodExample(METHOD_ID, {
      name: "March receipt",
      inputs: { total: 3 },
      run_id: null,
    });

    expect(onlyRequest(spy).body).toEqual({ name: "March receipt", inputs: { total: 3 } });
  });

  it("types the run as the docs describe it: a run id, null or left out", () => {
    expectTypeOf<MethodExampleCreateInput["run_id"]>().toEqualTypeOf<string | null | undefined>();
  });

  it.each([
    ["no input at all", undefined, "neither"],
    ["an empty input", {}, "neither"],
    ["no name", { inputs: { total: 3 } }, "no name"],
    ["a null name", { name: null, inputs: { total: 3 } }, "no name"],
    ["no inputs", { name: "March receipt" }, "no inputs"],
  ])("refuses %s before sending anything", async (_label, input, got) => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await client
      .createMethodExample(METHOD_ID, input as unknown as MethodExampleCreateInput)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      `createMethodExample() needs the example's name and its inputs; got ${got}.`,
    );
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty run id", "", "an empty string"],
    ["a run id that is not a string", 7, "number"],
  ])("refuses %s before sending anything", async (_label, runId, got) => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await client
      .createMethodExample(METHOD_ID, {
        name: "n",
        inputs: {},
        run_id: runId,
      } as unknown as MethodExampleCreateInput)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toBe(
      "createMethodExample() takes a run_id naming a run of this method that used these " +
        `inputs, a non-empty string, or none; got ${got}.`,
    );
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "input", retryable: false });
    expect(spy).not.toHaveBeenCalled();
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

  it.each([
    ["an empty method id", "", "got an empty string."],
    ["a dot segment", "..", 'got "..", a dot segment'],
  ])(
    "refuses %s at the call, before the iterator is pulled or anything is sent",
    (_label, methodId, got) => {
      const spy = vi.spyOn(globalThis, "fetch");

      let err: unknown;
      try {
        startIteratingExamples(methodId);
      } catch (thrown) {
        err = thrown;
      }

      expect(err).toBeInstanceOf(RequestArgumentError);
      expect((err as Error).message).toMatch(
        /^iterateMethodExamples\(\) takes a method id, the method's non-empty bare catalog id; /,
      );
      expect((err as Error).message).toContain(got);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("refuses a suffixed method id at the call", () => {
    expect(() => startIteratingExamples("mt_x@3")).toThrow('"mt_x@3" carries a version suffix');
  });
});

/** Call `iterateMethodExamples` without pulling the iterator it returns. */
function startIteratingExamples(methodId: string): void {
  void makeClient().iterateMethodExamples(methodId);
}

describe("getMethodExample", () => {
  it("GETs /v1/methods/{id}/examples/{example_id} and returns the example as served", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, EXAMPLE));

    const example = await client.getMethodExample(METHOD_ID, EXAMPLE_ID);

    const req = onlyRequest(spy);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(EXAMPLE_PATH);
    expect(example).toEqual(EXAMPLE);
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

  const OUTCOMES = "is not `recorded` or `stale`";
  const NOT_AN_EXAMPLE = "'s `example` that is not an object";

  it.each([
    [
      "an outcome it does not know",
      { outcome: "refused", example: EXAMPLE },
      ` whose \`outcome\` ${OUTCOMES}`,
    ],
    ["no outcome", { example: EXAMPLE }, ` whose \`outcome\` ${OUTCOMES}`],
    // The example is checked once, by the check every example goes through, so its refusals
    // read alike whatever is wrong with it.
    ["no example", { outcome: "recorded" }, NOT_AN_EXAMPLE],
    ["an example that is not an object", { outcome: "stale", example: "ex_1" }, NOT_AN_EXAMPLE],
  ])("throws a typed ApiResponseError for a verdict with %s", async (_label, body, what) => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await client
      .recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, { run_id: "run_2", input_revision: 2 })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API PUT /v1/methods/${METHOD_ID}/examples/${EXAMPLE_ID}/latest-run answered 200 with a ` +
        `latest-run result${what}`,
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
    [
      "a revision that is an object with no prototype",
      { run_id: "run_2", input_revision: Object.create(null) as unknown },
      "input_revision",
    ],
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
    expect((err as Error).message).toMatch(
      new RegExp(`^recordMethodExampleLatestRun\\(\\) takes an? ${field}[ ,].*; got .+\\.$`),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["a number by its value", 0, "0"],
    ["anything else by its type", "2", "string"],
    ["an object with no prototype by its type", Object.create(null) as unknown, "object"],
  ])("describes a revision it refuses, %s", async (_label, revision, got) => {
    const err = await makeClient()
      .recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, {
        run_id: "run_2",
        input_revision: revision as number,
      })
      .catch((thrown: unknown) => thrown);

    expect((err as Error).message).toBe(
      "recordMethodExampleLatestRun() takes an input_revision, the example's revision whose " +
        `inputs the run used, a positive integer; got ${got}.`,
    );
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

describe("saveAssistantMethodExample", () => {
  const SAVE_PATH = `${BASE_URL}/v1/methods/${METHOD_ID}/examples/assistant-save`;
  const KEPT_EXAMPLE: MethodExample = {
    ...EXAMPLE,
    inputs: { total: 5 },
    input_revision: 3,
    latest_run_id: null,
    kept_by_assistant: true,
  };

  it("POSTs the inputs with the example and revision it read, and hands back a kept verdict", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { outcome: "kept", example: KEPT_EXAMPLE }));

    const result = await client.saveAssistantMethodExample(METHOD_ID, {
      name: "Assistant's test inputs",
      inputs: { total: 5 },
      example_id: EXAMPLE_ID,
      input_revision: 2,
    });

    const req = onlyRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(SAVE_PATH);
    expect(req.body).toEqual({
      name: "Assistant's test inputs",
      inputs: { total: 5 },
      example_id: EXAMPLE_ID,
      input_revision: 2,
    });
    expect(result).toEqual({ outcome: "kept", example: KEPT_EXAMPLE });
    expect(result.example.kept_by_assistant).toBe(true);
  });

  it("sends neither member when none is named, null included, and nothing an untyped caller adds", async () => {
    const client = makeClient();
    const created = { ...KEPT_EXAMPLE, example_id: "ex_new", input_revision: 1 };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { outcome: "created", example: created }));

    const result = await client.saveAssistantMethodExample(METHOD_ID, {
      name: "Assistant's test inputs",
      inputs: { total: 5 },
      example_id: null,
      input_revision: null,
      run_id: "run_1",
    } as unknown as MethodExampleAssistantSaveInput);

    expect(onlyRequest(spy).body).toEqual({
      name: "Assistant's test inputs",
      inputs: { total: 5 },
    });
    expect(result.outcome).toBe("created");
    expect(result.example.example_id).toBe("ex_new");
  });

  it("narrows on outcome", () => {
    expectTypeOf<MethodExampleAssistantSaveResult["outcome"]>().toEqualTypeOf<"kept" | "created">();
    expectTypeOf<
      Extract<MethodExampleAssistantSaveResult, { outcome: "created" }>["example"]
    >().toEqualTypeOf<MethodExample>();
  });

  it.each([
    ["an outcome it does not know", { outcome: "stale", example: KEPT_EXAMPLE }],
    ["no outcome", { example: KEPT_EXAMPLE }],
  ])("throws a typed ApiResponseError for a verdict with %s", async (_label, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await makeClient()
      .saveAssistantMethodExample(METHOD_ID, { name: "n", inputs: {} })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API POST /v1/methods/${METHOD_ID}/examples/assistant-save answered 200 with an assistant ` +
        "save result whose `outcome` is not `kept` or `created`",
    );
    expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: false });
  });

  it.each([
    [
      "no name",
      { inputs: {} },
      /needs the name a new example takes and the inputs; got no name\.$/,
    ],
    ["no inputs", { name: "n" }, /; got no inputs\.$/],
    ["neither", {}, /; got neither\.$/],
    [
      "an empty example id",
      { name: "n", inputs: {}, example_id: "", input_revision: 2 },
      /takes an example_id naming the assistant's example .*; got an empty string\.$/,
    ],
    [
      "a zero revision",
      { name: "n", inputs: {}, example_id: EXAMPLE_ID, input_revision: 0 },
      /takes an input_revision, the revision the caller read .*; got 0\.$/,
    ],
    [
      "a revision as a string",
      { name: "n", inputs: {}, example_id: EXAMPLE_ID, input_revision: "2" },
      /takes an input_revision, .*; got string\.$/,
    ],
    [
      "an example id without its revision",
      { name: "n", inputs: {}, example_id: EXAMPLE_ID },
      /by both its example_id and the input_revision it was read at, or neither; got only example_id\.$/,
    ],
    [
      "a revision without its example id",
      { name: "n", inputs: {}, input_revision: 2 },
      /; got only input_revision\.$/,
    ],
  ])("refuses %s before sending anything", async (_label, input, message) => {
    const spy = vi.spyOn(globalThis, "fetch");

    const err = await makeClient()
      .saveAssistantMethodExample(METHOD_ID, input as unknown as MethodExampleAssistantSaveInput)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toMatch(/^saveAssistantMethodExample\(\) /);
    expect((err as Error).message).toMatch(message);
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a runner's refusal as a 403 role_not_permitted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(403, {
        status: 403,
        code: "role_not_permitted",
        error_domain: "config",
        retryable: false,
        detail: "Your role in this organization is runner.",
      }),
    );

    const err = await makeClient()
      .saveAssistantMethodExample(METHOD_ID, { name: "n", inputs: {} })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("role_not_permitted");
  });
});

describe.each(EXAMPLE_READS)(
  "an integer past Number.MAX_SAFE_INTEGER read by %s",
  (_name, _route, answer, _where, read) => {
    it("reads as a bigint with its exact digits, the other numbers staying numbers", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(answer(BIG_EXAMPLE_TEXT));

      const example = await read(makeClient());

      expect(example.inputs.big).toBe(12345678901234567891n);
      expect(example.inputs.nested).toEqual({ list: [-98765432109876543210n] });
      expect(example.inputs.total).toBe(3);
      expect(example.inputs.rate).toBe(3.5);
      // Shown as JSON text with the SDK's writer, the inputs read as they were saved.
      expect(stringifyExactJson(example.inputs)).toBe(BIG_INPUTS_TEXT);
      expect(String(example.inputs.big)).toBe("12345678901234567891");
    });

    it("goes back to updateMethodExample digit for digit", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(answer(BIG_EXAMPLE_TEXT))
        .mockResolvedValueOnce(jsonResponse(200, REVISED));
      const client = makeClient();

      const example = await read(client);
      await client.updateMethodExample(METHOD_ID, EXAMPLE_ID, { inputs: example.inputs });

      const [url, init] = spy.mock.calls[1] as [string, RequestInit];
      expect(url).toBe(EXAMPLE_PATH);
      expect(init.body).toBe(`{"inputs":${BIG_INPUTS_TEXT}}`);
    });

    it("runs digit for digit, and the run is recorded under the revision read", async () => {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(answer(BIG_EXAMPLE_TEXT))
        .mockResolvedValueOnce(jsonResponse(202, { pipeline_run_id: "run_2" }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            outcome: "recorded",
            example: { ...EXAMPLE, latest_run_id: "run_2" },
          }),
        );
      const client = makeClient();

      const example = await read(client);
      const started = await client.start({ method_id: METHOD_ID, inputs: example.inputs });
      const verdict = await client.recordMethodExampleLatestRun(METHOD_ID, EXAMPLE_ID, {
        run_id: started.pipeline_run_id,
        input_revision: example.input_revision,
      });

      const [startUrl, startInit] = spy.mock.calls[1] as [string, RequestInit];
      expect(startUrl).toBe(`${BASE_URL}/v1/start`);
      expect(startInit.body).toContain(`"inputs":${BIG_INPUTS_TEXT}`);
      const [recordUrl, recordInit] = spy.mock.calls[2] as [string, RequestInit];
      expect(recordUrl).toBe(`${EXAMPLE_PATH}/latest-run`);
      expect(recordInit.body).toBe('{"run_id":"run_2","input_revision":2}');
      expect(verdict.outcome).toBe("recorded");
    });
  },
);

describe("a page holding an example with an integer past Number.MAX_SAFE_INTEGER", () => {
  it("reads whole, every other example as it reads anyway", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(
        200,
        `{"items":[${JSON.stringify(EXAMPLE)},${BIG_EXAMPLE_TEXT},${JSON.stringify(REVISED)}],` +
          '"next_cursor":"c2"}',
      ),
    );

    const page = await makeClient().listMethodExamples(METHOD_ID);

    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toEqual(EXAMPLE);
    expect(page.items[1]?.inputs.big).toBe(12345678901234567891n);
    expect(page.items[2]).toEqual(REVISED);
    expect(page.nextCursor).toBe("c2");
  });
});

/** The example `EXAMPLE` is, with `field` removed or set to `value`. */
function exampleWith(field: keyof MethodExample, value?: unknown): Record<string, unknown> {
  const example: Record<string, unknown> = { ...EXAMPLE };
  if (value === undefined) delete example[field];
  else example[field] = value;
  return example;
}

/** Examples missing a field the Python SDK's model requires, or holding one of another type. */
const DEFECTIVE_EXAMPLES: [label: string, example: unknown, field: string, expected: string][] = [
  ["no example_id", exampleWith("example_id"), "example_id", "a string"],
  ["a numeric method_id", exampleWith("method_id", 7), "method_id", "a string"],
  ["no name", exampleWith("name"), "name", "a string"],
  ["inputs that are an array", exampleWith("inputs", [3]), "inputs", "an object"],
  ["inputs that are null", exampleWith("inputs", null), "inputs", "an object"],
  ["no input_revision", exampleWith("input_revision"), "input_revision", "an integer"],
  ["a revision as a string", exampleWith("input_revision", "2"), "input_revision", "an integer"],
  ["a fractional revision", exampleWith("input_revision", 2.5), "input_revision", "an integer"],
  ["no latest_run_id", exampleWith("latest_run_id"), "latest_run_id", "a string or null"],
  ["a numeric latest_run_id", exampleWith("latest_run_id", 1), "latest_run_id", "a string or null"],
  ["no created_by_user_id", exampleWith("created_by_user_id"), "created_by_user_id", "a string"],
  ["no created_at", exampleWith("created_at"), "created_at", "a string"],
  ["no updated_at", exampleWith("updated_at"), "updated_at", "a string"],
  ["no kept_by_assistant", exampleWith("kept_by_assistant"), "kept_by_assistant", "a boolean"],
  [
    "a kept_by_assistant as a string",
    exampleWith("kept_by_assistant", "true"),
    "kept_by_assistant",
    "a boolean",
  ],
];

describe.each(EXAMPLE_READS)("an example %s answers", (_name, route, answer, where, read) => {
  it.each(DEFECTIVE_EXAMPLES)(
    "with %s is an answer the SDK cannot read",
    async (_label, example, field, expected) => {
      const response = answer(JSON.stringify(example));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      const err = await read(makeClient()).catch((thrown: unknown) => thrown);

      expect(err).toBeInstanceOf(ApiResponseError);
      expect((err as ApiResponseError).message).toBe(
        `API ${route} answered ${response.status} with ${where} whose \`${field}\` is not ` +
          `${expected}`,
      );
      expect(errorVerdictOf(err)).toEqual({ errorDomain: "runtime", retryable: false });
    },
  );

  it("with a revision past the safe range is an answer the SDK cannot read", async () => {
    const text = JSON.stringify(EXAMPLE).replace(
      '"input_revision":2',
      '"input_revision":12345678901234567891',
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(answer(text));

    const err = await read(makeClient()).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toContain(
      `${where} whose \`input_revision\` is not an integer`,
    );
  });
});

describe("a page item that is not an object", () => {
  it("is an answer the SDK cannot read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [EXAMPLE, "ex_1"], next_cursor: null }),
    );

    const err = await makeClient()
      .listMethodExamples(METHOD_ID)
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API GET /v1/methods/${METHOD_ID}/examples answered 200 with a page item that is not an ` +
        "object",
    );
  });
});

describe("a verdict naming a single outcome it expects", () => {
  it("says which, without a stray conjunction", () => {
    // Both routes reading a verdict expect two or more outcomes; the wording of one is checked
    // on the private reader they share.
    type ReadVerdict = (
      method: string,
      endpoint: string,
      res: { status: number; statusText: string; headers: Headers; body: string; utf8: boolean },
      shape: { verdict: string; outcomes: readonly string[]; member: string },
    ) => unknown;
    const client = makeClient();
    const readVerdict = Reflect.get(client, "readVerdict") as ReadVerdict;
    const res = {
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: '{"outcome":"other","subject":{}}',
      utf8: true,
    };

    expect(() =>
      readVerdict.call(client, "PUT", "things/1", res, {
        verdict: "a thing result",
        outcomes: ["done"],
        member: "subject",
      }),
    ).toThrow(
      "API PUT /v1/things/1 answered 200 with a thing result whose `outcome` is not `done`",
    );
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
    [
      "saveAssistantMethodExample",
      (client) => client.saveAssistantMethodExample("mt_x@3", { name: "n", inputs: {} }),
    ],
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
