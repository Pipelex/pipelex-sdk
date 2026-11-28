/**
 * `npm run serve` and `npm run serve -- stop` — the dev server in the
 * background, proven. `make serve` and `make stop` are the same commands for
 * those who have `make`, and the verdicts name whichever of the two ran them.
 *
 * `npm run dev` holds a terminal. `npm run serve` starts the same dev server
 * detached, running the `dev` script's `scripts/run-next.mts dev` itself, with
 * this Node, rather than through npm, so that no npm and no shell stand between
 * serve and the server (`devServerCommand`). It waits for its port, checks that
 * the listener is the server it started and that it listens on this machine
 * alone, requests the page, and prints the URL with the page's title.
 * `npm run serve -- stop` stops what it started. Both stay in every project,
 * because a detached, proven server is as useful to a person or an agent
 * working on the app as it is right after the project is created.
 *
 * Every outcome is one verdict line, printed last, whose first word is stable:
 *
 *   serving, already-serving                     the page answered
 *   refused: not-loopback, refused: port-held,   nothing was started
 *   refused: no-lsof, refused: no-ps,
 *   refused: bad-port, refused: busy,
 *   refused: dev-script
 *   failed: not-listening, failed: exited,       what was started is stopped
 *   failed: page <status>, failed: no-ps,
 *   failed: interrupted
 *   failed: still-running                        a server of serve's that it
 *                                                meant to stop still runs, and
 *                                                stays recorded if it was
 *   stopped, not-running                         stop
 *
 * These rules make the verdict true rather than hopeful:
 *
 *  - **Loopback, before and after.** The app's Server Actions run methods with
 *    the key in the server's environment and nothing authenticates the browser
 *    calling them, so a server anyone on the network can reach spends the key
 *    for them from the moment its port opens. A host that is not loopback is
 *    refused before anything starts, and so is a `dev` script that adds a host
 *    or a port of its own after `scripts/run-next.mts dev`. Once the port
 *    opens, every socket the server's process group listens on, whatever its
 *    port, must be loopback, or the group is stopped.
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
 *
 * **Windows asks the same questions of other tools**, since it has no `lsof`,
 * no `ps` and no process groups, and every rule above holds there as written,
 * with these differences:
 *
 *  - The listeners are read with `netstat -ano`, a socket listening when its
 *    foreign address is the wildcard, which no locale translates, and the
 *    processes with PowerShell's `Get-CimInstance Win32_Process`: each one's
 *    parent, its start time to the microsecond and its command line.
 *  - The process serve spawns is the `node` running `scripts/run-next.mts`,
 *    never npm: npm runs a script through `cmd.exe`, and a `cmd.exe` started
 *    by a process with no console, as a detached one is, opens a console
 *    window of its own, which stayed open for as long as the server ran.
 *    `run-next.mts` starts `next` hidden (`windowsHide`), and everything under
 *    `next` shares its console.
 *  - The "group" is the tree under the process serve spawned, and a process
 *    belongs to it only when it is proven serve's: the first process, by its
 *    start time; every process serve saw in the tree once the server listened,
 *    recorded in the state by its id and start time; and every process whose
 *    parent is one of those, still running, and that started after that
 *    parent. A process id is reused once its process ends, so a process whose
 *    recorded parent has ended is never adopted on its parent id alone, as
 *    Explorer's would be, whose parent ends at sign-in; and a recorded member
 *    stays one, and stoppable, after the processes between it and the first
 *    have ended. Only during a stop, which kills the tree top down, does a
 *    member that has ended since that stop saw it keep its children.
 *  - Windows has no polite signal a detached console program receives, so a
 *    stop terminates the tree at once rather than after a grace period.
 *  - A process's working directory cannot be read there. A recorded tree is
 *    serve's server in this checkout when its first process, if it still runs,
 *    started when the record says and the record names this checkout, and a
 *    server a person started here is recognised by a command line that runs a
 *    file of this checkout, as `next` does from its `node_modules`, the path
 *    compared once it is resolved, so a short 8.3 name, a junction or a `subst`
 *    drive on either side does not hide it.
 *  - A `netstat` that fails is no answer, never "nothing listens". A stop that
 *    cannot read the process table falls back to `taskkill /T /F` on the
 *    process serve spawned while it still runs, and says the server may still
 *    run rather than that nothing was started.
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

import { npmCommand } from "./npm.mts";
import { isHostOrPortOption } from "./run-next.mts";

// The project's root, anchored on this file as `shared.mts` anchors its own.
// Not imported from there, because that module loads the SDK, and serving the
// app should need nothing but Node and the app's own dev server.
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Where serve keeps its state and the server's log, relative to the checkout. */
export const SERVE_DIR = ".serve";
export const STATE_FILE = path.posix.join(SERVE_DIR, "state.json");
export const LOG_FILE = path.posix.join(SERVE_DIR, "server.log");
/** Held while a serve or a stop runs, so that two never interleave in one checkout. */
export const LOCK_FILE = path.posix.join(SERVE_DIR, "lock");

/** The ports tried in turn when none is given, as `next dev` and Vite walk theirs. */
export const DEFAULT_PORTS: readonly number[] = Array.from({ length: 10 }, (_, i) => 4300 + i);

export const USAGE =
  "usage: serve.mts [serve] [--host <loopback host>] [--port <port>]\n       serve.mts stop";

export interface ServeConfig {
  /** The project's root: where the server runs and `.serve/` lives. */
  checkout: string;
  /**
   * What starts the dev server, run in the checkout with `APP_HOST` and
   * `APP_PORT` set, before the options the `dev` script gives `next` after
   * `scripts/run-next.mts dev`.
   */
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
  /**
   * What reads the listening sockets: `lsof`, or `netstat` on Windows. A test
   * names one that does not exist.
   */
  lsof: string;
  /**
   * What reads a start time where `/proc` does not: `ps`, or PowerShell on
   * Windows, which reads the process table there too. A test names one that
   * cannot run.
   */
  ps: string;
  /** How the person runs serve and stop, which the verdicts name. */
  commands: Commands;
  print: (line: string) => void;
}

/** The commands a verdict tells the person to run. */
export interface Commands {
  serve: string;
  stop: string;
  dev: string;
}

/** The names under `make`, which runs `npm run serve` for those who have it. */
export const MAKE_COMMANDS: Commands = { serve: "make serve", stop: "make stop", dev: "make dev" };

/**
 * npm's names for the commands, which every system runs, Windows included,
 * spelled as a person types them there: `npm.cmd` on Windows (`npmCommand`).
 */
export function npmCommands(platform: NodeJS.Platform = process.platform): Commands {
  const npm = npmCommand(platform);
  return { serve: `${npm} run serve`, stop: `${npm} run serve -- stop`, dev: `${npm} run dev` };
}

/**
 * The commands to name, from the environment serve runs in: `make` sets
 * `MAKELEVEL` for every command its recipes run, so a serve started by
 * `make serve` names `make stop`, and one started by `npm run serve` names
 * `npm run serve -- stop`, or `npm.cmd run serve -- stop` on Windows.
 */
