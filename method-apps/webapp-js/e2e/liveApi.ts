import { test } from "@playwright/test";

/**
 * Guard for a live-API e2e spec — one that runs a method end to end.
 *
 * Such a spec hits the real Pipelex API: it costs an LLM call and needs
 * PIPELEX_API_KEY. When the key is absent (e.g. a fresh clone that hasn't
 * configured credentials) the suite skips cleanly instead of failing with a
 * confusing auth error. `playwright.config.ts` loads `.env.local`, so a key set
 * there is visible here. Call it at the top of the spec file.
 *
 * The offline page spec (home.spec.ts) is deliberately NOT guarded — it needs
 * no key and runs out of the box.
 *
 * The skip is declared at file scope, never in a `beforeEach`: Playwright runs
 * `beforeAll` first, so a `beforeEach` guard lets a spec's whole setup run —
 * for the tile spec, copying the template, installing it and starting a dev
 * server — before skipping the test it was setting up, and reports a hook
 * FAILURE rather than the clean skip promised here when any of that fails.
 * Declared here, the hooks do not run at all.
 */
export function requireLiveApi() {
  test.skip(
    !process.env.PIPELEX_API_KEY,
    "Live-API e2e: set PIPELEX_API_KEY in .env.local to run.",
  );
}

/** Whether the live key is present, for a hook that must also stand on its own. */
export function hasLiveApiKey(): boolean {
  return Boolean(process.env.PIPELEX_API_KEY);
}
