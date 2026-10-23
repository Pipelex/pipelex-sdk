/**
 * The hook's networked validate stage: one deadline over the whole stage, the version handshake,
 * the blob route, the uploads and the validation together, whose expiry reads as `unavailable`,
 * as every other no-verdict condition does, so the lint and format verdicts already applied stand.
 * And what leaves the machine: never a file of the tree that looks like a secret, which the hook's
 * output names with why, and nothing at all when a bundle looks like one.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PipelexApiClient } from "../../src/client.js";
import {
  decideAfterValidate,
  encodeOutcome,
  mergeOutcomes,
  type HookOutcome,
} from "../../src/hooks/check-core.js";
import { runValidateStage } from "../../src/hooks/validate-stage.js";
import {
  fake,
  NOTICE_BUNDLE,
  NOTICE_TEMPLATE,
  REPORTED_CASE_SECRETS,
  writeReportedCase,
} from "../helpers/fake-secrets.js";

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

/**
 * The deadline of the cases a held request runs into. The deadline starts before the gatherer
 * lists the directory, so it must outlast that listing on a loaded machine, as when the whole
 * suite runs in parallel workers, or it fires before the held request is even sent; a held
 * request still ends at it, so it bounds how long each such case takes.
 */
const HELD_DEADLINE_MS = 1_000;

describe("runValidateStage", () => {
  it("reads the verdict of a validation that finishes within the deadline", async () => {
    playApi(() => false);
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(stage).toEqual({ status: "valid", pendingSignatures: ["d.p"], withheld: [] });
  });

  it("is unavailable when the handshake outlasts the deadline, which stops it", async () => {
    const api = playApi((url) => url.endsWith("/v1/version"));
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: HELD_DEADLINE_MS });

    expect(stage).toEqual({ status: "unavailable" });
    expect(api.stopped).toEqual(["/v1/version"]);
  });

  it("is unavailable when an upload outlasts the deadline, which stops it", async () => {
    const api = playApi((url) => !url.startsWith(BASE_URL));
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);
    // Past the inline threshold, so the tree travels by hash and its files are uploaded.
    writeFileSync(join(root, "big.txt"), "x".repeat(300 * 1024));

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: HELD_DEADLINE_MS });

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

  it("is unavailable when the gather throws, rather than rejecting the hook", async () => {
    // A fresh copy of the stage over a gatherer that throws, the mock kept to this case.
    vi.resetModules();
    vi.doMock("../../src/hooks/bundle-gather.js", () => ({
      gatherMethodTree: () => Promise.reject(new Error("the gatherer failed")),
    }));
    try {
      const fresh = await import("../../src/hooks/validate-stage.js");
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const stage = await fresh.runValidateStage(join(root, "main.mthds"), {
        client: client(),
        timeoutMs: 5_000,
      });

      expect(stage).toEqual({ status: "unavailable" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../../src/hooks/bundle-gather.js");
      vi.resetModules();
    }
  });
});

/** One request the client made: its method, where it went, and its body as text. */
interface SentRequest {
  method: string;
  where: string;
  body: string;
}

/**
 * Play an API keeping a blob store and answering `verdict` to the validation, recording every
 * request made, the uploads to storage among them, each body read one character per byte.
 */
function recordApi(verdict: unknown): SentRequest[] {
  const sent: SentRequest[] = [];
  const asText = (body: unknown): string =>
    typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder("latin1").decode(body)
        : body == null
          ? ""
          : String(body);
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const path = new URL(url).pathname;
      const where = url.startsWith(BASE_URL) ? path : `upload ${path.slice(1)}`;
      sent.push({ method: init.method ?? "GET", where, body: asText(init.body) });
      if (!url.startsWith(BASE_URL)) return new Response(null, { status: 200 });
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
      return jsonResponse(200, verdict);
    },
  );
  return sent;
}

const VALID = { is_valid: true, pending_signatures: [], is_runnable: true };

/** What the hook writes for one file's outcome, merged and encoded as it emits it, on Claude. */
function hookOutput(outcome: HookOutcome): string {
  const encoded = JSON.parse(encodeOutcome(mergeOutcomes([outcome]), "claude")) as {
    reason?: string;
    hookSpecificOutput?: { additionalContext: string };
  };
  return encoded.reason ?? encoded.hookSpecificOutput!.additionalContext;
}

