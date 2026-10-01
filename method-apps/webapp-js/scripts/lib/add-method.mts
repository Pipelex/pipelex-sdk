/**
 * `make add-method` — scaffold a method into this app.
 *
 * A method reaches the app in one of three forms, and every form ends in the
 * same slice: the generated tree, the Server Action trio, the typed narrower,
 * the form, a test and the registry entry, written by the same projections so
 * no app file is written by hand.
 *
 *  - **A bundle** — a `.mthds` file or a directory of them. The files are
 *    copied into `methods/<name>/` (a bundle already there is scaffolded in
 *    place) and the action reads them at request time.
 *  - **A catalog id** (`mt_…`) or **a published address** (`github.com/…`) —
 *    the method stays where it is and `methods/<name>/method.json` names it.
 *
 * Two halves, in this order, and the ordering is the whole safety story:
 *
 *  1. **Read-only** (`planAddMethod`). Parse the argument, read the bundle or
 *     check the base URL forwards the selector, fetch the catalog entry, run
 *     `fetchGenerated` (both API calls and every pre-write guard), choose the
 *     pipe, bind the output, derive every name, refuse every collision, and
 *     render and format every file *in memory*, the `src/methods.ts` insertion
 *     included. Every refusal happens here, with nothing on disk changed.
 *     `--dry-run` stops at the end of it and prints the plan.
 *  2. **Write** (`writeAddMethod`). The method directory, the tree through
 *     `writeGenerated` (the same writer `npm run codegen` uses, so a scaffolded
 *     tree IS the tree a regeneration would write), then the app files and the
 *     registry edit. A failure part-way removes everything the half created and
 *     restores the registry, so a re-run meets no collision of its own making.
 *     All of it runs under a lock file that refuses a second run meanwhile.
 *
 * The gesture is one-shot: re-running it for a name that already exists is a
 * refusal, not an overwrite. `npm run codegen` is the refresh — after editing a
 * bundle, or bumping a published method's tag in `method.json` — and
 * `npm run codegen:check` fails until you run it.
 *
 * Everything above `planAddMethod` is pure and unit-tested over a table; the
 * orchestration takes its repo root and its client from `deps` so the tests can
 * point it at a temporary copy of the tree. The two halves are exported
 * separately, so a caller can plan, act on the plan, and only then write.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, lstat, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// `@next/env` is CommonJS — see the note in `generate.mts`.
import nextEnv from "@next/env";
import {
  DEFAULT_API_BASE_URL,
  PipelexApiClient,
  type GeneratedArtifact,
  type InputForm,
  type InputFormItem,
  type PipeInputFormDescriptor,
  type PipeIOContract,
  type PipeIOContracts,
  type ValidateMethodSelector,
} from "@pipelex/sdk";

import { assertSelectorSupport, explainSelectorFailure } from "./api.mts";
import {
  fetchGenerated,
  methodVocabulary,
  writeGenerated,
  type FetchedMethod,
} from "./generate.mts";
import {
  assertSecureBaseUrl,
  hashSource,
  MANIFEST_FILENAME,
  NonUtf8FileError,
  readTextFile,
  refuseSymlinkRoot,
  REPO_ROOT,
  selectorKind,
  describeSelector,
  SymlinkRefusedError,
  walk,
  type MethodSource,
} from "./shared.mts";

const { loadEnvConfig } = nextEnv;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/**
 * A refusal: something the person asked for cannot be done, and the message
 * says what to do instead. Never a stack trace — every one of these is a
 * printed line and exit 1, the same contract `runGenerate` keeps.
 */
export class AddMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddMethodError";
  }
}

/**
 * A failure `fetchGenerated` has already printed. Carried as an error so the
 * read-only half can stay one straight line, and caught by the entry points
 * without printing anything more.
 */
export class ReportedFailure extends Error {
  constructor() {
    super("already reported");
    this.name = "ReportedFailure";
  }
}

// ── The argument ────────────────────────────────────────────────────────────

/** A catalog id, as the platform mints them. */
const METHOD_ID_PATTERN = /^mt_[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One segment of an address — host, owner, repo, or a package subpath segment. */
const ADDRESS_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A `@tag` suffix: a git tag or branch name, as the address grammar allows. */
const ADDRESS_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const METHOD_ARG_FORMS =
  "a path to a .mthds file or to a directory of them, " +
  'a catalog id ("mt_…"), or a published address ' +
  '("github.com/<owner>/<repo>[/<package>][@<tag>]")';

/** What the one `METHOD` argument names. */
export type MethodArg =
  | { kind: "selector"; selector: ValidateMethodSelector }
  | { kind: "bundle"; path: string };

/**
 * Does the argument name a place on disk rather than an address?
 *
 * An address always starts with its host, and a host has a dot in it
 * (`github.com`), so a first segment without one is a path — `methods/cv`,
 * `bundles/cv`. The explicit path forms are recognised before that test, since
 * `./cv` and `../cv` start with a dot of their own, and so is anything ending
 * in `.mthds`, which no address does.
 */
export function looksLikePath(value: string): boolean {
  if (value.endsWith(".mthds")) return true;
  if (/^(\/|~(\/|$)|\.{1,2}(\/|$))/.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) return true;
  return !value.split("/")[0]!.includes(".");
}

/**
 * Parse the one `METHOD` argument.
 *
 * `onDisk` answers whether the argument names something that exists, and a
 * name that does is a path whatever it looks like: `bundles.v2/cv` has a dot in
 * its first segment and `mt_drafts` the catalog prefix, and both are ordinary
 * directory names. Only a name that exists nowhere falls through to the
 * selector grammar.
 *
 * A selector comes back as the SDK's own type, which is what `validate`,
 * `codegen`, `prepareInputs`, the manifest and the scaffolded action's
 * `buildOptions` all take, so it is parsed once here and carried unchanged
 * everywhere else. A path comes back as given: resolving it needs the
 * directory the gesture was run from, which is the orchestration's business.
 *
 * `mthds` does not export its address parser from a public entry (it is
 * internal to the installer), so this is a small parser over the same grammar:
 * `github.com/<owner>/<repo>[/<subpath>…][@<tag>]`, with an optional
 * `https://` prefix that is normalized away.
 */
export function parseMethodArg(
  arg: string,
  onDisk: (value: string) => boolean = () => false,
): MethodArg {
  const trimmed = arg.trim();
  if (trimmed === "") throw new AddMethodError(`METHOD is empty — pass ${METHOD_ARG_FORMS}.`);
  if (onDisk(trimmed)) return { kind: "bundle", path: trimmed };

  if (trimmed.startsWith("mt_")) {
    if (!METHOD_ID_PATTERN.test(trimmed)) {
      throw new AddMethodError(`"${trimmed}" is not a well-formed catalog id (mt_…).`);
    }
    return { kind: "selector", selector: { method_id: trimmed } };
  }

  const hasScheme = /^https?:\/\//.test(trimmed);
  if (!hasScheme && looksLikePath(trimmed)) return { kind: "bundle", path: trimmed };

  const bare = trimmed.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const [address, ...extraTags] = bare.split("@");
  if (extraTags.length > 1) {
    throw new AddMethodError(`"${trimmed}" has more than one @tag — an address names one.`);
  }
  const tag = extraTags[0];
  if (tag !== undefined && !ADDRESS_TAG.test(tag)) {
    throw new AddMethodError(`"${trimmed}" has an @tag that is not a tag name.`);
  }

  const segments = (address ?? "").split("/");
  const wellFormed =
    segments.length >= 3 && segments.every((segment) => ADDRESS_SEGMENT.test(segment));
  if (!wellFormed) {
    throw new AddMethodError(
      `"${trimmed}" is not ${METHOD_ARG_FORMS}.\n` +
        "  An address names at least a host, an owner and a repository.",
    );
  }

  const methodRef = tag === undefined ? segments.join("/") : `${segments.join("/")}@${tag}`;
  return { kind: "selector", selector: { method_ref: methodRef } };
}

/**
 * The address's path segments, tag stripped — `github.com/o/r/pkg@v1` yields
 * `["github.com", "o", "r", "pkg"]`.
 */
export function addressSegments(methodRef: string): string[] {
  return methodRef.split("@")[0]!.split("/");
}

// ── The bundle ──────────────────────────────────────────────────────────────

/** One `.mthds` file of a bundle, as read. */
export interface BundleFile {
  /** Where it lands inside the method directory, forward slashes: `main.mthds`. */
  relative: string;
  /** How messages and validation diagnostics name it. */
  label: string;
  content: string;
}

/** A bundle the gesture was pointed at, read and placed. */
export interface Bundle {
  files: BundleFile[];
  /**
   * The method directory's name when the bundle already sits in
   * `methods/<name>/`, which is then scaffolded in place; `null` when the
   * files are copied in.
   */
  inPlace: string | null;
  /** How messages name the bundle as a whole. */
  display: string;
}

/** `~` and `~/…` the way a shell would have expanded them, had it been asked to. */
function expandHome(given: string): string {
  return given === "~" || given.startsWith("~/") ? path.join(os.homedir(), given.slice(1)) : given;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The refusal for a bundle path that is not a regular file or directory,
 * worded for a path anywhere: the codegen scripts' own wording names
 * `methods/` and `src/generated/`, which is wrong for a bundle outside both.
 * It promises what `readBundle` checks and no more — the path named and
 * everything under a bundle directory, not the directories above the path.
 */
function notRegularRefusal(where: string, kind: string): string {
  return (
    `refusing ${kind} at ${where} — the path given, and everything under a bundle ` +
    "directory, must be a regular file or a directory. Point at the files themselves."
  );
}

/**
 * Read every `.mthds` file under `dir`, refusing what the codegen scripts
 * refuse: a symlink or special file anywhere below it, and a file that is not
 * UTF-8. Both are refusals rather than skips, because a bundle that silently
 * loses a file is a method that silently changes.
 */
async function readBundleDir(
  dir: string,
  display: string,
  label: (relative: string) => string,
): Promise<{ files: BundleFile[]; treePaths: string[] }> {
  let treePaths: string[];
  try {
    treePaths = await walk(dir);
  } catch (error) {
    if (error instanceof SymlinkRefusedError) {
      throw new AddMethodError(notRegularRefusal(error.filePath, error.kind));
    }
    throw error;
  }
  const bundlePaths = treePaths.filter((relative) => relative.endsWith(".mthds"));
  if (bundlePaths.length === 0) {
    throw new AddMethodError(`${display} holds no .mthds file — there is no bundle to add.`);
  }
  const files: BundleFile[] = [];
  for (const relative of bundlePaths) {
    files.push({
      relative,
      label: label(relative),
      content: await readUtf8(path.join(dir, relative)),
    });
  }
  return { files, treePaths };
}

async function readUtf8(filePath: string): Promise<string> {
  try {
    return await readTextFile(filePath);
  } catch (error) {
    if (error instanceof NonUtf8FileError) throw new AddMethodError(error.message);
    throw error;
  }
}

/**
 * Read the bundle a path names, and decide where it lives in the app.
 *
 * A path inside `methods/<name>/` — the directory itself or any file in it —
 * means that whole directory, because `npm run codegen` reads every `.mthds`
 * file a method directory holds: scaffolding one file of it would describe a
 * method the generated tree does not. Anywhere else, a file is taken alone and
 * a directory is taken with every `.mthds` file under it, and all of them are
 * copied in later, keeping their paths relative to what was named.
 */
export async function readBundle(given: string, cwd: string, repoRoot: string): Promise<Bundle> {
  const resolved = path.resolve(cwd, expandHome(given));
  const methodsRoot = path.join(repoRoot, "methods");

  // `lstat`, not `stat`: the path itself is held to the rule its entries are,
  // so a `.mthds` link to some other file is refused rather than read.
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    throw new AddMethodError(
      `"${given}" is not a file or a directory (looked for ${resolved}).\n` +
        `  METHOD is ${METHOD_ARG_FORMS}.`,
    );
  }
  if (info.isSymbolicLink()) {
    throw new AddMethodError(notRegularRefusal(`"${given}"`, "a symlink"));
  }

  if (path.relative(methodsRoot, resolved) === "") {
    throw new AddMethodError(
      `"${given}" is the methods/ directory itself — point at one method's directory in it.`,
    );
  }

  if (isInside(methodsRoot, resolved)) {
    const [dirName, ...rest] = path.relative(methodsRoot, resolved).split(path.sep);
    if (rest.length === 0 && !info.isDirectory()) {
      throw new AddMethodError(
        `"${given}" sits directly in methods/, where no method is read from. Move it into a ` +
          "directory of its own, methods/<name>/, and point at that directory.",
      );
    }
    const methodDir = path.join(methodsRoot, dirName!);
    const display = `methods/${dirName}/`;
    const { files, treePaths } = await readBundleDir(
      methodDir,
      display,
      (relative) => `methods/${dirName}/${relative}`,
    );
    if (treePaths.includes(MANIFEST_FILENAME)) {
      throw new AddMethodError(
        `${display} holds a ${MANIFEST_FILENAME} beside its .mthds files — a method directory ` +
          "holds one or the other. Remove whichever does not describe the method.",
      );
    }
    return { files, inPlace: dirName!, display };
  }

  const shown = isInside(cwd, resolved) ? path.relative(cwd, resolved) : resolved;

  if (info.isFile()) {
    if (!resolved.endsWith(".mthds")) {
      throw new AddMethodError(
        `"${given}" is not a .mthds file.\n  METHOD is ${METHOD_ARG_FORMS}.`,
      );
    }
    const content = await readUtf8(resolved);
    return {
      files: [{ relative: path.basename(resolved), label: shown, content }],
      inPlace: null,
      display: shown,
    };
  }

  if (!info.isDirectory()) {
    throw new AddMethodError(`"${given}" is neither a file nor a directory.`);
  }
  if (!isInside(resolved, repoRoot) && path.relative(resolved, repoRoot) !== "") {
    // Not an ancestor of the app: the ordinary case.
  } else {
    throw new AddMethodError(
      `"${given}" contains this app. Point at the directory that holds the bundle's .mthds files.`,
    );
  }
  const display = `${shown}/`;
  const { files } = await readBundleDir(resolved, display, (relative) =>
    path.join(shown, relative),
  );
  return { files, inPlace: null, display };
}

// ── Names ───────────────────────────────────────────────────────────────────

// A letter first: the slug also becomes TypeScript identifiers (`TextStatsForm`,
// `runTextStatsBlocking`), and an identifier cannot start with a digit.
const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * `text_stats` → `text-stats`, `CV screening` → `cv-screening`, `Test-1` →
 * `test-1`. The result is a directory name, a registry id, and the stem of four
 * source files and of the identifiers in them, so it is validated rather than
 * merely produced: a name that cannot be one of those — `3D model`, whose slug
 * would start with a digit — is a refusal here, not a broken import later.
 */
export function kebabCase(input: string, nameFlag = "--name"): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SLUG_PATTERN.test(slug)) {
    throw new AddMethodError(
      `"${input}" does not yield a usable directory name (got "${slug}"). ` +
        `Pass ${nameFlag} with a kebab-case name of your own that starts with a letter.`,
    );
  }
  return slug;
}

