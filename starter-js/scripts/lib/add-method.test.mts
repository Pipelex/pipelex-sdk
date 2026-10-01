// @vitest-environment node
//
// Pins `make add-method`, in two layers.
//
// The pure helpers are tabled: each one turns an API payload or a command line
// into a decision the scaffold then writes into a file, so a wrong answer here
// is a wrong file rather than an error. The orchestration is exercised over a
// fake client and a temporary skeleton — what matters there is the ORDERING the
// design rests on: every refusal happens in the read-only half, with nothing on
// disk changed.
//
// Everything the API returns is a recorded fixture (`./fixtures/`), never
// re-fetched. The one thing read from the real repo is `ExampleTabs.tsx`: the
// anchor test exists precisely to fail the day a template edit moves an anchor.

import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ApiResponseError, runCodegenCheck, type PipelexApiClient } from "@pipelex/sdk";

import {
  AddMethodError,
  addressSegments,
  allowedMimesFor,
  bindOutput,
  camelCase,
  choosePipe,
  contractFor,
  descriptorFor,
  fileInputsOf,
  hasGatingInput,
  humanize,
  IMPORTS_ANCHOR,
  inSentence,
  kebabCase,
  looksLikePath,
  parseArgs,
  parseMethodArg,
  pascalCase,
  planAddMethod,
  readBundle,
  registerMethod,
  renderManifest,
  respellAcronyms,
  runAddMethod,
  scaffoldNames,
  scaffoldPaths,
  slugSource,
  spelledWords,
  TABS_ANCHOR,
  WRITE_LOCK_FILENAME,
  writeAddMethod,
  type ScaffoldPlan,
} from "./add-method.mts";
import {
  renderAction,
  renderActionTest,
  renderAdapter,
  renderForm,
  renderUploads,
} from "./add-method.mts";
import { MANIFEST_FILENAME, REPO_ROOT } from "./shared.mts";
import RECEIPT_REVIEW_CODEGEN from "./fixtures/recorded/receipt-review.codegen.json" with { type: "json" };
import RECEIPT_REVIEW_VALIDATE from "./fixtures/recorded/receipt-review.validate.json" with { type: "json" };
import {
  DOCUMENTS_CONTRACTS,
  DOCUMENTS_INPUT_FORM,
  DOCUMENTS_OUTPUT_FORM,
  TEXT_STATS_ARTIFACTS,
  TEXT_STATS_CONTRACTS,
  TEXT_STATS_INPUT_FORM,
  TEXT_STATS_OUTPUT_FORM,
  TEXT_STATS_LOCK,
} from "./fixtures/add-method-fixtures.mts";

// The recorded artifacts are trimmed to their export lines and so carry no
// codegen stamp, which `fetchGenerated`'s self-verify would call `hand-edited`.
// That check has its own tests in `generate.test.mts`; here it is noise, so it
// is the one thing mocked — the rest of the SDK stays real, because
// `readGeneratedTree` depends on `isStampableArtifactPath` to keep
// `sources.json` out of the artifact set.
vi.mock("@pipelex/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pipelex/sdk")>();
  return { ...actual, runCodegenCheck: vi.fn() };
});

const TEXT_STATS_REF = "github.com/Pipelex/methods/text_stats@v0.1.1";

// ── The selector ────────────────────────────────────────────────────────────

describe("parseMethodArg", () => {
  it.each([
    [
      "mt_ca0aa9d3-61ac-4db1-8b46-fb0cc75787df",
      { method_id: "mt_ca0aa9d3-61ac-4db1-8b46-fb0cc75787df" },
    ],
    [TEXT_STATS_REF, { method_ref: TEXT_STATS_REF }],
    ["github.com/Pipelex/methods", { method_ref: "github.com/Pipelex/methods" }],
    // The https:// prefix and a trailing slash are normalized away, so the
    // manifest and the run always name the address in one form.
    [`https://${TEXT_STATS_REF}`, { method_ref: TEXT_STATS_REF }],
    [
      "github.com/Pipelex/methods/documents/",
      { method_ref: "github.com/Pipelex/methods/documents" },
    ],
    ["  github.com/o/r  ", { method_ref: "github.com/o/r" }],
  ])("parses the selector %s", (arg, expected) => {
    expect(parseMethodArg(arg)).toEqual({ kind: "selector", selector: expected });
  });

  it.each([
    "cv_screening.mthds",
    "./bundles/cv",
    "../cv",
    "/tmp/cv",
    "~/cv",
    "methods/text-stats",
    "bundles/cv/main.mthds",
    "C:\\bundles\\cv",
  ])("reads %s as a bundle path, kept as given", (arg) => {
    expect(parseMethodArg(arg)).toEqual({ kind: "bundle", path: arg });
  });

  it.each([
    ["", "empty"],
    ["mt_", "malformed id"],
    ["mt_bad id", "id with a space"],
    ["github.com/Pipelex", "address with no repository"],
    ["github.com/o/r@v1@v2", "two tags"],
    ["github.com/o/r@", "an empty tag"],
  ])("refuses %s (%s)", (arg) => {
    expect(() => parseMethodArg(arg)).toThrow(AddMethodError);
  });

  // A name that exists is a path, whatever the selector grammar would make of it.
  it.each(["bundles.v2/cv", "my.org/methods/cv", "mt_drafts", "github.com/o/r"])(
    "reads %s as a bundle path when it exists on disk",
    (arg) => {
      expect(parseMethodArg(arg, (value) => value === arg)).toEqual({ kind: "bundle", path: arg });
    },
  );
});

describe("looksLikePath", () => {
  // An address starts with its host, and a host has a dot; nothing else does.
  it.each([
    ["github.com/o/r", false],
    ["gitlab.example.org/o/r", false],
    ["bundles/cv", true],
    ["cv", true],
    ["./cv", true],
    [".", true],
    ["..", true],
    ["x.mthds", true],
    ["github.com/o/r/main.mthds", true],
  ])("%s → %s", (value, expected) => {
    expect(looksLikePath(value)).toBe(expected);
  });
});

describe("addressSegments", () => {
  it("strips the tag", () => {
    expect(addressSegments(TEXT_STATS_REF)).toEqual([
      "github.com",
      "Pipelex",
      "methods",
      "text_stats",
    ]);
  });
});

// ── The bundle ──────────────────────────────────────────────────────────────

/** The fixture bundle, read in place from this checkout. */
const RECEIPTS_DIR = path.join(
  REPO_ROOT,
  "scripts",
  "lib",
  "fixtures",
  "bundles",
  "receipt-review",
);

/** The error a promise rejects with, failing the test when it resolves instead. */
async function refusalOf(pending: Promise<unknown>): Promise<Error> {
  const outcome = await pending.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("expected a rejection");
  return outcome;
}

