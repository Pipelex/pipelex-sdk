import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasLiveApiKey, requireLiveApi } from "./liveApi";

/**
 * The result tile, end to end: a method app consuming a run's whole result.
 *
 * LIVE — this spec creates an app from this template for a method that
 * produces an image, runs that method against the configured Pipelex API, and
 * then reads the page the way a person would. It costs one image generation
 * and needs `PIPELEX_API_KEY` and a `PIPELEX_BASE_URL` that serves the form
 * views `add-method` asks for (see docs/add-method.md); `requireLiveApi` skips
 * it without a key.
 *
 * What it pins, and why each is here rather than in a unit test:
 *
 * - **The picture paints through this app's own assets route.** The runtime
 *   returns the image as a `pipelex-storage://` reference beside a signed
 *   `public_url`; the kernel asks the host's resolver first, so with
 *   `ResultEnv` mounted the `<img src>` is `/api/assets/…` and the signed link
 *   is never what the browser fetches. Only a real run produces a real
 *   reference. The receipt still carries `public_url`, so the spec reads the
 *   rendered page rather than the payload.
 * - **The route's three header rules hold on the response the browser got**:
 *   `nosniff`, a controlled `Content-Disposition`, and the sandboxing CSP scoped
 *   to document-capable types — so absent on a raster. Private caching too.
 * - **The finished run keeps its id**, with its Copy button, under the result.
 * - **The cost panel labels a partial sum as partial.** It is read after opening
 *   the "Usage and cost" disclosure it starts closed in. Whether a live run mixes
 *   priced and unrated calls is the rate table's call, not this spec's, so the
 *   assertion is the labelling RULE read off the table: when a row shows an
 *   unpriced call beside a priced footer sum, the footer must not say "Total";
 *   when every row is priced, it must. The unit test pins each branch alone.
 *
 * It also saves a screenshot of the result tile and of the cost panel, as this
 * sprint's acceptance evidence, under the test's output directory
 * (`test-results/…`), and attaches both to the report — taken as soon as the
 * result is on screen, before the assertions, so a failed leg still leaves a
 * picture of what it saw.
 *
 * The assets route needs a platform that serves `POST /v1/resolve-storage-url/bulk`,
 * the route the SDK's `fetchArtifact` mints its link through; against a
 * deployment without it the route answers `502` naming the route, and this spec
 * fails at that answer rather than at a picture that never loaded.
 *
 * The app is created in a temporary directory: the template copied out (as a
 * project starts), `npm ci` from the local cache, `add-method` over the fixture
 * bundle, then `next dev` on a free port of its own — Turbopack refuses a
 * symlinked `node_modules`, so the install is real. The template's own dev
 * server, which `playwright.config.ts` starts for `home.spec.ts`, is not used.
 */

requireLiveApi();

test.describe.configure({ mode: "serial" });

const TEMPLATE_ROOT = path.resolve(__dirname, "..");
const METHOD_NAME = "generate-image";
const BUNDLE = path.join(__dirname, "fixtures", METHOD_NAME);
const PROMPT = "A red bicycle leaning against a white wall, flat vector illustration";

/** What the copy leaves behind: installs, build output, git, and local secrets. */
const NOT_COPIED = new Set([
  "node_modules",
  ".next",
  ".git",
  "test-results",
  "playwright-report",
  ".env",
  ".env.local",
  "tsconfig.tsbuildinfo",
]);

/** The three steps before the first request take a while on a cold cache, and the run itself is a live image generation. */
/**
 * The hook's own budget has to cover every step it wraps, or it fails the spec
 * for a reason that has nothing to do with what the spec pins: two installs at
 * `STEP_TIMEOUT_MS` each, then the wait for the dev server's first compile.
 */
const STEP_TIMEOUT_MS = 240_000;
const SERVER_TIMEOUT_MS = 180_000;
const CREATE_TIMEOUT_MS = STEP_TIMEOUT_MS * 2 + SERVER_TIMEOUT_MS + 60_000;
const RUN_TIMEOUT_MS = 300_000;
const NAV_TIMEOUT_MS = 120_000;
const DECODE_TIMEOUT_MS = 60_000;
/**
 * The test's own budget, built from the legs it actually contains rather than
 * set equal to the run's: the navigation, the wait for the result, then the
 * post-run legs — two screenshots, the re-fetch through the route, and the
 * decode poll. A budget that only covered the run would expire while an inner
 * timeout was still running, so a genuine failure would be reported as a bare
 * `Test timeout of …ms exceeded` instead of the assertion that actually failed.
 */
