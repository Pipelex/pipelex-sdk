import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { RejectedAssetError } from "@pipelex/sdk";
import type { GrantOutcome } from "@/lib/uploadGrant";

const uploadWithGrant = vi.fn();
vi.mock("@pipelex/sdk/upload", () => ({
  uploadWithGrant: (...args: unknown[]) => uploadWithGrant(...args),
}));

import { useFileInputs } from "./useFileInputs";

const GRANT = {
  uri: "pipelex-storage://org_1/assets/abc.jpg",
  url: "https://bucket.s3.amazonaws.com/org_1/assets/abc.jpg?X-Amz-Signature=sig",
  headers: { "Content-Type": "image/jpeg", "If-None-Match": "*" },
  expires_at: "2026-09-24T12:00:00Z",
  max_bytes: 52_428_800,
};

const requestUpload = vi.fn<(request: unknown) => Promise<GrantOutcome>>();

beforeEach(() => {
  uploadWithGrant.mockReset();
  requestUpload.mockReset();
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
    uploadWithGrant.mockResolvedValueOnce({ uri: GRANT.uri });
    const { hook, state, onSelectionStart } = setup();
    const file = receipt();

    await act(() => hook.result.current.dropFile("receipts.0", file));

    // Only the file's description crosses to the server, never its bytes.
    expect(requestUpload).toHaveBeenCalledWith({
      filename: "receipt.jpg",
      content_type: "image/jpeg",
      size: file.size,
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
