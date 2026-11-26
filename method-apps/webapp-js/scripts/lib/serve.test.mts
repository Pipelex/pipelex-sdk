// @vitest-environment node
//
// `make serve` and `make stop`, each case against a fake dev server: a process
// that forks a child to listen, as `next dev` forks `next-server`, so that
// stopping "the server" is proven to stop everything it started. Every case
// runs in a checkout of its own, on ports found free, with the real lsof and
// ps, or netstat and PowerShell on Windows, and the cases that need them are
// skipped where they cannot run. The cases that fake a tool with a shell
// script, or that refuse a signal to a process group, run where those exist:
// everywhere but Windows.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commandPaths,
  commandRunsIn,
  commandsFor,
  DEFAULT_CONFIG,
  devCommand,
  devScriptBindsLoopback,
  isLoopbackAddress,
  isLoopbackHost,
  LOCK_FILE,
  lsofUsable,
  MAKE_COMMANDS,
  NoPsError,
  NPM_COMMANDS,
  parseNetstat,
  parseProcessTable,
  parseServeArgs,
  processTableScript,
  processTime,
  psUsable,
  readNetstat,
  serve,
  startTimeOf,
  stop,
  stopSpawned,
  STATE_FILE,
  treeOf,
  withEnvironment,
  type ProcessEntry,
  type ServeConfig,
  type ServeState,
} from "./serve.mts";

// Each case spawns servers and waits on lsof, which is slow on a busy machine.
const SPAWNS = { timeout: 60_000 };

// The cases that start a server read the real lsof. A slim Linux image may not
// ship it, or ship BusyBox's under its name, and `make all` must stay green
// there, so those cases are skipped where no usable lsof is found; the refusal
// `make serve` gives there is tested anyway.
const HAS_LSOF = lsofUsable(DEFAULT_CONFIG.lsof);

// Every case that starts a server reads its start time too, with ps outside
// Linux, and a sandbox may refuse to run it, as Codex's does on macOS. Those
// cases are skipped there, and the refusal is tested with a ps that cannot run.
const HAS_PS = psUsable(DEFAULT_CONFIG.ps);
const CAN_SERVE = HAS_LSOF && HAS_PS;

// Windows has no shell to fake a tool with, and no process groups to refuse a
// signal to, so the cases that need either run everywhere else.
const WINDOWS = process.platform === "win32";
const POSIX = !WINDOWS;

// Only outside Linux is the start time read with ps, so only there does a ps
// that cannot run change what serve does; the cases fake it with a shell
// script, so they also need POSIX.
const READS_PS = process.platform !== "linux" && POSIX;

const TEMPLATE_DEV = "node --experimental-strip-types scripts/run-next.mts dev";

/**
 * The fake dev server. The parent forks a child and stays, as `next dev` does;
 * the child listens on APP_HOST and APP_PORT. Every process appends its pid to
 * `pids` in the directory it runs in. Modes: `ok`, `wide` (binds every
 * interface), `extra` (serves on loopback, and opens a second port on every
 * interface), `silent` (never listens), `slow` (listens after a minute),
 * `exit` (the parent fails at once) and `500` (the page answers 500).
 */
const FAKE_DEV = `
import { fork } from "node:child_process";
import { appendFileSync } from "node:fs";
import http from "node:http";

const [role, mode] = process.argv.slice(2);
appendFileSync("pids", process.pid + "\\n");
const forever = () => setInterval(() => {}, 1 << 30);
if (role === "parent") {
  if (mode === "exit") {
    console.error("fake: cannot start");
    process.exit(3);
  }
  fork(import.meta.filename, ["child", mode], { stdio: "inherit" });
  forever();
} else {
  const listen = () => {
    if (mode === "extra") http.createServer().listen(0, "0.0.0.0");
    http
      .createServer((request, response) => {
        response.statusCode = mode === "500" ? 500 : 200;
        response.setHeader("content-type", "text/html");
        response.end("<html><head><title>Fake &amp; App</title></head><body></body></html>");
      })
      .listen(Number(process.env.APP_PORT), mode === "wide" ? "0.0.0.0" : process.env.APP_HOST);
  };
  if (mode === "silent") forever();
  else if (mode === "slow") setTimeout(listen, 60_000);
  else listen();
}
`;

const dirs: string[] = [];
const holders: ChildProcess[] = [];
let caseStarted = new Date();

beforeEach(() => {
  caseStarted = new Date();
});

// Every process a case left running is killed, and waited for, before its
// directories are removed: Windows refuses to remove a directory a process
// still runs in, or a file it holds open, and a killed process lets go of them
// only once it has ended. On Windows each one is ended with everything under
// it, as `make stop` ends a server there: a console program's own console host
// runs as its child, in its directory, and outlives a process killed alone.
afterEach(async () => {
  const killed: number[] = [];
  for (const dir of dirs) killed.push(...pidsIn(dir));
  for (const holder of holders.splice(0)) {
    if (holder.pid !== undefined) killed.push(WINDOWS ? holder.pid : -holder.pid);
  }
  if (WINDOWS) {
    const running = killed.filter(alive);
    if (running.length > 0) {
      spawnSync("taskkill", ["/T", "/F", ...running.flatMap((pid) => ["/PID", String(pid)])], {
        windowsHide: true,
      });
    }
  }
  for (const pid of killed) kill(pid, "SIGKILL");
  const ended = await allGone(
    killed.map((pid) => Math.abs(pid)),
    10_000,
  );
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      throw new Error(
        `could not remove ${dir}${ended ? "" : ", where a process the case started still runs"}: ` +
          `${(error as Error).message}${leftovers(dir, caseStarted)}`,
        { cause: error },
      );
    }
  }
}, 30_000);

/**
 * What may hold a directory that cannot be removed: what is left in it, and on
 * Windows, where a process's directory cannot be read, every process started
 * since the case began.
 */
