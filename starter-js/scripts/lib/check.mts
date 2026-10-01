/**
 * Prove, offline, that the committed trees under `src/generated/` are current.
 *
 * This is the CI half of the codegen trust chain, and it is deliberately the
 * cheap half: no API key, no network, no engine — just hashes. It answers two
 * questions, and it is worth being precise about which is which:
 *
 *  1. **Does each tree still agree with its own lock?** `runCodegenCheck` from
 *     `@pipelex/sdk` owns that verdict (categories `missing` · `modified` ·
 *     `hand-edited` · `orphan`). Its `detail` strings are printed verbatim so
 *     this report reads identically to `pipelex codegen check`.
 *  2. **Do the trees still match the `.mthds` files they were generated from,
 *     and are the starter's own artifacts intact?** The lock cannot know either
 *     one — it hashes the artifacts the codegen route returned, not the sources
 *     behind them and not the files this repo emits itself — so the writer
 *     (`generate.mts`) puts a starter-owned `sources.json` beside each lock and
 *     `compareSidecar` checks both halves of it against what is on disk.
 *
 * Neither question is "is the tree what the engine would produce today". That one
 * needs the engine, and it is `npm run codegen:verify`.
 *
 * Exit codes follow the codegen spec: 0 current · 1 drift or stale sources ·
 * 2 no verdict could be produced. Aggregation across methods is by precedence,
 * deliberately: a no-verdict (2) outranks drift (1), because as long as any
 * method could not be checked the run has not produced the full verdict a 0
 * or 1 would claim. The per-category summary line at the end shows the mix
 * the single exit code cannot. `summarizeVerdicts` owns that precedence, and
 * `runCheck` owns the whole contract — including the catch-all: an unexpected
 * failure is a no-verdict, never a thrown exception, so the CLI entry stays a
 * one-liner.
 */
import path from "node:path";

import { CodegenLockError, runCodegenCheck } from "@pipelex/sdk";

import {
  compareSidecar,
  discoverMethods,
  findOrphanTrees,
  GENERATED_ROOT,
  LOCK_FILENAME,
  METHODS_DIR,
  ManifestError,
  NonUtf8FileError,
  readGeneratedTree,
  REPO_ROOT,
  SymlinkRefusedError,
  type MethodSource,
} from "./shared.mts";

export const EXIT_CURRENT = 0;
export const EXIT_DRIFT = 1;
export const EXIT_NO_VERDICT = 2;

const REGENERATE = "Run `npm run codegen` to regenerate.";

/** The per-category mix behind the single exit code, plus that code. */
export interface VerdictSummary {
  current: number;
  drift: number;
  noVerdict: number;
  exit: number;
}

/**
 * Fold per-method exit codes into the run's verdict, by precedence: a
 * no-verdict (2) outranks drift (1) outranks current (0). Never a max() over
 * codes — precedence and magnitude only coincide today, and the counts are
 * what the summary line prints. Any unknown code counts as a no-verdict.
 */
export function summarizeVerdicts(codes: readonly number[]): VerdictSummary {
  const counts = { current: 0, drift: 0, noVerdict: 0 };
  for (const code of codes) {
    if (code === EXIT_CURRENT) counts.current += 1;
    else if (code === EXIT_DRIFT) counts.drift += 1;
    else counts.noVerdict += 1;
  }
  const exit =
    counts.noVerdict > 0 ? EXIT_NO_VERDICT : counts.drift > 0 ? EXIT_DRIFT : EXIT_CURRENT;
  return { ...counts, exit };
}