export function commandsFor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Commands {
  return env.MAKELEVEL?.trim() ? MAKE_COMMANDS : npmCommands(platform);
}

/** Where the OS differs enough that serve asks it other questions. */
const WINDOWS = process.platform === "win32";

/** The template's `dev` script, which serve runs itself, as `devServerCommand` says. */
export const TEMPLATE_DEV_SCRIPT = "node --experimental-strip-types scripts/run-next.mts dev";

/**
 * What starts the dev server: what the `dev` script runs, `scripts/run-next.mts
 * dev`, run with this Node and named by its absolute path, with no npm and no
 * shell in between. `npm run` would run the script through a shell, `cmd.exe`
 * on Windows, which opened a console window there; and `run-next.mts` needs
 * nothing `npm run` provides: it finds `next` in the checkout's `node_modules`
 * on its own, reads only `APP_HOST` and `APP_PORT`, and serve runs it in the
 * checkout with the environment serve was given, `npm run serve`'s included.
 */
export function devServerCommand(checkout: string, execPath = process.execPath): string[] {
  return [
    execPath,
    "--experimental-strip-types",
    path.join(checkout, "scripts", "run-next.mts"),
    "dev",
  ];
}

export const DEFAULT_CONFIG: ServeConfig = {
  checkout: REPO_ROOT,
  command: devServerCommand(REPO_ROOT),
  host: "127.0.0.1",
  ports: DEFAULT_PORTS,
  waitMs: 60_000,
  pageMs: 120_000,
  graceMs: 5_000,
  lsof: WINDOWS ? "netstat.exe" : "lsof",
  ps: WINDOWS ? "powershell.exe" : "ps",
  commands: npmCommands(),
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
  /**
   * On Windows, every process of the server's tree serve saw once it listened,
   * so that one whose parents have ended is still known for serve's.
   */
  members?: MemberId[];
}

/**
 * An lsof serve cannot read: missing, or not taking lsof's options, or, with
 * `pgid`, one that sees none of a recorded group's processes while the group
 * still runs.
 */
export class NoLsofError extends Error {
  readonly pgid?: number;
  /** What the tool answered, when it ran and failed, for the verdict to say. */
  readonly detail?: string;
  constructor(pgid?: number, detail?: string) {
    super(
      detail ?? (pgid === undefined ? "no usable lsof" : `lsof sees no process of group ${pgid}`),
    );
    this.pgid = pgid;
    this.detail = detail;
  }
}

/**
 * A start time serve needs and cannot read: its own process's, when `ps` cannot
 * run here at all, or, with `pid`, that of a recorded group's first process,
 * which still runs.
 */
export class NoPsError extends Error {
  readonly pid?: number;
  constructor(pid?: number) {
    super(pid === undefined ? "no start time" : `no start time for pid ${pid}`);
    this.pid = pid;
  }
}

