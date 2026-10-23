import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { RejectedAssetError } from "@pipelex/sdk";
import type { GrantOutcome } from "@/lib/uploadGrant";

// The upload is stood in for, and the description is the SDK's own: the digest
// the hook sends is the one `describeUpload` computes from the file's bytes.
const uploadWithGrant = vi.fn();
vi.mock("@pipelex/sdk/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pipelex/sdk/upload")>()),
  uploadWithGrant: (...args: unknown[]) => uploadWithGrant(...args),
}));

import { useFileInputs } from "./useFileInputs";

const GRANT = {
  file_id: "fl_01920000-0000-7000-8000-000000000001",
  uri: "pipelex-storage://org_1/assets/abc.jpg",
  stored: false,
  url: "https://bucket.s3.amazonaws.com/org_1/assets/abc.jpg?X-Amz-Signature=sig",
  headers: { "Content-Type": "image/jpeg", "If-None-Match": "*" },
  expires_at: "2026-09-24T12:00:00Z",
  max_bytes: 52_428_800,
};
/** The answer for bytes the organization already holds: a reference, and nothing to send. */
const STORED_GRANT = {
  file_id: GRANT.file_id,
  uri: GRANT.uri,
  stored: true,
  url: null,
  headers: null,
  expires_at: null,
  max_bytes: 52_428_800,
};

/** The SHA-256 of `receipt()`'s bytes, "jpeg bytes". */
const RECEIPT_SHA256 = "1b48e21282963dfba2ffff3a4c331471242fe42fd0a51161e56df72085c445c9";

const requestUpload = vi.fn<(request: unknown) => Promise<GrantOutcome>>();

