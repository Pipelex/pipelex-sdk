// @vitest-environment node
//
// The proof that a scaffolded slice is a working part of this app.
//
// The template ships no method, so no committed slice compiles on every
// `make all` the way the gallery's do. In its place this test copies the whole
// tree to a temporary directory, runs the real `add-method` there against
// recorded API responses — one slice for each source kind — and then asks the
// tools that gate a real project: `tsc` over the whole tree, ESLint over the
// emitted files, the offline codegen check over each new generated tree, and
// vitest over each emitted action test.
// A template edit that breaks what the scaffold writes fails here, not in the
// next person's project.
//
// The recorded responses are real and complete, stamps included
// (`./fixtures/recorded/`), so nothing in the SDK is mocked: the self-check the
// scaffold runs before writing and the check that follows are the real ones.
// The slices are named `fixture-…`, so the test also runs in a project that
// already has methods of its own — they are copied along and compiled with the
// rest.

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PipelexApiClient } from "@pipelex/sdk";

import { runAddMethod } from "./add-method.mts";
import { checkMethod, EXIT_CURRENT } from "./check.mts";
import { discoverMethods, REPO_ROOT } from "./shared.mts";
import RECEIPT_REVIEW_CODEGEN from "./fixtures/recorded/receipt-review.codegen.json" with { type: "json" };
import RECEIPT_REVIEW_VALIDATE from "./fixtures/recorded/receipt-review.validate.json" with { type: "json" };
import TEXT_STATS_CODEGEN from "./fixtures/recorded/text-stats.codegen.json" with { type: "json" };
import TEXT_STATS_VALIDATE from "./fixtures/recorded/text-stats.validate.json" with { type: "json" };

/** What the copy leaves behind: installs, build output, git, and local secrets. */
const NOT_COPIED = new Set([
  "node_modules",
  ".next",
  ".git",
  "test-results",
  "playwright-report",
  ".env",
  ".env.local",
  "tsconfig.tsbuildinfo",
]);

/** One slice per source kind, and the flags that name each one out of the way. */
const SLICES = [
  {
    kind: "a published address",
    argv: ["github.com/Pipelex/methods/text_stats@v0.1.1", "--name", "fixture-text-stats"],
    slug: "fixture-text-stats",
    pascal: "FixtureTextStats",
  },
  {
    kind: "a catalog id",
    argv: ["mt_00000000-0000-0000-0000-000000000000", "--name", "fixture-stored"],
    slug: "fixture-stored",
    pascal: "FixtureStored",
  },
  {
    kind: "a bundle, copied in — a list of documents in, a list of records out",
    argv: ["scripts/lib/fixtures/bundles/receipt-review", "--name", "fixture-receipt-review"],
    slug: "fixture-receipt-review",
    pascal: "FixtureReceiptReview",
    uploads: true,
  },
];

function recordedClient() {
  return {
    version: vi.fn().mockResolvedValue({ extensions: ["runs", "method_id", "method_ref"] }),
    getMethod: vi.fn().mockResolvedValue({ name: "Stored text stats", description: null }),
    codegen: vi.fn(async (request: { files?: unknown }) =>
      request.files === undefined ? TEXT_STATS_CODEGEN : RECEIPT_REVIEW_CODEGEN,
    ),
    validate: vi.fn().mockResolvedValue(TEXT_STATS_VALIDATE),
    validateFiles: vi.fn().mockResolvedValue(RECEIPT_REVIEW_VALIDATE),
  } as unknown as Pick<
    PipelexApiClient,
    "codegen" | "validate" | "validateFiles" | "version" | "getMethod"
  >;
}

/**
 * Run a tool of this repo's own `node_modules` inside the copy, returning its
 * combined output only when it fails — a green run stays silent in the report.
 */
function runTool(cwd: string, script: string, args: string[], env = process.env): string | null {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf-8",
    timeout: 170_000,
  });
  if (result.status === 0) return null;
  return `exit ${result.status}\n${result.stdout}\n${result.stderr}`;
}

describe("a scaffolded slice, in a copy of this tree", () => {
  let tree: string;

  beforeAll(async () => {
    tree = await mkdtemp(path.join(tmpdir(), "scaffold-tree-"));
    await cp(REPO_ROOT, tree, {
      recursive: true,
      filter: (source) => !NOT_COPIED.has(path.relative(REPO_ROOT, source).split(path.sep)[0]!),
    });
    // A symlink is fine for tsc and vitest; only Turbopack refuses one, and
    // nothing here builds.
    await symlink(path.join(REPO_ROOT, "node_modules"), path.join(tree, "node_modules"), "dir");

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = {
      repoRoot: tree,
      cwd: tree,
      client: recordedClient(),
      baseUrl: "https://api.example",
    };
    for (const slice of SLICES) {
      const code = await runAddMethod(slice.argv, deps);
      if (code !== 0) throw new Error(`add-method failed for ${slice.kind}`);
    }
    vi.restoreAllMocks();
  }, 60_000);

  afterAll(async () => {
    if (tree !== undefined) await rm(tree, { recursive: true, force: true });
  });

  it("type-checks with the rest of the app", () => {
    const tsc = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
    expect(runTool(tree, tsc, ["-p", "tsconfig.json", "--noEmit"])).toBeNull();
  }, 180_000);

  it("lints clean", async () => {
    const { ESLint } = await import("eslint");
    const files = SLICES.flatMap((slice) => [
      `src/actions/run${slice.pascal}Pipeline.ts`,
      `src/actions/run${slice.pascal}Pipeline.test.ts`,
      `src/components/${slice.pascal}Form.tsx`,
      `src/types/${slice.pascal.charAt(0).toLowerCase()}${slice.pascal.slice(1)}Pipeline.ts`,
      ...(slice.uploads
        ? [`src/types/${slice.pascal.charAt(0).toLowerCase()}${slice.pascal.slice(1)}Uploads.ts`]
        : []),
      "src/methods.ts",
    ]);
    const results = await new ESLint({ cwd: tree }).lintFiles(files);
    const problems = results.flatMap((result) =>
      result.messages.map(
        (message) =>
          `${path.relative(tree, result.filePath)}:${message.line} ${message.ruleId ?? ""} ${message.message}`,
      ),
    );
    expect(problems).toEqual([]);
  }, 60_000);

  it("leaves every generated tree current by the offline check", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (line: unknown) => void errors.push(String(line)),
    );
    const slugs = new Set(SLICES.map((slice) => slice.slug));
    const methods = (await discoverMethods(path.join(tree, "methods"))).filter((method) =>
      slugs.has(method.name),
    );

    expect(methods.map((method) => method.name).sort()).toEqual([...slugs].sort());
    for (const method of methods) {
      expect(await checkMethod(method, path.join(tree, "src", "generated"))).toBe(EXIT_CURRENT);
    }
    expect(errors).toEqual([]);
    vi.restoreAllMocks();
  });

  it("passes the action tests it emitted", () => {
    // The outer vitest's own variables would make the inner one think it is a
    // worker of this run.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
    );
    const vitest = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
    const tests = SLICES.map((slice) => `src/actions/run${slice.pascal}Pipeline.test.ts`);
    expect(runTool(tree, vitest, ["run", ...tests], env)).toBeNull();
  }, 180_000);
});
