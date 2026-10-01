/**
 * `make serve` and `make stop` — the dev server in the background, proven.
 *
 * `make dev` holds a terminal. `make serve` starts the same dev server detached,
 * waits for its port, checks that the listener is the server it started and
 * that it listens on this machine alone, requests the page, and prints the URL
 * with the page's title. `make stop` stops what it started. Both stay in every
 * project, because a detached, proven server is as useful to a person or an
 * agent working on the app as it is right after the project is created.
 *
 * Every outcome is one verdict line, printed last, whose first word is stable:
 *
 *   serving, already-serving                     the page answered
 *   refused: not-loopback, refused: port-held,   nothing was started
 *   refused: no-lsof, refused: no-ps,
 *   refused: bad-port, refused: busy
 *   failed: not-listening, failed: exited,       what was started is stopped
 *   failed: page <status>, failed: no-ps,
 *   failed: interrupted
 *   failed: still-running                        a server of serve's that it
 *                                                meant to stop still runs, and
 *                                                stays recorded if it was
 *   stopped, not-running                         make stop
 *
 * These rules make the verdict true rather than hopeful:
 *
 *  - **Loopback, before and after.** The app's Server Actions run methods with
 *    the key in the server's environment and nothing authenticates the browser
 *    calling them, so a server anyone on the network can reach spends the key
 *    for them from the moment its port opens. A host that is not loopback is
 *    refused before anything starts, and so is a `dev` script that does not bind
 *    the host it is given. Once the port opens, every socket the server's
 *    process group listens on, whatever its port, must be loopback, or the
 *    group is stopped.
 *  - **A process group of its own.** The server is spawned in a new session, so
 *    the terminal's hangup does not reach it, and everything it starts shares
 *    its group. Stopping is one signal to the group, then a hard stop after a
 *    grace period.
 *  - **A recorded group is signalled only while it is provably serve's.**
 *    `.serve/state.json` records the group and when its first process started.
 *    A process id is reused once its process ends, so the group is taken for
 *    the one serve started only while that first process, if it still runs,
 *    started when the record says, and one of the group's processes runs in
 *    this checkout: a stale record whose id now names a shell, an editor or the
 *    very `make` running the command is never signalled. A start time that
 *    cannot be read proves neither way, and nor does a running group none of
 *    whose processes `lsof` can see, so the record is kept and nothing is
 *    signalled.
 *  - **A record goes only with its server.** It is removed once its group has
 *    ended or is proven another's, never on a stop the system refused, as a
 *    sandbox refuses to signal a process started outside it: the record is how
 *    a later `make stop` finds the server.
 *  - **One run at a time.** A serve or a stop holds `.serve/lock` from its first
 *    look at the state to its verdict, so two never undo each other. One that
 *    finds it held waits, and a second `make serve` then reports the server the
 *    first one proved.
 *  - **The holder is known by its group.** A listener on the port belongs to the
 *    server serve started when it is in that group; a path is compared only to
 *    recognise a server a person started from this checkout, and then against
 *    the checkout's real path, in the letter case the disk has.
 *  - **Nothing unproven is left running.** A server whose port does not open in
 *    time, that exits, whose page does not answer `200`, or whose start is
 *    interrupted or broken by an error, is stopped with every process under it,
 *    and one the system will not let serve stop is reported as still running,
 *    never as stopped.
 *
 * Serve never stops what it did not start: a server a person started from this
 * checkout is reported and left alone, and a port another directory holds is
 * stepped around or refused, never taken.
 *
 * It needs `lsof`, and refuses without it rather than passing silently as
 * `port-check` does, since a proof that cannot check the listener is not one.
 * It needs a process's start time too, read from `/proc` on Linux and with
 * `ps` elsewhere, and refuses before anything starts when it cannot read its
 * own, as in a sandbox that will not run `ps`: the server it started could not
 * be told from a process given the same id later, so it could not be stopped.
 * An `lsof` or `ps` killed by a signal has not answered either: the terminal's
 * Ctrl-C or hangup reaches them as it reaches serve, and their silence read as
 * "nothing runs" would take a running server for gone and drop its record. So
 * serve stops there, with the interruption as its verdict.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// The project's root, anchored on this file as `shared.mts` anchors its own.
// Not imported from there, because that module loads the SDK, and serving the
// app should need nothing but Node and the app's own dev server.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Where serve keeps its state and the server's log, relative to the checkout. */
export const SERVE_DIR = ".serve";
export const STATE_FILE = path.join(SERVE_DIR, "state.json");
export const LOG_FILE = path.join(SERVE_DIR, "server.log");
/** Held while a serve or a stop runs, so that two never interleave in one checkout. */
export const LOCK_FILE = path.join(SERVE_DIR, "lock");

/** The ports tried in turn when none is given, as `next dev` and Vite walk theirs. */
export const DEFAULT_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 4300 + i);

export const USAGE =
  "usage: serve.mts [serve] [--host <loopback host>] [--port <port>]\n       serve.mts stop";

export interface ServeConfig {
  /** The project's root: where the server runs and `.serve/` lives. */
  checkout: string;
  /** What starts the dev server, run in the checkout with `APP_HOST` and `APP_PORT` set. */
  command: readonly string[];
  /** `APP_HOST` as given; blank is the default, `127.0.0.1`. */
  host: string;
  /** A port the person named: the only one tried. */
  port?: number;
  /** The ports tried in turn when none is named. */
  ports: readonly number[];
  /** How long the port may take to open. */
  waitMs: number;
  /** How long the page may take to answer, first compilation included. */
  pageMs: number;
  /** How long a stopped group has between the polite signal and the hard one. */
  graceMs: number;
  /** The `lsof` to run; a test names one that does not exist. */
  lsof: string;
  /** The `ps` that reads a start time where `/proc` does not; a test names one that cannot run. */
  ps: string;
  print: (line: string) => void;
}

