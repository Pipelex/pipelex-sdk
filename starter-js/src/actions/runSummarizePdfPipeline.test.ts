import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiResponseError,
  ApiUnreachableError,
  UnsupportedUploadCapabilityError,
} from "@pipelex/sdk";

const execute = vi.fn();
const start = vi.fn();
const getRunStatus = vi.fn();
const getRunResult = vi.fn();
const prepareInputs = vi.fn();
const requestUploadGrant = vi.fn();

vi.mock("@/lib/loadBundle", () => ({
  loadMethodBundles: vi.fn().mockResolvedValue(["DUMMY_BUNDLE_TOML"]),
}));

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({
    execute,
    start,
    getRunStatus,
    getRunResult,
    prepareInputs,
    requestUploadGrant,
  }),
}));

import { loadMethodBundles } from "@/lib/loadBundle";
import {
  pollSummarizePdfRun,
  requestSummarizePdfUpload,
  runSummarizePdfBlocking,
  startSummarizePdfRun,
} from "./runSummarizePdfPipeline";

// What the form's value holds once the browser has stored the dropped PDF with
// a grant: its `pipelex-storage://` reference, never its bytes.
const STORED_PDF = "pipelex-storage://org-1/uploads/invoice.pdf";
const SUMMARY = { title: "Invoice", doc_type: "invoice", key_points: ["Total $1,728"] };
const PARSED = { title: "Invoice", doc_type: "invoice", key_points: ["Total $1,728"] };

// Blocking execute returns a PipelexExecuteResult with the resolved `main_stuff`.
const BLOCKING_RESPONSE = {
  pipeline_run_id: "run-1",
  main_stuff: SUMMARY,
  // The runner always sends `pipe_output`; the SDK's `resultsFromExecute` lifts
  // the extension fields off it, so a double stands in with an empty one.
  pipe_output: {},
};

// What `prepareInputs` returns for a stored reference: the input shaped as the
// run expects it, with the reference passed through and nothing uploaded.
const PREPARED_INPUTS = { document: { url: STORED_PDF } };
const PREPARED = { inputs: PREPARED_INPUTS, uploads: [] };

// The schema-shaped data dict the form hands the action: a `native.Document`
// input is `{url, filename}` in schema shape (the kernel's `FileValue`).
const DATA = { document: { url: STORED_PDF, filename: "invoice.pdf" } };

// What the kernel's gate puts on the wire, and hands straight to prepareInputs:
// the explicit `{concept, content}` envelope. `prepareInputs` interprets its
// `content` exactly as it would a bare value, classifies it as a file from the
// method's declared `document = Document` signature, and preserves the envelope
// on output — verified live. The qualified `pipe_ref` is stated rather than
// left to `main_pipe`; a bare pipe code is refused.
const PREPARE_CALL = {
  files: [{ content: "DUMMY_BUNDLE_TOML" }],
  pipe_ref: "summarize_pdf.summarize_pdf",
  inputs: {
    document: {
      concept: "native.Document",
      content: { url: STORED_PDF, filename: "invoice.pdf" },
    },
  },
};

beforeEach(() => {
  execute.mockReset();
  start.mockReset();
  getRunStatus.mockReset();
  getRunResult.mockReset();
  prepareInputs.mockReset();
  requestUploadGrant.mockReset();
});

