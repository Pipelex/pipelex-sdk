/**
 * `make create` — turn this template into the app for one method, in one
 * gesture.
 *
 * A fresh copy of the template is an app with no method and the template's own
 * name. This gesture takes the method the person has — a bundle path, a catalog
 * id or a published address — and leaves the app for it: the method scaffolded
 * by `add-method`, the project named after the method by the bootstrap, an env
 * file written from the shell, and `make all` green. Everything is decided by
 * this script; nothing asks a question. A value that cannot be derived is a
 * refusal naming the flag that supplies it.
 *
 * The order is the safety story, as it is for `add-method`:
 *
 *  1. **Read-only.** Check this is the un-bootstrapped template, resolve the
 *     key and the base URL, run `add-method`'s read-only half (which fetches the
 *     method once — everything below reads that one fetch), derive the app's
 *     name, title and description from it, plan the env file, and run the
 *     bootstrap with `--dry-run`, which validates every value it will be given.
 *     `--dry-run` stops here.
 *  2. **Write.** `add-method`'s write half first — it removes what it wrote if
 *     it fails, so a failure there leaves the template exactly as it was and
 *     the gesture can simply be run again. Then the bootstrap, the env file,
 *     the lock file re-sync, `make all`, and last the bootstrap skill's own
 *     removal, which happens only once the checks are green.
 *
 * The gesture is one-shot, and the template's alone: the bootstrap removes it,
 * with the rest of what only the template needs, from the project it creates.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// `@next/env` is CommonJS — see the note in `generate.mts`.
import nextEnv from "@next/env";
import { DEFAULT_API_BASE_URL } from "@pipelex/sdk";

import {
  AddMethodError,
  METHOD_ARG_FORMS,
  planAddMethod,
  printPlan,
  ReportedFailure,
  resolveDeps,
  respellAcronyms,
  writeAddMethod,
  type AddMethodDeps,
  type AddMethodPlan,
} from "./add-method.mts";
import { methodVocabulary } from "./generate.mts";
import { REPO_ROOT } from "./shared.mts";

const { loadEnvConfig } = nextEnv;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

/** The template's package name: the gesture runs only while `package.json` still says it. */
export const TEMPLATE_NAME = "pipelex-method-webapp-js";

/** The bootstrap script, relative to the repo root. */
export const BOOTSTRAP_SCRIPT = ".claude/skills/bootstrap/scripts/bootstrap.mjs";

/** The bootstrap skill's directory, which the gesture removes once the checks are green. */
export const BOOTSTRAP_DIR = ".claude/skills/bootstrap";

/** The env file the app reads, and the example it is written from. */
export const ENV_FILE = ".env.local";
export const ENV_EXAMPLE = ".env.example";

/** A refusal, printed as one message and exit 1. */
export class CreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateError";
  }
}

// ── The command line ────────────────────────────────────────────────────────

export interface CreateArgs {
  method: string;
  /** The package name. Defaults to the method's slug. */
  name?: string;
  title?: string;
  description?: string;
  /** The method's directory name — `add-method`'s `--name`. */
  methodName?: string;
  pipe?: string;
  label?: string;
  authorName?: string;
  authorEmail?: string;
  repoUrl?: string;
  license?: string;
  licenseHolder?: string;
  licenseYear?: string;
  dryRun: boolean;
}

type ValueFlag = Exclude<keyof CreateArgs, "method" | "dryRun">;

/** Every flag that takes a value, and the field it fills. */
const FLAGS: Record<string, ValueFlag> = {
  "--name": "name",
  "--title": "title",
  "--description": "description",
  "--method-name": "methodName",
  "--pipe": "pipe",
  "--label": "label",
  "--author-name": "authorName",
  "--author-email": "authorEmail",
  "--repo-url": "repoUrl",
  "--license": "license",
  "--license-holder": "licenseHolder",
  "--license-year": "licenseYear",
};

/** The flags passed through to the bootstrap unchanged. */
const BOOTSTRAP_PASSTHROUGH: readonly [ValueFlag, string][] = [
  ["authorName", "--author-name"],
  ["authorEmail", "--author-email"],
  ["repoUrl", "--repo-url"],
  ["license", "--license"],
  ["licenseHolder", "--license-holder"],
  ["licenseYear", "--license-year"],
];

