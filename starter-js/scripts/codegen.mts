#!/usr/bin/env node
/**
 * CLI entry for `npm run codegen`. The behavior — and its exit code — lives in
 * `scripts/lib/generate.mts`, which is importable and therefore testable; this
 * file exists only to be the thing Node runs.
 */
import process from "node:process";

import { runGenerate } from "./lib/generate.mts";

process.exit(await runGenerate());
