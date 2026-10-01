// @vitest-environment node
//
// Pins the offline check's exit-code contract — the part that used to live at
// a script's top level and could not be imported.
//
// Exit codes are the contract `make check` reads (0 current · 1 drift · 2 no
// verdict), and both halves fail as a *wrong verdict* rather than an error:
// `summarizeVerdicts` must let a no-verdict outrank drift instead of one
// method's verdict masking another's, and `checkMethod` must map each way a
// tree can be unreadable onto the right one of those three.

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkMethod,
  EXIT_CURRENT,
  EXIT_DRIFT,
  EXIT_NO_VERDICT,
  summarizeVerdicts,
} from "./check.mts";
import {
  CONTRACTS_FILENAME,
  hashSource,
  LOCK_FILENAME,
  renderContracts,
  SIDECAR_COMMENT,
  SOURCES_SIDECAR,
  type MethodSource,
} from "./shared.mts";

// Invalid UTF-8: a lone continuation byte, the same fixture the shared layer uses.
const INVALID_UTF8 = Buffer.from([0x68, 0x69, 0x80, 0x0a]);

const METHOD: MethodSource = {
  name: "demo",
  kind: "files",
  files: [{ content: "", source: "methods/demo/main.mthds" }],
  sourceHashes: { "methods/demo/main.mthds": "abc123" },
};

/** The same method named by a manifest instead of carrying its own bundles. */
const SELECTOR_METHOD: MethodSource = {
  name: "demo",
  kind: "selector",
  selector: { method_ref: "github.com/Pipelex/methods/demo@v1.0.0" },
  sourceHashes: { "methods/demo/method.json": "abc123" },
};

let generatedRoot: string;

beforeEach(async () => {
  generatedRoot = await mkdtemp(path.join(tmpdir(), "codegen-check-"));
  // The reports are the CLI's output, not the assertion surface.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(generatedRoot, { recursive: true, force: true });
});

/** Create `<generatedRoot>/demo/` with the given files, and return its path. */
async function tree(files: Record<string, string | Buffer>): Promise<string> {
  const outDir = path.join(generatedRoot, "demo");
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(outDir, name), content);
  }
  return outDir;
}

describe("summarizeVerdicts", () => {
  it("reports current when every method is current", () => {
    expect(summarizeVerdicts([EXIT_CURRENT, EXIT_CURRENT])).toMatchObject({
      current: 2,
      exit: EXIT_CURRENT,
    });
  });

  it("lets a no-verdict outrank drift, whichever came first", () => {
    // Order-independence is the point: a max() over codes happens to agree
    // today, but precedence is the rule and the counts are what gets printed.
    expect(summarizeVerdicts([EXIT_NO_VERDICT, EXIT_DRIFT]).exit).toBe(EXIT_NO_VERDICT);
    expect(summarizeVerdicts([EXIT_DRIFT, EXIT_NO_VERDICT]).exit).toBe(EXIT_NO_VERDICT);
  });

  it("counts the mix the single exit code cannot show", () => {
    expect(summarizeVerdicts([EXIT_CURRENT, EXIT_DRIFT, EXIT_NO_VERDICT])).toEqual({
      current: 1,
      drift: 1,
      noVerdict: 1,
      exit: EXIT_NO_VERDICT,
    });
  });

  it("treats an unknown code as a no-verdict rather than as success", () => {
    expect(summarizeVerdicts([42]).exit).toBe(EXIT_NO_VERDICT);
  });

  it("reports current on an empty run — the caller owns the 'nothing to check' case", () => {
    expect(summarizeVerdicts([]).exit).toBe(EXIT_CURRENT);
  });
});

describe("checkMethod", () => {
  it("calls an absent tree drift — regenerating is the real remedy", async () => {
    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_DRIFT);
  });

  it("produces no verdict for a tree with no lock", async () => {
    await tree({ "types.ts": "export {};\n" });

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_NO_VERDICT);
  });

  it("calls a non-UTF-8 artifact drift, because regenerating rewrites it", async () => {
    await tree({ [LOCK_FILENAME]: "lock_version = 1\n", "types.ts": INVALID_UTF8 });

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_DRIFT);
  });

  it("produces no verdict for a symlinked tree", async () => {
    const external = path.join(generatedRoot, "external");
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, LOCK_FILENAME), "lock_version = 1\n");
    await symlink(external, path.join(generatedRoot, "demo"));

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_NO_VERDICT);
  });

  it("produces no verdict for an unparseable lock", async () => {
    await tree({ [LOCK_FILENAME]: "this is not a lock\n" });

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_NO_VERDICT);
  });
});

