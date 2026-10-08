/**
 * The `pipelex-sdk` command against its recorded case table, `fixtures/cli-cases.json`.
 *
 * Each case runs the command in-process, in a fresh working directory holding the case's files,
 * with the case's environment and stdin, and with `fetch` answering from the case's recorded
 * routes. So the command runs on the SDK's real client: what is checked is what it sends and what
 * it prints, never which client method it called. The Python SDK's command runs the same table,
 * serving the same answers through its own HTTP mock (`docs/cli.md`, "The case table").
 *
 * A case that uses a field this suite does not know fails rather than being skipped, so a case
 * added to the table for the other language reaches this one.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ignoreClosedPipe } from "../src/cli/io.js";
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
  unreachable?: string;
  lost?: string;
  base64?: string;
  elapsed_ms?: number;
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
  stdin_error?: string;
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
  "stdin_error",
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
  "lost",
  "base64",
  "elapsed_ms",
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

/** A system error as Node raises it: its code, its number and the call that failed. */
function systemError(message: string, code: string, errno: number, syscall: string): Error {
  return Object.assign(new Error(message), { code, errno, syscall });
}

/**
 * Each kind of `unreachable` exchange, a request that never got a connection to answer it, as
 * fetch reports it: undici's failure under fetch's `TypeError`, or the client's own time limit.
 * Each shape was read off Node's own fetch against a local server, a closed port, a listener that
 * never accepts and certificates of a local authority, but for no route to the host or the network,
 * which take the shape every failed `connect` call takes (`docs/cli.md`, "The case table").
 */