export const USAGE =
  "usage: npm run create -- <path/to/bundle | mt_… | github.com/owner/repo[/package][@tag]> " +
  "[--name <package>] [--title <title>] [--description <text>] [--method-name <dir-name>] " +
  "[--pipe <pipe_code>] [--label <label>] [--author-name <name>] [--author-email <email>] " +
  "[--repo-url <url>] [--license <mit|proprietary|spdx>] [--license-holder <holder>] " +
  "[--license-year <year>] [--dry-run]";

/**
 * Parse the command line. A blank value counts as not given — `make create
 * TITLE=` is how a person clears a variable, not how they ask for an empty
 * title — and a value that looks like the next flag is refused, as
 * `add-method` refuses it.
 */
export function parseCreateArgs(argv: readonly string[]): CreateArgs {
  const values: Partial<Record<ValueFlag, string>> = {};
  let dryRun = false;
  let method: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg in FLAGS) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CreateError(`missing value for ${arg}.\n  ${USAGE}`);
      }
      if (value.trim() !== "") values[FLAGS[arg]!] = value.trim();
      i += 1;
    } else if (arg.startsWith("-")) {
      throw new CreateError(`unknown argument ${JSON.stringify(arg)}.\n  ${USAGE}`);
    } else if (method === undefined) {
      method = arg;
    } else {
      throw new CreateError(
        `unexpected second method ${JSON.stringify(arg)} — an app is created for one; ` +
          `add more afterwards with make add-method.\n  ${USAGE}`,
      );
    }
  }

  if (method === undefined || method.trim() === "") {
    throw new CreateError(`no method given — pass ${METHOD_ARG_FORMS}.\n  ${USAGE}`);
  }
  return { method, ...values, dryRun };
}

// ── The identity ────────────────────────────────────────────────────────────

/** What the bootstrap is told the project is. */
export interface Identity {
  name: string;
  title: string;
  description: string;
}

/** `receipt-review` → `Receipt Review`, the bootstrap's own default for a title. */
export function titleFromName(name: string): string {
  const bare = name.includes("/") ? name.split("/")[1]! : name;
  return bare
    .split(/[-._]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** A description on one line: it lands in `package.json`, `CLAUDE.md` and a meta tag. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Derive the app's identity from the method, each value overridable.
 *
 * - **name** — the method's slug, the same one its directory takes.
 * - **title** — the catalog name of a stored method (a person chose it), else
 *   the name title-cased, which is what the bootstrap would choose itself.
 * - **description** — the catalog description, else the domain's own
 *   description, else the chosen pipe's, else a sentence naming the method.
 */
export function deriveIdentity(plan: AddMethodPlan, args: CreateArgs): Identity {
  const name = args.name ?? plan.names.slug;
  const { prose } = plan.fetched.contracts;
  // A title the caller passed, or a catalog name somebody chose, is left
  // exactly as given; only the one derived from the package name is respelled,
  // so `cv-screening` becomes "CV Screening" where the method's own prose says
  // "CVs" rather than the "Cv Screening" a word-by-word title case produces.
  const title =
    present(args.title) ??
    present(plan.catalog?.name) ??
    respellAcronyms(titleFromName(name), methodVocabulary(prose));
  const description =
    present(args.description) ??
    present(plan.catalog?.description) ??
    present(prose.description) ??
    present(prose.pipeDescriptions[plan.scaffold.pipe.ref]) ??
    `Runs the ${title} method through the Pipelex API.`;
  return { name, title, description };
}

/**
 * A value on one line, or nothing when it is blank: the platform stores an empty
 * name or description as readily as a missing one, and both mean "not given".
 */
function present(value: string | null | undefined): string | undefined {
  const line = oneLine(value ?? "");
  return line === "" ? undefined : line;
}

// ── The env file ────────────────────────────────────────────────────────────

/** What the shell itself set, read before any env file was loaded. */
export interface ShellEnv {
  baseUrl?: string;
  key?: string;
}

/** The env file each value was read from, when the shell did not set it. */
export interface EnvFiles {
  baseUrl?: string;
  key?: string;
}

/** What `.env.local` is written with. */
export interface EnvValues {
  /** The base URL the gesture ran against, whatever set it. */
  baseUrl: string;
  /** The key, when the shell set it. */
  key?: string;
  /** The env file the key was read from, when the shell did not set it. */
  keyFile?: string;
}

/** What the gesture does about `.env.local`. */
export type EnvPlan =
  | { action: "keep"; notes: string[] }
  | { action: "write"; content: string; notes: string[] };

const BASE_URL_KEY = "PIPELEX_BASE_URL";
const API_KEY_KEY = "PIPELEX_API_KEY";

/** Used when the template's `.env.example` is missing. */
const MINIMAL_ENV = `${BASE_URL_KEY}=${DEFAULT_API_BASE_URL}\n${API_KEY_KEY}=\n`;

/**
 * Set `key=value` in dotenv text: the first line assigning `key` is replaced,
 * every later one is dropped, and the line is appended when there is none — so
 * the result assigns it exactly once, whatever the input did.
 */
export function setEnvLine(text: string, key: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new CreateError(`${key} contains a line break, which an env file cannot hold.`);
  }
  const assigns = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  let seen = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (!assigns.test(line)) {
      kept.push(line);
    } else if (!seen) {
      kept.push(`${key}=${value}`);
      seen = true;
    }
  }
  if (!seen) kept.push(`${key}=${value}`);
  return `${kept.join("\n")}\n`;
}

