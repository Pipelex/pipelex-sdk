/**
 * Engine-agnostic core of the `.mthds` PostToolUse hook: the per-stage verdict
 * shapes and the mapping from verdicts to the hook's decision output.
 *
 * The three stages (lint, format, validate) are swappable engines — local WASM
 * today, `client.lint`/`client.format` as the documented fallback, MCP calls
 * later. Nothing in this module knows which engine produced a verdict; it only
 * maps verdict → decision, mirroring the Stage-3 model of the plxt-era hook:
 *
 * - lint diagnostics            → BLOCK (agent fixes the file)
 * - validate `is_valid: false`  → BLOCK (input-domain by construction: over the
 *   API a produced verdict is always a 200; server/config faults are non-2xx =
 *   no verdict = unavailable)
 * - validate valid + pending `PipeSignature`s → non-blocking additionalContext
 * - tree files kept home as secrets → named in a note after the verdict's
 *   text: non-blocking beside a valid verdict, inside an invalid one's block
 * - validate refused (a bundle or the manifest looks like a secret, so
 *   nothing was sent) → non-blocking additionalContext naming the files
 * - any stage unavailable       → fail-open (the other stages' verdicts stand)
 */

import { isAbsolute as isAbsolutePath, resolve as resolvePath } from "node:path";
import type { Diagnostic, ValidationErrorItem } from "../models.js";
import { patchTargets, readPatchSections, type PatchSection } from "./patch-envelope.js";
import { linesAsRead, readShellScript } from "./shell-script.js";

/** Verdict of the local lint stage. `unavailable` = engine failed to load. */
export type LintStage =
  | { status: "clean" }
  | { status: "diagnostics"; diagnostics: Diagnostic[] }
  | { status: "unavailable" };

/**
 * A file of the method's tree that the hook kept on this machine, since it looks like a secret
 * (`secret-guard.ts`): its absolute path, and why, in words that quote nothing of the file.
 */
export interface WithheldFile {
  path: string;
  reason: string;
}

/**
 * Verdict of the networked validate stage. `unavailable` = no verdict could be produced.
 * `withheld` lists the files of the tree that stayed home, empty when every file was sent: a
 * verdict is about the tree without them. `refused` = nothing was sent, because a file every
 * validation reads, a bundle or the manifest, looks like a secret, so no tree without it is the
 * method; `root` is the tree's root and `withheld` lists every file of the tree that looks like
 * one, those every validation reads first.
 */
export type ValidateStage =
  | { status: "valid"; pendingSignatures: string[]; withheld: WithheldFile[] }
  | {
      status: "invalid";
      message?: string;
      validationErrors: ValidationErrorItem[];
      renderedMarkdown?: string;
      withheld: WithheldFile[];
    }
  | { status: "refused"; root: string; withheld: WithheldFile[] }
  | { status: "unavailable" };

/**
 * The hook's decision, prior to JSON encoding. `notes` say which files of a method's tree stayed
 * home: they ride apart from the text so that merging the outcomes of several files of one tree
 * names each note once, and encoding places them after the text (see {@link outcomeText}).
 */
export type HookOutcome =
  | { kind: "pass" }
  | { kind: "block"; reason: string; notes?: string[] }
  | { kind: "context"; context: string; notes?: string[] };

/**
 * Which harness invoked the hook. Claude and Codex share the block /
 * `hookSpecificOutput` stdout protocol; Mistral Vibe speaks
 * deny / `hook_specific_output.additional_context`.
 */
export type HookPlatform = "claude" | "codex" | "vibe";

function parseJsonOrNull(stdinJson: string): unknown {
  try {
    return JSON.parse(stdinJson);
  } catch {
    return null; // fail open on unparseable input, mirroring the plxt-era hooks
  }
}

/**
 * Extract the edited `.mthds` path from the Claude PostToolUse stdin payload;
 * null = not this hook's business (fail open, mirroring the plxt-era hook,
 * which also passed silently on unparseable input).
 */
export function extractMthdsFilePath(stdinJson: string): string | null {
  const parsed = parseJsonOrNull(stdinJson);
  const filePath = (parsed as { tool_input?: { file_path?: unknown } } | null)?.tool_input
    ?.file_path;
  if (typeof filePath !== "string" || !filePath.endsWith(".mthds")) {
    return null;
  }
  return filePath;
}

