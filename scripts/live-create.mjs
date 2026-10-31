#!/usr/bin/env node
/**
 * Take the live proofs of a method-app template's `make create`, each in a fresh copy of it.
 *
 * The method-app templates ship no method, so their `make create` gesture is proven in two
 * halves: offline, inside each template's `make test`, against recorded API responses, and live,
 * against the hosted API, here. A proof copies the template as this checkout holds it, what git
 * tracks or would track, into a temporary directory with a repository of its own, runs the
 * gesture there with the key and the base URL
 * this process was started with, and checks that the copy is what the gesture promised: the
 * project named after the method, the template's own files gone, an env file holding the base
 * URL the run used and an empty key line, and the project working, a page with the method's form
 * for the web app, one run of the command for the CLI (docs/live-create-proofs.md).
 *
 * It is a maintainers' release check, which no template may hold, and the root's `make
 * live-create` runs it once the account check passed, as the registered test account:
 *
 *   test-account run dev-sdk.builder -- make live-create IN=method-apps/cli-python
 *
 *   node scripts/live-create.mjs --template <dir> [--method <method>]...
 *
 * With no --method it takes the template's own proofs, its bundle fixture and a published
 * address. The key is read from PIPELEX_API_KEY only to see that it is set, and never shown; the
 * children inherit it. It exits 0 when every proof passed, 1 when one failed, whose copy is kept
 * and named, and 2 when it cannot start: an unknown argument or template, or no base URL or key.
 * A Ctrl-C, a SIGTERM or a SIGHUP stops the whole run before its next step, with 130, 143 or 129.
 *
 * Zero dependencies; runs on the Node the templates already need.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BASE_URL_ENV = "PIPELEX_BASE_URL";
export const API_KEY_ENV = "PIPELEX_API_KEY";

/**
 * The address both templates' own proofs use for a published method: the first release of
 * `Pipelex/methods` whose `PipeFunc` names its function by its import path, which engines from
 * pipelex 0.87.0 on require. The templates' own docs and recorded responses still name v0.1.1.
 */
const PUBLISHED_ADDRESS = "github.com/Pipelex/methods/text_stats@v0.2.0";

/**
 * Each template's proof: what the gesture must leave behind, from its own `docs/create.md`.
 *
 * - `identity` is the template's package name, which the gesture replaces with the method's.
 * - `removed` are the paths only the template needs, which the gesture deletes; `kept`, the ones
 *   a project keeps.
 * - `install` runs in the copy before the gesture, as a person runs it.
 * - `methods` are the proofs taken when no --method is given, each read from the copy's directory.
 */
export const TEMPLATES = {
  "method-apps/webapp-js": {
    kind: "webapp",
    identity: "pipelex-method-webapp-js",
    title: "Pipelex Method App",
    envFile: ".env.local",
    install: null,
    removed: [".claude/skills/bootstrap", "scripts/create.mts", "docs/create.md"],
    kept: [],
    methods: ["scripts/lib/fixtures/bundles/receipt-review", PUBLISHED_ADDRESS],
  },
  "method-apps/cli-python": {
    kind: "cli",
    identity: "pipelex-method-cli-python",
    envFile: ".env",
    install: ["make", "install"],
    removed: [".claude/skills/bootstrap", "scripts/create.py", "scripts/create_plan.py", "docs/create.md"],
    kept: [".claude/skills/bump-sdk"],
    methods: ["tests/fixtures/bundles/receipt-review", PUBLISHED_ADDRESS],
  },
};

/**
 * The one run each created command is given, by the command's name, which the gesture derives
 * from the method: the option the command must offer for the method's input, and the arguments.
 * The receipt review's input is a `Document`, which the plane hands the model as a file, and the
 * model refuses an image there, so it is given the repository's own sample invoice as a PDF.
 */
export const CLI_RUNS = {
  "receipt-review": {
    option: "--receipts",
    args: ["--receipts", path.join(ROOT, "starter-python", "samples", "sample-invoice.pdf")],
  },
  "text-stats": { option: "--text", args: ["--text", "Hello there. Two sentences."] },
};

