import { describe, expect, it } from "vitest";
import { buildLogoHeaders, logoEtag, matchesEtag } from "@/lib/logoHeaders";

const DIGEST = "a".repeat(64);

describe("buildLogoHeaders", () => {
  it("serves a raster logo inline under its digest, cached privately for a year", () => {
    const headers = buildLogoHeaders({ sha256: DIGEST, contentType: "image/webp" }, 42);
    expect(Object.fromEntries(headers)).toEqual({
      "content-type": "image/webp",
      "content-disposition": "inline",
      "cache-control": "private, max-age=31536000, immutable",
      etag: `"${DIGEST}"`,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-length": "42",
    });
  });

  it("sandboxes an SVG, which a browser could otherwise open as a document", () => {
    const headers = buildLogoHeaders({ sha256: DIGEST, contentType: "image/svg+xml" });
    expect(headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(headers.get("content-length")).toBeNull();
  });
});

describe("matchesEtag", () => {
  it("matches the logo's tag, weak or strong, in a list, or a wildcard", () => {
    expect(matchesEtag(logoEtag(DIGEST), DIGEST)).toBe(true);
    expect(matchesEtag(`W/${logoEtag(DIGEST)}`, DIGEST)).toBe(true);
    expect(matchesEtag(`"other", ${logoEtag(DIGEST)}`, DIGEST)).toBe(true);
    expect(matchesEtag("*", DIGEST)).toBe(true);
  });

  it("matches nothing else", () => {
    expect(matchesEtag(null, DIGEST)).toBe(false);
    expect(matchesEtag(`"${"b".repeat(64)}"`, DIGEST)).toBe(false);
    expect(matchesEtag(DIGEST, DIGEST)).toBe(false);
  });
});
