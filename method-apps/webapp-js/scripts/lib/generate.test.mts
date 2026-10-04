// @vitest-environment node
//
// Pins `writeTree` — the only code in this repo that deletes files, and until
// the entry/lib split it lived inside a script that could not be imported
// without running a whole regeneration.
//
// The delete rule is the interesting part: what may be removed is
// `runCodegenCheck`'s own `orphan` verdict over the tree just written, never a
// filename test. A weaker rule would delete a consumer's hand-written sibling
// module — the very file the generated header recommends for declaration
// merging — while the offline check calls that same file healthy. So
// `runCodegenCheck` is the one thing mocked here (the rest of the SDK stays
// real, `isStampableArtifactPath` included, because `readGeneratedTree`
// depends on it to keep `sources.json` out of the artifact set).

import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  ApiResponseError,
  runCodegenCheck,
  type CodegenValidReport,
  type InputForm,
  type OutputForm,
  type PipeIOContracts,
  type PipelexApiClient,
} from "@pipelex/sdk";

import {
  fetchPipeIoArtifacts,
  generateMethod,
  methodProseOf,
  readMethodProse,
  writeTree,
} from "./generate.mts";
import {
  CONTRACTS_FILENAME,
  hashSource,
  LOCK_FILENAME,
  renderContracts,
  SOURCES_SIDECAR,
  SymlinkRefusedError,
  type MethodSource,
} from "./shared.mts";

vi.mock("@pipelex/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pipelex/sdk")>();
  return { ...actual, runCodegenCheck: vi.fn() };
});

const checkMock = runCodegenCheck as unknown as Mock;

/** A minimal valid report — `writeTree` reads only these three fields. */
function report(artifacts: { path: string; content: string }[]): CodegenValidReport {
  return {
    artifacts,
    lock: "lock_version = 1\n",
    lock_filename: "codegen.lock",
  } as unknown as CodegenValidReport;
}

/** No orphans, no drift — the common case for a tree that is exactly right. */
function noDrifts(): void {
  checkMock.mockResolvedValue({ drifts: [], isCurrent: true });
}

const SOURCES = { "methods/demo/main.mthds": "abc123" };
const CONTRACTS = renderContracts(
  {
    "demo.demo": {
      inputs: {},
      output: {
        concept_ref: "native.Text",
        multiplicity: "single",
        item_count: null,
        optional: false,
        json_schema: {},
      },
    },
  },
  { "demo.demo": { fields: [] } },
  {
    "demo.demo": {
      field: { kind: "prose", name: "output", concept_ref: "native.Text", required: true },
    },
  },
);

let outDir: string;

beforeEach(async () => {
  outDir = path.join(await mkdtemp(path.join(tmpdir(), "codegen-write-")), "demo");
  checkMock.mockReset();
});

afterEach(async () => {
  await rm(path.dirname(outDir), { recursive: true, force: true });
});