/** What the grep of a created CLI skips: the copy's own commit of the template, and bytecode. */
const GREP_SKIPPED = new Set([".venv", ".git", "__pycache__"]);

const STEP_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const SERVER_TIMEOUT_MS = 180_000;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/** A step of a proof that failed, which ends that proof with its message. */
class ProofError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProofError";
  }
}

/** The template and the methods to prove, from the command line. */
export function parseArgs(argv) {
  let template;
  const methods = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--template" || arg === "--method") {
      if (value === undefined || value === "") throw new UsageError(`${arg} needs a value.`);
      if (arg === "--template") template = value.replace(/\/+$/, "");
      else methods.push(value);
      i++;
    } else {
      throw new UsageError(`Unknown argument ${JSON.stringify(arg)}.`);
    }
  }
  const known = Object.keys(TEMPLATES).join(" or ");
  if (template === undefined) throw new UsageError(`Name the template, --template ${known}.`);
  if (!Object.hasOwn(TEMPLATES, template)) {
    throw new UsageError(`${JSON.stringify(template)} is not a method-app template with a create proof: name ${known}.`);
  }
  return { template, methods: methods.length > 0 ? methods : TEMPLATES[template].methods };
}

/**
 * A base URL as every line here shows it: its scheme and host alone, since a URL's credentials,
 * path, query and fragment are where a secret travels, and these lines reach a terminal.
 */
export function shownUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "a value that is not a URL";
  }
}

/** Each value an env file assigns `key`, in order, unquoted. */
export function envAssignments(text, key) {
  const assigns = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=(.*)$`);
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const match = assigns.exec(line);
    if (match) values.push(unquoted(match[1].trim()));
  }
  return values;
}

function unquoted(value) {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value;
}

/**
 * The env file the gesture wrote: readable by its owner alone, with exactly one base URL line,
 * the one the run used, and one empty key line, never the key the run used. A key's value is
 * never shown, only that the line has one.
 */
export function checkEnvFile(copy, file, baseUrl) {
  const full = path.join(copy, file);
  if (!fs.existsSync(full)) return [`${file} was not written`];
  const failures = [];
  const mode = fs.statSync(full).mode & 0o777;
  if ((mode & 0o077) !== 0) failures.push(`${file} is readable beyond its owner, mode ${mode.toString(8)}`);
  const text = fs.readFileSync(full, "utf-8");
  const bases = envAssignments(text, BASE_URL_ENV);
  if (bases.length !== 1) {
    failures.push(`${file} assigns ${BASE_URL_ENV} ${bases.length === 0 ? "nowhere" : `on ${bases.length} lines`}, where the gesture writes one line`);
  } else if (bases[0] !== baseUrl) {
    const found = shownUrl(bases[0]);
    const used = shownUrl(baseUrl);
    const past = found === used ? ", the two differing past the host" : "";
    failures.push(`${file} sets ${BASE_URL_ENV} to ${found}, not to the ${used} the run used${past}`);
  }
  const keys = envAssignments(text, API_KEY_ENV);
  if (keys.length !== 1) {
    failures.push(`${file} assigns ${API_KEY_ENV} ${keys.length === 0 ? "nowhere" : `on ${keys.length} lines`}, where the gesture writes one empty line`);
  } else if (keys[0] !== "") {
    failures.push(`${file} gives ${API_KEY_ENV} a value, which is not shown, where the gesture leaves the line empty for the person's own key`);
  }
  return failures;
}

/** The template's own paths the gesture removes, and the ones the project keeps. */
export function checkPaths(copy, spec) {
  const failures = [];
  for (const removed of spec.removed) {
    if (fs.existsSync(path.join(copy, removed))) failures.push(`${removed} is still there`);
  }
  for (const kept of spec.kept) {
    if (!fs.existsSync(path.join(copy, kept))) failures.push(`${kept} is gone, where the project keeps it`);
  }
  return failures;
}

