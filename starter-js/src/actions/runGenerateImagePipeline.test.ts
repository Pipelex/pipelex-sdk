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
  pollGenerateImageRun,
  runGenerateImageBlocking,
  startGenerateImageRun,
} from "./runGenerateImagePipeline";

const IMAGE_CONTENT = { url: "https://cdn.pipelex.com/x.png", mime_type: "image/png" };
const PARSED = { url: "https://cdn.pipelex.com/x.png", mime_type: "image/png" };

// Blocking execute returns a PipelexExecuteResult with the resolved `main_stuff`.
const BLOCKING_RESPONSE = {
  pipeline_run_id: "run-1",
  main_stuff: IMAGE_CONTENT,
  // The runner always sends `pipe_output`; the SDK's `resultsFromExecute` lifts
  // the extension fields off it, so a double stands in with an empty one.
  pipe_output: {},
};

// The schema-shaped data dict the form hands the action (`rjsfDataFromRunValues`):
// a `native.Text` input is `{ text }` in schema shape.
const DATA = { image_prompt: { text: "a red bicycle" } };
// What the kernel's gate puts on the wire — the runtime's explicit
// `{ concept, content }` envelope, built from the method's own contract.
const WIRE_INPUTS = {
  image_prompt: { concept: "native.Text", content: { text: "a red bicycle" } },
};

beforeEach(() => {
  execute.mockReset();
  start.mockReset();
  getRunStatus.mockReset();
  getRunResult.mockReset();
});

describe("runGenerateImageBlocking", () => {
  it("calls execute with the bundle, pipe code, and gated inputs; returns narrowed output", async () => {
    execute.mockResolvedValueOnce(BLOCKING_RESPONSE);
    const result = await runGenerateImageBlocking(DATA);
    expect(loadMethodBundles).toHaveBeenCalledWith("generate-image");
    expect(execute).toHaveBeenCalledWith({
      pipe_code: "generate_image.generate_image",
      mthds_contents: ["DUMMY_BUNDLE_TOML"],
      inputs: WIRE_INPUTS,
    });
    // `toMatchObject`: these tests assert delegation + narrowed output; the `usage`
    // sibling now on the outcome is covered in the helper/model tests.
    expect(result).toMatchObject({ ok: true, output: PARSED });
  });

  it("returns a bad_request error on missing input without calling the SDK", async () => {
    // The kernel gate runs server-side too: the browser's readiness check is the
    // Run button's UX, this is the trust boundary.
    const result = await runGenerateImageBlocking({});
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        kind: "bad_request",
        title: "Input required",
        details: expect.stringContaining("image_prompt"),
      }),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies a missing image URL as bad_image_output", async () => {
    execute.mockResolvedValueOnce({
      pipeline_run_id: "run-1",
      main_stuff: { caption: "no url" },
      pipe_output: {},
    });
    const result = await runGenerateImageBlocking(DATA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_image_output");
  });

  it("classifies SDK errors into a structured PipelineError", async () => {
    execute.mockRejectedValueOnce(
      new ApiUnreachableError("unreachable", "https://api.unreachable.example", "ECONNREFUSED"),
    );
    const result = await runGenerateImageBlocking(DATA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_unreachable");
  });
});

describe("startGenerateImageRun", () => {
  it("calls start with the bundle, pipe code, and gated inputs; returns the run id", async () => {
    start.mockResolvedValueOnce({ pipeline_run_id: "run-1" });
    const result = await startGenerateImageRun(DATA);
    expect(start).toHaveBeenCalledWith({
      pipe_code: "generate_image.generate_image",
      mthds_contents: ["DUMMY_BUNDLE_TOML"],
      inputs: WIRE_INPUTS,
    });
    expect(result).toEqual({ ok: true, runId: "run-1" });
  });

  it("returns a bad_request error on missing input without calling start", async () => {
    const result = await startGenerateImageRun({});
    expect(result.ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("pollGenerateImageRun", () => {
  it("narrows the completed durable result (main_stuff with non-web url + web public_url)", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "COMPLETED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "completed",
      pipeline_run_id: "run-1",
      result: {
        pipeline_run_id: "run-1",
        main_stuff: {
          url: "pipelex-storage://user/results/run/assets/x.png",
          public_url: "https://s3.us-west-2.amazonaws.com/bucket/x.png?X-Amz-Signature=abc",
          mime_type: "image/png",
        },
      },
    });
    const result = await pollGenerateImageRun("run-1");
    expect(result.ok).toBe(true);
    if (!result.ok || result.state !== "completed") return;
    expect(result.output.public_url).toContain("https://s3");
  });
});
