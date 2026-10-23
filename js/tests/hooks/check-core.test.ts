/**
 * Decision-mapping tests for the `.mthds` hook core: per-stage verdicts in,
 * hook decisions out. Engine-free by design — the mappers must not care which
 * engine (WASM, API, MCP) produced a verdict.
 */

import { describe, expect, it } from "vitest";
import {
  decideAfterLint,
  decideAfterValidate,
  encodeOutcome,
  extractCodexMthdsTargets,
  extractMthdsFilePath,
  extractVibeMthdsFilePath,
  mergeOutcomes,
  outcomeText,
  carriesAddedLines,
  pathSpan,
  selectCodexTargets,
  truncate,
  uncheckedShellPatchNote,
  type CodexMthdsTarget,
  type HookOutcome,
} from "../../src/hooks/check-core.js";
import type { ProblemItem } from "mthds/protocol";
import type { Diagnostic } from "../../src/models.js";

const FILE = "/work/demo.mthds";

const diagnostic = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
  kind: "syntax",
  severity: "error",
  message: "unexpected token",
  location: null,
  range: {
    start_offset: 0,
    end_offset: 1,
    start_line: 3,
    start_col: 7,
    end_line: 3,
    end_col: 8,
  },
  ...overrides,
});

const problemItem = (overrides: Partial<ProblemItem> = {}): ProblemItem => ({
  code: "method.concept_unknown",
  detail: "Pipe 'extract' names the concept 'Invoice', which the domain does not declare.",
  ...overrides,
});

describe("decideAfterLint", () => {
  it("passes on a clean lint", () => {
    expect(decideAfterLint(FILE, { status: "clean" })).toEqual({ kind: "pass" });
  });

  it("passes on an empty diagnostics list", () => {
    expect(decideAfterLint(FILE, { status: "diagnostics", diagnostics: [] })).toEqual({
      kind: "pass",
    });
  });

  it("passes when the lint engine is unavailable (fail-open)", () => {
    expect(decideAfterLint(FILE, { status: "unavailable" })).toEqual({ kind: "pass" });
  });

  it("blocks on diagnostics, naming the file, kind, message, and span", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic()],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(FILE);
    expect(outcome.reason).toContain("[syntax/error]");
    expect(outcome.reason).toContain("unexpected token");
    expect(outcome.reason).toContain("line 3, col 7");
  });

  it("renders a span-less diagnostic without a location suffix", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic({ range: null })],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).not.toContain("line");
  });

  it("keeps the location when the diagnostic has no range", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic({ range: null, location: "demo.extract" })],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("demo.extract");
    expect(outcome.reason).not.toContain("col");
  });

  it("renders both location and span when the diagnostic carries both", () => {
    const outcome = decideAfterLint(FILE, {
      status: "diagnostics",
      diagnostics: [diagnostic({ location: "demo.extract" })],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("demo.extract");
    expect(outcome.reason).toContain("line 3, col 7");
  });
});

describe("decideAfterValidate", () => {
  it("passes silently when the stage is unavailable", () => {
    expect(decideAfterValidate(FILE, { status: "unavailable" })).toEqual({ kind: "pass" });
  });

  it("passes silently on a valid bundle with no pending signatures", () => {
    expect(
      decideAfterValidate(FILE, { status: "valid", pendingSignatures: [], withheld: [] }),
    ).toEqual({ kind: "pass" });
  });

  it("emits a non-blocking nudge on pending signatures", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "valid",
      pendingSignatures: ["demo.extract", "demo.render"],
      withheld: [],
    });
    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    expect(outcome.context).toContain("demo.extract, demo.render");
    expect(outcome.context).toContain("not yet runnable");
  });

  it("blocks with the server-rendered Markdown verbatim when present", () => {
    const markdown = "# Validation failed\n\n- pipe `demo.x`: unknown concept";
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      errors: [problemItem()],
      renderedMarkdown: markdown,
      withheld: [],
    });
    expect(outcome).toEqual({ kind: "block", reason: markdown });
  });

  it("names each problem item by its code, its sentence and its location without Markdown", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      message: "The method does not validate.",
      errors: [
        problemItem({ location: { pipe: "extract", file: "demo.mthds", line: 12 } }),
        problemItem({
          code: "method.input_unused",
          detail: "Pipe 'extract' declares inputs it never reads: name.",
        }),
      ],
      withheld: [],
    });

    expect(outcome).toEqual({
      kind: "block",
      reason: [
        "Validation failed for /work/demo.mthds:",
        "",
        "The method does not validate.",
        "",
        "- `method.concept_unknown`: Pipe 'extract' names the concept 'Invoice', which the " +
          "domain does not declare. (pipe 'extract', file 'demo.mthds', line 12)",
        "- `method.input_unused`: Pipe 'extract' declares inputs it never reads: name.",
      ].join("\n"),
    });
  });

  it("gives a problem item's suggested fix a line of its own, with its safety and rule", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      message: "The method does not validate.",
      errors: [
        problemItem({
          code: "method.model_unknown",
          detail: "The llm model 'gpt-5.1' is not one the runtime knows.",
          location: { pipe: "summarize" },
          suggested_fix: {
            fix_code: "rename-model",
            description: "Use the model 'gpt-5' in place of 'gpt-5.1'.",
            safety: "safe",
            ops: [
              {
                kind: "remap_value",
                table_path: ["pipe", "summarize"],
                key: "model",
                mapping: { "gpt-5.1": "gpt-5" },
              },
            ],
          },
        }),
      ],
      withheld: [],
    });

    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason.split("\n").slice(-2)).toEqual([
      "- `method.model_unknown`: The llm model 'gpt-5.1' is not one the runtime knows. " +
        "(pipe 'summarize')",
      "  - Suggested fix (safe, rename-model): Use the model 'gpt-5' in place of 'gpt-5.1'.",
    ]);
  });

  it("words a suggested fix of a safety it does not know as unsafe", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      errors: [
        problemItem({
          suggested_fix: {
            fix_code: "declare-concept",
            description: "Declare the concept 'Invoice'.",
            safety: "reviewed",
            ops: [{ kind: "ensure_table", table_path: ["concept", "Invoice"] }],
          },
        }),
      ],
      withheld: [],
    });

    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain(
      "  - Suggested fix (unsafe, declare-concept): Declare the concept 'Invoice'.",
    );
  });

  it("blocks even when the invalid verdict carries no errors or message", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      errors: [],
      withheld: [],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toContain("Bundle is invalid.");
  });

  it("shows the server message alone when the invalid verdict has no error items", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      message: "Custom server message.",
      errors: [],
      withheld: [],
    });
    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toBe(
      "Validation failed for /work/demo.mthds:\n\nCustom server message.",
    );
  });
});