/** Is `slug` a name the scaffold can build every file and identifier from? */
export function isSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** `text-stats` → `TextStats`. The component, the actions, the output type. */
export function pascalCase(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** `text-stats` → `textStats`. The adapter module's basename. */
export function camelCase(slug: string): string {
  const pascal = pascalCase(slug);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** `text-stats` → `Text stats`. The fallback label. */
export function humanize(slug: string): string {
  const words = slug.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The words a method spells with a capital after their first letter — `CVs`,
 * `PDF`, `PostgreSQL`, `REST`.
 *
 * That interior capital is what tells an acronym or a brand from an ordinary
 * word that happens to open a sentence: taking every capitalized word would
 * make "Build a hiring scorecard" turn a `build` slug into "Build", which says
 * nothing about how the author spells anything.
 */
export function spelledWords(prose: string): Map<string, string> {
  const spellings = new Map<string, string>();
  const plurals = new Map<string, string>();
  for (const word of prose.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) {
    if (!/[A-Z]/.test(word.slice(1))) continue;
    const lower = word.toLowerCase();
    if (!spellings.has(lower)) spellings.set(lower, word);
    // A method writing "CVs" spells "cv" too, and one writing "CV" spells
    // "cvs" — a derived word is singular or plural by the slug's grammar, not
    // by the prose's.
    if (word.endsWith("s")) {
      const singular = word.slice(0, -1);
      if (!plurals.has(singular.toLowerCase())) plurals.set(singular.toLowerCase(), singular);
    } else if (!plurals.has(`${lower}s`)) {
      plurals.set(`${lower}s`, `${word}s`);
    }
  }
  for (const [lower, word] of plurals) if (!spellings.has(lower)) spellings.set(lower, word);
  return spellings;
}

/**
 * A label inside a sentence — `Run text stats`, `Run CV screening`.
 *
 * Every word is lower-cased except one carrying an interior capital, which is
 * an acronym or a brand and is spelled the way it is spelled wherever it sits.
 * A flat `toLowerCase()` put "Run cv screening" on the button of a project
 * whose method writes "CVs".
 */
export function inSentence(label: string): string {
  return label.replace(/[A-Za-z][A-Za-z0-9]*/g, (word) =>
    /[A-Z]/.test(word.slice(1)) ? word : word.toLowerCase(),
  );
}

/**
 * Give back `text` with every word the method spells its own way respelled —
 * `Cv screening` → `CV screening`.
 *
 * The gesture asks nothing, by design, so a derived label or title is the only
 * one a project gets unless its author passes `--label` or `--title`. Deriving
 * it word by word from a kebab slug lower-cases an acronym the method itself
 * capitalizes: a `cv_screening` domain became "Cv screening" while the method's
 * own description said "score a batch of CVs".
 */
export function respellAcronyms(text: string, prose: string): string {
  const spellings = spelledWords(prose);
  if (spellings.size === 0) return text;
  return text.replace(/[A-Za-z][A-Za-z0-9]*/g, (word) => spellings.get(word.toLowerCase()) ?? word);
}

/**
 * Where a selector's slug comes from when `--name` is not given: the catalog
 * `name` for a stored method (a person chose it), and the address's last path
 * segment for a published one — the package, falling back to the repository for
 * an address that names no package. A bundle's slug is the domain of the pipe
 * it runs, or the name of the `methods/` directory it already sits in.
 */
export function slugSource(
  selector: ValidateMethodSelector,
  catalogName?: string,
  nameFlag = "--name",
): string {
  if (selectorKind(selector) === "method_id") {
    if (catalogName === undefined || catalogName.trim() === "") {
      throw new AddMethodError(
        `the catalog method has no name to derive a directory name from — pass ${nameFlag}.`,
      );
    }
    return catalogName;
  }
  const segments = addressSegments(selector.method_ref!);
  return segments.length > 3 ? segments[segments.length - 1]! : segments[2]!;
}

/** Every name the scaffold derives, in one record the templates read. */
export interface ScaffoldNames {
  /** Directory name under `methods/` and `src/generated/`, and the registry id. */
  slug: string;
  /** `TextStats` — the component, the action names, the output type. */
  pascal: string;
  /** `textStats` — the adapter module's basename. */
  camel: string;
  /** The method's label: its tab, when the app runs several, and its Run button. */
  label: string;
}

export function scaffoldNames(slug: string, label?: string): ScaffoldNames {
  const trimmed = label?.trim();
  return {
    slug,
    pascal: pascalCase(slug),
    camel: camelCase(slug),
    label: trimmed !== undefined && trimmed !== "" ? trimmed : humanize(slug),
  };
}

/** Every repo-relative path the gesture touches, derived from the names. */
export interface ScaffoldPaths {
  /** The method's directory: its bundle, or the manifest naming it. */
  methodDir: string;
  /** The manifest's path — written only for a method that lives elsewhere. */
  manifest: string;
  generatedDir: string;
  adapter: string;
  /** The media types its file inputs accept — written only for a method that takes a file. */
  uploads: string;
  action: string;
  actionTest: string;
  form: string;
  registry: string;
}

export function scaffoldPaths(names: ScaffoldNames): ScaffoldPaths {
  return {
    methodDir: `methods/${names.slug}`,
    manifest: `methods/${names.slug}/${MANIFEST_FILENAME}`,
    generatedDir: `src/generated/${names.slug}`,
    adapter: `src/types/${names.camel}Pipeline.ts`,
    uploads: `src/types/${names.camel}Uploads.ts`,
    action: `src/actions/run${names.pascal}Pipeline.ts`,
    actionTest: `src/actions/run${names.pascal}Pipeline.test.ts`,
    form: `src/components/${names.pascal}Form.tsx`,
    registry: "src/methods.ts",
  };
}

// ── The pipe ────────────────────────────────────────────────────────────────

/** The chosen pipe, split the way `requireContract` and the run options take it. */
export interface ChosenPipe {
  /** Qualified: `text_stats.analyze_text` — what the run request sends as `pipe_code`. */
  ref: string;
  /** Everything before the last dot. */
  domain: string;
  /** Everything after it. */
  code: string;
}

function splitPipeRef(ref: string): ChosenPipe {
  const at = ref.lastIndexOf(".");
  if (at <= 0 || at === ref.length - 1) {
    throw new AddMethodError(
      `the method declares a pipe ref this scaffold cannot split into a domain and a ` +
        `code: "${ref}". Report it upstream.`,
    );
  }
  return { ref, domain: ref.slice(0, at), code: ref.slice(at + 1) };
}

/**
 * Which pipe the scaffolded slice runs, by a rule that ends in a refusal rather
 * than a guess.
 *
 * In order: an explicit `--pipe` (bare or qualified); else the validate
 * report's `default_pipe_ref`; else the single entry when there is exactly one;
 * else a refusal listing what the method declares. `default_pipe_ref` is read
 * in preference to the blueprint's opaque `main_pipe` because it is typed and
 * because it is the field a published package's manifest fills — the
 * `documents` package has no bundle-level `main_pipe` and still names one.
 */
export function choosePipe(
  contracts: PipeIOContracts,
  defaultPipeRef: string | null,
  requested?: string,
): ChosenPipe {
  const refs = Object.keys(contracts);
  if (refs.length === 0) {
    throw new AddMethodError("the method declares no pipes — there is nothing to scaffold.");
  }
  const listed = refs.join(", ");

  if (requested !== undefined) {
    if (Object.prototype.hasOwnProperty.call(contracts, requested)) return splitPipeRef(requested);
    const matches = refs.filter((ref) => ref.slice(ref.lastIndexOf(".") + 1) === requested);
    if (matches.length === 1) return splitPipeRef(matches[0]!);
    if (matches.length > 1) {
      throw new AddMethodError(
        `--pipe "${requested}" is ambiguous — it matches ${matches.join(", ")}. ` +
          "Pass the qualified <domain>.<pipe_code>.",
      );
    }
    throw new AddMethodError(
      `--pipe "${requested}" is not a pipe this method declares. It declares: ${listed}.`,
    );
  }

  if (defaultPipeRef !== null && defaultPipeRef.trim() !== "") {
    if (!Object.prototype.hasOwnProperty.call(contracts, defaultPipeRef)) {
      throw new AddMethodError(
        `the method's default pipe "${defaultPipeRef}" is not among the pipes it declares ` +
          `(${listed}). Pass --pipe, and report the inconsistency upstream.`,
      );
    }
    return splitPipeRef(defaultPipeRef);
  }

  if (refs.length === 1) return splitPipeRef(refs[0]!);

  throw new AddMethodError(
    `the method declares several pipes and names no default — pass --pipe.\n` +
      `  Pipes: ${listed}`,
  );
}

/** Look a pipe's contract up, tolerating a map keyed by bare code. */
export function contractFor(contracts: PipeIOContracts, pipe: ChosenPipe): PipeIOContract {
  const contract = contracts[pipe.ref] ?? contracts[pipe.code];
  if (contract === undefined) {
    throw new AddMethodError(`the validate report carries no IO contract for "${pipe.ref}".`);
  }
  return contract;
}

/** Look a pipe's input-form descriptor up the same way. */
export function descriptorFor(inputForm: InputForm, pipe: ChosenPipe): PipeInputFormDescriptor {
  const descriptor = inputForm[pipe.ref] ?? inputForm[pipe.code];
  if (descriptor === undefined) {
    throw new AddMethodError(
      `the validate report carries no input-form descriptor for "${pipe.ref}" — ` +
        "the form would render empty. Check PIPELEX_BASE_URL, or report it upstream.",
    );
  }
  return descriptor;
}

// ── The output ──────────────────────────────────────────────────────────────

/** What the scaffolded narrower is written against. */
export interface OutputBinding {
  /** The concept's code — `Text` for `native.Text`. `<Code>Schema` and `parse<Code>`. */
  conceptCode: string;
  /**
   * A plural output is a list of the concept. The runtime renders one as a
   * `{ items: [...] }` envelope on some paths and as a bare array on others, so
   * the narrower reads it through `wireListOutput`, which accepts both.
   */
  plural: boolean;
}

/**
 * Bind the chosen pipe's output onto the exports the projection just produced.
 *
 * The narrower is typed — the ts-zod emitter projects native concepts too, so a
 * binder always exports a `parse<Concept>` for whatever the pipe produces. What
 * makes that safe to write blind is this check: the exports are looked for in
 * the artifacts we have in hand, so an emitter naming change is a refusal here
 * rather than a type error the person has to debug in a file they did not write.
 */
export function bindOutput(
  contract: PipeIOContract,
  artifacts: readonly GeneratedArtifact[],
): OutputBinding {
  const conceptRef = contract.output.concept_ref;
  const conceptCode = conceptRef.slice(conceptRef.lastIndexOf(".") + 1);
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(conceptCode)) {
    throw new AddMethodError(
      `the pipe's output concept "${conceptRef}" does not end in a name this scaffold can ` +
        "turn into a TypeScript identifier.",
    );
  }

  const plural = contract.output.multiplicity !== "single";
  const bodyOf = (name: string): string => {
    const artifact = artifacts.find((candidate) => candidate.path === name);
    if (artifact === undefined) {
      throw new AddMethodError(`the codegen response carries no ${name} to bind the output to.`);
    }
    return artifact.content;
  };

  if (!bodyOf("types.ts").includes(`export const ${conceptCode}Schema`)) {
    throw new AddMethodError(
      `the generated types.ts exports no ${conceptCode}Schema for the pipe's output ` +
        `concept "${conceptRef}". Nothing was written; report it upstream.`,
    );
  }
  // The plural arm parses through `z.array(<Code>Schema)`, so it needs the
  // schema and not the single-value binder.
  if (!plural && !bodyOf("binder.ts").includes(`export function parse${conceptCode}(`)) {
    throw new AddMethodError(
      `the generated binder.ts exports no parse${conceptCode} for the pipe's output ` +
        `concept "${conceptRef}". Nothing was written; report it upstream.`,
    );
  }

  return { conceptCode, plural };
}

// ── File inputs ─────────────────────────────────────────────────────────────

/** One file-bearing position of a pipe's inputs, at any depth. */
export interface FileInput {
  /** Dotted, with `[]` for a list's items: `document`, `cvs[]`, `packet.scan`. */
  path: string;
  kind: "document" | "image";
}

function collectFiles(node: InputFormItem, at: string, out: FileInput[]): void {
  if (node.kind === "document" || node.kind === "image") {
    out.push({ path: at, kind: node.kind });
  } else if (node.kind === "object") {
    for (const child of node.fields) collectFiles(child, `${at}.${child.name}`, out);
  } else if (node.kind === "list") {
    collectFiles(node.item, `${at}[]`, out);
  }
}

/**
 * Every file position a pipe's inputs declare, in descriptor order.
 *
 * Any one of them gives the slice the whole file-input path: the browser
 * stores each dropped file in Pipelex storage through `useFileInputs` and the
 * method's grant action (the kernel's list and object controls hand a nested
 * file to the same `onDropFile` seam, at its dotted id), the run action gates
 * every position with `checkFileInputs` — which walks this same descriptor —
 * and `prepareInputs` passes the stored references through. Depth does not
 * change the shape of what is scaffolded, only the media types the grant
 * action accepts.
 */
export function fileInputsOf(descriptor: PipeInputFormDescriptor): FileInput[] {
  const files: FileInput[] = [];
  for (const field of descriptor.fields) collectFiles(field, field.name, files);
  return files;
}

/** The media types a scaffolded action accepts, by the file kinds it declares. */
export function allowedMimesFor(files: FileInput[]): string[] {
  const mimes = new Set<string>();
  for (const field of files) {
    if (field.kind === "document") mimes.add("application/pdf");
    else for (const mime of ["image/png", "image/jpeg", "image/webp"]) mimes.add(mime);
  }
  return [...mimes];
}

/** Does the pipe have an input the run gate will refuse an empty submission for? */
export function hasGatingInput(descriptor: PipeInputFormDescriptor): boolean {
  return descriptor.fields.some((field) => field.gating);
}

// ── The registry ────────────────────────────────────────────────────────────

/**
 * The two markers `src/methods.ts` carries, and the scaffold's whole contract
 * with that file.
 *
 * The match is on the token alone, not on the full comment line, so the prose
 * after it can be reworded freely; the tokens themselves may not move. An
 * anchor test reads the real file, so a template edit that loses one fails the
 * suite rather than the next person's scaffold run.
 */
export const IMPORTS_ANCHOR = "// add-method:imports";
export const TABS_ANCHOR = "// add-method:tabs";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One entry of the `METHODS` array, and the import that feeds it. */
export interface RegistryEntry {
  id: string;
  label: string;
  componentName: string;
}

/**
 * Register a scaffolded method in `src/methods.ts` — one import line above the
 * imports anchor, one array entry above the entries anchor.
 *
 * Pure over the source text: the orchestration does this in memory during its
 * read-only half, so a missing anchor or a duplicate id is a refusal before
 * anything is written.
 */
export function registerMethod(source: string, entry: RegistryEntry, nameFlag = "--name"): string {
  const lines = source.split("\n");
  const importsAt = lines.findIndex((line) => line.includes(IMPORTS_ANCHOR));
  const tabsAt = lines.findIndex((line) => line.includes(TABS_ANCHOR));

  for (const [anchor, at] of [
    [IMPORTS_ANCHOR, importsAt],
    [TABS_ANCHOR, tabsAt],
  ] as const) {
    if (at === -1) {
      throw new AddMethodError(
        `src/methods.ts has no '${anchor}' anchor.\n` +
          "  The scaffold inserts at that comment; restore it (see the file's other anchor\n" +
          "  for the shape) or register the method by hand.",
      );
    }
  }
  if (new RegExp(`\\bid:\\s*"${escapeRegExp(entry.id)}"`).test(source)) {
    throw new AddMethodError(
      `src/methods.ts already registers a method with id "${entry.id}". ` +
        `Pass ${nameFlag} to scaffold under a different name.`,
    );
  }
  if (new RegExp(`\\b${escapeRegExp(entry.componentName)}\\b`).test(source)) {
    throw new AddMethodError(
      `src/methods.ts already mentions ${entry.componentName}. ` +
        `Pass ${nameFlag} to scaffold under a different name.`,
    );
  }

  const indent = /^\s*/.exec(lines[tabsAt]!)?.[0] ?? "  ";
  const withImport = [
    ...lines.slice(0, importsAt),
    `import { ${entry.componentName} } from "@/components/${entry.componentName}";`,
    ...lines.slice(importsAt),
  ];
  const entryAt = tabsAt + 1; // the import above pushed everything down one line
  return [
    ...withImport.slice(0, entryAt),
    `${indent}{ id: ${JSON.stringify(entry.id)}, label: ${JSON.stringify(entry.label)}, ` +
      `Component: ${entry.componentName} },`,
    ...withImport.slice(entryAt),
  ].join("\n");
}

// ── The emitted files ───────────────────────────────────────────────────────

/**
 * Where the scaffolded action finds its method: the selector a manifest holds,
 * or the bundle files under `methods/<slug>/`.
 */
export type ScaffoldSource =
  | { kind: "selector"; selector: ValidateMethodSelector }
  | { kind: "files" };

/** Everything the templates read, derived once by the read-only half. */
export interface ScaffoldPlan {
  names: ScaffoldNames;
  source: ScaffoldSource;
  pipe: ChosenPipe;
  binding: OutputBinding;
  files: FileInput[];
  /** Does the run gate refuse an empty submission? Decides the emitted test. */
  gating: boolean;
}

/** The manifest — the whole of the selector story on the codegen side. */
export function renderManifest(selector: ValidateMethodSelector): string {
  return `${JSON.stringify(selector, null, 2)}\n`;
}

/**
 * How the emitted code names the selector: the constant, and the manifest field
 * it is read from. The value itself is never copied into a source file — the
 * action and its test import the manifest — so editing `method.json` and running
 * `npm run codegen` moves the run and the generated contract together.
 */
function selectorConstant(selector: ValidateMethodSelector): { name: string; field: string } {
  return selectorKind(selector) === "method_ref"
    ? { name: "METHOD_REF", field: "method_ref" }
    : { name: "METHOD_ID", field: "method_id" };
}

/** `import MANIFEST from "@methods/<slug>/method.json";` — the one copy of the selector. */
function manifestImport(names: ScaffoldNames): string {
  return `import MANIFEST from "@methods/${names.slug}/method.json";`;
}

/**
 * `src/types/<camel>Pipeline.ts` — the adapter over the method's own generated
 * binder.
 *
 * The single arm hands `wireOutput` to the binder. The plural arm parses
 * `z.array(<Code>Schema)` over `wireListOutput`, which is what knows that the
 * runtime renders a list output two ways — `{ items: [...] }` on the blocking
 * path, a bare array on the durable path for a method-declared concept — and
 * hands back the array either way. Neither arm declares a field: the element
 * schema is the generated one, and the list around it is the contract's
 * `multiplicity`, not a shape.
 */
export function renderAdapter(plan: ScaffoldPlan): string {
  const { names, binding } = plan;
  const outputType = `${names.pascal}Output`;
  const parseName = `parse${names.pascal}Output`;
  const origin =
    plan.source.kind === "files"
      ? `the bundle in \`${scaffoldPaths(names).methodDir}/\``
      : `the method \`${scaffoldPaths(names).manifest}\` names`;
  const header = [
    "// Scaffolded by `make add-method` — yours to edit from here on.",
    "//",
    "// The output shape is NOT written here: `npm run codegen` projects it from",
    `// ${origin}, and this module is the thin`,
    "// adapter over that projection. If you find yourself declaring fields, the",
    "// method already declares them.",
    "",
  ];

  if (!binding.plural) {
    return [
      ...header,
      'import type { RunResults } from "@pipelex/sdk";',
      `import { parse${binding.conceptCode} } from "@/generated/${names.slug}/binder";`,
      `import type { ${binding.conceptCode} } from "@/generated/${names.slug}/types";`,
      'import { describeSchemaFailure, wireOutput } from "@/lib/wireOutput";',
      'import { BadPipelineOutputError } from "@/types/pipelineError";',
      "",
      `/** The pipe's output concept, re-exported under this slice's own name. */`,
      `export type ${outputType} = ${binding.conceptCode};`,
      "",
      "/**",
      ` * Narrow a run's output into \`${outputType}\` by handing \`main_stuff\` to the`,
      " * generated binder. Throws `BadPipelineOutputError` on a shape mismatch — this is",
      " * a system boundary (model output → typed app), so a failure is a real bug we",
      " * want surfaced; the blocking/poll catch classifies it.",
      " */",
      `export function ${parseName}(results: RunResults): ${outputType} {`,
      "  try {",
      `    return parse${binding.conceptCode}(wireOutput(results));`,
      "  } catch (err) {",
      `    throw new BadPipelineOutputError(describeSchemaFailure(err, ${JSON.stringify(binding.conceptCode)}));`,
      "  }",
      "}",
      "",
    ].join("\n");
  }

  const listSchema = `${names.pascal}OutputSchema`;
  return [
    ...header,
    'import type { RunResults } from "@pipelex/sdk";',
    'import { z } from "zod";',
    `import { ${binding.conceptCode}Schema, type ${binding.conceptCode} } from "@/generated/${names.slug}/types";`,
    'import { describeSchemaFailure, wireListOutput } from "@/lib/wireOutput";',
    'import { BadPipelineOutputError } from "@/types/pipelineError";',
    "",
    `/** This pipe produces several items: its output is a list of the concept. */`,
    `export type ${outputType} = ${binding.conceptCode}[];`,
    "",
    `const ${listSchema} = z.array(${binding.conceptCode}Schema);`,
    "",
    "/**",
    ` * Narrow a run's output into \`${outputType}\`. The runtime renders a list output`,
    " * two ways — a `{ items: [...] }` envelope on the blocking path, a bare array on",
    " * the durable path — and `wireListOutput` hands back the array either way, so",
    " * the generated element schema owns the verdict. Throws `BadPipelineOutputError`",
    " * on a shape mismatch — a system boundary, so a failure is a real bug we want",
    " * surfaced; the blocking/poll catch classifies it.",
    " */",
    `export function ${parseName}(results: RunResults): ${outputType} {`,
    "  try {",
    `    return ${listSchema}.parse(wireListOutput(results));`,
    "  } catch (err) {",
    `    throw new BadPipelineOutputError(describeSchemaFailure(err, ${JSON.stringify(`${binding.conceptCode}[]`)}));`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * How the emitted action names its method, in both halves of the file: the
 * imports it needs, the constant it declares, and the fields `buildOptions`
 * spreads into the run options.
 *
 * Neither form copies the method into the source file. A selector is read from
 * the manifest — so editing `method.json` and running `npm run codegen` moves
 * the run and the generated contract together — and a bundle is read from its
 * directory at request time, so an edit to the files and a regeneration do the
 * same.
 */
function methodReference(plan: ScaffoldPlan): {
  imports: string[];
  declaration: string[];
  describe: string[];
} {
  const { names, source } = plan;
  if (source.kind === "files") {
    return {
      imports: ['import { loadMethodBundles } from "@/lib/loadBundle";'],
      describe: [
        "// The method's bundle is every `.mthds` file under",
        `// \`${scaffoldPaths(names).methodDir}/\`, read at request time rather than copied`,
        "// here, so the run always sends the bundle the generated tree was projected",
        "// from: edit the files, then run `npm run codegen`.",
      ],
      declaration: [`const METHOD_DIR = ${JSON.stringify(names.slug)};`],
    };
  }
  const constant = selectorConstant(source.selector);
  return {
    imports: [manifestImport(names)],
    describe: [
      "// The method is NOT copied into this repo: it lives where",
      `// \`${scaffoldPaths(names).manifest}\` says. The selector is read from that manifest`,
      "// rather than copied here, so the run always names the method the generated tree",
      "// was projected from: to move to another version, edit the manifest and run",
      "// `npm run codegen`.",
    ],
    declaration: [`const ${constant.name} = MANIFEST.${constant.field};`],
  };
}

/**
 * `src/types/<camel>Uploads.ts` — the media types the method's file inputs
 * accept, written only for a method that takes a file.
 *
 * A module of its own because both halves read the list and neither can hold
 * it. The upload action lives in a `"use server"` file, which may export async
 * functions only, and the form is a client component the action must not
 * import. So the action refuses a grant for any other type, the form narrows
 * each file input to these formats through `useRunInputs`, and the dropzone can
 * no longer offer a file the action would then refuse.
 */
export function renderUploads(plan: ScaffoldPlan): string {
  return [
    "// Scaffolded by `make add-method` — yours to edit from here on.",
    "",
    "/**",
    " * Media types the file input(s) accept. Widen it if your method takes more.",
    " *",
    ` * The one list both halves read: \`request${plan.names.pascal}Upload\` refuses a grant for any`,
    " * other type, and the form narrows each file input to the formats among these,",
    " * so the dropzone offers exactly what the action grants. The form can offer only",
    " * a format the form kernel knows for the input's kind.",
    " */",
    `export const ALLOWED_MIMES = ${JSON.stringify(allowedMimesFor(plan.files))};`,
    "",
  ].join("\n");
}

/**
 * `src/actions/run<Pascal>Pipeline.ts` — the Server Action trio.
 *
 * A selector-sourced method lives elsewhere, so `buildOptions` sends the same
 * `method_ref` / `method_id` the tree was projected from. A bundle-sourced one
 * sends the bundle itself, as `mthds_contents`, read through the one generic
 * loader. Everything else — the gate, the file path, the three exports — is the
 * same for both.
 */
export function renderAction(plan: ScaffoldPlan): string {
  const { names, source, pipe, files } = plan;
  const outputType = `${names.pascal}Output`;
  const parseName = `parse${names.pascal}Output`;
  const reference = methodReference(plan);
  const hasFiles = files.length > 0;

  const imports = [
    ...reference.imports,
    `import { ${hasFiles ? "INPUT_FORM, " : ""}PIPE_IO_CONTRACTS } from "@/generated/${names.slug}/contracts";`,
    `import { ${parseName}, type ${outputType} } from "@/types/${names.camel}Pipeline";`,
    'import { executeBlockingRun, type BlockingOutcome } from "@/lib/blockingRun";',
    "import {",
    "  pollDurableRun,",
    "  startDurableRun,",
    "  type PollOutcome,",
    "  type StartOutcome,",
    '} from "@/lib/durableRun";',
    `import { gateRunInputs, requireContract${hasFiles ? ", requireInputForm" : ""} } from "@/lib/runInputs";`,
    'import type { PipelexStartOptions } from "@pipelex/sdk";',
  ];
  if (hasFiles) {
    imports.splice(
      reference.imports.length + 2,
      0,
      'import { getPipelexClient } from "@/lib/pipelexClient";',
      'import { MAX_FILE_BYTES, checkFileInputs, type UploadRequest } from "@/lib/fileInputs";',
      'import { grantFileUpload, type GrantOutcome } from "@/lib/uploadGrant";',
      'import type { PipelineError } from "@/lib/errors";',
      `import { ALLOWED_MIMES } from "@/types/${names.camel}Uploads";`,
    );
  }

  const head = [
    '"use server";',
    "",
    ...imports,
    "",
    "// Scaffolded by `make add-method` — yours to edit from here on.",
    "//",
    ...reference.describe,
    ...reference.declaration,
    `const PIPE_CODE = ${JSON.stringify(pipe.code)};`,
    "/**",
    ...(hasFiles
      ? [
          " * What `prepareInputs` and the run name the pipe by: the qualified",
          " * `<domain>.<pipe_code>`, an exact key. `prepareInputs` refuses a bare code, and",
          " * the run searches every domain of the method for one, refusing it as ambiguous",
          " * once two domains declare it.",
        ]
      : [
          " * What the run names the pipe by: the qualified `<domain>.<pipe_code>`, an exact",
          " * key. A bare code is searched for across every domain of the method, and",
          " * refused as ambiguous once two domains declare it.",
        ]),
    " */",
    `const PIPE_REF = ${JSON.stringify(pipe.ref)};`,
  ];
  head.push(
    "",
    "// The same generated contract the browser rendered the form from. One gate, two",
    "// call sites, zero drift — and the server's copy is the one that's trusted.",
    `const CONTRACT = requireContract(PIPE_IO_CONTRACTS, ${JSON.stringify(pipe.domain)}, PIPE_CODE);`,
  );
  if (hasFiles) {
    head.push(
      "// The file gate walks the same wire descriptor the browser rendered the form",
      "// from, and the SDK's `prepareInputs` resolves uploads by — so the three agree",
      "// on where the files are, at any depth.",
      `const DESCRIPTOR = requireInputForm(INPUT_FORM, ${JSON.stringify(pipe.domain)}, PIPE_CODE);`,
    );
  }
  head.push("");

  const body: string[] = [];

  if (hasFiles) {
    // What `prepareInputs` is told the method is, and what the run is sent.
    const closure =
      source.kind === "files"
        ? {
            load: ["  const bundles = await loadMethodBundles(METHOD_DIR);"],
            prepare: "    files: bundles.map((content) => ({ content })),",
            run: "    mthds_contents: bundles,",
          }
        : {
            load: [],
            prepare: `    ${selectorConstant(source.selector).field}: ${selectorConstant(source.selector).name},`,
            run: `    ${selectorConstant(source.selector).field}: ${selectorConstant(source.selector).name},`,
          };
    body.push(
      "/**",
      " * Shape gate, then file gate, in that order.",
      " *",
      " * The kernel gate proves the shape a contract can declare; `checkFileInputs`",
      " * proves what it cannot: that the `url` at every file position the descriptor",
      " * declares — top-level, in a list, nested in a structured concept — is a",
      " * reference we accept. The browser stored each file before the run, so a run",
      " * carries references and never bytes. The check is the security-relevant one —",
      " * `prepareInputs` reads an unrecognised string as a local filesystem path, and",
      " * a Server Action is a public endpoint.",
      " */",
      "function gateInputs(",
      "  data: Record<string, unknown>,",
      "): { ok: true; inputs: Record<string, unknown> } | { ok: false; error: PipelineError } {",
      "  const gated = gateRunInputs(CONTRACT, data);",
      "  if (!gated.ok) return gated;",
      "  const error = checkFileInputs(DESCRIPTOR, gated.inputs);",
      "  return error ? { ok: false, error } : gated;",
      "}",
      "",
      "/**",
      " * UPLOAD — a grant for the browser to store one dropped file straight in Pipelex",
      " * storage, before any run. Only the file's name, type and size reach this",
      " * action, never its bytes; it refuses a type outside `ALLOWED_MIMES` and a size",
      " * past `MAX_FILE_BYTES`, then asks the platform for a create-only `PUT` signed",
      " * for exactly that file. The form's `useFileInputs` sends the file with it and",
      " * keeps the `pipelex-storage://` reference the run then carries.",
      " *",
      " * It is open to anyone who can reach the app, like the run actions, and for",
      " * the same single-tenant reason as the assets route: see `mayRead` in",
      " * `src/app/api/assets/[...path]/route.ts`. A deployment serving more than one",
      " * person answers the same question here before granting anything.",
      " */",
      `export async function request${names.pascal}Upload(request: UploadRequest): Promise<GrantOutcome> {`,
      "  return grantFileUpload(request, { allowedMimes: ALLOWED_MIMES, maxBytes: MAX_FILE_BYTES });",
      "}",
      "",
      "/**",
      " * Build the run options through the SDK's signature-driven `prepareInputs`",
      " * rather than a hand-rolled envelope: it reads the method's declared signature",
      " * and shapes each file position as the run expects it. The files themselves are",
      " * already in Pipelex storage, so it passes their references through untouched.",
      " *",
      " * It throws *before any run starts*, and this closure runs inside",
      " * `executeBlockingRun` / `startDurableRun`'s try/catch, so that error is",
      " * classified like any other SDK error — no try/catch here.",
      " */",
      "async function buildOptions(",
      "  inputs: Record<string, unknown>,",
      "): Promise<PipelexStartOptions> {",
      ...closure.load,
      "  const prepared = await getPipelexClient().prepareInputs({",
      closure.prepare,
      "    pipe_ref: PIPE_REF,",
      "    inputs,",
      "  });",
      "  return {",
      closure.run,
      "    pipe_code: PIPE_REF,",
      "    inputs: prepared.inputs,",
      "  };",
      "}",
      "",
    );
  } else {
    const run =
      source.kind === "files"
        ? "    mthds_contents: await loadMethodBundles(METHOD_DIR),"
        : `    ${selectorConstant(source.selector).field}: ${selectorConstant(source.selector).name},`;
    body.push(
      "/**",
      " * SDK options shared by both paths — `execute` and `start` take the same shape.",
      " *",
      ...(source.kind === "files"
        ? [
            " * The bundle travels inline as `mthds_contents`, every file of it, in the",
            " * order `npm run codegen` read them.",
          ]
        : [
            " * `PipelexStartOptions` is the protocol's run arguments plus the run extensions;",
            " * the selector below is one of those, which is what lets this action name a",
            " * method that lives elsewhere instead of shipping a bundle inline.",
          ]),
      " */",
      "async function buildOptions(",
      "  inputs: Record<string, unknown>,",
      "): Promise<PipelexStartOptions> {",
      "  return {",
      run,
      "    pipe_code: PIPE_REF,",
      "    inputs,",
      "  };",
      "}",
      "",
    );
  }

  const gateCall = hasFiles ? "gateInputs(data)" : "gateRunInputs(CONTRACT, data)";

  body.push(
    "/**",
    " * BLOCKING path (`POST /v1/execute`). Behind the hosted gateway a synchronous run",
    " * is cut off at ~30s; the Durable mode, `NEXT_PUBLIC_EXECUTION_MODE`'s default,",
    " * survives a long one.",
    " */",
    `export async function run${names.pascal}Blocking(`,
    "  data: Record<string, unknown>,",
    `): Promise<BlockingOutcome<${outputType}>> {`,
    `  const gated = ${gateCall};`,
    "  if (!gated.ok) return gated;",
    `  return executeBlockingRun(() => buildOptions(gated.inputs), ${parseName});`,
    "}",
    "",
    "/** DURABLE path — start the run (`POST /v1/start`) and return its id to poll. */",
    `export async function start${names.pascal}Run(data: Record<string, unknown>): Promise<StartOutcome> {`,
    `  const gated = ${gateCall};`,
    "  if (!gated.ok) return gated;",
    "  return startDurableRun(() => buildOptions(gated.inputs));",
    "}",
    "",
    "/** DURABLE path — poll one tick of a started run by id. */",
    `export async function poll${names.pascal}Run(runId: string): Promise<PollOutcome<${outputType}>> {`,
    `  return pollDurableRun(runId, ${parseName});`,
    "}",
    "",
  );

  return [...head, ...body].join("\n");
}

/**
 * `src/actions/run<Pascal>Pipeline.test.ts` — one fixture-free test, and no more.
 *
 * A test that guessed input values from the descriptor would be a liability the
 * day it guessed wrong, so this asserts only what is true without knowing what
 * the method takes: the trust boundary (a gating pipe refuses an empty
 * submission before the SDK is reached), or, for a pipe that gates on nothing,
 * that an empty submission reaches `execute` carrying the method — its selector
 * or its bundle — and the qualified pipe ref. Everything else the slice does is
 * covered by the shared code's own tests — `useRun`, `RunInputsForm`,
 * `runInputs`, `blockingRun`, `durableRun`.
 */
export function renderActionTest(plan: ScaffoldPlan): string {
  const { names, source, pipe, files, gating } = plan;
  const hasFiles = files.length > 0;

  const clientMethods = ["execute", "start", "getRunStatus", "getRunResult"];
  if (hasFiles) clientMethods.push("prepareInputs", "requestUploadGrant");

  // Only the non-gating test reads the method; an unused import fails tsc.
  const methodImport = gating
    ? []
    : source.kind === "files"
      ? ['import { loadMethodBundles } from "@/lib/loadBundle";']
      : [manifestImport(names)];
  const methodField =
    source.kind === "files"
      ? `      mthds_contents: await loadMethodBundles(${JSON.stringify(names.slug)}),`
      : `      ${selectorConstant(source.selector).field}: MANIFEST.${selectorConstant(source.selector).field},`;

  const head = [
    'import { describe, it, expect, vi, beforeEach } from "vitest";',
    "",
    ...clientMethods.map((method) => `const ${method} = vi.fn();`),
    "",
    'vi.mock("@/lib/pipelexClient", () => ({',
    `  getPipelexClient: () => ({ ${clientMethods.join(", ")} }),`,
    "}));",
    "",
    ...methodImport,
    // The gating test drives both paths; the wiring test drives the blocking one;
    // a file method's grant test drives its upload action. An unused import fails tsc.
    `import { ${[
      ...(hasFiles ? [`request${names.pascal}Upload`] : []),
      `run${names.pascal}Blocking`,
      ...(gating ? [`start${names.pascal}Run`] : []),
    ].join(", ")} } from "./run${names.pascal}Pipeline";`,
    "",
    "beforeEach(() => {",
    ...clientMethods.map((method) => `  ${method}.mockReset();`),
    "});",
    "",
    "// Scaffolded by `make add-method`, and deliberately fixture-free: a test that",
    "// guessed input values from the method's descriptor would be wrong the day the",
    "// method changes. Add your own cases with real inputs once you know what this",
    "// method takes: mock `execute` and `start`, call the action, assert the outcome.",
    `describe("run${names.pascal}Pipeline", () => {`,
  ];

  const body = gating
    ? [
        "  // The browser's readiness check is the Run button's UX; this is the trust",
        "  // boundary. The gate runs the kernel's rules over the method's own contract.",
        '  it("refuses an empty submission before calling the SDK (blocking)", async () => {',
        `    const result = await run${names.pascal}Blocking({});`,
        '    expect(result).toMatchObject({ ok: false, error: { kind: "bad_request" } });',
        "    expect(execute).not.toHaveBeenCalled();",
        "  });",
        "",
        '  it("refuses an empty submission before calling the SDK (durable)", async () => {',
        `    const result = await start${names.pascal}Run({});`,
        '    expect(result).toMatchObject({ ok: false, error: { kind: "bad_request" } });',
        "    expect(start).not.toHaveBeenCalled();",
        "  });",
      ]
    : [
        "  // This pipe gates on nothing, so an empty submission is a legitimate run and",
        "  // what is worth pinning is the wiring: the method and the qualified pipe ref.",
        `  it(${JSON.stringify(
          source.kind === "files"
            ? "sends the bundle and the qualified pipe ref to the SDK"
            : "sends the selector and the qualified pipe ref to the SDK",
        )}, async () => {`,
        ...(hasFiles
          ? ["    prepareInputs.mockResolvedValueOnce({ inputs: {}, uploads: [] });"]
          : []),
        '    execute.mockResolvedValueOnce({ pipeline_run_id: "run-1", main_stuff: {}, pipe_output: {} });',
        `    await run${names.pascal}Blocking({});`,
        "    expect(execute).toHaveBeenCalledWith({",
        methodField,
        `      pipe_code: ${JSON.stringify(pipe.ref)},`,
        "      inputs: {},",
        "    });",
        "  });",
      ];

  // A file is stored before any run, through a grant this action asks for, so
  // the grant action is a trust boundary of its own: a type the method does not
  // take is refused before the platform is asked for anything.
  const upload = hasFiles
    ? [
        "",
        '  it("refuses to grant an upload of a type the method does not take", async () => {',
        `    const result = await request${names.pascal}Upload({`,
        '      filename: "notes.txt",',
        '      content_type: "text/plain",',
        "      size: 12,",
        "    });",
        '    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported_file_type" } });',
        "    expect(requestUploadGrant).not.toHaveBeenCalled();",
        "  });",
      ]
    : [];

  return [...head, ...body, ...upload, "});", ""].join("\n");
}

/**
 * `src/components/<Pascal>Form.tsx` — the one kernel composition, plus the run
 * chrome every method shares.
 *
 * Nothing about the method's IO is written by hand, on either side: the input
 * fields come from its committed input-form descriptor through `useRunInputs`
 * and are rendered by `<RunInputsForm>`, and the result comes from its
 * output-form descriptor paired with the payload schema and is rendered by
 * `<RunResult>`. A result component used to be the one thing the scaffold could
 * not project — it would have been inventing headings for fields it had never
 * seen — and the descriptor is what removed that gap.
 */
export function renderForm(plan: ScaffoldPlan): string {
  const { names, pipe, files } = plan;
  const hasFiles = files.length > 0;
  // While a file is being uploaded its value is unset, and `ready` only speaks
  // for the inputs the gate refuses empty — so a form holding an optional or
  // non-gating file input must wait for the upload, or it runs without it.
  const busy = hasFiles ? "running || uploadingIds.size > 0" : "running";

  const imports = [
    '"use client";',
    "",
    "import {",
    `  poll${names.pascal}Run,`,
    ...(hasFiles ? [`  request${names.pascal}Upload,`] : []),
    `  run${names.pascal}Blocking,`,
    `  start${names.pascal}Run,`,
    `} from "@/actions/run${names.pascal}Pipeline";`,
    'import { EXECUTION_MODE } from "@/config";',
    `import { INPUT_FORM, OUTPUT_FORM, PIPE_IO_CONTRACTS } from "@/generated/${names.slug}/contracts";`,
    ...(hasFiles ? ['import { useFileInputs } from "@/hooks/useFileInputs";'] : []),
    'import { useRun } from "@/hooks/useRun";',
    'import { useRunInputs } from "@/hooks/useRunInputs";',
    'import { requireResultField } from "@/lib/resultField";',
    'import { requireContract, requireInputForm } from "@/lib/runInputs";',
    ...(hasFiles ? ['import { resolveStoredFile } from "@/lib/storageAsset";'] : []),
    ...(hasFiles ? [`import { ALLOWED_MIMES } from "@/types/${names.camel}Uploads";`] : []),
    'import { ErrorDisplay } from "./ErrorDisplay";',
    'import { RunDetails } from "./RunDetails";',
    'import { RunInputsForm } from "./RunInputsForm";',
    'import { RunResult } from "./RunResult";',
    'import { RunStatus } from "./RunStatus";',
    "",
    "// Scaffolded by `make add-method` — yours to edit from here on.",
    "//",
    "// Both halves are derived from the method's own contract, committed by",
    "// `npm run codegen`: the form from the input-form descriptor, the result view",
    "// from the output-form descriptor paired with the payload schema. There is",
    "// nothing hand-written to keep in step — change what the method takes or",
    "// produces, regenerate, and both follow.",
    `const CONTRACT = requireContract(PIPE_IO_CONTRACTS, ${JSON.stringify(pipe.domain)}, ${JSON.stringify(pipe.code)});`,
    `const DESCRIPTOR = requireInputForm(INPUT_FORM, ${JSON.stringify(pipe.domain)}, ${JSON.stringify(pipe.code)});`,
    `const RESULT_FIELD = requireResultField(OUTPUT_FORM, CONTRACT, ${JSON.stringify(pipe.domain)}, ${JSON.stringify(pipe.code)});`,
    "",
    `export function ${names.pascal}Form() {`,
    ...(hasFiles
      ? [
          "  // Each file input is narrowed to the media types the upload action grants,",
          "  // so the dropzone never offers a file the action would refuse.",
          "  const { fields, values, setValues, ready, toData } = useRunInputs(CONTRACT, DESCRIPTOR, {",
          "    allowedMimes: ALLOWED_MIMES,",
          "  });",
        ]
      : [
          "  const { fields, values, setValues, ready, toData } = useRunInputs(CONTRACT, DESCRIPTOR);",
        ]),
    "  // `useRun` presents one state machine and dispatches to the blocking or",
    "  // durable Server Actions by `mode`, which is the deployment's choice",
    "  // (`NEXT_PUBLIC_EXECUTION_MODE`). The form never branches on mode itself.",
    `  const { state, run${hasFiles ? ", reset" : ""} } = useRun({`,
    "    mode: EXECUTION_MODE,",
    `    blocking: run${names.pascal}Blocking,`,
    `    start: start${names.pascal}Run,`,
    `    poll: poll${names.pascal}Run,`,
    "  });",
    "",
  ];

  if (hasFiles) {
    imports.push(
      "  // The host side of the form kernel's file seam — the upload straight from the",
      "  // browser to Pipelex storage, the busy set the kernel reads as `uploadingIds`,",
      "  // the clear-before-await discipline. The kernel never uploads: it hands the",
      "  // host a `File` and waits for a `FileValue` back, here a stored reference.",
      "  const { dropFile, uploadingIds, fileError, clearError } = useFileInputs({",
      "    setValues,",
      `    requestUpload: request${names.pascal}Upload,`,
      "    onSelectionStart: reset,",
      "  });",
      "",
    );
  }

  imports.push('  const running = state.phase === "running";', "");

  const submit = [
    "  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {",
    "    event.preventDefault();",
    ...(hasFiles ? ["    if (uploadingIds.size > 0) return;", "    clearError();"] : []),
    "    // The action gates the same contract server-side, applying the kernel's",
    "    // rules in full — that is the trust boundary; `ready` below is only UX.",
    "    run(toData());",
    "  }",
    "",
  ];

  const formProps = hasFiles
    ? [
        "        <RunInputsForm",
        "          fields={fields}",
        "          values={values}",
        "          onValuesChange={(next) => {",
        "            // A rejection belongs to the value that caused it: the kernel's",
        '            // "paste a URL instead" writes straight through this setter.',
        "            clearError();",
        "            setValues(next);",
        "          }}",
        "          disabled={running}",
        "          env={{ onDropFile: dropFile, uploadingIds, resolveUrl: resolveStoredFile }}",
        "        />",
      ]
    : [
        "        <RunInputsForm",
        "          fields={fields}",
        "          values={values}",
        "          onValuesChange={setValues}",
        "          disabled={running}",
        "        />",
      ];

  const jsx = [
    "  return (",
    '    <div className="space-y-6">',
    '      <form onSubmit={handleSubmit} className="space-y-4">',
    ...formProps,
    "        <button",
    '          type="submit"',
    `          disabled={${busy} || !ready}`,
    '          className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"',
    "        >",
    `          {running ? "Running…" : ${JSON.stringify(`Run ${inSentence(names.label)}`)}}`,
    "        </button>",
    "      </form>",
    "",
    "      {running && (",
    "        <RunStatus",
    "          status={state.status}",
    "          elapsedMs={state.elapsedMs}",
    "          health={state.health}",
    "          runId={state.runId}",
    "        />",
    "      )}",
    ...(hasFiles
      ? [
          "      {fileError && <ErrorDisplay error={fileError} />}",
          '      {!fileError && state.phase === "error" && (',
          "        <ErrorDisplay error={state.error} runId={state.runId} />",
          "      )}",
        ]
      : [
          '      {state.phase === "error" && (',
          "        <ErrorDisplay error={state.error} runId={state.runId} />",
          "      )}",
        ]),
    '      {state.phase === "done" && (',
    "        <>",
    "          {/* The result, rendered from the method's own output contract — the",
    "              scaffold has no design decision to make about a shape it has never",
    "              seen, because there is none left to make. Swap it for a component",
    "              of your own if this output deserves a bespoke view; the value is",
    "              already typed by the narrower, and docs/result-view.md says how. */}",
    `          <RunResult field={RESULT_FIELD} value={state.output} name=${JSON.stringify(names.slug.replace(/-/g, "_"))} />`,
    "          {/* The run's id, which a user quotes, and what it cost, folded away for",
    "              whoever built the app. */}",
    "          <RunDetails runId={state.runId} usage={state.usage} />",
    "        </>",
    "      )}",
    "    </div>",
    "  );",
    "}",
    "",
  ];

  return [...imports, ...submit, ...jsx].join("\n");
}

// ── The orchestration ───────────────────────────────────────────────────────

/** The client surface the gesture needs — the two crate routes, the handshake, the catalog. */
export type AddMethodClient = Pick<
  PipelexApiClient,
  "codegen" | "validate" | "validateFiles" | "version" | "getMethod"
>;

/** What the tests swap out: the tree the gesture writes into, and the API it talks to. */
export interface AddMethodDeps {
  repoRoot: string;
  client: AddMethodClient;
  baseUrl: string;
  /** Where a relative bundle path is resolved from. Defaults to `repoRoot`. */
  cwd?: string;
}

/** The parsed command line. */
export interface AddMethodArgs {
  method: string;
  pipe?: string;
  name?: string;
  label?: string;
  dryRun: boolean;
}

const USAGE =
  "usage: npm run add-method -- <path/to/bundle | mt_… | github.com/owner/repo[/package][@tag]> " +
  "[--pipe <pipe_code>] [--name <dir-name>] [--label <label>] [--dry-run]";

/**
 * Parse the command line, refusing an unknown flag and a swallowed value.
 *
 * A value starting with `--` almost certainly means the real one was dropped
 * and the next flag is about to be eaten — `--label --dry-run` turning a
 * rehearsal into a real run is exactly the accident worth failing loudly on.
 */
export function parseArgs(argv: readonly string[]): AddMethodArgs {
  const FLAGS: Record<string, "pipe" | "name" | "label"> = {
    "--pipe": "pipe",
    "--name": "name",
    "--label": "label",
  };
  const parsed: Partial<AddMethodArgs> = {};
  let dryRun = false;
  let method: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg in FLAGS) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new AddMethodError(`missing value for ${arg}.\n  ${USAGE}`);
      }
      parsed[FLAGS[arg]!] = value;
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new AddMethodError(`unknown argument ${JSON.stringify(arg)}.\n  ${USAGE}`);
    } else if (method === undefined) {
      method = arg;
    } else {
      throw new AddMethodError(
        `unexpected second method ${JSON.stringify(arg)} — the gesture scaffolds one.\n  ${USAGE}`,
      );
    }
  }

  if (method === undefined) throw new AddMethodError(`no method given.\n  ${USAGE}`);
  return { method, pipe: parsed.pipe, name: parsed.name, label: parsed.label, dryRun };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format an emitted source through this repo's own Prettier config.
 *
 * Not a nicety: the emitted files land under `src/`, which `make check` runs
 * `prettier --check` over, so a slice whose method name happened to push one
 * line past the print width would fail the very first `make all` after being
 * scaffolded. Letting the formatter decide removes a whole class of that. If
 * Prettier cannot be loaded the content is written as-is and the caller is told;
 * a Prettier that loads and then throws is a broken template, and it propagates
 * — from the read-only half, before anything is written.
 */
async function formatEmitted(filePath: string, content: string): Promise<string> {
  let prettier: typeof import("prettier");
  try {
    prettier = await import("prettier");
  } catch {
    console.error(
      "add-method: prettier is not installed — writing unformatted; run `make format`.",
    );
    return content;
  }
  const options = await prettier.resolveConfig(filePath);
  return prettier.format(content, { ...options, filepath: filePath });
}

/** One file the gesture is about to write: where it goes and what goes in it. */
export interface EmittedFile {
  /** Repo-relative, forward slashes. */
  relative: string;
  content: string;
}

/** What the catalog says about a stored method. */
export interface CatalogEntry {
  name: string;
  description: string | null;
}

/**
 * Everything the write half needs, and everything a caller reads to name an
 * app after the method — computed by `planAddMethod` with nothing written.
 */
export interface AddMethodPlan {
  names: ScaffoldNames;
  paths: ScaffoldPaths;
  scaffold: ScaffoldPlan;
  contract: PipeIOContract;
  fetched: FetchedMethod;
  /** The source `writeGenerated` records in the sidecar: labels and hashes at their final paths. */
  methodSource: MethodSource;
  /** Files written under `methods/<name>/` — the manifest, or the copied bundle. Empty in place. */
  methodFiles: EmittedFile[];
  /** The bundle already sits in `methods/<name>/`, so that directory is not the gesture's to create. */
  inPlace: boolean;
  /** The app files, formatted, then the registry. */
  emitted: EmittedFile[];
  /** `src/methods.ts` as it was read, so the write half can tell whether it moved. */
  registryBefore: string;
  /** The stored method's catalog entry, for an id. */
  catalog: CatalogEntry | null;
  /** One line naming what was added: the selector, or the bundle and its size. */
  describe: string;
  warnings: string[];
  baseUrl: string;
}

export interface PlanOptions {
  /**
   * The flag a refusal tells the person to pass when no usable name can be
   * derived. A caller that spends `--name` on something else names its own.
   */
  nameFlag?: string;
}

/**
 * The read-only half: every fetch, every derivation, every refusal, and every
 * file rendered and formatted in memory. Throws `AddMethodError` for a refusal
 * and `ReportedFailure` for one `fetchGenerated` has already printed; returns a
 * plan the write half can carry out without deciding anything.
 */
export async function planAddMethod(
  args: AddMethodArgs,
  deps: AddMethodDeps,
  options: PlanOptions = {},
): Promise<AddMethodPlan> {
  const nameFlag = options.nameFlag ?? "--name";
  const { repoRoot, client, baseUrl } = deps;
  const inRepo = (relative: string): string => path.join(repoRoot, relative);

  // Refused before anything is fetched: a name that cannot be a directory and
  // a TypeScript identifier is wrong whatever the method turns out to be.
  if (args.name !== undefined && !isSlug(args.name)) {
    throw new AddMethodError(
      `${nameFlag} "${args.name}" is not kebab-case starting with a letter ` +
        "(a-z first, then a-z, 0-9 and single dashes).",
    );
  }

  // The codegen scripts refuse a symlinked `methods/` or `src/generated/`, and
  // the write half writes into both: refused here, before anything is fetched,
  // rather than written through and refused by `make check` afterwards.
  for (const root of ["methods", path.join("src", "generated")]) {
    try {
      await refuseSymlinkRoot(inRepo(root));
    } catch (error) {
      if (error instanceof SymlinkRefusedError) throw new AddMethodError(error.message);
      throw error;
    }
  }

  const arg = parseMethodArg(args.method, (value) =>
    existsSync(path.resolve(deps.cwd ?? repoRoot, expandHome(value))),
  );
  let catalog: CatalogEntry | null = null;
  let methodFiles: EmittedFile[];
  let fetched: FetchedMethod | null;
  let names: ScaffoldNames;
  /** Whether the label came from `--label` or a catalog name, rather than the slug. */
  let labelChosen = false;
  let paths: ScaffoldPaths;
  let methodSource: MethodSource;
  let scaffoldSource: ScaffoldSource;
  let describe: string;
  let inPlace = false;
  let pipe: ChosenPipe | null = null;
  const warnings: string[] = [];

  if (arg.kind === "selector") {
    const { selector } = arg;
    const unsupported = await assertSelectorSupport(
      client,
      baseUrl,
      new Set([selectorKind(selector)]),
    );
    if (unsupported !== null) throw new AddMethodError(unsupported);

    // A stored method's catalog name is both the slug's source and the default
    // label — a person chose it. A published address has no such name.
    if (selectorKind(selector) === "method_id") {
      let method;
      try {
        method = await client.getMethod(selector.method_id!);
      } catch (error) {
        const explained = explainSelectorFailure(error, selector);
        if (explained !== null) throw new AddMethodError(explained);
        throw error;
      }
      catalog = { name: method.name, description: method.description ?? null };
      warnings.push(
        "a method_id is scoped to your key's organization, so `npm run codegen` on this " +
          "slice needs a key of that same org. A published address (method_ref) is the " +
          "portable form.",
      );
    }

    const slug = args.name ?? kebabCase(slugSource(selector, catalog?.name, nameFlag), nameFlag);
    const chosenLabel = args.label ?? catalog?.name;
    labelChosen = (chosenLabel?.trim() ?? "") !== "";
    names = scaffoldNames(slug, chosenLabel);
    paths = scaffoldPaths(names);
    await refuseCollisions(inRepo, paths, { inPlace: false, nameFlag });

    const manifest = renderManifest(selector);
    methodFiles = [{ relative: paths.manifest, content: manifest }];
    methodSource = {
      name: names.slug,
      kind: "selector",
      selector,
      sourceHashes: { [paths.manifest]: hashSource(manifest) },
    };
    scaffoldSource = { kind: "selector", selector };
    describe = describeSelector(selector);

    // The same fetch-and-guard half `npm run codegen` runs, so a scaffolded
    // tree is the tree a regeneration would write — and every codegen refusal
    // (an unresolvable selector, an escaping artifact path, a missing view)
    // happens here, having written nothing.
    fetched = await fetchGenerated(client, methodSource, inRepo(paths.generatedDir), baseUrl);
  } else {
    const bundle = await readBundle(arg.path, deps.cwd ?? repoRoot, repoRoot);
    if (bundle.inPlace !== null) {
      if (!isSlug(bundle.inPlace)) {
        throw new AddMethodError(
          `methods/${bundle.inPlace}/ is not a name the scaffold can build identifiers from — ` +
            "rename the directory to kebab-case starting with a letter.",
        );
      }
      if (args.name !== undefined && args.name !== bundle.inPlace) {
        throw new AddMethodError(
          `${nameFlag} "${args.name}" disagrees with the directory the bundle sits in, ` +
            `methods/${bundle.inPlace}/. A bundle in methods/ is named by its directory — ` +
            `drop ${nameFlag}, or rename the directory.`,
        );
      }
    }

    // The files are sent under the labels they were read by, so a diagnostic
    // names the file the person pointed at. The label does not reach the
    // artifacts: the crate is the same whatever the files are called.
    const pending: MethodSource = {
      name: bundle.inPlace ?? bundle.display,
      kind: "files",
      files: bundle.files.map((file) => ({ content: file.content, source: file.label })),
      sourceHashes: {},
    };
    // The tree's directory is not known until the pipe is, and only the
    // containment test reads it — which asks the same question of any directory.
    const provisionalOut = inRepo(`src/generated/${bundle.inPlace ?? "_"}`);
    fetched = await fetchGenerated(client, pending, provisionalOut, baseUrl);
    if (fetched === null) throw new ReportedFailure();

    // A bundle's slug is the domain of the pipe it runs, so the pipe comes first.
    pipe = choosePipe(
      fetched.contracts.pipeIoContracts,
      fetched.contracts.defaultPipeRef,
      args.pipe,
    );
    const slug = bundle.inPlace ?? args.name ?? kebabCase(pipe.domain, nameFlag);
    labelChosen = (args.label?.trim() ?? "") !== "";
    names = scaffoldNames(slug, args.label);
    paths = scaffoldPaths(names);
    inPlace = bundle.inPlace !== null;
    await refuseCollisions(inRepo, paths, { inPlace, nameFlag });

    const placed = bundle.files.map((file) => ({
      relative: `${paths.methodDir}/${file.relative}`,
      content: file.content,
    }));
    methodFiles = inPlace ? [] : placed;
    methodSource = {
      name: names.slug,
      kind: "files",
      files: placed.map((file) => ({ content: file.content, source: file.relative })),
      sourceHashes: Object.fromEntries(
        placed.map((file) => [file.relative, hashSource(file.content)]),
      ),
    };
    scaffoldSource = { kind: "files" };
    const count = `${bundle.files.length} .mthds file${bundle.files.length === 1 ? "" : "s"}`;
    describe = inPlace
      ? `bundle ${bundle.display} (${count}, in place)`
      : `bundle ${bundle.display} (${count}, copied to ${paths.methodDir}/)`;
  }

  if (fetched === null) throw new ReportedFailure();

  // An acronym the method spells keeps its capitals, and only a DERIVED label
  // is touched: a label somebody passed, or a catalog name somebody chose, is
  // already the spelling they wanted. Which one it is, is RECORDED rather than
  // read back off the value - `--label "Cv screening"` on a `cv-screening`
  // method is a chosen label that equals the derived one, and respelling it
  // would break the promise this reads.
  if (!labelChosen) {
    names = {
      ...names,
      label: respellAcronyms(names.label, methodVocabulary(fetched.contracts.prose)),
    };
  }

  pipe ??= choosePipe(
    fetched.contracts.pipeIoContracts,
    fetched.contracts.defaultPipeRef,
    args.pipe,
  );
  const contract = contractFor(fetched.contracts.pipeIoContracts, pipe);
  const descriptor = descriptorFor(fetched.contracts.inputForm, pipe);
  const scaffold: ScaffoldPlan = {
    names,
    source: scaffoldSource,
    pipe,
    binding: bindOutput(contract, fetched.report.artifacts),
    files: fileInputsOf(descriptor),
    gating: hasGatingInput(descriptor),
  };

  const registryBefore = await readFile(inRepo(paths.registry), "utf-8");
  const registryAfter = registerMethod(
    registryBefore,
    { id: names.slug, label: names.label, componentName: `${names.pascal}Form` },
    nameFlag,
  );

  // Formatted here, not in the write half: a formatter that throws must do so
  // while nothing has been written.
  const emitted: EmittedFile[] = [];
  for (const [relative, content] of [
    [paths.adapter, renderAdapter(scaffold)],
    ...(scaffold.files.length > 0 ? ([[paths.uploads, renderUploads(scaffold)]] as const) : []),
    [paths.action, renderAction(scaffold)],
    [paths.actionTest, renderActionTest(scaffold)],
    [paths.form, renderForm(scaffold)],
    [paths.registry, registryAfter],
  ] as const) {
    emitted.push({ relative, content: await formatEmitted(inRepo(relative), content) });
  }

  return {
    names,
    paths,
    scaffold,
    contract,
    fetched,
    methodSource,
    methodFiles,
    inPlace,
    emitted,
    registryBefore,
    catalog,
    describe,
    warnings,
    baseUrl,
  };
}

/**
 * Refuse a slice that would land on anything already there.
 *
 * A bundle scaffolded in place owns its method directory already, and may have
 * been through `npm run codegen` by hand: its generated tree is purely derived,
 * so it is regenerated rather than refused. Everything else is one-shot.
 */
async function refuseCollisions(
  inRepo: (relative: string) => string,
  paths: ScaffoldPaths,
  { inPlace, nameFlag }: { inPlace: boolean; nameFlag: string },
): Promise<void> {
  const guarded = [
    ...(inPlace ? [] : [paths.methodDir, paths.generatedDir]),
    paths.adapter,
    paths.uploads,
    paths.action,
    paths.actionTest,
    paths.form,
  ];
  for (const relative of guarded) {
    if (await exists(inRepo(relative))) {
      throw new AddMethodError(
        `${relative} already exists — the gesture is one-shot and never overwrites.\n` +
          "  To refresh a slice that is already here, edit its method and run\n" +
          '  `npm run codegen`. To start over, remove the slice first (see "Removing a\n' +
          `  method" in docs/add-method.md), or pass ${nameFlag} to scaffold beside it.`,
      );
    }
  }
}

/** Print what the plan will do — the same lines whether or not it is a rehearsal. */
export function printPlan(plan: AddMethodPlan): void {
  const { scaffold, contract, names } = plan;
  console.log(`add-method: ${plan.describe}, via ${plan.baseUrl}`);
  console.log(`  pipe:   ${scaffold.pipe.ref}`);
  console.log(
    `  output: ${contract.output.concept_ref}` +
      `${scaffold.binding.plural ? " (plural — a list of the concept)" : ""}`,
  );
  if (scaffold.files.length > 0) {
    console.log(`  files:  ${scaffold.files.map((file) => file.path).join(", ")}`);
  }
  console.log(`  entry:  ${JSON.stringify(names.label)} (id ${names.slug})`);
}

/** Every path the write half touches, in the order it writes them, for the report. */
function plannedPaths(plan: AddMethodPlan): string[] {
  const { paths } = plan;
  return [
    ...plan.methodFiles.map((file) => file.relative),
    `${paths.generatedDir}/  (types.ts, binder.ts, contracts.ts, codegen.lock, sources.json)`,
    ...plan.emitted.map(
      (file) =>
        `${file.relative}${file.relative === paths.registry ? "  (one import, one entry)" : ""}`,
    ),
  ];
}

/** The app's write lock, at its root and ignored by git. */
export const WRITE_LOCK_FILENAME = ".add-method.lock";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it is only someone else's.
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/**
 * Hold the app's write lock while `body` runs, its rollback included.
 *
 * Two runs writing into one checkout at once can undo each other: a run whose
 * own `mkdir` made a generated tree removes that tree when it fails, even after
 * a second run has rewritten it and finished. So the write half runs under a
 * lock file created exclusively, holding its owner's pid, and a second run is
 * refused before it writes anything. The lock is removed only by the run that
 * made it. One left behind by a run that was killed is never broken on its own
 * — two runs breaking it at once would each believe they held it — so the
 * refusal says whether its owner is still running and names the file. A lock
 * with no pid in it yet, or already gone, is one being taken or released.
 */
async function withWriteLock<T>(repoRoot: string, body: () => Promise<T>): Promise<T> {
  const lockPath = path.join(repoRoot, WRITE_LOCK_FILENAME);
  const stamp = `${process.pid}\n${randomUUID()}\n`;
  try {
    await writeFile(lockPath, stamp, { encoding: "utf-8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
    // Empty or gone: the file is created before its stamp is written, and
    // removed when its run ends, so another run is taking or releasing it.
    const held = await readFile(lockPath, "utf-8").catch(() => "");
    const pid = Number(held.split("\n")[0]);
    if (!(Number.isSafeInteger(pid) && pid > 0)) {
      throw new AddMethodError(
        `another \`make add-method\` is taking or releasing ${WRITE_LOCK_FILENAME}. Nothing ` +
          "was written: run again in a moment, and if it is refused the same way while no " +
          `other run is going on, remove ${WRITE_LOCK_FILENAME}.`,
      );
    }
    // A live pid may be a reused one, so this refusal names the file too.
    if (isRunning(pid)) {
      throw new AddMethodError(
        `another \`make add-method\` (pid ${pid}) is writing in this app. Nothing was ` +
          `written: run again once it has finished. If pid ${pid} is not a ` +
          `\`make add-method\` run, a run that was stopped left ${WRITE_LOCK_FILENAME} behind ` +
          "and its pid has been reused: remove the file and run again.",
      );
    }
    throw new AddMethodError(
      `${WRITE_LOCK_FILENAME} is held by pid ${pid}, which is no longer running, so a run ` +
        "was stopped before it could remove it. Nothing was written: if no other " +
        `\`make add-method\` is running, remove ${WRITE_LOCK_FILENAME} and run again.`,
    );
  }
  try {
    return await body();
  } finally {
    if ((await readFile(lockPath, "utf-8").catch(() => "")) === stamp) {
      await rm(lockPath, { force: true });
    }
  }
}

/**
 * The write half. Writes the method directory, the generated tree, the app
 * files and the registry edit, in that order — and on any failure removes what
 * it created and restores the registry, then rethrows as a refusal saying so.
 * What existed before the gesture (a bundle scaffolded in place, its
 * regenerated tree) is left where it was, and the refusal says which. All of
 * it, the rollback included, runs under the app's write lock.
 *
 * "Created" is taken literally: a directory is recorded only when this run's
 * own `mkdir` made it, and removed only once it is empty again, so a file
 * another run put there meanwhile survives the rollback. The one directory
 * removed with its contents is a generated tree this run made, whose files
 * `writeGenerated` writes without naming them here; the lock is what keeps
 * another run from writing into it meanwhile.
 */
export async function writeAddMethod(plan: AddMethodPlan, deps: AddMethodDeps): Promise<void> {
  await withWriteLock(deps.repoRoot, () => writeSlice(plan, deps));
}

async function writeSlice(plan: AddMethodPlan, deps: AddMethodDeps): Promise<void> {
  const inRepo = (relative: string): string => path.join(deps.repoRoot, relative);
  const { paths } = plan;
  const created: { target: string; kind: "file" | "dir" | "tree" }[] = [];
  let registryWritten = false;
  // An in-place bundle's tree may already exist: the run rewrites it rather
  // than creating it, so the rollback cannot take it back, only report it.
  let rewriting = false;
  let regenerated = false;

  // `mkdir` names the outermost directory it made, so everything from there
  // down to `dir` is this run's, and nothing above it is.
  const makeDir = async (dir: string, kind: "dir" | "tree" = "dir"): Promise<void> => {
    const first = await mkdir(dir, { recursive: true });
    if (first === undefined) return;
    const chain: string[] = [];
    for (let current = dir; ; current = path.dirname(current)) {
      chain.unshift(current);
      if (current === first || current === path.dirname(current)) break;
    }
    for (const target of chain) created.push({ target, kind: target === dir ? kind : "dir" });
  };

  // Create-only: a file that appeared since the plan is refused, never
  // replaced — and, never having been this run's, never removed either.
  const writeNew = async (relative: string, content: string): Promise<void> => {
    const target = inRepo(relative);
    await makeDir(path.dirname(target));
    try {
      await writeFile(target, content, { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        await rm(target, { force: true });
      }
      throw error;
    }
    created.push({ target, kind: "file" });
  };

  try {
    if (!plan.inPlace) {
      await makeDir(inRepo(paths.methodDir));
      for (const file of plan.methodFiles) await writeNew(file.relative, file.content);
    }

    const outDir = inRepo(paths.generatedDir);
    const recorded = created.length;
    await makeDir(outDir, "tree");
    if (created.length === recorded) {
      if (!plan.inPlace) {
        throw new AddMethodError(
          `${paths.generatedDir}/ appeared after the plan was made — run the gesture again.`,
        );
      }
      rewriting = true;
    }
    await writeGenerated(outDir, plan.fetched, plan.methodSource);
    regenerated = rewriting;

    for (const file of plan.emitted) {
      if (file.relative !== paths.registry) await writeNew(file.relative, file.content);
    }

    const registry = plan.emitted.find((file) => file.relative === paths.registry)!;
    if ((await readFile(inRepo(paths.registry), "utf-8")) !== plan.registryBefore) {
      throw new AddMethodError(
        `${paths.registry} changed after the plan was made — run the gesture again.`,
      );
    }
    registryWritten = true;
    await writeFile(inRepo(paths.registry), registry.content, "utf-8");
  } catch (error) {
    for (const { target, kind } of created.reverse()) {
      if (kind === "dir") await rmdir(target).catch(() => {});
      else await rm(target, { recursive: kind === "tree", force: true });
    }
    if (registryWritten) await writeFile(inRepo(paths.registry), plan.registryBefore, "utf-8");
    const reason = error instanceof Error ? error.message : String(error);
    const kept = regenerated
      ? ` — except ${paths.generatedDir}/, which existed before and was regenerated in place; ` +
        "it is kept, exactly as `npm run codegen` writes it for these sources"
      : rewriting
        ? ` — except ${paths.generatedDir}/, which existed before and may be partly rewritten; ` +
          "`npm run codegen` regenerates it whole"
        : "";
    throw new AddMethodError(
      `writing the slice failed, and everything this run had created was removed${kept}: ${reason}`,
    );
  }
}

/**
 * The whole `make add-method` behavior, exit code included.
 *
 * `deps` is what the tests replace; omitted, it loads `.env.local`, checks the
 * base URL and the key, and constructs the same client `npm run codegen` uses.
 * Never throws: a refusal is a printed line and exit 1.
 */
export async function runAddMethod(argv: readonly string[], deps?: AddMethodDeps): Promise<number> {
  try {
    return await runAddMethodInner(argv, deps);
  } catch (error) {
    if (error instanceof ReportedFailure) return EXIT_FAILED;
    if (error instanceof AddMethodError) {
      console.error(`add-method: ${error.message}`);
      return EXIT_FAILED;
    }
    console.error(`add-method: ${error instanceof Error ? error.stack : String(error)}`);
    return EXIT_FAILED;
  }
}

/**
 * The deps a real run uses: `.env.local` loaded, the base URL and the key
 * checked, and the same client `npm run codegen` constructs. A relative bundle
 * path is resolved from the directory the command was typed in — `npm run`
 * moves to the package root and records the original as `INIT_CWD`.
 */
export function resolveDeps(repoRoot: string = REPO_ROOT): AddMethodDeps {
  loadEnvConfig(repoRoot, false, { info: () => {}, error: console.error });
  const baseUrl = process.env.PIPELEX_BASE_URL ?? DEFAULT_API_BASE_URL;
  try {
    assertSecureBaseUrl(baseUrl);
  } catch (error) {
    throw new AddMethodError(error instanceof Error ? error.message : String(error));
  }
  if (!process.env.PIPELEX_API_KEY) {
    throw new AddMethodError("PIPELEX_API_KEY is not set — add it to .env.local.");
  }
  // Constructed bare, exactly as `generate.mts` does: the `@/` alias is a
  // tsconfig path mapping Node's resolver never reads, and the client picks up
  // the same environment natively, so this IS the same client.
  return {
    repoRoot,
    client: new PipelexApiClient(),
    baseUrl,
    cwd: process.env.INIT_CWD ?? process.cwd(),
  };
}

async function runAddMethodInner(argv: readonly string[], deps?: AddMethodDeps): Promise<number> {
  const args = parseArgs(argv);
  const resolved = deps ?? resolveDeps();
  const plan = await planAddMethod(args, resolved);
  printPlan(plan);

  if (args.dryRun) {
    console.log("\nWould write:");
    for (const line of plannedPaths(plan)) console.log(`  ${line}`);
    for (const warning of plan.warnings) console.log(`\n! ${warning}`);
    console.log("\nNothing was written (--dry-run).");
    return EXIT_OK;
  }

  await writeAddMethod(plan, resolved);

  console.log("\nWrote:");
  for (const line of plannedPaths(plan)) console.log(`  ${line}`);
  for (const warning of plan.warnings) console.log(`\n! ${warning}`);
  console.log(
    [
      "",
      "Next:",
      "  1. `make all` — the slice compiles, lints and tests with the rest of the app.",
      `  2. \`make dev\` and run it. The form and the result view both come from the`,
      `     method's contract; ${plan.paths.form} is where you replace either with your own.`,
    ].join("\n"),
  );
  return EXIT_OK;
}