/** An `lsof` or `ps` serve ran was killed by a signal, so it gave no answer. */
export class HelperKilledError extends Error {
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
 * What serve makes of the `dev` script: the options it gives `next` after
 * `scripts/run-next.mts dev`, which serve passes on, or why serve will not
 * start it.
 *
 *  - `host`: an option naming a host or a port. `run-next.mts` hands `next`
 *    the host `APP_HOST` names first, loopback by default, and `next` takes the
 *    last host it is given, so one after it would open the server wherever it
 *    says; `run-next.mts` refuses one too.
 *  - `other`: anything but the template's script followed by plain words.
 *    Serve runs `scripts/run-next.mts dev` itself rather than through npm, so
 *    a script that runs anything else, or whose options a shell would read,
 *    would start another server under `npm run dev` than under serve. So
 *    would a `predev` or `postdev` script, which serve refuses too
 *    (`devHooksOf`).
 */
export type DevScript =
  | { options: string[] }
  | { problem: "host"; option: string }
  | { problem: "other" };

export function readDevScriptOptions(script: string): DevScript {
  const match =
    /^node\s+--experimental-strip-types\s+scripts\/run-next\.mts\s+dev(?:\s+(.*))?$/.exec(
      script.trim(),
    );
  if (match === null) return { problem: "other" };
  const options = (match[1] ?? "").split(/\s+/).filter(Boolean);
  const option = options.find(isHostOrPortOption);
  if (option !== undefined) return { problem: "host", option };
  // Words no shell reads specially: a quote, `$`, `%` or an operator would
  // mean one thing to npm's shell and another as a word passed as it is.
  if (!options.every((word) => /^[\w@+=:,./-]+$/.test(word))) return { problem: "other" };
  return { options };
}

function urlOf(address: string, port: number): string {
  return `http://${address}:${port}/`;
}

// ── What lsof says ──────────────────────────────────────────────────────────

/**
 * One listening socket: the process, its group, and the address it is bound
 * to. Windows has no process groups, so a listener read there carries `-1`, and
 * its group is found by its place in a tree (`inGroup`).
 */
export interface Listener {
  pid: number;
  pgid: number;
  port: number;
  address: string;
}

/** Run lsof and return its field output; a missing lsof throws `NoLsofError`. */
function runLsof(lsof: string, args: readonly string[]): string {
  const result = spawnSync(lsof, args, { encoding: "utf-8", windowsHide: true });
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
 * would read as "nothing listens". On Windows the tool is `netstat`, which is
 * usable when it lists TCP sockets in the form `parseNetstat` reads.
 */
export function lsofUsable(lsof: string): boolean {
  if (WINDOWS) {
    const result = spawnSync(lsof, ["-ano", "-p", "TCP"], { encoding: "utf-8", windowsHide: true });
    if (result.signal !== null) throw new HelperKilledError(lsof, result.signal);
    return result.error === undefined && result.status === 0 && /^\s*TCP\s/m.test(result.stdout);
  }
  const result = spawnSync(lsof, ["-nP", "-a", "-p", String(process.pid), "-d", "cwd", "-Fp"], {
    encoding: "utf-8",
  });
  if (result.signal !== null) throw new HelperKilledError("lsof", result.signal);
  return (
    result.error === undefined && (result.stdout ?? "").split("\n").includes(`p${process.pid}`)
  );
}

/**
 * The listening TCP sockets in `netstat -ano`'s output. A socket listens when
 * its foreign address is the wildcard, `0.0.0.0:0` or `[::]:0`, which reads the
 * same in every locale, where the state column is translated. IPv6 rows are
 * labelled `TCP` too, with their addresses in brackets, as `lsof -n` writes
 * them.
 */
export function parseNetstat(output: string): Listener[] {
  const listeners: Listener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+(\S+)\s+\S.*\s(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const [, local, foreign, pid] = match;
    if (foreign !== "0.0.0.0:0" && foreign !== "[::]:0") continue;
    const colon = local.lastIndexOf(":");
    const port = Number(local.slice(colon + 1));
    if (colon < 0 || !Number.isInteger(port)) continue;
    listeners.push({ pid: Number(pid), pgid: -1, port, address: local.slice(0, colon) });
  }
  return listeners;
}

/**
 * What `netstat -ano` prints. Unlike lsof, which exits 1 when nothing matched,
 * netstat lists every socket and exits 0, so any other end is no answer, and is
 * refused as one rather than read as "nothing listens", which would pass the
 * loopback check of a server listening everywhere. A busy machine lists
 * thousands of sockets, beyond `spawnSync`'s default buffer.
 */
export function readNetstat(netstat: string): string {
  const result = spawnSync(netstat, ["-ano"], {
    encoding: "utf-8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.signal !== null) throw new HelperKilledError(netstat, result.signal);
  if (result.error !== undefined || result.status !== 0) {
    const why =
      result.error !== undefined
        ? result.error.message
        : `it exited ${result.status}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ""}`;
    throw new NoLsofError(undefined, `${netstat} -ano gave no answer (${why})`);
  }
  return result.stdout;
}

/** Every listening TCP socket on Windows, whatever its port. */
function netstatListeners(netstat: string): Listener[] {
  return parseNetstat(readNetstat(netstat));
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
  if (WINDOWS) return netstatListeners(lsof).filter((listener) => ports.includes(listener.port));
  const output = runLsof(lsof, ["-nP", `-iTCP:${ports.join(",")}`, "-sTCP:LISTEN", "-Fpgn"]);
  return parseListeners(output, ports);
}

/** Every TCP socket a process group listens on, whatever its port. */
export function groupListeners(config: ServeConfig, group: Group): Listener[] {
  if (WINDOWS) return inGroup(config, group, netstatListeners(config.lsof));
  const output = runLsof(config.lsof, [
    "-nP",
    "-a",
    "-g",
    String(group.pgid),
    "-iTCP",
    "-sTCP:LISTEN",
    "-Fpgn",
  ]);
  return parseListeners(output);
}

/**
 * The listeners among `listeners` that belong to the group: by their process
 * group, or on Windows by their place in the tree under its first process.
 */
function inGroup(config: ServeConfig, group: Group, listeners: readonly Listener[]): Listener[] {
  if (!WINDOWS) return listeners.filter((listener) => listener.pgid === group.pgid);
  if (listeners.length === 0) return [];
  const members = new Set(treeOf(readProcessTable(config.ps), group).map((entry) => entry.pid));
  return listeners.filter((listener) => members.has(listener.pid));
}

/** The sockets among `sockets` that listen beyond this machine. */
function beyond(sockets: readonly Listener[]): Listener[] {
  return sockets.filter((listener) => !isLoopbackAddress(listener.address));
}

function addressesOf(sockets: readonly Listener[]): string {
  return sockets.map((listener) => `${listener.address}:${listener.port}`).join(", ");
}

/**
 * Where a process runs, as far as the system tells: its working directory, or
 * on Windows, where that cannot be read, its command line.
 */
interface Whereabouts {
  dir?: string;
  command?: string;
}

/** Where each of `pids` runs, read once for all of them. */
function whereaboutsOf(config: ServeConfig, pids: readonly number[]): Map<number, Whereabouts> {
  const found = new Map<number, Whereabouts>();
  if (WINDOWS) {
    if (pids.length === 0) return found;
    const table = readProcessTable(config.ps);
    for (const pid of pids) found.set(pid, { command: table.find((p) => p.pid === pid)?.command });
    return found;
  }
  for (const pid of pids) {
    const output = runLsof(config.lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    found.set(pid, { dir: parseFields(output)[0]?.name });
  }
  return found;
}

/** Whether a process runs from this checkout: its working directory, or a file of it on its command line. */
function runsHere(where: Whereabouts | undefined, checkout: string): boolean {
  if (where?.dir !== undefined) return where.dir === checkout;
  return where?.command !== undefined && commandRunsIn(where.command, checkout);
}

/**
 * Whether a Windows command line runs a file under `dir`: names a path inside
 * it, in any letter case and with either slash, as `node` does when it runs
 * `next` from the checkout's `node_modules`. `dir` is the checkout's real path,
 * and a command line may spell the same file another way: through a short 8.3
 * name, as `%TEMP%` is on many machines, a junction or a `subst` drive. So
 * every absolute path the command line names is resolved too, with `real`, and
 * compared once resolved.
 */
export function commandRunsIn(
  command: string,
  dir: string,
  real: (file: string) => string | undefined = realPathOf,
): boolean {
  const normalize = (text: string) => text.replaceAll("/", "\\").toLowerCase();
  const prefix = normalize(dir).replace(/\\+$/, "") + "\\";
  if (normalize(command).includes(prefix)) return true;
  return commandPaths(command).some((file) => {
    const resolved = real(file);
    return resolved !== undefined && `${normalize(resolved)}\\`.startsWith(prefix);
  });
}

/** The absolute paths a command line names: each word, quoted or not, that is one. */
export function commandPaths(command: string): string[] {
  const words = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
  return words.filter((word) => /^([a-z]:[\\/]|[\\/])/i.test(word));
}

/** A file's real path, as the system resolves it, or `undefined` when it cannot be read. */
function realPathOf(file: string): string | undefined {
  try {
    return realpathSync.native(file);
  } catch {
    return undefined;
  }
}

/** Where a process runs, for a verdict. */
function describeWhereabouts(where: Whereabouts | undefined): string {
  if (where?.dir !== undefined) return `running in ${where.dir}`;
  if (where?.command) return `running ${where.command}`;
  return "running in an unknown directory";
}

/** The working directory of every process in a group; empty when the group is gone. */
function groupCwds(lsof: string, pgid: number): string[] {
  const output = runLsof(lsof, ["-a", "-g", String(pgid), "-d", "cwd", "-Fn"]);
  return parseFields(output).map((file) => file.name);
}

// ── The process table on Windows ────────────────────────────────────────────

/** A process as Windows lists it: its id, its parent's, when it started and its command line. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** When it started, in UTC to the microsecond, so that two spellings compare as text. */
  started: string;
  command: string;
}

/**
 * The PowerShell that lists processes, each as `pid`, `ppid`, `started` and
 * `command`, in JSON on UTF-8, so that a command line naming a path outside
 * ASCII reads as the disk spells it. `filter` narrows it to one process.
 */
export function processTableScript(filter = ""): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    `$list = @(Get-CimInstance -ClassName Win32_Process${filter} | ForEach-Object {`,
    "  [pscustomobject]@{",
    "    pid = [long]$_.ProcessId",
    "    ppid = [long]$_.ParentProcessId",
    // The invariant culture: a custom format's `:` is the culture's time
    // separator, and its calendar may not be the Gregorian one ISO times use.
    "    started = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\"yyyy-MM-dd'T'HH':'mm':'ss'.'ffffff'Z'\", [System.Globalization.CultureInfo]::InvariantCulture) } else { '' })",
    "    command = [string]$_.CommandLine",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $list -Compress",
  ].join("\n");
}

/** Read processes with PowerShell; one that cannot run throws `NoPsError`. */
function runProcessTable(ps: string, filter?: string): ProcessEntry[] {
  const script = Buffer.from(processTableScript(filter), "utf16le").toString("base64");
  const result = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", script], {
    encoding: "utf-8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw new NoPsError();
  if (result.signal !== null) throw new HelperKilledError(ps, result.signal);
  if (result.status !== 0) throw new NoPsError();
  try {
    return parseProcessTable(result.stdout);
  } catch {
    throw new NoPsError();
  }
}

/** Parse the process table's JSON: one object or a list of them, as PowerShell writes either. */
export function parseProcessTable(json: string): ProcessEntry[] {
  const text = json.replace(/^﻿/, "").trim();
  if (text === "") return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    pid: Number(row.pid),
    ppid: Number(row.ppid),
    started: typeof row.started === "string" ? row.started : "",
    command: typeof row.command === "string" ? row.command : "",
  }));
}

