#!/usr/bin/env node
/**
 * CLI entry for `npm run codegen:verify`. The behavior — and its exit code —
 * lives in `scripts/lib/verify.mts`; see the note in `scripts/codegen.mts`.
 */
import process from "node:process";

import { runVerify } from "./lib/verify.mts";

process.exit(await runVerify());
