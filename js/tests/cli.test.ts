/**
 * The `pipelex-sdk` command against its recorded case table, `fixtures/cli-cases.json`.
 *
 * Each case runs the command in-process, in a fresh working directory holding the case's files,
 * with the case's environment and stdin, and with `fetch` answering from the case's recorded
 * routes. So the command runs on the SDK's real client: what is checked is what it sends and what
 * it prints, never which client method it called. The Python twin runs the same table through its
 * own command, serving the same answers through its own HTTP mock (`docs/cli.md`, "The case table").
 *
 * A case that uses a field this suite does not know fails rather than being skipped, so a case
 * added to the table for the other language reaches this one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCommand } from "../src/cli/main.js";
import { SDK_VERSION } from "../src/version.js";

// ── The table's shape ───────────────────────────────────────────────────────────────────────

interface Exchange {
  request_body?: unknown;
  answer?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
  unreachable?: boolean;
}

interface FileEntry {
  path: string;
  text?: string;
  base64?: string;
  symlink?: string;
  directory?: boolean;
}

interface ExpectedFile {
  path: string;
  text: string;
  executable?: boolean;
}

interface Case {
  name: string;
  summary: string;
  argv: string[];
  env?: Record<string, string | null>;
  files?: FileEntry[];
  stdin?: string;
  routes?: Record<string, Exchange[]>;
  interrupt?: { route: string; call: number };
  expect: {
    exit_code: number;
    stdout?: string;
    stdout_includes?: string[];
    stderr?: string[];
    stderr_excludes?: string[];
    files?: ExpectedFile[];
    absent_files?: string[];
  };
}

interface CaseTable {
  about: string[];
  base_url: string;
  env: Record<string, string>;
  placeholders: Record<string, { js: string; python: string }>;
  answers: Record<string, Exchange>;
  cases: Case[];
}

const TABLE: CaseTable = JSON.parse(
  fs.readFileSync(new URL("./fixtures/cli-cases.json", import.meta.url), "utf8"),
) as CaseTable;

// Every field this suite knows how to run. Anything else in the table is a case it cannot run.
const TABLE_FIELDS = ["about", "base_url", "env", "placeholders", "answers", "cases"];
const CASE_FIELDS = [
  "name",
  "summary",
  "argv",
  "env",
  "files",
  "stdin",
  "routes",
  "interrupt",
  "expect",
];
const EXPECT_FIELDS = [
  "exit_code",
  "stdout",
  "stdout_includes",
  "stderr",
  "stderr_excludes",
  "files",
  "absent_files",
];
const FILE_FIELDS = ["path", "text", "base64", "symlink", "directory"];
const EXCHANGE_FIELDS = [
  "request_body",
  "answer",
  "status",
  "headers",
  "body",
  "text",
  "unreachable",
];
const PLACEHOLDER_LANGUAGE = "js";

function unknownFields(value: object, known: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !known.includes(key));
}

/** Every reason this suite cannot run a case as written; empty when it can. */
function unrunnable(testCase: Case): string[] {
  const problems: string[] = [];
  for (const field of unknownFields(testCase, CASE_FIELDS)) problems.push(`case field "${field}"`);
  for (const field of unknownFields(testCase.expect, EXPECT_FIELDS)) {
    problems.push(`expect field "${field}"`);
  }
  if ((testCase.expect.stdout === undefined) === (testCase.expect.stdout_includes === undefined)) {
    problems.push("expect needs exactly one of stdout and stdout_includes");
  }
  for (const file of testCase.files ?? []) {
    for (const field of unknownFields(file, FILE_FIELDS)) problems.push(`file field "${field}"`);
    const kinds = ["text", "base64", "symlink", "directory"].filter(
      (kind) => (file as unknown as Record<string, unknown>)[kind] !== undefined,
    );
    if (kinds.length !== 1) problems.push(`file "${file.path}" needs exactly one kind`);
  }
  for (const [key, exchanges] of Object.entries(testCase.routes ?? {})) {
    for (const exchange of exchanges) {
      for (const field of unknownFields(exchange, EXCHANGE_FIELDS)) {
        problems.push(`exchange field "${field}" on ${key}`);
      }
      if (exchange.answer !== undefined && !Object.hasOwn(TABLE.answers, exchange.answer)) {
        problems.push(`unknown answer "${exchange.answer}" on ${key}`);
      }
    }
  }
  return problems;
}