/**
 * Replace every assignment of `key` in dotenv text with one comment line, where
 * the first assignment was, so the file no longer sets it at all.
 */
export function dropEnvLine(text: string, key: string, comment: string): string {
  const assigns = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  let seen = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (!assigns.test(line)) {
      kept.push(line);
    } else if (!seen) {
      kept.push(`# ${comment}`);
      seen = true;
    }
  }
  return `${kept.join("\n")}\n`;
}

/** The env files `next dev` reads, `.env.local` among them. */
const DEV_SERVER_ENV_FILES: ReadonlySet<string> = new Set([
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
]);

/**
 * Whether `make dev` reads this env file. The gesture loads the files a
 * production build reads, as every script here does, so a value can come from
 * `.env.production` or `.env.production.local`, which the dev server never opens.
 */
export function devServerReads(file: string): boolean {
  return DEV_SERVER_ENV_FILES.has(path.basename(file));
}

/**
 * The URL `make dev` will answer on, read from the `APP_HOST` and `APP_PORT`
 * the Makefile exports, with the scripts' own fallbacks for a missing or blank
 * value. A wildcard bind answers on loopback, and an IPv6 address needs
 * brackets. `playwright.config.ts` derives its base URL the same way.
 */
export function appUrl(env: NodeJS.ProcessEnv): string {
  const host = env.APP_HOST?.trim() || "127.0.0.1";
  const port = env.APP_PORT?.trim() || "4300";
  const urlHost =
    host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

/** Where the dev server can find a key that only a production build reads. */
const DEV_KEY_HINT = "put it in .env or .env.development.local before `make dev`";

/**
 * The env file, written from the example. `.env.local` is read before every
 * other env file and its first assignment wins even when empty, so it must not
 * assign what another file supplied, or it hides it:
 *
 * - the base URL is always the one the gesture ran against, on exactly one line;
 * - the key is copied when the shell set it; when it came from another env file,
 *   the line is left out so that file keeps supplying it, and the secret is not
 *   copied; otherwise the example's empty line stays.
 */
export function renderEnvFile(example: string | null, values: EnvValues): string {
  let text = setEnvLine(example ?? MINIMAL_ENV, BASE_URL_KEY, values.baseUrl);
  if (values.key !== undefined) {
    text = setEnvLine(text, API_KEY_KEY, values.key);
  } else if (values.keyFile !== undefined) {
    const comment = devServerReads(values.keyFile)
      ? `${API_KEY_KEY} is read from ${values.keyFile}; a line here would override it.`
      : `${API_KEY_KEY} is read from ${values.keyFile} by a production build only — ` +
        `${DEV_KEY_HINT}. A line here would override it.`;
    text = dropEnvLine(text, API_KEY_KEY, comment);
  }
  return text;
}

/**
 * Decide what happens to `.env.local`. An existing file is the person's and is
 * never touched — only a disagreement with the shell is worth saying, because
 * the app started without that shell variable will read the file instead.
 */
export async function planEnvFile(
  repoRoot: string,
  shell: ShellEnv,
  effectiveBaseUrl: string,
  files: EnvFiles = {},
): Promise<EnvPlan> {
  const envPath = path.join(repoRoot, ENV_FILE);
  if (existsSync(envPath)) {
    const notes = [`${ENV_FILE} exists and is left as it is.`];
    const fileBase = new RegExp(`^\\s*(?:export\\s+)?${BASE_URL_KEY}\\s*=\\s*(.*)$`, "m")
      .exec(await readFile(envPath, "utf-8"))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    if (shell.baseUrl !== undefined && fileBase !== undefined && fileBase !== shell.baseUrl) {
      notes.push(
        `your shell sets ${BASE_URL_KEY}=${shell.baseUrl}, but ${ENV_FILE} says ${fileBase}: ` +
          "the app reads the file whenever the shell does not set it.",
      );
    }
    return { action: "keep", notes };
  }

  const examplePath = path.join(repoRoot, ENV_EXAMPLE);
  const example = existsSync(examplePath) ? await readFile(examplePath, "utf-8") : null;
  const keyFile = shell.key === undefined ? files.key : undefined;
  const content = renderEnvFile(example, { baseUrl: effectiveBaseUrl, key: shell.key, keyFile });
  const baseOrigin =
    shell.baseUrl !== undefined
      ? "from your shell"
      : files.baseUrl !== undefined
        ? `from ${files.baseUrl}`
        : "the default";
  const keyNote =
    shell.key !== undefined
      ? `, and ${API_KEY_KEY} from your shell.`
      : keyFile === undefined
        ? `, and an empty ${API_KEY_KEY} — set one before \`make dev\`.`
        : devServerReads(keyFile)
          ? `, and no ${API_KEY_KEY} line: the key stays in ${keyFile}, which a line here would hide.`
          : `, and no ${API_KEY_KEY} line: the key stays in ${keyFile}, which only a production ` +
            `build reads — ${DEV_KEY_HINT}.`;
  const notes = [
    `${ENV_FILE} is written with ${BASE_URL_KEY}=${effectiveBaseUrl} (${baseOrigin})${keyNote}`,
  ];
  return { action: "write", content, notes };
}

// ── The orchestration ───────────────────────────────────────────────────────

/** Runs a command with its output shown, returning its exit status. */
export type RunCommand = (command: string, args: readonly string[], cwd: string) => number;

export interface CreateDeps {
  repoRoot: string;
  /** What the shell set, before any env file was read. */
  shell: ShellEnv;
  /** The env file each value the shell did not set was read from. */
  envFiles?: EnvFiles;
  /** The client, base URL and bundle-path base `add-method` runs with. */
  addMethod: AddMethodDeps;
  run: RunCommand;
  /** How to invoke npm: the `npm_execpath` a `npm run` sets, or `npm` on the PATH. */
  npm: { command: string; args: string[] };
}

/** Refuse anything but the un-bootstrapped template, before any fetch. */
export async function assertTemplate(repoRoot: string): Promise<void> {
  let name: unknown;
  try {
    name = (
      JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf-8")) as {
        name?: unknown;
      }
    ).name;
  } catch {
    throw new CreateError(
      `no readable package.json in ${repoRoot} — run this from the app's root.`,
    );
  }
  if (name !== TEMPLATE_NAME) {
    throw new CreateError(
      `this is not the un-bootstrapped template: package.json names ${JSON.stringify(name)}, ` +
        `not "${TEMPLATE_NAME}". create is one-shot and has already run, or the project was ` +
        "bootstrapped by hand — add a method to it with `make add-method` instead.",
    );
  }
  if (!existsSync(path.join(repoRoot, BOOTSTRAP_SCRIPT))) {
    throw new CreateError(
      `${BOOTSTRAP_SCRIPT} is missing, and create runs it to name the project. ` +
        "Restore it from the template, or add the method with `make add-method`.",
    );
  }
}

