/**
 * Regenerate the committed typed artifacts for every method in `methods/`.
 *
 * One generated tree per method, mirroring `methods/` one-to-one: each method is
 * its own closure, so each gets its own crate, artifact set, and lock. The tree
 * is written **verbatim** — every `artifacts[]` entry at its `path`, the `lock`
 * as `lock_filename` — because that byte-for-byte fidelity is what makes the
 * tree identical to a local `pipelex codegen types` run, and therefore what lets
 * the offline check (`npm run codegen:check`) pass on it. Reformatting an
 * artifact or re-serializing the lock breaks that trust chain.
 *
 * This is the dev action: it needs an API key and a base URL that serves
 * `/v1/codegen` and `/v1/pipe-io`. The check that guards CI is offline and needs
 * neither.
 *
 * `runGenerate` owns the whole contract, exit code included, so the CLI entry
 * (`scripts/codegen.mts`) stays a one-liner and `writeTree` — the only code in
 * this repo that deletes files — is importable and tested.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// `@next/env` is CommonJS, so a native-ESM script must take the default export
// and destructure. (`playwright.config.ts` gets away with a named import only
// because Playwright transpiles its config to CJS first.)
import nextEnv from "@next/env";
import {
  ApiResponseError,
  DEFAULT_API_BASE_URL,
  PipelexApiClient,
  runCodegenCheck,
  type CodegenRequest,
  type CodegenValidReport,
  type GeneratedArtifact,
  type InputForm,
  type MthdsFileItem,
  type OutputForm,
  type PipeIOContracts,
} from "@pipelex/sdk";
import { parse as parseToml } from "smol-toml";

import { assertSelectorSupport, explainSelectorFailure, selectorKindsOf } from "./api.mts";
import {
  assertSecureBaseUrl,
  CONTRACTS_FILENAME,
  DERIVED_ARTIFACTS,
  discoverMethods,
  hashSource,
  isContainedPath,
  ManifestError,
  refuseSymlinkRoot,
  GENERATED_ROOT,
  LOCK_FILENAME,
  METHODS_DIR,
  readGeneratedTree,
  renderContracts,
  REPO_ROOT,
  SIDECAR_COMMENT,
  SOURCES_SIDECAR,
  notRunnableReason,
  pipeIoRequest,
  type MethodSource,
  type SourcesSidecar,
  walk,
} from "./shared.mts";

const { loadEnvConfig } = nextEnv;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/**
 * Write `content` at `filePath` only if the bytes differ.
 *
 * Mirrors pipelex's own `write_stamped_projection` discipline: no mtime churn,
 * clean diffs, and a regeneration over an already-current tree is a true no-op.
 */
async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  let existing: string | null = null;
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    existing = null;
  }
  if (existing === content) return false;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf-8");
  return true;
}

/**
 * Write one method's artifact set, its lock, the app-emitted artifacts, and
 * its sources sidecar.
 *
 * Stale artifacts that dropped out of the set are removed, and the authority on
 * what may be removed is `runCodegenCheck`'s own `orphan` verdict over the tree
 * we just wrote — not a filename test. That distinction is load-bearing. A
 * suffix test (`isStampableArtifactPath`) answers "could this file type be an
 * artifact"; the SDK's orphan rule additionally requires the file to *carry a
 * codegen stamp*. Deleting on the weaker test destroys any hand-written `.ts`
 * a consumer parks in the tree — including the "sibling module" the generated
 * header itself recommends for declaration merging — while the offline check,
 * which uses the stronger rule, reports that same file as perfectly healthy.
 * Deferring to the check here is what makes the writer and the checker agree by
 * construction, the same property the `lock_filename` guard below buys.
 *
 * `derived` (filename → content) carries the artifacts this repo emits itself,
 * `contracts.ts` today. They are written BEFORE the orphan pass, deliberately:
 * the writer and the checker then see the identical tree, so if the SDK's orphan
 * rule ever stopped exempting unstamped files, the writer would delete the file
 * and the failure would be visible here rather than only in a later check.
 */