function leftovers(dir: string, since: Date): string {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }).map(String);
  } catch (error) {
    entries = [`(unreadable: ${(error as Error).message})`];
  }
  let lines = `\nleft in it: ${entries.length === 0 ? "nothing" : entries.join(", ")}`;
  if (WINDOWS) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$since = [datetime]::Parse('${since.toISOString()}').ToLocalTime().AddSeconds(-1)`,
      "Get-CimInstance -ClassName Win32_Process | Where-Object { $_.CreationDate -ge $since } |",
      "  ForEach-Object { '{0} (parent {1}) {2}: {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine }",
    ].join("\n");
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf-8", windowsHide: true },
    );
    lines +=
      `\nprocesses started since the case began:\n${(result.stdout ?? "").trim() || "none"}` +
      (result.status === 0 ? "" : `\n(PowerShell: ${result.error?.message ?? result.stderr})`);
  }
  return lines;
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function tempDir(prefix: string): string {
  // The real path: on macOS the temporary directory is reached through a
  // symlink, and the system reports a process's directory without it.
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A checkout whose `dev` script is `devScript`, holding the fake dev server. */
function checkoutWith(devScript = TEMPLATE_DEV): string {
  const dir = tempDir("serve-checkout-");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fake", private: true, scripts: { dev: devScript } }),
  );
  writeFileSync(path.join(dir, "fake-dev.mjs"), FAKE_DEV);
  return dir;
}

function pidsIn(dir: string): number[] {
  try {
    return readFileSync(path.join(dir, "pids"), "utf-8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until none of `pids` runs, for `ms` at most, and say whether they are gone. */
async function allGone(pids: readonly number[], ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (pids.some(alive) && Date.now() < deadline) await sleep(50);
  return !pids.some(alive);
}

/** A port nothing listens on, and the one after it, both free. */
async function freePorts(count: number): Promise<number[]> {
  for (;;) {
    const first = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
    const ports = Array.from({ length: count }, (_, i) => first + i);
    if (ports.at(-1)! >= 65536) continue;
    const free = await Promise.all(ports.map(portFree));
    if (free.every(Boolean)) return ports;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function listening(port: number, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await sleep(50);
  }
  throw new Error(`nothing listened on ${port}`);
}

/** Start a process of its own group in `cwd`, as a person or another app would. */
function startOutside(cwd: string, args: readonly string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.unref();
  holders.push(child);
  return child;
}

/**
 * A foreign app: a listener in another directory, running a file of it, so
 * that its directory is named on every system: by its working directory, or on
 * Windows, where that cannot be read, by its command line.
 */
async function foreignHolder(port: number) {
  const dir = tempDir("serve-foreign-");
  const script = path.join(dir, "hold.cjs");
  writeFileSync(script, `require("node:net").createServer().listen(${port}, "127.0.0.1");\n`);
  const holder = startOutside(dir, [script]);
  await listening(port);
  return { dir, pid: holder.pid! };
}

interface Run {
  code: number;
  lines: string[];
  /** The last line printed: the verdict. */
  verdict: string;
}

function configFor(
  checkout: string,
  mode: string,
  ports: readonly number[],
  overrides: Partial<ServeConfig> = {},
): ServeConfig & { lines: string[] } {
  const lines: string[] = [];
  return {
    checkout,
    command: [process.execPath, "fake-dev.mjs", "parent", mode],
    host: "127.0.0.1",
    ports,
    waitMs: 8_000,
    pageMs: 8_000,
    graceMs: 2_000,
    lsof: DEFAULT_CONFIG.lsof,
    ps: DEFAULT_CONFIG.ps,
    commands: MAKE_COMMANDS,
    print: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

async function run(
  action: typeof serve | typeof stop,
  config: ServeConfig & { lines: string[] },
): Promise<Run> {
  config.lines.length = 0;
  const code = await action(config);
  const lines = [...config.lines];
  return { code, lines, verdict: lines.at(-1) ?? "" };
}

/**
 * An lsof that a signal kills, as a terminal's Ctrl-C or hangup would, when its
 * arguments match `pattern`, a shell `case` pattern over them.
 */
function lsofKilledOn(pattern: string): string {
  const lsof = path.join(tempDir("serve-lsof-"), "lsof");
  writeFileSync(
    lsof,
    `#!/bin/sh\ncase " $* " in ${pattern}) kill -INT $$ ;; esac\nexec lsof "$@"\n`,
  );
  chmodSync(lsof, 0o755);
  return lsof;
}

/** A ps that cannot run, as a sandbox's refusal leaves it: the file is there, not executable. */
function psThatCannotRun(): string {
  const ps = path.join(tempDir("serve-ps-"), "ps");
  writeFileSync(ps, '#!/bin/sh\nexec ps "$@"\n');
  chmodSync(ps, 0o644);
  return ps;
}

/**
 * Run `action` while every signal to a process group is refused, as a sandbox
 * refuses one to a group started outside it; asking whether a group runs still
 * answers.
 */
async function refusingGroupSignals<T>(action: () => Promise<T>): Promise<T> {
  const kill = process.kill.bind(process);
  const refusing = vi
    .spyOn(process, "kill")
    .mockImplementation((pid: number, signal?: string | number) => {
      if (pid < 0 && signal !== 0) {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      return kill(pid, signal);
    });
  try {
    return await action();
  } finally {
    refusing.mockRestore();
  }
}

function stateOf(checkout: string): ServeState | undefined {
  const file = path.join(checkout, STATE_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as ServeState) : undefined;
}

describe("the loopback rules", () => {
  it("accepts a loopback host and refuses any other", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "::1", "localhost"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "[::1]", "192.168.1.20", "example.com", "127.0.0.1 ::"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("reads lsof's addresses: loopback is 127.x.x.x or [::1], never a wildcard", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "[::1]"]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
    for (const address of ["*", "[::]", "0.0.0.0", "192.168.1.20", "[::ffff:127.0.0.1]"]) {
      expect(isLoopbackAddress(address), address).toBe(false);
    }
  });

  it("accepts a dev script that binds the host it is given, or loopback itself", () => {
    for (const script of [
      TEMPLATE_DEV,
      `${TEMPLATE_DEV} --turbopack`,
      "next dev -H ${APP_HOST:-127.0.0.1} -p ${APP_PORT:-4300}",
      'next dev -H "${APP_HOST:-127.0.0.1}" -p 4300',
      "next dev --hostname=127.0.0.1",
      "next dev -H localhost",
      "next dev -H ::1 -p 4300",
    ]) {
      expect(devScriptBindsLoopback(script), script).toBe(true);
    }
    for (const script of [
      "next dev",
      "next dev -p 4300",
      "next dev -H 0.0.0.0",
      "next dev -H ${APP_HOST}",
      "next dev -H 127.0.0.10",
      "node --experimental-strip-types scripts/run-next.mts start",
      // run-next hands next its host first, so a host after it would win.
      `${TEMPLATE_DEV} -H 0.0.0.0`,
      `${TEMPLATE_DEV} --hostname=0.0.0.0`,
      `${TEMPLATE_DEV} --turbopack --hostname 0.0.0.0`,
      `${TEMPLATE_DEV} -p 80`,
      "",
    ]) {
      expect(devScriptBindsLoopback(script), script).toBe(false);
    }
  });

  it("reads its arguments, the action first", () => {
    expect(parseServeArgs([])).toEqual({ action: "serve" });
    expect(parseServeArgs(["stop"])).toEqual({ action: "stop" });
    expect(parseServeArgs(["serve", "--host", "::1", "--port", "4305"])).toEqual({
      action: "serve",
      host: "::1",
      port: 4305,
    });
    expect(parseServeArgs(["--port", "43o5"]).port).toBeNaN();
    expect(() => parseServeArgs(["--port"])).toThrow("--port needs a value");
    expect(() => parseServeArgs(["--pot", "1"])).toThrow("unknown argument --pot");
  });

  it("takes APP_HOST and APP_PORT from the environment when no flag names them, outside make", () => {
    const env = { APP_HOST: " 0.0.0.0 ", APP_PORT: "4305" };
    expect(withEnvironment({ action: "serve" }, env)).toEqual({
      action: "serve",
      host: "0.0.0.0",
      port: 4305,
    });
    // A flag wins, a blank value is none, and a value that is no port is refused later.
    expect(withEnvironment({ action: "serve", host: "::1", port: 4301 }, env)).toEqual({
      action: "serve",
      host: "::1",
      port: 4301,
    });
    expect(withEnvironment({ action: "serve" }, { APP_HOST: " ", APP_PORT: "" })).toEqual({
      action: "serve",
    });
    expect(withEnvironment({ action: "serve" }, { APP_PORT: "43o5" }).port).toBeNaN();
    // Under make, the Makefile exports its own defaults under those names and
    // has already turned what the person gave into flags.
    expect(
      withEnvironment({ action: "serve", host: "127.0.0.1" }, { ...env, MAKELEVEL: "1" }),
    ).toEqual({
      action: "serve",
      host: "127.0.0.1",
    });
  });

  it("refuses an APP_HOST beyond loopback from the environment, as npm run serve reads it", async () => {
    const checkout = checkoutWith();
    const host = withEnvironment({ action: "serve" }, { APP_HOST: "0.0.0.0" }).host!;
    const result = await run(serve, configFor(checkout, "ok", await freePorts(1), { host }));
    expect(result.verdict).toMatch(/^refused: not-loopback — APP_HOST=0\.0\.0\.0 /);
    expect(pidsIn(checkout)).toEqual([]);
  });
});

