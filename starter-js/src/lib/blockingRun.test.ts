import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  MissingMainStuffError,
  type RunResults,
} from "@pipelex/sdk";

const execute = vi.fn();
const resolveStorageUrls = vi.fn();

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ execute, resolveStorageUrls }),
}));

import { executeBlockingRun } from "./blockingRun";
import { BadImageOutputError, BadPipelineOutputError } from "@/types/pipelineError";

beforeEach(() => {
  execute.mockReset();
  resolveStorageUrls.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const OPTIONS = {
  pipe_code: "extract_entities",
  contents: { "main.mthds": "BUNDLE" },
  inputs: { text: "x" },
};

// Inline fixture narrowers, so the shared-helper tests import no removable
// example's adapter (the examples stay deletable without touching this file).
// They honor the real `parseXxx` contract: read `main_stuff`, throw a tagged
// error on shape mismatch.
type FixtureOutput = { items: string[] };

function parseFixture(results: RunResults): FixtureOutput {
  const stuff = results.main_stuff;
  if (typeof stuff !== "object" || stuff === null || !("items" in stuff)) {
    throw new BadPipelineOutputError("fixture output is missing `items`");
  }
  return stuff as FixtureOutput;
}

function parseImageFixture(results: RunResults): { url: string } {
  const stuff = results.main_stuff;
  if (typeof stuff !== "object" || stuff === null || !("url" in stuff)) {
    throw new BadImageOutputError("fixture image output has no url");
  }
  return stuff as { url: string };
}

/** A stored text's reference, as the runtime answers a `Text` value past its inline threshold. */
function storedReference(url: string): Record<string, unknown> {
  return { url, size: 4096, mime_type: "text/plain", preview: "The start…" };
}

/**
 * An execute answer whose main stuff is a `native.Text` held by reference, its
 * working memory naming the concept, as the hosted runner answers a long text.
 */
function storedTextAnswer(runId: string, mainStuff: unknown): Record<string, unknown> {
  return {
    pipeline_run_id: runId,
    main_stuff: mainStuff,
    pipe_output: {
      pipeline_run_id: runId,
      working_memory: {
        root: { essay: { concept: "native.Text", content: mainStuff } },
        aliases: { main_stuff: "essay" },
      },
    },
  };
}

function parseTextFixture(results: RunResults): { text: string } {
  const stuff = results.main_stuff as { text?: unknown } | null;
  if (typeof stuff !== "object" || stuff === null || typeof stuff.text !== "string") {
    throw new BadPipelineOutputError("fixture text output has no `text`");
  }
  return { text: stuff.text };
}

describe("executeBlockingRun", () => {
  it("calls execute with the built options, adapts the response to RunResults, and narrows it", async () => {
    // `execute` returns a PipelexExecuteResult whose `.main_stuff` the SDK has already
    // resolved out of the working memory — the blocking path reads it like the durable one.
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-1",
      main_stuff: { items: ["Ada"] },
      // The runner always sends `pipe_output`; an empty one is the faithful
      // stand-in for a response that carried no extension fields.
      pipe_output: {},
    });

    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);

    expect(execute).toHaveBeenCalledWith(OPTIONS);
    // Nothing on `pipe_output` → the usage pair is absent → "unavailable".
    expect(result).toEqual({
      ok: true,
      output: { items: ["Ada"] },
      runId: "run-1",
      usage: {
        calls: [],
        totalCostUsd: null,
        hasCost: false,
        state: "unavailable",
        assemblyError: null,
      },
    });
  });

  it("lifts tokens_usages off the execute response's pipe_output into the usage report", async () => {
    // On the blocking path the usage pair rides the extension-open `pipe_output`;
    // the adapter lifts it onto RunResults so `buildUsageReport` reads it like durable.
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-1",
      main_stuff: { items: ["Ada"] },
      pipe_output: {
        pipeline_run_id: "run-1",
        working_memory: { root: {}, aliases: {} },
        tokens_usages: [
          {
            inference_model_name: "gpt-4o",
            pipe_code: "extract_entities",
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
      // The gateway's own 502 carries no problem document, and `execute` may
      // have started the run, which is how the SDK's client raises it.
      new ApiResponseError(
        "API POST /v1/execute failed (502)",
        "https://api.pipelex.com",
        502,
        "Bad Gateway",
        "<html>Bad Gateway</html>",
        { mayStartRun: true },
      ),
    );
    const result = await executeBlockingRun(async () => OPTIONS, parseFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("execute_timeout");
  });

  it("classifies a narrower throw (image content with no URL) as bad_image_output", async () => {
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-1",
      main_stuff: { caption: "no url" },
      pipe_output: {},
    });
    const result = await executeBlockingRun(async () => OPTIONS, parseImageFixture);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_image_output");
  });

  it("loads a stored text of the result before the narrower reads it, as a durable read does", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    execute.mockResolvedValueOnce(
      storedTextAnswer("run-4", storedReference("data:text/plain;charset=utf-8,A%20long%20essay")),
    );

    const result = await executeBlockingRun(async () => OPTIONS, parseTextFixture);

    expect(result).toMatchObject({ ok: true, output: { text: "A long essay" }, runId: "run-4" });
    // A data: URL is decoded where it is, so nothing is resolved.
    expect(resolveStorageUrls).not.toHaveBeenCalled();
  });

  it("loads a stored text inside a plural output's items envelope", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    execute.mockResolvedValueOnce(
      storedTextAnswer("run-5", {
        items: [{ text: "short" }, storedReference("data:text/plain;charset=utf-8,long%20one")],
      }),
    );

    const result = await executeBlockingRun(
      async () => OPTIONS,
      (results) => results.main_stuff,
    );

    expect(result).toMatchObject({
      ok: true,
      output: { items: [{ text: "short" }, { text: "long one" }] },
    });
  });

  it("presents a stored text that failed to load as a finished run's unloadable result, keeping its id", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    execute.mockResolvedValueOnce(
      storedTextAnswer(
        "run-6",
        storedReference("pipelex-storage://org/runs/run-6/generated/ab/value.txt"),
      ),
    );
    // The resolve route out of reach: its problem is `client.unreachable`,
    // which must not be told as the API out of reach or as the ~30s cap.
    resolveStorageUrls.mockRejectedValueOnce(
      new ApiUnreachableError("unreachable", "https://api.pipelex.com", "ECONNRESET"),
    );

    const result = await executeBlockingRun(async () => OPTIONS, parseTextFixture);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.runId).toBe("run-6");
    expect(result.error.kind).toBe("result_not_loaded");
    expect(result.error.title).toBe("The run finished, but its result could not be loaded");
    expect(result.error.hint?.summary).toMatch(/run the method again/);
    expect(result.error.details).toContain("reason: resolve_failed");
  });

  it("fails at once on a result that cannot say which of its values are texts", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // No working memory names the main stuff, so nothing tells a stored text
    // from any other value; a blocking answer is whole, so this is final.
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-7",
      main_stuff: storedReference("pipelex-storage://org/runs/run-7/generated/ab/value.txt"),
      pipe_output: { pipeline_run_id: "run-7", working_memory: { root: {}, aliases: {} } },
    });

    const result = await executeBlockingRun(async () => OPTIONS, parseTextFixture);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(resolveStorageUrls).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      runId: "run-7",
      error: { kind: "result_not_loaded" },
    });
    if (result.ok) return;
    expect(result.error.details).toContain("reason: concepts_missing");
  });
});