describe("writeTree", () => {
  it("writes every artifact, the lock, and the sidecar on a first generation", async () => {
    noDrifts();

    const changed = await writeTree(
      outDir,
      report([{ path: "types.ts", content: "export {};\n" }]),
      SOURCES,
    );

    expect(changed).toEqual(["types.ts", "codegen.lock", SOURCES_SIDECAR]);
    expect(await readFile(path.join(outDir, "types.ts"), "utf-8")).toBe("export {};\n");
    const sidecar: unknown = JSON.parse(
      await readFile(path.join(outDir, SOURCES_SIDECAR), "utf-8"),
    );
    expect(sidecar).toMatchObject({ sources: SOURCES });
  });

  it("is a true no-op over an already-current tree", async () => {
    noDrifts();
    const artifacts = [{ path: "types.ts", content: "export {};\n" }];
    await writeTree(outDir, report(artifacts), SOURCES);

    const changed = await writeTree(outDir, report(artifacts), SOURCES);

    expect(changed).toEqual([]);
  });

  it("deletes a file the check calls an orphan", async () => {
    noDrifts();
    await writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES);
    await writeFile(path.join(outDir, "stale.ts"), "// left over\n");
    checkMock.mockResolvedValue({
      drifts: [{ category: "orphan", path: "stale.ts", detail: "not in the lock" }],
      isCurrent: false,
    });

    const changed = await writeTree(
      outDir,
      report([{ path: "types.ts", content: "export {};\n" }]),
      SOURCES,
    );

    expect(changed).toContain("stale.ts (removed)");
    await expect(readFile(path.join(outDir, "stale.ts"), "utf-8")).rejects.toThrow();
  });

  it("leaves every non-orphan drift alone — a `modified` file is regenerated, never deleted", async () => {
    noDrifts();
    await writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES);
    checkMock.mockResolvedValue({
      drifts: [{ category: "modified", path: "types.ts", detail: "content_hash differs" }],
      isCurrent: false,
    });

    const changed = await writeTree(
      outDir,
      report([{ path: "types.ts", content: "export {};\n" }]),
      SOURCES,
    );

    expect(changed.some((entry) => entry.includes("removed"))).toBe(false);
    expect(await readFile(path.join(outDir, "types.ts"), "utf-8")).toBe("export {};\n");
  });

  it("keeps a hand-written sibling module the check does not call an orphan", async () => {
    noDrifts();
    await writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES);
    // The generated header itself recommends this file for declaration merging.
    await writeFile(path.join(outDir, "types.extra.ts"), "// mine\n");

    await writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES);

    expect(await readFile(path.join(outDir, "types.extra.ts"), "utf-8")).toBe("// mine\n");
  });

  it("writes a derived artifact and records its hash in the sidecar", async () => {
    noDrifts();

    const changed = await writeTree(
      outDir,
      report([{ path: "types.ts", content: "export {};\n" }]),
      SOURCES,
      { [CONTRACTS_FILENAME]: CONTRACTS },
    );

    expect(changed).toContain(CONTRACTS_FILENAME);
    expect(await readFile(path.join(outDir, CONTRACTS_FILENAME), "utf-8")).toBe(CONTRACTS);
    const sidecar: unknown = JSON.parse(
      await readFile(path.join(outDir, SOURCES_SIDECAR), "utf-8"),
    );
    expect(sidecar).toMatchObject({ derived: { [CONTRACTS_FILENAME]: hashSource(CONTRACTS) } });
  });

  it("is a true no-op over a tree whose derived artifact is unchanged", async () => {
    noDrifts();
    const artifacts = [{ path: "types.ts", content: "export {};\n" }];
    const derived = { [CONTRACTS_FILENAME]: CONTRACTS };
    await writeTree(outDir, report(artifacts), SOURCES, derived);

    expect(await writeTree(outDir, report(artifacts), SOURCES, derived)).toEqual([]);
  });

  it("keeps the derived artifact through the orphan pass", async () => {
    // It is written BEFORE the cleanup on purpose, so the writer and the checker
    // see the same tree. The SDK's orphan rule requires a codegen *stamp*, which
    // this file does not carry — but the guarantee is worth pinning here too,
    // because the failure mode is a file that silently disappears on every
    // regeneration and comes back only on the next one.
    noDrifts();
    await writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES, {
      [CONTRACTS_FILENAME]: CONTRACTS,
    });
    checkMock.mockResolvedValue({
      drifts: [{ category: "orphan", path: "stale.ts", detail: "not in the lock" }],
      isCurrent: false,
    });
    await writeFile(path.join(outDir, "stale.ts"), "// left over\n");

    await writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES, {
      [CONTRACTS_FILENAME]: CONTRACTS,
    });

    expect(await readFile(path.join(outDir, CONTRACTS_FILENAME), "utf-8")).toBe(CONTRACTS);
  });

  it("fails loudly if the orphan pass ever removes the derived artifact", async () => {
    // The test above pins the behaviour today; this one pins the *detection* if
    // the SDK's orphan rule ever stops exempting unstamped files. Without it the
    // deletion is silent: the sidecar is hashed from the content we wrote, not
    // from disk, so regeneration still exits 0 and only the next check notices.
    noDrifts();
    await writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES, {
      [CONTRACTS_FILENAME]: CONTRACTS,
    });
    checkMock.mockResolvedValue({
      drifts: [{ category: "orphan", path: CONTRACTS_FILENAME, detail: "not in the lock" }],
      isCurrent: false,
    });

    await expect(
      writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES, {
        [CONTRACTS_FILENAME]: CONTRACTS,
      }),
    ).rejects.toThrow(/orphan pass removed/);
    // Refused, not half-done: the file is still there.
    expect(await readFile(path.join(outDir, CONTRACTS_FILENAME), "utf-8")).toBe(CONTRACTS);
  });

  it("refuses a symlink nested in the pre-existing tree before writing anything", async () => {
    const target = path.join(path.dirname(outDir), "outside.ts");
    await writeFile(target, "// external\n");
    await mkdir(path.join(outDir, "nested"), { recursive: true });
    await symlink(target, path.join(outDir, "nested", "linked.ts"));

    await expect(
      writeTree(outDir, report([{ path: "types.ts", content: "export {};\n" }]), SOURCES),
    ).rejects.toThrow(SymlinkRefusedError);

    // Nothing was written: the vet runs before the first write, so the tree
    // still holds only the symlink that caused the refusal.
    expect(await readdir(outDir)).toEqual(["nested"]);
    expect(checkMock).not.toHaveBeenCalled();
  });
});

