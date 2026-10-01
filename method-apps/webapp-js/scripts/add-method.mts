#!/usr/bin/env node
/**
 * CLI entry for `npm run add-method`. The behavior — and its exit code — lives
 * in `scripts/lib/add-method.mts`, which is importable and therefore testable;
 * this file exists only to be the thing Node runs.
 */
import process from "node:process";

import { runAddMethod } from "./lib/add-method.mts";

process.exit(await runAddMethod(process.argv.slice(2)));