/** Every process Windows lists. */
function readProcessTable(ps: string): ProcessEntry[] {
  return runProcessTable(ps);
}

/** A time as the process table spells it, a second earlier, to bound a tree whose first process has not been read. */
export function processTime(date: Date): string {
  return new Date(date.getTime() - 1_000).toISOString().replace(/Z$/, "000Z");
}

/**
 * The processes of a group on Windows: the tree under its first process, each
 * one proven serve's. A process is a member when it is
 *
 *  - the first process, while it is the one the group records, by its start
 *    time, or, before that was read, one that started after `notBefore`;
 *  - a member the group records (`members`), still running with the start
 *    time recorded, whatever became of the processes between it and the first;
 *  - a process whose parent is a member, or is in `known`, and that started no
 *    earlier than that parent and no later than another process given the
 *    parent's id after it.
 *
 * A process id is reused once its process ends, so a parent id alone could
 * name a stranger's child, and the children of a process that has ended are
 * never adopted on its id: a record outliving a reboot would otherwise take
 * every process whose parent ended at sign-in, Explorer among them, for its
 * own. `known` is the exception, for a stop under way: members it saw a moment
 * ago and killed since, whose children started meanwhile still belong.
 */
export function treeOf(
  table: readonly ProcessEntry[],
  group: Group,
  known: readonly ProcessEntry[] = [],
): ProcessEntry[] {
  const floor = group.leaderStart ?? group.notBefore ?? "";
  const live = table.find((entry) => entry.pid === group.pgid);
  const rootIsOurs =
    live !== undefined &&
    (group.leaderStart !== undefined ? live.started === group.leaderStart : live.started >= floor);
  const members = new Map<number, ProcessEntry>();
  const nodes: ProcessEntry[] = [];
  const admit = (entry: ProcessEntry) => {
    if (members.has(entry.pid)) return;
    members.set(entry.pid, entry);
    nodes.push(entry);
  };
  if (rootIsOurs) admit(live);
  for (const member of group.members ?? []) {
    const now = table.find((entry) => entry.pid === member.pid && entry.started === member.started);
    if (now !== undefined) admit(now);
  }
  for (const entry of known) {
    if (!nodes.some((node) => node.pid === entry.pid && node.started === entry.started)) {
      nodes.push(entry);
    }
  }
  for (let at = 0; at < nodes.length; at += 1) {
    const parent = nodes[at];
    // A later process holding the parent's id owns the children started after it.
    const successor = table
      .filter((entry) => entry.pid === parent.pid && entry.started > parent.started)
      .map((entry) => entry.started)
      .sort()[0];
    for (const child of table) {
      if (child.ppid !== parent.pid || child.pid === parent.pid) continue;
      if (child.started < parent.started) continue;
      if (successor !== undefined && child.started >= successor) continue;
      admit(child);
    }
  }
  // A member seen earlier in this stop that still runs is still a member.
  for (const entry of known) {
    const now = table.find((each) => each.pid === entry.pid && each.started === entry.started);
    if (now !== undefined) members.set(now.pid, now);
  }
  return [...members.values()];
}

/** The identities a state records of a tree's members: each one's id and start time. */
function memberIds(members: readonly ProcessEntry[]): MemberId[] {
  return members.map(({ pid, started }) => ({ pid, started }));
}

// ── The process group ───────────────────────────────────────────────────────

/**
 * A process group serve started: its id, which is its first process's, and
 * when that process started, once read. On Windows, where the group is a tree,
 * `notBefore` bounds its first process until its start time is read.
 */
export interface Group {
  pgid: number;
  leaderStart?: string;
  notBefore?: string;
  /** On Windows, the members serve saw once the server listened (`treeOf`). */
  members?: readonly MemberId[];
}

/** A process as a state records it: its id, and when it started, which tells it from a later one. */
export interface MemberId {
  pid: number;
  started: string;
}

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

function groupAlive(config: ServeConfig, group: Group): boolean {
  if (WINDOWS) return treeOf(readProcessTable(config.ps), group).length > 0;
  return exists(-group.pgid);
}

/**
 * When a process started, as a string that differs for another process given
 * the same id later, or `undefined` when it does not run. Linux keeps it in
 * `/proc`, in clock ticks since the boot, so the boot's id goes with it, and
 * this needs no `ps`, which a slim image may lack; Windows lists it with the
 * process, in UTC to the microsecond, read through PowerShell; elsewhere `ps`
 * reads it, in a locale and a time zone fixed so that two shells agree on its
 * spelling: it prints local time, and an agent's shell often sets `TZ=UTC`. A
 * `ps` that cannot run at all throws `NoPsError`, as when a sandbox refuses
 * it: Codex's, on macOS, will not run a setuid program, and `ps` is one.
 */
