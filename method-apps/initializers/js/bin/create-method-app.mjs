#!/usr/bin/env node
/**
 * `npm create @pipelex/method-app@latest <dir> -- --method …` runs this. The
 * behavior lives in `lib/main.mjs`; this file catches SIGINT and SIGTERM, so an
 * interruption ends in a verdict rather than a dead process, and sets the exit
 * code.
 */
import process from "node:process";

import { run } from "../lib/main.mjs";

const controller = new AbortController();
const interrupt = (signal) => controller.abort(signal);
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

process.exitCode = await run(process.argv.slice(2), { signal: controller.signal });
