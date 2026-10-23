/**
 * `uploadFile` — the single-asset upload convenience over the raw `upload()` wire
 * call. Pins: accepted asset forms (bytes everywhere, path Node-only), the
 * client-side record assembly (uri/filename/contentType/size), base64 correctness,
 * and the mapping of raw transport errors onto the semantic preparation errors.
 *
 * The function takes a client interface, so these inject a fake `upload` rather
 * than mocking fetch.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile } from "../src/upload.js";
import type { UploadCapableClient } from "../src/upload.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  InputPreparationError,
  InvalidLocalSourceError,
  RejectedAssetError,
  TestFileRefusedError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "../src/errors.js";
import type { UploadFileOptions } from "../src/upload.js";
import { problemDocument } from "./helpers/problems.js";

interface Captured {
  filename: string;
  data: string;
  content_type: string;
}

/** A fake client that records the wire body and returns a canned URI. */
function capturingClient(uri = "pipelex-storage://user/assets/abc.bin"): {
  client: UploadCapableClient;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const client: UploadCapableClient = {
    async upload(input) {
      calls.push(input);
      return { uri, filename: input.filename };
    },
  };
  return { client, calls };
}

/** A fake client whose upload always throws the given error. */
function throwingClient(error: unknown): UploadCapableClient {
  return {
    async upload() {
      throw error;
    },
  };
}

/** The `ApiResponseError` of an answer with an empty body, as an edge may give one. */
function apiError(status: number): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    "https://api.pipelex.com/v1/upload",
    status,
    "Error",
    "",
  );
}