export function startTimeOf(pid: number, ps = DEFAULT_CONFIG.ps): string | undefined {
  if (WINDOWS) {
    if (!Number.isSafeInteger(pid) || pid < 0) return undefined;
    const started = runProcessTable(ps, ` -Filter "ProcessId = ${pid}"`)[0]?.started;
    return started ? started : undefined;
  }
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

/**
 * How stopping a group ended: it has, the system refused the signal, it
 * outlived the hard one, or whether it ended could not be read.
 */
export type StopOutcome = "stopped" | "refused" | "survived" | "unknown";

/**
 * Stop a whole group: a polite signal, then a hard one once the grace period
 * runs out. A refused signal ends the attempt at once, since waiting would not
 * change the answer. On Windows the group is a tree, terminated at once.
 */
export async function stopGroup(
  config: ServeConfig,
  group: Group,
  graceMs = config.graceMs,
): Promise<StopOutcome> {
  if (WINDOWS) return stopTree(config, group, graceMs);
  const { pgid } = group;
  const alive = () => groupAlive(config, group);
  if (!signalGroup(pgid, "SIGTERM")) return alive() ? "refused" : "stopped";
  const deadline = Date.now() + graceMs;
  while (alive() && Date.now() < deadline) await sleep(100);
  if (alive()) {
    if (!signalGroup(pgid, "SIGKILL")) return alive() ? "refused" : "stopped";
    const hardDeadline = Date.now() + 2_000;
    while (alive() && Date.now() < hardDeadline) await sleep(50);
  }
  return alive() ? "survived" : "stopped";
}

/**
 * Stop a tree on Windows: terminate every member, the first process first so
 * that none of them starts another, and look again, since a member may have
 * started a process between the look and its end; the members seen are kept,
 * so the children of one that has ended are still found. Windows sends a
 * detached console program no polite signal, so there is no grace period, only
 * the time a stubborn tree is given to end.
 */
async function stopTree(config: ServeConfig, group: Group, graceMs: number): Promise<StopOutcome> {
  const known = new Map<string, ProcessEntry>();
  const deadline = Date.now() + graceMs + 2_000;
  let refused = false;
  for (;;) {
    const members = treeOf(readProcessTable(config.ps), group, [...known.values()]);
    if (members.length === 0) return "stopped";
    if (Date.now() >= deadline) return refused ? "refused" : "survived";
    refused = false;
    for (const member of members) {
      known.set(`${member.pid}@${member.started}`, member);
      try {
        process.kill(member.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") refused = true;
      }
    }
    if (refused && members.every((member) => processAlive(member.pid))) return "refused";
    await sleep(200);
  }
}

/** The command a person runs to stop a group serve never recorded. */
function killCommand(pgid: number): string {
  return WINDOWS ? `taskkill /T /F /PID ${pgid}` : `kill -- -${pgid}`;
}

/** End a group by force, with no tool to read: the whole tree on Windows, the group elsewhere. */
function forceKill(pgid: number): void {
  if (WINDOWS) {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pgid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Gone already, or refused: the verdict says it may still run either way.
  }
}

/**
 * Stop the group a start has just spawned, and never throw for a tool that
 * cannot answer: on Windows the stop reads the process table, and a
 * PowerShell that fails or is killed then would leave a detached server
 * running behind a verdict saying nothing was started. Such a stop ends as
 * `unknown`, with `unproven` saying why, after the group is ended by force
 * while `spawnedRuns` says the process serve spawned still runs, so that its
 * id cannot name another process yet; once it has ended, what it left is
 * reported and nothing is sent.
 */
export async function stopSpawned(
  config: ServeConfig,
  group: Group,
  spawnedRuns: () => boolean,
  stopper: typeof stopGroup = stopGroup,
): Promise<{ outcome: StopOutcome; unproven?: string }> {
  try {
    return { outcome: await stopper(config, group) };
  } catch (error) {
    if (
      !(
        error instanceof NoPsError ||
        error instanceof HelperKilledError ||
        error instanceof NoLsofError
      )
    ) {
      throw error;
    }
    if (!spawnedRuns()) {
      return {
        outcome: "unknown",
        unproven:
          `${error.message}, and its first process had already exited, so nothing was sent to ` +
          "what it left",
      };
    }
    forceKill(group.pgid);
    return {
      outcome: "unknown",
      unproven: `${error.message}, so it was ended by force (${killCommand(group.pgid)}) unread`,
    };
  }
}

/**
 * The verdict for a group serve or stop meant to stop and could not, `why`
 * saying why it was stopping it. Its record is kept, so a later stop still
 * finds it; one a failed start never recorded is named for a person to stop.
 */
function stillRunning(
  config: ServeConfig,
  pgid: number,
  why: string,
  outcome: StopOutcome,
  recorded = true,
  unproven?: string,
): string {
  const { serve, stop } = config.commands;
  if (outcome === "unknown") {
    const then = recorded
      ? `It may still be running, and is still recorded in ${STATE_FILE}, so ${stop} finds it.`
      : `It may still be running, and was never recorded, so ${stop} cannot find it: check ` +
        `for it, and stop it with ${killCommand(pgid)} where that is allowed.`;
    return (
      `failed: still-running — the server ${serve} started (process group ${pgid}) ${why}, ` +
      `and whether it stopped could not be read: ${unproven ?? "no tool answered"}. ${then}`
    );
  }
  const cause =
    outcome === "refused"
      ? "the system refused to signal it, as a sandbox refuses a signal to a process started " +
        "outside it"
      : "it outlived SIGKILL";
  const then = recorded
    ? `It is still running and still recorded in ${STATE_FILE}, so ${stop} run where it may ` +
      "signal the group stops it."
    : `It is still running and was never recorded, so ${stop} cannot find it: stop it with ` +
      `${killCommand(pgid)} where that is allowed.`;
  return (
    `failed: still-running — the server ${serve} started (process group ${pgid}) ${why}, ` +
    `and could not be stopped: ${cause}. ${then}`
  );
}

// ── The state file ──────────────────────────────────────────────────────────

function readState(checkout: string): ServeState | undefined {
  try {
    const state = JSON.parse(readFileSync(path.join(checkout, STATE_FILE), "utf-8")) as ServeState;
    if (
      !(Number.isInteger(state.pgid) && state.pgid > 1 && typeof state.leaderStart === "string")
    ) {
      return undefined;
    }
    // A member is only as good as its identity: one without both is dropped.
    const members = Array.isArray(state.members)
      ? state.members.filter(
          (member) =>
            Number.isInteger(member?.pid) && typeof member?.started === "string" && member.started,
        )
      : undefined;
    return { ...state, members };
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

/** The group a state file records. */
function recordedGroup(state: ServeState): Group {
  return { pgid: state.pgid, leaderStart: state.leaderStart, members: state.members };
}

/**
 * Whether the group a state file names is still serve's server in this
 * checkout: `gone` when no process of it runs, `foreign` when its id now names
 * another group, or when its processes run elsewhere, as in a checkout copied
 * with its `.serve/`. A first process whose start time cannot be read is
 * neither, and throws `NoPsError`; a running group none of whose processes
 * lsof can see is neither too, and throws `NoLsofError`. On Windows, where a
 * process's directory cannot be read, the record's own checkout stands for it:
 * the start time it compares is read to the microsecond.
 */
function ownership(
  config: ServeConfig,
  state: ServeState,
  checkout: string,
): "ours" | "gone" | "foreign" {
  const group = recordedGroup(state);
  if (WINDOWS) return treeOwnership(config, state, checkout);
  if (!groupAlive(config, group)) return "gone";
  // A group's id is its first process's. While that process runs it must be
  // the one serve started; once it has ended, the id is not given to another
  // process until the whole group has ended too, so the group is still serve's.
  const leaderStart = leaderStartOf(state.pgid, config.ps);
  if (leaderStart !== undefined && leaderStart !== state.leaderStart) return "foreign";
  const cwds = groupCwds(config.lsof, state.pgid);
  if (cwds.length > 0) return cwds.includes(checkout) ? "ours" : "foreign";
  // Nothing seen: the group has ended since, or lsof may not look at its
  // processes, which proves neither way.
  if (!groupAlive(config, group)) return "gone";
  throw new NoLsofError(state.pgid);
}

/**
 * `ownership` on Windows, where the group is the tree under its first process.
 * The tree holds only processes proven the record's (`treeOf`): the first one
 * and the recorded members by their start times, each one under them by
 * starting after its parent and before any process given its parent's id
 * later. Unlike a process group's id, a process's id is
 * given to another process as soon as it ends, even while its children run on,
 * so the process holding the recorded id says nothing about a tree that still
 * has members. When the tree has none, a process holding that id is another's,
 * since the tree would have held it had it started when the record says; one
 * whose start time cannot be read proves neither way, and throws `NoPsError`.
 */
function treeOwnership(
  config: ServeConfig,
  state: ServeState,
  checkout: string,
): "ours" | "gone" | "foreign" {
  const here = state.checkout === checkout ? "ours" : "foreign";
  if (groupAlive(config, recordedGroup(state))) return here;
  const leaderStart = leaderStartOf(state.pgid, config.ps);
  if (leaderStart === undefined) return "gone";
  // The first process started since the tree was read: still the record's.
  return leaderStart === state.leaderStart ? here : "foreign";
}

/**
 * The `refused: no-lsof` verdict for a recorded group that still runs where
 * lsof sees none of its processes.
 */
function unseenGroup(config: ServeConfig, pgid: number): string {
  const { serve, stop } = config.commands;
  return (
    `refused: no-lsof — process group ${pgid}, recorded in ${STATE_FILE}, still runs, but ` +
    `${config.lsof} sees none of its processes, so whether it is the server ${serve} started ` +
    `here cannot be told. Nothing was signalled or started, and the record was kept: run ${stop} ` +
    `where lsof can see it, or remove ${STATE_FILE} if that group is not this checkout's ` +
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
  const { serve, stop } = config.commands;
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
          `${serve} or ${stop} was killed before it could remove it. Nothing was done: if ` +
          `no other one is running in this checkout, remove ${LOCK_FILE} and run again.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new BusyError(
        known
          ? `refused: busy — pid ${pid} has held ${LOCK_FILE} for longer than a ${serve} takes. ` +
              `Nothing was done. If pid ${pid} is not a ${serve} or ${stop}, one that was ` +
              `killed left the file behind and its pid has been reused: remove ${LOCK_FILE} and ` +
              "run again."
          : `refused: busy — ${LOCK_FILE} has stayed empty for longer than a ${serve} takes, so ` +
              `a run was killed as it took it. Nothing was done: remove ${LOCK_FILE} and run again.`,
      );
    }
    if (known && !announced) {
      config.print(
        `waiting for another ${serve} or ${stop} (pid ${pid}) to finish in this checkout`,
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

function readScripts(checkout: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

/**
 * The scripts npm runs around `dev` (`predev`, `postdev`), which `npm run dev`
 * runs and serve, starting `run-next.mts` itself, would not.
 */
export function devHooksOf(scripts: Readonly<Record<string, string>>): string[] {
  return ["predev", "postdev"].filter((name) => scripts[name] !== undefined);
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
  const { serve: serveCommand, dev } = config.commands;
  const checkout = realpathSync.native(config.checkout);
  const host = config.host.trim() || "127.0.0.1";

  if (!isLoopbackHost(host)) {
    print(
      `refused: not-loopback — APP_HOST=${host} would open the server beyond this machine, ` +
        `where anyone who can reach it runs methods on your key. ${serveCommand} listens on ` +
        `loopback only; ${dev} with APP_HOST=${host} runs it in the foreground, with a warning.`,
    );
    return EXIT_FAILED;
  }
  const scripts = readScripts(checkout);
  const script = scripts.dev ?? "";
  const devScript = readDevScriptOptions(script);
  const hooks = devHooksOf(scripts);
  if (!("problem" in devScript) && hooks.length > 0) {
    print(
      `refused: dev-script — package.json has ${hooks.join(" and ")}, which npm runs around ` +
        `the dev script and ${serveCommand}, running scripts/run-next.mts itself with no npm in ` +
        `between, would not, so it would not start the server ${dev} starts. Nothing was ` +
        `started: run ${dev} in the foreground, or remove ${hooks.length > 1 ? "them" : "it"}.`,
    );
    return EXIT_FAILED;
  }
  if ("problem" in devScript) {
    print(
      devScript.problem === "host"
        ? `refused: not-loopback — the dev script in package.json (${JSON.stringify(script)}) ` +
            `gives next ${devScript.option}, which would win over the host APP_HOST names, so ` +
            `${serveCommand} does not start it. Name the host in APP_HOST and the port in ` +
            "APP_PORT instead."
        : `refused: dev-script — the dev script in package.json (${JSON.stringify(script)}) is ` +
            `not ${JSON.stringify(TEMPLATE_DEV_SCRIPT)} followed by plain options for next, ` +
            `which ${serveCommand} runs itself, with no npm or shell in between, so it would not ` +
            `start the server ${dev} starts. Nothing was started: put the template's dev script ` +
            `back, or run ${dev} in the foreground.`,
    );
    return EXIT_FAILED;
  }
  const command = [...config.command, ...devScript.options];
  if (
    config.port !== undefined &&
    !(Number.isInteger(config.port) && config.port > 0 && config.port < 65536)
  ) {
    print(`refused: bad-port — APP_PORT=${config.port} is not a port number.`);
    return EXIT_FAILED;
  }

  try {
    return await exclusive(config, checkout, (interrupt) =>
      serveChecked({ ...config, command }, checkout, host, interrupt),
    );
  } catch (error) {
    if (error instanceof NoLsofError) {
      print(
        error.pgid !== undefined
          ? unseenGroup(config, error.pgid)
          : refusedNoLsof(config, `${serveCommand} reads who holds the port`, error.detail),
      );
      return EXIT_FAILED;
    }
    if (error instanceof NoPsError) {
      print(
        refusedNoPs(
          config,
          error,
          `${serveCommand} reads when the server's first process started, to tell it later ` +
            "from a process given the same id",
          `Nothing was started: run ${serveCommand} where it can, or ${dev} in the foreground.`,
        ),
      );
      return EXIT_FAILED;
    }
    throw error;
  }
}

/**
 * The `refused: no-lsof` verdict for a tool that cannot read the listeners:
 * `need` says what serve or stop reads them for.
 */
function refusedNoLsof(config: ServeConfig, need: string, detail?: string): string {
  if (detail !== undefined) {
    return (
      `refused: no-lsof — ${need}, and ${detail}, so it cannot tell what listens. Nothing more ` +
      `was done. Run ${config.commands.dev} in the foreground.`
    );
  }
  if (WINDOWS) {
    return (
      `refused: no-lsof — ${need} with netstat, and ${config.lsof} is not on the PATH or does ` +
      `not list TCP sockets as Windows' own does. Run ${config.commands.dev} in the foreground.`
    );
  }
  return (
    `refused: no-lsof — ${need} with lsof, and ${config.lsof} is not on the PATH or does not ` +
    "take lsof's options, as BusyBox's does not. Install lsof, or run " +
    `${config.commands.dev} in the foreground.`
  );
}

/**
 * The `refused: no-ps` verdict. Without a pid, serve's own start time could not
 * be read, and `need` says what serve or stop reads it for; with one, the
 * recorded group still runs and its first process's could not, so the record
 * is kept for a later run that can read it.
 */
function refusedNoPs(config: ServeConfig, error: NoPsError, need: string, then: string): string {
  const { serve, stop } = config.commands;
  if (error.pid !== undefined) {
    return (
      `refused: no-ps — process group ${error.pid}, recorded in ${STATE_FILE}, still runs, but ` +
      `when its first process started cannot be read ${startTimeReader(config)}, so whether it ` +
      `is the server ${serve} started cannot be told. Nothing was signalled or started, and ` +
      `the record was kept: run ${stop} where it can be read, or remove ${STATE_FILE} if that ` +
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
  const { serve: serveCommand } = config.commands;
  requireLsof(lsof);
  requirePs(config.ps);

  // The server serve started earlier, when it still runs here.
  const state = readState(checkout);
  if (state !== undefined) {
    const owner = ownership(config, state, checkout);
    if (owner === "ours") {
      const group = recordedGroup(state);
      const listening = inGroup(config, group, readListeners(lsof, [state.port]));
      if (listening.length > 0) {
        return reportOwnServer(config, checkout, state, listening, interrupt);
      }
      // Ours, but not listening: a start that never finished. It proves
      // nothing, so it goes before a fresh one starts.
      print(
        `the server ${serveCommand} started earlier (process group ${state.pgid}) is not listening; stopping it.`,
      );
      const outcome = await stopGroup(config, group);
      if (outcome !== "stopped") {
        print(stillRunning(config, state.pgid, "is not listening", outcome));
        return EXIT_FAILED;
      }
    }
    removeState(checkout);
  }

  const candidates = config.port !== undefined ? [config.port] : config.ports;
  const listeners = readListeners(lsof, candidates);

  // A server a person started from this checkout, with `make dev` or
  // `npm run dev`: never stepped around, never stopped.
  const where = whereaboutsOf(config, [...new Set(listeners.map((listener) => listener.pid))]);
  const personal = listeners.find((listener) => runsHere(where.get(listener.pid), checkout));
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
        `refused: port-held — port ${config.port} is held by pid ${holder.pid}, ` +
          `${describeWhereabouts(where.get(holder.pid))}, which is not this checkout. Leave it ` +
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
  const { serve: serveCommand, stop } = config.commands;
  const group = recordedGroup(state);
  const wide = beyond(groupListeners(config, group));
  if (wide.length > 0) {
    const outcome = await stopGroup(config, group);
    if (outcome !== "stopped") {
      print(
        stillRunning(
          config,
          state.pgid,
          `listens beyond this machine (${addressesOf(wide)})`,
          outcome,
        ),
      );
      return EXIT_FAILED;
    }
    removeState(checkout);
    print(
      `refused: not-loopback — the server ${serveCommand} started listened beyond this machine ` +
        `(${addressesOf(wide)}), so it was stopped.`,
    );
    return EXIT_FAILED;
  }
  const url = urlOf(loopbackAddressOf(listening), state.port);
  const page = await requestPage(
    url,
    config.pageMs,
    () => groupAlive(config, group),
    interrupt.signal,
  );
  if (page.status === "interrupted") {
    print(
      `failed: interrupted — ${interrupt.received()} arrived before ${url} answered; the server ` +
        `${serveCommand} started earlier is still running.`,
    );
    return EXIT_FAILED;
  }
  if (page.status !== 200) {
    const outcome = await stopGroup(config, group);
    printLogTail(config, path.join(checkout, LOG_FILE));
    if (outcome !== "stopped") {
      print(stillRunning(config, state.pgid, `did not answer ${url} with 200`, outcome));
      return EXIT_FAILED;
    }
    removeState(checkout);
    print(
      `failed: page ${page.status} — the server ${serveCommand} started earlier did not answer ` +
        `${url} with 200, so it was stopped.`,
    );
    return EXIT_FAILED;
  }
  if (WINDOWS) {
    // Members started since the record was written are recorded too.
    writeState(checkout, {
      ...state,
      members: memberIds(treeOf(readProcessTable(config.ps), group)),
    });
  }
  const title = "title" in page ? page.title : undefined;
  print(`already-serving ${describePage(url, title)} (log ${LOG_FILE}); stop it with: ${stop}`);
  return EXIT_OK;
}

async function reportPersonalServer(
  config: ServeConfig,
  personal: Listener,
  sockets: readonly Listener[],
  interrupt: Interrupt,
): Promise<number> {
  const { print } = config;
  const { serve: serveCommand, stop } = config.commands;
  const where = `pid ${personal.pid}, started outside ${serveCommand}`;
  if (!sockets.every((listener) => isLoopbackAddress(listener.address))) {
    print(
      `refused: not-loopback — this checkout's server on port ${personal.port} (${where}) listens ` +
        `beyond this machine (${sockets.map((l) => l.address).join(", ")}). ${serveCommand} ` +
        "stops only what it started, so it is still running: stop it yourself.",
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
        `with 200. ${serveCommand} did not start it, so it is still running.`,
    );
    return EXIT_FAILED;
  }
  const title = "title" in page ? page.title : undefined;
  print(`already-serving ${describePage(url, title)} (${where}, so ${stop} leaves it alone)`);
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
  const { stop } = config.commands;
  const log = path.join(checkout, LOG_FILE);
  const output = openSync(log, "w");

  const [command, ...args] = config.command;
  // On Windows, the earliest a process of this start can have started.
  const notBefore = processTime(new Date());
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd: checkout,
      // A new session: a group of its own for one signal to stop, and out of
      // reach of the terminal's hangup. On Windows, a process that outlives
      // this one, outside the job Node ends with it, and with no console at
      // all: what it starts must then ask for a hidden one, as run-next.mts
      // starts next with `windowsHide`, or Windows opens a visible console
      // for it, as it did for the `cmd.exe` npm started here.
      detached: true,
      windowsHide: true,
      stdio: ["ignore", output, output],
      env: { ...process.env, APP_HOST: host, APP_PORT: String(port) },
    });
  } finally {
    closeSync(output);
  }
  child.unref();
  let exit: string | undefined;
  const exited = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      exit = signal ? `signal ${signal}` : `code ${code}`;
      resolve();
    });
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
  const group: Group = { pgid, notBefore };

  // From here the group is stopped unless its page is proven: each verdict
  // below says why, and an error on the way stops it just the same before it
  // propagates. The server is in a session of its own, so the terminal's
  // Ctrl-C does not reach it; the interruption `exclusive` catches does. A
  // group that outlives its stop keeps its record, once it has one, and the
  // verdict says it still runs rather than the status it was stopped for.
  let settled = false;
  let recorded = false;
  let unproven: string | undefined;
  const stopStarted = async (): Promise<StopOutcome> => {
    const stopped = await stopSpawned(config, group, () => exit === undefined);
    unproven = stopped.unproven;
    if (stopped.outcome === "stopped") removeState(checkout);
    return stopped.outcome;
  };
  const giveUp = async (status: string, reason: string, tail = true): Promise<number> => {
    settled = true;
    const outcome = await stopStarted();
    if (tail) printLogTail(config, log);
    print(
      outcome === "stopped"
        ? `${status} — ${reason}`
        : stillRunning(config, pgid, `failed to start (${status})`, outcome, recorded, unproven),
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
      // Gone before its start time was read. Its exit is reported once Node
      // has run the event that carries it, which the synchronous read held back.
      if (exit === undefined) await Promise.race([exited, sleep(1_000)]);
      return await giveUp(
        "failed: exited",
        `the dev server exited (${exit ?? "at once"}) before it could be recorded.`,
      );
    }
    group.leaderStart = leaderStart;
    const startedAt = new Date().toISOString();
    // On Windows the record also names every process of the tree it can see,
    // read once the server listens and again once its page answers, so that a
    // server whose parents end is still known for serve's (`treeOf`).
    const record = (url: string, members?: MemberId[]) => {
      if (members !== undefined) group.members = members;
      writeState(checkout, {
        pgid,
        leaderStart,
        port,
        url,
        log: LOG_FILE,
        checkout,
        startedAt,
        ...(group.members !== undefined ? { members: [...group.members] } : {}),
      });
      recorded = true;
    };
    const seen = () =>
      WINDOWS ? memberIds(treeOf(readProcessTable(config.ps), group)) : undefined;
    record(urlOf(host.includes(":") ? `[${host}]` : host, port));
    print(`starting the dev server on port ${port} (process group ${pgid}, log ${LOG_FILE})`);

    // The port opens when a process of this group listens on it.
    const deadline = Date.now() + config.waitMs;
    let listening: Listener[] = [];
    for (;;) {
      if (interrupt.received()) return await interrupted();
      listening = inGroup(config, group, readListeners(lsof, [port]));
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
    const wide = beyond(groupListeners(config, group));
    if (wide.length > 0) {
      return await giveUp(
        "refused: not-loopback",
        `the dev server listened beyond this machine (${addressesOf(wide)}), so it was stopped ` +
          "before its page was requested.",
        false,
      );
    }

    const url = urlOf(loopbackAddressOf(listening), port);
    record(url, seen());
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
    const after = beyond(groupListeners(config, group));
    if (after.length > 0) {
      return await giveUp(
        "refused: not-loopback",
        `the dev server listened beyond this machine (${addressesOf(after)}), so it was stopped.`,
        false,
      );
    }

    try {
      record(url, seen());
    } catch (error) {
      // The members read once it listened stand; the page is proven.
      if (!(error instanceof NoPsError)) throw error;
    }
    settled = true;
    print(`serving ${describePage(url, page.title)} (log ${LOG_FILE}); stop it with: ${stop}`);
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
        print(
          stillRunning(config, pgid, "hit an error while starting", outcome, recorded, unproven),
        );
      }
    }
  }
}

