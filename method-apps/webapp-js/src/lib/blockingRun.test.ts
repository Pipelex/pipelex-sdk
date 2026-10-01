import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  MissingMainStuffError,
  type RunResults,
} from "@pipelex/sdk";

const execute = vi.fn();

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ execute }),
}));

import { executeBlockingRun } from "./blockingRun";
import { BadPipelineOutputError } from "@/types/pipelineError";

beforeEach(() => execute.mockReset());
afterEach(() => vi.restoreAllMocks());

const OPTIONS = {
  pipe_code: "fixture_pipe",
  mthds_contents: ["BUNDLE"],
  inputs: { text: "x" },
};

// An inline fixture narrower, so the shared-helper tests import no method's
// adapter — the template ships no method, and a scaffolded one stays removable
// without touching this file. It honors the real `parseXxx` contract: read
// `main_stuff`, throw a tagged error on shape mismatch.
type FixtureOutput = { items: string[] };

function parseFixture(results: RunResults): FixtureOutput {
  const stuff = results.main_stuff;
  if (typeof stuff !== "object" || stuff === null || !("items" in stuff)) {
    throw new BadPipelineOutputError("fixture output is missing `items`");
  }
  return stuff as FixtureOutput;
}

describe("executeBlockingRun", () => {
  it("calls execute with the built options, adapts the response to RunResults, and narrows it", async () => {
    // `execute` returns a PipelexExecuteResult whose `.main_stuff` the SDK has already
    // resolved out of the working memory — the blocking path reads it like the durable one.
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-1",
      main_stuff: { items: ["Ada"] },
      pipe_output: { pipeline_run_id: "run-1", working_memory: { root: {}, aliases: {} } },
    });

    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);

    expect(execute).toHaveBeenCalledWith(OPTIONS);
    // No usage pair on `pipe_output` → "unavailable".
    expect(result).toEqual({
      ok: true,
      output: { items: ["Ada"] },
      runId: "run-1",
      usage: {
        state: "unavailable",
        calls: [],
        totalCostUsd: null,
        costPartial: false,
        assemblyError: null,
      },
    });
  });

  it("lifts tokens_usages off the execute response's pipe_output into the usage report", async () => {
    // On the blocking path the usage pair rides the extension-open `pipe_output`;
    // `resultsFromExecute` lifts it onto RunResults so `buildUsageReport` reads it like durable.
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-1",
      main_stuff: { items: ["Ada"] },
      pipe_output: {
        pipeline_run_id: "run-1",
        working_memory: { root: {}, aliases: {} },
        tokens_usages: [
          {
            inference_model_name: "gpt-4o",
            pipe_code: "fixture_pipe",
            nb_tokens_by_category: { input: 10, output: 5 },
            cost: 0.001,
          },
        ],
        usage_assembly_error: null,
      },
    });

    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.state).toBe("records");
    expect(result.usage.totalCostUsd).toBeCloseTo(0.001);
    expect(result.usage.calls[0].modelName).toBe("gpt-4o");
  });

  it("classifies a thrown SDK error", async () => {
    execute.mockRejectedValueOnce(
      new ApiUnreachableError("unreachable", "https://api.unreachable.example", "ECONNREFUSED"),
    );
    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_unreachable");
    // No run was made, so there is no id to carry.
    expect(result).not.toHaveProperty("runId");
  });

  it("keeps the id of a run that finished but whose output the narrower refused, and logs it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-2",
      main_stuff: { unexpected: true },
      pipe_output: { pipeline_run_id: "run-2", working_memory: { root: {}, aliases: {} } },
    });

    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);

    expect(result).toMatchObject({ ok: false, error: { kind: "bad_response" }, runId: "run-2" });
    expect(info).toHaveBeenCalledWith("[pipelex] run finished: run-2");
  });

  it("keeps the id of a run that finished with no locatable main stuff, and logs it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-3",
      get main_stuff(): never {
        throw new MissingMainStuffError(
          "Blocking run 'run-3' delivered no locatable main stuff",
          "run-3",
        );
      },
      pipe_output: { pipeline_run_id: "run-3", working_memory: { root: {}, aliases: {} } },
    });

    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);

    expect(result).toMatchObject({ ok: false, runId: "run-3" });
    expect(info).toHaveBeenCalledWith("[pipelex] run finished: run-3");
  });

  it("maps the gateway's 502 cap response to execute_timeout (the real blocking cap)", async () => {
    execute.mockRejectedValueOnce(
      new ApiResponseError(
        "API POST /v1/execute failed (502)",
        "https://api.pipelex.com",
        502,
        "Bad Gateway",
        "",
        undefined,
        "The runner did not complete the request (/execute).",
        undefined,
        undefined,
      ),
    );
    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("execute_timeout");
  });
});