const TILE_TEST_TIMEOUT_MS = NAV_TIMEOUT_MS + RUN_TIMEOUT_MS + DECODE_TIMEOUT_MS + 60_000;

let app: string | undefined;
let server: ChildProcess | undefined;
let baseUrl = "";

/** Run one command in the created app, throwing with its output when it fails. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf-8",
    timeout: STEP_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    // A killed child leaves `status` null, so an exit code alone would report
    // a timeout as "exit null" and send the reader looking for the wrong thing.
    const why =
      result.error !== undefined
        ? result.error.message
        : result.signal !== null
          ? `killed by ${result.signal} (the step's ${STEP_TIMEOUT_MS}ms budget)`
          : `exit ${result.status}`;
    throw new Error(
      `${command} ${args.join(" ")} failed (${why})\n${result.stdout}\n${result.stderr}`,
    );
  }
}

/** A port nothing on loopback holds right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not find a free port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/** Poll the created app's home page until Next serves it — the first request compiles it. */
async function waitForServer(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the created app's dev server exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the created app did not answer on ${url} within ${timeoutMs}ms`);
}

/** Stop the dev server and everything it forked: `next dev` runs the server in a child of its own. */
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

test.beforeAll(async () => {
  // The file-scope skip already keeps this hook from running without a key.
  // Standing on its own as well costs nothing and makes the expensive part
  // unreachable by accident, whatever a future edit does to the guard.
  if (!hasLiveApiKey()) return;
  test.setTimeout(CREATE_TIMEOUT_MS);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // The created app is a project of its own: the template's port, host and
  // execution-mode settings must not leak into it through the shell.
  delete env.APP_HOST;
  delete env.APP_PORT;

  app = await mkdtemp(path.join(tmpdir(), "method-app-tile-"));
  await cp(TEMPLATE_ROOT, app, {
    recursive: true,
    filter: (source) => !NOT_COPIED.has(path.relative(TEMPLATE_ROOT, source).split(path.sep)[0]!),
  });
  console.log(`[tile e2e] created the app in ${app}`);

  run("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], app, env);
  run("npm", ["run", "add-method", "--", BUNDLE, "--name", METHOD_NAME], app, env);

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const next = path.join(app, "node_modules", "next", "dist", "bin", "next");
  server = spawn(process.execPath, [next, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: app,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so stopping it stops the server Next forks.
    detached: true,
  });
  server.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[app] ${chunk}`));
  server.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[app] ${chunk}`));
  await waitForServer(`${baseUrl}/`, server, SERVER_TIMEOUT_MS);
});

test.afterAll(async () => {
  if (server !== undefined) await stopServer(server);
  if (app !== undefined) await rm(app, { recursive: true, force: true });
});

/** The image row's cost cells and the footer, read as a person would read them. */
async function readCostTable(page: Page) {
  const panel = page.getByRole("region", { name: "Cost report" });
  const cells = await panel.locator("tbody tr td:last-child").allTextContents();
  const footerLabel = (await panel.locator("tfoot td").first().textContent())?.trim() ?? "";
  const footerValue = (await panel.locator("tfoot td").last().textContent())?.trim() ?? "";
  return { panel, cells: cells.map((cell) => cell.trim()), footerLabel, footerValue };
}