/** The table's placeholders filled with this language's values, then the SDK's version. */
function fill(text: string): string {
  let filled = text;
  for (const [name, values] of Object.entries(TABLE.placeholders)) {
    if (name !== "SDK_VERSION")
      filled = filled.replaceAll(`{{${name}}}`, values[PLACEHOLDER_LANGUAGE]);
  }
  filled = filled.replaceAll("{{SDK_VERSION}}", SDK_VERSION);
  if (filled.includes("{{")) throw new Error(`an unknown placeholder is left in: ${filled}`);
  return filled;
}

// ── The recorded API ─────────────────────────────────────────────────────────────────────────

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * `fetch` answering from a case's routes. A route is `METHOD /path?query` on the table's base
 * URL; its exchanges answer its calls in order, each once. A request the case did not record, to
 * another origin or without the case's key, is a problem the case reports.
 */
class RecordedApi {
  readonly problems: string[] = [];
  private readonly calls = new Map<string, number>();
  private readonly held: Array<(reason: unknown) => void> = [];

  constructor(
    private readonly testCase: Case,
    private readonly env: Record<string, string>,
    private readonly interrupt: AbortController,
  ) {}

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = `${init.method ?? "GET"} ${url.pathname}${url.search}`;
    if (url.origin !== new URL(TABLE.base_url).origin) {
      this.problems.push(`a request to another origin: ${key} on ${url.origin}`);
      return new Response(null, { status: 599 });
    }
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization !== `Bearer ${this.env.PIPELEX_API_KEY}`) {
      this.problems.push(`${key} was sent without the case's key`);
    }
    const call = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, call);

    const interrupt = this.testCase.interrupt;
    if (interrupt !== undefined && interrupt.route === key && interrupt.call === call) {
      // Interrupt instead of answering, as Ctrl-C would while this request is in flight.
      this.interrupt.abort();
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        this.held.push(reject);
      });
    }

    const exchange = this.testCase.routes?.[key]?.[call - 1];
    if (exchange === undefined) {
      this.problems.push(`an unrecorded request: ${key}, call ${call}`);
      return new Response(JSON.stringify({ detail: "unrecorded" }), { status: 599 });
    }
    if (exchange.request_body !== undefined) {
      const sent = sentBody(init.body);
      if (!jsonEqual(sent, exchange.request_body)) {
        this.problems.push(
          `${key}, call ${call}, sent ${JSON.stringify(sent)} where the case records ` +
            JSON.stringify(exchange.request_body),
        );
      }
    }
    const answer = {
      ...(exchange.answer === undefined ? {} : TABLE.answers[exchange.answer]),
      ...exchange,
    };
    if (answer.unreachable === true) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }
    const headers = new Headers(answer.headers);
    let body: string | null = null;
    if (answer.body !== undefined) {
      body = JSON.stringify(answer.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (answer.text !== undefined) {
      body = answer.text;
    }
    return new Response(body, { status: answer.status ?? 200, headers });
  };

  /** Every recorded exchange the command never asked for. */
  unserved(): string[] {
    const left: string[] = [];
    for (const [key, exchanges] of Object.entries(this.testCase.routes ?? {})) {
      const served = this.calls.get(key) ?? 0;
      if (served < exchanges.length)
        left.push(`${key}: ${exchanges.length - served} never asked for`);
    }
    return left;
  }

  /** Fail the requests left waiting by an interrupt, so their timers are cleared. */
  release(): void {
    for (const reject of this.held) reject(new DOMException("The case is over.", "AbortError"));
  }
}

/** A request body as JSON, without the top-level keys sent as `null`, which mean "absent". */
function sentBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") return body ?? null;
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== null));
}

// ── Running a case ───────────────────────────────────────────────────────────────────────────

function materialize(root: string, files: readonly FileEntry[]): void {
  for (const file of files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (file.directory === true) fs.mkdirSync(target, { recursive: true });
    else if (file.symlink !== undefined) fs.symlinkSync(file.symlink, target);
    else if (file.base64 !== undefined)
      fs.writeFileSync(target, Buffer.from(file.base64, "base64"));
    else fs.writeFileSync(target, file.text ?? "");
  }
}