export async function writeTree(
  outDir: string,
  report: CodegenValidReport,
  sourceHashes: Record<string, string>,
  derived: Record<string, string> = {},
): Promise<string[]> {
  // Vet the whole pre-existing tree — root and nested entries alike — BEFORE
  // the first write. `walk` refuses any symlink or special file, so a write
  // can never be routed through a link into an external target; the post-write
  // readGeneratedTree scan alone would refuse only after the damage was done.
  // An absent tree (first generation) is fine.
  try {
    await walk(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }

  const changed: string[] = [];

  for (const artifact of [
    ...report.artifacts,
    { path: report.lock_filename, content: report.lock },
    ...Object.entries(derived).map(([name, content]) => ({ path: name, content })),
  ]) {
    if (await writeIfChanged(path.join(outDir, artifact.path), artifact.content)) {
      changed.push(artifact.path);
    }
  }

  // Re-read what is now on disk and ask the check which files are orphans against
  // the lock we just wrote. `force: true` because a file vanishing between the
  // read and the unlink is a race, not a failure — and an ENOENT thrown here
  // would abort before the sidecar below is written, leaving a tree the offline
  // check then calls stale.
  const written = await readGeneratedTree(outDir);
  if (written.status === "ok") {
    const { drifts } = await runCodegenCheck({
      lockContent: written.lockContent,
      files: written.files,
    });
    for (const drift of drifts) {
      if (drift.category !== "orphan") continue;
      // The docstring above promises this ordering makes an orphan-rule change
      // visible here. That is only true if someone looks: without this, a
      // deleted `contracts.ts` still gets its hash recorded below (the sidecar
      // is hashed from the content we wrote, not from disk), so regeneration
      // exits 0 on a tree the very next check calls stale.
      if (drift.path in derived) {
        throw new Error(
          `the orphan pass removed '${drift.path}', which this script emits. ` +
            `@pipelex/sdk's orphan rule no longer exempts unstamped files — ` +
            `the derived artifacts need a new home or a stamp.`,
        );
      }
      await rm(path.join(outDir, drift.path), { force: true });
      changed.push(`${drift.path} (removed)`);
    }
  }

  // Hashed from the content we wrote, not re-read from disk: the sidecar records
  // what regeneration produced, and a re-read would launder any interference
  // between the write and the hash into a "current" verdict.
  const derivedHashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(derived)) derivedHashes[name] = hashSource(content);

  const sidecar: SourcesSidecar = {
    comment: SIDECAR_COMMENT,
    sources: sourceHashes,
    derived: derivedHashes,
  };
  const sidecarPath = path.join(outDir, SOURCES_SIDECAR);
  if (await writeIfChanged(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`)) {
    changed.push(SOURCES_SIDECAR);
  }

  return changed;
}

/**
 * Turn a thrown value into an actionable line, naming the fix where we know it.
 *
 * `source` is passed for a selector method so a 404 can be read the right way
 * round: on a files method a 404 means the route is missing, while on a selector
 * method the route answered and the *method* is missing — two failures with
 * nothing in common but their status code. A call made after the selector has
 * already resolved passes it only for a 404 the API typed: an untyped one there
 * is its own route missing.
 */
function explain(
  error: unknown,
  baseUrl: string,
  route = "POST /v1/codegen",
  source?: MethodSource,
): string {
  if (source?.kind === "selector") {
    const selectorFailure = explainSelectorFailure(error, source.selector);
    if (selectorFailure !== null) return selectorFailure;
  }
  if (error instanceof ApiResponseError && (error.status === 403 || error.status === 404)) {
    return [
      `this base URL does not serve ${route} (HTTP ${error.status}).`,
      `  Base URL: ${baseUrl}`,
      "  The hosted Pipelex API serves this route — check PIPELEX_BASE_URL in",
      "  .env.local, or drop it to use the default.",
    ].join("\n");
  }
  if (error instanceof ApiResponseError) {
    return `HTTP ${error.status} from ${route} — ${error.serverMessage ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The files `writeTree` writes itself, which no server artifact may land on. */
const WRITER_OWNED: ReadonlySet<string> = new Set([
  LOCK_FILENAME,
  SOURCES_SIDECAR,
  ...DERIVED_ARTIFACTS,
]);

/**
 * What the method says about itself in prose, read from its own `.mthds` files:
 * the domain's `description` and each pipe's.
 *
 * Written into no artifact. It is there for a caller that describes an app
 * after its method, and a missing value is simply `null`: such a caller has a
 * fallback.
 */
export interface MethodProse {
  /** The domain's own `description`. */
  description: string | null;
  /** Each pipe's `description`, keyed by qualified ref (`domain.pipe_code`). */
  pipeDescriptions: Record<string, string>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Read `MethodProse` out of one parsed `.mthds` file, tolerating any shape: the
 * file is the method author's, so every field is checked rather than assumed.
 */
export function readMethodProse(blueprint: unknown): MethodProse {
  const fields = asRecord(blueprint);
  const domain = nonEmptyString(fields.domain);
  const pipeDescriptions: Record<string, string> = {};
  if (domain !== null) {
    for (const [code, pipe] of Object.entries(asRecord(fields.pipe))) {
      const description = nonEmptyString(asRecord(pipe).description);
      if (description !== null) pipeDescriptions[`${domain}.${code}`] = description;
    }
  }
  return { description: nonEmptyString(fields.description), pipeDescriptions };
}

/**
 * Read `MethodProse` out of a method's `.mthds` files.
 *
 * The domain's description is the one in the method's primary file: the first
 * that declares a `main_pipe`, else the first, which is the file a method leads
 * with. Every file's pipes contribute their descriptions, each qualified by its
 * own file's domain, so a pipe declared beside the main one is described too;
 * the primary file's come first, since `methodVocabulary` keeps the first
 * spelling it meets.
 *
 * A file that does not parse here contributes nothing. The API has just loaded
 * the same closure, so such a file is a disagreement between two TOML parsers,
 * not a broken method, and the prose is optional: every caller has a fallback.
 */
export function methodProseOf(files: readonly MthdsFileItem[]): MethodProse {
  const blueprints: Record<string, unknown>[] = [];
  for (const file of files) {
    try {
      blueprints.push(parseToml(file.content));
    } catch {
      continue;
    }
  }
  const primary =
    blueprints.find((blueprint) => nonEmptyString(blueprint.main_pipe) !== null) ?? blueprints[0];
  const pipeDescriptions: Record<string, string> = {};
  for (const blueprint of [primary, ...blueprints.filter((other) => other !== primary)]) {
    for (const [ref, description] of Object.entries(readMethodProse(blueprint).pipeDescriptions)) {
      pipeDescriptions[ref] ??= description;
    }
  }
  return { description: readMethodProse(primary).description, pipeDescriptions };
}

/**
 * Everything the method says about itself, as one string to read spellings out
 * of. Order is the domain's description first, then each pipe's, so the word a
 * caller sees first is the one the method leads with.
 */
export function methodVocabulary(prose: MethodProse): string {
  return [prose.description ?? "", ...Object.values(prose.pipeDescriptions)].join(" ");
}

/** The three `/v1/pipe-io` artifacts `contracts.ts` is rendered from, and what rides beside them. */
export interface PipeIoArtifacts {
  pipeIoContracts: PipeIOContracts;
  inputForm: InputForm;
  outputForm: OutputForm;
  /** The method's own prose, for a caller naming an app after it. Written into no artifact. */
  prose: MethodProse;
  /**
   * The method's own entry pipe, carried through for the scaffold's pipe rule
   * (`make add-method`) and written into no artifact.
   *
   * It is the route's `default_pipe_ref`: a published package's manifest
   * `main_pipe`, else the closure's single `main_pipe` declaration, so
   * `github.com/Pipelex/methods/documents`, which has no bundle-level
   * `main_pipe`, still names an entry pipe here. It is `null` when the method
   * declares none, or several in different domains: the route refuses to choose
   * between them, and so does the scaffold, which then asks for `--pipe`.
   */
  defaultPipeRef: string | null;
}

/**
 * Fetch one method's pipe IO contracts and both wire form descriptors from
 * `POST /v1/pipe-io`, for every pipe the method loads (`pipeIoRequest`).
 *
 * The route loads the method and derives the three artifacts without dry-running
 * it, where `/v1/validate` dry-ran every pipe for a verdict nothing here reads.
 * What the build still refuses is a method that cannot run at all: one whose
 * pipes are still declared as signatures, which the route reports as
 * `is_runnable: false` with their refs in `pending_signatures`.
 *
 * Returns `null` after reporting; the caller fails the method and writes nothing.
 * An unresolvable method and an unrunnable one are both produced verdicts on a
 * 200, not thrown errors, so they are pattern-matched rather than caught — and
 * neither may yield a contracts file: contracts projected from either would
 * describe a form for a method that cannot run.
 */
export async function fetchPipeIoArtifacts(
  client: Pick<PipelexApiClient, "pipeIo">,
  source: MethodSource,
  baseUrl: string,
): Promise<PipeIoArtifacts | null> {
  try {
    const response = await client.pipeIo(pipeIoRequest(source));
    if (!response.is_valid) {
      console.error(`\n✗ ${source.name} — the method does not resolve:`);
      for (const item of response.validation_errors) {
        console.error(`    ${item.source ?? "?"}: ${item.message}`);
      }
      return null;
    }
    const notRunnable = notRunnableReason(response);
    if (notRunnable !== null) {
      console.error(`\n✗ ${source.name} — ${notRunnable}`);
      return null;
    }
    return {
      pipeIoContracts: response.pipe_io_contracts,
      inputForm: response.input_form,
      outputForm: response.output_form,
      prose: methodProseOf(source.kind === "files" ? source.files : (response.files ?? [])),
      defaultPipeRef: response.default_pipe_ref,
    };
  } catch (error) {
    // `fetchGenerated` calls this only after `/v1/codegen` resolved the same
    // selector, so an untyped 404 here is a runner older than the route, and the
    // message names the route. A 404 the API typed is still its own answer about
    // the method, so that one keeps the selector reading.
    const aboutTheMethod = error instanceof ApiResponseError && error.errorType !== undefined;
    console.error(
      `\n✗ ${source.name} — ` +
        explain(error, baseUrl, "POST /v1/pipe-io", aboutTheMethod ? source : undefined),
    );
    return null;
  }
}

/** Everything one method needs written, once every guard has passed. */
export interface FetchedMethod {
  report: CodegenValidReport;
  contracts: PipeIoArtifacts;
}

/**
 * Ask `POST /v1/codegen` for one method's typed artifacts, as the method
 * resolves now.
 *
 * Returns `null` after reporting why the request failed or the closure does not
 * resolve.
 */
async function requestCodegen(
  client: Pick<PipelexApiClient, "codegen">,
  source: MethodSource,
  baseUrl: string,
): Promise<CodegenValidReport | null> {
  // No `pipe_ref`: `kind: "types"` is concept-set-wide and rejects it with a 422.
  const request: CodegenRequest =
    source.kind === "files"
      ? { files: source.files, kind: "types", target: "ts-zod" }
      : { ...source.selector, kind: "types", target: "ts-zod" };
  try {
    const response = await client.codegen(request);
    if (!response.is_valid) {
      console.error(`\n✗ ${source.name} — the closure does not resolve:`);
      for (const item of response.validation_errors) {
        console.error(`    ${item.source ?? "?"}: ${item.message}`);
      }
      return null;
    }
    return response;
  } catch (error) {
    console.error(`\n✗ ${source.name} — ${explain(error, baseUrl, "POST /v1/codegen", source)}`);
    return null;
  }
}

/**
 * The read-and-guard half of generating one method: both API calls, and every
 * refusal that must happen before a byte is written.
 *
 * Split from the writing half so the scaffold can run the same guards without
 * committing to a write — `--dry-run` is exactly this function and nothing else.
 * The ordering inside is load-bearing: by the time the pipe-io call is made,
 * every codegen guard has passed, so a failure there leaves the tree untouched
 * rather than half-updated. The last call asks `/v1/codegen` again, because the
 * two routes each resolve the method on their own and only the codegen answer
 * names the revision it resolved: a method edited or republished between them
 * would otherwise commit the types of one revision beside the contracts of
 * another, a tree the offline check would then call current.
 *
 * Returns `null` after reporting the reason; the caller fails the method.
 */
export async function fetchGenerated(
  client: Pick<PipelexApiClient, "codegen" | "pipeIo">,
  source: MethodSource,
  outDir: string,
  baseUrl: string,
): Promise<FetchedMethod | null> {
  const report = await requestCodegen(client, source, baseUrl);
  if (report === null) return null;

  // Self-verify BEFORE writing: `GeneratedArtifact` and `CodegenTreeFile` are
  // structurally identical on purpose, so the response feeds in with no mapping.
  // A tree that fails its own check would fail `make check` after being committed.
  const artifacts: GeneratedArtifact[] = report.artifacts;
  const selfCheck = await runCodegenCheck({ lockContent: report.lock, files: artifacts });
  if (!selfCheck.isCurrent) {
    console.error(`\n✗ ${source.name} — the server's own artifacts fail the offline check:`);
    for (const drift of selfCheck.drifts) {
      console.error(`    ${drift.category}: ${drift.path} — ${drift.detail}`);
    }
    console.error("    Nothing was written. This is an upstream bug — report it.");
    return null;
  }

  // The offline check opens the lock by name, so the writer must not put it
  // anywhere else. Following a rename silently would leave the old lock in
  // place — it is not stampable, so the tree cleanup keeps it — and the check
  // would keep validating that obsolete file and stay green. A rename is
  // upstream news; surface it here rather than writing a tree nothing guards.
  if (report.lock_filename !== LOCK_FILENAME) {
    console.error(
      `\n✗ ${source.name} — the server returned lock_filename '${report.lock_filename}', ` +
        `not '${LOCK_FILENAME}'. Nothing was written; bump @pipelex/sdk or report it upstream.`,
    );
    return null;
  }

  // The server names each artifact's path too, and `path.join` would resolve a
  // `..` in one into a write outside the tree — somewhere no stamp guards the
  // file and the offline check never looks, while `writeIfChanged`'s recursive
  // `mkdir` creates whatever directory the path asks for. Refuse the method
  // whole rather than write the containable ones, so the promise above holds.
  const escaping = artifacts.filter((artifact) => !isContainedPath(outDir, artifact.path));
  if (escaping.length > 0) {
    console.error(
      `\n✗ ${source.name} — the server returned artifact path(s) that escape ` +
        `${path.relative(REPO_ROOT, outDir)}/: ${escaping.map((artifact) => artifact.path).join(", ")}. ` +
        `Nothing was written; report it upstream.`,
    );
    return null;
  }

  // The writer owns three names in the tree — the lock, the sidecar and every
  // derived artifact — and writes each after the server's artifacts, so a
  // server artifact landing on one of them would be silently overwritten:
  // `writeTree` returns normally, the sidecar records our content, and the lock
  // still expects the server's — leaving `codegen:check` reporting `hand-edited`
  // forever, with a remedy ("run npm run codegen") that reproduces the same
  // tree. Same class as the `lock_filename` guard above, and not hypothetical:
  // the roadmap has the API serving an input-form descriptor at exactly this
  // seam. The path is normalized first, because `nested/../contracts.ts` is
  // contained and still lands on the same file.
  const colliding = artifacts.filter((artifact) =>
    WRITER_OWNED.has(path.posix.normalize(artifact.path.replaceAll("\\", "/"))),
  );
  if (colliding.length > 0) {
    console.error(
      `\n✗ ${source.name} — the server returned artifact path(s) that land on a file this ` +
        `script writes itself (${[...WRITER_OWNED].join(", ")}): ` +
        `${colliding.map((artifact) => artifact.path).join(", ")}. ` +
        `Nothing was written; report it upstream.`,
    );
    return null;
  }

  // The form's half of the tree: by here every codegen guard has passed, so a
  // failure now leaves the whole tree untouched rather than half-updated.
  const contracts = await fetchPipeIoArtifacts(client, source, baseUrl);
  if (contracts === null) return null;

  // The last thing that can fail this method: the revision both answers
  // describe, confirmed by asking `/v1/codegen` again after `/v1/pipe-io`.
  const again = await requestCodegen(client, source, baseUrl);
  if (again === null) return null;
  if (again.crate_fingerprint !== report.crate_fingerprint) {
    console.error(
      `\n✗ ${source.name} — the method changed while it was being generated: ` +
        "/v1/codegen resolved it to another crate after /v1/pipe-io answered.",
    );
    console.error(`    first: ${report.crate_fingerprint}`);
    console.error(`    then:  ${again.crate_fingerprint}`);
    console.error("    Nothing was written. Run the command again.");
    return null;
  }

  return { report, contracts };
}

/** The writing half: the artifact set, the lock, `contracts.ts`, and the sidecar. */
export async function writeGenerated(
  outDir: string,
  fetched: FetchedMethod,
  source: MethodSource,
): Promise<string[]> {
  return writeTree(outDir, fetched.report, source.sourceHashes, {
    [CONTRACTS_FILENAME]: renderContracts(
      fetched.contracts.pipeIoContracts,
      fetched.contracts.inputForm,
      fetched.contracts.outputForm,
    ),
  });
}

/**
 * Generate one method end to end — fetch, guard, write, report.
 *
 * This is the unit `npm run codegen` loops over and the scaffold calls once, so
 * a scaffolded tree is the tree a regeneration would write: the same function
 * wrote it. Never throws; a failure is reported and returned as `"failed"`, so
 * one bad method neither aborts the loop nor skips every method after it.
 */
export async function generateMethod(
  client: Pick<PipelexApiClient, "codegen" | "pipeIo">,
  source: MethodSource,
  outDir: string,
  baseUrl: string,
): Promise<"ok" | "failed"> {
  const fetched = await fetchGenerated(client, source, outDir, baseUrl);
  if (fetched === null) return "failed";

  let changed: string[];
  try {
    changed = await writeGenerated(outDir, fetched, source);
  } catch (error) {
    console.error(
      `\n✗ ${source.name} — writing the tree failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }

  const { report } = fetched;
  console.log(
    `\n✓ ${source.name} → ${path.relative(REPO_ROOT, outDir)}/  ` +
      `(crate ${report.crate_fingerprint.slice(0, 12)}, engine ${report.engine_version})`,
  );
  if (changed.length === 0) {
    console.log("    no changes");
  } else {
    for (const entry of changed) console.log(`    wrote ${entry}`);
  }
  return "ok";
}

async function runGenerateInner(): Promise<number> {
  loadEnvConfig(REPO_ROOT, false, { info: () => {}, error: console.error });

  const baseUrl = process.env.PIPELEX_BASE_URL ?? DEFAULT_API_BASE_URL;
  try {
    assertSecureBaseUrl(baseUrl);
  } catch (error) {
    console.error(`codegen: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  if (!process.env.PIPELEX_API_KEY) {
    console.error("codegen: PIPELEX_API_KEY is not set — add it to .env.local.");
    return EXIT_FAILED;
  }

  let methods: MethodSource[];
  try {
    methods = await discoverMethods();
  } catch (error) {
    if (error instanceof ManifestError) {
      // A manifest that cannot be read names no method, so there is nothing to
      // regenerate and no remedy beyond the message itself.
      console.error(`codegen: ${error.message}`);
      return EXIT_FAILED;
    }
    throw error;
  }
  if (methods.length === 0) {
    console.error(`codegen: no methods found under ${path.relative(REPO_ROOT, METHODS_DIR)}/.`);
    return EXIT_FAILED;
  }

  // A symlinked src/generated/ root would route reads — and for the writer,
  // writes and deletes — into an external target. Same refusal as the check's.
  await refuseSymlinkRoot(GENERATED_ROOT);

  // Constructed bare, not via `@/lib/pipelexClient`: the `@/` alias is a tsconfig
  // path mapping that Node's runtime resolver never reads. The client picks up the
  // same PIPELEX_API_KEY / PIPELEX_BASE_URL natively, so this IS the same client.
  const client = new PipelexApiClient();

  // Asked once, before the loop, and only when a selector method is in play: an
  // origin that does not forward selectors fails every one of them for the same
  // reason, and saying so once — before anything is fetched or written — beats
  // one opaque 403 per method.
  const selectorKinds = selectorKindsOf(
    methods.filter((method) => method.kind === "selector").map((method) => method.selector),
  );
  const unsupported = await assertSelectorSupport(client, baseUrl, selectorKinds);
  if (unsupported !== null) {
    console.error(`codegen: ${unsupported}`);
    return EXIT_FAILED;
  }

  console.log(`codegen: ${methods.length} method(s), via ${baseUrl}`);

  let failed = false;
  for (const method of methods) {
    const outcome = await generateMethod(
      client,
      method,
      path.join(GENERATED_ROOT, method.name),
      baseUrl,
    );
    if (outcome === "failed") failed = true;
  }

  return failed ? EXIT_FAILED : EXIT_OK;
}

/**
 * The whole `npm run codegen` behavior, exit code included. Never throws: an
 * unexpected failure is reported with its stack and exits 1, which is the
 * contract, not the entry file's job.
 */
export async function runGenerate(): Promise<number> {
  try {
    return await runGenerateInner();
  } catch (error) {
    console.error(`codegen: ${error instanceof Error ? error.stack : String(error)}`);
    return EXIT_FAILED;
  }
}
