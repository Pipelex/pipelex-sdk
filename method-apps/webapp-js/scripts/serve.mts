#!/usr/bin/env node
/**
 * CLI entry for `npm run serve` and `npm run serve -- stop`, which `make serve`
 * and `make stop` run. The behavior — and its exit code — lives in
 * `scripts/lib/serve.mts`, which is importable and therefore testable; this
 * file exists only to be the thing Node runs.
 */
import process from "node:process";

import { runServe } from "./lib/serve.mts";

// Set rather than passed to process.exit, so the verdict line is flushed to a
// pipe before the process ends: it is the line a caller reads.
process.exitCode = await runServe(process.argv.slice(2));