/** A `.mthds` file a Codex patch leaves on disk. */
export interface CodexMthdsTarget {
  /** The file's absolute path. */
  path: string;
  /** The path as the patch wrote it. */
  writtenAs: string;
  /**
   * The lines each envelope's last section writing the file adds, as the
   * patch command read them through the shell's quoting, less any line an
   * expansion makes unknown. A shell script may hold several envelopes, in
   * branches, so any one may be the one that ran.
   */
  addedLines: string[][];
  /** Some section of the patch deletes the file or moves it away. */
  removedByPatch: boolean;
  /**
   * What the file's content must show before it is checked (see
   * `selectCodexTargets`). `carried`: it carries the patch's added lines,
   * because a shell patch named it by a relative path, which the hook resolved
   * through its reading of the script, or by an absolute path that no patch
   * command in the script reads. `unrefuted`: it does not lack lines the patch
   * added, because a shell patch command reads its absolute path, but the
   * script may not have reached that command. `null` for the `apply_patch`
   * tool, whose patch was applied where its paths say.
   */
  confirm: "carried" | "unrefuted" | null;
}

/** What a Codex PostToolUse payload says about the `.mthds` files it wrote. */
export interface CodexMthdsTargets {
  /** Whether the patch ran through the shell (`tool_name: "Bash"`). */
  fromShell: boolean;
  /** The files the patch leaves on disk, in the order the patch names them. */
  targets: CodexMthdsTarget[];
  /** Relative paths from a shell patch whose directory the script does not tell. */
  unplaced: string[];
}

/** Prefix of the key of a path whose directory is unknown; no resolved path starts with it. */
const UNPLACED_KEY = "\0";

/**
 * The `.mthds` files a Codex PostToolUse payload's patch leaves on disk.
 *
 * The patch envelope rides in `tool_input.command`, and its sections are
 * applied in order, so a file the patch moves or deletes is not a target,
 * unless another envelope of a shell script leaves it (see `patchTargets`). Relative paths resolve against the session directory, the
 * payload's `cwd` when it is absolute and `processCwd` otherwise, since Codex
 * starts the hook in that same directory.
 *
 * With `tool_name: "Bash"`, the command is a shell script that runs the patch,
 * and a relative path is relative to wherever the script had moved when the
 * patch ran. Each section is placed by the patch command reading its header
 * (see `readShellScript`): a relative path under a known directory resolves
 * against it, one under an unknown directory, in text no patch command reads,
 * or anywhere in a script that could not be read, is listed as unplaced
 * rather than guessed, and a header no command holds is dropped. An absolute
 * path resolves wherever it sits, and is confirmed: like a relative one in
 * text no patch command reads, and against the patch's added lines otherwise,
 * since the reading follows every branch and function body whether or not
 * the script ran it. Any other `tool_name` is the `apply_patch` tool's, whose
 * paths are relative to the session directory.
 */
export function extractCodexMthdsTargets(stdinJson: string, processCwd: string): CodexMthdsTargets {
  const parsed = parseJsonOrNull(stdinJson) as {
    cwd?: unknown;
    tool_name?: unknown;
    tool_input?: { command?: unknown };
  } | null;
  const fromShell = parsed?.tool_name === "Bash";
  const command = parsed?.tool_input?.command;
  if (typeof command !== "string") {
    return { fromShell, targets: [], unplaced: [] };
  }
  const sessionDir =
    typeof parsed?.cwd === "string" && isAbsolutePath(parsed.cwd) ? parsed.cwd : processCwd;

  let sections = readPatchSections(command);
  let directoryOf: (section: PatchSection) => string | null = () => sessionDir;
  let readByPatch: (section: PatchSection) => boolean = () => true;
  let addedLinesOf = (section: PatchSection): string[] => section.addedLines;
  if (fromShell) {
    const reading = readShellScript(command, sessionDir);
    if (reading === "unparsed") {
      directoryOf = () => null;
      readByPatch = () => false;
    } else {
      const placements = new Map(
        sections.map((section) => [section, reading.directoryAt(section.offset)] as const),
      );
      sections = sections.filter((section) => placements.get(section)!.kind !== "outside");
      directoryOf = (section) => {
        const placement = placements.get(section)!;
        return placement.kind === "directory" ? placement.path : null;
      };
      readByPatch = (section) => placements.get(section)!.kind !== "unread";
      addedLinesOf = (section) =>
        linesAsRead(section.addedLines, reading.quotingAt(section.offset));
    }
  }

  const keyOf = (path: string, section: PatchSection): string => {
    if (isAbsolutePath(path)) {
      return resolvePath(path);
    }
    const directory = directoryOf(section);
    return directory === null ? UNPLACED_KEY + path : resolvePath(directory, path);
  };
  const targets: CodexMthdsTarget[] = [];
  const unplaced: string[] = [];
  for (const file of patchTargets(sections, keyOf)) {
    if (!file.key.startsWith(UNPLACED_KEY)) {
      targets.push({
        path: file.key,
        writtenAs: file.path,
        addedLines: file.sections.map(addedLinesOf),
        removedByPatch: file.removedByPatch,
        confirm: !fromShell
          ? null
          : !isAbsolutePath(file.path) || !file.sections.some(readByPatch)
            ? "carried"
            : "unrefuted",
      });
    } else if (!unplaced.includes(file.path)) {
      unplaced.push(file.path);
    }
  }
  return { fromShell, targets, unplaced };
}

