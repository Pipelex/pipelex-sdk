#!/usr/bin/env node
/**
 * CLI entry for `npm run create`. The behavior — and its exit code — lives in
 * `scripts/lib/create.mts`, which is importable and therefore testable; this
 * file exists only to be the thing Node runs.
 */
import process from "node:process";

import { runCreate } from "./lib/create.mts";

process.exit(await runCreate(process.argv.slice(2)));