describe("uploadFile", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uploads a Uint8Array, base64-encoding the bytes and returning a full record", async () => {
    const { client, calls } = capturingClient();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const record = await uploadFile(client, bytes, {
      filename: "blob.png",
      contentType: "image/png",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      filename: "blob.png",
      data: Buffer.from(bytes).toString("base64"),
      content_type: "image/png",
    });
    expect(record).toEqual({
      uri: "pipelex-storage://user/assets/abc.bin",
      filename: "blob.png",
      contentType: "image/png",
      size: 5,
    });
  });

  it("uploads an ArrayBuffer", async () => {
    const { client, calls } = capturingClient();
    const buffer = new Uint8Array([9, 8, 7]).buffer;

    const record = await uploadFile(client, buffer, { filename: "x.bin" });

    expect(calls[0]?.data).toBe(Buffer.from(new Uint8Array([9, 8, 7])).toString("base64"));
    expect(record.size).toBe(3);
  });

  it("derives filename and MIME from a File", async () => {
    const { client, calls } = capturingClient();
    const file = new File([new Uint8Array([1, 2])], "photo.jpg", { type: "image/jpeg" });

    const record = await uploadFile(client, file);

    expect(calls[0]?.filename).toBe("photo.jpg");
    expect(calls[0]?.content_type).toBe("image/jpeg");
    expect(record.filename).toBe("photo.jpg");
    expect(record.contentType).toBe("image/jpeg");
  });

  it("falls back to a default filename and guessed MIME for a nameless Blob", async () => {
    const { client, calls } = capturingClient();
    const blob = new Blob([new Uint8Array([1])], { type: "image/webp" });

    await uploadFile(client, blob);

    expect(calls[0]?.filename).toBe("upload.bin");
    expect(calls[0]?.content_type).toBe("image/webp");
  });

  it("reads a local path in Node, deriving filename from basename and MIME from extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plx-upload-"));
    tempDirs.push(dir);
    const path = join(dir, "diagram.png");
    await writeFile(path, new Uint8Array([10, 20, 30]));
    const { client, calls } = capturingClient();

    const record = await uploadFile(client, path);

    expect(calls[0]?.filename).toBe("diagram.png");
    expect(calls[0]?.content_type).toBe("image/png");
    expect(record.size).toBe(3);
  });

  it("raises InvalidLocalSourceError for a missing path", async () => {
    const { client } = capturingClient();
    await expect(uploadFile(client, "/no/such/file.png")).rejects.toBeInstanceOf(
      InvalidLocalSourceError,
    );
  });

  it("maps a 413 to RejectedAssetError carrying the filename, status and reason", async () => {
    const client = throwingClient(apiError(413));
    const bytes = new Uint8Array([1]);

    await expect(uploadFile(client, bytes, { filename: "big.pdf" })).rejects.toMatchObject({
      name: "RejectedAssetError",
      filename: "big.pdf",
      status: 413,
      reason: "too_large",
    });
    await expect(uploadFile(client, bytes, { filename: "big.pdf" })).rejects.toBeInstanceOf(
      RejectedAssetError,
    );
  });

  it("maps 401/403 to UploadAuthenticationError", async () => {
    for (const status of [401, 403]) {
      const client = throwingClient(apiError(status));
      await expect(uploadFile(client, new Uint8Array([1]))).rejects.toBeInstanceOf(
        UploadAuthenticationError,
      );
    }
  });

  it("reads a refused credential's problem from the server's problem document, else from the status", async () => {
    const answered = new ApiResponseError(
      "HTTP 403",
      "https://api.pipelex.com/v1/upload",
      403,
      "Forbidden",
      JSON.stringify(problemDocument("auth.forbidden", 403, { domain: "account" })),
    );
    const fromServer = await uploadFile(throwingClient(answered), new Uint8Array([1])).catch(
      (e: unknown) => e,
    );
    expect((fromServer as UploadAuthenticationError).code).toBe("auth.forbidden");

    // A bare refusal says nothing of the credential: the status's reading stands.
    const bare = await uploadFile(throwingClient(apiError(401)), new Uint8Array([1])).catch(
      (e: unknown) => e,
    );
    expect((bare as UploadAuthenticationError).code).toBe("auth.missing_credential");

    // What the caller knows of its own request outranks the status of a bare refusal.
    const sentKey = new UploadAuthenticationError("refused", 401, {
      cause: apiError(401),
      credentialSent: true,
    });
    expect(sentKey.code).toBe("auth.invalid_credential");
  });

  it("maps a 404 to UnsupportedUploadCapabilityError", async () => {
    const client = throwingClient(apiError(404));
    await expect(uploadFile(client, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UnsupportedUploadCapabilityError,
    );
  });

  it("maps other error statuses and unreachable hosts to UploadTransportError", async () => {
    const server = throwingClient(apiError(500));
    await expect(uploadFile(server, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UploadTransportError,
    );
    await expect(uploadFile(server, new Uint8Array([1]))).rejects.toMatchObject({ status: 500 });

    const unreachable = throwingClient(
      new ApiUnreachableError("down", "https://api.pipelex.com", "ECONNREFUSED"),
    );
    await expect(uploadFile(unreachable, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UploadTransportError,
    );
    await expect(uploadFile(unreachable, new Uint8Array([1]))).rejects.toMatchObject({
      status: undefined,
    });
  });

  it.each([
    ["a 401", apiError(401), UploadAuthenticationError],
    ["a 404", apiError(404), UnsupportedUploadCapabilityError],
    ["a 500", apiError(500), UploadTransportError],
    ["a 2xx the client could not read", apiError(200), UploadTransportError],
    [
      "an unreachable host",
      new ApiUnreachableError("down", "https://api.pipelex.com", "ECONNREFUSED"),
      UploadTransportError,
    ],
    ["a failure that is not HTTP", new SyntaxError("Unexpected token"), UploadTransportError],
  ])("names the file it was sending on the error for %s", async (_case, failure, errorClass) => {
    const error = await uploadFile(throwingClient(failure), new Uint8Array([1]), {
      filename: "scan.pdf",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(errorClass);
    expect((error as { filename?: string }).filename).toBe("scan.pdf");
  });

  it.each([
    ["a 503", apiError(503), "server_error"],
    ["a 500", apiError(500), "server_error"],
    ["a 429", apiError(429), "unexpected"],
    ["a 2xx the client could not read", apiError(200), "unexpected"],
    [
      "the client's own timeout",
      new ApiUnreachableError("timed out", "https://api.pipelex.com", "ABORT_TIMEOUT"),
      "timeout",
    ],
    [
      "a refused connection",
      new ApiUnreachableError("down", "https://api.pipelex.com", "ECONNREFUSED"),
      "unreachable",
    ],
    [
      "an unreachable host with no code",
      new ApiUnreachableError("down", "https://api.pipelex.com", undefined),
      "unreachable",
    ],
    ["a failure that is not HTTP", new SyntaxError("Unexpected token"), "unexpected"],
  ])("sets UploadTransportError's reason for %s", async (_case, failure, reason) => {
    const error = await uploadFile(throwingClient(failure), new Uint8Array([1])).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).reason).toBe(reason);
  });

  it("keeps the filename it sent when the client's answer names none", async () => {
    const client: UploadCapableClient = {
      async upload() {
        return {
          uri: "pipelex-storage://user/assets/abc.bin",
          filename: null as unknown as string,
        };
      },
    };

    const record = await uploadFile(client, new Uint8Array([1]), { filename: "scan.pdf" });

    expect(record.filename).toBe("scan.pdf");
    expect(record.uri).toBe("pipelex-storage://user/assets/abc.bin");
  });

  it("wraps an unexpected non-transport error as UploadTransportError, preserving the cause", async () => {
    // A custom client can throw anything, such as a SyntaxError of its own, which is not one
    // of the two mapped transport types — it must still land in the preparation-error family.
    const original = new SyntaxError("Unexpected token < in JSON");
    const client = throwingClient(original);

    await expect(uploadFile(client, new Uint8Array([1]))).rejects.toBeInstanceOf(
      UploadTransportError,
    );
    await expect(uploadFile(client, new Uint8Array([1]))).rejects.toMatchObject({
      cause: original,
    });
  });
});

/** A platform refusal as the client raises it: its problem document, with its code and domain. */
function platformRefusal(
  status: number,
  code: string,
  domain: string,
  detail: string,
): ApiResponseError {
  return new ApiResponseError(
    `API POST /v1/upload failed (${status}): ${detail}`,
    "https://api.pipelex.com/v1/upload",
    status,
    "Error",
    JSON.stringify(problemDocument(code, status, { domain, detail })),
  );
}

describe("uploadFile's kind and method", () => {
  it("sends a test file's kind and method beside the bytes", async () => {
    const { client, calls } = capturingClient();

    await uploadFile(client, new Uint8Array([1]), {
      filename: "case.pdf",
      kind: "test",
      method_id: "mt_abc",
    });

    expect(calls[0]).toEqual({
      filename: "case.pdf",
      data: Buffer.from([1]).toString("base64"),
      content_type: "application/pdf",
      kind: "test",
      method_id: "mt_abc",
    });
  });

  it("sends an explicit kind uploaded, and reads a null member as absent", async () => {
    const { client, calls } = capturingClient();

    await uploadFile(client, new Uint8Array([1]), {
      filename: "a.pdf",
      kind: "uploaded",
      method_id: null as unknown as string,
    });

    expect(calls[0]).toMatchObject({ kind: "uploaded" });
    expect(calls[0]).not.toHaveProperty("method_id");
  });

  it.each([
    ["a test file naming no method", { kind: "test" }, "a test file names the method"],
    ["a method beside no kind", { method_id: "mt_abc" }, "only a test file names a method"],
    [
      "a method beside kind uploaded",
      { kind: "uploaded", method_id: "mt_abc" },
      "only a test file names a method",
    ],
    ["an unknown kind", { kind: "draft" }, '`kind` is "uploaded" or "test", got "draft"'],
    ["a suffixed method id", { kind: "test", method_id: "mt_abc@3" }, "with no version suffix"],
    ["an empty method id", { kind: "test", method_id: "" }, "is not a catalog id"],
    [
      "a method id that is no catalog id",
      { kind: "test", method_id: "abc" },
      "is not a catalog id",
    ],
    ["a method id that is not a string", { kind: "test", method_id: 7 }, "got number"],
  ])("refuses %s before reading the asset", async (_case, options, words) => {
    const { client, calls } = capturingClient();

    // A path that does not exist: a refusal after reading would be an InvalidLocalSourceError.
    const error = await uploadFile(
      client,
      "/no/such/file.pdf",
      options as unknown as UploadFileOptions,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InputPreparationError);
    expect(error).not.toBeInstanceOf(InvalidLocalSourceError);
    expect((error as Error).message).toContain("Cannot upload");
    expect((error as Error).message).toContain(words);
    expect((error as InputPreparationError).code).toBe("client.argument_invalid");
    expect(calls).toHaveLength(0);
  });

  it.each([
    [
      "a role that may not change methods",
      platformRefusal(403, "auth.forbidden", "account", "Your role is runner."),
      "role_not_permitted",
      "account",
    ],
    [
      "an unknown method",
      platformRefusal(404, "pipelex.catalog.not_found", "input", "Item not found."),
      "method_not_found",
      "input",
    ],
    [
      "a method being erased",
      platformRefusal(409, "pipelex.catalog.being_deleted", "input", "Method is being deleted."),
      "method_being_deleted",
      "input",
    ],
  ])(
    "maps the refusal of a test file for %s to TestFileRefusedError",
    async (_case, failure, reason, domain) => {
      const error = await uploadFile(throwingClient(failure), new Uint8Array([1]), {
        filename: "case.pdf",
        kind: "test",
        method_id: "mt_abc",
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TestFileRefusedError);
      expect(error).toBeInstanceOf(InputPreparationError);
      expect(error).toMatchObject({
        name: "TestFileRefusedError",
        reason,
        code: failure.code,
        status: failure.status,
        filename: "case.pdf",
        methodId: "mt_abc",
        cause: failure,
        domain,
        retry: "no",
      });
    },
  );

  it("keeps the 404 of a deployment without the route unsupported, test file or not", async () => {
    const routeMissing = platformRefusal(404, "request.not_found", "input", "Not Found");

    const error = await uploadFile(throwingClient(routeMissing), new Uint8Array([1]), {
      kind: "test",
      method_id: "mt_abc",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsupportedUploadCapabilityError);
  });

  it("keeps a 403 that is not a role refusal a refused credential", async () => {
    const forbidden = platformRefusal(403, "auth.invalid_credential", "account", "Forbidden.");

    const error = await uploadFile(throwingClient(forbidden), new Uint8Array([1]), {
      kind: "test",
      method_id: "mt_abc",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadAuthenticationError);
  });
});