/** The bootstrap's command line for this identity, without `--dry-run`. */
export function bootstrapArgs(repoRoot: string, identity: Identity, args: CreateArgs): string[] {
  const argv = [
    path.join(repoRoot, BOOTSTRAP_SCRIPT),
    "--root",
    repoRoot,
    "--name",
    identity.name,
    "--title",
    identity.title,
    "--description",
    identity.description,
    // A created project is not a template, and the template's charter paragraph
    // would steer every later agent session toward maintaining one.
    "--clean",
  ];
  for (const [field, flag] of BOOTSTRAP_PASSTHROUGH) {
    const value = args[field];
    if (value !== undefined) argv.push(flag, value);
  }
  return argv;
}

/**
 * The whole `make create` behavior, exit code included. Never throws: a
 * refusal is a printed message and exit 1.
 */
export async function runCreate(argv: readonly string[], deps?: CreateDeps): Promise<number> {
  try {
    return await runCreateInner(argv, deps);
  } catch (error) {
    if (error instanceof ReportedFailure) return EXIT_FAILED;
    if (error instanceof CreateError || error instanceof AddMethodError) {
      console.error(`create: ${error.message}`);
      return EXIT_FAILED;
    }
    console.error(`create: ${error instanceof Error ? error.stack : String(error)}`);
    return EXIT_FAILED;
  }
}