// `generateMethod` is the unit `npm run codegen` loops over AND the unit the
// scaffold calls once, which is the whole reason it exists as a function: a
// scaffolded tree has to be the tree a regeneration would write. What is worth
// pinning is therefore not the writing (that is `writeTree` above) but the
// branch — which SDK call each source kind makes, and that a refusal writes
// nothing at all.
describe("generateMethod", () => {
  const FILES_SOURCE: MethodSource = {
    name: "demo",
    kind: "files",
    files: [{ content: "a = 1\n", source: "methods/demo/main.mthds" }],
    sourceHashes: SOURCES,
  };
  const SELECTOR_SOURCE: MethodSource = {
    name: "demo",
    kind: "selector",
    selector: { method_ref: "github.com/Pipelex/methods/text_stats@v0.1.1" },
    sourceHashes: { "methods/demo/method.json": "abc123" },
  };

  const VALID_REPORT = {
    is_valid: true,
    artifacts: [{ path: "types.ts", content: "export {};\n" }],
    lock: "lock_version = 1\n",
    lock_filename: LOCK_FILENAME,
    crate_fingerprint: "f".repeat(64),
    engine_version: "0.56.0",
  };

  const VALID_PIPE_IO = {
    is_valid: true,
    pipe_ref: "demo.demo",
    pipe_io_contracts: {
      "demo.demo": {
        inputs: {},
        output: {
          concept_ref: "native.Text",
          multiplicity: "single",
          item_count: null,
          optional: false,
          json_schema: {},
        },
      },
    },
    input_form: { "demo.demo": { fields: [] } },
    output_form: {
      "demo.demo": {
        field: { kind: "prose", name: "output", concept_ref: "native.Text", required: true },
      },
    },
    default_pipe_ref: "demo.demo",
    pending_signatures: [],
    is_runnable: true,
  };

  /** A client that answers both calls with the fixtures above, unless overridden. */
  function fakeClient(overrides: Record<string, unknown> = {}) {
    return {
      codegen: vi.fn().mockResolvedValue(VALID_REPORT),
      pipeIo: vi.fn().mockResolvedValue(VALID_PIPE_IO),
      ...overrides,
    } as unknown as Pick<PipelexApiClient, "codegen" | "pipeIo"> & {
      codegen: Mock;
      pipeIo: Mock;
    };
  }

  /** Collect what the method under test reports on stderr. */
  function captureErrors(): string[] {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    return errors;
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a files source inline to both routes, describing every pipe", async () => {
    noDrifts();
    const client = fakeClient();

    expect(await generateMethod(client, FILES_SOURCE, outDir, "https://api.example")).toBe("ok");
    expect(client.codegen).toHaveBeenCalledWith({
      files: FILES_SOURCE.kind === "files" ? FILES_SOURCE.files : [],
      kind: "types",
      target: "ts-zod",
    });
    // The files are here already, so the route is not asked to echo them.
    expect(client.pipeIo).toHaveBeenCalledWith({
      files: FILES_SOURCE.kind === "files" ? FILES_SOURCE.files : [],
      all_pipes: true,
    });
    expect((await readdir(outDir)).sort()).toEqual(
      [CONTRACTS_FILENAME, LOCK_FILENAME, SOURCES_SIDECAR, "types.ts"].sort(),
    );
  });

  it("sends a selector source as the selector, on both routes, asking for its files", async () => {
    noDrifts();
    const client = fakeClient();

    expect(await generateMethod(client, SELECTOR_SOURCE, outDir, "https://api.example")).toBe("ok");
    expect(client.codegen).toHaveBeenCalledWith({
      method_ref: "github.com/Pipelex/methods/text_stats@v0.1.1",
      kind: "types",
      target: "ts-zod",
    });
    expect(client.pipeIo).toHaveBeenCalledWith({
      method_ref: "github.com/Pipelex/methods/text_stats@v0.1.1",
      all_pipes: true,
      include_files: true,
    });
  });

  it("writes contracts.ts from the route's three maps, verbatim", async () => {
    noDrifts();

    await generateMethod(fakeClient(), FILES_SOURCE, outDir, "https://api.example");

    expect(await readFile(path.join(outDir, CONTRACTS_FILENAME), "utf-8")).toBe(
      renderContracts(
        VALID_PIPE_IO.pipe_io_contracts as PipeIOContracts,
        VALID_PIPE_IO.input_form as InputForm,
        VALID_PIPE_IO.output_form as OutputForm,
      ),
    );
  });

  it("records the manifest hash in the sidecar of a selector-sourced tree", async () => {
    noDrifts();

    await generateMethod(fakeClient(), SELECTOR_SOURCE, outDir, "https://api.example");

    const sidecar: unknown = JSON.parse(
      await readFile(path.join(outDir, SOURCES_SIDECAR), "utf-8"),
    );
    expect(sidecar).toMatchObject({ sources: { "methods/demo/method.json": "abc123" } });
  });

  it("fails a selector the API cannot resolve, writing nothing", async () => {
    noDrifts();
    const errors = captureErrors();
    const client = fakeClient({
      codegen: vi
        .fn()
        .mockRejectedValue(
          new ApiResponseError(
            "API POST /v1/codegen failed (404)",
            "https://api.example/v1/codegen",
            404,
            "Not Found",
            "{}",
            "MethodPackageNotFoundError",
            "No package at address 'github.com/Pipelex/methods/text_stats'.",
            undefined,
            undefined,
          ),
        ),
    });

    expect(await generateMethod(client, SELECTOR_SOURCE, outDir, "https://api.example")).toBe(
      "failed",
    );
    // The server's own message is the useful half, and the line names the
    // selector rather than blaming PIPELEX_BASE_URL for a route that answered.
    expect(errors.join("\n")).toContain("could not resolve method_ref");
    expect(errors.join("\n")).toContain("No package at address");
    expect(errors.join("\n")).not.toContain("does not serve");
    await expect(readdir(outDir)).rejects.toThrow();
  });

  // The route runs no dry run, so a method still under construction loads and
  // describes itself like any other. Its contracts would describe a form whose
  // Run can only fail, so the build refuses it, naming what is left to write.
  it("refuses a method whose pipes are still signatures, naming them, writing nothing", async () => {
    noDrifts();
    const errors = captureErrors();
    const client = fakeClient({
      pipeIo: vi.fn().mockResolvedValue({
        ...VALID_PIPE_IO,
        is_runnable: false,
        pending_signatures: ["demo.summarize", "demo.shout"],
      }),
    });

    expect(await generateMethod(client, FILES_SOURCE, outDir, "https://api.example")).toBe(
      "failed",
    );
    expect(errors.join("\n")).toContain("not runnable");
    expect(errors.join("\n")).toContain("demo.summarize, demo.shout");
    await expect(readdir(outDir)).rejects.toThrow();
  });

  it("refuses a method the route reports as invalid, with each diagnostic, writing nothing", async () => {
    noDrifts();
    const errors = captureErrors();
    const client = fakeClient({
      pipeIo: vi.fn().mockResolvedValue({
        is_valid: false,
        validation_errors: [
          { category: "blueprint", message: "unknown concept", source: "main.mthds" },
        ],
        message: "The method does not load.",
      }),
    });

    expect(await generateMethod(client, FILES_SOURCE, outDir, "https://api.example")).toBe(
      "failed",
    );
    expect(errors.join("\n")).toContain("does not resolve");
    expect(errors.join("\n")).toContain("main.mthds: unknown concept");
    await expect(readdir(outDir)).rejects.toThrow();
  });

  it("names the route a base URL does not serve, writing nothing", async () => {
    noDrifts();
    const errors = captureErrors();
    const client = fakeClient({
      pipeIo: vi
        .fn()
        .mockRejectedValue(
          new ApiResponseError(
            "API POST /v1/pipe-io failed (404)",
            "https://api.example/v1/pipe-io",
            404,
            "Not Found",
            "{}",
            undefined,
            undefined,
            undefined,
            undefined,
          ),
        ),
    });

    expect(await generateMethod(client, FILES_SOURCE, outDir, "https://api.example")).toBe(
      "failed",
    );
    expect(errors.join("\n")).toContain("does not serve POST /v1/pipe-io");
    await expect(readdir(outDir)).rejects.toThrow();
  });

  // The writer lays the lock, the sidecar and `contracts.ts` over whatever the
  // server returned, so an artifact on one of those names would be overwritten
  // silently and the tree would fail its own check forever after. A contained
  // path that normalizes onto one of them is the same collision.
  it.each([CONTRACTS_FILENAME, SOURCES_SIDECAR, LOCK_FILENAME, `nested/../${CONTRACTS_FILENAME}`])(
    "refuses a server artifact that lands on %s, writing nothing",
    async (artifactPath) => {
      noDrifts();
      const errors: string[] = [];
      vi.spyOn(console, "error").mockImplementation((line: unknown) => {
        errors.push(String(line));
      });
      const client = fakeClient({
        codegen: vi.fn().mockResolvedValue({
          ...VALID_REPORT,
          artifacts: [...VALID_REPORT.artifacts, { path: artifactPath, content: "export {};\n" }],
        }),
      });

      expect(await generateMethod(client, FILES_SOURCE, outDir, "https://api.example")).toBe(
        "failed",
      );
      expect(errors.join("\n")).toContain("land on a file this script writes itself");
      expect(client.pipeIo).not.toHaveBeenCalled();
      await expect(readdir(outDir)).rejects.toThrow();
    },
  );
});

