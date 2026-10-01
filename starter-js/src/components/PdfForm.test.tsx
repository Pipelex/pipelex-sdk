import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PdfForm } from "./PdfForm";
import {
  pollSummarizePdfRun,
  requestSummarizePdfUpload,
  runSummarizePdfBlocking,
  startSummarizePdfRun,
} from "@/actions/runSummarizePdfPipeline";
import type { UploadRequest } from "@/lib/fileInputs";

vi.mock("@/actions/runSummarizePdfPipeline", () => ({
  runSummarizePdfBlocking: vi.fn(),
  startSummarizePdfRun: vi.fn(),
  pollSummarizePdfRun: vi.fn(),
  requestSummarizePdfUpload: vi.fn(),
}));

const uploadWithGrant = vi.fn();
vi.mock("@pipelex/sdk/upload", () => ({
  uploadWithGrant: (...args: unknown[]) => uploadWithGrant(...args),
}));

const blocking = vi.mocked(runSummarizePdfBlocking);
const start = vi.mocked(startSummarizePdfRun);
const poll = vi.mocked(pollSummarizePdfRun);
const requestUpload = vi.mocked(requestSummarizePdfUpload);

/** Where the stand-in storage puts a file: one reference per filename. */
const storedUri = (filename: string) => `pipelex-storage://org_1/uploads/${filename}`;

beforeEach(() => {
  blocking.mockReset();
  start.mockReset();
  poll.mockReset();
  // Every drop is granted and stored unless a test says otherwise: the grant
  // names the reference, and the stand-in storage answers with it.
  requestUpload.mockReset().mockImplementation(async (request: UploadRequest) => ({
    ok: true,
    grant: {
      url: `https://storage.example/${request.filename}`,
      headers: { "Content-Type": request.content_type },
      uri: storedUri(request.filename),
      expires_at: "2026-09-24T12:00:00Z",
      max_bytes: 52_428_800,
    },
  }));
  uploadWithGrant.mockReset().mockImplementation(async (grant: { uri: string }) => ({
    uri: grant.uri,
  }));
});

const USAGE = {
  calls: [
    {
      modelName: "gpt-4o",
      modelType: "llm",
      pipeCode: "summarize_pdf",
      tokensByCategory: { input: 3400, output: 210 },
      costUsd: 0.012,
    },
  ],
  totalCostUsd: 0.012,
  hasCost: true,
  state: "records" as const,
  assemblyError: null,
};

function pdfFile(name = "doc.pdf", type = "application/pdf") {
  return new File(["%PDF-1.4 fake pdf bytes"], name, { type });
}

/**
 * The kernel's `DocumentField` links its field label to the `<input
 * type="file">` itself — the tab stop lives on the input, with the focus ring
 * drawn on the dropzone through `focus-within` — so the accessible query
 * reaches the same element a real drop or browse would deliver the file to.
 */
function fileInput(): HTMLInputElement {
  return screen.getByLabelText("Document");
}

async function selectFile(file: File) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
  // The grant request and the upload are async; the submit button enables once
  // storage has the file and the form holds its reference.
  await waitFor(() => expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeEnabled());
}

/** The document input's value, as the action received it. */
function documentArg(call: [Record<string, unknown>]): { url?: string; filename?: string } {
  return call[0].document as { url?: string; filename?: string };
}

/** A durable run that completes on the first poll (no setTimeout gap to bridge). */
function durableCompletes(summary: { title: string; doc_type: string; key_points: string[] }) {
  start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
  poll.mockResolvedValueOnce({ ok: true, state: "completed", output: summary, usage: USAGE });
}