describe("the commands the verdicts name", () => {
  it("names make's commands under make, and npm's everywhere else", () => {
    expect(commandsFor({ MAKELEVEL: "1" })).toEqual(MAKE_COMMANDS);
    expect(commandsFor({})).toEqual(NPM_COMMANDS);
    expect(commandsFor({ MAKELEVEL: " " })).toEqual(NPM_COMMANDS);
    expect(NPM_COMMANDS.stop).toBe("npm run serve -- stop");
  });

  it("starts the dev script through npm, run as npmInvocation runs it", () => {
    const cli = "/usr/lib/node_modules/npm/bin/npm-cli.js";
    expect(devCommand({ npm_execpath: cli })).toEqual([process.execPath, cli, "run", "dev"]);
    expect(devCommand({}).slice(-2)).toEqual(["run", "dev"]);
  });
});

// What serve reads on Windows, held here on every system: the tools' output is
// recorded, so a change to how it is read fails on a Mac as it would on
// Windows.
describe("what Windows says", () => {
  it("reads netstat's listening sockets by their wildcard foreign address, in any locale", () => {
    const output = [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012",
      "  TCP    127.0.0.1:4300         0.0.0.0:0              ABHÖREN         4242",
      "  TCP    127.0.0.1:4300         127.0.0.1:51234        ESTABLISHED     4242",
      "  TCP    [::]:4301              [::]:0                 LISTENING       77",
      "  TCP    [::1]:4302             [::]:0                 LISTENING       78",
      "  UDP    0.0.0.0:5353           *:*                                    1500",
      "",
    ].join("\r\n");
    expect(parseNetstat(output)).toEqual([
      { pid: 1012, pgid: -1, port: 135, address: "0.0.0.0" },
      { pid: 4242, pgid: -1, port: 4300, address: "127.0.0.1" },
      { pid: 77, pgid: -1, port: 4301, address: "[::]" },
      { pid: 78, pgid: -1, port: 4302, address: "[::1]" },
    ]);
    // The wildcards are not loopback; [::1] is, as lsof writes it.
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackAddress("[::]")).toBe(false);
  });

  it("reads the process table PowerShell writes, as a list or a lone object", () => {
    const row = { pid: 4, ppid: 0, started: "2026-11-26T09:00:00.000000Z", command: "" };
    expect(parseProcessTable(`\uFEFF${JSON.stringify([row])}\r\n`)).toEqual([row]);
    expect(parseProcessTable(JSON.stringify(row))).toEqual([row]);
    expect(parseProcessTable(JSON.stringify({ ...row, command: null }))).toEqual([row]);
    expect(parseProcessTable("")).toEqual([]);
  });

  it("spells a start time in the invariant culture, whatever the machine's", () => {
    // The custom format's `:` and `.` would otherwise be the culture's own
    // separators, and its calendar the culture's: neither compares with ISO.
    const script = processTableScript();
    expect(script).toContain("[System.Globalization.CultureInfo]::InvariantCulture");
    expect(script).toContain(`"yyyy-MM-dd'T'HH':'mm':'ss'.'ffffff'Z'"`);
  });

  it("spells a time as the process table does, a second earlier", () => {
    expect(processTime(new Date("2026-11-26T09:00:01.250Z"))).toBe("2026-11-26T09:00:00.250000Z");
  });

  describe("the tree under the process serve started", () => {
    const at = (second: number) => `2026-11-26T09:00:${String(second).padStart(2, "0")}.000000Z`;
    const entry = (pid: number, ppid: number, second: number): ProcessEntry => ({
      pid,
      ppid,
      started: at(second),
      command: `node ${pid}`,
    });
    const pids = (entries: readonly ProcessEntry[]) => entries.map((each) => each.pid).sort();

    it("takes the first process and everything under it", () => {
      const table = [entry(1, 0, 0), entry(10, 1, 10), entry(11, 10, 11), entry(12, 11, 12)];
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10) }))).toEqual([10, 11, 12]);
    });

    it("keeps the members it recorded once their parents have ended, and their children", () => {
      // npm (10) and run-next (11) have ended; next (12) and its worker (13) run on.
      const table = [entry(12, 11, 12), entry(13, 12, 13)];
      const members = [11, 12, 13].map((pid) => ({ pid, started: at(pid) }));
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10), members }))).toEqual([12, 13]);
    });

    it("never adopts a process on the id of a parent that has ended, unrecorded", () => {
      // A record outliving a reboot: its first process's id is now the parent
      // id of Explorer, whose own parent ended at sign-in.
      const explorer = { ...entry(4321, 10, 30), command: "C:\\Windows\\explorer.exe" };
      const table = [explorer, entry(4400, 4321, 31)];
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10) }))).toEqual([]);
      // Nor when the record names members, none of which runs with its start time.
      const members = [{ pid: 4321, started: at(12) }];
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10), members }))).toEqual([]);
    });

    it("never takes a process given the first one's id later, nor its children", () => {
      // 10 ended; its child 11 runs on; 10 was given to a stranger, whose child is 13.
      const table = [entry(10, 1, 20), entry(11, 10, 11), entry(13, 10, 21)];
      const members = [{ pid: 11, started: at(11) }];
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10), members }))).toEqual([11]);
    });

    it("never takes a child older than its parent, which another process with that id left", () => {
      const table = [entry(10, 1, 10), entry(11, 10, 5)];
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10) }))).toEqual([10]);
    });

    it("bounds a first process not yet read by when the start began", () => {
      const table = [entry(10, 1, 10)];
      expect(pids(treeOf(table, { pgid: 10, notBefore: at(9) }))).toEqual([10]);
      expect(pids(treeOf(table, { pgid: 10, notBefore: at(11) }))).toEqual([]);
    });

    it("finds the children of a member seen earlier that has ended since", () => {
      const parent = entry(11, 10, 11);
      const table = [entry(12, 11, 12)];
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10) }))).toEqual([]);
      expect(pids(treeOf(table, { pgid: 10, leaderStart: at(10) }, [parent]))).toEqual([12]);
    });
  });

  it("knows a command line that runs a file of the checkout", () => {
    const checkout = "C:\\Users\\Ada\\my-app";
    for (const command of [
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Ada\\my-app\\node_modules\\next\\dist\\bin\\next dev',
      "node c:/users/ada/MY-APP/fake-dev.mjs child ok",
    ]) {
      expect(commandRunsIn(command, checkout), command).toBe(true);
    }
    // A short 8.3 name, a junction or a subst drive spells the same file another
    // way: each path is resolved, as the system would, before it is compared.
    const resolve = (file: string) =>
      file.replace(/^C:\\Users\\ADA~1\\/i, "C:\\Users\\Ada\\").replace(/^S:\\/i, "C:\\Users\\");
    for (const command of [
      "node C:\\Users\\ADA~1\\my-app\\node_modules\\next\\dist\\bin\\next dev",
      '"C:\\Program Files\\nodejs\\node.exe" "S:\\Ada\\my-app\\fake-dev.mjs" child ok',
    ]) {
      expect(commandRunsIn(command, checkout), command).toBe(false);
      expect(commandRunsIn(command, checkout, resolve), command).toBe(true);
    }
    expect(commandPaths('"C:\\a b\\node.exe" C:\\x\\y.js -H 127.0.0.1 /tmp/z')).toEqual([
      "C:\\a b\\node.exe",
      "C:\\x\\y.js",
      "/tmp/z",
    ]);
    for (const command of [
      "node C:\\Users\\Ada\\my-app2\\server.js",
      "node -e \"require('node:net')\"",
      "",
    ]) {
      expect(commandRunsIn(command, checkout), command).toBe(false);
    }
  });
});

