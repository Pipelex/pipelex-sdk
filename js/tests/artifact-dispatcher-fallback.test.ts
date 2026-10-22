/**
 * `fetchArtifact` when the Node host cannot be loaded: the fetch runs on the platform's default
 * dispatcher, with only the overall budget applied, rather than failing. The undici dispatcher is
 * a Node refinement (`docs/artifact-download.md`), so losing it never loses the fetch. The host is
 * mocked to fail here, in a file of its own, so the mock touches no other suite.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchArtifact } from "../src/artifacts.js";
import type { ArtifactCapableClient, ResolvedArtifact } from "../src/artifacts.js";

vi.mock("#node-host", () => {
  throw new Error("the Node host cannot be loaded");
});

const URI = "pipelex-storage://org/runs/01JRUN/outputs/illustration.png";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

/** A client resolving `URI` to a fresh link; nothing else is called. */
function makeClient(): Pick<ArtifactCapableClient, "resolveStorageUrls"> {
  return {
    async resolveStorageUrls(input) {
      const items: ResolvedArtifact[] = input.uris.map((uri) => ({
        uri,
        url: `https://store.example/${encodeURIComponent(uri)}?sig=abc`,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        content_type: "image/png",
        error: null,
      }));
      return { items };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchArtifact without the Node host", () => {
  it("fetches on the platform's default dispatcher", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response(BYTES, { status: 200 })));

    const response = await fetchArtifact(makeClient(), URI);

    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0] as [URL, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeUndefined();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });
});