const sha256Of = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("runValidateStage, on a tree holding secrets", () => {
  it("sends the reported case's bundle and template inline, and none of its secret files", async () => {
    const { dir, edited } = writeReportedCase(root);
    const sent = recordApi(VALID);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(sent.map((request) => `${request.method} ${request.where}`)).toEqual([
      "GET /v1/version",
      "POST /v1/validate",
    ]);
    const body = JSON.parse(sent[1]!.body) as { files: Record<string, unknown> };
    expect(body.files).toEqual({ "main.mthds": NOTICE_BUNDLE, "notice.html": NOTICE_TEMPLATE });
    for (const request of sent) {
      for (const secret of REPORTED_CASE_SECRETS) expect(request.body).not.toContain(secret);
    }
    expect(stage).toEqual({
      status: "valid",
      pendingSignatures: [],
      withheld: [
        { path: join(dir, "key.pem"), reason: "it holds a private key block (PEM)" },
        {
          path: join(dir, "secrets.yaml"),
          reason: "it holds an AWS access key id and an Anthropic API key",
        },
        { path: join(dir, "service-account.json"), reason: "it holds a private key block (PEM)" },
      ],
    });
  });

  it("says in the hook's output which file stayed home and why, quoting none of it", async () => {
    const { dir, edited } = writeReportedCase(root);
    recordApi(VALID);

    const outcome = decideAfterValidate(
      edited,
      await runValidateStage(edited, { client: client(), timeoutMs: 5_000 }),
    );

    expect(outcome.kind).toBe("context");
    const output = hookOutput(outcome);
    expect(output.split("\n").slice(0, 4)).toEqual([
      "The .mthds hook kept these files of the method's tree on this machine, since each looks " +
        "like a secret, and validated the method without them:",
      `- \`${join(dir, "key.pem")}\` (it holds a private key block (PEM))`,
      `- \`${join(dir, "secrets.yaml")}\` (it holds an AWS access key id and an Anthropic API key)`,
      `- \`${join(dir, "service-account.json")}\` (it holds a private key block (PEM))`,
    ]);
    // `.env` never reaches the guard: the membership rule keeps a dotfile out of the tree.
    expect(output).not.toContain(join(dir, ".env"));
    for (const secret of [...REPORTED_CASE_SECRETS, fake.aws.slice(4), fake.anthropic.slice(7)]) {
      expect(output).not.toContain(secret);
    }
  });

  it("names and uploads only the files it sends when the tree travels by hash", async () => {
    const { dir, edited } = writeReportedCase(root);
    // Past the inline threshold, so the tree travels by hash and its files are uploaded.
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "rates.csv"), "rate\n".repeat(80 * 1024));
    const sent = recordApi(VALID);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(stage.status).toBe("valid");
    const kept = ["data/rates.csv", "main.mthds", "notice.html"];
    const keptBlobs = kept.map((path) => sha256Of(join(dir, ...path.split("/")))).sort();
    const blobRoute = sent.find((request) => request.where === "/v1/blobs/missing")!;
    const asked = (JSON.parse(blobRoute.body) as { blobs: { sha256: string }[] }).blobs;
    expect(asked.map((blob) => blob.sha256).sort()).toEqual(keptBlobs);
    expect(
      sent
        .filter((request) => request.where.startsWith("upload "))
        .map((request) => request.where.slice("upload ".length))
        .sort(),
    ).toEqual(keptBlobs);
    const validation = sent.find((request) => request.where === "/v1/validate")!;
    expect(Object.keys((JSON.parse(validation.body) as { files: object }).files).sort()).toEqual(
      kept,
    );
    for (const request of sent) {
      for (const secret of REPORTED_CASE_SECRETS) expect(request.body).not.toContain(secret);
    }
  });

  it("refuses before any request when a bundle looks like a secret, and says so", async () => {
    const { dir, edited } = writeReportedCase(root);
    writeFileSync(edited, `${NOTICE_BUNDLE}\n# token = "${fake.anthropic}"\n`);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stage).toEqual({
      status: "refused",
      root: dir,
      withheld: [
        { path: edited, reason: "it holds an Anthropic API key" },
        { path: join(dir, "key.pem"), reason: "it holds a private key block (PEM)" },
        {
          path: join(dir, "secrets.yaml"),
          reason: "it holds an AWS access key id and an Anthropic API key",
        },
        { path: join(dir, "service-account.json"), reason: "it holds a private key block (PEM)" },
      ],
    });
    const outcome = decideAfterValidate(edited, stage);
    expect(outcome.kind).toBe("context");
    const output = hookOutput(outcome);
    expect(output).toContain(`The .mthds hook did not validate the method at \`${dir}\``);
    expect(output).toContain(`- \`${edited}\` (it holds an Anthropic API key)`);
    for (const secret of REPORTED_CASE_SECRETS) expect(output).not.toContain(secret);
  });
});