const UNREACHABLE: Record<string, () => Error> = {
  refused: () => systemError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", -61, "connect"),
  // A name with several addresses, each refused: Node tries each and reports them together.
  "refused-every-address": () =>
    Object.assign(
      new AggregateError(
        [
          systemError("connect ECONNREFUSED ::1:80", "ECONNREFUSED", -61, "connect"),
          systemError("connect ECONNREFUSED 127.0.0.1:80", "ECONNREFUSED", -61, "connect"),
        ],
        "",
      ),
      { code: "ECONNREFUSED" },
    ),
  "unknown-host": () =>
    systemError("getaddrinfo ENOTFOUND api.test", "ENOTFOUND", -3008, "getaddrinfo"),
  "no-route": () =>
    systemError("connect EHOSTUNREACH 127.0.0.1:80", "EHOSTUNREACH", -65, "connect"),
  "no-network": () =>
    systemError("connect ENETUNREACH 127.0.0.1:80", "ENETUNREACH", -51, "connect"),
  // undici's own connect time limit, ten seconds by default.
  "connect-timeout": () =>
    Object.assign(new Error("Connect Timeout Error (attempted address: api.test:80)"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  "system-connect-timeout": () =>
    systemError("connect ETIMEDOUT 127.0.0.1:80", "ETIMEDOUT", -60, "connect"),
  certificate: () =>
    Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
  // A server that drops the connection during the TLS handshake: the same reset, from the same
  // call, as one that drops it once the request has left.
  "handshake-dropped": () => systemError("read ECONNRESET", "ECONNRESET", -54, "read"),
};

/**
 * Each kind of `lost` exchange but `timeout`, a request that left and whose connection then
 * failed, as undici reports it under fetch's `TypeError`.
 */
const LOST: Record<string, () => Error> = {
  closed: () => Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  reset: () => systemError("read ECONNRESET", "ECONNRESET", -54, "read"),
  "no-route": () => systemError("read EHOSTUNREACH", "EHOSTUNREACH", -65, "read"),
};

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
    private readonly clock: CaseClock,
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
    // The exchange takes this long on the clock the command and the SDK read, at once.
    if (answer.elapsed_ms !== undefined) this.clock.advance(answer.elapsed_ms);
    // The client's own time limit, run out before the connection was made: fetch reports it as it
    // reports one run out once the request has left.
    if (
      answer.unreachable === "timeout-before-connecting" ||
      answer.unreachable === "pool-timeout"
    ) {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (answer.unreachable !== undefined) {
      const failure = UNREACHABLE[answer.unreachable];
      if (failure === undefined) {
        this.problems.push(`${key}, call ${call}: unreachable is "${answer.unreachable}", no kind`);
      } else {
        throw new TypeError("fetch failed", { cause: failure() });
      }
    }
    // The request went out and its answer never came back: the time limit ran out, as the
    // client's own timer reports it, or the connection closed or failed, as undici reports it.
    if (answer.lost === "timeout") throw new DOMException("Request timed out.", "TimeoutError");
    if (answer.lost !== undefined) {
      const failure = LOST[answer.lost];
      if (failure === undefined) {
        this.problems.push(`${key}, call ${call}: lost is "${answer.lost}", no kind`);
      } else {
        throw new TypeError("fetch failed", { cause: failure() });
      }
    }
    const headers = new Headers(answer.headers);
    if (headers.get("content-encoding") === "gzip") {
      // A fetch mock decodes nothing, so a gzip answer, which the table records only broken, fails
      // here as undici fails it: once the headers have arrived, while the body is read.
      const failure = new TypeError("terminated", {
        cause: Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR" }),
      });
      const broken = new ReadableStream({ start: (controller) => controller.error(failure) });
      return new Response(broken, { status: answer.status ?? 200, headers });
    }
    let body: string | Uint8Array<ArrayBuffer> | null = null;
    if (answer.base64 !== undefined) {
      body = Uint8Array.from(Buffer.from(answer.base64, "base64"));
    } else if (answer.body !== undefined) {
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

/**
 * The clock a case runs on: `Date.now`, which the command and the SDK read to time a request,
 * runs as it does, plus the time the case's exchanges have taken (`elapsed_ms`), so that a case
 * can hold an answer that came back half a minute later without waiting for it.
 */
class CaseClock {
  private elapsedMs = 0;

  constructor() {
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + this.elapsedMs);
  }

  advance(ms: number): void {
    this.elapsedMs += ms;
  }
}

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

/**
 * When an interrupt lands outside any request, which the table cannot say: `"before"`, before the
 * command starts, and `"stdin"`, while it reads stdin, the read then completing as a named pipe's
 * would once its writer closes it.
 */
type EarlyInterrupt = "before" | "stdin";

async function runCase(
  testCase: Case,
  root: string,
  early?: EarlyInterrupt,
): Promise<{ outcome: Outcome; api: RecordedApi }> {
  materialize(root, testCase.files ?? []);
  const env = caseEnv(testCase);
  const interrupt = new AbortController();
  if (early === "before") interrupt.abort();
  const api = new RecordedApi(testCase, env, interrupt, new CaseClock());
  vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
  let stdout = "";
  let stderr = "";
  const previous = process.cwd();
  process.chdir(root);
  try {
    const code = await runCommand(testCase.argv, {
      env,
      readStdin: () => {
        if (early === "stdin") interrupt.abort();
        if (testCase.stdin_error !== undefined) {
          const code = testCase.stdin_error;
          return Promise.reject(systemError(`${code}: failed to read`, code, -1, "read"));
        }
        return Promise.resolve(new TextEncoder().encode(testCase.stdin ?? ""));
      },
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

describe("an interrupt that lands before any request", () => {
  // Each case records no route, so any request the command sent would fail it.
  const BUNDLE = 'domain = "receipts"\nmain_pipe = "review_receipt"\n';
  const NO_RUN = "Interrupted. No run was started.\n";
  const scenarios: Array<[string, EarlyInterrupt, Case]> = [
    [
      "sends nothing for a run without inputs, and says no run was started",
      "before",
      {
        name: "early/run",
        summary: "",
        argv: ["run", "--method", "mt_receipts01"],
        expect: { exit_code: 130, stdout: "", stderr: [NO_RUN], stderr_excludes: ["Error"] },
      },
    ],
    [
      "sends no input preparation for a run with inputs",
      "before",
      {
        name: "early/run-with-inputs",
        summary: "",
        argv: ["run", "--method", "receipt-review.mthds", "--inputs", "inputs.json"],
        files: [
          { path: "receipt-review.mthds", text: BUNDLE },
          { path: "inputs.json", text: '{"receipt": "scans/receipt.pdf"}\n' },
          { path: "scans/receipt.pdf", text: "%PDF-1.4\n" },
        ],
        expect: { exit_code: 130, stdout: "", stderr: [NO_RUN] },
      },
    ],
    [
      "sends nothing when the interrupt lands while the inputs are read from stdin",
      "stdin",
      {
        name: "early/stdin",
        summary: "",
        argv: ["run", "--method", "mt_receipts01", "--inputs", "-"],
        stdin: '{"note": "Team lunch"}',
        expect: { exit_code: 130, stdout: "", stderr: [NO_RUN] },
      },
    ],
    [
      "sends no pipe I/O request for --inputs-template",
      "before",
      {
        name: "early/template",
        summary: "",
        argv: ["run", "--method", "mt_receipts01", "--inputs-template"],
        expect: { exit_code: 130, stdout: "", stderr: ["Interrupted.\n"] },
      },
    ],
    [
      "sends nothing for script and writes nothing",
      "before",
      {
        name: "early/script",
        summary: "",
        argv: ["script", "--method", "github.com/acme/methods/receipt-review@v1.0.0"],
        expect: {
          exit_code: 130,
          stdout: "",
          stderr: ["Interrupted. Nothing was written.\n"],
          absent_files: ["receipt-review"],
        },
      },
    ],
  ];

  it.each(scenarios)("%s", async (_title, early, testCase) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipelex-sdk-cli-")));
    try {
      const { outcome, api } = await runCase(testCase, root, early);
      check(testCase, outcome, api);
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
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

  it("drops a closed pipe on both output streams, so a reader that stops early ends nothing", () => {
    const entry = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(entry).toContain("ignoreClosedPipe(process.stdout);");
    expect(entry).toContain("ignoreClosedPipe(process.stderr);");
  });

  it.each(["stdout", "stderr"])("ignores EPIPE on %s and throws any other error", (_stream) => {
    const stream = new EventEmitter();
    ignoreClosedPipe(stream);
    const failure = (code: string): Error => Object.assign(new Error(`write ${code}`), { code });

    expect(() => stream.emit("error", failure("EPIPE"))).not.toThrow();
    expect(() => stream.emit("error", failure("EIO"))).toThrow("write EIO");
  });

  it("is not exported from the package entry", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry)).not.toContain("runCommand");
  });
});