export const DEFAULT_CONFIG: ServeConfig = {
  checkout: REPO_ROOT,
  command: ["npm", "run", "dev"],
  host: "127.0.0.1",
  ports: DEFAULT_PORTS,
  waitMs: 60_000,
  pageMs: 120_000,
  graceMs: 5_000,
  lsof: "lsof",
  ps: "ps",
  print: (line) => console.log(line),
};

/** What `.serve/state.json` records about the server serve started. */
export interface ServeState {
  pgid: number;
  /** When the group's first process started, as `startTimeOf` reads it. */
  leaderStart: string;
  port: number;
  url: string;
  log: string;
  checkout: string;
  startedAt: string;
}

/**
 * An lsof serve cannot read: missing, or not taking lsof's options, or, with
 * `pgid`, one that sees none of a recorded group's processes while the group
 * still runs.
 */
class NoLsofError extends Error {
  readonly pgid?: number;
  constructor(pgid?: number) {
    super(pgid === undefined ? "no usable lsof" : `lsof sees no process of group ${pgid}`);
    this.pgid = pgid;
  }
}

/**
 * A start time serve needs and cannot read: its own process's, when `ps` cannot
 * run here at all, or, with `pid`, that of a recorded group's first process,
 * which still runs.
 */
class NoPsError extends Error {
  readonly pid?: number;
  constructor(pid?: number) {
    super(pid === undefined ? "no start time" : `no start time for pid ${pid}`);
    this.pid = pid;
  }
}

/** An `lsof` or `ps` serve ran was killed by a signal, so it gave no answer. */
class HelperKilledError extends Error {
  readonly signal: NodeJS.Signals;
  constructor(helper: string, signal: NodeJS.Signals) {
    super(`${signal} killed ${helper} before it answered`);
    this.signal = signal;
  }
}

// ── Hosts and addresses ─────────────────────────────────────────────────────

/**
 * Whether `APP_HOST` keeps the server on this machine: an address in
 * 127.0.0.0/8, `::1` or `localhost`, as the Makefile's warning reads it. Next
 * takes an IPv6 host bare, so `[::1]` is not a spelling of loopback here.
 */
export function isLoopbackHost(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1" || host === "localhost";
}

/**
 * Whether an address `lsof -n` reports for a listening socket is loopback:
 * `127.x.x.x` or `[::1]`. A wildcard (`*`) or any other address is not.
 */
export function isLoopbackAddress(address: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || address === "[::1]";
}

/**
 * Whether a `dev` script binds the host it is given, or a loopback address of
 * its own: `next dev` given no `-H` listens on every interface, and no
 * environment variable changes that.
 */
export function devScriptBindsLoopback(script: string): boolean {
  return /(^|\s)(-H|--hostname)(\s+|=)("?)(\$\{APP_HOST:-127\.0\.0\.1\}|127\.0\.0\.1|localhost|::1)\4(\s|$)/.test(
    script,
  );
}

function urlOf(address: string, port: number): string {
  return `http://${address}:${port}/`;
}

// ── What lsof says ──────────────────────────────────────────────────────────

/** One listening socket: the process, its group, and the address it is bound to. */
export interface Listener {
  pid: number;
  pgid: number;
  port: number;
  address: string;
}

/** Run lsof and return its field output; a missing lsof throws `NoLsofError`. */
function runLsof(lsof: string, args: readonly string[]): string {
  const result = spawnSync(lsof, args, { encoding: "utf-8" });
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") throw new NoLsofError();
    throw result.error;
  }
  if (result.signal !== null) throw new HelperKilledError("lsof", result.signal);
  // lsof exits 1 when nothing matched, which is an answer, not a failure.
  return result.stdout;
}

/**
 * Whether `lsof` is one serve can read: it runs, takes lsof's options, and
 * finds this very process. BusyBox's, which slim images ship under the name,
 * ignores every option and prints another format, so every question put to it
 * would read as "nothing listens".
 */
export function lsofUsable(lsof: string): boolean {
  const result = spawnSync(lsof, ["-nP", "-a", "-p", String(process.pid), "-d", "cwd", "-Fp"], {
    encoding: "utf-8",
  });
  if (result.signal !== null) throw new HelperKilledError("lsof", result.signal);
  return (
    result.error === undefined && (result.stdout ?? "").split("\n").includes(`p${process.pid}`)
  );
}

function requireLsof(lsof: string): void {
  if (!lsofUsable(lsof)) throw new NoLsofError();
}

/** Parse lsof's `-F` output into one record per file, carrying its process's fields. */
function parseFields(output: string): Array<{ pid: number; pgid?: number; name: string }> {
  const files: Array<{ pid: number; pgid?: number; name: string }> = [];
  let pid = 0;
  let pgid: number | undefined;
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    switch (line[0]) {
      case "p":
        pid = Number(value);
        pgid = undefined;
        break;
      case "g":
        pgid = Number(value);
        break;
      case "n":
        files.push({ pid, pgid, name: value });
        break;
    }
  }
  return files;
}

/** Parse lsof's socket records into listeners, keeping only `ports` when given. */
function parseListeners(output: string, ports?: readonly number[]): Listener[] {
  return parseFields(output).flatMap(({ pid, pgid, name }) => {
    const colon = name.lastIndexOf(":");
    const port = Number(name.slice(colon + 1));
    if (colon < 0 || !Number.isInteger(port)) return [];
    if (ports !== undefined && !ports.includes(port)) return [];
    return [{ pid, pgid: pgid ?? -1, port, address: name.slice(0, colon) }];
  });
}

