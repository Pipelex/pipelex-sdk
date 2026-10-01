import { describe, it, expect } from "vitest";
import type { RunResults } from "@pipelex/sdk";
import { parseGeneratedImage } from "./generateImagePipeline";
import { BadImageOutputError } from "./pipelineError";

/** Both paths deliver the resolved output on `main_stuff` (the SDK digs it out on the blocking path too). */
function mainStuff(content: unknown): RunResults {
  return { pipeline_run_id: "run-123", main_stuff: content };
}

describe("parseGeneratedImage", () => {
  it("extracts an image with a remote URL and web public_url", () => {
    const result = parseGeneratedImage(
      mainStuff({
        url: "https://storage.pipelex.com/generated/abc.png",
        public_url: "https://cdn.pipelex.com/abc.png",
        mime_type: "image/png",
        caption: "A robot",
      }),
    );
    expect(result).toEqual({
      url: "https://storage.pipelex.com/generated/abc.png",
      public_url: "https://cdn.pipelex.com/abc.png",
      mime_type: "image/png",
      caption: "A robot",
    });
  });

  it("extracts the durable hosted shape verbatim: non-web url, web public_url, explicit nulls", () => {
    // Captured live from api-dev: `url` is a non-web pipelex-storage URI,
    // `public_url` a signed S3 URL, and every unset optional field arrives as
    // an explicit `null` (pydantic serializes `None`, it does not omit the
    // key). Since the trees were regenerated on engine 0.56.0 the schema models
    // those as `.nullish()`, so the null now survives the narrower as a null
    // rather than being stripped to absence — both read as "unset", and the
    // narrower's job is that neither one fails the parse.
    const result = parseGeneratedImage(
      mainStuff({
        url: "pipelex-storage://org/runs/run_1/generated/abc.png",
        public_url: "https://s3.us-west-2.amazonaws.com/bucket/abc.png?X-Amz-Signature=abc",
        source_prompt: "A simple red circle on a plain white background.",
        source_negative_prompt: null,
        caption: null,
        mime_type: "image/png",
        width: 1024,
        height: 1024,
        filename: null,
      }),
    );
    expect(result.url).toBe("pipelex-storage://org/runs/run_1/generated/abc.png");
    expect(result.public_url).toContain("https://s3");
    expect(result.mime_type).toBe("image/png");
    expect(result.width).toBe(1024);
    // A `.nullish()` field keeps the wire's null; the point is that it parses.
    expect(result.caption).toBeNull();
    expect(result.filename).toBeNull();
  });

  it("treats an empty public_url as absent and falls back to url", () => {
    // `.optional()` accepts `""`, and `""` is not nullish — so a `??` fallback
    // would let it beat a perfectly good `url` and fail the run.
    const result = parseGeneratedImage(mainStuff({ url: "https://x/y.png", public_url: "" }));
    expect(result.url).toBe("https://x/y.png");
  });

  it("extracts an image delivered as a base64 data URL", () => {
    const result = parseGeneratedImage(mainStuff({ url: "data:image/png;base64,AAAA" }));
    expect(result.url).toBe("data:image/png;base64,AAAA");
    expect(result.public_url).toBeUndefined();
    expect(result.mime_type).toBeUndefined();
    expect(result.caption).toBeUndefined();
  });

  it("refuses a data: URL whose media type is not an image", () => {
    // Not an image-decoding concern: the result view puts the same string in an
    // `<a download>`, so a text/html payload would be saved as a file that runs
    // on a file:// origin when opened.
    expect(() =>
      parseGeneratedImage(mainStuff({ url: "data:text/html;base64,PHNjcmlwdD4=" })),
    ).toThrow(BadImageOutputError);
  });

  it("refuses a data: URL with no media type at all", () => {
    // `data:,Hello` defaults to text/plain — an image pipeline never emits it.
    expect(() => parseGeneratedImage(mainStuff({ url: "data:,Hello" }))).toThrow(
      BadImageOutputError,
    );
  });

  it("accepts an image data: URL whose media type carries parameters", () => {
    const url = "data:image/png;charset=utf-8,AAAA";
    expect(parseGeneratedImage(mainStuff({ url })).url).toBe(url);
  });

  it.each(["image/jpeg", "image/webp"])("accepts a %s data: URL", (mediaType) => {
    const url = `data:${mediaType};base64,AAAA`;
    expect(parseGeneratedImage(mainStuff({ url })).url).toBe(url);
  });

  it("refuses an SVG data: URL, which is an image type but active content", () => {
    // The reason is the download link, not the <img>: scripts are inert inside
    // an <img>, but the saved file executes them when opened as a document.
    expect(() =>
      parseGeneratedImage(
        mainStuff({
          url: "data:image/svg+xml,%3Csvg%3E%3Cscript%3Ex()%3C%2Fscript%3E%3C%2Fsvg%3E",
        }),
      ),
    ).toThrow(BadImageOutputError);
    expect(() =>
      parseGeneratedImage(mainStuff({ url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })),
    ).toThrow(BadImageOutputError);
  });

  it("matches the media type case-insensitively, so an uppercased SVG is still refused", () => {
    // A regression in the case-folding would silently reopen the SVG hole.
    expect(() =>
      parseGeneratedImage(mainStuff({ url: "data:IMAGE/SVG+XML,%3Csvg%2F%3E" })),
    ).toThrow(BadImageOutputError);
  });

  it("refuses an inert image type the platform does not produce", () => {
    // The gate is an allow-list, not an `image/` prefix match: a GIF is inert,
    // but it is not one of the types a Pipelex run returns.
    expect(() =>
      parseGeneratedImage(mainStuff({ url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" })),
    ).toThrow(BadImageOutputError);
  });

  it("throws BadImageOutputError when main_stuff carries no url", () => {
    expect(() => parseGeneratedImage(mainStuff({ caption: "no url here" }))).toThrow(
      BadImageOutputError,
    );
  });

  it("throws BadImageOutputError when the URL is an empty string", () => {
    expect(() => parseGeneratedImage(mainStuff({ url: "" }))).toThrow(BadImageOutputError);
  });

  it.each(["file:///tmp/storage/abc.png", "pipelex-storage://anonymous/uuid/abc.png"])(
    "rejects a non-web image URL with no web public_url: %s",
    (url) => {
      try {
        parseGeneratedImage(mainStuff({ url }));
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BadImageOutputError);
        expect((err as BadImageOutputError).nonWebUrl).toBe(url);
      }
    },
  );

  it("rejects a file:// public_url even when url is web-renderable", () => {
    // The result view displays public_url ?? url, so a bad public_url wins.
    try {
      parseGeneratedImage(
        mainStuff({
          url: "https://storage.pipelex.com/abc.png",
          public_url: "file:///tmp/storage/abc.png",
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BadImageOutputError);
      expect((err as BadImageOutputError).nonWebUrl).toBe("file:///tmp/storage/abc.png");
    }
  });

  it("throws when main_stuff is not the expected object (a list output / scalar)", () => {
    expect(() => parseGeneratedImage(mainStuff(null))).toThrow(BadImageOutputError);
    expect(() => parseGeneratedImage(mainStuff([{ url: "https://x" }]))).toThrow(
      BadImageOutputError,
    );
  });
});
