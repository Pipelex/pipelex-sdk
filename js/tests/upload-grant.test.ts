/**
 * `describeUpload` and `uploadWithGrant` — the halves of an upload grant that run where
 * the bytes are, and the browser-safe `@pipelex/sdk/upload` entry. Pins: the
 * description (name, type, size and the SHA-256 Web Crypto computes, absent where the
 * runtime has no digest), a stored grant sending nothing, the PUT it sends otherwise
 * (the grant's URL, its signed headers unchanged, the file as the raw body, redirects
 * refused), a `412` read as stored for a grant that names its bytes, a `409` conflict
 * sent again after a short pause, the mapping of storage's refusals onto the
 * input-preparation errors and their codes, the time limit on the whole exchange and
 * the capped read of storage's error body, a caller's abort passing through untouched,
 * and — by bundling the module for the browser with esbuild — that its runtime import
 * graph reaches no Node builtin and no `undici`.
 *
 * The function calls the global `fetch`, so these spy on it; the bodies are the
 * XML documents S3 answers with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { build } from "esbuild";
import { describeUpload, uploadWithGrant } from "../src/upload-grant.js";
import type { UploadGrant } from "../src/upload-grant.js";
import {
  InputPreparationError,
  RejectedAssetError,
  UploadTransportError,
} from "../src/upload-grant.js";
import * as mainEntry from "../src/index.js";

/** A grant asked for without the file's hash: a UUID-named object, always a target. */
const GRANT: UploadGrant = {
  file_id: "fl_01a16405-12a5-757c-b44c-10c40b5a947b",
  uri: "pipelex-storage://org_1/assets/5f0c.pdf",
  stored: false,
  url: "https://pipelex-app-dev.s3.amazonaws.com/org_1/assets/5f0c.pdf?X-Amz-Signature=abc",
  headers: {
    "If-None-Match": "*",
    "Content-Type": "application/pdf",
    "x-amz-meta-uploaded-by": "user_1",
    "x-amz-meta-original-filename": "report.pdf",
    "x-amz-meta-byte-size": "5",
    "x-amz-meta-uploaded-at": "2026-09-23T10:00:00+00:00",
  },
  expires_at: "2026-09-23T10:05:00Z",
  max_bytes: 52428800,
};

/** The SHA-256 of `pdfFile()`'s five bytes, `%PDF-`. */
const PDF_SHA256 = createHash("sha256").update(Buffer.from("%PDF-")).digest("hex");

/** A grant asked for with the file's hash: the object is named after the bytes, which it signs. */
const HASHED_GRANT: UploadGrant = {
  ...GRANT,
  uri: `pipelex-storage://org_1/assets/${PDF_SHA256}.pdf`,
  url: `https://pipelex-app-dev.s3.amazonaws.com/org_1/assets/${PDF_SHA256}.pdf?X-Amz-Signature=abc`,
  headers: {
    ...GRANT.headers,
    "x-amz-checksum-sha256": createHash("sha256").update(Buffer.from("%PDF-")).digest("base64"),
  },
};

/** The answer for bytes the organization already holds: nothing to send. */
const STORED_GRANT: UploadGrant = {
  file_id: GRANT.file_id,
  uri: HASHED_GRANT.uri,
  stored: true,
  url: null,
  headers: null,
  expires_at: null,
  max_bytes: GRANT.max_bytes,
};

/** What a successful upload with `GRANT` answers. */
const STORED = { uri: GRANT.uri, file_id: GRANT.file_id };

/** The credential S3 echoes back inside a signature-mismatch body. It must never reach a message. */
const ECHOED_TOKEN = "IQoJb3JpZ2luX2VjEXAMPLESECRET";

/** A grant URL's signature, the bearer credential. It must never reach a thrown error. */
const SIGNATURE_SENTINEL = "SIGNATURESENTINEL123";

/** The sentinel appears nowhere a logger or an error reporter would print the error. */
function expectNoSentinel(error: unknown): void {
  expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(SIGNATURE_SENTINEL);
  expect(String(error)).not.toContain(SIGNATURE_SENTINEL);
  expect((error as Error).stack ?? "").not.toContain(SIGNATURE_SENTINEL);
}