/**
 * Which of a Codex patch's targets the hook checks, and which relative paths
 * of a shell patch it could not check. `readFile` returns a file's content,
 * or null when there is no file to read.
 *
 * A `carried` target is checked only when its file carries the added lines
 * of some section that wrote it (see `carriesAddedLines`), since a file in
 * another directory than the one the script wrote to almost never does, and
 * neither does a file the script never patched. An `unrefuted` one is checked
 * unless every section that wrote it added lines its file lacks, which is
 * the evidence that the script did not run the patch; a section that adds no
 * line refutes nothing. When a relative path's file fails, or when no file
 * exists where it resolves, the path joins the unplaced ones as unchecked,
 * unless the patch itself removed the missing file. An absolute path that
 * fails was not patched by this script, so it is dropped without a note. Any
 * other target is checked when its file exists.
 *
 * The files are returned as paths: each stage reads its file again when its
 * turn comes, so a file changed while an earlier one was checked is never
 * overwritten with the content read here.
 */
export function selectCodexTargets(
  extracted: CodexMthdsTargets,
  readFile: (path: string) => string | null,
): { targets: string[]; unchecked: string[] } {
  const targets: string[] = [];
  const unchecked = [...extracted.unplaced];
  for (const target of extracted.targets) {
    const content = readFile(target.path);
    const confirmed =
      content !== null &&
      (target.confirm === null ||
        target.addedLines.some(
          (addedLines) =>
            carriesAddedLines(content, addedLines) ||
            (target.confirm === "unrefuted" && comparedLines(addedLines).length === 0),
        ));
    if (confirmed) {
      targets.push(target.path);
    } else if (
      target.confirm === "carried" &&
      !isAbsolutePath(target.writtenAs) &&
      (content !== null || !target.removedByPatch) &&
      !unchecked.includes(target.writtenAs)
    ) {
      unchecked.push(target.writtenAs);
    }
  }
  return { targets, unchecked };
}

/**
 * Whether `content` carries `addedLines` in order, the evidence that a patch
 * adding them wrote it. Each line is compared with its trailing whitespace
 * trimmed, and blank lines are skipped on both sides. Only added lines count,
 * because they are the only ones the patch program writes verbatim: it
 * matches context lines loosely. A section that adds no line, a pure
 * deletion or a bare rename, leaves no evidence, so it is never carried.
 */
export function carriesAddedLines(content: string, addedLines: readonly string[]): boolean {
  const wanted = comparedLines(addedLines);
  if (wanted.length === 0) {
    return false;
  }
  let next = 0;
  for (const line of content.split("\n")) {
    if (line.trimEnd() === wanted[next]) {
      next++;
      if (next === wanted.length) {
        return true;
      }
    }
  }
  return false;
}

/** The added lines a file is compared on: trailing whitespace trimmed, blank lines skipped. */
function comparedLines(addedLines: readonly string[]): string[] {
  return addedLines.map((line) => line.trimEnd()).filter((line) => line !== "");
}

/**
 * The non-blocking note naming the relative paths of a shell patch that the
 * hook could not check. Without it, the agent would read the hook's silence
 * as a clean check.
 */
