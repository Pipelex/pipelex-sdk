import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

// Load .env.local (and friends) exactly like Next does, so the live-API specs
// can detect PIPELEX_API_KEY and skip cleanly when it's missing (see
// e2e/liveApi.ts). Silent logger keeps `make test-e2e` output uncluttered.
loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

const isCI = !!process.env.CI;

// Where the dev server listens. `APP_HOST` and `APP_PORT` are declared once, in
// the Makefile, which exports them; package.json's `dev` and `start` scripts
// fall back to the same 127.0.0.1 and 4300, and this reads them so
// `make test-e2e APP_PORT=4301` stays coherent with the server it starts. The
// names are deliberately not the ambient `HOST` or `PORT`, which hosts and
// other tools set for their own reasons and would silently move this server.
// A blank value means the default, as an empty one does in the scripts and in
// the Makefile's port-check, which guards the port this reuses.
//
// Deliberately NOT port 4100: the pipelex-server local stack publishes its
// sandbox container (the MTHDS build chatbot) on 127.0.0.1:4100. With the
// loopback default the collision is loud — Next fails with EADDRINUSE. With the
// host widened it is silent: Docker holds IPv4 loopback, Next still binds the
// wildcard and prints "Ready", and every webServer health check on 127.0.0.1
// reaches the container's 404 instead — until `timeout` below expires with
// "Timed out waiting 120000ms from config.webServer". If that ever happens, the
// first thing to run is `lsof -nP -iTCP:4300 -sTCP:LISTEN`.
const HOST = process.env.APP_HOST?.trim() || "127.0.0.1";
const PORT = Number(process.env.APP_PORT?.trim() || 4300);

// A wildcard bind answers on loopback, and an IPv6 address needs brackets.
const URL_HOST =
  HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
const BASE_URL = `http://${URL_HOST}:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? "github" : "list",
  // Pipeline runs hit a real LLM and can take a while; bump the per-test timeout.
  timeout: 120_000,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: isCI ? "npm run build && npm start" : "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