/** Check one method's generated tree; print its report and return its exit code. */
export async function checkMethod(
  method: MethodSource,
  generatedRoot: string = GENERATED_ROOT,
): Promise<number> {
  const outDir = path.join(generatedRoot, method.name);
  const where = path.relative(REPO_ROOT, outDir);

  let tree;
  try {
    tree = await readGeneratedTree(outDir);
  } catch (error) {
    if (error instanceof NonUtf8FileError) {
      // In a generated tree a bad decode is drift, not a refusal: regenerating
      // rewrites the file, so the standard remedy genuinely fixes it.
      console.error(`\n✗ ${method.name} — ${error.message}`);
      console.error(`    ${REGENERATE}`);
      return EXIT_DRIFT;
    }
    if (error instanceof SymlinkRefusedError) {
      console.error(`\n✗ ${method.name} — ${error.message}`);
      return EXIT_NO_VERDICT;
    }
    // Any other walk failure (permissions, I/O): no verdict was produced, so
    // never print the regenerate remedy — it would claim a drift verdict.
    console.error(
      `\n✗ ${method.name} — cannot read ${where}/: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_NO_VERDICT;
  }

  if (tree.status === "no-tree") {
    console.error(`\n✗ ${method.name} — no generated tree at ${where}/`);
    console.error(`    ${REGENERATE}`);
    return EXIT_DRIFT;
  }
  if (tree.status === "no-lock") {
    console.error(`\n✗ ${method.name} — no ${LOCK_FILENAME} in ${where}/, so there is no verdict.`);
    console.error(`    Found: ${tree.treePaths.join(", ") || "(empty directory)"}`);
    console.error(`    ${REGENERATE}`);
    return EXIT_NO_VERDICT;
  }
  const { lockContent, files } = tree;

  let drifts: { category: string; path: string; detail: string }[];
  let fingerprint: string;
  let engineVersion: string;
  try {
    const report = await runCodegenCheck({ lockContent, files });
    drifts = report.drifts;
    fingerprint = report.crateFingerprint;
    engineVersion = report.engineVersion;
  } catch (error) {
    if (error instanceof CodegenLockError) {
      // A no-verdict condition, not a drift: the message already names the fix
      // (an unknown `lock_version` says which side to upgrade), so print it as-is.
      console.error(`\n✗ ${method.name} — ${error.message}`);
      return EXIT_NO_VERDICT;
    }
    throw error;
  }

  const stale = await compareSidecar(outDir, method.sourceHashes);

  if (drifts.length === 0 && stale.length === 0) {
    console.log(
      `\n✓ ${method.name} — ${files.length} artifact(s) current  (crate ${fingerprint.slice(0, 12)}, engine ${engineVersion})`,
    );
    return EXIT_CURRENT;
  }

  console.error(`\n✗ ${method.name} — ${where}/`);
  for (const drift of drifts) {
    console.error(`    ${drift.category}: ${drift.path} — ${drift.detail}`);
  }
  for (const line of stale) console.error(`    ${line}`);
  console.error(`    ${REGENERATE}`);
  return EXIT_DRIFT;
}

async function runCheckInner(): Promise<number> {
  let methods: MethodSource[];
  try {
    methods = await discoverMethods();
  } catch (error) {
    if (
      error instanceof SymlinkRefusedError ||
      error instanceof NonUtf8FileError ||
      error instanceof ManifestError
    ) {
      // A refusal on the source side: regenerating would ship garbage to the
      // API (or follow a link out of the closure), and a manifest that names no
      // method names nothing to regenerate from. No verdict, and no remedy to
      // print beyond the message itself.
      console.error(`codegen:check: ${error.message}`);
      return EXIT_NO_VERDICT;
    }
    throw error;
  }

  // Orphan detection runs even when methods/ is empty: generated trees left
  // behind after the last method was removed are drift, not "nothing to check".
  let scan;
  try {
    scan = await findOrphanTrees(GENERATED_ROOT, new Set(methods.map((m) => m.name)));
  } catch (error) {
    if (error instanceof SymlinkRefusedError) {
      // A symlinked src/generated/ root, or a symlinked entry directly under
      // it. The scan runs before the per-method loop precisely so a refusal
      // here means no verdict was ever produced over external content.
      console.error(`codegen:check: ${error.message}`);
      return EXIT_NO_VERDICT;
    }
    throw error;
  }

  if (methods.length === 0 && scan.orphans.length === 0 && scan.caseMismatches.length === 0) {
    console.error(
      `codegen:check: no methods found under ${path.relative(REPO_ROOT, METHODS_DIR)}/ — nothing to check.`,
    );
    return EXIT_NO_VERDICT;
  }

  console.log(`codegen:check: ${methods.length} method(s), offline`);

  const codes: number[] = [];

  for (const method of methods) {
    codes.push(await checkMethod(method));
  }

  for (const { actual, expected } of scan.caseMismatches) {
    // On a case-insensitive filesystem this tree may be the very one the loop
    // above just certified, so the remedy is a rename — never a delete.
    console.error(
      `\n✗ ${actual} — a generated tree whose name matches methods/${expected}/ in case only.`,
    );
    console.error(`    Rename src/generated/${actual}/ to src/generated/${expected}/.`);
    codes.push(EXIT_DRIFT);
  }

  for (const name of scan.orphans) {
    console.error(`\n✗ ${name} — a generated tree with no methods/${name}/ behind it.`);
    console.error(
      `    Regeneration never removes a whole tree: delete src/generated/${name}/ or restore the method.`,
    );
    codes.push(EXIT_DRIFT);
  }

  const summary = summarizeVerdicts(codes);
  console.log(
    `\ncodegen:check: ${summary.current} current · ${summary.drift} drift · ${summary.noVerdict} no verdict`,
  );
  return summary.exit;
}

/**
 * The whole `npm run codegen:check` behavior, exit code included. Never
 * throws: an unexpected failure produced no verdict, and saying so (exit 2,
 * stack printed) is part of the contract rather than the entry file's job.
 */
export async function runCheck(): Promise<number> {
  try {
    return await runCheckInner();
  } catch (error) {
    console.error(`codegen:check: ${error instanceof Error ? error.stack : String(error)}`);
    return EXIT_NO_VERDICT;
  }
}