describe("what Windows says, read from the system", () => {
  it("knows a command line that reaches the checkout through a link", () => {
    // A junction on Windows, as %TEMP% may be reached through; a symlink elsewhere.
    const checkout = tempDir("serve-real-");
    writeFileSync(path.join(checkout, "server.js"), "");
    const link = path.join(tempDir("serve-alias-"), "app");
    symlinkSync(checkout, link, WINDOWS ? "junction" : undefined);
    const command = `"${process.execPath}" ${path.join(link, "server.js")} dev`;
    expect(commandRunsIn(command, checkout), command).toBe(true);
    expect(commandRunsIn(`node ${path.join(link, "missing.js")}`, checkout)).toBe(false);
  });

  it("takes a netstat that fails for no answer, never for nothing listening", () => {
    expect(() => readNetstat("netstat-that-is-not-installed")).toThrow(
      /^netstat-that-is-not-installed -ano gave no answer \(/,
    );
    if (WINDOWS) return;
    // It printed a socket, then failed: what it printed is not taken either.
    const failing = path.join(tempDir("serve-netstat-"), "netstat");
    writeFileSync(
      failing,
      "#!/bin/sh\necho '  TCP 0.0.0.0:4300 0.0.0.0:0 LISTENING 1'\necho denied >&2\nexit 1\n",
    );
    chmodSync(failing, 0o755);
    expect(() => readNetstat(failing)).toThrow(/ -ano gave no answer \(it exited 1: denied\)$/);
  });
});

describe("stopping what a start spawned when no tool answers", () => {
  /** A process of its own group, as serve's server is, that runs until killed. */
  function spawned() {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    holders.push(child);
    return child;
  }
  const config = configFor("unused", "ok", []);
  const failing = async (): Promise<never> => {
    throw new NoPsError();
  };

  it("ends the group by force while the process it spawned runs, and says so", async () => {
    const child = spawned();
    await sleep(200);
    const stopped = await stopSpawned(config, { pgid: child.pid! }, () => true, failing);
    expect(stopped.outcome).toBe("unknown");
    expect(stopped.unproven).toMatch(
      /^no start time, so it was ended by force \((taskkill \/T \/F \/PID |kill -- -)\d+\) unread$/,
    );
    expect(await allGone([child.pid!])).toBe(true);
  });

  it("sends nothing once the process it spawned has ended, whose id may name another", async () => {
    const child = spawned();
    await sleep(200);
    const stopped = await stopSpawned(config, { pgid: child.pid! }, () => false, failing);
    expect(stopped.outcome).toBe("unknown");
    expect(stopped.unproven).toMatch(/had already exited, so nothing was sent to what it left$/);
    expect(alive(child.pid!)).toBe(true);
  });

  it("passes on an error that is not a tool's silence", async () => {
    const broken = async (): Promise<never> => {
      throw new Error("bug");
    };
    await expect(stopSpawned(config, { pgid: 1 }, () => true, broken)).rejects.toThrow("bug");
  });
});

// On the Windows CI runner every case that starts a server must run: were
// netstat or PowerShell unusable there, the job would pass with those cases
// skipped and prove nothing. The message carries what each tool answered.
describe.runIf(WINDOWS && process.env.CI === "true")("the tools serve reads on Windows CI", () => {
  it("are usable, so no case that starts a server is skipped", () => {
    const probe = (command: string, args: string[]) => {
      const result = spawnSync(command, args, { encoding: "utf-8", windowsHide: true });
      return {
        command: [command, ...args].join(" "),
        status: result.status,
        error: result.error?.message,
        stdout: (result.stdout ?? "").slice(0, 400),
        stderr: (result.stderr ?? "").slice(0, 400),
      };
    };
    const diagnosis = [
      probe(DEFAULT_CONFIG.lsof, ["-ano", "-p", "TCP"]),
      probe(DEFAULT_CONFIG.ps, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable"]),
    ];
    expect({ lsof: HAS_LSOF, ps: HAS_PS }, JSON.stringify(diagnosis, null, 2)).toEqual({
      lsof: true,
      ps: true,
    });
  });
});

describe("what is refused or answered before a server is looked for", () => {
  it("refuses a host beyond loopback before starting anything", async () => {
    const checkout = checkoutWith();
    const result = await run(
      serve,
      configFor(checkout, "ok", await freePorts(1), { host: "0.0.0.0" }),
    );
    expect(result.code).toBe(1);
    expect(result.verdict).toMatch(/^refused: not-loopback — APP_HOST=0\.0\.0\.0 /);
    expect(pidsIn(checkout)).toEqual([]);
  });

  it("refuses a dev script that binds no loopback host before starting anything", async () => {
    const checkout = checkoutWith("next dev -p ${APP_PORT:-4300}");
    const result = await run(serve, configFor(checkout, "ok", await freePorts(1)));
    expect(result.verdict).toMatch(/^refused: not-loopback — the dev script in package\.json/);
    expect(pidsIn(checkout)).toEqual([]);
  });

  it("refuses without lsof, before starting anything", async () => {
    const checkout = checkoutWith();
    const result = await run(
      serve,
      configFor(checkout, "ok", await freePorts(1), { lsof: "lsof-that-is-not-installed" }),
    );
    expect(result.verdict).toMatch(/^refused: no-lsof — /);
    expect(pidsIn(checkout)).toEqual([]);
  });

  it.skipIf(WINDOWS)(
    "refuses an lsof that does not take lsof's options, before starting anything",
    async () => {
      const checkout = checkoutWith();
      // As BusyBox's does: every option ignored, another format, exit 0.
      const lsof = path.join(tempDir("serve-busybox-"), "lsof");
      writeFileSync(lsof, '#!/bin/sh\necho "1\t/sbin/init\t0\t/dev/null"\n');
      chmodSync(lsof, 0o755);
      const result = await run(serve, configFor(checkout, "ok", await freePorts(1), { lsof }));
      expect(result.verdict).toMatch(/^refused: no-lsof — .*BusyBox/);
      expect(pidsIn(checkout)).toEqual([]);
    },
  );

  it.skipIf(!HAS_LSOF || !READS_PS)(
    "refuses when ps cannot run, before starting anything",
    async () => {
      const checkout = checkoutWith();
      for (const ps of ["ps-that-is-not-installed", psThatCannotRun()]) {
        const result = await run(serve, configFor(checkout, "ok", await freePorts(1), { ps }));
        expect(result.code).toBe(1);
        expect(result.verdict).toMatch(
          /^refused: no-ps — make serve reads when the server's first process started, .* Nothing was started/,
        );
        expect(pidsIn(checkout)).toEqual([]);
      }
    },
  );

  it.skipIf(!HAS_PS)("reads a start time that does not depend on the shell's time zone", () => {
    const zone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = startTimeOf(process.pid);
      process.env.TZ = "Asia/Tokyo";
      expect(startTimeOf(process.pid)).toBe(utc);
      expect(utc).toBeDefined();
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it.skipIf(!READS_PS)(
    "takes a ps killed by a signal for no answer, not for a process that has ended",
    () => {
      const ps = path.join(tempDir("serve-ps-"), "ps");
      writeFileSync(ps, "#!/bin/sh\nkill -INT $$\n");
      chmodSync(ps, 0o755);
      expect(() => startTimeOf(process.pid, ps)).toThrow(/^SIGINT killed ps before it answered$/);
    },
  );

  it.skipIf(!READS_PS)("takes a ps that cannot run for no answer, and says it cannot read", () => {
    expect(psUsable("ps-that-is-not-installed")).toBe(false);
    expect(psUsable(psThatCannotRun())).toBe(false);
    expect(() => startTimeOf(process.pid, psThatCannotRun())).toThrow("no start time");
  });

  it("says so when nothing was started", async () => {
    const checkout = checkoutWith();
    const result = await run(stop, configFor(checkout, "ok", []));
    expect(result.code).toBe(0);
    expect(result.verdict).toBe(
      "not-running — make serve has no server recorded in this checkout.",
    );
  });
});

describe.skipIf(!CAN_SERVE)("make serve", SPAWNS, () => {
  it("starts the server, proves its page, and reports it once", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(2);
    const config = configFor(checkout, "ok", ports);

    const first = await run(serve, config);
    expect(first.code, first.lines.join("\n")).toBe(0);
    expect(first.verdict).toBe(
      `serving http://127.0.0.1:${ports[0]}/ — "Fake & App" (log .serve/server.log); stop it with: make stop`,
    );
    const pids = pidsIn(checkout);
    expect(pids).toHaveLength(2);
    expect(stateOf(checkout)).toMatchObject({ pgid: pids[0], port: ports[0], checkout });

    const second = await run(serve, config);
    expect(second.code).toBe(0);
    expect(second.verdict).toMatch(
      new RegExp(`^already-serving http://127\\.0\\.0\\.1:${ports[0]}/ — "Fake & App"`),
    );
    expect(pidsIn(checkout)).toEqual(pids);

    const stopped = await run(stop, config);
    expect(stopped.verdict).toBe(
      `stopped http://127.0.0.1:${ports[0]}/ (process group ${pids[0]})`,
    );
    expect(await allGone(pids)).toBe(true);
    expect(stateOf(checkout)).toBeUndefined();
  });

  it("stops a server that listens beyond loopback, with its whole group", async () => {
    const checkout = checkoutWith();
    const result = await run(serve, configFor(checkout, "wide", await freePorts(1)));
    expect(result.code).toBe(1);
    expect(result.verdict).toMatch(/^refused: not-loopback — the dev server listened beyond/);
    expect(pidsIn(checkout)).toHaveLength(2);
    expect(await allGone(pidsIn(checkout))).toBe(true);
    expect(stateOf(checkout)).toBeUndefined();
  });

  it("stops a server whose group listens beyond loopback on another port", async () => {
    const checkout = checkoutWith();
    const result = await run(serve, configFor(checkout, "extra", await freePorts(1)));
    expect(result.code).toBe(1);
    expect(result.verdict).toMatch(
      /^refused: not-loopback — the dev server listened beyond this machine \((\*|0\.0\.0\.0):\d+\)/,
    );
    expect(await allGone(pidsIn(checkout))).toBe(true);
    expect(stateOf(checkout)).toBeUndefined();
  });

  it("takes turns with another make serve in the same checkout, so one server runs", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(2);
    const runs = await Promise.all([
      run(serve, configFor(checkout, "ok", ports)),
      run(serve, configFor(checkout, "ok", ports)),
    ]);
    const [second, first] = [...runs].sort((a, b) => a.verdict.localeCompare(b.verdict));
    expect(first.verdict).toMatch(new RegExp(`^serving http://127\\.0\\.0\\.1:${ports[0]}/`));
    expect(second.verdict).toMatch(
      new RegExp(`^already-serving http://127\\.0\\.0\\.1:${ports[0]}/`),
    );
    expect(second.lines[0]).toMatch(/^waiting for another make serve or make stop \(pid \d+\)/);
    const pids = pidsIn(checkout);
    expect(pids).toHaveLength(2);
    expect(stateOf(checkout)?.pgid).toBe(pids[0]);
    expect(existsSync(path.join(checkout, LOCK_FILE))).toBe(false);

    expect((await run(stop, configFor(checkout, "ok", ports))).verdict).toMatch(/^stopped /);
    expect(await allGone(pids)).toBe(true);
  });

  it("refuses while a killed run's lock remains, and starts nothing", async () => {
    const checkout = checkoutWith();
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(path.join(checkout, ".serve"));
    writeFileSync(path.join(checkout, LOCK_FILE), `${gone}\nleft-behind\n`);

    const result = await run(serve, configFor(checkout, "ok", await freePorts(1)));
    expect(result.code).toBe(1);
    expect(result.verdict).toMatch(
      new RegExp(
        `^refused: busy — \\.serve/lock is held by pid ${gone}, which is no longer running`,
      ),
    );
    expect(pidsIn(checkout)).toEqual([]);
    expect(existsSync(path.join(checkout, LOCK_FILE))).toBe(true);
  });

  it.skipIf(WINDOWS)("stops what it started when an error breaks the start", async () => {
    const checkout = checkoutWith();
    // An lsof that stops being runnable once serve looks at the group's
    // sockets, so the look after the page throws.
    const lsof = path.join(tempDir("serve-lsof-"), "lsof");
    writeFileSync(
      lsof,
      '#!/bin/sh\ncase " $* " in *" -g "*" -iTCP "*) chmod -x "$0" ;; esac\nexec lsof "$@"\n',
    );
    chmodSync(lsof, 0o755);

    await expect(serve(configFor(checkout, "ok", await freePorts(1), { lsof }))).rejects.toThrow(
      /EACCES/,
    );
    expect(pidsIn(checkout)).toHaveLength(2);
    expect(await allGone(pidsIn(checkout))).toBe(true);
    expect(stateOf(checkout)).toBeUndefined();
    expect(existsSync(path.join(checkout, LOCK_FILE))).toBe(false);
  });

  it.skipIf(WINDOWS)(
    "stops what it started when a signal kills lsof during the start",
    async () => {
      const checkout = checkoutWith();
      // Killed once serve looks at the group's sockets, after the port opened.
      const lsof = lsofKilledOn(`*" -g "*" -iTCP "*`);

      const result = await run(serve, configFor(checkout, "ok", await freePorts(1), { lsof }));
      expect(result.verdict).toBe(
        "failed: interrupted — SIGINT arrived before the page was proven, so the server was stopped.",
      );
      expect(pidsIn(checkout)).toHaveLength(2);
      expect(await allGone(pidsIn(checkout))).toBe(true);
      expect(stateOf(checkout)).toBeUndefined();
      expect(existsSync(path.join(checkout, LOCK_FILE))).toBe(false);
    },
  );

  it("steps around a port another directory holds, and leaves it alone", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(2);
    const foreign = await foreignHolder(ports[0]);

    const result = await run(serve, configFor(checkout, "ok", ports));
    expect(result.verdict).toMatch(new RegExp(`^serving http://127\\.0\\.0\\.1:${ports[1]}/`));
    expect(alive(foreign.pid)).toBe(true);
  });

  it("refuses a given port another directory holds, naming the holder", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(2);
    const foreign = await foreignHolder(ports[0]);

    const result = await run(serve, configFor(checkout, "ok", ports, { port: ports[0] }));
    expect(result.code).toBe(1);
    // The holder's working directory, or on Windows, where that cannot be read,
    // its command line, which runs a file of that directory.
    expect(result.verdict).toMatch(
      new RegExp(
        `^refused: port-held — port ${ports[0]} is held by pid ${foreign.pid}, running ${WINDOWS ? "" : "in "}`,
      ),
    );
    expect(result.verdict).toContain(foreign.dir);
    expect(pidsIn(checkout)).toEqual([]);
    expect(alive(foreign.pid)).toBe(true);
  });

  it("refuses when every port it may try is held", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(1);
    await foreignHolder(ports[0]);
    const result = await run(serve, configFor(checkout, "ok", ports));
    expect(result.verdict).toMatch(/^refused: port-held — every port from /);
    expect(pidsIn(checkout)).toEqual([]);
  });

  it("stops a server that never opens its port, with every process under it", async () => {
    const checkout = checkoutWith();
    const result = await run(
      serve,
      configFor(checkout, "silent", await freePorts(1), { waitMs: 1_500 }),
    );
    expect(result.code).toBe(1);
    expect(result.verdict).toMatch(/^failed: not-listening — /);
    expect(pidsIn(checkout)).toHaveLength(2);
    expect(await allGone(pidsIn(checkout))).toBe(true);
    expect(stateOf(checkout)).toBeUndefined();
  });

  it("stops a server still starting when the wait ends", async () => {
    const checkout = checkoutWith();
    const result = await run(
      serve,
      configFor(checkout, "slow", await freePorts(1), { waitMs: 1_500 }),
    );
    expect(result.verdict).toMatch(/^failed: not-listening — /);
    expect(await allGone(pidsIn(checkout))).toBe(true);
  });

  it("reports a server that exits before it listens, with the log's tail", async () => {
    const checkout = checkoutWith();
    const result = await run(serve, configFor(checkout, "exit", await freePorts(1)));
    expect(result.code).toBe(1);
    expect(result.verdict).toMatch(/^failed: exited — the dev server exited \(code 3\)/);
    expect(result.lines).toContain("  fake: cannot start");
    expect(stateOf(checkout)).toBeUndefined();
  });

  it("stops a server whose page does not answer 200", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(1);
    const result = await run(serve, configFor(checkout, "500", ports));
    expect(result.code).toBe(1);
    expect(result.verdict).toMatch(
      new RegExp(`^failed: page 500 — http://127\\.0\\.0\\.1:${ports[0]}/ did not answer with 200`),
    );
    expect(await allGone(pidsIn(checkout))).toBe(true);
  });

  it.skipIf(WINDOWS)(
    "keeps the record of a server it could not stop once its start failed",
    async () => {
      const checkout = checkoutWith();
      const config = configFor(checkout, "500", await freePorts(1));
      const result = await refusingGroupSignals(() => run(serve, config));
      const recorded = stateOf(checkout)!;
      expect(result.code).toBe(1);
      expect(result.verdict).toBe(
        `failed: still-running — the server make serve started (process group ${recorded.pgid}) ` +
          "failed to start (failed: page 500), and could not be stopped: the system refused to " +
          "signal it, as a sandbox refuses a signal to a process started outside it. It is still " +
          "running and still recorded in .serve/state.json, so make stop run where it may signal " +
          "the group stops it.",
      );
      expect(pidsIn(checkout).every(alive)).toBe(true);

      expect((await run(stop, config)).verdict).toMatch(/^stopped /);
      expect(await allGone(pidsIn(checkout))).toBe(true);
    },
  );

  it.skipIf(!READS_PS)("names a server it could not stop and never recorded", async () => {
    const checkout = checkoutWith();
    // A ps that answers for serve's own process alone, so the server's start
    // time cannot be read and the server cannot be recorded.
    const ps = path.join(tempDir("serve-ps-"), "ps");
    writeFileSync(
      ps,
      `#!/bin/sh\ncase " $* " in *" ${process.pid} "*) exec ps "$@" ;; esac\nexit 1\n`,
    );
    chmodSync(ps, 0o755);
    const config = configFor(checkout, "ok", await freePorts(1), { ps });

    const result = await refusingGroupSignals(() => run(serve, config));
    const pgid = Number(/process group (\d+)/.exec(result.verdict)?.[1]);
    try {
      expect(result.code).toBe(1);
      expect(result.verdict).toBe(
        `failed: still-running — the server make serve started (process group ${pgid}) failed ` +
          "to start (failed: no-ps), and could not be stopped: the system refused to signal it, " +
          "as a sandbox refuses a signal to a process started outside it. It is still running " +
          `and was never recorded, so make stop cannot find it: stop it with kill -- -${pgid} ` +
          "where that is allowed.",
      );
      expect(stateOf(checkout)).toBeUndefined();
      expect(alive(pgid)).toBe(true);
    } finally {
      if (pgid > 1) kill(-pgid, "SIGKILL");
    }
  });

  it("reports a server a person started here, and make stop leaves it alone", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(2);
    // On the second port, so the walk must find it rather than take the first.
    const person = startOutside(checkout, ["fake-dev.mjs", "parent", "ok"], {
      APP_HOST: "127.0.0.1",
      APP_PORT: String(ports[1]),
    });
    await listening(ports[1]);

    // Reached through a symlink, and, where the disk ignores letter case as
    // macOS's does by default, in another case: the system reports the
    // server's directory as the disk spells it.
    const link = path.join(tempDir("serve-link-"), "checkout");
    // A junction on Windows, which needs no privilege a symlink would.
    symlinkSync(checkout, link, WINDOWS ? "junction" : undefined);
    const spelled = existsSync(link.toUpperCase()) ? link.toUpperCase() : link;
    const config = configFor(spelled, "ok", ports);

    const result = await run(serve, config);
    expect(result.code, result.lines.join("\n")).toBe(0);
    expect(result.verdict).toBe(
      `already-serving http://127.0.0.1:${ports[1]}/ — "Fake & App" (pid ${pidsIn(checkout)[1]}, ` +
        "started outside make serve, so make stop leaves it alone)",
    );
    expect(pidsIn(checkout)).toHaveLength(2);

    const stopped = await run(stop, config);
    expect(stopped.verdict).toMatch(/^not-running — /);
    expect(alive(person.pid!)).toBe(true);
  });

  it("refuses a server a person started here beyond loopback, and leaves it running", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(1);
    const person = startOutside(checkout, ["fake-dev.mjs", "parent", "wide"], {
      APP_PORT: String(ports[0]),
    });
    await listening(ports[0]);

    const result = await run(serve, configFor(checkout, "ok", ports));
    expect(result.verdict).toMatch(/^refused: not-loopback — this checkout's server on port /);
    expect(result.verdict).toContain("still running");
    expect(alive(person.pid!)).toBe(true);
  });
});

