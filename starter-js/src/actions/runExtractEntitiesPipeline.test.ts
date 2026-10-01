import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiUnreachableError } from "@pipelex/sdk";

const execute = vi.fn();
const start = vi.fn();
const getRunStatus = vi.fn();
const getRunResult = vi.fn();

vi.mock("@/lib/loadBundle", () => ({
  loadMethodBundles: vi.fn().mockResolvedValue(["DUMMY_BUNDLE_TOML"]),
}));

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ execute, start, getRunStatus, getRunResult }),
}));

import { loadMethodBundles } from "@/lib/loadBundle";
import {
  pollExtractEntitiesRun,
  runExtractEntitiesBlocking,
  startExtractEntitiesRun,
} from "./runExtractEntitiesPipeline";

beforeEach(() => {
  execute.mockReset();
  start.mockReset();
  getRunStatus.mockReset();
  getRunResult.mockReset();
});

const ENTITIES = { people: ["Ada"], orgs: ["ACME"], dates: ["1843"] };

// The schema-shaped data dict the form hands the action (`rjsfDataFromRunValues`):
// a `native.Text` input is `{ text }` in schema shape.
const DATA = { text: { text: "entity text" } };
// What the kernel's gate puts on the wire — the runtime's explicit
// `{ concept, content }` envelope, built from the method's own contract.
const WIRE_INPUTS = { text: { concept: "native.Text", content: { text: "entity text" } } };

// Blocking execute returns a PipelexExecuteResult with the resolved `main_stuff`.
const BLOCKING_RESPONSE = {
  pipeline_run_id: "run-1",
  main_stuff: ENTITIES,
  // The runner always sends `pipe_output`; the SDK's `resultsFromExecute` lifts
  // the extension fields off it, so a double stands in with an empty one.
  pipe_output: {},
};
// Durable completed result returns the same bare `main_stuff` content.
const COMPLETED_RESULT = { pipeline_run_id: "run-1", main_stuff: ENTITIES };

describe("runExtractEntitiesBlocking", () => {
  it("calls execute with the bundle, pipe code, and gated inputs; returns narrowed output", async () => {
    execute.mockResolvedValueOnce(BLOCKING_RESPONSE);
    const result = await runExtractEntitiesBlocking(DATA);
    expect(loadMethodBundles).toHaveBeenCalledWith("extract-entities");
    expect(execute).toHaveBeenCalledWith({
      pipe_code: "extract_entities.extract_entities",
      mthds_contents: ["DUMMY_BUNDLE_TOML"],
      inputs: WIRE_INPUTS,
    });
    // `toMatchObject`: these tests assert delegation + narrowed output; the `usage`
    // sibling now on the outcome is covered in the helper/model tests.
    expect(result).toMatchObject({ ok: true, output: ENTITIES });
  });

  it("returns a bad_request error on missing input without calling the SDK", async () => {
    // The kernel gate runs server-side too: the browser's readiness check is the
    // Run button's UX, this is the trust boundary.
    const result = await runExtractEntitiesBlocking({});
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: "bad_request",
        title: "Input required",
        details: expect.stringContaining("text"),
      }),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies SDK errors into a structured PipelineError", async () => {
    execute.mockRejectedValueOnce(
      new ApiUnreachableError("unreachable", "https://api.unreachable.example", "ECONNREFUSED"),
    );
    const result = await runExtractEntitiesBlocking(DATA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_unreachable");
  });
});

describe("startExtractEntitiesRun", () => {
  it("calls start with the bundle, pipe code, and gated inputs; returns the run id", async () => {
    start.mockResolvedValueOnce({ pipeline_run_id: "run-1" });
    const result = await startExtractEntitiesRun(DATA);
    expect(start).toHaveBeenCalledWith({
      pipe_code: "extract_entities.extract_entities",
      mthds_contents: ["DUMMY_BUNDLE_TOML"],
      inputs: WIRE_INPUTS,
    });
    expect(result).toEqual({ ok: true, runId: "run-1" });
  });

  it("returns a bad_request error on missing input without calling start", async () => {
    const result = await startExtractEntitiesRun({});
    expect(result.ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("pollExtractEntitiesRun", () => {
  it("narrows the completed durable result (main_stuff)", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "COMPLETED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "completed",
      pipeline_run_id: "run-1",
      result: COMPLETED_RESULT,
    });
    const result = await pollExtractEntitiesRun("run-1");
    expect(getRunStatus).toHaveBeenCalledWith("run-1");
    expect(result).toMatchObject({ ok: true, state: "completed", output: ENTITIES });
  });

  it("reports running while the status is non-terminal", async () => {
    getRunStatus.mockResolvedValueOnce({
      status: "RUNNING",
      degraded: false,
      retry_after_seconds: null,
    });
    const result = await pollExtractEntitiesRun("run-1");
    expect(result).toMatchObject({ ok: true, state: "running", status: "RUNNING" });
    expect(getRunResult).not.toHaveBeenCalled();
  });
});