test("the image tile paints through the assets route, and the cost panel labels a partial cost as partial", async ({
  page,
}, testInfo) => {
  test.setTimeout(TILE_TEST_TIMEOUT_MS);

  await page.goto(`${baseUrl}/`, { timeout: NAV_TIMEOUT_MS });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // Act only once the page is live: before hydration the form has no handlers.
  await page.waitForSelector("html[data-hydrated]");

  // The form is the kernel's, so the control is reached by role and the
  // humanized name of the method's own input (`image_prompt`).
  await page.getByRole("textbox", { name: "Image prompt" }).fill(PROMPT);
  await page.getByRole("button", { name: /^Run / }).click();

  // The result region is named after the method (`generate_image`, humanized).
  const result = page.getByRole("region", { name: "Generate image" });
  await expect(result).toBeVisible({ timeout: RUN_TIMEOUT_MS });

  // A rendered file is always an `<img>`; the kernel's icons are `<svg>`.
  const img = result.locator("img").first();
  await expect(img).toBeVisible();
  // Let the picture settle either way, then keep both screenshots BEFORE any
  // assertion on them: they are the evidence of what rendered, whether or not
  // a leg below passes, and a failure with no picture of it is half a report.
  await img
    .evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          const image = el as HTMLImageElement;
          if (image.complete) resolve();
          else image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    )
    .catch(() => undefined);
  const tilePath = testInfo.outputPath("result-tile.png");
  await result.screenshot({ path: tilePath });
  await testInfo.attach("result-tile", { path: tilePath, contentType: "image/png" });
  console.log(`[tile e2e] result tile screenshot: ${tilePath}`);
  // The finished run keeps its id under the result, beside its Copy button.
  await expect(page.getByRole("button", { name: "Copy the run id" })).toBeVisible();
  // The cost panel sits in a disclosure that starts closed: open it as a person would.
  await page.getByText("Usage and cost").click();
  const costPanel = page.getByRole("region", { name: "Cost report" });
  await expect(costPanel).toBeVisible();
  const costPath = testInfo.outputPath("cost-panel.png");
  await costPanel.screenshot({ path: costPath });
  await testInfo.attach("cost-panel", { path: costPath, contentType: "image/png" });
  console.log(`[tile e2e] cost panel screenshot: ${costPath}`);

  const src = await img.getAttribute("src");
  expect(src, "the picture is addressed on this origin, through the assets route").toMatch(
    /^\/api\/assets\/.+/,
  );
  // The signed link — the credential — is nowhere in the page.
  expect(await page.content()).not.toContain("X-Amz-Signature");

  // The response the browser got, re-fetched through the same route. Read
  // before the decode check, so a route that could not reach the bytes fails
  // with the reason it answered rather than with a picture that never loaded.
  const response = await page.request.get(`${baseUrl}${src}`);
  expect(
    response.status(),
    `the assets route answered ${response.status()}: ${await response.text()}`,
  ).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toMatch(/^image\//);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-disposition"]).toMatch(/^inline; filename="[A-Za-z0-9._-]+"$/);
  expect(headers["cache-control"]).toBe("private, max-age=300, must-revalidate");
  // Every response from the route carries `frame-ancestors 'self'`; what is
  // scoped to document-capable types is the `sandbox` directive, and a raster
  // is not one.
  expect(headers["content-security-policy"]).toBe("frame-ancestors 'self'");
  // And the browser actually decoded what the route streamed.
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
      timeout: DECODE_TIMEOUT_MS,
    })
    .toBeGreaterThan(0);

  // The cost panel: the rule is read off what the table shows.
  const { panel, cells, footerLabel, footerValue } = await readCostTable(page);
  expect(cells.length, "the run made at least one inference call").toBeGreaterThan(0);
  const unpriced = cells.filter((cell) => cell === "—").length;
  const priced = cells.length - unpriced;
  if (priced > 0 && unpriced > 0) {
    // Priced and unrated calls mixed: the sum is a lower bound and must say so.
    expect(footerLabel).toBe("Priced calls only");
    expect(footerLabel).not.toBe("Total");
    expect(footerValue).toMatch(/^\$/);
    await expect(panel.getByText(/partial cost/i)).toBeVisible();
  } else {
    expect(footerLabel).toBe("Total");
    expect(footerValue).toMatch(priced > 0 ? /^\$/ : /^Not priced$/);
    await expect(panel.getByText(/partial cost/i)).toHaveCount(0);
  }
  console.log(
    `[tile e2e] cost panel: ${cells.length} call(s), ${unpriced} unpriced, footer "${footerLabel} ${footerValue}"`,
  );
});
