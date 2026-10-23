import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError } from "@pipelex/sdk";

const requestUploadGrant = vi.fn();

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ requestUploadGrant }),
}));

import { grantFileUpload } from "./uploadGrant";
import { MAX_FILE_BYTES } from "./fileInputs";

beforeEach(() => requestUploadGrant.mockReset());

const OPTS = { allowedMimes: ["image/png", "image/jpeg"], maxBytes: MAX_FILE_BYTES };
const REQUEST = { filename: "receipt.jpg", content_type: "image/jpeg", size: 2_500_000 };
/** A SHA-256 as `describeUpload` writes one: 64 lowercase hexadecimal digits. */
const SHA256 = "1b48e21282963dfba2ffff3a4c331471242fe42fd0a51161e56df72085c445c9";
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

/** The SDK's error for a product route answering `status`, as `requestProduct` builds it. */
function responseError(status: number, serverMessage?: string) {
  return new ApiResponseError(
    `API POST /v1/upload/grant failed (${status})`,
    "https://api.example.com",
    status,
    "",
    serverMessage ? JSON.stringify({ detail: serverMessage }) : "",
    undefined,
    serverMessage,
    undefined,
    undefined,
  );
}

describe("grantFileUpload", () => {
  it("asks for a grant with the file's name, type and size, and hands it back", async () => {
    requestUploadGrant.mockResolvedValueOnce(GRANT);
    const outcome = await grantFileUpload(REQUEST, OPTS);
    expect(requestUploadGrant).toHaveBeenCalledWith(REQUEST);
    // No digest was given, so none is sent, and the grant names a new object.
    expect(requestUploadGrant.mock.calls[0]?.[0]).not.toHaveProperty("sha256");
    expect(outcome).toEqual({ ok: true, grant: GRANT });
  });

  it("passes the file's SHA-256 through, and hands back the grant for bytes already held", async () => {
    requestUploadGrant.mockResolvedValueOnce(STORED_GRANT);
    const outcome = await grantFileUpload({ ...REQUEST, sha256: SHA256 }, OPTS);
    expect(requestUploadGrant).toHaveBeenCalledWith({ ...REQUEST, sha256: SHA256 });
    expect(outcome).toEqual({ ok: true, grant: STORED_GRANT });
  });

  it("asks with the file's description and nothing else the request carries", async () => {
    requestUploadGrant.mockResolvedValueOnce(GRANT);
    // A Server Action reads untrusted JSON: what an upload is recorded as is not the browser's to say.
    await grantFileUpload({ ...REQUEST, kind: "test", method_id: "mt_other" }, OPTS);
    expect(requestUploadGrant.mock.calls[0]?.[0]).toEqual(REQUEST);
  });

  it("refuses a malformed SHA-256 before asking for anything, naming the file", async () => {
    const outcome = await grantFileUpload({ ...REQUEST, sha256: "not-a-digest" }, OPTS);
    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "invalid_file", details: "invalid_file: receipt.jpg" },
    });
    expect(requestUploadGrant).not.toHaveBeenCalled();
  });

  it("refuses a type the method does not take before asking for anything", async () => {
    const outcome = await grantFileUpload({ ...REQUEST, content_type: "application/pdf" }, OPTS);
    expect(outcome).toMatchObject({ ok: false, error: { kind: "unsupported_file_type" } });
    expect(requestUploadGrant).not.toHaveBeenCalled();
  });

  it("refuses a file past the cap before asking for anything, naming the file", async () => {
    const outcome = await grantFileUpload({ ...REQUEST, size: MAX_FILE_BYTES + 1 }, OPTS);
    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "file_too_large", details: "file_too_large: receipt.jpg" },
    });
    expect(requestUploadGrant).not.toHaveBeenCalled();
  });

  it("refuses a request that is not one — a Server Action reads untrusted JSON", async () => {
    const outcome = await grantFileUpload("receipt.jpg", OPTS);
    expect(outcome.ok).toBe(false);
    expect(requestUploadGrant).not.toHaveBeenCalled();
  });

  it("names the API as the problem when it serves no upload grants", async () => {
    requestUploadGrant.mockRejectedValueOnce(responseError(404));
    const outcome = await grantFileUpload(REQUEST, OPTS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("upload_unavailable");
    expect(outcome.error.message).toContain("POST /v1/upload/grant");
    expect(outcome.error.message).toContain("PIPELEX_BASE_URL");
  });

  it("takes the platform's own word on a file too large", async () => {
    requestUploadGrant.mockRejectedValueOnce(
      responseError(413, "Declared file size exceeds the 50 MiB limit."),
    );
    const outcome = await grantFileUpload(REQUEST, OPTS);
    expect(outcome).toMatchObject({
      ok: false,
      error: { kind: "file_too_large", message: "Declared file size exceeds the 50 MiB limit." },
    });
  });

  it("classifies any other failure like every other SDK call", async () => {
    requestUploadGrant.mockRejectedValueOnce(responseError(401));
    const outcome = await grantFileUpload(REQUEST, OPTS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toMatch(/^auth_/);
  });
});