describe("runValidateStage, on an invalid verdict", () => {
  /** The faults of an invalid verdict, as a runner speaking the MTHDS problem document lists them. */
  const PROBLEM_ITEMS = [
    {
      code: "method.input_undeclared",
      detail: "Pipe 'greet_visitor' reads names its inputs do not declare: visitor.",
      params: { pipe: "greet_visitor", variables: ["visitor"] },
      location: { pipe: "greet_visitor", file: "main.mthds" },
    },
    {
      code: "method.model_unknown",
      detail: "The llm model 'gpt-5.1' is not one the runtime knows.",
      location: { pipe: "greet_visitor" },
      suggestions: ["gpt-5"],
      suggested_fix: {
        fix_code: "rename-model",
        description: "Use the model 'gpt-5' in place of 'gpt-5.1'.",
        safety: "safe",
        ops: [
          {
            kind: "remap_value",
            table_path: ["pipe", "greet_visitor"],
            key: "model",
            mapping: { "gpt-5.1": "gpt-5" },
          },
        ],
      },
    },
  ];
  const INVALID = {
    is_valid: false,
    errors: PROBLEM_ITEMS,
    pending_signatures: [],
    is_runnable: false,
    message: "The method does not validate.",
  };

  it("reads the verdict's problem items, its message and the server's Markdown", async () => {
    recordApi({ ...INVALID, rendered_markdown: "# Validation failed" });
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(stage).toEqual({
      status: "invalid",
      message: "The method does not validate.",
      errors: [
        {
          code: "method.input_undeclared",
          detail: "Pipe 'greet_visitor' reads names its inputs do not declare: visitor.",
          location: { pipe: "greet_visitor", file: "main.mthds" },
        },
        {
          code: "method.model_unknown",
          detail: "The llm model 'gpt-5.1' is not one the runtime knows.",
          location: { pipe: "greet_visitor" },
          suggested_fix: PROBLEM_ITEMS[1]!.suggested_fix,
        },
      ],
      renderedMarkdown: "# Validation failed",
      withheld: [],
    });
  });

  it("blocks without the server's Markdown naming each item by its code, sentence and place", async () => {
    recordApi(INVALID);
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const outcome = decideAfterValidate(
      edited,
      await runValidateStage(edited, { client: client(), timeoutMs: 5_000 }),
    );

    expect(outcome.kind).toBe("block");
    expect(hookOutput(outcome)).toBe(
      [
        `Validation failed for ${edited}:`,
        "",
        "The method does not validate.",
        "",
        "- `method.input_undeclared`: Pipe 'greet_visitor' reads names its inputs do not " +
          "declare: visitor. (pipe 'greet_visitor', file 'main.mthds')",
        "- `method.model_unknown`: The llm model 'gpt-5.1' is not one the runtime knows. " +
          "(pipe 'greet_visitor')",
        "  - Suggested fix (safe, rename-model): Use the model 'gpt-5' in place of 'gpt-5.1'.",
      ].join("\n"),
    );
  });

  it("reads each item member by member, leaving out what it cannot read", async () => {
    recordApi({
      is_valid: false,
      errors: [
        "not an item",
        null,
        { detail: "An item with no code names no fault." },
        { code: "method.no_detail" },
        { code: "method.located_badly", detail: "Its location is no object.", location: null },
        {
          code: "method.fixed_badly",
          detail: "Its fix has no description.",
          location: "pipe 'x'",
          suggested_fix: { fix_code: "no-description", safety: "safe", ops: [] },
        },
      ],
      message: 42,
      rendered_markdown: ["not", "text"],
    });
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(stage).toEqual({
      status: "invalid",
      message: undefined,
      errors: [
        { code: "method.located_badly", detail: "Its location is no object." },
        { code: "method.fixed_badly", detail: "Its fix has no description." },
      ],
      renderedMarkdown: undefined,
      withheld: [],
    });
    expect(hookOutput(decideAfterValidate(edited, stage))).toBe(
      [
        `Validation failed for ${edited}:`,
        "",
        "Bundle is invalid.",
        "",
        "- `method.located_badly`: Its location is no object.",
        "- `method.fixed_badly`: Its fix has no description.",
      ].join("\n"),
    );
  });

  it("no longer reads the retired `validation_errors[]`", async () => {
    recordApi({
      is_valid: false,
      validation_errors: [{ category: "pipe_validation", message: "unknown concept" }],
      message: "The method does not validate.",
    });
    const edited = join(root, "main.mthds");
    writeFileSync(edited, MAIN);

    const stage = await runValidateStage(edited, { client: client(), timeoutMs: 5_000 });

    expect(stage).toEqual({
      status: "invalid",
      message: "The method does not validate.",
      errors: [],
      renderedMarkdown: undefined,
      withheld: [],
    });
  });
});