function s3Error(code: string, message: string, extra = ""): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Error><Code>${code}</Code><Message>${message}</Message>${extra}` +
    "<RequestId>R1</RequestId><HostId>H1</HostId></Error>"
  );
}

function xmlResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/xml" } });
}

function pdfFile(): File {
  return new File([new Uint8Array([37, 80, 68, 70, 45])], "report.pdf", {
    type: "application/pdf",
  });
}

/** A Blob that reports `size` bytes without holding them: the mocked fetch never reads it. */
function sizedBlob(size: number): Blob {
  return Object.defineProperty(new Blob([]), "size", { value: size });
}

/** A fetch that never answers, and rejects with its signal's reason once aborted, as a runtime does. */
function hangingFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A promise's outcome, readable before it settles: `settled` says whether it has. */
function track(promise: Promise<unknown>): { settled: () => boolean; outcome: Promise<unknown> } {
  let done = false;
  const outcome = promise.then(
    (value) => {
      done = true;
      return value;
    },
    (error: unknown) => {
      done = true;
      return error;
    },
  );
  return { settled: () => done, outcome };
}

/** The signal the mocked fetch was handed on its first call. */
function fetchSignal(spy: { mock: { calls: unknown[][] } }): AbortSignal {
  return (spy.mock.calls[0]![1] as RequestInit).signal!;
}

/** The error `uploadWithGrant` rejects with, for a fetch answering `response`. */
async function refusalFor(response: Response, file: Blob = pdfFile()): Promise<unknown> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  return uploadWithGrant(GRANT, file).then(
    () => {
      throw new Error("expected uploadWithGrant to reject");
    },
    (error: unknown) => error,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("uploadWithGrant — the PUT", () => {
  it("PUTs the file as the raw body to the grant's URL with its headers unchanged", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const file = pdfFile();

    const result = await uploadWithGrant(GRANT, file);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GRANT.url);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual(GRANT.headers);
    expect(init.body).toBe(file);
    expect(init.redirect).toBe("manual");
    expect(result).toEqual(STORED);
  });

  it("accepts a nameless Blob", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const result = await uploadWithGrant(GRANT, new Blob([new Uint8Array([1, 2, 3])]));

    expect(result).toEqual(STORED);
  });

  it("forwards a caller's abort into the PUT's own signal", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch);
    const controller = new AbortController();
    const reason = new Error("The user cancelled.");

    const pending = uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    const sent = fetchSignal(spy);
    expect(sent).not.toBe(controller.signal);
    expect(sent.aborted).toBe(false);
    controller.abort(reason);

    expect(sent.aborted).toBe(true);
    expect(await pending).toBe(reason);
  });

  it("stops listening to the caller's signal once the upload settles", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const controller = new AbortController();

    await uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal });
    controller.abort(new Error("too late"));

    expect(fetchSignal(spy).aborted).toBe(false);
  });
});

describe("uploadWithGrant — a grant for bytes already stored", () => {
  it("sends nothing for a stored grant and answers its uri and file_id", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not be called"));
    const file = pdfFile();
    const read = vi.spyOn(file, "arrayBuffer");

    const result = await uploadWithGrant(STORED_GRANT, file);

    expect(result).toEqual({ uri: STORED_GRANT.uri, file_id: STORED_GRANT.file_id });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("still refuses an invalid timeoutMs and lets an earlier abort through for a stored grant", async () => {
    const controller = new AbortController();
    const reason = new Error("The user cancelled.");
    controller.abort(reason);

    expect(
      await uploadWithGrant(STORED_GRANT, pdfFile(), { signal: controller.signal }).catch(
        (e: unknown) => e,
      ),
    ).toBe(reason);
    expect(
      await uploadWithGrant(STORED_GRANT, pdfFile(), { timeoutMs: 0 }).catch((e: unknown) => e),
    ).toBeInstanceOf(InputPreparationError);
  });

  it("sends the file when stored is false, branching on stored and never on url", async () => {
    // A grant that is not stored and carries no target is refused, not read as stored.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not be called"));

    const error = await uploadWithGrant(
      { ...GRANT, url: null, headers: null, expires_at: null },
      pdfFile(),
    ).catch((e: unknown) => e);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).code).toBe("invalid_grant_url");
    expect((error as Error).message).toContain("not stored yet");
  });

  it("sends the file for an answer with no stored field, as a platform before hashed uploads gave", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    // Neither `stored` nor `file_id`: both are optional, and the result carries no file_id.
    const { stored: _stored, file_id: _fileId, ...legacy } = GRANT;

    const result = await uploadWithGrant(legacy, pdfFile());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toStrictEqual({ uri: GRANT.uri });
    expect("file_id" in result).toBe(false);
  });
});

describe("uploadWithGrant — a grant that names its bytes", () => {
  it("sends the signed checksum with the other headers unchanged", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const result = await uploadWithGrant(HASHED_GRANT, pdfFile());

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HASHED_GRANT.url);
    expect(init.headers).toEqual(HASHED_GRANT.headers);
    expect(result).toEqual({ uri: HASHED_GRANT.uri, file_id: HASHED_GRANT.file_id });
  });

  it.each([
    ["as the platform writes it", HASHED_GRANT.headers!],
    [
      "in any case",
      {
        ...GRANT.headers,
        "X-Amz-Checksum-SHA256": HASHED_GRANT.headers!["x-amz-checksum-sha256"]!,
      },
    ],
  ])(
    "reads a 412 as stored when the grant signs the checksum %s: the key holds those bytes",
    async (_case, headers) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        xmlResponse(412, s3Error("PreconditionFailed", "pre-conditions")),
      );

      const result = await uploadWithGrant({ ...HASHED_GRANT, headers }, pdfFile());

      expect(result).toEqual({ uri: HASHED_GRANT.uri, file_id: HASHED_GRANT.file_id });
      // The same answer as the grant that found the bytes held and asked for no PUT.
      expect(result).toEqual(await uploadWithGrant(STORED_GRANT, pdfFile()));
    },
  );

  it("tells a grant that names its bytes by its signed checksum, never by its key's shape", async () => {
    // A grant without the checksum is a hashless one, whatever its key looks like: its 412
    // still means it was used, and the one with the checksum still reads as stored.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(xmlResponse(412, s3Error("PreconditionFailed", "pre-conditions"))),
    );

    const hashlessError = await uploadWithGrant(
      { ...HASHED_GRANT, headers: GRANT.headers },
      pdfFile(),
    ).catch((e: unknown) => e);
    const hashed = await uploadWithGrant({ ...HASHED_GRANT, uri: GRANT.uri }, pdfFile());

    expect(hashlessError).toBeInstanceOf(RejectedAssetError);
    expect((hashlessError as RejectedAssetError).code).toBe("grant_used");
    expect(hashed).toEqual({ uri: GRANT.uri, file_id: GRANT.file_id });
  });

  it("maps a body whose bytes differ from the hash onto RejectedAssetError, saying so", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      xmlResponse(
        400,
        s3Error("BadDigest", "The SHA256 you specified did not match the calculated checksum."),
      ),
    );

    const error = await uploadWithGrant(HASHED_GRANT, pdfFile()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RejectedAssetError);
    const rejected = error as RejectedAssetError;
    expect(rejected.status).toBe(400);
    expect(rejected.code).toBe("store_refused");
    expect(rejected.message).toContain("400 BadDigest");
    expect(rejected.message).toContain("bytes differ from the ones whose SHA-256");
    expect(rejected.retryable).toBe(false);
  });

  it("advises a retry that finds the file stored, not a used grant", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      xmlResponse(503, s3Error("SlowDown", "Please reduce your request rate.")),
    );

    const error = await uploadWithGrant(HASHED_GRANT, pdfFile()).catch((e: unknown) => e);

    expect((error as Error).message).toContain(
      `Retrying with the same grant before it expires at ${GRANT.expires_at} stores the file ` +
        "or finds it already stored",
    );
    expect((error as Error).message).not.toContain("reports the grant as used");
  });
});

describe("uploadWithGrant — storage's 409 ConditionalRequestConflict", () => {
  const conflict = (): Response =>
    xmlResponse(
      409,
      s3Error(
        "ConditionalRequestConflict",
        "A conflicting operation occurred. If using PutObject you can retry the request.",
      ),
    );

  it("sends the PUT again after a short pause, and succeeds when the other write is done", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const file = pdfFile();

    const upload = track(uploadWithGrant(GRANT, file));
    await vi.advanceTimersByTimeAsync(249);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await upload.outcome).toEqual(STORED);
    expect(spy).toHaveBeenCalledTimes(2);
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(GRANT.url);
    expect(init.headers).toEqual(GRANT.headers);
    expect(init.body).toBe(file);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the 412 after a conflict as stored for a grant that names its bytes", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(conflict())
      .mockResolvedValueOnce(xmlResponse(412, s3Error("PreconditionFailed", "pre-conditions")));

    const upload = track(uploadWithGrant(HASHED_GRANT, pdfFile()));
    await vi.advanceTimersByTimeAsync(250);

    expect(await upload.outcome).toEqual({
      uri: HASHED_GRANT.uri,
      file_id: HASHED_GRANT.file_id,
    });
  });

  it("gives up after a few attempts with pauses of 250, 500, 1000 and 2000 ms", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => conflict());

    const upload = track(uploadWithGrant(GRANT, pdfFile()));
    const attemptsAfter: number[] = [];
    for (const pauseMs of [250, 500, 1_000, 2_000]) {
      await vi.advanceTimersByTimeAsync(pauseMs - 1);
      attemptsAfter.push(spy.mock.calls.length);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(attemptsAfter).toEqual([1, 2, 3, 4]);

    const error = await upload.outcome;
    expect(spy).toHaveBeenCalledTimes(5);
    expect(error).toBeInstanceOf(UploadTransportError);
    expect(error).not.toBeInstanceOf(RejectedAssetError);
    const transport = error as UploadTransportError;
    expect(transport.status).toBe(409);
    expect(transport.code).toBe("conflict");
    expect(transport.message).toContain("409 ConditionalRequestConflict");
    expect(transport.message).toContain("another write of the same object");
    expect(transport.message).toContain("on each of its 5 attempts");
    expect(transport.message).toContain(
      `Retrying with the same grant before it expires at ${GRANT.expires_at}`,
    );
    expect(transport.errorDomain).toBe("runtime");
    expect(transport.retryable).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a caller's abort during the pause through as its own reason, sending nothing more", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => conflict());
    const controller = new AbortController();
    const reason = new Error("The user cancelled.");

    const upload = track(uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(reason);

    expect(await upload.outcome).toBe(reason);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles as the conflict storage last answered when the time limit runs out in a pause", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => conflict());

    const upload = track(uploadWithGrant(GRANT, pdfFile(), { timeoutMs: 600 }));
    await vi.advanceTimersByTimeAsync(600);

    const error = await upload.outcome;
    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).code).toBe("conflict");
    expect((error as UploadTransportError).status).toBe(409);
    expect((error as Error).message).toContain(
      "on each of its 2 attempts before the 0.6 s allowed ran out",
    );
    // Sent at 0 and after the first pause, at 250 ms; the limit ran out in the second pause.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends no new PUT for a 409 of any other code", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(xmlResponse(409, s3Error("OperationAborted", "A conflicting operation")));

    const error = await uploadWithGrant(GRANT, pdfFile()).catch((e: unknown) => e);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).code).toBe("store_refused");
  });
});

describe("describeUpload", () => {
  it("reads a File's name, type and size, and the SHA-256 of its bytes", async () => {
    const description = await describeUpload(pdfFile());

    expect(description).toEqual({
      filename: "report.pdf",
      content_type: "application/pdf",
      size: 5,
      sha256: PDF_SHA256,
    });
  });

  it("hashes an empty file as SHA-256 hashes nothing", async () => {
    const description = await describeUpload(new File([], "empty.txt"));

    expect(description).toEqual({
      filename: "empty.txt",
      content_type: "",
      size: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("hashes a file of a few megabytes exactly", async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024 + 7).map((_, i) => (i * 31) % 251);

    const description = await describeUpload(new Blob([bytes]), { filename: "big.bin" });

    expect(description.size).toBe(bytes.byteLength);
    expect(description.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("names a nameless Blob by the filename option, which also replaces a File's own", async () => {
    const fromBlob = await describeUpload(new Blob([new Uint8Array([1])]), {
      filename: "scan.png",
    });
    const renamed = await describeUpload(pdfFile(), { filename: "invoice.pdf" });

    expect(fromBlob.filename).toBe("scan.png");
    expect(fromBlob.content_type).toBe("");
    expect(renamed.filename).toBe("invoice.pdf");
    expect(renamed.sha256).toBe(PDF_SHA256);
  });

  it.each([
    ["a nameless Blob", new Blob([new Uint8Array([1])])],
    ["a File named nothing", new File([new Uint8Array([1])], "")],
  ])("refuses %s before reading it", async (_case, file) => {
    const read = vi.spyOn(file, "arrayBuffer");

    const error = await describeUpload(file).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InputPreparationError);
    expect((error as Error).message).toContain("has no name");
    expect(read).not.toHaveBeenCalled();
  });

  it("never reads a file past 50 MiB by default, describing it without its hash", async () => {
    // A file of several gigabytes read whole would freeze or crash a browser tab before the
    // grant route could refuse its size; without the hash, the route's own 413 does.
    const tooLarge = sizedBlob(52_428_801);
    const tooLargeRead = vi.spyOn(tooLarge, "arrayBuffer");
    const atLimit = sizedBlob(52_428_800);
    const atLimitRead = vi.spyOn(atLimit, "arrayBuffer").mockResolvedValue(new ArrayBuffer(0));

    const skipped = await describeUpload(tooLarge, { filename: "film.mov" });
    const hashed = await describeUpload(atLimit, { filename: "scan.pdf" });

    expect(skipped).toEqual({ filename: "film.mov", content_type: "", size: 52_428_801 });
    expect(tooLargeRead).not.toHaveBeenCalled();
    expect(atLimitRead).toHaveBeenCalledTimes(1);
    expect(hashed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes up to the maxBytes a caller gives, and no further", async () => {
    const atBound = await describeUpload(pdfFile(), { maxBytes: 5 });
    const file = pdfFile();
    const read = vi.spyOn(file, "arrayBuffer");
    const pastBound = await describeUpload(file, { maxBytes: 4 });

    expect(atBound.sha256).toBe(PDF_SHA256);
    expect(pastBound).toEqual({ filename: "report.pdf", content_type: "application/pdf", size: 5 });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number])(
    "refuses a maxBytes of %s before reading anything",
    async (maxBytes) => {
      const file = pdfFile();
      const read = vi.spyOn(file, "arrayBuffer");

      const error = await describeUpload(file, { maxBytes }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InputPreparationError);
      expect((error as Error).message).toContain('"maxBytes" must be a positive number');
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("leaves the hash out where the runtime offers no Web Crypto digest", async () => {
    // A browser withholds `crypto.subtle` from a page served over plain http.
    vi.stubGlobal("crypto", {});
    try {
      const file = pdfFile();
      const read = vi.spyOn(file, "arrayBuffer");

      const description = await describeUpload(file);

      expect(description).toEqual({
        filename: "report.pdf",
        content_type: "application/pdf",
        size: 5,
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wraps a file that cannot be read, keeping the runtime's error as its cause", async () => {
    const file = pdfFile();
    const failure = new DOMException("The file could not be read.", "NotReadableError");
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(failure);

    const error = await describeUpload(file).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InputPreparationError);
    expect((error as Error).message).toContain('"report.pdf" could not be read');
    expect((error as Error).message).toContain("NotReadableError");
    expect((error as InputPreparationError).cause).toBe(failure);
  });
});

describe("uploadWithGrant — the time limit", () => {
  it.each([
    ["an empty file", 0, 60_000],
    ["one byte", 1, 61_000],
    ["1 MiB", 1024 * 1024, 68_000],
    ["1 MiB and one byte", 1024 * 1024 + 1, 69_000],
    ["50 MiB, the size cap", 50 * 1024 * 1024, 460_000],
  ])(
    "times out a PUT of %s (%i bytes) that never answers after %i ms by default, and not before",
    async (_case, size, limitMs) => {
      vi.useFakeTimers();
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch);

      const upload = track(uploadWithGrant(GRANT, sizedBlob(size)));
      await vi.advanceTimersByTimeAsync(limitMs - 1);
      expect(upload.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const error = await upload.outcome;
      expect(error).toBeInstanceOf(UploadTransportError);
      const transport = error as UploadTransportError;
      expect(transport.code).toBe("timeout");
      expect(transport.status).toBeUndefined();
      expect(transport.cause).toBeUndefined();
      expect(transport.message).toContain(
        `"5f0c.pdf" did not finish within the ${limitMs / 1000} s allowed`,
      );
      expect(transport.message).toContain("whether storage stored the file is unknown");
      expect(transport.message).toContain(
        `Retrying with the same grant before it expires at ${GRANT.expires_at}`,
      );
      expect(fetchSignal(spy).aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ["shorter", 1_500, "1.5"],
    ["longer", 600_000, "600"],
  ])("puts a %s timeoutMs in the default's place", async (_case, timeoutMs, seconds) => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch);

    const upload = track(uploadWithGrant(GRANT, pdfFile(), { timeoutMs }));
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(upload.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await upload.outcome;
    expect((error as UploadTransportError).code).toBe("timeout");
    expect((error as Error).message).toContain(`within the ${seconds} s allowed`);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    "refuses a timeoutMs of %s before sending anything",
    async (timeoutMs) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("fetch must not be called"));

      const error = await uploadWithGrant(GRANT, pdfFile(), { timeoutMs }).catch((e: unknown) => e);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(InputPreparationError);
      expect(error).not.toBeInstanceOf(UploadTransportError);
      expect((error as Error).message).toContain('"timeoutMs" must be a positive number');
    },
  );

  it("accepts the longest timeoutMs a timer honours", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const result = await uploadWithGrant(GRANT, pdfFile(), { timeoutMs: 2 ** 31 - 1 });

    expect(result).toEqual(STORED);
  });

  it("lets a caller's abort before the limit through as its own reason", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch);
    const controller = new AbortController();
    const reason = new Error("The user cancelled.");

    const upload = track(uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort(reason);

    expect(await upload.outcome).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a caller's own AbortSignal.timeout through unwrapped, since that abort is the caller's", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch);

    const error = await uploadWithGrant(GRANT, pdfFile(), {
      signal: AbortSignal.timeout(10),
    }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(UploadTransportError);
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  it("lets a caller's abort win when the limit ran out too", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("The user cancelled.");
    // The time limit fires first, and the caller aborts before the rejection is seen.
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            controller.abort(reason);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    });

    const upload = track(uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }));
    // The file is 5 bytes, so its limit is 61 s.
    await vi.advanceTimersByTimeAsync(61_000);

    expect(await upload.outcome).toBe(reason);
  });

  it("clears its timer once the upload settles, whichever way", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await uploadWithGrant(GRANT, pdfFile());
    expect(vi.getTimerCount()).toBe(0);

    fetchSpy.mockResolvedValueOnce(
      xmlResponse(412, s3Error("PreconditionFailed", "pre-conditions")),
    );
    await uploadWithGrant(GRANT, pdfFile()).catch(() => undefined);
    expect(vi.getTimerCount()).toBe(0);

    fetchSpy.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await uploadWithGrant(GRANT, pdfFile()).catch(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["never ends", false],
    ["errors with a generic AbortError on abort, as a browser does", true],
  ])(
    "answers with storage's status when the limit runs out while its error body %s",
    async (_case, errorsOnAbort) => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("<Error><Code>AccessDenied</Code>"));
            if (errorsOnAbort) {
              init?.signal?.addEventListener("abort", () =>
                stream.error(new DOMException("The user aborted a request.", "AbortError")),
              );
            }
          },
        });
        return new Response(body, { status: 403, statusText: "Forbidden" });
      });

      const upload = track(uploadWithGrant(GRANT, pdfFile()));
      // The file is 5 bytes, so its limit is 61 s.
      await vi.advanceTimersByTimeAsync(60_999);
      expect(upload.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      // Storage answered before the limit: a 403 stored nothing, so this is its refusal,
      // read off the part of the body that arrived, and no unknown-outcome timeout.
      const error = await upload.outcome;
      expect(error).toBeInstanceOf(RejectedAssetError);
      expect((error as RejectedAssetError).status).toBe(403);
      expect((error as RejectedAssetError).code).toBe("store_refused");
      expect((error as Error).message).toContain("403 AccessDenied");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps the code S3 sent before the limit ran out mid-body", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            new TextEncoder().encode("<Error><Code>ConditionalRequestConflict</Code><Message>"),
          );
        },
      });
      return new Response(body, { status: 409 });
    });

    const upload = track(uploadWithGrant(GRANT, pdfFile()));
    await vi.advanceTimersByTimeAsync(61_000);

    const error = await upload.outcome;
    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).code).toBe("conflict");
    expect((error as UploadTransportError).status).toBe(409);
    // The limit has run out, so no new PUT is sent after it.
    expect((error as Error).message).toContain(
      "on its one attempt before the 61 s allowed ran out",
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a success", 200, ""],
    ["a redirect", 307, ""],
    ["an error body past the cap", 403, s3Error("AccessDenied", "Request has expired")],
  ])("settles on %s even when the body's cancellation never does", async (_case, status, text) => {
    // A body whose cancel never settles: nothing may wait on it, or the call would
    // outlive its own time limit.
    const bytes = new TextEncoder().encode(text.padEnd(20 * 1024, " "));
    let served = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (!served && text !== "") stream.enqueue(bytes);
        served = true;
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }));

    const outcome = await uploadWithGrant(GRANT, pdfFile(), { timeoutMs: 1_000 }).catch(
      (e: unknown) => e,
    );

    if (status === 200) expect(outcome).toEqual(STORED);
    if (status === 307) expect((outcome as UploadTransportError).code).toBe("redirected");
    if (status === 403) expect((outcome as RejectedAssetError).code).toBe("grant_expired");
  });
});

describe("uploadWithGrant — reading storage's error body", () => {
  /** A body served in chunks as they are asked for, counting what went out and whether it was cancelled. */
  function chunkedBody(text: string, chunkSize: number) {
    const bytes = new TextEncoder().encode(text);
    const served = { bytes: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (served.bytes >= bytes.byteLength) {
            controller.close();
            return;
          }
          const chunk = bytes.subarray(served.bytes, served.bytes + chunkSize);
          served.bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          served.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, served };
  }

  it("reads only the first 16 KiB, which carry S3's code and message, and cancels the rest", async () => {
    const { stream, served } = chunkedBody(
      s3Error("AccessDenied", "Request has expired", `<Pad>${"x".repeat(64 * 1024)}</Pad>`),
      4 * 1024,
    );

    const error = await refusalFor(new Response(stream, { status: 403 }));

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).code).toBe("grant_expired");
    expect(served.bytes).toBe(16 * 1024);
    expect(served.cancelled).toBe(true);
  });

  it("falls back to the status text when S3's code starts past the first 16 KiB", async () => {
    const { stream } = chunkedBody(
      `<!--${"x".repeat(20 * 1024)}-->` + s3Error("AccessDenied", "Request has expired"),
      4 * 1024,
    );

    const error = await refusalFor(new Response(stream, { status: 403, statusText: "Forbidden" }));

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).code).toBe("store_refused");
    expect((error as Error).message).toContain("403 Forbidden");
  });

  it("decodes a character split across two chunks", async () => {
    const { stream } = chunkedBody(s3Error("InvalidArgument", "En-tête refusé"), 7);

    const error = await refusalFor(new Response(stream, { status: 400 }));

    expect((error as Error).message).toContain("En-tête refusé");
  });
});

describe("uploadWithGrant — storage's refusals", () => {
  it("maps the 412 of a used grant onto RejectedAssetError", async () => {
    const error = await refusalFor(
      xmlResponse(
        412,
        s3Error(
          "PreconditionFailed",
          "At least one of the pre-conditions you specified did not hold",
        ),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect(error).toBeInstanceOf(InputPreparationError);
    const rejected = error as RejectedAssetError;
    expect(rejected.status).toBe(412);
    expect(rejected.code).toBe("grant_used");
    expect(rejected.filename).toBe("report.pdf");
    expect(rejected.message).toContain("412 PreconditionFailed");
    expect(rejected.message).toContain("already used");
    expect(rejected.message).toContain("may have stored the file");
  });

  it("maps a signature mismatch onto RejectedAssetError, keeping no part of the echoed request", async () => {
    const error = await refusalFor(
      xmlResponse(
        403,
        s3Error(
          "SignatureDoesNotMatch",
          "The request signature we calculated does not match the signature you provided. Check your key and signing method.",
          `<AWSAccessKeyId>ASIAEXAMPLE</AWSAccessKeyId><CanonicalRequest>PUT\n/org_1/assets/5f0c.pdf\nX-Amz-Security-Token=${ECHOED_TOKEN}</CanonicalRequest>`,
        ),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    const rejected = error as RejectedAssetError;
    expect(rejected.status).toBe(403);
    expect(rejected.code).toBe("signature_mismatch");
    expect(rejected.message).toContain("403 SignatureDoesNotMatch");
    expect(rejected.message).toContain("size, content type or metadata");
    expect(rejected.message).not.toContain(ECHOED_TOKEN);
    expect(rejected.message).not.toContain("ASIAEXAMPLE");
    expect(rejected.cause).toBeUndefined();
  });

  it("says the grant expired when storage says so", async () => {
    const error = await refusalFor(
      xmlResponse(403, s3Error("AccessDenied", "Request has expired")),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).code).toBe("grant_expired");
    expect((error as RejectedAssetError).message).toContain(
      `the grant expired at ${GRANT.expires_at}`,
    );
  });

  it("names an unsigned header when storage refuses one", async () => {
    const error = await refusalFor(
      xmlResponse(
        403,
        s3Error("AccessDenied", "There were headers present in the request which were not signed"),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).code).toBe("unsigned_header");
    expect((error as RejectedAssetError).message).toContain("a header the grant did not sign");
  });

  it("relays storage's own message for any other 4xx", async () => {
    const error = await refusalFor(
      xmlResponse(
        400,
        s3Error("EntityTooSmall", "Your proposed upload is smaller than the minimum"),
      ),
    );

    expect(error).toBeInstanceOf(RejectedAssetError);
    const rejected = error as RejectedAssetError;
    expect(rejected.status).toBe(400);
    expect(rejected.code).toBe("store_refused");
    expect(rejected.message).toContain("400 EntityTooSmall");
    expect(rejected.message).toContain("smaller than the minimum");
  });

  it("decodes XML entities in storage's message", async () => {
    const error = await refusalFor(
      xmlResponse(400, s3Error("InvalidArgument", "Header &apos;x&apos; &amp; &lt;y&gt;")),
    );

    expect((error as RejectedAssetError).message).toContain("Header 'x' & <y>");
  });

  it("falls back to the status text on a body that is not S3's", async () => {
    const error = await refusalFor(new Response("nope", { status: 403, statusText: "Forbidden" }));

    expect(error).toBeInstanceOf(RejectedAssetError);
    expect((error as RejectedAssetError).message).toContain("403 Forbidden");
  });

  it("names a nameless Blob by the object its grant names", async () => {
    const error = await refusalFor(
      xmlResponse(412, s3Error("PreconditionFailed", "pre-conditions")),
      new Blob([new Uint8Array([1])]),
    );

    expect((error as RejectedAssetError).filename).toBe("5f0c.pdf");
  });
});

describe("uploadWithGrant — transport failures", () => {
  it("maps a 5xx onto UploadTransportError", async () => {
    const error = await refusalFor(
      xmlResponse(503, s3Error("SlowDown", "Please reduce your request rate.")),
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    expect(error).toBeInstanceOf(InputPreparationError);
    expect((error as UploadTransportError).status).toBe(503);
    expect((error as UploadTransportError).code).toBe("server_error");
    expect((error as UploadTransportError).cause).toBeUndefined();
    expect((error as Error).message).toContain("503 SlowDown");
    expect((error as Error).message).toContain("Please reduce your request rate.");
    expect((error as Error).message).toContain("Whether the file was stored is unknown.");
    expect((error as Error).message).toContain(
      `Retrying with the same grant before it expires at ${GRANT.expires_at}`,
    );
    // A fault in storage may pass.
    expect((error as UploadTransportError).errorDomain).toBe("runtime");
    expect((error as UploadTransportError).retryable).toBe(true);
  });

  it("maps a 501 onto a server_error that invites no retry, since storage stored nothing", async () => {
    const error = await refusalFor(
      xmlResponse(
        501,
        s3Error(
          "NotImplemented",
          "A header you provided implies functionality that is not implemented.",
        ),
      ),
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    const transport = error as UploadTransportError;
    expect(transport.status).toBe(501);
    expect(transport.code).toBe("server_error");
    expect(transport.message).toContain("501 NotImplemented");
    expect(transport.message).toContain("functionality that is not implemented. Storage does not");
    expect(transport.message).toContain("so it stored nothing");
    expect(transport.message).not.toContain("same grant");
    expect(transport.message).not.toContain("Whether the file was stored is unknown");
    // Storage does not implement the request, so asking again meets the same answer.
    expect(transport.errorDomain).toBe("runtime");
    expect(transport.retryable).toBe(false);
  });

  it("prints one period after a 5xx message that already ends with one", async () => {
    const error = await refusalFor(
      xmlResponse(
        500,
        s3Error("InternalError", "We encountered an internal error. Please try again."),
      ),
    );

    expect((error as UploadTransportError).code).toBe("server_error");
    expect((error as Error).message).toContain("Please try again. Whether the file was stored");
    expect((error as Error).message).not.toContain("..");
  });

  it("maps storage timing out on the body onto UploadTransportError, since nothing was written", async () => {
    const error = await refusalFor(
      xmlResponse(
        400,
        s3Error(
          "RequestTimeout",
          "Your socket connection to the server was not read from or written to within the timeout period.",
        ),
      ),
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).status).toBe(400);
    expect((error as UploadTransportError).code).toBe("storage_timeout");
    expect((error as Error).message).toContain("400 RequestTimeout");
    expect((error as Error).message).toContain("wrote nothing");
    expect((error as Error).message).toContain(`expires at ${GRANT.expires_at}`);
  });

  it.each([
    [
      "429 SlowDown",
      xmlResponse(429, s3Error("SlowDown", "Please reduce your request rate.")),
      429,
      "throttled",
      "(429 SlowDown): Please reduce your request rate. Storage throttled",
    ],
    ["429 with an empty body", new Response(null, { status: 429 }), 429, "throttled", "(429)."],
    [
      "408 RequestTimeout",
      xmlResponse(
        408,
        s3Error(
          "RequestTimeout",
          "Your socket connection to the server was not read from or written to within the timeout period.",
        ),
      ),
      408,
      "timed out",
      "(408 RequestTimeout): Your socket connection",
    ],
    ["408 with an empty body", new Response(null, { status: 408 }), 408, "timed out", "(408)."],
  ])(
    "maps storage's %s onto a retryable UploadTransportError, not a refusal of the file",
    async (_case, response, status, verb, described) => {
      const error = await refusalFor(response);

      expect(error).toBeInstanceOf(UploadTransportError);
      expect(error).not.toBeInstanceOf(RejectedAssetError);
      const transport = error as UploadTransportError;
      expect(transport.status).toBe(status);
      expect(transport.code).toBe("unexpected");
      expect(transport.cause).toBeUndefined();
      expect(transport.message).toContain(described);
      expect(transport.message).toContain(
        `Storage ${verb} the request rather than refusing the file, so a later attempt can succeed.`,
      );
      expect(transport.message).toContain(
        `Retrying with the same grant before it expires at ${GRANT.expires_at}`,
      );
      expect(transport.message).not.toContain("request a new grant");
      // Refused for its timing, so a later attempt can pass.
      expect(transport.errorDomain).toBe("runtime");
      expect(transport.retryable).toBe(true);
    },
  );

  it("refuses a redirect rather than following it", async () => {
    const error = await refusalFor(
      new Response(null, {
        status: 307,
        headers: { Location: "https://elsewhere.example/upload" },
      }),
    );

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).status).toBe(307);
    expect((error as UploadTransportError).code).toBe("redirected");
    expect((error as Error).message).toContain("redirect was refused");
  });

  it("maps an unreachable storage onto UploadTransportError, naming a refused cross-origin request", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await uploadWithGrant(GRANT, pdfFile()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).status).toBeUndefined();
    expect((error as UploadTransportError).code).toBe("unreachable");
    expect((error as Error).message).toContain(
      "could not reach storage at https://pipelex-app-dev.s3.amazonaws.com (TypeError)",
    );
    expect((error as Error).message).toContain("connect-src");
    // The connection may have dropped after the file went out, so the same grant tells.
    expect((error as Error).message).toContain("may have stored it anyway");
    expect((error as Error).message).toContain(
      `Retrying with the same grant before it expires at ${GRANT.expires_at}`,
    );
  });

  it("keeps a network error's names and codes, and never the error, whose message or fields can carry the grant URL", async () => {
    const url = `https://pipelex-app-dev.s3.amazonaws.com/k.pdf?X-Amz-Signature=${SIGNATURE_SENTINEL}`;
    // Node names the URL in a message and in its cause's `input`; Bun puts it on `path`.
    const failure = new TypeError(`fetch failed for ${url}`, {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url}`), {
        code: "ENOTFOUND",
        input: url,
        path: url,
      }),
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);

    const error = await uploadWithGrant({ ...GRANT, url }, pdfFile()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as Error).message).toContain("(TypeError, caused by Error ENOTFOUND)");
    expect((error as UploadTransportError).cause).toBeUndefined();
    expectNoSentinel(error);
  });

  it("keeps an error name only when it is a bare identifier, since a wrapper may rename it", async () => {
    const url = `https://pipelex-app-dev.s3.amazonaws.com/k.pdf?X-Amz-Signature=${SIGNATURE_SENTINEL}`;
    const inner = Object.assign(new Error("socket closed"), { name: `SocketError ${url}` });
    const failure = Object.assign(new Error("failed", { cause: inner }), {
      name: `FetchError(${url})`,
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);

    const error = await uploadWithGrant({ ...GRANT, url }, pdfFile()).catch((e: unknown) => e);

    expect((error as Error).message).toContain("(Error, caused by Error)");
    expectNoSentinel(error);
  });

  it("lets an abort that came first win over a grant url it would refuse", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not be called"));
    const controller = new AbortController();
    const reason = new Error("The user cancelled.");
    controller.abort(reason);

    const error = await uploadWithGrant({ ...GRANT, url: "/relative/k.pdf" }, pdfFile(), {
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["carries user info", `https://user:pass@pipelex-app-dev.s3.amazonaws.com/k.pdf`],
    ["does not parse", `https://pipelex-app-dev.s3.amazonaws.com:99999/k.pdf`],
    ["is relative", `/org_1/assets/k.pdf`],
    ["is not http(s)", `ftp://pipelex-app-dev.s3.amazonaws.com/k.pdf`],
  ])("refuses a grant whose url %s before sending, naming none of it", async (_case, base) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch must not be called"));
    const url = `${base}?X-Amz-Signature=${SIGNATURE_SENTINEL}`;

    const error = await uploadWithGrant({ ...GRANT, url }, pdfFile()).catch((e: unknown) => e);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(UploadTransportError);
    expect((error as UploadTransportError).code).toBe("invalid_grant_url");
    expect((error as Error).message).toContain("was not sent");
    expect((error as UploadTransportError).cause).toBeUndefined();
    expectNoSentinel(error);
  });

  it("lets a caller's abort through unwrapped, even when fetch rejects with a generic AbortError", async () => {
    const controller = new AbortController();
    const reason = new Error("The user cancelled.");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      controller.abort(reason);
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const error = await uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }).catch(
      (e: unknown) => e,
    );

    expect(error).toBe(reason);
  });

  it("lets a caller's abort through unwrapped while storage's error body is still arriving", async () => {
    const controller = new AbortController();
    const reason = new DOMException("The user cancelled.", "AbortError");
    // Storage answered 403 and is still streaming its body when the caller aborts.
    // Chrome and Firefox error the body stream with a generic AbortError rather than
    // the signal's reason, which is what the caller must still get back.
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("<Error><Code>AccessDenied</Code>"));
        controller.signal.addEventListener("abort", () =>
          stream.error(new DOMException("The user aborted a request.", "AbortError")),
        );
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 403 }));

    const pending = uploadWithGrant(GRANT, pdfFile(), { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);

    expect(await pending).toBe(reason);
  });
});

