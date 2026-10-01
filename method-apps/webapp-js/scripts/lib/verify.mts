/**
 * Ask the engine whether the committed trees are still semantically right.
 *
 * `npm run codegen:check` proves a tree agrees with its own lock, which is a
 * question about bytes and needs nothing but hashes. It deliberately cannot
 * answer the other question — whether the crate those artifacts project is still
 * what the `.mthds` closure resolves to today — because that needs the engine.
 * This module closes that gap the way the SDK documents: re-run `codegen()` live
 * and compare its `crate_fingerprint` against the committed lock's.
 *
 * The same gap exists for `contracts.ts`, and for the same reason: it is projected
 * from `POST /v1/validate` and nothing offline can tell whether that route would
 * return the same payload today. So this module re-fetches it too and compares
 * the rendered bytes against the committed file. The re-fetch is close to free —
 * the client and the closure are already in hand — which is why it is checked
 * here rather than exempted the way an unverifiable artifact would have to be.
 *
 * It writes nothing. A mismatch means `npm run codegen` has real work to do; the
 * fix is a deliberate regeneration commit, not a silent rewrite from a checker.
 *
 * Keyed and online, so it stays out of `make all` — same reason `test-e2e` does.
 */
import path from "node:path";
import process from "node:process";

// `@next/env` is CommonJS — see the same note in `generate.mts`.
import nextEnv from "@next/env";
import {
  ApiResponseError,
  CodegenLockError,
  DEFAULT_API_BASE_URL,
  PipelexApiClient,
  runCodegenCheck,
} from "@pipelex/sdk";

import { assertSelectorSupport, explainSelectorFailure, selectorKindsOf } from "./api.mts";
import {
  assertSecureBaseUrl,
  CONTRACTS_FILENAME,
  discoverMethods,
  ManifestError,
  refuseSymlinkRoot,
  GENERATED_ROOT,
  LOCK_FILENAME,
  METHODS_DIR,
  readGeneratedTree,
  readTextFile,
  renderContracts,
  REPO_ROOT,
  missingViews,
  VALIDATE_VIEWS,
  type MethodSource,
} from "./shared.mts";

const { loadEnvConfig } = nextEnv;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/**
 * How a failed call to `route` reads in the console. Both routes this script
 * calls report the same way, and the status plus the server's own message is
 * the part that tells a stale commit apart from an expired key.
 *
 * A selector method takes the selector-resolution reading of a 404 first: on a
 * committed tree that used to resolve, "no package at this address any more" is
 * the whole story, and the server spells it out.
 */