describe("decideAfterValidate, with files kept home", () => {
  const withheld = [
    { path: "/work/key.pem", reason: "it holds a private key block (PEM)" },
    { path: "/work/secrets.yaml", reason: "it holds an AWS access key id" },
  ];
  const noteHead = [
    "The .mthds hook kept these files of the method's tree on this machine, since each looks " +
      "like a secret, and validated the method without them:",
    "- `/work/key.pem` (it holds a private key block (PEM))",
    "- `/work/secrets.yaml` (it holds an AWS access key id)",
  ].join("\n");

  /** `count` withheld files, each with a path as long as a deep project's. */
  const manyWithheld = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      path: `/home/someone/projects/client-work/methods/invoices/keys/key-${index}.pem`,
      reason: "it holds a private key block (PEM)",
    }));

  it("names them in a non-blocking note beside a valid verdict", () => {
    const outcome = decideAfterValidate(FILE, { status: "valid", pendingSignatures: [], withheld });

    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    expect(outcome.context).toBe("");
    expect(outcome.notes).toHaveLength(1);
    const text = outcomeText(outcome);
    expect(text.startsWith(noteHead)).toBe(true);
    expect(text).toContain("Move the secret out of the file");
    expect(text).toContain("one above the tree's root is not read");
  });

  it("places the note after the pending signatures' nudge", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "valid",
      pendingSignatures: ["demo.extract"],
      withheld,
    });

    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    const [nudge, ...rest] = outcomeText(outcome).split("\n\n");
    expect(nudge).toContain("not yet runnable");
    expect(rest.join("\n\n").startsWith(noteHead)).toBe(true);
  });

  it("places the note after an invalid verdict's reason, which still blocks", () => {
    const markdown = "# Validation failed\n\n- pipe `demo.print`: template file missing";
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      errors: [problemItem()],
      renderedMarkdown: markdown,
      withheld,
    });

    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    expect(outcome.reason).toBe(markdown);
    const text = outcomeText(outcome);
    expect(text.startsWith(`${markdown}\n\n${noteHead}`)).toBe(true);
    expect(text).toContain("the validation reports that file missing");
  });

  it("names the first ten files and counts the rest", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "valid",
      pendingSignatures: [],
      withheld: manyWithheld(25),
    });

    expect(outcome.kind).toBe("context");
    if (outcome.kind !== "context") return;
    const items = outcomeText(outcome)
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(items).toHaveLength(11);
    expect(items[9]).toContain("key-9.pem");
    expect(items[10]).toBe("- and 15 more files");
  });

  it("keeps a long verdict's errors in place before the note of many files, within the cap", () => {
    const errors = Array.from(
      { length: 200 },
      (_, index) => `- pipe \`demo.step_${index}\`: the output concept is unknown to the domain`,
    );
    const markdown = ["# Validation failed", "", ...errors].join("\n");
    expect(markdown.length).toBeGreaterThan(12000);
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      errors: [problemItem()],
      renderedMarkdown: markdown,
      withheld: manyWithheld(100),
    });

    expect(outcome.kind).toBe("block");
    if (outcome.kind !== "block") return;
    const text = outcomeText(outcome);
    expect(text.length).toBeLessThanOrEqual(9500);
    expect(text.startsWith(markdown.slice(0, 5000))).toBe(true);
    expect(text).toContain("chars omitted]\n\nThe .mthds hook kept these files");
    expect(text).toContain("- and 90 more files");
    expect(text.endsWith("that holds no key can be renamed.")).toBe(true);
  });

  it("names the files of a refused validation by its tree's root, in a note that never blocks", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "refused",
      root: "/work",
      withheld: [{ path: FILE, reason: "it holds an Anthropic API key" }],
    });

    expect(outcome).toEqual({
      kind: "context",
      context: "",
      notes: [
        [
          "The .mthds hook did not validate the method at `/work`: these files of its tree " +
            "look like a secret, and every validation reads the method's bundles and its " +
            "manifest, so nothing was sent:",
          "- `/work/demo.mthds` (it holds an Anthropic API key)",
          "",
          "A key belongs in the environment, never in a method: a method's files leave this " +
            "machine for the Pipelex API, which keeps them in the organization's storage, where " +
            "every member can read them. Move the secret out of each bundle or manifest listed, " +
            "and the next edit is validated; any other file listed can instead stay where it is " +
            "if you keep the file out of the method's tree with a `.gitignore` line inside the " +
            "tree, since one above the tree's root is not read, or with a name starting with a dot.",
        ].join("\n"),
      ],
    });
  });

  it("cuts a long verdict carrying a note once, with the true count", () => {
    const errors = Array.from(
      { length: 400 },
      (_, index) => `- pipe \`demo.step_${index}\`: the output concept is unknown to the domain`,
    );
    const markdown = ["# Validation failed", "", ...errors].join("\n");
    expect(markdown.length).toBeGreaterThan(20000);
    const merged = mergeOutcomes([
      decideAfterValidate(FILE, {
        status: "invalid",
        errors: [],
        renderedMarkdown: markdown,
        withheld,
      }),
    ]);

    expect(merged.kind).toBe("block");
    if (merged.kind === "pass") return;
    const text = outcomeText(merged);
    const markers = [...text.matchAll(/\[truncated, (\d+) chars omitted\]/g)];
    expect(markers).toHaveLength(1);
    const kept = text.indexOf("\n\n[truncated, ");
    expect(text.slice(0, kept)).toBe(markdown.slice(0, kept));
    expect(Number(markers[0]![1])).toBe(markdown.length - kept);
    expect(text.length).toBeLessThanOrEqual(9500);
  });

  it("keeps the notes of the outcomes a block outranks", () => {
    const lint: HookOutcome = {
      kind: "block",
      reason: "MTHDS lint errors in /work/c.mthds:\n\n- [syntax/error] unexpected token",
    };
    const refused = decideAfterValidate("/work/a.mthds", {
      status: "refused",
      root: "/work",
      withheld,
    });
    const valid = decideAfterValidate("/other/b.mthds", {
      status: "valid",
      pendingSignatures: [],
      withheld: [{ path: "/other/key.pem", reason: "it holds a private key block (PEM)" }],
    });

    const merged = mergeOutcomes([lint, refused, valid]);

    expect(merged.kind).toBe("block");
    if (merged.kind !== "block" || refused.kind === "pass" || valid.kind === "pass") return;
    expect(merged.reason).toBe(lint.reason);
    expect(merged.notes).toEqual([...refused.notes!, ...valid.notes!]);
    const text = outcomeText(merged);
    expect(
      text.startsWith(`${lint.reason}\n\nThe .mthds hook did not validate the method at`),
    ).toBe(true);
    expect(text).toContain("- `/other/key.pem` (it holds a private key block (PEM))");
  });

  it("names a tree's note once when several of its files are merged", () => {
    const first = decideAfterValidate("/work/a.mthds", {
      status: "invalid",
      errors: [],
      renderedMarkdown: "# a is invalid",
      withheld,
    });
    const second = decideAfterValidate("/work/b.mthds", {
      status: "invalid",
      errors: [],
      renderedMarkdown: "# b is invalid",
      withheld,
    });
    const refusedA = decideAfterValidate("/work/a.mthds", {
      status: "refused",
      root: "/work",
      withheld,
    });
    const refusedB = decideAfterValidate("/work/b.mthds", {
      status: "refused",
      root: "/work",
      withheld,
    });

    const merged = mergeOutcomes([first, second]);
    expect(merged.kind).toBe("block");
    if (merged.kind !== "block") return;
    const text = outcomeText(merged);
    expect(text.startsWith("# a is invalid\n\n# b is invalid\n\nThe .mthds hook kept")).toBe(true);
    expect(text.split("The .mthds hook kept").length).toBe(2);

    const refused = mergeOutcomes([refusedA, refusedB]);
    expect(refused.kind).toBe("context");
    if (refused.kind !== "context") return;
    expect(outcomeText(refused).split("did not validate the method at").length).toBe(2);
    expect(outcomeText(refused).startsWith("The .mthds hook did not validate")).toBe(true);
  });

  it("encodes the note after the text, on every platform", () => {
    const outcome = decideAfterValidate(FILE, {
      status: "invalid",
      errors: [],
      renderedMarkdown: "# invalid",
      withheld,
    });

    const claude = JSON.parse(encodeOutcome(outcome, "claude")) as { reason: string };
    const vibe = JSON.parse(encodeOutcome(outcome, "vibe")) as { reason: string };
    expect(claude.reason.startsWith(`# invalid\n\n${noteHead}`)).toBe(true);
    expect(vibe.reason).toBe(claude.reason);
  });
});