describe.skipIf(!CAN_SERVE)("make stop", SPAWNS, () => {
  // A process's working directory cannot be read on Windows, where the record's
  // own checkout stands for it: the case below that names another checkout.
  it.skipIf(WINDOWS)(
    "never signals a recorded group that no longer runs in this checkout",
    async () => {
      const checkout = checkoutWith();
      const elsewhere = tempDir("serve-recycled-");
      const other = startOutside(elsewhere, ["-e", "setInterval(() => {}, 1 << 30)"]);
      await sleep(200);
      mkdirSync(path.join(checkout, ".serve"));
      const recycled: ServeState = {
        pgid: other.pid!,
        leaderStart: startTimeOf(other.pid!)!,
        port: 4300,
        url: "http://127.0.0.1:4300/",
        log: ".serve/server.log",
        checkout,
        startedAt: new Date().toISOString(),
      };
      writeFileSync(path.join(checkout, STATE_FILE), JSON.stringify(recycled));

      const result = await run(stop, configFor(checkout, "ok", []));
      expect(result.verdict).toMatch(
        /^not-running — process group \d+ is no longer the server make serve started here/,
      );
      expect(alive(other.pid!)).toBe(true);
      expect(stateOf(checkout)).toBeUndefined();
    },
  );

  it("never signals a recorded group whose record names another checkout", async () => {
    // A checkout copied with its `.serve/`: the record names the server the
    // original started, which still runs there.
    const original = checkoutWith();
    const copy = checkoutWith();
    const config = configFor(original, "ok", await freePorts(1));
    const started = await run(serve, config);
    expect(started.code, started.lines.join("\n")).toBe(0);
    mkdirSync(path.join(copy, ".serve"));
    writeFileSync(path.join(copy, STATE_FILE), JSON.stringify(stateOf(original)));

    const result = await run(stop, configFor(copy, "ok", []));
    expect(result.verdict).toMatch(
      /^not-running — process group \d+ is no longer the server make serve started here/,
    );
    expect(pidsIn(original).every(alive)).toBe(true);
    expect(stateOf(copy)).toBeUndefined();

    expect((await run(stop, config)).verdict).toMatch(/^stopped /);
    expect(await allGone(pidsIn(original))).toBe(true);
  });

  it.skipIf(WINDOWS)(
    "keeps the record when a signal kills lsof before the group is known",
    async () => {
      const checkout = checkoutWith();
      const config = configFor(checkout, "ok", await freePorts(1));
      const started = await run(serve, config);
      expect(started.code, started.lines.join("\n")).toBe(0);
      const recorded = stateOf(checkout);
      // Killed once asked where the group runs, which is how its owner is known.
      const killing = { ...config, lsof: lsofKilledOn(`*" -g "*" cwd "*`) };

      for (const action of [stop, serve]) {
        const result = await run(action, killing);
        expect(result.verdict).toBe(
          "failed: interrupted — SIGINT killed lsof before it answered, so nothing more was done " +
            "and every running server was left as it was.",
        );
        expect(stateOf(checkout)).toEqual(recorded);
        expect(pidsIn(checkout).every(alive)).toBe(true);
      }

      const stopped = await run(stop, config);
      expect(stopped.verdict).toMatch(/^stopped /);
      expect(await allGone(pidsIn(checkout))).toBe(true);
    },
  );

  it.skipIf(WINDOWS)(
    "keeps the record of a running group none of whose processes lsof can see",
    async () => {
      const checkout = checkoutWith();
      const config = configFor(checkout, "ok", await freePorts(1));
      const started = await run(serve, config);
      expect(started.code, started.lines.join("\n")).toBe(0);
      const recorded = stateOf(checkout)!;
      // An lsof that finds nothing of the group, as one may not look at
      // processes started outside its sandbox.
      const lsof = path.join(tempDir("serve-lsof-"), "lsof");
      writeFileSync(
        lsof,
        `#!/bin/sh\ncase " $* " in *" -g ${recorded.pgid} "*) exit 1 ;; esac\nexec lsof "$@"\n`,
      );
      chmodSync(lsof, 0o755);

      for (const action of [stop, serve]) {
        const result = await run(action, { ...config, lsof });
        expect(result.code).toBe(1);
        expect(result.verdict).toBe(
          `refused: no-lsof — process group ${recorded.pgid}, recorded in .serve/state.json, still ` +
            `runs, but ${lsof} sees none of its processes, so whether it is the server make serve ` +
            "started here cannot be told. Nothing was signalled or started, and the record was " +
            "kept: run make stop where lsof can see it, or remove .serve/state.json if that group " +
            "is not this checkout's server.",
        );
        expect(stateOf(checkout)).toEqual(recorded);
        expect(pidsIn(checkout).every(alive)).toBe(true);
      }

      expect((await run(stop, config)).verdict).toMatch(/^stopped /);
      expect(await allGone(pidsIn(checkout))).toBe(true);
    },
  );

  it.skipIf(!READS_PS)("keeps the record, and the server, when ps cannot run", async () => {
    // Started where ps may run, then stopped where a sandbox refuses it.
    const checkout = checkoutWith();
    const config = configFor(checkout, "ok", await freePorts(1));
    const started = await run(serve, config);
    expect(started.code, started.lines.join("\n")).toBe(0);
    const recorded = stateOf(checkout);
    const refused = { ...config, ps: psThatCannotRun() };

    const stopping = await run(stop, refused);
    expect(stopping.code).toBe(1);
    expect(stopping.verdict).toMatch(
      /^refused: no-ps — make stop signals the recorded process group only once .* Nothing was signalled, and \.serve\/state\.json was kept/,
    );
    expect((await run(serve, refused)).verdict).toMatch(/^refused: no-ps — make serve reads when /);
    expect(stateOf(checkout)).toEqual(recorded);
    expect(pidsIn(checkout).every(alive)).toBe(true);

    expect((await run(stop, config)).verdict).toMatch(/^stopped /);
    expect(await allGone(pidsIn(checkout))).toBe(true);
  });

  it.skipIf(!READS_PS)(
    "clears the record of a server that has ended, even where ps cannot run",
    async () => {
      const checkout = checkoutWith();
      const config = configFor(checkout, "ok", await freePorts(1));
      const started = await run(serve, config);
      expect(started.code, started.lines.join("\n")).toBe(0);
      const recorded = stateOf(checkout)!;
      const pids = pidsIn(checkout);
      for (const pid of pids) kill(pid, "SIGKILL");
      expect(await allGone(pids)).toBe(true);

      const result = await run(stop, { ...config, ps: psThatCannotRun() });
      expect(result.code).toBe(0);
      expect(result.verdict).toBe(
        `not-running — the server make serve started (process group ${recorded.pgid}) has ` +
          "already exited.",
      );
      expect(stateOf(checkout)).toBeUndefined();
    },
  );

  it.skipIf(!READS_PS)(
    "stops a server whose first process has ended without reading a start time",
    async () => {
      const checkout = checkoutWith();
      const config = configFor(checkout, "ok", await freePorts(1));
      const started = await run(serve, config);
      expect(started.code, started.lines.join("\n")).toBe(0);
      const [parent, child] = pidsIn(checkout);
      kill(parent, "SIGKILL");
      expect(await allGone([parent])).toBe(true);
      expect(alive(child)).toBe(true);

      const result = await run(stop, { ...config, ps: psThatCannotRun() });
      expect(result.verdict).toMatch(/^stopped /);
      expect(await allGone([child])).toBe(true);
      expect(stateOf(checkout)).toBeUndefined();
    },
  );

  it.skipIf(!READS_PS)(
    "never takes a start time it cannot read for another process's",
    async () => {
      const checkout = checkoutWith();
      const config = configFor(checkout, "ok", await freePorts(1));
      const started = await run(serve, config);
      expect(started.code, started.lines.join("\n")).toBe(0);
      const recorded = stateOf(checkout)!;
      // A ps that runs, and answers for every process but the group's first,
      // as one that cannot see it would: nothing, and a failure.
      const ps = path.join(tempDir("serve-ps-"), "ps");
      writeFileSync(
        ps,
        `#!/bin/sh\ncase " $* " in *" ${recorded.pgid} "*) exit 1 ;; esac\nexec ps "$@"\n`,
      );
      chmodSync(ps, 0o755);

      for (const action of [stop, serve]) {
        const result = await run(action, { ...config, ps });
        expect(result.code).toBe(1);
        expect(result.verdict).toMatch(
          new RegExp(
            `^refused: no-ps — process group ${recorded.pgid}, recorded in \\.serve/state\\.json, ` +
              "still runs, but when its first process started cannot be read",
          ),
        );
        expect(stateOf(checkout)).toEqual(recorded);
        expect(pidsIn(checkout).every(alive)).toBe(true);
      }

      expect((await run(stop, config)).verdict).toMatch(/^stopped /);
      expect(await allGone(pidsIn(checkout))).toBe(true);
    },
  );

  it.skipIf(WINDOWS)(
    "keeps the record of a server the system refuses to let it signal",
    async () => {
      const checkout = checkoutWith();
      const config = configFor(checkout, "ok", await freePorts(1));
      const started = await run(serve, config);
      expect(started.code, started.lines.join("\n")).toBe(0);
      const recorded = stateOf(checkout)!;
      const [parent, child] = pidsIn(checkout);

      // As a sandbox answers a signal to a group started outside it.
      const kill = process.kill.bind(process);
      const refusing = vi
        .spyOn(process, "kill")
        .mockImplementation((pid: number, signal?: string | number) => {
          if (pid === -recorded.pgid) {
            throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
          }
          return kill(pid, signal);
        });
      try {
        const stopping = await run(stop, config);
        expect(stopping.code).toBe(1);
        expect(stopping.verdict).toBe(
          `failed: still-running — the server make serve started (process group ${recorded.pgid}) ` +
            `serves ${recorded.url}, and could not be stopped: the system refused to signal it, as ` +
            "a sandbox refuses a signal to a process started outside it. It is still running and " +
            "still recorded in .serve/state.json, so make stop run where it may signal the group " +
            "stops it.",
        );
        expect(stateOf(checkout)).toEqual(recorded);

        // Ours, and not listening: serve means to stop it before starting afresh.
        kill(child, "SIGKILL");
        expect(await allGone([child])).toBe(true);
        const serving = await run(serve, config);
        expect(serving.code).toBe(1);
        expect(serving.verdict).toMatch(
          new RegExp(
            "^failed: still-running — the server make serve started \\(process group " +
              `${recorded.pgid}\\) is not listening, and could not be stopped`,
          ),
        );
        expect(stateOf(checkout)).toEqual(recorded);
        expect(alive(parent)).toBe(true);
      } finally {
        refusing.mockRestore();
      }

      const restarted = await run(serve, config);
      expect(restarted.verdict, restarted.lines.join("\n")).toMatch(/^serving /);
      expect(alive(parent)).toBe(false);
      expect((await run(stop, config)).verdict).toMatch(/^stopped /);
    },
  );

  // On Windows, Node ends the children it spawned when it ends (they run in a
  // job it closes), so the fake server's child cannot outlive its parent there;
  // the tree's rule for a member whose parents have ended is tested on every
  // system against a recorded table, above.
  it.skipIf(WINDOWS)(
    "stops a server whose first process has ended, with what it left",
    async () => {
      // The group's first process has ended, and its id may be given to another
      // process: the group is still found by what it left.
      const checkout = checkoutWith();
      const config = configFor(checkout, "ok", await freePorts(1));
      const started = await run(serve, config);
      expect(started.code, started.lines.join("\n")).toBe(0);
      const [parent, child] = pidsIn(checkout);
      kill(parent, "SIGKILL");
      expect(await allGone([parent])).toBe(true);
      expect(alive(child)).toBe(true);

      const result = await run(stop, config);
      expect(result.verdict, result.lines.join("\n")).toMatch(/^stopped /);
      expect(await allGone([child])).toBe(true);
      expect(stateOf(checkout)).toBeUndefined();
    },
  );

  it("never signals a recorded group whose first process is another one, even here", async () => {
    // A stale record whose id now names a process started in this checkout —
    // a shell, an editor, or the make running the command.
    const checkout = checkoutWith();
    const other = startOutside(checkout, ["-e", "setInterval(() => {}, 1 << 30)"]);
    await sleep(200);
    mkdirSync(path.join(checkout, ".serve"));
    const stale: ServeState = {
      pgid: other.pid!,
      leaderStart: "a process that ended long ago",
      port: 4300,
      url: "http://127.0.0.1:4300/",
      log: ".serve/server.log",
      checkout,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(checkout, STATE_FILE), JSON.stringify(stale));

    const result = await run(stop, configFor(checkout, "ok", []));
    expect(result.verdict).toMatch(
      /^not-running — process group \d+ is no longer the server make serve started here/,
    );
    expect(alive(other.pid!)).toBe(true);
    expect(stateOf(checkout)).toBeUndefined();
  });
});

