// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiUnreachableError, ArtifactFetchError } from "@pipelex/sdk";
import {
  BRANDED,
  SQUARE_LOGO,
  SQUARE_LOGO_BYTES,
  WIDE_LOGO,
  WIDE_LOGO_BYTES,
  branding,
} from "@/test/fixtures/branding";

const fetchArtifact = vi.fn();
const readOrganizationBranding = vi.fn();

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ fetchArtifact }),
}));
vi.mock("@/lib/brandingRead", () => ({
  readOrganizationBranding: () => readOrganizationBranding(),
}));

type RouteModule = typeof import("./route");

/** A fresh route, so the bytes one test kept never serve the next. */
async function load(): Promise<RouteModule> {
  vi.resetModules();
  return import("./route");
}

function stored(bytes: Uint8Array): Response {
  return new Response(bytes.slice(), {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

function get(route: RouteModule, sha256: string, headers?: HeadersInit): Promise<Response> {
  const request = new Request(`http://app.test/api/branding/logo/${sha256}`, { headers });
  return route.GET(request, { params: Promise.resolve({ sha256 }) });
}

beforeEach(() => {
  fetchArtifact.mockReset();
  readOrganizationBranding.mockReset();
  vi.stubEnv("PIPELEX_BASE_URL", "https://api.pipelex.com");
});

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/branding/logo/[sha256]", () => {
  it("serves the logo with this digest, read through the SDK and checked against it", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValueOnce(BRANDED);
    fetchArtifact.mockResolvedValueOnce(stored(WIDE_LOGO_BYTES));

    const response = await get(route, WIDE_LOGO.sha256);

    expect(fetchArtifact).toHaveBeenCalledTimes(1);
    const [uri, options] = fetchArtifact.mock.calls[0]!;
    expect(uri).toBe(WIDE_LOGO.uri);
    // A logo is at most 1 MiB, so nothing larger is read; a hosted store link is https only.
    expect(options).toMatchObject({ maxBytes: 1024 * 1024, allowHttp: false });
    expect(options.signal).toBeUndefined();

    expect(response.status).toBe(200);
    // The type the platform read from the bytes, never the store's.
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe(`"${WIDE_LOGO.sha256}"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe(String(WIDE_LOGO_BYTES.byteLength));
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(WIDE_LOGO_BYTES);
  });

  it("keeps the bytes in memory under their digest, so a second view asks the API nothing", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValue(BRANDED);
    fetchArtifact.mockResolvedValueOnce(stored(SQUARE_LOGO_BYTES));

    await get(route, SQUARE_LOGO.sha256);
    const again = await get(route, SQUARE_LOGO.sha256);

    expect(fetchArtifact).toHaveBeenCalledTimes(1);
    expect(again.status).toBe(200);
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(SQUARE_LOGO_BYTES);
  });

  it("shares one read between requests that arrive while it is in flight", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValue(BRANDED);
    let answer!: (response: Response) => void;
    fetchArtifact.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const first = get(route, WIDE_LOGO.sha256);
    const second = get(route, WIDE_LOGO.sha256);
    await vi.waitFor(() => expect(fetchArtifact).toHaveBeenCalled());
    answer(stored(WIDE_LOGO_BYTES));

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fetchArtifact).toHaveBeenCalledTimes(1);
  });

  it("confirms the browser's copy with a 304, reading nothing", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValueOnce(BRANDED);
    const response = await get(route, WIDE_LOGO.sha256, {
      "if-none-match": `W/"${WIDE_LOGO.sha256}"`,
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(`"${WIDE_LOGO.sha256}"`);
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it("sandboxes an SVG logo", async () => {
    const route = await load();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const { sha256Of } = await import("@/test/fixtures/branding");
    const logo = { ...WIDE_LOGO, content_type: "image/svg+xml", sha256: sha256Of(svg) };
    readOrganizationBranding.mockResolvedValueOnce(branding({ wide_logo: logo }));
    fetchArtifact.mockResolvedValueOnce(stored(svg));

    const response = await get(route, logo.sha256);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });

  it("refuses a path that is not a digest, before reading anything", async () => {
    const route = await load();
    const response = await get(route, "../assets/org/secret.pdf");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_logo_path");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readOrganizationBranding).not.toHaveBeenCalled();
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it("answers 404 for a digest that names no current logo, or when the branding is unreadable", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValueOnce(branding({ wide_logo: WIDE_LOGO }));
    let response = await get(route, SQUARE_LOGO.sha256);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("logo_not_found");

    readOrganizationBranding.mockResolvedValueOnce(null);
    response = await get(route, WIDE_LOGO.sha256);
    expect(response.status).toBe(404);
    expect(fetchArtifact).not.toHaveBeenCalled();
  });

  it("answers 502 when the bytes do not hash to the digest, and keeps none of them", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValue(BRANDED);
    fetchArtifact
      .mockResolvedValueOnce(stored(SQUARE_LOGO_BYTES))
      .mockResolvedValueOnce(stored(WIDE_LOGO_BYTES));

    const response = await get(route, WIDE_LOGO.sha256);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("logo_digest_mismatch");

    // Nothing was kept: the next request reads again, and gets the right bytes.
    const retried = await get(route, WIDE_LOGO.sha256);
    expect(retried.status).toBe(200);
    expect(fetchArtifact).toHaveBeenCalledTimes(2);
  });

  it("answers 502 when the logo cannot be fetched, so the header falls back", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValue(BRANDED);
    fetchArtifact
      .mockRejectedValueOnce(new ArtifactFetchError("gone", WIDE_LOGO.uri, "not_found", 404))
      .mockRejectedValueOnce(new ApiUnreachableError("down", "https://api.test", "ECONNREFUSED"));

    let response = await get(route, WIDE_LOGO.sha256);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatchObject({ code: "logo_unavailable" });

    response = await get(route, WIDE_LOGO.sha256);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("api_unreachable");
  });

  it("drops a replaced logo's bytes once a current logo is read", async () => {
    const route = await load();
    readOrganizationBranding.mockResolvedValueOnce(BRANDED);
    fetchArtifact.mockResolvedValueOnce(stored(WIDE_LOGO_BYTES));
    await get(route, WIDE_LOGO.sha256);

    // The wide logo is removed; the square one is read and the wide one's bytes go.
    readOrganizationBranding.mockResolvedValueOnce(branding({ square_logo: SQUARE_LOGO }));
    fetchArtifact.mockResolvedValueOnce(stored(SQUARE_LOGO_BYTES));
    await get(route, SQUARE_LOGO.sha256);

    // Put back, the wide logo is read again rather than served from memory.
    readOrganizationBranding.mockResolvedValueOnce(BRANDED);
    fetchArtifact.mockResolvedValueOnce(stored(WIDE_LOGO_BYTES));
    const response = await get(route, WIDE_LOGO.sha256);
    expect(response.status).toBe(200);
    expect(fetchArtifact).toHaveBeenCalledTimes(3);
  });
});
