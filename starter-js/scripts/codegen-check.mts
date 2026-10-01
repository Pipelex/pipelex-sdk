#!/usr/bin/env node
/**
 * CLI entry for `npm run codegen:check`. The behavior — and its exit code —
 * lives in `scripts/lib/check.mts`; see the note in `scripts/codegen.mts`.
 */
import process from "node:process";

import { runCheck } from "./lib/check.mts";

process.exit(await runCheck());
