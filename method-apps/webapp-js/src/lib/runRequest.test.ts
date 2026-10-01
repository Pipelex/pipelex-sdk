import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { MAX_RUN_INPUT_BYTES, runInputBytes } from "./runRequest";

const require = createRequire(import.meta.url);

describe("runInputBytes", () => {
  it("counts the inputs' JSON in UTF-8 bytes", () => {
    expect(runInputBytes({ text: "abc" })).toBe('{"text":"abc"}'.length);
    // "é" is one character and two bytes.
    expect(runInputBytes({ text: "é" })).toBe('{"text":""}'.length + 2);
  });

  it("answers null for inputs that do not serialize as JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(runInputBytes(cyclic)).toBeNull();
    expect(runInputBytes({ count: BigInt(1) })).toBeNull();
    expect(runInputBytes(undefined)).toBeNull();
  });
});

describe("MAX_RUN_INPUT_BYTES", () => {
  it("stays under the Server Action body limit next.config.js leaves in place", () => {
    // The limit is Next's 1 MiB default only while nothing raises it. Raising
    // `serverActions.bodySizeLimit` without moving this constant would refuse
    // inputs the server now takes; lowering it would let the form send a body
    // the server refuses, which reads as "Could not reach the server".
    const config = require("../../next.config.js") as {
      serverActions?: { bodySizeLimit?: unknown };
      experimental?: { serverActions?: { bodySizeLimit?: unknown } };
    };
    expect(config.experimental?.serverActions?.bodySizeLimit).toBeUndefined();
    expect(config.serverActions?.bodySizeLimit).toBeUndefined();
    expect(MAX_RUN_INPUT_BYTES).toBeLessThan(1024 * 1024);
  });
});