/** Run a command inheriting this process's output, and read its exit status. */
export const runInherited: RunCommand = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(`create: could not run ${command}: ${result.error.message}`);
    return EXIT_FAILED;
  }
  return result.status ?? EXIT_FAILED;
};

/**
 * The deps a real run uses. The shell's own values are read first, because the
 * env files loaded next would otherwise be indistinguishable from them — and
 * the gesture copies a key only from the shell. For a value the shell did not
 * set, the file it came from is recorded, so `.env.local` does not hide it.
 */
export function resolveCreateDeps(repoRoot: string = REPO_ROOT): CreateDeps {
  const shell: ShellEnv = {
    baseUrl: process.env.PIPELEX_BASE_URL || undefined,
    key: process.env.PIPELEX_API_KEY || undefined,
  };
  const { loadedEnvFiles } = loadEnvConfig(repoRoot, false, {
    info: () => {},
    error: console.error,
  });
  // The files come in precedence order, and the first one assigning a
  // variable is the one that set it — even to an empty value.
  const fileOf = (variable: string): string | undefined => {
    const file = loadedEnvFiles.find((loaded) => loaded.env[variable] !== undefined);
    return file?.env[variable] ? file.path : undefined;
  };
  const envFiles: EnvFiles = {
    baseUrl: shell.baseUrl === undefined ? fileOf(BASE_URL_KEY) : undefined,
    key: shell.key === undefined ? fileOf(API_KEY_KEY) : undefined,
  };
  if (!process.env.PIPELEX_API_KEY) {
    throw new CreateError(
      `${API_KEY_KEY} is not set. Export it in your shell — create copies it into ${ENV_FILE} ` +
        `— or put it in ${ENV_FILE} yourself.`,
    );
  }
  const npmExecPath = process.env.npm_execpath;
  return {
    repoRoot,
    shell,
    envFiles,
    addMethod: resolveDeps(repoRoot),
    run: runInherited,
    npm:
      npmExecPath !== undefined && npmExecPath.endsWith(".js")
        ? { command: process.execPath, args: [npmExecPath] }
        : { command: "npm", args: [] },
  };
}

