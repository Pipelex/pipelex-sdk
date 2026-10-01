import { describe, it, expect } from "vitest";
import { assetPath, isStorageUri, resolveStoredFile, storageUriFromSegments } from "./storageAsset";

describe("assetPath", () => {
  it("maps a storage reference onto the assets route, keeping the object's path and extension", () => {
    expect(assetPath("pipelex-storage://org_1/runs/01J/outputs/illustration.png")).toBe(
      "/api/assets/org_1/runs/01J/outputs/illustration.png",
    );
  });

  it("percent-encodes a segment so the route decodes exactly what was stored", () => {
    expect(assetPath("pipelex-storage://org/a b/report v2.pdf")).toBe(
      "/api/assets/org/a%20b/report%20v2.pdf",
    );
    expect(assetPath("pipelex-storage://org/100%.png")).toBe("/api/assets/org/100%25.png");
  });

  it("answers undefined for anything that is not a storage reference — the kernel then paints the payload's own URL", () => {
    expect(assetPath("https://bucket.s3.amazonaws.com/x.png?X-Amz-Signature=…")).toBeUndefined();
    expect(assetPath("data:image/png;base64,iVBORw0KGgo=")).toBeUndefined();
    expect(assetPath("/api/assets/already/a/path.png")).toBeUndefined();
    expect(assetPath("pipelex-storage://")).toBeUndefined();
    expect(assetPath("")).toBeUndefined();
  });

  it("refuses a reference whose segments would not round-trip", () => {
    expect(assetPath("pipelex-storage://org/../secrets.png")).toBeUndefined();
    expect(assetPath("pipelex-storage://org//double.png")).toBeUndefined();
    expect(assetPath("pipelex-storage://org/back\\slash.png")).toBeUndefined();
    expect(assetPath("pipelex-storage://org/line\nbreak.png")).toBeUndefined();
    expect(assetPath(`pipelex-storage://org/${"x".repeat(2048)}.png`)).toBeUndefined();
  });
});

describe("resolveStoredFile", () => {
  it("answers the assets route for a stored reference, for the input preview", async () => {
    await expect(resolveStoredFile("pipelex-storage://org_1/assets/cv.pdf")).resolves.toBe(
      assetPath("pipelex-storage://org_1/assets/cv.pdf"),
    );
  });

  it("answers null — the kernel's 'cannot resolve' — for anything else", async () => {
    await expect(resolveStoredFile("https://example.com/cv.pdf")).resolves.toBeNull();
  });
});

describe("storageUriFromSegments", () => {
  it("rebuilds the reference from the route's decoded segments", () => {
    expect(storageUriFromSegments(["org_1", "runs", "01J", "illustration.png"])).toBe(
      "pipelex-storage://org_1/runs/01J/illustration.png",
    );
  });

  it("round-trips with assetPath through URL decoding", () => {
    const uri = "pipelex-storage://org/a b/100%.png";
    const path = assetPath(uri)!;
    const segments = path.slice("/api/assets/".length).split("/").map(decodeURIComponent);
    expect(storageUriFromSegments(segments)).toBe(uri);
  });

  it("refuses what is not a plain, traversal-free path", () => {
    expect(storageUriFromSegments(undefined)).toBeUndefined();
    expect(storageUriFromSegments([])).toBeUndefined();
    expect(storageUriFromSegments(["org", "..", "x.png"])).toBeUndefined();
    expect(storageUriFromSegments(["org", "", "x.png"])).toBeUndefined();
    expect(storageUriFromSegments(["org", "a/b"])).toBeUndefined();
    expect(storageUriFromSegments(Array.from({ length: 25 }, () => "s"))).toBeUndefined();
  });
});

describe("isStorageUri", () => {
  it("is the scheme followed by at least one character, on a string", () => {
    expect(isStorageUri("pipelex-storage://x")).toBe(true);
    expect(isStorageUri("pipelex-storage://")).toBe(false);
    expect(isStorageUri("https://x")).toBe(false);
    expect(isStorageUri(42)).toBe(false);
    expect(isStorageUri(null)).toBe(false);
  });
});