function caseEnv(testCase: Case): Record<string, string> {
  const env: Record<string, string> = { ...TABLE.env };
  for (const [name, value] of Object.entries(testCase.env ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** Whether each needle appears in `text`, in order, each after the end of the one before. */
function inOrder(text: string, needles: readonly string[]): string | undefined {
  let from = 0;
  for (const needle of needles) {
    const at = text.indexOf(needle, from);
    if (at < 0) return needle;
    from = at + needle.length;
  }
  return undefined;
}

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  root: string;
}

async function runCase(
  testCase: Case,
  root: string,
): Promise<{ outcome: Outcome; api: RecordedApi }> {
  materialize(root, testCase.files ?? []);
  const env = caseEnv(testCase);
  const interrupt = new AbortController();
  const api = new RecordedApi(testCase, env, interrupt);
  vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
  let stdout = "";
  let stderr = "";
  const previous = process.cwd();
  process.chdir(root);
  try {
    const code = await runCommand(testCase.argv, {
      env,
      readStdin: () => Promise.resolve(new TextEncoder().encode(testCase.stdin ?? "")),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
      interrupt: interrupt.signal,
    });
    return { outcome: { code, stdout, stderr, root }, api };
  } finally {
    process.chdir(previous);
    api.release();
  }
}

function check(testCase: Case, outcome: Outcome, api: RecordedApi): void {
  const shown = `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`;
  expect(api.problems, shown).toEqual([]);
  expect(api.unserved(), shown).toEqual([]);
  expect(outcome.code, shown).toBe(testCase.expect.exit_code);
  const expected = testCase.expect;
  if (expected.stdout !== undefined) expect(outcome.stdout).toBe(fill(expected.stdout));
  if (expected.stdout_includes !== undefined) {
    expect(inOrder(outcome.stdout, expected.stdout_includes.map(fill)), shown).toBeUndefined();
  }
  expect(inOrder(outcome.stderr, (expected.stderr ?? []).map(fill)), shown).toBeUndefined();
  for (const excluded of expected.stderr_excludes ?? []) {
    expect(outcome.stderr, shown).not.toContain(fill(excluded));
  }
  for (const file of expected.files ?? []) {
    const target = path.join(outcome.root, file.path);
    expect(fs.readFileSync(target, "utf8")).toBe(fill(file.text));
    if (file.executable === true) expect(fs.statSync(target).mode & 0o100).not.toBe(0);
  }
  for (const absent of expected.absent_files ?? []) {
    expect(fs.existsSync(path.join(outcome.root, absent)), `${absent} exists`).toBe(false);
  }
}

// ── The suites ───────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the case table", () => {
  it("is a table this suite can read", () => {
    expect(unknownFields(TABLE, TABLE_FIELDS)).toEqual([]);
    const names = TABLE.cases.map((testCase) => testCase.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [name, answer] of Object.entries(TABLE.answers)) {
      expect(unknownFields(answer, EXCHANGE_FIELDS), name).toEqual([]);
    }
  });
});

describe("pipelex-sdk, case by case", () => {
  it.each(TABLE.cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    async (_name, testCase) => {
      // A case this suite cannot run fails here, naming what it does not know.
      expect(unrunnable(testCase)).toEqual([]);
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipelex-sdk-cli-")));
      try {
        const { outcome, api } = await runCase(testCase, root);
        check(testCase, outcome, api);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("the command's packaging", () => {
  it("is the package's one bin, an executable Node script", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin: Record<string, string>; exports: Record<string, unknown> };
    // Written without `./`, the form npm keeps: it rewrites `./dist/cli.js` at publish, warning
    // that the script name "was invalid and removed".
    expect(manifest.bin).toEqual({ "pipelex-sdk": "dist/cli.js" });
    // The command is not part of the importable surface.
    expect(Object.keys(manifest.exports)).not.toContain("./cli");
    const entry = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(entry.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("is not exported from the package entry", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry)).not.toContain("runCommand");
  });
});