export function uncheckedShellPatchNote(paths: readonly string[]): HookOutcome {
  const named = paths.map((path) => `\`${path}\``);
  const list =
    named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} and ${named.at(-1)!}`;
  const context =
    named.length === 1
      ? `The .mthds hook did not check ${list}: it could not confirm which file this shell ` +
        "command patched. Name the file by its absolute path, or edit it with the apply_patch " +
        "tool, and the hook will check it."
      : `The .mthds hook did not check ${list}: it could not confirm which files this shell ` +
        "command patched. Name the files by their absolute paths, or edit them with the " +
        "apply_patch tool, and the hook will check them.";
  return { kind: "context", context: truncate(context) };
}

/**
 * Extract the edited `.mthds` path from a Mistral Vibe stable `post_tool`
 * payload, plus the cwd to resolve it against. Only successful tool calls
 * count (`tool_status: "success"`); the path rides in `tool_output.file` /
 * `tool_output.path` / `tool_input.file_path` / `tool_input.path` — the same
 * fallback chain as the plxt-era Vibe hook.
 */
export function extractVibeMthdsFilePath(
  stdinJson: string,
): { filePath: string; cwd?: string } | null {
  const parsed = parseJsonOrNull(stdinJson) as {
    tool_status?: unknown;
    cwd?: unknown;
    tool_output?: { file?: unknown; path?: unknown };
    tool_input?: { file_path?: unknown; path?: unknown };
  } | null;
  if (!parsed || parsed.tool_status !== "success") {
    return null;
  }
  const candidates = [
    parsed.tool_output?.file,
    parsed.tool_output?.path,
    parsed.tool_input?.file_path,
    parsed.tool_input?.path,
  ];
  const filePath = candidates.find(
    (value): value is string => typeof value === "string" && value.endsWith(".mthds"),
  );
  if (!filePath) {
    return null;
  }
  return { filePath, cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined };
}

/**
 * Merge per-file outcomes (Codex's `apply_patch` can touch several `.mthds`
 * files in one call) into the single decision the hook emits: any block wins
 * (reasons joined), else contexts are joined, else pass. The winning
 * outcomes' notes are kept once each, so several files of one tree, whose
 * notes are the same, name its withheld files once.
 */
export function mergeOutcomes(outcomes: HookOutcome[]): HookOutcome {
  const blocks = outcomes.filter((outcome) => outcome.kind === "block");
  if (blocks.length > 0) {
    const reason = truncate(joinTexts(blocks.map((block) => block.reason)));
    return withNotesOf({ kind: "block", reason }, blocks);
  }
  const contexts = outcomes.filter((outcome) => outcome.kind === "context");
  if (contexts.length > 0) {
    const context = truncate(joinTexts(contexts.map((outcome) => outcome.context)));
    return withNotesOf({ kind: "context", context }, contexts);
  }
  return { kind: "pass" };
}

/** Texts joined as paragraphs, an empty one, that of an outcome holding only notes, left out. */
function joinTexts(texts: readonly string[]): string {
  return texts.filter((text) => text !== "").join("\n\n");
}

/** `outcome` carrying every distinct note of `merged`, in order, or none when they have none. */
function withNotesOf<T extends HookOutcome>(
  outcome: T,
  merged: readonly { notes?: string[] }[],
): T {
  const notes = [...new Set(merged.flatMap((each) => each.notes ?? []))];
  return notes.length > 0 ? { ...outcome, notes } : outcome;
}

/** Cap on emitted reason/context bodies — same guard as the plxt-era hook. */
const MAX_OUTPUT_CHARS = 9500;

export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  const omitted = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated, ${omitted} chars omitted]`;
}

/** `text` cut to `budget` characters at most, the marker of the cut included, when longer. */
function fitWithin(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }
  const marker = (omitted: number) => `\n\n[truncated, ${omitted} chars omitted]`;
  // The marker is no longer for a smaller count, so measuring it for the whole text bounds it.
  const kept = Math.max(0, budget - marker(text.length).length);
  return `${text.slice(0, kept)}${marker(text.length - kept)}`;
}

/** The most of the output's characters an outcome's notes take, so its text keeps the rest. */
const NOTES_SHARE = 3000;

/**
 * The text an outcome is encoded with: its own text, then its notes, within the output's cap.
 * The text keeps its place and every character the notes leave it, so a verdict's errors are
 * never cut for a note; the notes take at most {@link NOTES_SHARE}, a bound a note's capped list
 * of files keeps them under but for paths of extreme length.
 */
