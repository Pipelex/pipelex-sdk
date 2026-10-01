import { test } from "@playwright/test";

/**
 * Guard for the live-API e2e specs (extract / summarize-pdf / generate-image).
 *
 * These hit the real Pipelex API — they cost an LLM call and need
 * PIPELEX_API_KEY. When the key is absent (e.g. a fresh fork that hasn't
 * configured credentials) the suite skips cleanly instead of failing with a
 * confusing auth error. `playwright.config.ts` loads `.env.local`, so a key set
 * there is visible here.
 *
 * The offline error-UX spec (error-display.spec.ts) is deliberately NOT
 * guarded — it needs no key and runs out of the box.
 */
export function requireLiveApi() {
  test.beforeEach(() => {
    test.skip(
      !process.env.PIPELEX_API_KEY,
      "Live-API e2e: set PIPELEX_API_KEY in .env.local to run (or delete e2e/).",
    );
  });
}
