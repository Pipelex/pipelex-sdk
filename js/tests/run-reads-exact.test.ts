/**
 * The run reads that carry a person's data keep an integer past `Number.MAX_SAFE_INTEGER` exact:
 * `getRunDetail`'s inputs, `getRunResult`'s outputs and working memory, and the blocking
 * `execute`'s, each read as a `bigint` holding its digits and sent back digit for digit, whether
 * to `start` or as an example's inputs. The status read and the run history carry none of that
 * data, and read as `JSON.parse` reads them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printResult } from "../src/cli/present.js";
import { PipelexApiClient } from "../src/client.js";
import { stringifyExactJson } from "../src/exact-json.js";

const BASE_URL = "http://localhost:8081";
const METHOD_ID = "mt_receipts01";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

/** A JSON answer whose body is the text given, spelled as the server spelled it. */
function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function jsonResponse(status: number, body: unknown): Response {
  return textResponse(status, JSON.stringify(body));
}

/** The body of the fetch call at `index`, as the text the client sent. */
function sentBody(spy: ReturnType<typeof vi.spyOn>, index: number): string {
  const [, init] = spy.mock.calls[index] as [string, RequestInit];
  return String(init.body);
}

/** Inputs holding integers past the safe range beside an ordinary integer and a float. */
const BIG_INPUTS_TEXT =
  '{"total":3,"big":12345678901234567891,"nested":{"list":[-98765432109876543210]},"rate":3.5}';

/** A run's record as the platform serializes it, its inputs `BIG_INPUTS_TEXT`. */
const RUN_DETAIL_TEXT =
  '{"pipeline_run_id":"run_7","method_id":"mt_receipts01","pipe_code":"main",' +
  '"status":"COMPLETED","created_at":"2026-10-13T09:00:00+00:00",' +
  `"mthds_contents":["domain = \\"receipts\\""],"inputs":${BIG_INPUTS_TEXT},"error":null}`;

/** A stuff whose content holds an integer past the safe range, as a run's output carries it. */
const BIG_STUFF_TEXT = '{"concept":"native.Number","content":{"number":12345678901234567891}}';

/** An example as the platform answers a create, for the second request of a round trip. */
const EXAMPLE = {
  example_id: "ex_1",
  method_id: METHOD_ID,
  name: "From run_7",
  inputs: { total: 3 },
  input_revision: 1,
  latest_run_id: "run_7",
  created_by_user_id: "user_1",
  created_at: "2026-10-13T09:00:00+00:00",
  updated_at: "2026-10-13T09:00:00+00:00",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getRunDetail", () => {
  it("reads a run's inputs exactly, an integer past the safe range as a bigint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(200, RUN_DETAIL_TEXT));

    const run = await makeClient().getRunDetail("run_7");

    expect(run.inputs?.big).toBe(12345678901234567891n);
    expect(run.inputs?.nested).toEqual({ list: [-98765432109876543210n] });
    expect(run.inputs?.total).toBe(3);
    expect(run.inputs?.rate).toBe(3.5);
    expect(stringifyExactJson(run.inputs)).toBe(BIG_INPUTS_TEXT);
  });

  it("hands a run's inputs to createMethodExample digit for digit", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(textResponse(200, RUN_DETAIL_TEXT))
      .mockResolvedValueOnce(jsonResponse(201, EXAMPLE));
    const client = makeClient();

    const run = await client.getRunDetail("run_7");
    await client.createMethodExample(METHOD_ID, {
      name: "From run_7",
      inputs: run.inputs ?? {},
      run_id: run.pipeline_run_id,
    });

    expect(sentBody(spy, 1)).toBe(
      `{"name":"From run_7","inputs":${BIG_INPUTS_TEXT},"run_id":"run_7"}`,
    );
  });

  it("hands a run's inputs to start digit for digit, so a rerun runs what the run ran", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(textResponse(200, RUN_DETAIL_TEXT))
      .mockResolvedValueOnce(jsonResponse(202, { pipeline_run_id: "run_8" }));
    const client = makeClient();

    const run = await client.getRunDetail("run_7");
    await client.start({ method_id: METHOD_ID, inputs: run.inputs ?? undefined });

    expect(sentBody(spy, 1)).toContain(`"inputs":${BIG_INPUTS_TEXT}`);
  });
});

describe("getRunResult", () => {
  const RESULT_TEXT =
    '{"pipeline_run_id":"run_7","main_stuff":{"number":12345678901234567891},' +
    `"working_memory":{"root":{"total":${BIG_STUFF_TEXT}},"aliases":{}},` +
    '"graph_spec":{"nodes":[]},"tokens_usages":[]}';

  it("reads the output and the working memory exactly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse(200, RESULT_TEXT));

    const state = await makeClient().getRunResult("run_7");

    expect(state.state).toBe("completed");
    if (state.state !== "completed") return;
    expect(state.result.main_stuff).toEqual({ number: 12345678901234567891n });
    expect(state.result.working_memory?.root.total?.content).toEqual({
      number: 12345678901234567891n,
    });
  });

  it("hands an output read back to start digit for digit", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(textResponse(200, RESULT_TEXT))
      .mockResolvedValueOnce(jsonResponse(202, { pipeline_run_id: "run_8" }));
    const client = makeClient();

    const result = await client.waitForResult("run_7");
    await client.start({ method_id: METHOD_ID, inputs: { total: result.main_stuff } });

    expect(sentBody(spy, 1)).toContain('"inputs":{"total":{"number":12345678901234567891}}');
  });
});

describe("execute", () => {
  it("reads the working memory and the main output exactly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse(
        200,
        '{"pipeline_run_id":"run_7","main_stuff_name":"total","pipe_output":' +
          `{"pipeline_run_id":"run_7","working_memory":{"root":{"total":${BIG_STUFF_TEXT}},` +
          '"aliases":{}}}}',
      ),
    );

    const result = await makeClient().execute({ pipe_code: "main" });

    expect(result.main_stuff).toEqual({ number: 12345678901234567891n });
  });
});

describe("the command's result", () => {
  it("prints an output read exactly with its digits, where JSON.stringify would throw", () => {
    let stdout = "";
    printResult(
      { number: 12345678901234567891n, rate: 3.5 },
      {
        env: {},
        readStdin: () => Promise.resolve(new Uint8Array()),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: () => undefined,
        interrupt: new AbortController().signal,
      },
    );

    expect(stdout).toBe('{\n  "number": 12345678901234567891,\n  "rate": 3.5\n}\n');
  });
});