// ── stop ────────────────────────────────────────────────────────────────────

/** Stop the server serve started here, when it is still this checkout's. */
export async function stop(config: ServeConfig): Promise<number> {
  const { print } = config;
  const { serve: serveCommand, stop: stopCommand } = config.commands;
  const checkout = realpathSync.native(config.checkout);
  if (!existsSync(path.join(checkout, SERVE_DIR))) {
    print(`not-running — ${serveCommand} has no server recorded in this checkout.`);
    return EXIT_OK;
  }
  try {
    return await exclusive(config, checkout, () => stopChecked(config, checkout));
  } catch (error) {
    if (error instanceof NoLsofError) {
      print(
        error.pgid !== undefined
          ? unseenGroup(config, error.pgid)
          : refusedNoLsof(
              config,
              `${stopCommand} checks that the recorded process group still runs in this ` +
                "checkout before signalling it",
              error.detail,
            ),
      );
      return EXIT_FAILED;
    }
    if (error instanceof NoPsError) {
      print(
        refusedNoPs(
          config,
          error,
          `${stopCommand} signals the recorded process group only once its first process's ` +
            `start time proves it is the server ${serveCommand} started`,
          `Nothing was signalled, and ${STATE_FILE} was kept, so ${stopCommand} run where it ` +
            "can still stops the server.",
        ),
      );
      return EXIT_FAILED;
    }
    throw error;
  }
}