function requestDetail(error: unknown, route: string, source: MethodSource): string {
  if (source.kind === "selector") {
    const selectorFailure = explainSelectorFailure(error, source.selector);
    if (selectorFailure !== null) return selectorFailure;
  }
  if (error instanceof ApiResponseError) {
    return `HTTP ${error.status} from ${route} — ${error.serverMessage ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runVerifyInner(): Promise<number> {
  loadEnvConfig(REPO_ROOT, false, { info: () => {}, error: console.error });

  const baseUrl = process.env.PIPELEX_BASE_URL ?? DEFAULT_API_BASE_URL;
  try {
    assertSecureBaseUrl(baseUrl);
  } catch (error) {
    console.error(`codegen:verify: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  if (!process.env.PIPELEX_API_KEY) {
    console.error("codegen:verify: PIPELEX_API_KEY is not set — add it to .env.local.");
    return EXIT_FAILED;
  }

  let methods: MethodSource[];
  try {
    methods = await discoverMethods();
  } catch (error) {
    if (error instanceof ManifestError) {
      console.error(`codegen:verify: ${error.message}`);
      return EXIT_FAILED;
    }
    throw error;
  }
  if (methods.length === 0) {
    console.error(
      `codegen:verify: no methods found under ${path.relative(REPO_ROOT, METHODS_DIR)}/.`,
    );
    return EXIT_FAILED;
  }

  // A symlinked src/generated/ root would route reads — and for the writer,
  // writes and deletes — into an external target. Same refusal as the check's.
  await refuseSymlinkRoot(GENERATED_ROOT);

  const client = new PipelexApiClient();

  // Same handshake as the writer's, for the same reason: an origin that does not
  // forward selectors cannot answer the question this script asks about a
  // selector method, and it should say that once rather than per method.
  const unsupported = await assertSelectorSupport(
    client,
    baseUrl,
    selectorKindsOf(
      methods.filter((method) => method.kind === "selector").map((method) => method.selector),
    ),
  );
  if (unsupported !== null) {
    console.error(`codegen:verify: ${unsupported}`);
    return EXIT_FAILED;
  }

  console.log(`codegen:verify: ${methods.length} method(s), against ${baseUrl}`);

  let failed = false;

  for (const method of methods) {
    const outDir = path.join(GENERATED_ROOT, method.name);
    const where = path.relative(REPO_ROOT, outDir);

    const tree = await readGeneratedTree(outDir);
    if (tree.status !== "ok") {
      const what = tree.status === "no-tree" ? "no generated tree" : `no ${LOCK_FILENAME}`;
      console.error(`\n✗ ${method.name} — ${what} at ${where}/. Run \`npm run codegen\` first.`);
      failed = true;
      continue;
    }

    // `runCodegenCheck` is how the committed fingerprint is read: it is the lock
    // parser, and it surfaces the header precisely so a caller can make this
    // comparison. Its drift verdict is a bonus here — `codegen:check` owns that.
    let committedFingerprint: string;
    let committedEngine: string;
    let driftCount: number;
    try {
      const report = await runCodegenCheck({ lockContent: tree.lockContent, files: tree.files });
      committedFingerprint = report.crateFingerprint;
      committedEngine = report.engineVersion;
      driftCount = report.drifts.length;
    } catch (error) {
      if (error instanceof CodegenLockError) {
        console.error(`\n✗ ${method.name} — ${error.message}`);
        failed = true;
        continue;
      }
      throw error;
    }

    let liveFingerprint: string;
    let liveEngine: string;
    try {
      const response = await client.codegen(
        method.kind === "files"
          ? { files: method.files, kind: "types", target: "ts-zod" }
          : { ...method.selector, kind: "types", target: "ts-zod" },
      );
      if (!response.is_valid) {
        console.error(`\n✗ ${method.name} — the closure does not resolve:`);
        for (const item of response.validation_errors) {
          console.error(`    ${item.source ?? "?"}: ${item.message}`);
        }
        failed = true;
        continue;
      }
      liveFingerprint = response.crate_fingerprint;
      liveEngine = response.engine_version;
    } catch (error) {
      console.error(`\n✗ ${method.name} — ${requestDetail(error, "POST /v1/codegen", method)}`);
      failed = true;
      continue;
    }

    if (liveFingerprint !== committedFingerprint) {
      console.error(`\n✗ ${method.name} — the committed crate is not what the method resolves to.`);
      console.error(`    committed: ${committedFingerprint}`);
      console.error(`    live:      ${liveFingerprint}`);
      console.error("    Run `npm run codegen` and commit the result.");
      failed = true;
      continue;
    }

    // The contracts artifact rides `/v1/validate`, not `/v1/codegen`, so the
    // crate fingerprint above says nothing about it. Compare the rendered bytes —
    // with the same `views` opt-in the writer sends, or the render differs on
    // every tree by the descriptor's absence alone.
    try {
      const response =
        method.kind === "files"
          ? await client.validateFiles(
              method.files.map((file) => ({ content: file.content, uri: file.source })),
              { views: VALIDATE_VIEWS },
            )
          : await client.validate(method.selector, false, undefined, undefined, VALIDATE_VIEWS);
      if (!response.is_valid) {
        console.error(`\n✗ ${method.name} — the method no longer validates:`);
        for (const item of response.validation_errors) {
          console.error(`    ${item.source ?? "?"}: ${item.message}`);
        }
        failed = true;
        continue;
      }
      if (!response.input_form || !response.output_form) {
        console.error(
          `\n✗ ${method.name} — /v1/validate returned no ` +
            `${missingViews(response).join(" or ")} view, so the committed ` +
            `${CONTRACTS_FILENAME} cannot be verified. This base URL serves an API too old ` +
            `for the wire descriptors — check PIPELEX_BASE_URL.`,
        );
        failed = true;
        continue;
      }
      const live = renderContracts(
        response.pipe_io_contracts,
        response.input_form,
        response.output_form,
      );
      const committed = await readTextFile(path.join(outDir, CONTRACTS_FILENAME));
      if (live !== committed) {
        console.error(
          `\n✗ ${method.name} — the committed ${CONTRACTS_FILENAME} is not what /v1/validate returns.`,
        );
        console.error("    Run `npm run codegen` and commit the result.");
        failed = true;
        continue;
      }
    } catch (error) {
      console.error(`\n✗ ${method.name} — ${requestDetail(error, "POST /v1/validate", method)}`);
      failed = true;
      continue;
    }

    console.log(
      `\n✓ ${method.name} — crate ${committedFingerprint.slice(0, 12)} matches the engine, ` +
        `${CONTRACTS_FILENAME} matches /v1/validate`,
    );
    if (liveEngine !== committedEngine) {
      // Not a failure. The stamp carries `engine_version`, so an engine bump
      // rewrites every artifact with zero semantic change — the fingerprint is
      // the semantic signal and it just matched. Regenerate deliberately, in its
      // own commit, rather than letting an unrelated PR carry a whole-tree diff.
      console.log(
        `    note: engine moved ${committedEngine} → ${liveEngine}; regenerating will restamp the tree with no semantic change`,
      );
    }
    if (driftCount > 0) {
      console.log(
        `    note: ${driftCount} drift(s) against the lock — run \`npm run codegen:check\``,
      );
    }
  }

  return failed ? EXIT_FAILED : EXIT_OK;
}

/**
 * The whole `npm run codegen:verify` behavior, exit code included. Never
 * throws — see the same note on `runGenerate`.
 */
export async function runVerify(): Promise<number> {
  try {
    return await runVerifyInner();
  } catch (error) {
    console.error(`codegen:verify: ${error instanceof Error ? error.stack : String(error)}`);
    return EXIT_FAILED;
  }
}