// The contracts artifact is the one file in a generated tree the codegen lock
// does not sign, so every verdict about it comes from the sidecar's `derived`
// map instead. These run against the REAL `runCodegenCheck` over a REAL lock and
// a genuinely stamped artifact — a mocked check would only pin the mock, and the
// load-bearing claim here is about the SDK's own orphan rule.
describe("checkMethod over a tree carrying contracts.ts", () => {
  const FINGERPRINT = "f".repeat(64);
  const CONTRACTS = renderContracts(
    {
      "demo.demo": {
        inputs: {
          text: {
            concept_ref: "native.Text",
            presence: "plain",
            multiplicity: "single",
            item_count: null,
            json_schema: {},
          },
        },
        output: {
          concept_ref: "native.Text",
          multiplicity: "single",
          item_count: null,
          optional: false,
          json_schema: {},
        },
      },
    },
    {
      "demo.demo": {
        fields: [
          {
            kind: "prose",
            name: "text",
            concept_ref: "native.Text",
            required: true,
            presence: "plain",
            gating: true,
          },
        ],
      },
    },
    {
      "demo.demo": {
        field: { kind: "prose", name: "output", concept_ref: "native.Text", required: true },
      },
    },
  );

  /** A body plus the stamp the SDK expects over it — the hash is of the body alone. */
  function stamped(body: string): string {
    const contentHash = createHash("sha256").update(body, "utf8").digest("hex");
    return [
      "// >>> pipelex-codegen-stamp >>>",
      `// crate_fingerprint: ${FINGERPRINT}`,
      "// engine_version: 0.50.0",
      "// projection: types / ts-zod",
      "// options: {}",
      `// content_hash: ${contentHash}`,
      "// <<< pipelex-codegen-stamp <<<",
      body,
    ].join("\n");
  }

  const TYPES_BODY = "export type Demo = string;\n";

  function lock(): string {
    const contentHash = createHash("sha256").update(TYPES_BODY, "utf8").digest("hex");
    return [
      "lock_version = 1",
      `crate_fingerprint = "${FINGERPRINT}"`,
      'engine_version = "0.50.0"',
      "",
      "[[artifacts]]",
      'path = "types.ts"',
      `content_hash = "${contentHash}"`,
      "",
    ].join("\n");
  }

  /** A complete, genuinely current tree: locked artifact, contracts, sidecar. */
  async function currentTree(
    contracts: string | null = CONTRACTS,
    derived: Record<string, string> = { [CONTRACTS_FILENAME]: hashSource(CONTRACTS) },
    sources: Record<string, string> = METHOD.sourceHashes,
  ): Promise<string> {
    const files: Record<string, string> = {
      [LOCK_FILENAME]: lock(),
      "types.ts": stamped(TYPES_BODY),
      [SOURCES_SIDECAR]: `${JSON.stringify(
        { comment: SIDECAR_COMMENT, sources, derived },
        null,
        2,
      )}\n`,
    };
    if (contracts !== null) files[CONTRACTS_FILENAME] = contracts;
    return tree(files);
  }

  it("is current — an unstamped .ts beside the lock is not an orphan", async () => {
    await currentTree();

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_CURRENT);
  });

  it("reports drift when contracts.ts is hand-edited", async () => {
    await currentTree(`${CONTRACTS}// tampered\n`);

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_DRIFT);
  });

  it("reports drift when contracts.ts is deleted", async () => {
    await currentTree(null);

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_DRIFT);
  });

  it("reports drift when the sidecar never recorded contracts.ts", async () => {
    await currentTree(CONTRACTS, {});

    expect(await checkMethod(METHOD, generatedRoot)).toBe(EXIT_DRIFT);
  });

  // A selector-sourced tree is checked by exactly the same code — the point of
  // hashing the manifest the way a bundle is hashed rather than recording the
  // selector somewhere the check would have to learn about. These three pin that
  // it really is the same code, so the gesture inherits the gate rather than
  // getting a weaker one.
  describe("over a selector-sourced tree", () => {
    const SELECTOR_SOURCES = SELECTOR_METHOD.sourceHashes;

    it("is current when the manifest still hashes to what the tree recorded", async () => {
      await currentTree(
        CONTRACTS,
        { [CONTRACTS_FILENAME]: hashSource(CONTRACTS) },
        SELECTOR_SOURCES,
      );

      expect(await checkMethod(SELECTOR_METHOD, generatedRoot)).toBe(EXIT_CURRENT);
    });

    it("reports drift after the manifest changes — a bumped tag, not regenerated", async () => {
      await currentTree(
        CONTRACTS,
        { [CONTRACTS_FILENAME]: hashSource(CONTRACTS) },
        {
          "methods/demo/method.json": "an-older-hash",
        },
      );

      expect(await checkMethod(SELECTOR_METHOD, generatedRoot)).toBe(EXIT_DRIFT);
    });

    it("reports drift when contracts.ts is hand-edited, same as a files method", async () => {
      await currentTree(
        `${CONTRACTS}// tampered\n`,
        { [CONTRACTS_FILENAME]: hashSource(CONTRACTS) },
        SELECTOR_SOURCES,
      );

      expect(await checkMethod(SELECTOR_METHOD, generatedRoot)).toBe(EXIT_DRIFT);
    });
  });
});