async function runCreateInner(argv: readonly string[], given?: CreateDeps): Promise<number> {
  const args = parseCreateArgs(argv);
  const repoRoot = given?.repoRoot ?? REPO_ROOT;
  await assertTemplate(repoRoot);
  const deps = given ?? resolveCreateDeps(repoRoot);
  const { run } = deps;

  // ── Read-only half ──
  const plan = await planAddMethod(
    {
      method: args.method,
      pipe: args.pipe,
      name: args.methodName,
      label: args.label,
      dryRun: args.dryRun,
    },
    deps.addMethod,
    { nameFlag: "--method-name" },
  );
  const identity = deriveIdentity(plan, args);
  const envPlan = await planEnvFile(repoRoot, deps.shell, deps.addMethod.baseUrl, deps.envFiles);
  const bootstrap = bootstrapArgs(repoRoot, identity, args);

  console.log(`create: ${identity.title}`);
  console.log(`  package:     ${identity.name}`);
  console.log(`  description: ${identity.description}`);
  printPlan(plan);
  for (const warning of plan.warnings) console.log(`\n! ${warning}`);
  for (const note of envPlan.notes) console.log(`  env:    ${note}`);

  console.log("\ncreate: checking the project values with the bootstrap (--dry-run)\n");
  if (run(process.execPath, [...bootstrap, "--dry-run"], repoRoot) !== 0) {
    throw new CreateError(
      "the bootstrap refused these values (see above). Nothing was written; pass the flag " +
        "that fixes it — --name, --title, --description, or one of the --author-*, " +
        "--repo-url and --license* flags.",
    );
  }

  const steps = [
    `scaffold the method (${plan.paths.methodDir}/, ${plan.paths.generatedDir}/, the app files, src/methods.ts)`,
    "run the bootstrap with the values above",
    envPlan.action === "write" ? `write ${ENV_FILE}` : `leave ${ENV_FILE} as it is`,
    "re-sync package-lock.json (npm install --package-lock-only)",
    "run make all",
    `remove ${BOOTSTRAP_DIR}/ once make all is green`,
  ];
  if (args.dryRun) {
    console.log("\nWould then:");
    steps.forEach((step, at) => console.log(`  ${at + 1}. ${step}`));
    console.log("\nNothing was written (--dry-run).");
    return EXIT_OK;
  }

  // ── Write half ──
  console.log(`\ncreate: 1/${steps.length} ${steps[0]}`);
  await writeAddMethod(plan, deps.addMethod);

  console.log(`\ncreate: 2/${steps.length} ${steps[1]}\n`);
  if (run(process.execPath, bootstrap, repoRoot) !== 0) {
    throw new CreateError(
      "the bootstrap failed after the method was added (see above). The slice is in place; " +
        `fix the cause, then run the bootstrap by hand:\n  node ${bootstrap.map(quote).join(" ")}\n` +
        `  then \`npm install --package-lock-only\`, \`make all\`, and \`rm -rf ${BOOTSTRAP_DIR}\`.`,
    );
  }

  console.log(`\ncreate: 3/${steps.length} ${steps[2]}`);
  if (envPlan.action === "write") {
    await writeFile(path.join(repoRoot, ENV_FILE), envPlan.content, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  const remaining = (from: number): string =>
    [
      "npm install --package-lock-only",
      "make all",
      `rm -rf ${BOOTSTRAP_DIR}   # once make all is green`,
    ]
      .slice(from)
      .map((line) => `  ${line}`)
      .join("\n");

  console.log(`\ncreate: 4/${steps.length} ${steps[3]}\n`);
  if (run(deps.npm.command, [...deps.npm.args, "install", "--package-lock-only"], repoRoot) !== 0) {
    throw new CreateError(
      "re-syncing package-lock.json failed (see above). The project is created; finish with:\n" +
        remaining(0),
    );
  }

  console.log(`\ncreate: 5/${steps.length} ${steps[4]}\n`);
  if (run("make", ["all"], repoRoot) !== 0) {
    throw new CreateError(
      "make all is red (see above). The project is created and nothing is committed; fix the " +
        "cause — never by editing src/generated/ — then finish with:\n" +
        remaining(1),
    );
  }

  console.log(`\ncreate: 6/${steps.length} ${steps[5]}`);
  await rm(path.join(repoRoot, BOOTSTRAP_DIR), { recursive: true, force: true });

  console.log(
    [
      "",
      `create: done — ${identity.title} (${identity.name}) runs ${plan.describe}.`,
      "",
      "Nothing is committed: review with `git status` and `git diff`, then commit.",
      "",
      "Next:",
      `  make dev                  # ${appUrl(process.env)}`,
      "  make serve                # the same server in the background, proven; make stop stops it",
      "  make add-method METHOD=…  # a second method, as a tab beside the first",
      "  npm run codegen           # after editing the method, or bumping its tag",
    ].join("\n"),
  );
  return EXIT_OK;
}

/** Quote one argument for a line the person may paste into a shell. */
function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}
