import { describe, it, expect } from "vitest";
import {
  assetFilename,
  buildAssetHeaders,
  contentDisposition,
  isDocumentCapable,
  isInlineRenderable,
} from "./assetHeaders";

describe("buildAssetHeaders", () => {
  it("serves an image inline, nosniffed, privately cached, and framed only by this origin", () => {
    const headers = buildAssetHeaders(
      new Headers({ "content-type": "image/png", "content-length": "1234", etag: '"abc"' }),
      { filename: "illustration.png" },
    );

    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-disposition")).toBe('inline; filename="illustration.png"');
    expect(headers.get("cache-control")).toBe("private, max-age=300, must-revalidate");
    // Rule 2 is scoped to document-capable types: a raster is not one.
    // Framing is allowed, same-origin only: the document preview's iframe now
    // points at this origin, so a policy that blocked framing outright would
    // break the viewer the route exists to feed.
    expect(headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // What describes the bytes handed on is kept.
    expect(headers.get("content-length")).toBe("1234");
    expect(headers.get("etag")).toBe('"abc"');
  });

  it("sandboxes a document-capable type so it cannot act on this origin", () => {
    for (const type of ["image/svg+xml", "text/html; charset=utf-8", "application/xml"]) {
      const headers = buildAssetHeaders(new Headers({ "content-type": type }));
      expect(headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox; frame-ancestors 'self'",
      );
      expect(headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("serves a PDF inline and unsandboxed, so the browser's viewer keeps working", () => {
    const headers = buildAssetHeaders(new Headers({ "content-type": "application/pdf" }), {
      filename: "report.pdf",
    });
    expect(headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
    expect(headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  });

  it("makes an unknown type a download rather than something to interpret", () => {
    const headers = buildAssetHeaders(new Headers({ "content-type": "application/zip" }), {
      filename: "bundle.zip",
    });
    expect(headers.get("content-disposition")).toBe('attachment; filename="bundle.zip"');
  });

  it("falls back to octet-stream, as an attachment, when the store declared no type", () => {
    const headers = buildAssetHeaders(new Headers());
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("content-disposition")).toBe("attachment");
  });

  it("does not advertise ranges it cannot honour", () => {
    const headers = buildAssetHeaders(
      new Headers({ "content-type": "image/png", "accept-ranges": "bytes" }),
    );
    expect(headers.get("accept-ranges")).toBeNull();
  });
});

describe("assetFilename", () => {
  it("names the file after the last segment of its storage key", () => {
    expect(
      assetFilename("pipelex-storage://org_1/runs/01J/outputs/2325fcfe.png", "image/png"),
    ).toBe("2325fcfe.png");
    expect(assetFilename("pipelex-storage://report.pdf", null)).toBe("report.pdf");
  });

  it("adds the extension a run's type implies when the key carries none, and only then", () => {
    expect(assetFilename("pipelex-storage://org/outputs/image", "image/png; charset=x")).toBe(
      "image.png",
    );
    expect(assetFilename("pipelex-storage://org/outputs/photo.jpeg", "image/png")).toBe(
      "photo.jpeg",
    );
    expect(assetFilename("pipelex-storage://org/outputs/blob", "application/zip")).toBe("blob");
  });

  it("reduces the name so it can never be hidden, traverse, or break out of the header", () => {
    expect(assetFilename('pipelex-storage://org/a b/100% ré"s.png', "image/png")).toBe(
      "100__r__s.png",
    );
    expect(assetFilename("pipelex-storage://org/..hidden.pdf", null)).toBe("hidden.pdf");
    expect(assetFilename("pipelex-storage://org/…", "application/pdf")).toBe("asset.pdf");
  });

  it("cuts a long name to the cap and keeps its extension", () => {
    const name = assetFilename(`pipelex-storage://org/${"a".repeat(300)}.pdf`, null);
    expect(name).toHaveLength(128);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("contentDisposition", () => {
  it("keeps a quote or a backslash in a filename from breaking out of the header", () => {
    expect(contentDisposition("image/png", 'a"b\\c.png')).toBe('inline; filename="a_b_c.png"');
  });

  it("replaces non-ASCII rather than emitting it raw", () => {
    expect(contentDisposition("application/pdf", "résumé.pdf")).toBe(
      'inline; filename="r_sum_.pdf"',
    );
  });
});

describe("type predicates", () => {
  it("match on the base type, ignoring parameters and case", () => {
    expect(isInlineRenderable("IMAGE/WEBP")).toBe(true);
    expect(isInlineRenderable("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineRenderable("text/html")).toBe(false);
    expect(isDocumentCapable("Text/HTML; charset=utf-8")).toBe(true);
    expect(isDocumentCapable("image/png")).toBe(false);
  });
});