describe("extractMthdsFilePath", () => {
  it("extracts the file path of a .mthds Write/Edit", () => {
    const payload = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/work/demo.mthds", content: "..." },
    });
    expect(extractMthdsFilePath(payload)).toBe("/work/demo.mthds");
  });

  it("returns null for a non-mthds file", () => {
    const payload = JSON.stringify({ tool_input: { file_path: "/work/demo.ts" } });
    expect(extractMthdsFilePath(payload)).toBeNull();
  });

  it("returns null on unparseable input (fail open)", () => {
    expect(extractMthdsFilePath("not json")).toBeNull();
  });

  it("returns null when tool_input or file_path is missing", () => {
    expect(extractMthdsFilePath("{}")).toBeNull();
    expect(extractMthdsFilePath(JSON.stringify({ tool_input: {} }))).toBeNull();
    expect(extractMthdsFilePath(JSON.stringify({ tool_input: { file_path: 42 } }))).toBeNull();
  });
});

describe("extractCodexMthdsTargets", () => {
  const HOOK_CWD = "/hook-cwd";
  const envelope = (body: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ tool_name: "apply_patch", tool_input: { command: body }, ...extra });
  const paths = (stdinJson: string) =>
    extractCodexMthdsTargets(stdinJson, HOOK_CWD).targets.map((target) => target.path);

  it("extracts the files the patch leaves on disk, a moved file by its destination", () => {
    const stdin = envelope(
      "*** Begin Patch\n*** Update File: a.mthds\n@@\n*** Add File: sub/b.mthds\n+x\n" +
        "*** Update File: a.mthds\n*** Move to: c.mthds\n*** End Patch\n",
      { cwd: "/work" },
    );
    expect(paths(stdin)).toEqual(["/work/sub/b.mthds", "/work/c.mthds"]);
  });

  it("carries the path as written and the added lines", () => {
    const { targets } = extractCodexMthdsTargets(
      envelope("*** Update File: sub/a.mthds\n@@\n-old\n+new\n", { cwd: "/work" }),
      HOOK_CWD,
    );
    expect(targets).toEqual([
      {
        path: "/work/sub/a.mthds",
        writtenAs: "sub/a.mthds",
        addedLines: [["new"]],
        removedByPatch: false,
        confirm: null,
      },
    ]);
  });

  it("skips deleted files, Move from headers, and non-mthds files", () => {
    const stdin = envelope(
      "*** Delete File: gone.mthds\n*** Move from: old.mthds\n*** Update File: code.py\n",
    );
    expect(paths(stdin)).toEqual([]);
  });

  it("keeps an absolute path as it is", () => {
    expect(paths(envelope("*** Update File: /abs/a.mthds\n+x\n", { cwd: "/work" }))).toEqual([
      "/abs/a.mthds",
    ]);
  });

  it("anchors relative paths on the payload's cwd when it is absolute", () => {
    expect(paths(envelope("*** Update File: a.mthds\n", { cwd: "/session" }))).toEqual([
      "/session/a.mthds",
    ]);
  });

  it("falls back to the hook's working directory when cwd is missing or relative", () => {
    expect(paths(envelope("*** Update File: a.mthds\n"))).toEqual(["/hook-cwd/a.mthds"]);
    expect(paths(envelope("*** Update File: a.mthds\n", { cwd: "session" }))).toEqual([
      "/hook-cwd/a.mthds",
    ]);
    expect(paths(envelope("*** Update File: a.mthds\n", { cwd: 42 }))).toEqual([
      "/hook-cwd/a.mthds",
    ]);
  });

  it("returns empty on unparseable input or missing command", () => {
    expect(paths("not json")).toEqual([]);
    expect(paths(JSON.stringify({ tool_input: {} }))).toEqual([]);
  });

  describe("a patch run through the shell", () => {
    const PATCH = "*** Begin Patch\n*** Update File: broken.mthds\n@@\n+x\n*** End Patch";
    const shell = (script: string) =>
      JSON.stringify({ tool_name: "Bash", cwd: "/work", tool_input: { command: script } });

    it("resolves a relative path against the directory the script moved to", () => {
      const result = extractCodexMthdsTargets(
        shell(`cd sub && apply_patch <<'PATCH'\n${PATCH}\nPATCH\n`),
        HOOK_CWD,
      );
      expect(result).toEqual({
        fromShell: true,
        targets: [
          {
            path: "/work/sub/broken.mthds",
            writtenAs: "broken.mthds",
            addedLines: [["x"]],
            removedByPatch: false,
            confirm: "carried",
          },
        ],
        unplaced: [],
      });
    });

    it("lists a relative path under an unknown directory as unplaced", () => {
      const result = extractCodexMthdsTargets(
        shell(`cd "$DIR" && apply_patch <<'PATCH'\n${PATCH}\nPATCH\n`),
        HOOK_CWD,
      );
      expect(result).toEqual({ fromShell: true, targets: [], unplaced: ["broken.mthds"] });
    });

    it("lists every relative path of a script it cannot read as unplaced", () => {
      const result = extractCodexMthdsTargets(
        shell(`cd 'sub && apply_patch <<'PATCH'\n${PATCH}\nPATCH\n`),
        HOOK_CWD,
      );
      expect(result.unplaced).toEqual(["broken.mthds"]);
      expect(result.targets).toEqual([]);
    });

    it("keeps an absolute path wherever the script ran", () => {
      const result = extractCodexMthdsTargets(
        shell(
          `cd "$DIR" && apply_patch <<'PATCH'\n${PATCH.replace("broken.mthds", "/abs/broken.mthds")}\nPATCH\n`,
        ),
        HOOK_CWD,
      );
      expect(result.targets).toMatchObject([{ path: "/abs/broken.mthds", confirm: "unrefuted" }]);
      expect(result.unplaced).toEqual([]);
    });

    const DELETE = "*** Begin Patch\n*** Delete File: broken.mthds\n*** End Patch";

    it("keeps a file one patch edits and another deletes, compared by resolved path", () => {
      const script =
        `cd sub && apply_patch <<'P1'\n${PATCH}\nP1\n` +
        `cd .. && apply_patch <<'P2'\n${DELETE.replace("broken", "sub/broken")}\nP2\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD).targets).toMatchObject([
        { path: "/work/sub/broken.mthds", removedByPatch: true },
      ]);
    });

    it("keeps an edit when a patch in another unknown directory deletes the same name", () => {
      const script =
        `cd "$A" && apply_patch <<'P1'\n${PATCH}\nP1\n` +
        `cd "$B" && apply_patch <<'P2'\n${DELETE}\nP2\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD)).toEqual({
        fromShell: true,
        targets: [],
        unplaced: ["broken.mthds"],
      });
    });

    it("keeps an edit made in one branch and deleted in the other", () => {
      const script =
        `if test -f x; then apply_patch <<'P1'\n${PATCH}\nP1\n` +
        `else apply_patch <<'P2'\n${DELETE}\nP2\nfi\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD).targets).toMatchObject([
        { path: "/work/broken.mthds", addedLines: [["x"]], removedByPatch: true },
      ]);
    });

    it("confirms an absolute path that no patch command reads against its added lines", () => {
      const absolute = PATCH.replace("broken.mthds", "/abs/broken.mthds");
      const staged = `cat > /tmp/p <<'EOF'\n${absolute}\nEOF\n`;
      expect(extractCodexMthdsTargets(shell(staged), HOOK_CWD).targets).toMatchObject([
        { path: "/abs/broken.mthds", confirm: "carried" },
      ]);
      const unparsed = `cd 'sub && apply_patch <<'EOF'\n${absolute}\nEOF\n`;
      expect(extractCodexMthdsTargets(shell(unparsed), HOOK_CWD).targets).toMatchObject([
        { path: "/abs/broken.mthds", confirm: "carried" },
      ]);
    });

    it("asks an absolute path a patch command reads not to lack its lines, in any branch", () => {
      const absolute = PATCH.replace("broken.mthds", "/abs/broken.mthds");
      for (const script of [
        `apply_patch <<'EOF'\n${absolute}\nEOF\n`,
        `if false; then apply_patch <<'EOF'\n${absolute}\nEOF\nfi\n`,
        `f() { apply_patch <<'EOF'\n${absolute}\nEOF\n}\n`,
      ]) {
        expect(extractCodexMthdsTargets(shell(script), HOOK_CWD).targets).toMatchObject([
          { path: "/abs/broken.mthds", confirm: "unrefuted" },
        ]);
      }
    });

    it("keeps apart the patches passed as quoted arguments", () => {
      const add = "*** Begin Patch\n*** Add File: a.mthds\n+x\n*** End Patch";
      const remove = "*** Begin Patch\n*** Delete File: a.mthds\n*** End Patch";
      const script = `cd sub\napply_patch '${add}'\nif false; then apply_patch '${remove}'; fi\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD).targets).toMatchObject([
        { path: "/work/sub/a.mthds", addedLines: [["x"]], removedByPatch: true },
      ]);
    });

    it("reads the added lines through the shell's quoting", () => {
      const lines = '+domain = \\"d\\"\n+prompt = \\$text\n+now = $(date)\n+plain';
      const quoted = PATCH.replace("+x", lines);
      expect(
        extractCodexMthdsTargets(shell(`apply_patch "${quoted}"\n`), HOOK_CWD).targets[0]!
          .addedLines,
      ).toEqual([['domain = "d"', "prompt = $text", "plain"]]);
      expect(
        extractCodexMthdsTargets(shell(`apply_patch <<EOF\n${quoted}\nEOF\n`), HOOK_CWD).targets[0]!
          .addedLines,
      ).toEqual([['domain = \\"d\\"', "prompt = $text", "plain"]]);
      expect(
        extractCodexMthdsTargets(shell(`apply_patch <<'EOF'\n${quoted}\nEOF\n`), HOOK_CWD)
          .targets[0]!.addedLines,
      ).toEqual([['domain = \\"d\\"', "prompt = \\$text", "now = $(date)", "plain"]]);
    });

    it("reads the added lines of a single-quoted patch through its apostrophes", () => {
      const quoted = PATCH.replace("broken.mthds", "/abs/broken.mthds").replace(
        "+x",
        `+prompt = "Don'\\''t"`,
      );
      expect(
        extractCodexMthdsTargets(shell(`apply_patch '${quoted}'\n`), HOOK_CWD).targets,
      ).toMatchObject([{ path: "/abs/broken.mthds", addedLines: [[`prompt = "Don't"`]] }]);
    });

    it("lists a patch held in a variable and applied later as unplaced", () => {
      const script = `PATCH=$(cat <<'EOF'\n${PATCH}\nEOF\n)\ncd sub && apply_patch "$PATCH"\n`;
      expect(extractCodexMthdsTargets(shell(script), HOOK_CWD)).toEqual({
        fromShell: true,
        targets: [],
        unplaced: ["broken.mthds"],
      });
    });

    it("reads the apply_patch tool's patch as the session directory's, whatever it holds", () => {
      const stdin = envelope(`cd sub\n${PATCH}\n`, { cwd: "/work" });
      expect(extractCodexMthdsTargets(stdin, HOOK_CWD)).toEqual({
        fromShell: false,
        targets: [
          {
            path: "/work/broken.mthds",
            writtenAs: "broken.mthds",
            addedLines: [["x"]],
            removedByPatch: false,
            confirm: null,
          },
        ],
        unplaced: [],
      });
    });

    it("reads a payload with no tool_name as the apply_patch tool's", () => {
      const stdin = JSON.stringify({ cwd: "/work", tool_input: { command: `cd sub\n${PATCH}` } });
      expect(extractCodexMthdsTargets(stdin, HOOK_CWD).targets[0]!.path).toBe("/work/broken.mthds");
    });
  });
});

describe("carriesAddedLines", () => {
  const CONTENT = 'domain = "demo"\n\n[pipe.a]\ntype = "PipeLLM"   \nprompt = "x"\n';

  it("finds the added lines in order, with other lines between them", () => {
    expect(carriesAddedLines(CONTENT, ['domain = "demo"', 'prompt = "x"'])).toBe(true);
  });

  it("refuses lines out of order, or one the file does not hold", () => {
    expect(carriesAddedLines(CONTENT, ['prompt = "x"', 'domain = "demo"'])).toBe(false);
    expect(carriesAddedLines(CONTENT, ['domain = "demo"', 'prompt = "y"'])).toBe(false);
  });

  it("ignores trailing whitespace on either side, and keeps leading whitespace", () => {
    expect(carriesAddedLines(CONTENT, ['type = "PipeLLM"', 'prompt = "x"  '])).toBe(true);
    expect(carriesAddedLines(CONTENT, ['  prompt = "x"'])).toBe(false);
  });

  it("skips blank added lines", () => {
    expect(carriesAddedLines(CONTENT, ["", "[pipe.a]", "   ", 'prompt = "x"'])).toBe(true);
  });

  it("reads CRLF content", () => {
    expect(carriesAddedLines(CONTENT.replaceAll("\n", "\r\n"), ["[pipe.a]", 'prompt = "x"'])).toBe(
      true,
    );
  });

  it("finds no evidence in a section that adds no line, or only blank ones", () => {
    expect(carriesAddedLines(CONTENT, [])).toBe(false);
    expect(carriesAddedLines(CONTENT, ["", "  "])).toBe(false);
  });
});

describe("selectCodexTargets", () => {
  const target = (overrides: Partial<CodexMthdsTarget> = {}): CodexMthdsTarget => ({
    path: "/work/sub/a.mthds",
    writtenAs: "a.mthds",
    addedLines: [["added"]],
    removedByPatch: false,
    confirm: "carried",
    ...overrides,
  });
  const select = (
    targets: CodexMthdsTarget[],
    files: Record<string, string>,
    unplaced: string[] = [],
  ) => selectCodexTargets({ fromShell: true, targets, unplaced }, (path) => files[path] ?? null);

  it("checks a file that carries the patch's added lines", () => {
    expect(select([target()], { "/work/sub/a.mthds": "x\nadded\n" })).toEqual({
      targets: ["/work/sub/a.mthds"],
      unchecked: [],
    });
  });

  it("names a file that does not carry them, rather than checking it", () => {
    expect(select([target()], { "/work/sub/a.mthds": "other\n" })).toEqual({
      targets: [],
      unchecked: ["a.mthds"],
    });
  });

  it("names a missing file, unless the patch itself removed it", () => {
    expect(select([target()], {}).unchecked).toEqual(["a.mthds"]);
    expect(select([target({ removedByPatch: true })], {})).toEqual({ targets: [], unchecked: [] });
  });

  it("names a file whose sections add no line, since nothing confirms it", () => {
    const selected = select([target({ addedLines: [[]] })], { "/work/sub/a.mthds": "x\n" });
    expect(selected).toEqual({ targets: [], unchecked: ["a.mthds"] });
  });

  it("checks a file that carries the lines of any envelope that wrote it", () => {
    const selected = select([target({ addedLines: [["first"], ["second"]] })], {
      "/work/sub/a.mthds": "second\n",
    });
    expect(selected.targets).toHaveLength(1);
  });

  it("checks a target that needs no confirming whenever its file exists", () => {
    const unconfirmed = target({ confirm: null, addedLines: [[]] });
    expect(select([unconfirmed], { "/work/sub/a.mthds": "x\n" }).targets).toHaveLength(1);
    expect(select([unconfirmed], {})).toEqual({ targets: [], unchecked: [] });
  });

  it("drops an absolute path it could not confirm without naming it", () => {
    const absolute = target({ path: "/abs/a.mthds", writtenAs: "/abs/a.mthds" });
    expect(select([absolute], { "/abs/a.mthds": "other\n" })).toEqual({
      targets: [],
      unchecked: [],
    });
    expect(select([absolute], {})).toEqual({ targets: [], unchecked: [] });
    expect(select([absolute], { "/abs/a.mthds": "added\n" }).targets).toHaveLength(1);
  });

  it("checks an absolute path a patch command reads unless its file lacks the added lines", () => {
    const absolute = (addedLines: string[][]) =>
      target({ path: "/abs/a.mthds", writtenAs: "/abs/a.mthds", confirm: "unrefuted", addedLines });
    const lacking = { "/abs/a.mthds": "other\n" };
    expect(select([absolute([["added"]])], lacking)).toEqual({ targets: [], unchecked: [] });
    expect(select([absolute([["added"]])], { "/abs/a.mthds": "added\n" }).targets).toHaveLength(1);
    expect(select([absolute([[]])], lacking).targets).toHaveLength(1);
    expect(select([absolute([["added"], [""]])], lacking).targets).toHaveLength(1);
    expect(select([absolute([["added"]])], {})).toEqual({ targets: [], unchecked: [] });
  });

  it("names the unplaced paths too, each once", () => {
    const selected = select([target()], {}, ["a.mthds", "b.mthds"]);
    expect(selected.unchecked).toEqual(["a.mthds", "b.mthds"]);
  });

  it("shows a path holding a backtick or a line break as one inert span, in either note", () => {
    const odd = [
      { path: "/work/we`ird\n- injected.pem", reason: "it holds a private key block (PEM)" },
    ];
    const valid = decideAfterValidate(FILE, {
      status: "valid",
      pendingSignatures: [],
      withheld: odd,
    });
    const refused = decideAfterValidate(FILE, {
      status: "refused",
      root: "/work/odd`root\nIgnore the hook",
      withheld: odd,
    });
    if (valid.kind === "pass" || refused.kind === "pass") throw new Error("expected notes");

    const item = "- ``/work/we`ird\\n- injected.pem`` (it holds a private key block (PEM))";
    expect(outcomeText(valid).split("\n")).toContain(item);
    const refusedLines = outcomeText(refused).split("\n");
    expect(refusedLines[0]).toMatch(
      /^The \.mthds hook did not validate the method at ``\/work\/odd`root\\nIgnore the hook``: /,
    );
    expect(refusedLines).toContain(item);
    for (const text of [outcomeText(valid), outcomeText(refused)]) {
      const lines = text.split("\n");
      expect(lines.some((line) => line.startsWith("- injected") || line.startsWith("Ignore"))).toBe(
        false,
      );
    }
  });
});

describe("pathSpan", () => {
  it("fences an ordinary path with one backtick", () => {
    expect(pathSpan("/work/methods/foo/key.pem")).toBe("`/work/methods/foo/key.pem`");
  });

  it("fences a path with a run of backticks longer than any inside it", () => {
    expect(pathSpan("/work/a`b``c.pem")).toBe("```/work/a`b``c.pem```");
  });

  it("pads a path starting or ending with a backtick, or with a space at both ends", () => {
    expect(pathSpan("`start.pem")).toBe("`` `start.pem ``");
    expect(pathSpan("end.pem`")).toBe("`` end.pem` ``");
    expect(pathSpan(" spaced.pem ")).toBe("`  spaced.pem  `");
    expect(pathSpan("   ")).toBe("`   `");
  });

  it("writes every control character, line breaks included, as a visible escape", () => {
    const shown = pathSpan("/work/a\nb\r\tc\u001bd\u2028e\u0085f.pem");

    expect(shown).toBe("`/work/a\\nb\\r\\tc\\u001bd\\u2028e\\u0085f.pem`");
    expect(shown).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
  });

  it("leaves a backslash as it is, so a Windows path reads as itself", () => {
    expect(pathSpan("C:\\work\\key.pem")).toBe("`C:\\work\\key.pem`");
  });
});

describe("uncheckedShellPatchNote", () => {
  it("names one file", () => {
    expect(uncheckedShellPatchNote(["broken.mthds"])).toEqual({
      kind: "context",
      context:
        "The .mthds hook did not check `broken.mthds`: it could not confirm which file this " +
        "shell command patched. Name the file by its absolute path, or edit it with the " +
        "apply_patch tool, and the hook will check it.",
    });
  });

  it("names several files", () => {
    const note = uncheckedShellPatchNote(["a.mthds", "b.mthds", "c.mthds"]);
    expect(note).toEqual({
      kind: "context",
      context:
        "The .mthds hook did not check `a.mthds`, `b.mthds` and `c.mthds`: it could not " +
        "confirm which files this shell command patched. Name the files by their absolute " +
        "paths, or edit them with the apply_patch tool, and the hook will check them.",
    });
  });

  it("shows a name holding a backtick or a line break as one inert span", () => {
    const note = uncheckedShellPatchNote(["we`ird\nname.mthds"]);

    expect(note.kind === "context" && note.context).toMatch(
      /^The \.mthds hook did not check ``we`ird\\nname\.mthds``: /,
    );
  });

  it("gives way to a block from another file, and joins another file's context", () => {
    const note = uncheckedShellPatchNote(["a.mthds"]);
    expect(mergeOutcomes([note, { kind: "block", reason: "lint failed" }])).toEqual({
      kind: "block",
      reason: "lint failed",
    });
    const merged = mergeOutcomes([{ kind: "context", context: "pending signatures" }, note]);
    expect(merged.kind).toBe("context");
    expect(merged.kind === "context" && merged.context.startsWith("pending signatures\n\n")).toBe(
      true,
    );
  });
});

describe("extractVibeMthdsFilePath", () => {
  it("reads the path from the tool_output/tool_input fallback chain with cwd", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      cwd: "/work",
      tool_output: { file: "demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "demo.mthds", cwd: "/work" });
  });

  it("falls back to tool_output.path", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      tool_output: { path: "x/demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "x/demo.mthds", cwd: undefined });
  });

  it("falls back to tool_input.file_path", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      tool_input: { file_path: "x/demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "x/demo.mthds", cwd: undefined });
  });

  it("falls back to tool_input.path", () => {
    const payload = JSON.stringify({
      tool_status: "success",
      tool_input: { path: "x/demo.mthds" },
    });
    expect(extractVibeMthdsFilePath(payload)).toEqual({ filePath: "x/demo.mthds", cwd: undefined });
  });

  it("ignores failed tool calls and non-mthds paths", () => {
    expect(
      extractVibeMthdsFilePath(
        JSON.stringify({ tool_status: "error", tool_output: { file: "demo.mthds" } }),
      ),
    ).toBeNull();
    expect(
      extractVibeMthdsFilePath(
        JSON.stringify({ tool_status: "success", tool_output: { file: "demo.py" } }),
      ),
    ).toBeNull();
    expect(extractVibeMthdsFilePath("not json")).toBeNull();
  });
});

describe("mergeOutcomes", () => {
  it("passes when everything passes", () => {
    expect(mergeOutcomes([{ kind: "pass" }, { kind: "pass" }])).toEqual({ kind: "pass" });
    expect(mergeOutcomes([])).toEqual({ kind: "pass" });
  });

  it("any block wins and reasons are joined", () => {
    const merged = mergeOutcomes([
      { kind: "pass" },
      { kind: "block", reason: "first" },
      { kind: "context", context: "note" },
      { kind: "block", reason: "second" },
    ]);
    expect(merged).toEqual({ kind: "block", reason: "first\n\nsecond" });
  });

  it("contexts are joined when nothing blocks", () => {
    const merged = mergeOutcomes([
      { kind: "context", context: "a" },
      { kind: "pass" },
      { kind: "context", context: "b" },
    ]);
    expect(merged).toEqual({ kind: "context", context: "a\n\nb" });
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("short")).toBe("short");
  });

  it("caps long text and reports the omission", () => {
    const long = "x".repeat(12000);
    const result = truncate(long);
    expect(result.length).toBeLessThan(10000);
    expect(result).toContain("[truncated, 2500 chars omitted]");
  });
});

describe("encodeOutcome", () => {
  it("encodes pass as empty output", () => {
    expect(encodeOutcome({ kind: "pass" })).toBe("");
  });

  it("encodes a block as the PostToolUse decision object", () => {
    const encoded = encodeOutcome({ kind: "block", reason: "why" });
    expect(JSON.parse(encoded)).toEqual({ decision: "block", reason: "why" });
  });

  it("encodes context as hookSpecificOutput.additionalContext", () => {
    const encoded = encodeOutcome({ kind: "context", context: "heads up" });
    expect(JSON.parse(encoded)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "heads up",
      },
    });
  });

  it("codex shares the claude dialect", () => {
    expect(encodeOutcome({ kind: "block", reason: "why" }, "codex")).toBe(
      encodeOutcome({ kind: "block", reason: "why" }, "claude"),
    );
    expect(encodeOutcome({ kind: "context", context: "note" }, "codex")).toBe(
      encodeOutcome({ kind: "context", context: "note" }, "claude"),
    );
  });

  it("vibe speaks deny / hook_specific_output.additional_context", () => {
    expect(JSON.parse(encodeOutcome({ kind: "block", reason: "why" }, "vibe"))).toEqual({
      decision: "deny",
      reason: "why",
    });
    expect(JSON.parse(encodeOutcome({ kind: "context", context: "note" }, "vibe"))).toEqual({
      decision: "allow",
      hook_specific_output: { additional_context: "note" },
    });
    expect(encodeOutcome({ kind: "pass" }, "vibe")).toBe("");
  });
});
