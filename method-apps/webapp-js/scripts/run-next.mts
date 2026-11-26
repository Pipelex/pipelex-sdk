#!/usr/bin/env node
/**
 * CLI entry for `npm run dev` and `npm run start`. The behavior — and its exit
 * code — lives in `scripts/lib/run-next.mts`, which is importable and therefore
 * testable; this file exists only to be the thing Node runs.
 */
import process from "node:process";

import { runNext } from "./lib/run-next.mts";

process.exitCode = await runNext(process.argv.slice(2));