export function outcomeText(outcome: Exclude<HookOutcome, { kind: "pass" }>): string {
  const text = outcome.kind === "block" ? outcome.reason : outcome.context;
  const notes = outcome.notes ?? [];
  if (notes.length === 0) {
    return text;
  }
  const notesText = fitWithin(notes.join("\n\n"), NOTES_SHARE);
  if (text === "") {
    return notesText;
  }
  return `${fitWithin(text, MAX_OUTPUT_CHARS - notesText.length - 2)}\n\n${notesText}`;
}

/**
 * One diagnostic as an agent-actionable line: severity, locators, message.
 * `location` and `range` are independent — a schema/semantic diagnostic can name
 * its target (a pipe, a concept) without a byte span, so both render when present.
 */
function renderDiagnosticLine(diagnostic: Diagnostic): string {
  const locators = [
    diagnostic.location,
    diagnostic.range && `line ${diagnostic.range.start_line}, col ${diagnostic.range.start_col}`,
  ].filter(Boolean);
  const span = locators.length > 0 ? ` (${locators.join(", ")})` : "";
  return `- [${diagnostic.kind}/${diagnostic.severity}] ${diagnostic.message}${span}`;
}

/**
 * Map the lint verdict to a decision. Every engine diagnostic is an error by
 * construction (the shared Rust engine emits `severity: "error"` only), so any
 * diagnostic blocks — the same bar as `plxt lint`'s non-zero exit.
 */
export function decideAfterLint(filePath: string, lint: LintStage): HookOutcome {
  if (lint.status !== "diagnostics" || lint.diagnostics.length === 0) {
    return { kind: "pass" };
  }
  const lines = [
    `MTHDS lint errors in ${filePath}:`,
    "",
    ...lint.diagnostics.map(renderDiagnosticLine),
  ];
  return { kind: "block", reason: truncate(lines.join("\n")) };
}

/** One validation error with its locators — mirror of the plxt-era rendering. */
function renderValidationErrorLine(item: ValidationErrorItem): string {
  const locators = [
    item.pipe_code && `pipe ${item.pipe_code}`,
    item.concept_code && `concept ${item.concept_code}`,
    item.field_name && `field ${item.field_name}`,
    item.source && `source ${item.source}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `- [${item.category ?? "error"}] ${item.message ?? ""}${locators ? ` (${locators})` : ""}`;
}

/** How many withheld files a note names; the rest it counts. */
const WITHHELD_LISTED = 10;

/**
 * The withheld files as Markdown list items, each path and why, never what the file holds: the
 * first {@link WITHHELD_LISTED}, then how many more, so a tree full of key files cannot crowd a
 * verdict out of the hook's output.
 */
function withheldLines(withheld: readonly WithheldFile[]): string[] {
  const lines = withheld
    .slice(0, WITHHELD_LISTED)
    .map((file) => `- \`${file.path}\` (${file.reason})`);
  const more = withheld.length - WITHHELD_LISTED;
  return more > 0 ? [...lines, `- and ${more} more ${more === 1 ? "file" : "files"}`] : lines;
}

/** Why a key must not ride a method, the workshop's own words. */
const KEY_BELONGS_IN_THE_ENVIRONMENT =
  "A key belongs in the environment, never in a method: a method's files leave this machine " +
  "for the Pipelex API, which keeps them in the organization's storage, where every member can " +
  "read them.";

/** How a file is kept out of the method's tree, which only the tree's own rule decides. */
const KEEP_IT_OUT =
  "keep the file out of the method's tree with a `.gitignore` line inside the tree, since one " +
  "above the tree's root is not read, or with a name starting with a dot";

/**
 * The note on a verdict reached without some files of the tree. A step reading one of them, such
 * as a `PipeDocGen` step's template or a `PipeFunc` step's module, cannot load without it, so the
 * validation reports it missing; the note says so, and the error goes once the secret is out of
 * the file.
 */
function withheldNote(withheld: readonly WithheldFile[]): string {
  return [
    "The .mthds hook kept these files of the method's tree on this machine, since each looks " +
      "like a secret, and validated the method without them:",
    ...withheldLines(withheld),
    "",
    "If a step reads one of them, as its template or its Python module, the validation reports " +
      "that file missing until the secret is moved out of it. " +
      KEY_BELONGS_IN_THE_ENVIRONMENT +
      ` Move the secret out of the file, or ${KEEP_IT_OUT}. A file kept home for its name alone ` +
      "that holds no key can be renamed.",
  ].join("\n");
}