describe("readBundle", () => {
  let app: string;
  let outside: string;

  beforeEach(async () => {
    app = await mkdtemp(path.join(tmpdir(), "read-bundle-app-"));
    outside = await mkdtemp(path.join(tmpdir(), "read-bundle-src-"));
    await mkdir(path.join(app, "methods"), { recursive: true });
  });

  afterEach(async () => {
    await rm(app, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  async function put(root: string, relative: string, content = 'domain = "x"\n'): Promise<void> {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content, "utf-8");
  }

  it("takes every .mthds file under a directory, keeping their relative paths", async () => {
    await put(outside, "cv/main.mthds");
    await put(outside, "cv/steps/screen.mthds");
    await put(outside, "cv/notes.md");

    const bundle = await readBundle("cv", outside, app);

    expect(bundle.inPlace).toBeNull();
    expect(bundle.display).toBe("cv/");
    expect(bundle.files.map((file) => [file.relative, file.label])).toEqual([
      ["main.mthds", path.join("cv", "main.mthds")],
      ["steps/screen.mthds", path.join("cv", "steps", "screen.mthds")],
    ]);
  });

  it("takes a single file alone, under its own name", async () => {
    await put(outside, "cv/main.mthds");
    await put(outside, "cv/other.mthds");

    const bundle = await readBundle(path.join(outside, "cv", "main.mthds"), app, app);

    expect(bundle.files.map((file) => file.relative)).toEqual(["main.mthds"]);
    // Outside the directory it was typed in, a path is named absolutely.
    expect(bundle.files[0]!.label).toBe(path.join(outside, "cv", "main.mthds"));
  });

  it("reads a whole method directory in place, whichever of its files was named", async () => {
    await put(app, "methods/cv/main.mthds");
    await put(app, "methods/cv/screen.mthds");

    for (const given of ["methods/cv", "methods/cv/", "methods/cv/screen.mthds"]) {
      const bundle = await readBundle(given, app, app);
      expect(bundle.inPlace).toBe("cv");
      expect(bundle.files.map((file) => file.label)).toEqual([
        "methods/cv/main.mthds",
        "methods/cv/screen.mthds",
      ]);
    }
  });

  it.each([
    ["nope", "a path that is not there", /is not a file or a directory/],
    ["notes.md", "a file that is not a bundle", /is not a \.mthds file/],
    ["empty", "a directory with no bundle", /holds no \.mthds file/],
  ])("refuses %s (%s)", async (given, _what, message) => {
    await put(outside, "notes.md", "# notes\n");
    await mkdir(path.join(outside, "empty"));
    await expect(readBundle(given, outside, app)).rejects.toThrow(message);
  });

  it("refuses methods/ itself, and a file sitting directly in it", async () => {
    await put(app, "methods/stray.mthds");
    await expect(readBundle("methods", app, app)).rejects.toThrow(/methods\/ directory itself/);
    await expect(readBundle("methods/stray.mthds", app, app)).rejects.toThrow(
      /sits directly in methods\//,
    );
  });

  it("refuses a directory that contains the app", async () => {
    await expect(readBundle(app, outside, app)).rejects.toThrow(/contains this app/);
    await expect(readBundle(path.dirname(app), outside, app)).rejects.toThrow(/contains this app/);
  });

  it("refuses a method directory holding a manifest beside its bundle", async () => {
    await put(app, "methods/cv/main.mthds");
    await put(app, `methods/cv/${MANIFEST_FILENAME}`, "{}\n");
    await expect(readBundle("methods/cv", app, app)).rejects.toThrow(/holds one or the other/);
  });

  it("refuses a symlink inside the bundle rather than follow or skip it", async () => {
    await put(outside, "cv/main.mthds");
    await symlink(path.join(outside, "cv", "main.mthds"), path.join(outside, "cv", "link.mthds"));

    const refusal = await refusalOf(readBundle("cv", outside, app));

    expect(refusal).toBeInstanceOf(AddMethodError);
    expect(refusal.message).toMatch(/a symlink at .*link\.mthds — the path given, and everything/);
    // The codegen scripts' wording names methods/, where this bundle is not.
    expect(refusal.message).not.toContain("methods/");
  });

  it("refuses a bundle named through a symlink, whether it links a file or a directory", async () => {
    await put(outside, "notes.txt", "not a bundle\n");
    await put(outside, "cv/main.mthds");
    await symlink(path.join(outside, "notes.txt"), path.join(outside, "x.mthds"));
    await symlink(path.join(outside, "cv"), path.join(outside, "linked"));

    for (const given of ["x.mthds", "linked", "linked/"]) {
      const refusal = await refusalOf(readBundle(given, outside, app));
      expect(refusal).toBeInstanceOf(AddMethodError);
      expect(refusal.message).toContain(`refusing a symlink at "${given}"`);
      expect(refusal.message).not.toContain("methods/");
    }
  });
});

// ── Names ───────────────────────────────────────────────────────────────────

describe("the name derivations", () => {
  it.each([
    ["text_stats", "text-stats"],
    ["CV screening", "cv-screening"],
    ["Test-1", "test-1"],
    ["pipelex_mcp_e2e_fixture", "pipelex-mcp-e2e-fixture"],
    ["  Create   moodboard  ", "create-moodboard"],
    ["Model 3D", "model-3d"],
  ])("kebab-cases %s", (input, expected) => {
    expect(kebabCase(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["---", "punctuation only"],
    ["🙂", "no ASCII at all"],
    ["3D model", "a leading digit, which no TypeScript identifier may have"],
  ])("refuses %s (%s), pointing at --name", (input) => {
    expect(() => kebabCase(input)).toThrow(/--name/);
  });

  it("derives the identifiers and the label from the slug", () => {
    expect(pascalCase("text-stats")).toBe("TextStats");
    expect(camelCase("text-stats")).toBe("textStats");
    expect(humanize("text-stats")).toBe("Text stats");
    expect(scaffoldNames("text-stats")).toEqual({
      slug: "text-stats",
      pascal: "TextStats",
      camel: "textStats",
      label: "Text stats",
    });
    expect(scaffoldNames("text-stats", "Word counts").label).toBe("Word counts");
  });

  it("keeps an acronym's capitals where the method spells them", () => {
    // `cv_screening` derived "Cv screening" while the method's own description
    // said "score a batch of CVs against it".
    const prose = "Score a batch of CVs against a hiring scorecard, one PDF at a time.";
    expect(respellAcronyms(humanize("cv-screening"), prose)).toBe("CV screening");
    expect(respellAcronyms("Cvs", prose)).toBe("CVs");
    expect(respellAcronyms("Pdfs", prose)).toBe("PDFs");
  });

  it("respells a derived label only, and records which it was rather than comparing", () => {
    // `--label "Cv screening"` on a `cv-screening` method is a CHOSEN label
    // that happens to equal the derived one, so a value comparison would have
    // respelled it and broken the promise that a chosen label is kept.
    expect(scaffoldNames("cv-screening", "Cv screening").label).toBe("Cv screening");
    expect(scaffoldNames("cv-screening").label).toBe(humanize("cv-screening"));
  });

  it("takes only a word spelled with an INTERIOR capital, not one opening a sentence", () => {
    // Every sentence starts with a capital, so a rule reading those would
    // respell "Score" and say nothing about how the author spells anything.
    expect(respellAcronyms(humanize("score-cvs"), "Score a batch of CVs.")).toBe("Score CVs");
    expect(spelledWords("Score a batch of CVs.")).toEqual(
      new Map([
        ["cvs", "CVs"],
        ["cv", "CV"],
      ]),
    );
  });

  it("lower-cases a label inside a sentence, but never an acronym", () => {
    expect(inSentence("Text stats")).toBe("text stats");
    expect(inSentence("CV screening")).toBe("CV screening");
  });

  it("leaves a label alone when the method spells nothing its own way", () => {
    expect(respellAcronyms("Text stats", "Count the words in a text.")).toBe("Text stats");
  });

  it("takes the slug from the package, and the repo when the address names none", () => {
    expect(slugSource({ method_ref: TEXT_STATS_REF })).toBe("text_stats");
    expect(slugSource({ method_ref: "github.com/Pipelex/methods" })).toBe("methods");
  });

  it("takes a stored method's slug from its catalog name — a person chose it", () => {
    expect(slugSource({ method_id: "mt_x" }, "CV screening")).toBe("CV screening");
    expect(() => slugSource({ method_id: "mt_x" }, "")).toThrow(/--name/);
  });

  it("puts every emitted file where the app's conventions place it", () => {
    expect(scaffoldPaths(scaffoldNames("text-stats"))).toEqual({
      methodDir: "methods/text-stats",
      manifest: "methods/text-stats/method.json",
      generatedDir: "src/generated/text-stats",
      adapter: "src/types/textStatsPipeline.ts",
      uploads: "src/types/textStatsUploads.ts",
      action: "src/actions/runTextStatsPipeline.ts",
      actionTest: "src/actions/runTextStatsPipeline.test.ts",
      form: "src/components/TextStatsForm.tsx",
      registry: "src/components/ExampleTabs.tsx",
    });
  });
});

// ── The pipe rule ───────────────────────────────────────────────────────────

describe("choosePipe", () => {
  it("takes the single pipe when a method declares exactly one", () => {
    expect(choosePipe(TEXT_STATS_CONTRACTS, null)).toEqual({
      ref: "text_stats.analyze_text",
      domain: "text_stats",
      code: "analyze_text",
    });
  });

  it("reads default_pipe_ref, which a package manifest fills where main_pipe is null", () => {
    // `github.com/Pipelex/methods/documents` — measured: seven pipes, no
    // bundle-level main_pipe, and a default all the same.
    expect(choosePipe(DOCUMENTS_CONTRACTS, "documents.extract_document_markdown").ref).toBe(
      "documents.extract_document_markdown",
    );
  });

  it("takes an explicit --pipe, qualified or bare", () => {
    expect(choosePipe(DOCUMENTS_CONTRACTS, null, "documents.extract_text_pages").code).toBe(
      "extract_text_pages",
    );
    expect(choosePipe(DOCUMENTS_CONTRACTS, null, "extract_text_pages").ref).toBe(
      "documents.extract_text_pages",
    );
  });

  it("refuses a --pipe the method does not declare, listing what it does", () => {
    expect(() => choosePipe(DOCUMENTS_CONTRACTS, null, "nope")).toThrow(
      /not a pipe this method declares/,
    );
    expect(() => choosePipe(DOCUMENTS_CONTRACTS, null, "nope")).toThrow(
      /documents.extract_document_text/,
    );
  });

  it("refuses several pipes with no default rather than guessing", () => {
    expect(() => choosePipe(DOCUMENTS_CONTRACTS, null)).toThrow(/pass --pipe/);
  });

  it("refuses a default the contract map does not carry", () => {
    expect(() => choosePipe(DOCUMENTS_CONTRACTS, "documents.gone")).toThrow(/not among the pipes/);
  });

  it("refuses a method with no pipes at all", () => {
    expect(() => choosePipe({}, null)).toThrow(/no pipes/);
  });
});

describe("contractFor / descriptorFor", () => {
  const pipe = { ref: "text_stats.analyze_text", domain: "text_stats", code: "analyze_text" };

  it("finds both by qualified ref", () => {
    expect(contractFor(TEXT_STATS_CONTRACTS, pipe).output.concept_ref).toBe("native.Text");
    expect(descriptorFor(TEXT_STATS_INPUT_FORM, pipe).fields).toHaveLength(1);
  });

  it("refuses a descriptor the report did not carry — the form would render empty", () => {
    expect(() => descriptorFor({}, pipe)).toThrow(/no input-form descriptor/);
  });
});

// ── The output binding ──────────────────────────────────────────────────────

describe("bindOutput", () => {
  const single = contractFor(TEXT_STATS_CONTRACTS, {
    ref: "text_stats.analyze_text",
    domain: "text_stats",
    code: "analyze_text",
  });

  it("binds a single output to the concept's generated exports", () => {
    expect(bindOutput(single, TEXT_STATS_ARTIFACTS)).toEqual({
      conceptCode: "Text",
      plural: false,
    });
  });

  it("flags a plural output — the narrower reads it as a list of the concept", () => {
    const plural = contractFor(DOCUMENTS_CONTRACTS, {
      ref: "documents.extract_text_pages",
      domain: "documents",
      code: "extract_text_pages",
    });
    expect(
      bindOutput(plural, [
        { path: "types.ts", content: "export const PageSchema = 1;\n" },
        { path: "binder.ts", content: "export function parsePage(w: unknown) {}\n" },
      ]),
    ).toEqual({ conceptCode: "Page", plural: true });
  });

  it("refuses when the emitter names the export something else, rather than writing a type error", () => {
    expect(() =>
      bindOutput(single, [
        { path: "types.ts", content: "export const SomethingElse = 1;\n" },
        { path: "binder.ts", content: "export function parseText(w: unknown) {}\n" },
      ]),
    ).toThrow(/exports no TextSchema/);
  });

  it("refuses when the codegen response carries no types.ts to bind against", () => {
    expect(() => bindOutput(single, [])).toThrow(/no types.ts/);
  });
});

// ── File inputs ─────────────────────────────────────────────────────────────

describe("fileInputsOf", () => {
  it("finds nothing in a text-only method", () => {
    expect(fileInputsOf(TEXT_STATS_INPUT_FORM["text_stats.analyze_text"]!)).toEqual([]);
  });

  it("finds a top-level document input", () => {
    expect(fileInputsOf(DOCUMENTS_INPUT_FORM["documents.extract_text_pages"]!)).toEqual([
      { path: "document", kind: "document" },
    ]);
  });

  it("finds a file inside a list or a structured input, at its dotted path", () => {
    // Depth changes nothing about what is scaffolded: `checkFileInputs` walks
    // the same descriptor, so a nested position is gated like a top-level one.
    const files = fileInputsOf({
      fields: [
        {
          kind: "list",
          name: "cvs",
          concept_ref: "native.Document",
          description: null,
          required: true,
          presence: "plain",
          gating: false,
          item: { kind: "document", concept_ref: "native.Document", description: null },
        },
        {
          kind: "object",
          name: "packet",
          concept_ref: "demo.Packet",
          description: null,
          required: true,
          presence: "plain",
          gating: true,
          fields: [
            {
              kind: "document",
              name: "scan",
              concept_ref: "native.Document",
              description: null,
            },
            {
              kind: "list",
              name: "shots",
              concept_ref: "native.Image",
              description: null,
              item: { kind: "image", concept_ref: "native.Image", description: null },
            },
          ],
        },
      ],
    } as never);
    expect(files).toEqual([
      { path: "cvs[]", kind: "document" },
      { path: "packet.scan", kind: "document" },
      { path: "packet.shots[]", kind: "image" },
    ]);
  });
});

describe("allowedMimesFor", () => {
  it("maps each file kind to the types the action accepts", () => {
    expect(allowedMimesFor([{ path: "d", kind: "document" }])).toEqual(["application/pdf"]);
    expect(allowedMimesFor([{ path: "i", kind: "image" }])).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    expect(
      allowedMimesFor([
        { path: "d", kind: "document" },
        { path: "shots[]", kind: "image" },
      ]),
    ).toEqual(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
  });
});

describe("hasGatingInput", () => {
  it("decides which of the two fixture-free tests the scaffold emits", () => {
    expect(hasGatingInput(TEXT_STATS_INPUT_FORM["text_stats.analyze_text"]!)).toBe(true);
    expect(hasGatingInput({ fields: [] })).toBe(false);
  });
});

// ── The command line ────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("takes the method positionally and the rest as flags", () => {
    expect(
      parseArgs([TEXT_STATS_REF, "--pipe", "analyze_text", "--name", "stats", "--dry-run"]),
    ).toEqual({
      method: TEXT_STATS_REF,
      pipe: "analyze_text",
      name: "stats",
      label: undefined,
      dryRun: true,
    });
  });

  it("refuses a swallowed value — `--label --dry-run` must not turn a rehearsal real", () => {
    expect(() => parseArgs([TEXT_STATS_REF, "--label", "--dry-run"])).toThrow(/missing value/);
  });

  it.each([
    [[TEXT_STATS_REF, "--nope"], /unknown argument/],
    [[TEXT_STATS_REF, "another"], /second method/],
    [["--dry-run"], /no method given/],
  ])("refuses %s", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

// ── The registry ────────────────────────────────────────────────────────────

/**
 * `src/components/ExampleTabs.tsx` with every tab taken out: the real file, so
 * the anchors are the ones on disk, emptied of the demos and of whatever a
 * project has since scaffolded. These tests run in projects made from this
 * template too, so they must not depend on which tabs that project still has —
 * only on the anchors.
 */
function emptiedRegistry(source: string): string {
  const lines = source.split("\n").filter((line) => !/^import\s.*\sfrom\s+"\.\/[A-Z]/.test(line));
  const arrayAt = lines.findIndex((line) => line.startsWith("const TABS"));
  // Everything between the opening bracket and the anchor's comment block is a
  // registration, however it was formatted; the block starts at its first comment.
  const commentAt = lines.findIndex((line, at) => at > arrayAt && line.trim().startsWith("//"));
  return [...lines.slice(0, arrayAt + 1), ...lines.slice(commentAt)].join("\n");
}

describe("registerMethod", () => {
  const ENTRY = { id: "demo", label: "Demo", componentName: "DemoForm" };

  /** The real file — this is the test that fails the day a template edit moves an anchor. */
  async function realRegistry(): Promise<string> {
    return readFile(path.join(REPO_ROOT, "src", "components", "ExampleTabs.tsx"), "utf-8");
  }

  it("inserts one import and one entry into the real ExampleTabs.tsx", async () => {
    const source = await realRegistry();
    const updated = registerMethod(source, ENTRY);

    expect(updated).toContain('import { DemoForm } from "./DemoForm";');
    expect(updated).toContain('{ id: "demo", label: "Demo", Component: DemoForm },');
    // Both anchors survive, in order, so the next scaffold run still finds them.
    expect(updated.indexOf(IMPORTS_ANCHOR)).toBeGreaterThan(-1);
    expect(updated.indexOf(TABS_ANCHOR)).toBeGreaterThan(updated.indexOf(IMPORTS_ANCHOR));
    // The import lands above its anchor and the entry inside the array.
    expect(updated.indexOf("import { DemoForm }")).toBeLessThan(updated.indexOf(IMPORTS_ANCHOR));
    expect(updated.indexOf('{ id: "demo"')).toBeLessThan(updated.indexOf(TABS_ANCHOR));
    // One line added at each anchor, and nothing else touched.
    expect(updated.split("\n")).toHaveLength(source.split("\n").length + 2);
  });

  it.each([IMPORTS_ANCHOR, TABS_ANCHOR])(
    "refuses a source with %s missing, naming it",
    async (anchor) => {
      const source = (await realRegistry())
        .split("\n")
        .filter((line) => !line.includes(anchor))
        .join("\n");
      expect(() => registerMethod(source, ENTRY)).toThrow(anchor);
    },
  );

  it("refuses a duplicate id and a duplicate component, pointing at --name", async () => {
    const source = registerMethod(await realRegistry(), ENTRY);
    expect(() => registerMethod(source, { ...ENTRY, componentName: "OtherForm" })).toThrow(
      /--name/,
    );
    expect(() => registerMethod(source, { ...ENTRY, id: "other" })).toThrow(/--name/);
  });

  it("lands the first entry inside the empty array, above the anchor comment", async () => {
    // The empty array the template ships is where the first entry goes: the
    // entry must land inside it, above the anchor comment, and nowhere else.
    const updated = registerMethod(emptiedRegistry(await realRegistry()), ENTRY);
    const body = updated.slice(updated.indexOf("const TABS"));
    expect(body).toMatch(
      /= \[\n\s+\{ id: "demo", label: "Demo", Component: DemoForm \},\n\s+\/\/ add-method:tabs/,
    );
  });
});

// ── The templates ───────────────────────────────────────────────────────────

const TEXT_STATS_PLAN: ScaffoldPlan = {
  names: scaffoldNames("text-stats"),
  source: { kind: "selector", selector: { method_ref: TEXT_STATS_REF } },
  pipe: { ref: "text_stats.analyze_text", domain: "text_stats", code: "analyze_text" },
  binding: { conceptCode: "Text", plural: false },
  files: [],
  gating: true,
};

/** The bundle arm, as the receipt-review fixture scaffolds: a list of documents in, a list out. */
const RECEIPTS_PLAN: ScaffoldPlan = {
  names: scaffoldNames("receipt-review"),
  source: { kind: "files" },
  pipe: {
    ref: "receipt_review.review_receipts",
    domain: "receipt_review",
    code: "review_receipts",
  },
  binding: { conceptCode: "ReceiptSummary", plural: true },
  files: [{ path: "receipts[]", kind: "document" }],
  gating: false,
};

/** The plural + document variant, built from the `documents` measurements. */
const DOCUMENTS_PLAN: ScaffoldPlan = {
  names: scaffoldNames("documents", "Document pages"),
  source: { kind: "selector", selector: { method_id: "mt_ca0aa9d3-61ac-4db1-8b46-fb0cc75787df" } },
  pipe: { ref: "documents.extract_text_pages", domain: "documents", code: "extract_text_pages" },
  binding: { conceptCode: "Page", plural: true },
  files: [{ path: "document", kind: "document" }],
  gating: true,
};

describe("renderManifest", () => {
  it("holds the selector and nothing else", () => {
    expect(renderManifest({ method_ref: TEXT_STATS_REF })).toBe(
      `{\n  "method_ref": "${TEXT_STATS_REF}"\n}\n`,
    );
  });
});

describe("renderAdapter", () => {
  it("hands wireOutput to the method's own generated binder", () => {
    const source = renderAdapter(TEXT_STATS_PLAN);
    expect(source).toContain('import { parseText } from "@/generated/text-stats/binder";');
    expect(source).toContain("export type TextStatsOutput = Text;");
    expect(source).toContain("return parseText(wireOutput(results, TextSchema));");
    expect(source).toContain(
      'import { TextSchema, type Text } from "@/generated/text-stats/types";',
    );
    expect(source).toContain("throw new BadPipelineOutputError(");
    // No shape is declared: if this file lists fields, it duplicates the method.
    expect(source).not.toMatch(/z\.object\(\{\s*\w+:/);
  });

  it("names the bundle's directory as the source of a bundle-sourced slice", () => {
    const source = renderAdapter(RECEIPTS_PLAN);
    expect(source).toContain("the bundle in `methods/receipt-review/`");
    expect(source).not.toContain("method.json");
  });

  it("types a plural output as a list of the concept, read through wireListOutput", () => {
    const source = renderAdapter(DOCUMENTS_PLAN);
    expect(source).toContain("export type DocumentsOutput = Page[];");
    expect(source).toContain("const DocumentsOutputSchema = z.array(PageSchema);");
    // `wireListOutput` is what accepts both renderings of a list output — the
    // `{ items: [...] }` envelope and the bare array — so no envelope is
    // declared here, and the single-value binder is deliberately not used.
    expect(source).toContain("DocumentsOutputSchema.parse(wireListOutput(results, PageSchema))");
    expect(source).not.toContain("z.object(");
    expect(source).not.toContain("parsePage(");
  });
});

describe("renderAction", () => {
  it("sends the selector in place of an inline bundle, with the qualified pipe ref", () => {
    const source = renderAction(TEXT_STATS_PLAN);
    // The selector is read from the manifest, never copied into the action, so
    // an upgrade — edit the manifest, regenerate — moves the run with the tree.
    expect(source).toContain('import MANIFEST from "@methods/text-stats/method.json";');
    expect(source).toContain("const METHOD_REF = MANIFEST.method_ref;");
    expect(source).not.toContain(TEXT_STATS_REF);
    expect(source).toContain('const PIPE_CODE = "analyze_text";');
    expect(source).toContain('requireContract(PIPE_IO_CONTRACTS, "text_stats", PIPE_CODE)');
    expect(source).toContain("method_ref: METHOD_REF,");
    // The run names the pipe by its exact key: a bare code is searched across
    // every domain of the method and refused once two domains declare it.
    expect(source).toContain('const PIPE_REF = "text_stats.analyze_text";');
    expect(source).toContain("pipe_code: PIPE_REF,");
    expect(source).not.toContain("pipe_code: PIPE_CODE,");
    // No bundle loader, and no hand-guard beside the gate.
    expect(source).not.toContain("loadBundle");
    expect(source).not.toContain("mthds_contents");
    expect(source).toContain("const gated = gateRunInputs(CONTRACT, data);");
    for (const name of ["runTextStatsBlocking", "startTextStatsRun", "pollTextStatsRun"]) {
      expect(source).toContain(`export async function ${name}`);
    }
  });

  it("adds the file gate, the grant action and prepareInputs when the method takes a file", () => {
    const source = renderAction(DOCUMENTS_PLAN);
    // The media types live in their own module, which the form reads as well: a
    // `"use server"` file may export async functions only.
    expect(source).toContain('import { ALLOWED_MIMES } from "@/types/documentsUploads";');
    expect(source).not.toContain("const ALLOWED_MIMES");
    // A dropped file is stored before the run, through a grant this action asks
    // for with the method's own media types; the run then carries references.
    expect(source).toContain(
      "export async function requestDocumentsUpload(request: UploadRequest): Promise<GrantOutcome> {",
    );
    expect(source).toContain(
      "return grantFileUpload(request, { allowedMimes: ALLOWED_MIMES, maxBytes: MAX_FILE_BYTES });",
    );
    // The file gate walks the pipe's wire descriptor, the same one the form is
    // rendered from — so the action looks it up beside the contract.
    expect(source).toContain(
      'import { INPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/documents/contracts";',
    );
    expect(source).toContain(
      'const DESCRIPTOR = requireInputForm(INPUT_FORM, "documents", PIPE_CODE);',
    );
    expect(source).toContain("checkFileInputs(DESCRIPTOR, gated.inputs);");
    // prepareInputs keys on the QUALIFIED ref — a bare pipe code is refused.
    expect(source).toContain('const PIPE_REF = "documents.extract_text_pages";');
    expect(source).toContain("pipe_ref: PIPE_REF,");
    // …and the run is sent the same ref.
    expect(source).toContain("pipe_code: PIPE_REF,");
    expect(source).toContain("const METHOD_ID = MANIFEST.method_id;");
    expect(source).toContain("method_id: METHOD_ID,");
    // The file gate runs over the GATED inputs, never beside the gate — so
    // inside `gateInputs` the shape gate comes first and short-circuits.
    const gate = source.slice(source.indexOf("function gateInputs("));
    expect(gate.indexOf("gateRunInputs(CONTRACT, data)")).toBeLessThan(
      gate.indexOf("checkFileInputs(DESCRIPTOR, gated.inputs"),
    );
  });

  it("scaffolds the same file path for a file below the top level", () => {
    // A `cvs: Document[]` slice is gated, uploaded and dropped into exactly like
    // a top-level document — the descriptor walk reaches every position.
    const source = renderAction({
      ...DOCUMENTS_PLAN,
      files: [{ path: "cvs[]", kind: "document" }],
    });
    expect(source).toContain('import { ALLOWED_MIMES } from "@/types/documentsUploads";');
    expect(source).toContain("checkFileInputs(DESCRIPTOR, gated.inputs);");
    expect(source).toContain("prepareInputs({");
  });

  it("sends a bundle-sourced method inline, naming its directory once", () => {
    const source = renderAction({ ...RECEIPTS_PLAN, files: [], gating: true });
    expect(source).toContain('import { loadMethodBundles } from "@/lib/loadBundle";');
    expect(source).toContain('const METHOD_DIR = "receipt-review";');
    expect(source).toContain("mthds_contents: await loadMethodBundles(METHOD_DIR),");
    // No manifest and no selector: the bundle is the method.
    expect(source).not.toContain("MANIFEST");
    expect(source).not.toContain("method_ref");
    expect(source).not.toContain("method_id");
  });

  it("hands prepareInputs the same bundle the run sends, when it takes a file", () => {
    const source = renderAction(RECEIPTS_PLAN);
    expect(source).toContain("const bundles = await loadMethodBundles(METHOD_DIR);");
    expect(source).toContain("files: bundles.map((content) => ({ content })),");
    expect(source).toContain("mthds_contents: bundles,");
    expect(source).toContain('const PIPE_REF = "receipt_review.review_receipts";');
    // Read once per run: prepareInputs and the run options share the one read.
    expect(source.match(/loadMethodBundles\(/g)).toHaveLength(1);
  });
});

describe("renderUploads", () => {
  it("holds the media types the method's file inputs take, for both halves to import", () => {
    const source = renderUploads(DOCUMENTS_PLAN);
    expect(source).toContain('export const ALLOWED_MIMES = ["application/pdf"];');
    expect(source).toContain("`requestDocumentsUpload` refuses a grant for any");
    // A plain module: the form, a client component, imports it too.
    expect(source).not.toContain("use server");
    expect(source).not.toContain("use client");
  });

  it("takes every kind the method's file inputs declare", () => {
    const source = renderUploads({
      ...DOCUMENTS_PLAN,
      files: [
        { path: "document", kind: "document" },
        { path: "shots[]", kind: "image" },
      ],
    });
    expect(source).toContain(
      'export const ALLOWED_MIMES = ["application/pdf","image/png","image/jpeg","image/webp"];',
    );
  });
});

describe("renderActionTest", () => {
  it("pins the trust boundary for a gating pipe, and nothing it would have to invent", () => {
    const source = renderActionTest(TEXT_STATS_PLAN);
    expect(source).toContain("refuses an empty submission before calling the SDK (blocking)");
    expect(source).toContain("expect(execute).not.toHaveBeenCalled();");
    expect(source).not.toContain("execute.mockResolvedValue");
    // Nothing here reads the selector, and an unused import would fail tsc.
    expect(source).not.toContain("MANIFEST");
  });

  it("pins the wiring instead when the pipe gates on nothing", () => {
    const source = renderActionTest({ ...TEXT_STATS_PLAN, gating: false });
    expect(source).toContain("expect(execute).toHaveBeenCalledWith({");
    expect(source).toContain('import MANIFEST from "@methods/text-stats/method.json";');
    expect(source).toContain("method_ref: MANIFEST.method_ref,");
    expect(source).toContain('pipe_code: "text_stats.analyze_text",');
  });

  it("pins the bundle it sends when a bundle-sourced pipe gates on nothing", () => {
    const source = renderActionTest(RECEIPTS_PLAN);
    expect(source).toContain('import { loadMethodBundles } from "@/lib/loadBundle";');
    expect(source).toContain('mthds_contents: await loadMethodBundles("receipt-review"),');
    expect(source).toContain("prepareInputs.mockResolvedValueOnce(");
    expect(source).not.toContain("MANIFEST");
  });

  it("pins the grant action's boundary when the method takes a file", () => {
    const source = renderActionTest(RECEIPTS_PLAN);
    expect(source).toContain("refuses to grant an upload of a type the method does not take");
    expect(source).toContain("expect(requestUploadGrant).not.toHaveBeenCalled();");
    expect(renderActionTest(TEXT_STATS_PLAN)).not.toContain("requestUploadGrant");
  });
});

describe("renderForm", () => {
  it("writes no input markup — the descriptor declares the fields", () => {
    const source = renderForm(TEXT_STATS_PLAN);
    expect(source).toContain("useRunInputs(CONTRACT, DESCRIPTOR)");
    expect(source).toContain("<RunInputsForm");
    for (const tag of ["<textarea", "<input", "<select"]) expect(source).not.toContain(tag);
    // A method with no file input has no media types to narrow to.
    expect(source).not.toContain("ALLOWED_MIMES");
  });

  it("narrows each file input to the media types the upload action grants", () => {
    const source = renderForm(DOCUMENTS_PLAN);
    expect(source).toContain('import { ALLOWED_MIMES } from "@/types/documentsUploads";');
    expect(source).toContain("useRunInputs(CONTRACT, DESCRIPTOR, {");
    expect(source).toContain("allowedMimes: ALLOWED_MIMES,");
  });

  it("hands the run id to the status card and the error display", () => {
    // A durable run's id is the only handle on it once the page is closed, and
    // the scaffold writes every form, so the chrome gets it here or nowhere.
    const source = renderForm(TEXT_STATS_PLAN);
    expect(source).toContain("runId={state.runId}");
    expect(source).toContain("<ErrorDisplay error={state.error} runId={state.runId} />");
  });

  it("names the method on its Run button, keeping an acronym's capitals", () => {
    expect(renderForm(TEXT_STATS_PLAN)).toContain('"Run text stats"');
    expect(
      renderForm({ ...TEXT_STATS_PLAN, names: scaffoldNames("cv-screening", "CV screening") }),
    ).toContain('"Run CV screening"');
  });

  it("renders the result from the output contract, not from a hand-written view", () => {
    // The half the scaffold could not project before the output-form descriptor
    // existed: a result component is a design decision about a shape, and the
    // shape is now declared. The stuff name is the slug in the wire's
    // snake_case, so the kernel's `app` presentation humanizes it for the header.
    const source = renderForm(TEXT_STATS_PLAN);
    expect(source).toContain(
      'const RESULT_FIELD = requireResultField(OUTPUT_FORM, CONTRACT, "text_stats", "analyze_text");',
    );
    expect(source).toContain(
      '<RunResult field={RESULT_FIELD} value={state.output} name="text_stats" />',
    );
    expect(source).toContain(
      'import { INPUT_FORM, OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/text-stats/contracts";',
    );
  });

  it("wires the kernel's file seam through useFileInputs when the method takes a file", () => {
    const source = renderForm(DOCUMENTS_PLAN);
    expect(source).toContain('import { useFileInputs } from "@/hooks/useFileInputs";');
    expect(source).toContain("env={{ onDropFile: dropFile, uploadingIds }}");
    expect(source).toContain("{fileError && <ErrorDisplay error={fileError} />}");
  });

  it("holds the run while a file is uploading — its value is unset until then", () => {
    // `ready` speaks only for the inputs the gate refuses empty, so an optional
    // or non-gating file input (a list of receipts) would otherwise run without
    // the file the person just dropped.
    const source = renderForm(RECEIPTS_PLAN);
    expect(source).toContain("disabled={running || uploadingIds.size > 0 || !ready}");
    expect(source).toContain("if (uploadingIds.size > 0) return;");
    // The file is stored through the method's own grant action before any run.
    expect(source).toContain("requestUpload: requestReceiptReviewUpload,");
    expect(renderForm(TEXT_STATS_PLAN)).toContain("disabled={running || !ready}");
  });

  it("keeps the finished run's id under the result, with the cost folded beside it", () => {
    const source = renderForm(TEXT_STATS_PLAN);
    expect(source).toContain('import { RunDetails } from "./RunDetails";');
    expect(source).toContain("<RunDetails runId={state.runId} usage={state.usage} />");
    expect(source).not.toContain("CostReport");
  });
});

// ── The orchestration ───────────────────────────────────────────────────────
//
// What is worth pinning here is not the writing (the templates above cover
// that, and `writeTree` has its own tests) but the ORDERING the design rests
// on: every refusal happens in the read-only half, having written nothing.

describe("runAddMethod", () => {
  let root: string;

  /** A skeleton with just enough of the repo for the gesture to land in. */
  async function skeleton(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "add-method-"));
    for (const relative of [
      "methods",
      "src/generated",
      "src/types",
      "src/actions",
      "src/components",
    ]) {
      await mkdir(path.join(dir, relative), { recursive: true });
    }
    // The real registry, copied rather than fabricated, so the anchors under
    // test stay exactly the ones on disk — emptied of its tabs, since this
    // checkout already ships `text-stats` and these runs would otherwise be
    // refused as duplicates.
    const tabs = path.join("src", "components", "ExampleTabs.tsx");
    await writeFile(
      path.join(dir, tabs),
      emptiedRegistry(await readFile(path.join(REPO_ROOT, tabs), "utf-8")),
      "utf-8",
    );
    return dir;
  }

  function fakeClient(overrides: Record<string, unknown> = {}) {
    return {
      version: vi.fn().mockResolvedValue({ extensions: ["runs", "method_id", "method_ref"] }),
      getMethod: vi.fn().mockResolvedValue({ name: "pipelex_mcp_e2e_fixture" }),
      codegen: vi.fn().mockResolvedValue({
        is_valid: true,
        artifacts: TEXT_STATS_ARTIFACTS,
        lock: TEXT_STATS_LOCK,
        lock_filename: "codegen.lock",
        crate_fingerprint: "28f776a299e6ab8d2c14fafae459f5daa50bd030ee1191d149e566f0f37d38e2",
        engine_version: "0.56.0",
      }),
      validate: vi.fn().mockResolvedValue({
        is_valid: true,
        pipe_io_contracts: TEXT_STATS_CONTRACTS,
        input_form: TEXT_STATS_INPUT_FORM,
        output_form: TEXT_STATS_OUTPUT_FORM,
        default_pipe_ref: "text_stats.analyze_text",
      }),
      validateFiles: vi.fn(),
      ...overrides,
    } as unknown as Pick<
      PipelexApiClient,
      "codegen" | "validate" | "validateFiles" | "version" | "getMethod"
    > & { codegen: Mock; validate: Mock; validateFiles: Mock; version: Mock; getMethod: Mock };
  }

  /** A client answering for the receipt-review bundle, with its recorded responses. */
  function receiptsClient() {
    return fakeClient({
      codegen: vi.fn().mockResolvedValue(RECEIPT_REVIEW_CODEGEN),
      validateFiles: vi.fn().mockResolvedValue(RECEIPT_REVIEW_VALIDATE),
    });
  }

  function deps(client = fakeClient()) {
    return { repoRoot: root, client, baseUrl: "https://api.example" };
  }

  beforeEach(async () => {
    root = await skeleton();
    (runCodegenCheck as unknown as Mock).mockResolvedValue({ drifts: [], isCurrent: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  /** Every path the gesture creates, relative to the skeleton, sorted. */
  async function written(): Promise<string[]> {
    const found: string[] = [];
    async function walkInto(relative: string): Promise<void> {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walkInto(child);
        else found.push(child.replace(/^\//, ""));
      }
    }
    await walkInto("");
    return found.sort();
  }

  it("writes the manifest, the tree and the app files, and edits the registry", async () => {
    expect(await runAddMethod([TEXT_STATS_REF], deps())).toBe(0);

    expect(await written()).toEqual([
      `methods/text-stats/${MANIFEST_FILENAME}`,
      "src/actions/runTextStatsPipeline.test.ts",
      "src/actions/runTextStatsPipeline.ts",
      "src/components/ExampleTabs.tsx",
      "src/components/TextStatsForm.tsx",
      "src/generated/text-stats/binder.ts",
      "src/generated/text-stats/codegen.lock",
      "src/generated/text-stats/contracts.ts",
      "src/generated/text-stats/sources.json",
      "src/generated/text-stats/types.ts",
      "src/types/textStatsPipeline.ts",
    ]);
    expect(await readFile(path.join(root, "methods/text-stats", MANIFEST_FILENAME), "utf-8")).toBe(
      `{\n  "method_ref": "${TEXT_STATS_REF}"\n}\n`,
    );
    const registry = await readFile(path.join(root, "src/components/ExampleTabs.tsx"), "utf-8");
    expect(registry).toContain('import { TextStatsForm } from "./TextStatsForm";');
    expect(registry).toContain(
      '{ id: "text-stats", label: "Text stats", Component: TextStatsForm }',
    );
  });

  it("records the manifest's own hash as the tree's source — that is the staleness gate", async () => {
    await runAddMethod([TEXT_STATS_REF], deps());

    const sidecar: unknown = JSON.parse(
      await readFile(path.join(root, "src/generated/text-stats/sources.json"), "utf-8"),
    );
    expect(sidecar).toMatchObject({
      sources: { [`methods/text-stats/${MANIFEST_FILENAME}`]: expect.any(String) },
    });
  });

  it("is one-shot: a second run is refused on the collision, changing nothing", async () => {
    await runAddMethod([TEXT_STATS_REF], deps());
    const before = await written();
    const registryBefore = await readFile(
      path.join(root, "src/components/ExampleTabs.tsx"),
      "utf-8",
    );

    expect(await runAddMethod([TEXT_STATS_REF], deps())).toBe(1);

    expect(await written()).toEqual(before);
    expect(await readFile(path.join(root, "src/components/ExampleTabs.tsx"), "utf-8")).toBe(
      registryBefore,
    );
  });

  it("takes --name and --label, and --name is what makes a second slice possible", async () => {
    await runAddMethod([TEXT_STATS_REF], deps());
    expect(
      await runAddMethod(
        [TEXT_STATS_REF, "--name", "word-counts", "--label", "Word counts"],
        deps(),
      ),
    ).toBe(0);

    const registry = await readFile(path.join(root, "src/components/ExampleTabs.tsx"), "utf-8");
    expect(registry).toContain(
      '{ id: "word-counts", label: "Word counts", Component: WordCountsForm }',
    );
  });

  it("names a stored method's slice after its catalog name", async () => {
    const client = fakeClient();
    expect(await runAddMethod(["mt_ca0aa9d3-61ac-4db1-8b46-fb0cc75787df"], deps(client))).toBe(0);

    expect(client.getMethod).toHaveBeenCalledWith("mt_ca0aa9d3-61ac-4db1-8b46-fb0cc75787df");
    expect(await written()).toContain("src/components/PipelexMcpE2eFixtureForm.tsx");
    const action = await readFile(
      path.join(root, "src/actions/runPipelexMcpE2eFixturePipeline.ts"),
      "utf-8",
    );
    expect(action).toContain("const METHOD_ID = MANIFEST.method_id;");
    const manifest = await readFile(
      path.join(root, "methods/pipelex-mcp-e2e-fixture/method.json"),
      "utf-8",
    );
    expect(JSON.parse(manifest)).toEqual({ method_id: "mt_ca0aa9d3-61ac-4db1-8b46-fb0cc75787df" });
  });

  it("--dry-run stops at the end of the read-only half, writing nothing", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));

    expect(await runAddMethod([TEXT_STATS_REF, "--dry-run"], deps())).toBe(0);

    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
    expect(lines.join("\n")).toContain("text_stats.analyze_text");
    expect(lines.join("\n")).toContain("Nothing was written");
  });

  it("refuses a --name that cannot become a TypeScript identifier, writing nothing", async () => {
    const client = fakeClient();
    expect(await runAddMethod([TEXT_STATS_REF, "--name", "3d-model"], deps(client))).toBe(1);

    expect(client.codegen).not.toHaveBeenCalled();
    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
  });

  it("refuses a base URL that does not forward the selector, before any fetch", async () => {
    const client = fakeClient({
      version: vi.fn().mockResolvedValue({ extensions: ["runs", "method_id"] }),
    });

    expect(await runAddMethod([TEXT_STATS_REF], deps(client))).toBe(1);

    expect(client.codegen).not.toHaveBeenCalled();
    expect(client.validate).not.toHaveBeenCalled();
    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
  });

  it("refuses an unresolvable selector with the server's own message, writing nothing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (line: unknown) => void errors.push(String(line)),
    );
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
            "No package at address 'github.com/Pipelex/methods/__nope__'.",
            undefined,
            undefined,
          ),
        ),
    });

    expect(await runAddMethod(["github.com/Pipelex/methods/__nope__"], deps(client))).toBe(1);

    expect(errors.join("\n")).toContain("No package at address");
    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
  });

  it("refuses a multi-pipe method that names no default, listing the pipes", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (line: unknown) => void errors.push(String(line)),
    );
    const client = fakeClient({
      validate: vi.fn().mockResolvedValue({
        is_valid: true,
        pipe_io_contracts: DOCUMENTS_CONTRACTS,
        input_form: DOCUMENTS_INPUT_FORM,
        output_form: DOCUMENTS_OUTPUT_FORM,
        default_pipe_ref: null,
      }),
    });

    expect(await runAddMethod(["github.com/Pipelex/methods/documents"], deps(client))).toBe(1);

    expect(errors.join("\n")).toContain("pass --pipe");
    expect(errors.join("\n")).toContain("documents.extract_text_pages");
    // The tree fetch happened (the pipe rule reads the validate report), but the
    // refusal still landed before the write half.
    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
  });

  it("scaffolds the whole file path for a file below the top level, and warns of nothing", async () => {
    // A file inside a structured or list input used to be a scaffold-time
    // warning, because the action's gate could not reach it. The gate now walks
    // the descriptor, so the slice gets the gate, the upload and the drop seam
    // like a top-level document — and the plan names the position instead.
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const client = fakeClient({
      validate: vi.fn().mockResolvedValue({
        is_valid: true,
        pipe_io_contracts: TEXT_STATS_CONTRACTS,
        input_form: {
          "text_stats.analyze_text": {
            fields: [
              {
                kind: "object",
                name: "packet",
                concept_ref: "demo.Packet",
                description: null,
                required: true,
                presence: "plain",
                gating: true,
                fields: [
                  {
                    kind: "document",
                    name: "scan",
                    concept_ref: "native.Document",
                    description: null,
                  },
                ],
              },
            ],
          },
        },
        output_form: TEXT_STATS_OUTPUT_FORM,
        default_pipe_ref: "text_stats.analyze_text",
      }),
    });

    expect(await runAddMethod([TEXT_STATS_REF], deps(client))).toBe(0);

    const printed = lines.join("\n");
    expect(printed).toContain("files:  packet.scan");
    expect(printed).not.toContain("handle it yourself");

    const action = await readFile(
      path.join(root, "src", "actions", "runTextStatsPipeline.ts"),
      "utf-8",
    );
    expect(action).toContain("checkFileInputs(DESCRIPTOR, gated.inputs);");
    const form = await readFile(path.join(root, "src", "components", "TextStatsForm.tsx"), "utf-8");
    expect(form).toContain("useFileInputs");
  });

  // ── The bundle arm ──

  it("copies a bundle into methods/<domain>/ and scaffolds it as a files source", async () => {
    const client = receiptsClient();
    expect(await runAddMethod([RECEIPTS_DIR], deps(client))).toBe(0);

    expect(await written()).toEqual([
      "methods/receipt-review/concepts.mthds",
      "methods/receipt-review/main.mthds",
      "src/actions/runReceiptReviewPipeline.test.ts",
      "src/actions/runReceiptReviewPipeline.ts",
      "src/components/ExampleTabs.tsx",
      "src/components/ReceiptReviewForm.tsx",
      "src/generated/receipt-review/binder.ts",
      "src/generated/receipt-review/codegen.lock",
      "src/generated/receipt-review/contracts.ts",
      "src/generated/receipt-review/sources.json",
      "src/generated/receipt-review/types.ts",
      "src/types/receiptReviewPipeline.ts",
      "src/types/receiptReviewUploads.ts",
    ]);
    // Copied byte for byte.
    expect(await readFile(path.join(root, "methods/receipt-review/main.mthds"), "utf-8")).toBe(
      await readFile(path.join(RECEIPTS_DIR, "main.mthds"), "utf-8"),
    );
    // Sent under the names it was read by, so a diagnostic names the person's file…
    expect(client.validateFiles.mock.calls[0]![0].map((file: { uri: string }) => file.uri)).toEqual(
      [path.join(RECEIPTS_DIR, "concepts.mthds"), path.join(RECEIPTS_DIR, "main.mthds")],
    );
    // …and recorded under the names it now has, which is what `codegen:check` hashes.
    const sidecar = JSON.parse(
      await readFile(path.join(root, "src/generated/receipt-review/sources.json"), "utf-8"),
    ) as { sources: Record<string, string> };
    expect(Object.keys(sidecar.sources)).toEqual([
      "methods/receipt-review/concepts.mthds",
      "methods/receipt-review/main.mthds",
    ]);
    const action = await readFile(
      path.join(root, "src/actions/runReceiptReviewPipeline.ts"),
      "utf-8",
    );
    expect(action).toContain('const METHOD_DIR = "receipt-review";');
    expect(client.version).not.toHaveBeenCalled();
  });

  it("resolves a relative bundle path from the directory the command was typed in", async () => {
    const client = receiptsClient();
    const relative = path.relative(REPO_ROOT, RECEIPTS_DIR);
    expect(await runAddMethod([relative], { ...deps(client), cwd: REPO_ROOT })).toBe(0);

    expect(client.validateFiles.mock.calls[0]![0][0].uri).toBe(
      path.join(relative, "concepts.mthds"),
    );
  });

  it("takes --name for a copied bundle", async () => {
    expect(await runAddMethod([RECEIPTS_DIR, "--name", "receipts"], deps(receiptsClient()))).toBe(
      0,
    );
    expect(await written()).toContain("methods/receipts/main.mthds");
    expect(await written()).toContain("src/components/ReceiptsForm.tsx");
  });

  it("scaffolds a bundle already in methods/ in place, named by its directory", async () => {
    for (const name of ["concepts.mthds", "main.mthds"]) {
      await mkdir(path.join(root, "methods/receipts"), { recursive: true });
      await writeFile(
        path.join(root, "methods/receipts", name),
        await readFile(path.join(RECEIPTS_DIR, name), "utf-8"),
        "utf-8",
      );
    }
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));

    const code = await runAddMethod(["methods/receipts/main.mthds"], deps(receiptsClient()));

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("in place");
    const files = await written();
    expect(files).toContain("src/components/ReceiptsForm.tsx");
    expect(files.filter((file) => file.startsWith("methods/"))).toEqual([
      "methods/receipts/concepts.mthds",
      "methods/receipts/main.mthds",
    ]);
  });

  it("refuses a --name that disagrees with the directory a bundle sits in", async () => {
    await mkdir(path.join(root, "methods/receipts"), { recursive: true });
    await writeFile(path.join(root, "methods/receipts/main.mthds"), 'domain = "x"\n', "utf-8");
    const client = receiptsClient();

    expect(await runAddMethod(["methods/receipts", "--name", "other"], deps(client))).toBe(1);
    expect(client.codegen).not.toHaveBeenCalled();
  });

  it("refuses to copy a bundle over a method directory that exists, writing nothing", async () => {
    await mkdir(path.join(root, "methods/receipt-review"), { recursive: true });
    const before = await written();

    expect(await runAddMethod([RECEIPTS_DIR], deps(receiptsClient()))).toBe(1);
    expect(await written()).toEqual(before);
  });

  it("removes everything it wrote when the write half fails, so a re-run succeeds", async () => {
    // The self-check in the read-only half passes; the orphan pass in the
    // writer — after the tree's files are on disk — fails.
    (runCodegenCheck as unknown as Mock)
      .mockResolvedValueOnce({ drifts: [], isCurrent: true })
      .mockRejectedValueOnce(new Error("disk went away"));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (line: unknown) => void errors.push(String(line)),
    );
    const registryBefore = await readFile(
      path.join(root, "src/components/ExampleTabs.tsx"),
      "utf-8",
    );

    expect(await runAddMethod([RECEIPTS_DIR], deps(receiptsClient()))).toBe(1);

    expect(errors.join("\n")).toContain("everything this run had created was removed");
    expect(errors.join("\n")).toContain("disk went away");
    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
    expect(await readFile(path.join(root, "src/components/ExampleTabs.tsx"), "utf-8")).toBe(
      registryBefore,
    );

    expect(await runAddMethod([RECEIPTS_DIR], deps(receiptsClient()))).toBe(0);
  });

  it("leaves a method directory another run created after the plan, and its files", async () => {
    const plan = await planAddMethod(
      { method: RECEIPTS_DIR, dryRun: false },
      deps(receiptsClient()),
    );
    // Between the plan and the write, another run claims the same directory.
    const foreign = path.join(root, "methods/receipt-review");
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, "main.mthds"), 'domain = "theirs"\n', "utf-8");
    await writeFile(path.join(foreign, "NOTES.txt"), "not this run's\n", "utf-8");

    await expect(writeAddMethod(plan, deps(receiptsClient()))).rejects.toThrow(AddMethodError);

    expect(await written()).toEqual([
      "methods/receipt-review/NOTES.txt",
      "methods/receipt-review/main.mthds",
      "src/components/ExampleTabs.tsx",
    ]);
    expect(await readFile(path.join(foreign, "main.mthds"), "utf-8")).toBe('domain = "theirs"\n');
  });

  it("refuses a generated tree that appeared after the plan, and leaves it", async () => {
    const plan = await planAddMethod(
      { method: RECEIPTS_DIR, dryRun: false },
      deps(receiptsClient()),
    );
    const tree = path.join(root, "src/generated/receipt-review");
    await mkdir(tree, { recursive: true });
    await writeFile(path.join(tree, "types.ts"), "// theirs\n", "utf-8");

    await expect(writeAddMethod(plan, deps(receiptsClient()))).rejects.toThrow(
      "appeared after the plan was made",
    );

    expect(await written()).toEqual([
      "src/components/ExampleTabs.tsx",
      "src/generated/receipt-review/types.ts",
    ]);
    expect(await readFile(path.join(tree, "types.ts"), "utf-8")).toBe("// theirs\n");
  });

  it("names the regenerated tree it keeps when an in-place scaffold fails", async () => {
    await mkdir(path.join(root, "methods/receipts"), { recursive: true });
    for (const name of ["concepts.mthds", "main.mthds"]) {
      await writeFile(
        path.join(root, "methods/receipts", name),
        await readFile(path.join(RECEIPTS_DIR, name), "utf-8"),
        "utf-8",
      );
    }
    await mkdir(path.join(root, "src/generated/receipts"), { recursive: true });
    await writeFile(path.join(root, "src/generated/receipts/types.ts"), "// stale\n", "utf-8");
    const plan = await planAddMethod(
      { method: "methods/receipts", dryRun: false },
      deps(receiptsClient()),
    );
    // An app file appears after the plan, so the write half fails after the tree.
    const appFile = plan.emitted.find((file) => file.relative !== plan.paths.registry)!;
    await writeFile(path.join(root, appFile.relative), "// theirs\n", "utf-8");

    const failure = writeAddMethod(plan, deps(receiptsClient()));

    await expect(failure).rejects.toThrow("src/generated/receipts/, which existed before");
    await expect(failure).rejects.toThrow("regenerated in place");
    const files = await written();
    expect(files).toContain("src/generated/receipts/types.ts");
    expect(files).toContain(appFile.relative);
    // The form it wrote is gone; the registry beside it was restored, not removed.
    expect(
      files.filter((file) => file.startsWith("src/components/") && file !== plan.paths.registry),
    ).toEqual([]);
    expect(await readFile(path.join(root, "src/generated/receipts/types.ts"), "utf-8")).not.toBe(
      "// stale\n",
    );
  });

  it("refuses to write while another run holds the lock, so its tree survives", async () => {
    // A bundle in place with no tree yet: the case where a run that made the
    // tree and then failed would remove it, after a second run had rewritten
    // it and succeeded.
    await mkdir(path.join(root, "methods/receipts"), { recursive: true });
    for (const name of ["concepts.mthds", "main.mthds"]) {
      await writeFile(
        path.join(root, "methods/receipts", name),
        await readFile(path.join(RECEIPTS_DIR, name), "utf-8"),
        "utf-8",
      );
    }
    const args = { method: "methods/receipts", dryRun: false };
    const first = await planAddMethod(args, deps(receiptsClient()));
    const second = await planAddMethod(args, deps(receiptsClient()));

    // The first run pauses in the writer's check, its tree already on disk.
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    (runCodegenCheck as unknown as Mock).mockImplementationOnce(async () => {
      reached();
      await gate;
      return { drifts: [], isCurrent: true };
    });
    const writing = writeAddMethod(first, deps(receiptsClient()));
    await paused;
    const during = await written();
    expect(during).toContain(WRITE_LOCK_FILENAME);
    expect(during).toContain("src/generated/receipts/types.ts");

    const refusal = await refusalOf(writeAddMethod(second, deps(receiptsClient())));
    expect(refusal.message).toContain(
      `another \`make add-method\` (pid ${process.pid}) is writing in this app`,
    );
    // A live pid may be a reused one, so the refusal still names the file.
    expect(refusal.message).toContain(`left ${WRITE_LOCK_FILENAME} behind`);
    expect(await written()).toEqual(during);

    resume();
    await writing;
    const after = await written();
    expect(after).toContain("src/generated/receipts/types.ts");
    expect(after).not.toContain(WRITE_LOCK_FILENAME);
  });

  it("refuses a lock left by a run that is gone, naming it, until it is removed", async () => {
    const plan = await planAddMethod(
      { method: RECEIPTS_DIR, dryRun: false },
      deps(receiptsClient()),
    );
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(path.join(root, WRITE_LOCK_FILENAME), `${gone}\n`, "utf-8");
    const before = await written();

    const refusal = await refusalOf(writeAddMethod(plan, deps(receiptsClient())));

    expect(refusal.message).toContain(`held by pid ${gone}, which is no longer running`);
    expect(refusal.message).toContain(`remove ${WRITE_LOCK_FILENAME}`);
    expect(await written()).toEqual(before);

    await rm(path.join(root, WRITE_LOCK_FILENAME));
    await writeAddMethod(plan, deps(receiptsClient()));
    expect(await written()).toContain("src/generated/receipt-review/types.ts");
    expect(await written()).not.toContain(WRITE_LOCK_FILENAME);
  });

  it("reads a lock holding no pid as one being taken or released, not as stale", async () => {
    const plan = await planAddMethod(
      { method: RECEIPTS_DIR, dryRun: false },
      deps(receiptsClient()),
    );
    await writeFile(path.join(root, WRITE_LOCK_FILENAME), "", "utf-8");
    const before = await written();

    const refusal = await refusalOf(writeAddMethod(plan, deps(receiptsClient())));

    expect(refusal.message).toContain(`is taking or releasing ${WRITE_LOCK_FILENAME}`);
    expect(refusal.message).not.toContain("stopped");
    expect(await written()).toEqual(before);
  });

  it.each(["methods", "src/generated"])(
    "refuses a symlinked %s before fetching anything, writing nothing through it",
    async (relative) => {
      const elsewhere = await mkdtemp(path.join(tmpdir(), "add-method-elsewhere-"));
      try {
        await rm(path.join(root, relative), { recursive: true });
        await symlink(elsewhere, path.join(root, relative));
        const client = receiptsClient();
        const errors: string[] = [];
        vi.spyOn(console, "error").mockImplementation(
          (line: unknown) => void errors.push(String(line)),
        );

        expect(await runAddMethod([RECEIPTS_DIR], deps(client))).toBe(1);

        expect(errors.join("\n")).toContain("refusing a symlink at");
        expect(client.validateFiles).not.toHaveBeenCalled();
        expect(client.codegen).not.toHaveBeenCalled();
        expect(await readdir(elsewhere)).toEqual([]);
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    },
  );

  it("scaffolds a directory whose name reads like an address when it exists", async () => {
    const dotted = path.join(root, "bundles.v2/receipt-review");
    await mkdir(dotted, { recursive: true });
    for (const name of ["concepts.mthds", "main.mthds"]) {
      await writeFile(
        path.join(dotted, name),
        await readFile(path.join(RECEIPTS_DIR, name), "utf-8"),
        "utf-8",
      );
    }

    expect(await runAddMethod(["bundles.v2/receipt-review"], deps(receiptsClient()))).toBe(0);
    expect(await written()).toContain("methods/receipt-review/main.mthds");
  });

  it("refuses a catalog id the API does not know, naming it, with no stack", async () => {
    const client = fakeClient({
      getMethod: vi
        .fn()
        .mockRejectedValueOnce(
          new ApiResponseError(
            "API GET /v1/methods/mt_missing failed (404)",
            "https://api.example/v1/methods/mt_missing",
            404,
            "Not Found",
            "{}",
            "MethodNotFoundError",
            "Method mt_missing not found",
            undefined,
            undefined,
          ),
        ),
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(
      (line: unknown) => void errors.push(String(line)),
    );

    expect(await runAddMethod(["mt_missing"], deps(client))).toBe(1);

    expect(errors.join("\n")).toContain("could not resolve");
    expect(errors.join("\n")).toContain("Method mt_missing not found");
    expect(errors.join("\n")).not.toMatch(/\n\s+at /);
    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
  });

  it("refuses a registry whose anchor is gone, before writing anything", async () => {
    const registryPath = path.join(root, "src/components/ExampleTabs.tsx");
    const stripped = (await readFile(registryPath, "utf-8"))
      .split("\n")
      .filter((line) => !line.includes(TABS_ANCHOR))
      .join("\n");
    await writeFile(registryPath, stripped, "utf-8");

    expect(await runAddMethod([TEXT_STATS_REF], deps())).toBe(1);

    expect(await written()).toEqual(["src/components/ExampleTabs.tsx"]);
    expect(await readFile(registryPath, "utf-8")).toBe(stripped);
  });
});