describe("readMethodProse", () => {
  it("reads the domain description and each pipe's, qualified by the domain", () => {
    expect(
      readMethodProse({
        domain: "receipt_review",
        description: "Read receipts.",
        pipe: { review_receipts: { description: "Summarize each one." }, bare: {} },
      }),
    ).toEqual({
      description: "Read receipts.",
      pipeDescriptions: { "receipt_review.review_receipts": "Summarize each one." },
    });
  });

  it.each([undefined, null, "text", [], { description: "   ", pipe: [] }])(
    "tolerates a blueprint it cannot read (%j)",
    (blueprint) => {
      expect(readMethodProse(blueprint)).toEqual({ description: null, pipeDescriptions: {} });
    },
  );
});

describe("methodProseOf", () => {
  const CONCEPTS = { source: "concepts.mthds", content: 'domain = "review"\n' };
  const MAIN = {
    source: "main.mthds",
    content: [
      'domain = "review"',
      'description = "Score a batch of CVs."',
      'main_pipe = "score"',
      "",
      "[pipe.score]",
      'type = "PipeLLM"',
      'description = "Score each CV."',
    ].join("\n"),
  };
  const HELPERS = {
    source: "helpers.mthds",
    content: [
      'domain = "helpers"',
      'description = "Shared steps."',
      "",
      "[pipe.clean]",
      'type = "PipeCompose"',
      'description = "Clean each PDF."',
    ].join("\n"),
  };

  it("takes the description from the file that declares the main pipe, wherever it sits", () => {
    expect(methodProseOf([CONCEPTS, HELPERS, MAIN]).description).toBe("Score a batch of CVs.");
  });

  it("collects every file's pipe descriptions, the primary file's first", () => {
    const prose = methodProseOf([HELPERS, MAIN]);
    expect(prose.pipeDescriptions).toEqual({
      "review.score": "Score each CV.",
      "helpers.clean": "Clean each PDF.",
    });
    expect(Object.keys(prose.pipeDescriptions)[0]).toBe("review.score");
  });

  it("falls back to the first file when none declares a main pipe", () => {
    expect(methodProseOf([HELPERS, CONCEPTS]).description).toBe("Shared steps.");
  });

  it("skips a file it cannot parse, and reads nothing from none", () => {
    expect(methodProseOf([{ content: "this is = = not toml" }, MAIN]).description).toBe(
      "Score a batch of CVs.",
    );
    expect(methodProseOf([])).toEqual({ description: null, pipeDescriptions: {} });
  });
});

