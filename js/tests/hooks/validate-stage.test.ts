/**
 * The hook's networked validate stage: one deadline over the whole stage, the version handshake,
 * the blob route, the uploads and the validation together, whose expiry reads as `unavailable`,
 * as every other no-verdict condition does, so the lint and format verdicts already applied stand.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelexApiClient } from "../../src/client.js";
import { runValidateStage } from "../../src/hooks/validate-stage.js";

const BASE_URL = "http://localhost:8081";
const MAIN = 'domain = "d"\nmain_pipe = "p"\n';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hook-validate-stage-")));
  // An entry named `.git` stops Manifest Discovery here, whatever lies above the scratch directory.
  writeFileSync(join(root, ".git"), "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A request held until its signal aborts, then failed as fetch fails on an abort. */
function untilAborted(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init.signal!;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Play the API, holding every request `held` names until the stage's deadline stops it. */
function playApi(held: (url: string) => boolean): { stopped: string[] } {
  const stopped: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (held(url)) {
        try {
          return await untilAborted(init);
        } catch (err) {
          stopped.push(url.startsWith(BASE_URL) ? new URL(url).pathname : "upload");
          throw err;
        }
      }
      if (!url.startsWith(BASE_URL)) return new Response(null, { status: 200 });
      const path = new URL(url).pathname;
      if (path === "/v1/version") {
        return jsonResponse(200, {
          protocol_version: "1",
          runner_version: "0.90.0",
          blob_store: true,
        });
      }
      if (path === "/v1/blobs/missing") {
        const { blobs } = JSON.parse(init.body as string) as {
          blobs: { sha256: string; size: number }[];
        };
        return jsonResponse(200, {
          missing: blobs.map((blob) => ({
            ...blob,
            upload: { method: "PUT", url: `https://storage.example/${blob.sha256}`, headers: {} },
          })),
        });
      }
      return jsonResponse(200, { is_valid: true, pending_signatures: ["d.p"], is_runnable: false });
    },
  );
  return { stopped };
}

function client(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

describe("runValidateStage", () => {
  it("reads the verdict of a validation that finishes within the deadline", async () => {
    playApi(() => false);
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(stage).toEqual({ status: "valid", pendingSignatures: ["d.p"] });
  });

  it("is unavailable when the handshake outlasts the deadline, which stops it", async () => {
    const api = playApi((url) => url.endsWith("/v1/version"));
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 50 });

    expect(stage).toEqual({ status: "unavailable" });
    expect(api.stopped).toEqual(["/v1/version"]);
  });

  it("is unavailable when an upload outlasts the deadline, which stops it", async () => {
    const api = playApi((url) => !url.startsWith(BASE_URL));
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);
    // Past the inline threshold, so the tree travels by hash and its files are uploaded.
    writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 50 });

    expect(stage).toEqual({ status: "unavailable" });
    expect(api.stopped.length).toBeGreaterThan(0);
    expect(api.stopped.every((what) => what === "upload")).toBe(true);
  });

  it("is unavailable with no API key, before anything is sent", async () => {
    vi.stubEnv("PIPELEX_API_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    expect(await runValidateStage(edited)).toEqual({ status: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