beforeEach(() => {
  uploadWithGrant.mockReset();
  requestUpload.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The hook over a plain values object, the way a form's `useRunInputs` holds one. */
function setup(maxBytes?: number, prepareFile?: (file: File) => File) {
  const state: { values: Record<string, unknown> } = {
    values: { receipts: [{ url: "pipelex-storage://org_1/assets/old.jpg", filename: "old.jpg" }] },
  };
  const setValues = (update: (current: Record<string, unknown>) => Record<string, unknown>) => {
    state.values = update(state.values);
  };
  const onSelectionStart = vi.fn();
  const hook = renderHook(() =>
    useFileInputs({ setValues, requestUpload, onSelectionStart, maxBytes, prepareFile }),
  );
  return { hook, state, onSelectionStart };
}

const receipt = () => new File(["jpeg bytes"], "receipt.jpg", { type: "image/jpeg" });
const firstReceipt = (values: Record<string, unknown>) =>
  (values.receipts as Record<string, unknown>[])[0];

describe("useFileInputs", () => {
  it("asks for a grant, sends the file to storage, then writes the reference", async () => {
    requestUpload.mockResolvedValueOnce({ ok: true, grant: GRANT });
    uploadWithGrant.mockResolvedValueOnce({ uri: GRANT.uri, file_id: GRANT.file_id });
    const { hook, state, onSelectionStart } = setup();
    const file = receipt();

    await act(() => hook.result.current.dropFile("receipts.0", file));

    // Only the file's description crosses to the server, never its bytes: its
    // name, type and size, and the SHA-256 the browser computed from them.
    expect(requestUpload).toHaveBeenCalledWith({
      filename: "receipt.jpg",
      content_type: "image/jpeg",
      size: file.size,
      sha256: RECEIPT_SHA256,
    });
    // No options: the SDK's own limit, which grows with the file's size, bounds it.
    expect(uploadWithGrant).toHaveBeenCalledWith(GRANT, file);
    expect(firstReceipt(state.values)).toEqual({ url: GRANT.uri, filename: "receipt.jpg" });
    expect(onSelectionStart).toHaveBeenCalledOnce();
    expect(hook.result.current.fileError).toBeNull();
    expect(hook.result.current.uploadingIds.size).toBe(0);
  });

  it("clears the old file before its first await, and holds the field busy until stored", async () => {
    let finishUpload: (value: { uri: string }) => void = () => {};
    requestUpload.mockResolvedValueOnce({ ok: true, grant: GRANT });
    uploadWithGrant.mockReturnValueOnce(new Promise((resolve) => (finishUpload = resolve)));
    const { hook, state } = setup();

    let dropping: Promise<void> = Promise.resolve();
    act(() => {
      dropping = hook.result.current.dropFile("receipts.0", receipt());
    });
    // The previous selection is gone at once, so nothing stale can be submitted.
    expect(firstReceipt(state.values)).toBeUndefined();
    expect(hook.result.current.uploadingIds.has("receipts.0")).toBe(true);

    // Between the grant and the stored file, the field stays shut and empty.
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.uploadingIds.has("receipts.0")).toBe(true);
    expect(firstReceipt(state.values)).toBeUndefined();

    await act(async () => {
      finishUpload({ uri: GRANT.uri });
      await dropping;
    });
    expect(firstReceipt(state.values)).toEqual({ url: GRANT.uri, filename: "receipt.jpg" });
    expect(hook.result.current.uploadingIds.size).toBe(0);
  });

  it("shows a refused grant and sends nothing to storage", async () => {
    const refusal = {
      kind: "unsupported_file_type" as const,
      title: "Unsupported file type",
      message: 'Unsupported file type "image/gif".',
      details: "unsupported_file_type: receipt.jpg",
    };
    requestUpload.mockResolvedValueOnce({ ok: false, error: refusal });
    const { hook, state } = setup();

    await act(() => hook.result.current.dropFile("receipts.0", receipt()));

    expect(hook.result.current.fileError).toEqual(refusal);
    expect(uploadWithGrant).not.toHaveBeenCalled();
    expect(firstReceipt(state.values)).toBeUndefined();
    expect(hook.result.current.uploadingIds.size).toBe(0);
  });

  it("shows what storage refused, and leaves the field empty", async () => {
    requestUpload.mockResolvedValueOnce({ ok: true, grant: GRANT });
    uploadWithGrant.mockRejectedValueOnce(
      new RejectedAssetError("refused", "receipt.jpg", 403, { code: "grant_expired" }),
    );
    const { hook, state } = setup();

    await act(() => hook.result.current.dropFile("receipts.0", receipt()));

    expect(hook.result.current.fileError).toMatchObject({
      kind: "upload_failed",
      title: "The upload's permission ran out",
    });
    expect(firstReceipt(state.values)).toBeUndefined();
  });

  it("writes the reference to bytes storage already holds, and sends nothing", async () => {
    // The SDK's own sender, over a `fetch` that must not be called.
    const actual =
      await vi.importActual<typeof import("@pipelex/sdk/upload")>("@pipelex/sdk/upload");
    const put = vi.fn();
    vi.stubGlobal("fetch", put);
    requestUpload.mockResolvedValueOnce({ ok: true, grant: STORED_GRANT });
    uploadWithGrant.mockImplementationOnce(actual.uploadWithGrant);
    const { hook, state } = setup();

    await act(() => hook.result.current.dropFile("receipts.0", receipt()));

    expect(requestUpload).toHaveBeenCalledWith(expect.objectContaining({ sha256: RECEIPT_SHA256 }));
    expect(put).not.toHaveBeenCalled();
    expect(firstReceipt(state.values)).toEqual({ url: GRANT.uri, filename: "receipt.jpg" });
    expect(hook.result.current.fileError).toBeNull();
    expect(hook.result.current.uploadingIds.size).toBe(0);
  });

  it("asks without the digest where the browser offers no Web Crypto", async () => {
    // A page served over plain `http` from a host other than the local one.
    vi.stubGlobal("crypto", {});
    requestUpload.mockResolvedValueOnce({ ok: true, grant: GRANT });
    uploadWithGrant.mockResolvedValueOnce({ uri: GRANT.uri, file_id: GRANT.file_id });
    const { hook, state } = setup();
    const file = receipt();

    await act(() => hook.result.current.dropFile("receipts.0", file));

    expect(requestUpload.mock.calls[0]?.[0]).toEqual({
      filename: "receipt.jpg",
      content_type: "image/jpeg",
      size: file.size,
    });
    expect(requestUpload.mock.calls[0]?.[0]).not.toHaveProperty("sha256");
    expect(firstReceipt(state.values)).toEqual({ url: GRANT.uri, filename: "receipt.jpg" });
  });

  it("shows a file that cannot be read as a preparation error, and asks for nothing", async () => {
    const file = receipt();
    // How a browser answers for a file changed on disk since it was picked.
    Object.defineProperty(file, "arrayBuffer", {
      value: () => Promise.reject(new DOMException("The file changed.", "NotReadableError")),
    });
    const { hook, state } = setup();

    await act(() => hook.result.current.dropFile("receipts.0", file));

    expect(hook.result.current.fileError).toMatchObject({
      kind: "upload_failed",
      title: "The file could not be prepared",
    });
    expect(requestUpload).not.toHaveBeenCalled();
    expect(firstReceipt(state.values)).toBeUndefined();
    expect(hook.result.current.uploadingIds.size).toBe(0);
  });

  it("refuses a file past the cap before asking for anything", async () => {
    const { hook, state } = setup(4);

    await act(() => hook.result.current.dropFile("receipts.0", receipt()));

    expect(hook.result.current.fileError).toMatchObject({ kind: "file_too_large" });
    expect(requestUpload).not.toHaveBeenCalled();
    expect(firstReceipt(state.values)).toBeUndefined();
  });

  it("shows a throwing prepareFile as a file error, and asks for nothing", async () => {
    const { hook, state } = setup(undefined, () => {
      throw new Error("cannot re-wrap");
    });

    await act(() => hook.result.current.dropFile("receipts.0", receipt()));

    expect(hook.result.current.fileError).toMatchObject({
      kind: "upload_failed",
      title: "The file could not be prepared",
      details: "Error: cannot re-wrap",
    });
    expect(requestUpload).not.toHaveBeenCalled();
    expect(firstReceipt(state.values)).toBeUndefined();
    expect(hook.result.current.uploadingIds.size).toBe(0);
  });

  it("reports a grant request that never reached the server as a transport error", async () => {
    requestUpload.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { hook } = setup();

    await act(() => hook.result.current.dropFile("receipts.0", receipt()));

    expect(hook.result.current.fileError).toMatchObject({ kind: "transport_error" });
  });
});