async function stopChecked(config: ServeConfig, checkout: string): Promise<number> {
  const { print } = config;
  const { serve: serveCommand } = config.commands;
  const state = readState(checkout);
  if (state === undefined) {
    print(`not-running — ${serveCommand} has no server recorded in this checkout.`);
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
      `not-running — the server ${serveCommand} started (process group ${state.pgid}) has ` +
        "already exited.",
    );
    return EXIT_OK;
  }
  if (owner === "foreign") {
    removeState(checkout);
    print(
      `not-running — process group ${state.pgid} is no longer the server ${serveCommand} ` +
        "started here, so it was left alone.",
    );
    return EXIT_OK;
  }
  const outcome = await stopGroup(config, recordedGroup(state));
  if (outcome !== "stopped") {
    print(stillRunning(config, state.pgid, `serves ${state.url}`, outcome));
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
    else if (flag === "--port") args.port = portOf(value);
    else throw new UsageError(`unknown argument ${flag}`);
  }
  return args;
}

/** A port as typed: a number, or `NaN`, which serve refuses as `bad-port`. */
function portOf(value: string): number {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
}

/**
 * The host and port serve is asked for: the flags, else `APP_HOST` and
 * `APP_PORT` from the environment, a blank value being none, as `npm run dev`
 * reads them. Under make (`MAKELEVEL`) the flags are the whole request: the
 * Makefile exports its own defaults under those names and has already turned
 * what the person gave, on its command line or in the shell, into flags.
 */
export function withEnvironment(args: ServeArgs, env: NodeJS.ProcessEnv): ServeArgs {
  if (env.MAKELEVEL?.trim()) return args;
  const host = env.APP_HOST?.trim();
  const port = env.APP_PORT?.trim();
  return {
    ...args,
    ...(args.host === undefined && host ? { host } : {}),
    ...(args.port === undefined && port ? { port: portOf(port) } : {}),
  };
}

/** The whole command, exit code included. */
export async function runServe(
  argv: readonly string[],
  overrides: Partial<ServeConfig> = {},
): Promise<number> {
  let args: ServeArgs;
  try {
    args = withEnvironment(parseServeArgs(argv), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`serve: ${error.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const config: ServeConfig = {
    ...DEFAULT_CONFIG,
    commands: commandsFor(process.env),
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...overrides,
  };
  if (!existsSync(config.checkout)) throw new Error(`no checkout at ${config.checkout}`);
  return args.action === "stop" ? stop(config) : serve(config);
}