describe.skipIf(!CAN_SERVE)("the command that started it", SPAWNS, () => {
  const LIB = path.join(import.meta.dirname, "serve.mts");

  /** Run serve in a process of its own, as `make serve` does, and hand it back. */
  function serveInProcess(
    checkout: string,
    mode: string,
    ports: readonly number[],
    waitMs: number,
  ) {
    const script = path.join(checkout, "run-serve.mts");
    writeFileSync(
      script,
      `import { serve } from ${JSON.stringify(pathToFileURL(LIB).href)};\n` +
        `process.exitCode = await serve({ checkout: ${JSON.stringify(checkout)}, ` +
        `command: [process.execPath, "fake-dev.mjs", "parent", ${JSON.stringify(mode)}], ` +
        `host: "127.0.0.1", ports: ${JSON.stringify(ports)}, waitMs: ${waitMs}, pageMs: 8000, ` +
        `graceMs: 2000, lsof: ${JSON.stringify(DEFAULT_CONFIG.lsof)}, ` +
        `ps: ${JSON.stringify(DEFAULT_CONFIG.ps)}, commands: ${JSON.stringify(MAKE_COMMANDS)}, ` +
        `print: (line) => console.log(line) });\n`,
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
      cwd: checkout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    return { child, exited, output: () => output };
  }

  it("leaves the server running after the command exits", async () => {
    const checkout = checkoutWith();
    const ports = await freePorts(1);
    const started = serveInProcess(checkout, "ok", ports, 8_000);
    expect(await started.exited, started.output()).toBe(0);
    expect(started.output().trimEnd().split("\n").at(-1)).toMatch(/^serving /);

    const response = await fetch(`http://127.0.0.1:${ports[0]}/`);
    expect(response.status).toBe(200);

    const stopped = await run(stop, configFor(checkout, "ok", ports));
    expect(stopped.verdict).toMatch(/^stopped /);
    expect(await allGone(pidsIn(checkout))).toBe(true);
  });

  // Windows delivers no signal a process can answer when another process sends
  // it, so an interruption there is a Ctrl-C in serve's own console.
  it.skipIf(WINDOWS).each(["SIGINT", "SIGHUP"] as const)(
    "stops what it started when %s interrupts it",
    async (signal) => {
      const checkout = checkoutWith();
      const started = serveInProcess(checkout, "slow", await freePorts(1), 30_000);
      const deadline = Date.now() + 10_000;
      while (!started.output().includes("starting the dev server") && Date.now() < deadline) {
        await sleep(50);
      }
      expect(started.output()).toContain("starting the dev server");
      // serve announces the group as soon as it has spawned the fake server's
      // parent, which forks its child only afterwards. The interruption is sent
      // once both have recorded themselves, so stopping is proven on the child
      // the parent forked as well as on the parent. The wait has a budget of its
      // own, since the announcement may have spent most of the first one.
      const forked = Date.now() + 10_000;
      while (pidsIn(checkout).length < 2 && Date.now() < forked) await sleep(50);
      expect(pidsIn(checkout)).toHaveLength(2);
      started.child.kill(signal);

      expect(await started.exited).toBe(1);
      expect(started.output().trimEnd().split("\n").at(-1)).toMatch(
        `failed: interrupted — ${signal}`,
      );
      expect(pidsIn(checkout)).toHaveLength(2);
      expect(await allGone(pidsIn(checkout))).toBe(true);
      expect(stateOf(checkout)).toBeUndefined();
    },
  );
});