describe("PdfForm", () => {
  it("renders the file input the method's contract declares", () => {
    render(<PdfForm />);
    // `document` in the bundle → "Document" through the kernel's `app`
    // presentation, rendered as a dropzone because the concept is a file one.
    expect(screen.getByText("Document")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeDisabled();
  });

  it("stores a dropped PDF, runs on its reference and renders the summary (durable)", async () => {
    durableCompletes({ title: "Invoice", doc_type: "invoice", key_points: ["Total $1,728"] });

    render(<PdfForm />);
    const file = pdfFile();
    await selectFile(file);
    // Only the file's description crosses to the server, never its bytes.
    expect(requestUpload).toHaveBeenCalledWith({
      filename: "doc.pdf",
      content_type: "application/pdf",
      size: file.size,
    });
    fireEvent.click(screen.getByRole("button", { name: /summarize pdf/i }));

    expect(await screen.findByText("Invoice")).toBeInTheDocument();
    // The action receives the kernel's `FileValue` in schema shape — the stored
    // file's reference and its filename, never a `File` and never its bytes.
    expect(documentArg(start.mock.calls[0])).toEqual({
      url: storedUri("doc.pdf"),
      filename: "doc.pdf",
    });
    // The finished run keeps its id on screen, under the result.
    expect(screen.getByText("run-1")).toBeInTheDocument();
  });

  it("rejects an oversized file before asking for a grant", async () => {
    render(<PdfForm />);
    const huge = pdfFile("huge.pdf");
    // `File.size` is read-only; stand in for a 51 MB file (the cap is 50 MB).
    Object.defineProperty(huge, "size", { value: 51 * 1024 * 1024 });
    fireEvent.change(fileInput(), { target: { files: [huge] } });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("File too large")).toBeInTheDocument();
    expect(requestUpload).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(blocking).not.toHaveBeenCalled();
  });

  it("shows a refused grant beside the field, and starts no run", async () => {
    requestUpload.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "upload_unavailable",
        title: "File upload isn't available on this API",
        message: "https://api.example.test doesn't serve upload grants.",
        details: "ApiResponseError: HTTP 404",
      },
    });
    render(<PdfForm />);
    fireEvent.change(fileInput(), { target: { files: [pdfFile()] } });

    expect(await screen.findByText("File upload isn't available on this API")).toBeInTheDocument();
    expect(uploadWithGrant).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeDisabled();
  });

  it("clears a rejection once the user fixes the input by pasting a URL", async () => {
    render(<PdfForm />);
    const huge = pdfFile("huge.pdf");
    Object.defineProperty(huge, "size", { value: 51 * 1024 * 1024 });
    fireEvent.change(fileInput(), { target: { files: [huge] } });
    expect(await screen.findByText("File too large")).toBeInTheDocument();

    // "paste a URL instead" writes straight through `onValuesChange`, never
    // touching the handler that set the error — so the alert outlives the value
    // that caused it unless the setter clears it.
    fireEvent.click(screen.getByRole("button", { name: /paste a url instead/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /link to the file/i }), {
      target: { value: "https://example.com/ok.pdf" },
    });

    await waitFor(() => expect(screen.queryByText("File too large")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeEnabled();
  });

  it("drops the previous PDF when its replacement is rejected", async () => {
    render(<PdfForm />);
    await selectFile(pdfFile("first.pdf"));

    // Once a file is chosen the kernel renders a file chip and hides the drop
    // zone, so the one way to select a replacement is this form's own shortcut.
    // Have storage's authority refuse the sample: the replacement is rejected,
    // and the point is that the *first* PDF must not survive as a submittable
    // value.
    requestUpload.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "file_too_large",
        title: "File too large",
        message: "The file is past the size limit of Pipelex storage.",
        details: "ApiResponseError: HTTP 413",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        blob: async () => new Blob(["%PDF-1.4 sample"], { type: "application/pdf" }),
      }),
    );
    try {
      fireEvent.click(screen.getByRole("button", { name: /use sample pdf/i }));
      expect(await screen.findByText("File too large")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeDisabled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("locks the field while the sample PDF is still downloading", async () => {
    let release!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      ),
    );
    try {
      render(<PdfForm />);
      fireEvent.click(screen.getByRole("button", { name: /use sample pdf/i }));

      // Still downloading: every door into the field is shut, so a PDF picked
      // meanwhile cannot be silently overwritten when this older request lands.
      expect(await screen.findByText("Uploading…")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /use sample pdf/i })).toBeDisabled();
      // react-dropzone disables by no-op'ing its handler, not by setting the
      // `disabled` attribute — so the check is that the change does nothing.
      // `handleDropFile` is async, so it has to be given the chance to run:
      // asserting straight after the event passes whether or not the drop was
      // refused, which is what made this case vacuous before.
      fireEvent.change(fileInput(), { target: { files: [pdfFile("mine.pdf")] } });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      // An accepted drop renders its filename in the kernel's file chip, and
      // its `finally` would have emptied `uploadingIds` and re-enabled submit.
      expect(screen.queryByText(/mine\.pdf/)).not.toBeInTheDocument();
      // The third door: the kernel's `uploadingIds` shuts the "paste a URL
      // instead" toggle and its input too, not only the dropzone — the form
      // passes plain run state as `disabled` and relies on that. Left open, a
      // URL pasted here makes the form ready mid-fetch — and the run it starts
      // is abandoned client-side when the fetch lands and calls `reset()`.
      expect(screen.getByRole("button", { name: /paste a url instead/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeDisabled();

      release({
        ok: true,
        blob: async () => new Blob(["%PDF-1.4 sample"], { type: "application/pdf" }),
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeEnabled(),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settles a pasted storage URL's preview instead of spinning forever", async () => {
    // A `pipelex-storage://…` reference pasted through "paste a URL instead" is
    // one the control holds no local copy of and cannot paint, and this form
    // passes no `resolveUrl` to exchange it for one it can. So nothing is painted,
    // and the preview settles on the kernel's placeholder. Kernel 0.10.0 showed a
    // spinner forever here unless a resolver was passed, which is what this pins
    // against.
    render(<PdfForm />);
    fireEvent.click(screen.getByRole("button", { name: /paste a url instead/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /link to the file/i }), {
      target: { value: "pipelex-storage://bucket/invoice.pdf" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeEnabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    // The spinner is pending until a resolution lands for this URI, so its
    // absence, with the placeholder in its place, is the resolver having answered.
    await waitFor(() => expect(document.querySelector(".lucide-image-off")).not.toBeNull());
    expect(document.querySelector(".animate-spin")).toBeNull();
    // Nothing is painted from a scheme the browser cannot fetch.
    expect(document.querySelector("object, iframe")).toBeNull();
    expect(document.querySelector('img[src^="pipelex-storage:"]')).toBeNull();
  });

  it("renders the structured error when a poll returns ok:false", async () => {
    start.mockResolvedValueOnce({ ok: true, runId: "run-1" });
    poll.mockResolvedValueOnce({
      ok: false,
      transient: false,
      error: {
        kind: "auth_missing",
        title: "Pipelex API key missing",
        message: "no key configured",
        details: "ApiResponseError: HTTP 401",
      },
    });

    render(<PdfForm />);
    await selectFile(pdfFile());
    fireEvent.click(screen.getByRole("button", { name: /summarize pdf/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Pipelex API key missing")).toBeInTheDocument();
  });

  it("surfaces a transport_error when the awaited blocking action rejects", async () => {
    blocking.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<PdfForm />);
    await selectFile(pdfFile());
    fireEvent.click(screen.getByRole("radio", { name: "Blocking" }));
    fireEvent.click(screen.getByRole("button", { name: /summarize pdf/i }));

    expect(await screen.findByText(/Could not reach the server/i)).toBeInTheDocument();
  });

  it("clears a prior summary when the sample-PDF fetch fails", async () => {
    durableCompletes({ title: "Invoice", doc_type: "invoice", key_points: ["Total $1,728"] });

    render(<PdfForm />);
    await selectFile(pdfFile());
    fireEvent.click(screen.getByRole("button", { name: /summarize pdf/i }));
    expect(await screen.findByText("Invoice")).toBeInTheDocument();

    // The sample fetch now fails — the stale summary must not linger beside the
    // new error (regression: clearing used to run only on the success path).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")));
    try {
      fireEvent.click(screen.getByRole("button", { name: /use sample pdf/i }));
      expect(await screen.findByText(/Could not reach the server/i)).toBeInTheDocument();
      expect(screen.queryByText("Invoice")).not.toBeInTheDocument();
      // The replacement was requested before the fetch could fail, so the PDF it
      // was replacing must not still be sitting there submittable.
      expect(screen.getByRole("button", { name: /summarize pdf/i })).toBeDisabled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("accepts a .pdf when the browser reports an empty MIME type", async () => {
    durableCompletes({ title: "Invoice", doc_type: "invoice", key_points: [] });

    render(<PdfForm />);
    await selectFile(pdfFile("report.pdf", ""));
    fireEvent.click(screen.getByRole("button", { name: /summarize pdf/i }));

    expect(await screen.findByText("Invoice")).toBeInTheDocument();
    // The empty MIME is normalized before the grant is asked for, so the grant
    // action's type gate accepts it and storage signs the upload as a PDF.
    expect(requestUpload).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "report.pdf", content_type: "application/pdf" }),
    );
  });
});