/** A created web app's name, which must no longer be the template's. */
export function checkWebappIdentity(copy, spec) {
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, "package.json"), "utf-8"));
  const failures = [];
  if (typeof manifest.name !== "string" || manifest.name === "") failures.push("package.json names no package");
  else if (manifest.name === spec.identity) failures.push(`package.json still carries the template's name, ${spec.identity}`);
  return { failures, name: manifest.name };
}

/** The `[project]` name of a pyproject.toml, and the entries of its `[project.scripts]` table. */
export function pyprojectIdentity(text) {
  const tables = new Map();
  let table = "";
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const entry = /^\s*([A-Za-z0-9._-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (entry) {
      if (!tables.has(table)) tables.set(table, []);
      tables.get(table).push({ key: entry[1], value: entry[2] });
    }
  }
  const name = (tables.get("project") ?? []).find((entry) => entry.key === "name")?.value;
  const scripts = (tables.get("project.scripts") ?? []).map(({ key, value }) => ({ command: key, target: value }));
  return { name, scripts };
}

/** Every file under `dir` holding `needle`, as a path from `dir`, the directories named in `skipped` left out at any depth. */
export function filesHolding(dir, needle, skipped = GREP_SKIPPED) {
  const found = [];
  const bytes = Buffer.from(needle);
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) walk(full);
      } else if (entry.isFile() && fs.readFileSync(full).includes(bytes)) {
        found.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * A created CLI's identity: the distribution, the package directory under `src/` and the command
 * named after the method, and the template's import name left nowhere the project keeps.
 */
export function checkCliIdentity(copy, spec) {
  const failures = [];
  const { name, scripts } = pyprojectIdentity(fs.readFileSync(path.join(copy, "pyproject.toml"), "utf-8"));
  const templatePackage = spec.identity.replaceAll("-", "_");
  if (name === undefined) {
    failures.push("pyproject.toml names no [project] name");
    return { failures, command: undefined };
  }
  if (name === spec.identity) failures.push(`pyproject.toml still carries the template's name, ${spec.identity}`);
  const pkg = name.replaceAll("-", "_");
  if (scripts.length !== 1 || scripts[0].command !== name || scripts[0].target !== `${pkg}.cli:main`) {
    const declared = scripts.map((script) => `${script.command} = "${script.target}"`).join(", ") || "nothing";
    failures.push(`[project.scripts] declares ${declared}, where the gesture declares only ${name} = "${pkg}.cli:main"`);
  }
  if (!fs.existsSync(path.join(copy, "src", pkg))) failures.push(`src/${pkg} is not there`);
  const holding = filesHolding(copy, templatePackage);
  if (holding.length > 0) failures.push(`${templatePackage} is still in ${holding.join(", ")}`);
  return { failures, command: name };
}

/** The environment a proof's commands run with: this one, without what the root's make set for itself. */
export function childEnv(env) {
  const child = { ...env };
  // A make started here would read the root make's command-line variables from these.
  for (const name of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"]) delete child[name];
  // The created project is a project of its own: the template's host and port do not reach it.
  for (const name of ["APP_HOST", "APP_PORT"]) delete child[name];
  child.DO_NOT_TRACK = "1";
  return child;
}

/** The signals that stop the whole run, each with the exit status it gives it. */
export const STOP_SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** The temporary directory of the proof in progress, named when a signal stops the run. */
let proofInProgress = null;

/**
 * Stop the run on any of `STOP_SIGNALS`: the dev servers killed, the copy in progress named, and
 * the process gone with the signal's status. A terminal's Ctrl-C reaches every process of the job,
 * so it stops the command a step is running and this process alike, and the next proof must not
 * start: it would spend model calls nobody asked for. Node queues a signal while `spawnSync` holds
 * the event loop, so every command is followed by `settle()`, which hands the loop one turn.
 */
export function stopOnSignals({ onStop = stopServersNow, exit = (code) => process.exit(code) } = {}) {
  for (const [signal, code] of Object.entries(STOP_SIGNALS)) {
    process.once(signal, () => {
      onStop();
      const kept = proofInProgress === null ? "" : ` The copy of the proof in progress is kept at ${proofInProgress}.`;
      console.error(`\nlive-create: stopped by ${signal}.${kept}`);
      exit(code);
    });
  }
}

/** One turn of the event loop, which delivers a signal that arrived while a command ran. */
export function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Run one command of a proof with its output shown, throwing when it fails. */
async function runShown(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", timeout: STEP_TIMEOUT_MS });
  await settle();
  if (result.error !== undefined) throw new ProofError(`${[command, ...args].join(" ")} could not run: ${result.error.message}`);
  if (result.signal !== null) throw new ProofError(`${[command, ...args].join(" ")} was stopped by ${result.signal}`);
  if (result.status !== 0) throw new ProofError(`${[command, ...args].join(" ")} exited ${result.status}`);
}

/** Run one command with its output captured. */
async function runCaptured(command, args, cwd, env, timeout = STEP_TIMEOUT_MS) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf-8", timeout, maxBuffer: 64 * 1024 * 1024 });
  await settle();
  if (result.error !== undefined) throw new ProofError(`${[command, ...args].join(" ")} could not run: ${result.error.message}`);
  return result;
}

/**
 * The template as this checkout holds it, as a git tree: its tracked files with their uncommitted
 * changes and its untracked files git does not ignore, so never an env file or an install. The
 * bump skills take the proofs before they commit, so `HEAD` alone would prove the template they
 * started from. The tree is built in an index of its own, which leaves the checkout's untouched.
 */
export async function templateTree(root, template, env) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "live-create-index-"));
  const indexEnv = { ...env, GIT_INDEX_FILE: path.join(scratch, "index") };
  try {
    const added = await runCaptured("git", ["-C", root, "add", "-A", "--", template], root, indexEnv);
    if (added.status !== 0) throw new ProofError(`git add could not read ${template}: ${added.stderr.trim()}`);
    const written = await runCaptured("git", ["-C", root, "write-tree", `--prefix=${template}/`], root, indexEnv);
    if (written.status !== 0) throw new ProofError(`git write-tree could not write ${template}: ${written.stderr.trim()}`);
    return written.stdout.trim();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The git `tree` written into `copy`, with a repository of its own and its first commit, as a
 * project starts. The commit names its own author, since a machine may give git none outside the
 * repositories it configures.
 */
export async function copyTemplate(root, tree, copy, env) {
  fs.mkdirSync(copy);
  const archive = path.join(path.dirname(copy), "template.tar");
  const archived = await runCaptured("git", ["-C", root, "archive", "--format=tar", "-o", archive, tree], root, env);
  if (archived.status !== 0) throw new ProofError(`git archive ${tree} failed: ${archived.stderr.trim()}`);
  const extracted = await runCaptured("tar", ["-x", "-f", archive, "-C", copy], root, env);
  if (extracted.status !== 0) throw new ProofError(`tar could not extract the template: ${extracted.stderr.trim()}`);
  fs.rmSync(archive);
  const commit = ["-c", "commit.gpgsign=false", "-c", "user.name=live-create", "-c", "user.email=live-create@localhost"];
  for (const args of [["init", "-q"], ["add", "-A"], [...commit, "commit", "-q", "-m", "as copied"]]) {
    const result = await runCaptured("git", args, copy, env);
    if (result.status !== 0) throw new ProofError(`git ${args.join(" ")} failed in the copy: ${result.stderr.trim()}`);
  }
}

/** A port nothing on loopback holds right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The dev servers a proof started, stopped on the way out whatever happens. */
const servers = new Set();

async function stopServer(server) {
  servers.delete(server);
  if (server.exitCode !== null || server.signalCode !== null || server.pid === undefined) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  const signal = (name) => {
    try {
      process.kill(-server.pid, name);
    } catch {
      server.kill(name);
    }
  };
  signal("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  if (server.exitCode === null && server.signalCode === null) signal("SIGKILL");
}

function stopServersNow() {
  for (const server of servers) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Poll the page until the dev server answers it: the first request compiles it. */
async function waitForPage(url, server, output) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new ProofError(`make dev exited (${server.exitCode ?? server.signalCode}) before serving the page:\n${output.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ProofError(`make dev served no page on ${url} within ${SERVER_TIMEOUT_MS / 1000} seconds:\n${output.join("")}`);
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

/** The page the created web app serves: its title, which must no longer be the template's, and the method's form. */
export function checkPage(html, spec) {
  const failures = [];
  const raw = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  const title = raw?.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]);
  if (title === undefined || title.trim() === "") failures.push("the page has no title");
  else if (title === spec.title) failures.push(`the page is still titled ${JSON.stringify(spec.title)}, the template's own title`);
  if (html.includes("No method yet")) failures.push("the page shows the empty state, no method");
  else if (!/<form[\s>]/.test(html)) failures.push("the page shows no form");
  return { failures, title };
}

/**
 * The created web app's page, as `make dev` serves it: started on a free loopback port, read
 * once, then driven by the project's own `e2e/home.spec.ts`, which reuses that server.
 */
async function provePage(copy, spec, env) {
  const port = await freePort();
  const pageEnv = { ...env, APP_HOST: "127.0.0.1", APP_PORT: String(port) };
  // Playwright builds and starts a production server in CI rather than reusing this one.
  delete pageEnv.CI;
  const output = [];
  const server = spawn("npm", ["run", "dev"], { cwd: copy, env: pageEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  servers.add(server);
  const keep = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  server.stdout.on("data", keep);
  server.stderr.on("data", keep);
  try {
    const html = await waitForPage(`http://127.0.0.1:${port}/`, server, output);
    const { failures, title } = checkPage(html, spec);
    const playwright = spawnSync(path.join(copy, "node_modules", ".bin", "playwright"), ["test", "e2e/home.spec.ts"], {
      cwd: copy,
      env: pageEnv,
      stdio: "inherit",
      timeout: STEP_TIMEOUT_MS,
    });
    await settle();
    if (playwright.error !== undefined) failures.push(`playwright could not run: ${playwright.error.message}`);
    else if (playwright.status !== 0) failures.push(`e2e/home.spec.ts failed (exit ${playwright.status ?? playwright.signal})`);
    return { failures, said: `serves ${JSON.stringify(title)} with the method's form` };
  } finally {
    await stopServer(server);
  }
}

/** The created command: its help offers the method's input, and one run prints its result and its report. */
async function proveCommand(copy, command, env) {
  const run = CLI_RUNS[command];
  if (run === undefined) {
    return { failures: [`no run is recorded for the command ${command}: add one to CLI_RUNS in scripts/live-create.mjs`], said: "" };
  }
  const failures = [];
  const bin = path.join(copy, ".venv", "bin", command);
  const help = await runCaptured(bin, ["--help"], copy, env);
  if (help.status !== 0) failures.push(`${command} --help exited ${help.status}:\n${help.stderr}`);
  else if (!help.stdout.includes(run.option)) failures.push(`${command} --help does not list ${run.option}:\n${help.stdout}`);
  console.log(`── ${command} ${run.args.join(" ")}`);
  const result = await runCaptured(bin, run.args, copy, env, RUN_TIMEOUT_MS);
  process.stderr.write(result.stderr);
  let said = "";
  if (result.status !== 0) {
    failures.push(`the run exited ${result.status ?? result.signal}`);
  } else {
    try {
      JSON.parse(result.stdout);
    } catch {
      failures.push(`the run's stdout is not one JSON document:\n${result.stdout}`);
    }
    const runId = /\brun_[0-9A-Za-z-]+/.exec(result.stderr)?.[0];
    if (runId === undefined) failures.push("the run printed no run id on stderr");
    if (!/Total: |No inference calls/.test(result.stderr)) failures.push("the run printed no cost report on stderr");
    said = `ran ${runId ?? "a run"}, its JSON result on stdout`;
  }
  return { failures, said };
}

/** One proof: the template copied, the gesture run with `method`, the copy checked. */
async function prove({ root, tree, template, spec, method, env, baseUrl }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "live-create-"));
  const copy = path.join(parent, "proof");
  const label = `${template}, METHOD=${method}`;
  console.log(`\n── ${label}, in a fresh copy at ${copy}`);
  proofInProgress = parent;
  const failures = [];
  const said = [];
  try {
    await copyTemplate(root, tree, copy, env);
    if (spec.install !== null) await runShown(spec.install[0], spec.install.slice(1), copy, env);
    await runShown("make", ["create", `METHOD=${method}`], copy, env);
    failures.push(...checkPaths(copy, spec), ...checkEnvFile(copy, spec.envFile, baseUrl));
    if (spec.kind === "webapp") {
      const identity = checkWebappIdentity(copy, spec);
      failures.push(...identity.failures);
      said.push(`named ${identity.name}`);
      const page = await provePage(copy, spec, env);
      failures.push(...page.failures);
      said.push(page.said);
    } else {
      const identity = checkCliIdentity(copy, spec);
      failures.push(...identity.failures);
      if (identity.command !== undefined) {
        said.push(`named ${identity.command}`);
        const command = await proveCommand(copy, identity.command, env);
        failures.push(...command.failures);
        said.push(command.said);
      }
    }
  } catch (error) {
    // A step that failed ends the proof with its message; anything else a check threw, such as a
    // manifest the gesture left unreadable, ends it too, with its stack, rather than the run.
    failures.push(error instanceof ProofError ? error.message : `the proof stopped on ${error.stack ?? error}`);
  }
  proofInProgress = null;
  if (failures.length === 0) {
    fs.rmSync(parent, { recursive: true, force: true });
    console.log(`✓ ${label}: ${said.filter(Boolean).join(", ")}`);
    return true;
  }
  console.log(`✗ ${label}:`);
  for (const failure of failures) console.log(`  - ${failure}`);
  console.log(`  The copy is kept for reading at ${copy}; remove ${parent} afterwards.`);
  return false;
}

/** Take every proof the arguments name, one after the other; the exit code. */
export async function main(argv, { env = process.env, root = ROOT } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`live-create: ${error.message}`);
    return 2;
  }
  const baseUrl = env[BASE_URL_ENV];
  if (!baseUrl) {
    console.error(
      `live-create: ${BASE_URL_ENV} is not set. The root's make live-create sets it to the URL its account check ` +
        "decided on, under the workspace's test-account run (docs/live-create-proofs.md).",
    );
    return 2;
  }
  if (!env[API_KEY_ENV]) {
    console.error(
      `live-create: ${API_KEY_ENV} is not set. Run the proofs through the workspace's test-account run, which ` +
        "hands over the key of the test account they act for (docs/live-create-proofs.md).",
    );
    return 2;
  }
  const spec = TEMPLATES[args.template];
  const commandEnv = childEnv(env);
  let tree;
  try {
    tree = await templateTree(root, args.template, commandEnv);
  } catch (error) {
    if (!(error instanceof ProofError)) throw error;
    console.error(`live-create: ${error.message}`);
    return 2;
  }
  const head = (await runCaptured("git", ["-C", root, "rev-parse", "--short", "HEAD"], root, env)).stdout.trim();
  const headTree = (await runCaptured("git", ["-C", root, "rev-parse", `HEAD:${args.template}`], root, env)).stdout.trim();
  if (tree === headTree) {
    console.log(`Proving ${args.template} as HEAD (${head}) holds it, against ${shownUrl(baseUrl)}.`);
  } else {
    console.log(
      `Proving ${args.template} as this checkout holds it, with changes HEAD (${head}) does not hold, against ` +
        `${shownUrl(baseUrl)}. A release ships what HEAD holds, so commit them before a release's proofs.`,
    );
  }
  const verdicts = [];
  for (const method of args.methods) {
    verdicts.push(await prove({ root, tree, template: args.template, spec, method, env: commandEnv, baseUrl }));
  }
  const failed = verdicts.filter((ok) => !ok).length;
  console.log(failed === 0 ? `\nEvery create proof of ${args.template} passed.` : `\n${failed} of the create proofs of ${args.template} failed.`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stopOnSignals();
  process.once("exit", stopServersNow);
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      stopServersNow();
      console.error(error);
      process.exitCode = 2;
    },
  );
}