describe("the @pipelex/sdk/upload entry", () => {
  const entry = fileURLToPath(new URL("../src/upload-grant.ts", import.meta.url));

  it("bundles for the browser with nothing marked external", async () => {
    // esbuild fails to resolve a Node builtin on the browser platform, and a dynamic
    // import with a literal specifier is bundled like a static one — so a reachable
    // Node builtin or `undici` fails this build.
    // Type-only imports are erased, as they are by every consumer's bundler.
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      logLevel: "silent",
    });

    expect(result.errors).toEqual([]);
    const code = result.outputFiles[0]!.text;
    expect(code).toContain("uploadWithGrant");
    expect(code).toContain("describeUpload");
    expect(code).not.toMatch(/["']node:/);
    expect(code).not.toContain("undici");
    expect(code).not.toContain("PipelexApiClient");
  });

  it("is the ./upload subpath of the package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };

    expect(pkg.exports["./upload"]).toEqual({
      types: "./dist/upload-grant.d.ts",
      import: "./dist/upload-grant.js",
      default: "./dist/upload-grant.js",
    });
  });

  it("shares its function and error classes with the main entry", () => {
    expect(mainEntry.uploadWithGrant).toBe(uploadWithGrant);
    expect(mainEntry.describeUpload).toBe(describeUpload);
    expect(mainEntry.RejectedAssetError).toBe(RejectedAssetError);
    expect(mainEntry.UploadTransportError).toBe(UploadTransportError);
    expect(mainEntry.InputPreparationError).toBe(InputPreparationError);
  });
});