// The prose rides the same call as the artifacts: a selector's files come back
// on the answer because `pipeIoRequest` asks for them, and a bundle's are read
// where they already are.
describe("fetchPipeIoArtifacts", () => {
  const ANSWER = {
    is_valid: true,
    pipe_ref: "review.score",
    pipe_io_contracts: {},
    input_form: {},
    output_form: {},
    default_pipe_ref: "review.score",
    pending_signatures: [],
    is_runnable: true,
    files: [
      {
        source: "review.mthds",
        content: 'domain = "review"\ndescription = "Read from the echo."\nmain_pipe = "score"\n',
      },
    ],
  };

  function client(answer: unknown) {
    return { pipeIo: vi.fn().mockResolvedValue(answer) } as unknown as Pick<
      PipelexApiClient,
      "pipeIo"
    >;
  }

  it("reads a selector method's prose off the files the route echoed", async () => {
    const fetched = await fetchPipeIoArtifacts(
      client(ANSWER),
      {
        name: "review",
        kind: "selector",
        selector: { method_id: "mt_review" },
        sourceHashes: {},
      },
      "https://api.example",
    );
    expect(fetched?.prose.description).toBe("Read from the echo.");
    expect(fetched?.defaultPipeRef).toBe("review.score");
  });

  it("reads a bundle's prose off its own files", async () => {
    const fetched = await fetchPipeIoArtifacts(
      client({ ...ANSWER, files: undefined }),
      {
        name: "review",
        kind: "files",
        files: [{ source: "main.mthds", content: 'domain = "review"\ndescription = "Local."\n' }],
        sourceHashes: {},
      },
      "https://api.example",
    );
    expect(fetched?.prose.description).toBe("Local.");
  });

  it("carries a stated null entry pipe through for the scaffold's pipe rule", async () => {
    const fetched = await fetchPipeIoArtifacts(
      client({ ...ANSWER, default_pipe_ref: null }),
      { name: "review", kind: "selector", selector: { method_id: "mt_review" }, sourceHashes: {} },
      "https://api.example",
    );
    expect(fetched?.defaultPipeRef).toBeNull();
  });
});