/** Every socket listening on one of `ports`. */
export function readListeners(lsof: string, ports: readonly number[]): Listener[] {
  const output = runLsof(lsof, ["-nP", `-iTCP:${ports.join(",")}`, "-sTCP:LISTEN", "-Fpgn"]);
  return parseListeners(output, ports);
}

/** Every TCP socket a process group listens on, whatever its port. */
export function groupListeners(lsof: string, pgid: number): Listener[] {
  const output = runLsof(lsof, ["-nP", "-a", "-g", String(pgid), "-iTCP", "-sTCP:LISTEN", "-Fpgn"]);
  return parseListeners(output);
}

/** The sockets among `sockets` that listen beyond this machine. */
function beyond(sockets: readonly Listener[]): Listener[] {
  return sockets.filter((listener) => !isLoopbackAddress(listener.address));
}

function addressesOf(sockets: readonly Listener[]): string {
  return sockets.map((listener) => `${listener.address}:${listener.port}`).join(", ");
}

/** The working directory of a process, as the system reports it. */
function cwdOf(lsof: string, pid: number): string | undefined {
  const output = runLsof(lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return parseFields(output)[0]?.name;
}

/** The working directory of every process in a group; empty when the group is gone. */
function groupCwds(lsof: string, pgid: number): string[] {
  const output = runLsof(lsof, ["-a", "-g", String(pgid), "-d", "cwd", "-Fn"]);
  return parseFields(output).map((file) => file.name);
}

// ── The process group ───────────────────────────────────────────────────────

/** Whether a process exists, or with a negative id, a process group. */
function exists(id: number): boolean {
  try {
    process.kill(id, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processAlive(pid: number): boolean {
  return exists(pid);
}

function groupAlive(pgid: number): boolean {
  return exists(-pgid);
}

/**
 * When a process started, as a string that differs for another process given
 * the same id later, or `undefined` when it does not run. Linux keeps it in
 * `/proc`, in clock ticks since the boot, so the boot's id goes with it, and
 * this needs no `ps`, which a slim image may lack; elsewhere `ps` reads it, in
 * a locale and a time zone fixed so that two shells agree on its spelling: it
 * prints local time, and an agent's shell often sets `TZ=UTC`. A `ps` that
 * cannot run at all throws `NoPsError`, as when a sandbox refuses it: Codex's,
 * on macOS, will not run a setuid program, and `ps` is one.
 */
export function startTimeOf(pid: number, ps = "ps"): string | undefined {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    } catch {
      return undefined;
    }
    // The command's name, in parentheses, may hold spaces, so the fields are
    // counted after it: the state is the third, the start time the 22nd.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    let boot = "";
    try {
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    } catch {
      // The ticks alone, then.
    }
    return `${boot}:${fields[19]}`;
  }
  const result = spawnSync(ps, ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf-8",
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.error !== undefined) throw new NoPsError();
  if (result.signal !== null) throw new HelperKilledError("ps", result.signal);
  const text = result.status === 0 ? result.stdout.trim() : "";
  return text === "" ? undefined : text;
}

/**
 * Whether serve can read a start time here: its own process's, which runs, so
 * no answer means none can be read. A sandbox that will not run `ps` fails it.
 */
export function psUsable(ps: string): boolean {
  try {
    return startTimeOf(process.pid, ps) !== undefined;
  } catch (error) {
    if (error instanceof NoPsError) return false;
    throw error;
  }
}

function requirePs(ps: string): void {
  if (!psUsable(ps)) throw new NoPsError();
}

/** How a start time is read here, for a verdict to say. */
function startTimeReader(config: ServeConfig): string {
  return process.platform === "linux" ? "from /proc" : `with ${config.ps}`;
}

/**
 * When a recorded group's first process started, or `undefined` once it no
 * longer runs, which needs no start time read, so no `ps`. One that still runs
 * and whose start time cannot be read throws `NoPsError` rather than
 * answering: read as another process's, its record would be dropped while the
 * server may still listen, and read as serve's, a process given the same id
 * later could be signalled.
 */
function leaderStartOf(pid: number, ps: string): string | undefined {
  if (!processAlive(pid)) return undefined;
  const start = startTimeOf(pid, ps);
  if (start === undefined && processAlive(pid)) throw new NoPsError(pid);
  return start;
}

/**
 * Signal a whole group, and say whether the signal reached it: a group already
 * gone needs none, and `EPERM` means the system refused it, as a sandbox
 * refuses a signal to a process started outside it.
 */
function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

/** How stopping a group ended: it has, the system refused the signal, or it outlived the hard one. */
export type StopOutcome = "stopped" | "refused" | "survived";

/**
 * Stop a whole group: a polite signal, then a hard one once the grace period
 * runs out. A refused signal ends the attempt at once, since waiting would not
 * change the answer.
 */
export async function stopGroup(pgid: number, graceMs: number): Promise<StopOutcome> {
  if (!signalGroup(pgid, "SIGTERM")) return groupAlive(pgid) ? "refused" : "stopped";
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(pgid)) {
    if (!signalGroup(pgid, "SIGKILL")) return groupAlive(pgid) ? "refused" : "stopped";
    const hardDeadline = Date.now() + 2_000;
    while (groupAlive(pgid) && Date.now() < hardDeadline) await sleep(50);
  }
  return groupAlive(pgid) ? "survived" : "stopped";
}

/**
 * The verdict for a group serve or stop meant to stop and could not, `why`
 * saying why it was stopping it. Its record is kept, so a later make stop still
 * finds it; one a failed start never recorded is named for a person to stop.
 */
function stillRunning(pgid: number, why: string, outcome: StopOutcome, recorded = true): string {
  const cause =
    outcome === "refused"
      ? "the system refused to signal it, as a sandbox refuses a signal to a process started " +
        "outside it"
      : "it outlived SIGKILL";
  const then = recorded
    ? `It is still running and still recorded in ${STATE_FILE}, so make stop run where it may ` +
      "signal the group stops it."
    : "It is still running and was never recorded, so make stop cannot find it: stop it with " +
      `kill -- -${pgid} where that is allowed.`;
  return (
    `failed: still-running — the server make serve started (process group ${pgid}) ${why}, ` +
    `and could not be stopped: ${cause}. ${then}`
  );
}

// ── The state file ──────────────────────────────────────────────────────────

function readState(checkout: string): ServeState | undefined {
  try {
    const state = JSON.parse(readFileSync(path.join(checkout, STATE_FILE), "utf-8")) as ServeState;
    return Number.isInteger(state.pgid) && state.pgid > 1 && typeof state.leaderStart === "string"
      ? state
      : undefined;
  } catch {
    return undefined;
  }
}

function writeState(checkout: string, state: ServeState): void {
  const file = path.join(checkout, STATE_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

function removeState(checkout: string): void {
  rmSync(path.join(checkout, STATE_FILE), { force: true });
}

/**
 * Whether the group a state file names is still serve's server in this
 * checkout: `gone` when no process of it runs, `foreign` when its id now names
 * another group, or when its processes run elsewhere, as in a checkout copied
 * with its `.serve/`. A first process whose start time cannot be read is
 * neither, and throws `NoPsError`; a running group none of whose processes
 * lsof can see is neither too, and throws `NoLsofError`.
 */
function ownership(
  config: ServeConfig,
  state: ServeState,
  checkout: string,
): "ours" | "gone" | "foreign" {
  if (!groupAlive(state.pgid)) return "gone";
  // A group's id is its first process's. While that process runs it must be
  // the one serve started; once it has ended, the id is not given to another
  // process until the whole group has ended too, so the group is still serve's.
  const leaderStart = leaderStartOf(state.pgid, config.ps);
  if (leaderStart !== undefined && leaderStart !== state.leaderStart) return "foreign";
  const cwds = groupCwds(config.lsof, state.pgid);
  if (cwds.length > 0) return cwds.includes(checkout) ? "ours" : "foreign";
  // Nothing seen: the group has ended since, or lsof may not look at its
  // processes, which proves neither way.
  if (!groupAlive(state.pgid)) return "gone";
  throw new NoLsofError(state.pgid);
}

/**
 * The `refused: no-lsof` verdict for a recorded group that still runs where
 * lsof sees none of its processes.
 */
function unseenGroup(config: ServeConfig, pgid: number): string {
  return (
    `refused: no-lsof — process group ${pgid}, recorded in ${STATE_FILE}, still runs, but ` +
    `${config.lsof} sees none of its processes, so whether it is the server make serve started ` +
    "here cannot be told. Nothing was signalled or started, and the record was kept: run make " +
    `stop where lsof can see it, or remove ${STATE_FILE} if that group is not this checkout's ` +
    "server."
  );
}

// ── The page ────────────────────────────────────────────────────────────────

type PageAnswer =
  | { status: number; title?: string }
  | { status: "no-answer" | "exited" | "interrupted" };

/** Decode the few entities a `<title>` carries. */
function decodeTitle(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Request the page until it answers, for `pageMs` at most: the first request
 * waits out the page's first compilation, and a refused connection is retried.
 * Any answer is final, and only `200` proves the page. `interrupt` ends a
 * request in flight at once, rather than when its time runs out.
 */
async function requestPage(
  url: string,
  pageMs: number,
  alive: () => boolean,
  interrupt?: AbortSignal,
): Promise<PageAnswer> {
  const deadline = Date.now() + pageMs;
  while (Date.now() < deadline) {
    if (interrupt?.aborted) return { status: "interrupted" };
    if (!alive()) return { status: "exited" };
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    try {
      const response = await fetch(url, {
        signal: interrupt ? AbortSignal.any([timeout, interrupt]) : timeout,
      });
      const body = await response.text();
      const match = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
      return { status: response.status, title: match ? decodeTitle(match[1]) : undefined };
    } catch {
      if (interrupt?.aborted) return { status: "interrupted" };
      await sleep(500);
    }
  }
  return { status: "no-answer" };
}

function describePage(url: string, title: string | undefined): string {
  return title ? `${url} — "${title}"` : url;
}

// ── The log ─────────────────────────────────────────────────────────────────

function printLogTail(config: ServeConfig, log: string, lines = 20): void {
  let text: string;
  try {
    text = readFileSync(log, "utf-8");
  } catch {
    return;
  }
  const tail = text.trimEnd().split("\n").slice(-lines);
  if (tail.length === 0 || (tail.length === 1 && tail[0] === "")) return;
  config.print(`the last lines of ${LOG_FILE}:`);
  for (const line of tail) config.print(`  ${line}`);
}

// ── One run at a time ───────────────────────────────────────────────────────

/** A signal that arrived while a run was going, which it answers with a verdict rather than dying. */
interface Interrupt {
  signal: AbortSignal;
  received: () => NodeJS.Signals | undefined;
}

class BusyError extends Error {}

function readOr(file: string, fallback: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return fallback;
  }
}

/**
 * Take the checkout's lock, waiting while another run holds it.
 *
 * Two runs at once undo each other: both find no server and start one on the
 * same port, and the one that fails removes the state of the one that serves;
 * or one stops the other's server while it is still starting. So a run takes
 * `.serve/lock`, created exclusively and holding its pid, and one that finds it
 * held waits for as long as a whole start can take. The lock is removed only by
 * the run that made it. One left behind by a run that was killed is never
 * broken on its own, as in `make add-method`: two runs breaking it at once would
 * each believe they held it, so the refusal names the file instead. Returns
 * `undefined` when an interruption ends the wait.
 */
async function takeLock(
  config: ServeConfig,
  checkout: string,
  interrupt: Interrupt,
): Promise<string | undefined> {
  const file = path.join(checkout, LOCK_FILE);
  const stamp = `${process.pid}\n${randomUUID()}\n`;
  const deadline = Date.now() + config.waitMs + config.pageMs + 2 * config.graceMs + 5_000;
  let announced = false;
  for (;;) {
    try {
      writeFileSync(file, stamp, { flag: "wx" });
      return stamp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Empty or gone: the file is created before its pid is written, and removed
    // when its run ends, so another run is taking or releasing it.
    const pid = Number(readOr(file, "").split("\n")[0]);
    const known = Number.isSafeInteger(pid) && pid > 0;
    if (known && !processAlive(pid)) {
      throw new BusyError(
        `refused: busy — ${LOCK_FILE} is held by pid ${pid}, which is no longer running, so a ` +
          "make serve or make stop was killed before it could remove it. Nothing was done: if " +
          `no other one is running in this checkout, remove ${LOCK_FILE} and run again.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new BusyError(
        known
          ? `refused: busy — pid ${pid} has held ${LOCK_FILE} for longer than a make serve takes. ` +
              `Nothing was done. If pid ${pid} is not a make serve or make stop, one that was ` +
              `killed left the file behind and its pid has been reused: remove ${LOCK_FILE} and ` +
              "run again."
          : `refused: busy — ${LOCK_FILE} has stayed empty for longer than a make serve takes, so ` +
              `a run was killed as it took it. Nothing was done: remove ${LOCK_FILE} and run again.`,
      );
    }
    if (known && !announced) {
      config.print(
        `waiting for another make serve or make stop (pid ${pid}) to finish in this checkout`,
      );
      announced = true;
    }
    if (interrupt.received()) return undefined;
    await sleep(200);
  }
}

function releaseLock(checkout: string, stamp: string): void {
  const file = path.join(checkout, LOCK_FILE);
  if (readOr(file, "") === stamp) rmSync(file, { force: true });
}

/**
 * Run `body` holding the lock, with SIGINT, SIGTERM and SIGHUP turned into an
 * interruption it answers: a run killed outright would leave the lock behind,
 * and one killed while it starts the server would leave an unproven server.
 * SIGHUP is a terminal or a remote session closing while serve waits for the
 * page, which can take minutes.
 */
async function exclusive(
  config: ServeConfig,
  checkout: string,
  body: (interrupt: Interrupt) => Promise<number>,
): Promise<number> {
  let received: NodeJS.Signals | undefined;
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    received = signal;
    controller.abort();
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  const interrupt: Interrupt = { signal: controller.signal, received: () => received };
  try {
    mkdirSync(path.join(checkout, SERVE_DIR), { recursive: true });
    let stamp: string | undefined;
    try {
      stamp = await takeLock(config, checkout, interrupt);
    } catch (error) {
      if (!(error instanceof BusyError)) throw error;
      config.print(error.message);
      return EXIT_FAILED;
    }
    if (stamp === undefined) {
      config.print(`failed: interrupted — ${received} arrived before anything was done.`);
      return EXIT_FAILED;
    }
    try {
      return await body(interrupt);
    } catch (error) {
      // Killed before a server was started, or while serve looked at the one it
      // started earlier: nothing was changed on its silence. One killed during
      // a start never reaches here, since `start` stops what it started.
      if (!(error instanceof HelperKilledError)) throw error;
      config.print(
        `failed: interrupted — ${error.message}, so nothing more was done and every running ` +
          "server was left as it was.",
      );
      return EXIT_FAILED;
    } finally {
      releaseLock(checkout, stamp);
    }
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

// ── serve ───────────────────────────────────────────────────────────────────

function readDevScript(checkout: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.dev ?? "";
  } catch {
    return "";
  }
}

/** The loopback address a group listens on for a port, IPv4 first. */
function loopbackAddressOf(listeners: readonly Listener[]): string {
  const addresses = listeners.map((listener) => listener.address);
  return addresses.find((address) => address.startsWith("127.")) ?? addresses[0];
}

/**
 * Start the dev server in the background and prove its page, or report the one
 * already serving this checkout. Prints its verdict last and returns the exit
 * code; never throws for an outcome it can name.
 */
export async function serve(config: ServeConfig): Promise<number> {
  const { print } = config;
  const checkout = realpathSync.native(config.checkout);
  const host = config.host.trim() || "127.0.0.1";

  if (!isLoopbackHost(host)) {
    print(
      `refused: not-loopback — APP_HOST=${host} would open the server beyond this machine, ` +
        `where anyone who can reach it runs methods on your key. make serve listens on loopback ` +
        `only; make dev APP_HOST=${host} runs it in the foreground, with a warning.`,
    );
    return EXIT_FAILED;
  }
  const script = readDevScript(checkout);
  if (!devScriptBindsLoopback(script)) {
    print(
      `refused: not-loopback — the dev script in package.json (${JSON.stringify(script)}) ` +
        "does not bind the server to this machine, so make serve does not start it. " +
        "Give it -H ${APP_HOST:-127.0.0.1}, as the template's does.",
    );
    return EXIT_FAILED;
  }
  if (
    config.port !== undefined &&
    !(Number.isInteger(config.port) && config.port > 0 && config.port < 65536)
  ) {
    print(`refused: bad-port — APP_PORT=${config.port} is not a port number.`);
    return EXIT_FAILED;
  }

  try {
    return await exclusive(config, checkout, (interrupt) =>
      serveChecked(config, checkout, host, interrupt),
    );
  } catch (error) {
    if (error instanceof NoLsofError) {
      print(
        error.pgid !== undefined
          ? unseenGroup(config, error.pgid)
          : `refused: no-lsof — make serve reads who holds the port with lsof, and ${config.lsof} ` +
              "is not on the PATH or does not take lsof's options, as BusyBox's does not. " +
              "Install lsof, or run make dev in the foreground.",
      );
      return EXIT_FAILED;
    }
    if (error instanceof NoPsError) {
      print(
        refusedNoPs(
          config,
          error,
          "make serve reads when the server's first process started, to tell it later from a " +
            "process given the same id",
          "Nothing was started: run make serve where it can, or make dev in the foreground.",
        ),
      );
      return EXIT_FAILED;
    }
    throw error;
  }
}

/**
 * The `refused: no-ps` verdict. Without a pid, serve's own start time could not
 * be read, and `need` says what serve or stop reads it for; with one, the
 * recorded group still runs and its first process's could not, so the record
 * is kept for a later run that can read it.
 */
function refusedNoPs(config: ServeConfig, error: NoPsError, need: string, then: string): string {
  if (error.pid !== undefined) {
    return (
      `refused: no-ps — process group ${error.pid}, recorded in ${STATE_FILE}, still runs, but ` +
      `when its first process started cannot be read ${startTimeReader(config)}, so whether it ` +
      "is the server make serve started cannot be told. Nothing was signalled or started, and " +
      `the record was kept: run make stop where it can be read, or remove ${STATE_FILE} if that ` +
      "group is not this checkout's server."
    );
  }
  const cannot =
    process.platform === "linux"
      ? "/proc cannot be read here"
      : `${config.ps} is not on the PATH or may not run here, as a sandbox such as Codex's ` +
        "refuses it";
  return `refused: no-ps — ${need}, and ${cannot}. ${then}`;
}

async function serveChecked(
  config: ServeConfig,
  checkout: string,
  host: string,
  interrupt: Interrupt,
): Promise<number> {
  const { print, lsof } = config;
  requireLsof(lsof);
  requirePs(config.ps);

  // The server serve started earlier, when it still runs here.
  const state = readState(checkout);
  if (state !== undefined) {
    const owner = ownership(config, state, checkout);
    if (owner === "ours") {
      const listening = readListeners(lsof, [state.port]).filter(
        (listener) => listener.pgid === state.pgid,
      );
      if (listening.length > 0) {
        return reportOwnServer(config, checkout, state, listening, interrupt);
      }
      // Ours, but not listening: a start that never finished. It proves
      // nothing, so it goes before a fresh one starts.
      print(
        `the server make serve started earlier (process group ${state.pgid}) is not listening; stopping it.`,
      );
      const outcome = await stopGroup(state.pgid, config.graceMs);
      if (outcome !== "stopped") {
        print(stillRunning(state.pgid, "is not listening", outcome));
        return EXIT_FAILED;
      }
    }
    removeState(checkout);
  }

  const candidates = config.port !== undefined ? [config.port] : config.ports;
  const listeners = readListeners(lsof, candidates);

  // A server a person started from this checkout, with `make dev`: never
  // stepped around, never stopped.
  const cwds = new Map<number, string | undefined>();
  for (const listener of listeners) {
    if (!cwds.has(listener.pid)) cwds.set(listener.pid, cwdOf(lsof, listener.pid));
  }
  const personal = listeners.find((listener) => cwds.get(listener.pid) === checkout);
  if (personal !== undefined) {
    const sockets = listeners.filter(
      (listener) => listener.pid === personal.pid && listener.port === personal.port,
    );
    return reportPersonalServer(config, personal, sockets, interrupt);
  }

  let port: number;
  if (config.port !== undefined) {
    const holder = listeners[0];
    if (holder !== undefined) {
      print(
        `refused: port-held — port ${config.port} is held by pid ${holder.pid}, running in ` +
          `${cwds.get(holder.pid) ?? "an unknown directory"}, which is not this checkout. Leave it ` +
          "alone, and give another APP_PORT, or none to take the first free port from " +
          `${config.ports[0]}.`,
      );
      return EXIT_FAILED;
    }
    port = config.port;
  } else {
    const held = new Set(listeners.map((listener) => listener.port));
    const free = config.ports.find((candidate) => !held.has(candidate));
    if (free === undefined) {
      print(
        `refused: port-held — every port from ${config.ports[0]} to ${config.ports.at(-1)} is held ` +
          "by another directory. Give another one with APP_PORT=<port>.",
      );
      return EXIT_FAILED;
    }
    port = free;
  }

  return start(config, checkout, host, port, interrupt);
}

async function reportOwnServer(
  config: ServeConfig,
  checkout: string,
  state: ServeState,
  listening: readonly Listener[],
  interrupt: Interrupt,
): Promise<number> {
  const { print } = config;
  const wide = beyond(groupListeners(config.lsof, state.pgid));
  if (wide.length > 0) {
    const outcome = await stopGroup(state.pgid, config.graceMs);
    if (outcome !== "stopped") {
      print(
        stillRunning(state.pgid, `listens beyond this machine (${addressesOf(wide)})`, outcome),
      );
      return EXIT_FAILED;
    }
    removeState(checkout);
    print(
      `refused: not-loopback — the server make serve started listened beyond this machine ` +
        `(${addressesOf(wide)}), so it was stopped.`,
    );
    return EXIT_FAILED;
  }
  const url = urlOf(loopbackAddressOf(listening), state.port);
  const page = await requestPage(
    url,
    config.pageMs,
    () => groupAlive(state.pgid),
    interrupt.signal,
  );
  if (page.status === "interrupted") {
    print(
      `failed: interrupted — ${interrupt.received()} arrived before ${url} answered; the server ` +
        "make serve started earlier is still running.",
    );
    return EXIT_FAILED;
  }
  if (page.status !== 200) {
    const outcome = await stopGroup(state.pgid, config.graceMs);
    printLogTail(config, path.join(checkout, LOG_FILE));
    if (outcome !== "stopped") {
      print(stillRunning(state.pgid, `did not answer ${url} with 200`, outcome));
      return EXIT_FAILED;
    }
    removeState(checkout);
    print(
      `failed: page ${page.status} — the server make serve started earlier did not answer ${url} ` +
        "with 200, so it was stopped.",
    );
    return EXIT_FAILED;
  }
  const title = "title" in page ? page.title : undefined;
  print(`already-serving ${describePage(url, title)} (log ${LOG_FILE}); stop it with: make stop`);
  return EXIT_OK;
}

async function reportPersonalServer(
  config: ServeConfig,
  personal: Listener,
  sockets: readonly Listener[],
  interrupt: Interrupt,
): Promise<number> {
  const { print } = config;
  const where = `pid ${personal.pid}, started outside make serve`;
  if (!sockets.every((listener) => isLoopbackAddress(listener.address))) {
    print(
      `refused: not-loopback — this checkout's server on port ${personal.port} (${where}) listens ` +
        `beyond this machine (${sockets.map((l) => l.address).join(", ")}). make serve stops only ` +
        "what it started, so it is still running: stop it yourself.",
    );
    return EXIT_FAILED;
  }
  const url = urlOf(loopbackAddressOf(sockets), personal.port);
  const page = await requestPage(url, config.pageMs, () => true, interrupt.signal);
  if (page.status === "interrupted") {
    print(
      `failed: interrupted — ${interrupt.received()} arrived before ${url} answered; this ` +
        `checkout's server (${where}) is still running.`,
    );
    return EXIT_FAILED;
  }
  if (page.status !== 200) {
    print(
      `failed: page ${page.status} — this checkout's server on ${url} (${where}) did not answer ` +
        "with 200. make serve did not start it, so it is still running.",
    );
    return EXIT_FAILED;
  }
  const title = "title" in page ? page.title : undefined;
  print(`already-serving ${describePage(url, title)} (${where}, so make stop leaves it alone)`);
  return EXIT_OK;
}

async function start(
  config: ServeConfig,
  checkout: string,
  host: string,
  port: number,
  interrupt: Interrupt,
): Promise<number> {
  const { print, lsof } = config;
  const log = path.join(checkout, LOG_FILE);
  const output = openSync(log, "w");

  const [command, ...args] = config.command;
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: checkout,
      // A new session: a group of its own for one signal to stop, and out of
      // reach of the terminal's hangup.
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, APP_HOST: host, APP_PORT: String(port) },
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  let exit: string | undefined;
  child.on("exit", (code, signal) => {
    exit = signal ? `signal ${signal}` : `code ${code}`;
  });
  const spawned = await new Promise<Error | undefined>((resolve) => {
    child.once("spawn", () => resolve(undefined));
    child.once("error", (error) => resolve(error));
  });
  if (spawned !== undefined || child.pid === undefined) {
    print(`failed: exited — could not run ${command}: ${spawned?.message ?? "no process id"}`);
    return EXIT_FAILED;
  }
  const pgid = child.pid;

  // From here the group is stopped unless its page is proven: each verdict
  // below says why, and an error on the way stops it just the same before it
  // propagates. The server is in a session of its own, so the terminal's
  // Ctrl-C does not reach it; the interruption `exclusive` catches does. A
  // group that outlives its stop keeps its record, once it has one, and the
  // verdict says it still runs rather than the status it was stopped for.
  let settled = false;
  let recorded = false;
  const stopStarted = async (): Promise<StopOutcome> => {
    const outcome = await stopGroup(pgid, config.graceMs);
    if (outcome === "stopped") removeState(checkout);
    return outcome;
  };
  const giveUp = async (status: string, reason: string, tail = true): Promise<number> => {
    settled = true;
    const outcome = await stopStarted();
    if (tail) printLogTail(config, log);
    print(
      outcome === "stopped"
        ? `${status} — ${reason}`
        : stillRunning(pgid, `failed to start (${status})`, outcome, recorded),
    );
    return EXIT_FAILED;
  };
  const interrupted = (signal = interrupt.received()) =>
    giveUp(
      "failed: interrupted",
      `${signal} arrived before the page was proven, so the server was stopped.`,
      false,
    );

  try {
    const leaderStart = leaderStartOf(pgid, config.ps);
    if (leaderStart === undefined) {
      return await giveUp(
        "failed: exited",
        `the dev server exited (${exit ?? "at once"}) before it could be recorded.`,
      );
    }
    const startedAt = new Date().toISOString();
    const record = (url: string) => {
      writeState(checkout, { pgid, leaderStart, port, url, log: LOG_FILE, checkout, startedAt });
      recorded = true;
    };
    record(urlOf(host.includes(":") ? `[${host}]` : host, port));
    print(`starting the dev server on port ${port} (process group ${pgid}, log ${LOG_FILE})`);

    // The port opens when a process of this group listens on it.
    const deadline = Date.now() + config.waitMs;
    let listening: Listener[] = [];
    for (;;) {
      if (interrupt.received()) return await interrupted();
      listening = readListeners(lsof, [port]).filter((listener) => listener.pgid === pgid);
      if (listening.length > 0) break;
      if (exit !== undefined) {
        return await giveUp(
          "failed: exited",
          `the dev server exited (${exit}) before it listened on port ${port}.`,
        );
      }
      if (Date.now() >= deadline) {
        return await giveUp(
          "failed: not-listening",
          `nothing of the dev server listened on port ${port} within ` +
            `${Math.round(config.waitMs / 1000)}s, so it was stopped with everything it started.`,
        );
      }
      await sleep(200);
    }

    // Every socket of the group, not only the app's port: a dev script may
    // start something else beside the server, an inspector for one.
    const wide = beyond(groupListeners(lsof, pgid));
    if (wide.length > 0) {
      return await giveUp(
        "refused: not-loopback",
        `the dev server listened beyond this machine (${addressesOf(wide)}), so it was stopped ` +
          "before its page was requested.",
        false,
      );
    }

    const url = urlOf(loopbackAddressOf(listening), port);
    record(url);
    const page = await requestPage(url, config.pageMs, () => exit === undefined, interrupt.signal);
    if (interrupt.received()) return await interrupted();
    if (page.status === "exited") {
      return await giveUp(
        "failed: exited",
        `the dev server exited (${exit}) before its page answered.`,
      );
    }
    if (page.status !== 200) {
      return await giveUp(
        `failed: page ${page.status}`,
        `${url} did not answer with 200, so the server was stopped.`,
      );
    }

    // A listening socket can open after the first one; look once more.
    const after = beyond(groupListeners(lsof, pgid));
    if (after.length > 0) {
      return await giveUp(
        "refused: not-loopback",
        `the dev server listened beyond this machine (${addressesOf(after)}), so it was stopped.`,
        false,
      );
    }

    settled = true;
    print(`serving ${describePage(url, page.title)} (log ${LOG_FILE}); stop it with: make stop`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof NoPsError) {
      // Read for serve's own process a moment ago, so rare: the group could
      // not be recorded, and one that is not recorded cannot be stopped later.
      return await giveUp(
        "failed: no-ps",
        `when the dev server's first process (pid ${pgid}) started could not be read ` +
          `${startTimeReader(config)}, so it could not be recorded, and it was stopped.`,
      );
    }
    if (!(error instanceof HelperKilledError)) throw error;
    return await interrupted(error.signal);
  } finally {
    if (!settled) {
      const outcome = await stopStarted();
      if (outcome !== "stopped") {
        print(stillRunning(pgid, "hit an error while starting", outcome, recorded));
      }
    }
  }
}

// ── stop ────────────────────────────────────────────────────────────────────

/** Stop the server make serve started here, when it is still this checkout's. */
export async function stop(config: ServeConfig): Promise<number> {
  const { print } = config;
  const checkout = realpathSync.native(config.checkout);
  if (!existsSync(path.join(checkout, SERVE_DIR))) {
    print("not-running — make serve has no server recorded in this checkout.");
    return EXIT_OK;
  }
  try {
    return await exclusive(config, checkout, () => stopChecked(config, checkout));
  } catch (error) {
    if (error instanceof NoLsofError) {
      print(
        error.pgid !== undefined
          ? unseenGroup(config, error.pgid)
          : "refused: no-lsof — make stop checks that the recorded process group still runs in " +
              `this checkout before signalling it, and ${config.lsof} is not on the PATH or does ` +
              "not take lsof's options, as BusyBox's does not.",
      );
      return EXIT_FAILED;
    }
    if (error instanceof NoPsError) {
      print(
        refusedNoPs(
          config,
          error,
          "make stop signals the recorded process group only once its first process's start " +
            "time proves it is the server make serve started",
          `Nothing was signalled, and ${STATE_FILE} was kept, so make stop run where it can ` +
            "still stops the server.",
        ),
      );
      return EXIT_FAILED;
    }
    throw error;
  }
}

async function stopChecked(config: ServeConfig, checkout: string): Promise<number> {
  const { print } = config;
  const state = readState(checkout);
  if (state === undefined) {
    print("not-running — make serve has no server recorded in this checkout.");
    return EXIT_OK;
  }
  requireLsof(config.lsof);
  // Unlike serve, stop does not require ps up front: the record of a group that
  // has ended is cleared without a start time, and ownership throws NoPsError
  // for one that still runs and whose start cannot be read.
  const owner = ownership(config, state, checkout);
  if (owner === "gone") {
    removeState(checkout);
    print(
      `not-running — the server make serve started (process group ${state.pgid}) has already exited.`,
    );
    return EXIT_OK;
  }
  if (owner === "foreign") {
    removeState(checkout);
    print(
      `not-running — process group ${state.pgid} is no longer the server make serve started ` +
        "here, so it was left alone.",
    );
    return EXIT_OK;
  }
  const outcome = await stopGroup(state.pgid, config.graceMs);
  if (outcome !== "stopped") {
    print(stillRunning(state.pgid, `serves ${state.url}`, outcome));
    return EXIT_FAILED;
  }
  removeState(checkout);
  print(`stopped ${state.url} (process group ${state.pgid})`);
  return EXIT_OK;
}

// ── The command line ────────────────────────────────────────────────────────

export interface ServeArgs {
  action: "serve" | "stop";
  host?: string;
  port?: number;
}

export class UsageError extends Error {}

export function parseServeArgs(argv: readonly string[]): ServeArgs {
  const args: ServeArgs = { action: "serve" };
  const rest = [...argv];
  if (rest[0] === "serve" || rest[0] === "stop") args.action = rest.shift() as ServeArgs["action"];
  while (rest.length > 0) {
    const flag = rest.shift()!;
    const value = rest.shift();
    if (value === undefined) throw new UsageError(`${flag} needs a value`);
    if (flag === "--host") args.host = value;
    else if (flag === "--port") args.port = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    else throw new UsageError(`unknown argument ${flag}`);
  }
  return args;
}

/** The whole command, exit code included. */
export async function runServe(
  argv: readonly string[],
  overrides: Partial<ServeConfig> = {},
): Promise<number> {
  let args: ServeArgs;
  try {
    args = parseServeArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`serve: ${error.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const config: ServeConfig = {
    ...DEFAULT_CONFIG,
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...overrides,
  };
  if (!existsSync(config.checkout)) throw new Error(`no checkout at ${config.checkout}`);
  return args.action === "stop" ? stop(config) : serve(config);
}