/**
 * The note on a validation the hook did not send, a bundle or the manifest looking like a secret.
 * It names the method by its tree's root, which every file of the tree shares, so the notes of
 * several of them are one.
 */
function refusedNote(root: string, withheld: readonly WithheldFile[]): string {
  return [
    `The .mthds hook did not validate the method at \`${root}\`: these files of its tree look ` +
      "like a secret, and every validation reads the method's bundles and its manifest, so " +
      "nothing was sent:",
    ...withheldLines(withheld),
    "",
    KEY_BELONGS_IN_THE_ENVIRONMENT +
      " Move the secret out of each bundle or manifest listed, and the next edit is validated; " +
      `any other file listed can instead stay where it is if you ${KEEP_IT_OUT}.`,
  ].join("\n");
}

/**
 * Map the validate verdict to a decision.
 *
 * Invalid blocks with the server-rendered Markdown verbatim when present (the
 * workspace's "surface output conventions": the wire is JSON, the agent reads
 * Markdown), falling back to a client-side rendering of `validation_errors[]`.
 * Valid passes, with a non-blocking nudge listing still-unimplemented
 * `PipeSignature`s. Unavailable passes silently — the local lint/format
 * verdicts already applied.
 *
 * A verdict reached without files the hook kept home says which, and why, in
 * a note placed after the verdict's text: non-blocking beside a valid verdict,
 * and inside an invalid one's block, so the agent reads an error about a
 * missing file as the hook's doing while the errors keep their place. A
 * refused validation sent nothing, and its note never blocks, since no verdict
 * was produced; the lint and format verdicts stand.
 */
export function decideAfterValidate(filePath: string, validate: ValidateStage): HookOutcome {
  switch (validate.status) {
    case "unavailable":
      return { kind: "pass" };
    case "refused":
      return {
        kind: "context",
        context: "",
        notes: [refusedNote(validate.root, validate.withheld)],
      };
    case "valid": {
      const notes = validate.withheld.length > 0 ? [withheldNote(validate.withheld)] : [];
      const nudge =
        validate.pendingSignatures.length > 0
          ? "Bundle is valid but not yet runnable. Signatures still unimplemented (PipeSignature placeholders): " +
            validate.pendingSignatures.join(", ") +
            ". They mock their output on dry-run; implement them before running the method for real."
          : "";
      if (nudge === "" && notes.length === 0) {
        return { kind: "pass" };
      }
      return notes.length > 0
        ? { kind: "context", context: truncate(nudge), notes }
        : { kind: "context", context: truncate(nudge) };
    }
    case "invalid": {
      let reason: string;
      if (validate.renderedMarkdown) {
        reason = validate.renderedMarkdown;
      } else {
        const lines = [
          `Validation failed for ${filePath}:`,
          "",
          validate.message || "Bundle is invalid.",
        ];
        if (validate.validationErrors.length > 0) {
          lines.push("");
          lines.push(...validate.validationErrors.map(renderValidationErrorLine));
        }
        reason = lines.join("\n");
      }
      return validate.withheld.length > 0
        ? { kind: "block", reason: truncate(reason), notes: [withheldNote(validate.withheld)] }
        : { kind: "block", reason: truncate(reason) };
    }
  }
}

/**
 * Encode an outcome as the harness's stdout payload, its text and notes as
 * {@link outcomeText} places them. `pass` is empty output; the hook always
 * exits 0. Claude and Codex share the block / `hookSpecificOutput` protocol;
 * Vibe speaks deny / `hook_specific_output`.
 */
export function encodeOutcome(outcome: HookOutcome, platform: HookPlatform = "claude"): string {
  switch (outcome.kind) {
    case "pass":
      return "";
    case "block":
      if (platform === "vibe") {
        return JSON.stringify({ decision: "deny", reason: outcomeText(outcome) }) + "\n";
      }
      return JSON.stringify({ decision: "block", reason: outcomeText(outcome) }) + "\n";
    case "context":
      if (platform === "vibe") {
        return (
          JSON.stringify({
            decision: "allow",
            hook_specific_output: { additional_context: outcomeText(outcome) },
          }) + "\n"
        );
      }
      return (
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: outcomeText(outcome),
          },
        }) + "\n"
      );
  }
}
