// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiResponseError, ApiUnreachableError, ArtifactFetchError } from "@pipelex/sdk";

const fetchArtifact = vi.fn();

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ fetchArtifact }),
}));

import { GET, HEAD } from "./route";

beforeEach(() => fetchArtifact.mockReset());
afterEach(() => vi.unstubAllEnvs());

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function upstream(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string>): Response {
  return new Response(bytes, { status: 200, headers });
}

function get(segments: string[]): Promise<Response> {
  const request = new Request(`http://app.test/api/assets/${segments.join("/")}`);
  return GET(request, { params: Promise.resolve({ path: segments }) });
}

describe("GET /api/assets/[...path]", () => {
  it("rebuilds the reference, fetches it through the SDK, and streams the bytes under the asset headers", async () => {
    vi.stubEnv("PIPELEX_BASE_URL", "https://api.pipelex.com");
    fetchArtifact.mockResolvedValueOnce(
      upstream(PNG_BYTES, { "content-type": "image/png", "content-length": "8" }),
    );

    const response = await get(["org_1", "runs", "01J", "illustration.png"]);

    expect(fetchArtifact).toHaveBeenCalledTimes(1);
    const [uri, options] = fetchArtifact.mock.calls[0]!;
    expect(uri).toBe("pipelex-storage://org_1/runs/01J/illustration.png");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    // Against the hosted API, a plain-http store link stays refused. The base
    // URL is stubbed rather than inherited: a developer working against the
    // local compose stack exports a plain-http one, and this assertion would
    // fail on their machine and nowhere else.
    expect(options.allowHttp).toBe(false);
    // The proxy's own bounds, not the SDK's disk-sized defaults: the byte cap
    // is what bounds an unauthenticated request while `mayRead` ships open,
    // and the time budget is spent by the client's own pull.
    expect(options.maxBytes).toBe(64 * 1024 * 1024);
    expect(options.timeoutMs).toBe(300_000);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="illustration.png"');
    expect(response.headers.get("cache-control")).toBe("private, max-age=300, must-revalidate");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("decodes a percent-encoded segment before rebuilding the reference", async () => {
    fetchArtifact.mockResolvedValueOnce(upstream(PNG_BYTES, { "content-type": "image/png" }));
    // Next hands the catch-all segments already decoded.
    await get(["org", "a b", "100%.png"]);
    expect(fetchArtifact.mock.calls[0]![0]).toBe("pipelex-storage://org/a b/100%.png");
  });

  it("sandboxes a document-capable type and names the file from the reference", async () => {
    fetchArtifact.mockResolvedValueOnce(
      upstream(new TextEncoder().encode("<svg/>"), { "content-type": "image/svg+xml" }),
    );
    const response = await get(["org", "diagram.svg"]);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox; frame-ancestors 'self'",
    );
    expect(response.headers.get("content-disposition")).toBe('inline; filename="diagram.svg"');
  });

  it("adds the extension the store's type implies when the reference has none", async () => {
    fetchArtifact.mockResolvedValueOnce(upstream(PNG_BYTES, { "content-type": "image/png" }));
    const response = await get(["org", "outputs", "image"]);
    expect(response.headers.get("content-disposition")).toBe('inline; filename="image.png"');
  });

  it("refuses a malformed path before resolving anything", async () => {
    const response = await get(["org", "..", "secret.png"]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_asset_path", message: expect.any(String) },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it("carries the framing and referrer guard on a refusal, as on a served asset", async () => {
    // `next.config.js` leaves this route out of the app's global framing and
    // referrer rules so a PDF can be framed same-origin, which makes the route
    // the only thing answering for its own responses. A refusal is one of them,
    // so it must not be the single response in the app with no framing policy.
    const response = await get(["org", "..", "secret.png"]);
    expect(response.status).toBe(400);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });

  it("answers 404 alike for a reference that is not the key's and one that names nothing", async () => {
    for (const code of ["forbidden", "not_found", "invalid_storage_uri"]) {
      fetchArtifact.mockRejectedValueOnce(
        new ArtifactFetchError("refused", "pipelex-storage://org/x.png", code),
      );
      const response = await get(["org", "x.png"]);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("asset_not_found");
    }
  });

  it("answers 502 for a fetch that failed on this side of the object", async () => {
    // `store_refused` belongs here and not with the 404s: it is the store
    // rejecting a signature this route has just minted, which is a clock, a
    // key or a bucket policy — an outage, not a missing asset.
    for (const code of [
      "timeout",
      "network",
      "store_error",
      "too_large",
      "redirect_refused",
      "store_refused",
    ]) {
      fetchArtifact.mockRejectedValueOnce(
        new ArtifactFetchError("failed", "pipelex-storage://org/x.png", code),
      );
      const response = await get(["org", "x.png"]);
      expect(response.status).toBe(502);
      expect((await response.json()).error.code).toBe("asset_unavailable");
    }
  });

  it("answers 502 when the resolve route refused the request or the API is unreachable", async () => {
    fetchArtifact.mockRejectedValueOnce(
      new ApiResponseError(
        "forbidden",
        "https://api.test",
        403,
        "Forbidden",
        "",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    );
    let response = await get(["org", "x.png"]);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("resolve_failed");

    // A deployment without the bulk route is named, because the single
    // `resolveStorageUrl` route working beside it is exactly what misleads.
    fetchArtifact.mockRejectedValueOnce(
      new ApiResponseError(
        "not found",
        "https://api.test",
        404,
        "Not Found",
        "",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    );
    response = await get(["org", "x.png"]);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("resolve_failed");
    expect(body.error.message).toContain("/v1/resolve-storage-url/bulk");

    fetchArtifact.mockRejectedValueOnce(
      new ApiUnreachableError("down", "https://api.test", "ECONNREFUSED"),
    );
    response = await get(["org", "x.png"]);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("api_unreachable");
  });

  it("hands on a Content-Encoding the SDK left, so encoded bytes stay labelled as such", async () => {
    // The SDK strips the pair only when fetch decoded the body, so a coding
    // still on the response means the bytes really are still encoded.
    fetchArtifact.mockResolvedValueOnce(
      upstream(PNG_BYTES, {
        "content-type": "image/png",
        "content-encoding": "zstd",
        "content-length": "8",
      }),
    );

    const response = await get(["org", "x.png"]);

    expect(response.headers.get("content-encoding")).toBe("zstd");
    expect(response.headers.get("content-length")).toBe("8");
  });

  it("answers a HEAD probe even when the upstream stream refuses to be cancelled", async () => {
    // A stream already locked or errored rejects on cancel, and the probe
    // still has to answer with the route's own headers.
    const refusing = {
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      body: { cancel: () => Promise.reject(new Error("already locked")) },
    } as unknown as Response;
    fetchArtifact.mockResolvedValueOnce(refusing);

    const response = await HEAD(new Request("http://localhost/api/assets/org/x.pdf"), {
      params: Promise.resolve({ path: ["org", "x.pdf"] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('inline; filename="x.pdf"');
  });

  it("accepts a plain-http store link only when the API itself is configured over plain http", async () => {
    vi.stubEnv("PIPELEX_BASE_URL", "http://localhost:8000");
    fetchArtifact.mockResolvedValueOnce(upstream(PNG_BYTES, { "content-type": "image/png" }));
    await get(["org", "x.png"]);
    expect(fetchArtifact.mock.calls[0]![1].allowHttp).toBe(true);
  });
});

describe("HEAD /api/assets/[...path]", () => {
  it("answers the same headers with no body, and releases the upstream stream", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = new ReadableStream<Uint8Array>({ cancel });
    fetchArtifact.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-type": "application/pdf" } }),
    );

    const request = new Request("http://app.test/api/assets/org/report.pdf", { method: "HEAD" });
    const response = await HEAD(request, {
      params: Promise.resolve({ path: ["org", "report.pdf"] }),
    });

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(cancel).toHaveBeenCalled();
  });
});