describe("runSummarizePdfBlocking", () => {
  it("prepares inputs, then calls execute with the prepared inputs", async () => {
    prepareInputs.mockResolvedValueOnce(PREPARED);
    execute.mockResolvedValueOnce(BLOCKING_RESPONSE);
    const result = await runSummarizePdfBlocking(DATA);
    expect(loadMethodBundles).toHaveBeenCalledWith("summarize-pdf");
    expect(prepareInputs).toHaveBeenCalledWith(PREPARE_CALL);
    expect(execute).toHaveBeenCalledWith({
      pipe_code: "summarize_pdf.summarize_pdf",
      mthds_contents: ["DUMMY_BUNDLE_TOML"],
      inputs: PREPARED_INPUTS,
    });
    // `toMatchObject`: these tests assert delegation + narrowed output; the `usage`
    // sibling now on the outcome is covered in the helper/model tests.
    expect(result).toMatchObject({ ok: true, output: PARSED });
  });

  it("returns a bad_request error on missing input without preparing or running", async () => {
    const result = await runSummarizePdfBlocking({});
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ kind: "bad_request", title: "Input required" }),
    });
    expect(prepareInputs).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a PDF sent inline as a data URL, before preparing", async () => {
    // Nothing in the app sends a file inline any more: the browser stores it
    // first. A run body carrying bytes is what outgrew the Server Action limit,
    // so the file gate refuses the route rather than size-checks it.
    const result = await runSummarizePdfBlocking({
      document: { url: "data:application/pdf;base64,JVBERi0xLjQK", filename: "invoice.pdf" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_request");
    expect(result.error.title).toBe("Unsupported file reference");
    expect(prepareInputs).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies a preparation failure (prepareInputs throws) into upload_failed, never running", async () => {
    prepareInputs.mockRejectedValueOnce(
      new UnsupportedUploadCapabilityError("no /v1/upload route"),
    );
    const result = await runSummarizePdfBlocking(DATA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("upload_failed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies SDK errors from execute into a structured PipelineError", async () => {
    prepareInputs.mockResolvedValueOnce(PREPARED);
    execute.mockRejectedValueOnce(
      new ApiUnreachableError("unreachable", "https://api.unreachable.example", "ECONNREFUSED"),
    );
    const result = await runSummarizePdfBlocking(DATA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("api_unreachable");
  });
});

describe("startSummarizePdfRun", () => {
  it("prepares inputs, then calls start with the rewritten inputs; returns the run id", async () => {
    prepareInputs.mockResolvedValueOnce(PREPARED);
    start.mockResolvedValueOnce({ pipeline_run_id: "run-1" });
    const result = await startSummarizePdfRun(DATA);
    expect(prepareInputs).toHaveBeenCalledWith(PREPARE_CALL);
    expect(start).toHaveBeenCalledWith({
      pipe_code: "summarize_pdf.summarize_pdf",
      mthds_contents: ["DUMMY_BUNDLE_TOML"],
      inputs: PREPARED_INPUTS,
    });
    expect(result).toEqual({ ok: true, runId: "run-1" });
  });

  it("re-runs the file gate: refuses a data URL without preparing or starting", async () => {
    const result = await startSummarizePdfRun({
      document: { url: "data:application/pdf;base64,JVBERi0xLjQK", filename: "invoice.pdf" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_request");
    expect(prepareInputs).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("requestSummarizePdfUpload", () => {
  // The grant action is a trust boundary of its own: a Server Action is a
  // public endpoint, so what the browser says about a file is checked before
  // the platform is asked for anything.
  const GRANT = {
    url: "https://storage.example/put",
    headers: { "Content-Type": "application/pdf" },
    uri: STORED_PDF,
    expires_at: "2026-09-24T12:00:00Z",
    max_bytes: 52_428_800,
  };

  it("asks the platform for a grant for a PDF, sending its name, type and size only", async () => {
    requestUploadGrant.mockResolvedValueOnce(GRANT);
    const result = await requestSummarizePdfUpload({
      filename: "invoice.pdf",
      content_type: "application/pdf",
      size: 36_000,
    });
    expect(requestUploadGrant).toHaveBeenCalledWith({
      filename: "invoice.pdf",
      content_type: "application/pdf",
      size: 36_000,
    });
    expect(result).toEqual({ ok: true, grant: GRANT });
  });

  it("refuses a type the method does not take before asking for a grant", async () => {
    const result = await requestSummarizePdfUpload({
      filename: "photo.png",
      content_type: "image/png",
      size: 12,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported_file_type" } });
    expect(requestUploadGrant).not.toHaveBeenCalled();
  });

  it("refuses a file past the size limit before asking for a grant", async () => {
    const result = await requestSummarizePdfUpload({
      filename: "huge.pdf",
      content_type: "application/pdf",
      size: 60 * 1024 * 1024,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "file_too_large" } });
    expect(requestUploadGrant).not.toHaveBeenCalled();
  });

  it("names the configured API when it serves no upload grants", async () => {
    requestUploadGrant.mockRejectedValueOnce(
      new ApiResponseError(
        "API POST /v1/upload/grant failed (404)",
        "https://api.example.test",
        404,
        "Not Found",
        "",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    );
    const result = await requestSummarizePdfUpload({
      filename: "invoice.pdf",
      content_type: "application/pdf",
      size: 36_000,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "upload_unavailable" } });
  });
});

describe("pollSummarizePdfRun", () => {
  it("narrows the completed durable result (main_stuff)", async () => {
    getRunStatus.mockResolvedValueOnce({ status: "COMPLETED", degraded: false });
    getRunResult.mockResolvedValueOnce({
      state: "completed",
      pipeline_run_id: "run-1",
      result: { pipeline_run_id: "run-1", main_stuff: SUMMARY },
    });
    const result = await pollSummarizePdfRun("run-1");
    expect(result).toMatchObject({ ok: true, state: "completed", output: PARSED });
  });
});

describe("the paste-a-URL escape hatch", () => {
  it("passes an https reference through the file gate untouched", async () => {
    // The kernel's file control offers "paste a URL instead", so a document
    // input can arrive as a reference nobody uploaded; resolving it is the
    // runner's job.
    prepareInputs.mockResolvedValueOnce(PREPARED);
    start.mockResolvedValueOnce({ pipeline_run_id: "run-1" });
    const result = await startSummarizePdfRun({
      document: { url: "https://example.com/invoice.pdf" },
    });
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(prepareInputs).toHaveBeenCalledWith({
      files: [{ content: "DUMMY_BUNDLE_TOML" }],
      pipe_ref: "summarize_pdf.summarize_pdf",
      inputs: {
        document: {
          concept: "native.Document",
          content: { url: "https://example.com/invoice.pdf" },
        },
      },
    });
  });

  it("passes a pipelex-storage reference through untouched", async () => {
    prepareInputs.mockResolvedValueOnce(PREPARED);
    start.mockResolvedValueOnce({ pipeline_run_id: "run-1" });
    const result = await startSummarizePdfRun({
      document: { url: "pipelex-storage://abc123" },
    });
    expect(result).toEqual({ ok: true, runId: "run-1" });
  });
});

describe("the file gate's accepted schemes", () => {
  // `prepareInputs` resolves any string it does not recognise as a *local
  // filesystem path*, reads it and uploads it (`@pipelex/sdk`'s
  // `prepare-inputs.js` → `readLocalPath`). These Server Actions are public
  // endpoints, so an unconstrained `url` is an arbitrary server-side file read
  // whose contents come back summarized to the caller. The accepted set is
  // closed; anything outside it must be refused before the SDK is touched.
  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a relative path", "../../.env.local"],
    ["a bare filename", "package.json"],
    ["a file:// URL", "file:///etc/hosts"],
    ["a cleartext http URL", "http://169.254.169.254/latest/meta-data/"],
    ["an inline data URL", "data:application/pdf;base64,JVBERi0xLjQK"],
  ])("refuses %s without reaching the SDK", async (_label, url) => {
    const result = await startSummarizePdfRun({ document: { url, filename: "invoice.pdf" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_request");
    expect(result.error.title).toBe("Unsupported file reference");
    expect(prepareInputs).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses on the blocking path too, not just the durable one", async () => {
    const result = await runSummarizePdfBlocking({ document: { url: "/etc/passwd" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("bad_request");
    expect(prepareInputs).not.toHaveBeenCalled();
  });
});
