// @vitest-environment node
//
// Pins how the Makefile hands a gesture's variables to its script: only what
// the command line gives, never a blank, and always exactly as typed. `make -n`
// prints the command a target would run without running it, so each case reads
// the npm line `add-method` would execute.
//
// It also pins where the servers listen, which is a safety property rather than
// a convenience: loopback unless the person widens it, and said out loud when
// they do.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { REPO_ROOT } from "./shared.mts";

// Every test here spawns `make`, some of them several times over, and a spawn
// is slow on a busy machine, so vitest's 5-second default would fail a loaded
// run: the block takes a budget sized for that.
const SPAWNS = { timeout: 60_000 };

/** Run make in the repo with a clean make environment, plus `env`. */
function make(args: readonly string[], env: Record<string, string> = {}) {
  // A parent make (`make all NAME=x`) passes its own command-line variables
  // down through MAKEFLAGS, which would make them "given" here too. The
  // Makefile also exports where the servers listen, so a parent make would hand
  // its own APP_HOST and APP_PORT down as the environment.
  const {
    MAKEFLAGS: _flags,
    MAKELEVEL: _level,
    MFLAGS: _mflags,
    APP_HOST: _host,
    APP_PORT: _port,
    ...inherited
  } = process.env;
  const result = spawnSync("make", ["--no-print-directory", ...args], {
    cwd: REPO_ROOT,
    env: { ...inherited, ...env },
    encoding: "utf-8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The npm line `make add-method <vars>` would run, with its spacing collapsed. */
function npmLine(vars: readonly string[], env: Record<string, string> = {}): string {
  const { status, stdout, stderr } = make(["-n", "add-method", ...vars], env);
  expect(status, stderr).toBe(0);
  const line = stdout.split("\n").find((printed) => printed.startsWith("npm run add-method"));
  expect(line, stdout).toBeDefined();
  return line!.replace(/\s+/g, " ").trim();
}

describe("the Makefile's gesture arguments", SPAWNS, () => {
  it("passes the values given on the command line, as flags", () => {
    expect(npmLine(["METHOD=bundles/cv", "NAME=cv", "PIPE=screen", "DRY_RUN=1"])).toBe(
      "npm run add-method -- 'bundles/cv' --pipe 'screen' --name 'cv' --dry-run",
    );
  });

  it("treats a blank value, and a 0 switch, as not given", () => {
    expect(npmLine(["METHOD=cv", "NAME=", "PIPE=", "LABEL= ", "DRY_RUN="])).toBe(
      "npm run add-method -- 'cv'",
    );
    expect(npmLine(["METHOD=cv", "DRY_RUN=0"])).toBe("npm run add-method -- 'cv'");
  });

  it("ignores a variable the shell exports", () => {
    expect(npmLine(["METHOD=cv"], { NAME: "from-shell", DRY_RUN: "1" })).toBe(
      "npm run add-method -- 'cv'",
    );
  });

  it("hands a value over exactly as typed, quotes, $ and commas included", () => {
    expect(npmLine(["METHOD=$(touch pwned)", `LABEL=Bob's "$5" app, really`])).toBe(
      `npm run add-method -- '$(touch pwned)' --label 'Bob'\\''s "$5" app, really'`,
    );
  });

  it("refuses a missing or blank METHOD before running anything", () => {
    for (const vars of [[], ["METHOD="], ["METHOD=  "]]) {
      const { status, stdout } = make(["add-method", ...vars]);
      expect(status).toBe(2);
      expect(stdout).toContain("usage: make add-method METHOD=");
      expect(stdout).not.toContain("npm run");
    }
  });
});

describe("where the servers listen", SPAWNS, () => {
  // A makefile read after the real one, whose target prints what the Makefile
  // exports — the environment `npm run dev` and `npm run start` start from.
  const probeDir = mkdtempSync(path.join(tmpdir(), "makefile-listen-"));
  const probe = path.join(probeDir, "probe.mk");
  writeFileSync(probe, 'print-listen:\n\t@echo "[$$APP_HOST]:[$$APP_PORT]"\n');
  afterAll(() => rmSync(probeDir, { recursive: true, force: true }));

  /** What the Makefile exports, as `[host]:[port]`. */
  function exported(vars: readonly string[], env: Record<string, string> = {}): string {
    const { status, stdout, stderr } = make(
      ["-f", "Makefile", "-f", probe, "print-listen", ...vars],
      env,
    );
    expect(status, stderr).toBe(0);
    return stdout.trim();
  }

  /** The arguments `npm run <name>` hands to `next`, in the environment `env`. */
  function nextArgs(name: "dev" | "start", env: Record<string, string> = {}): string {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts[name];
    expect(script).toMatch(/^next /);
    // npm runs a script with sh; echoing it shows what the shell expanded.
    const result = spawnSync("sh", ["-c", `echo ${script}`], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf-8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  it("exports loopback and 4300 by default", () => {
    expect(exported([])).toBe("[127.0.0.1]:[4300]");
  });

  it("exports the host and port given on the command line, or by the shell", () => {
    expect(exported(["APP_HOST=0.0.0.0", "APP_PORT=4301"])).toBe("[0.0.0.0]:[4301]");
    expect(exported([], { APP_HOST: "::1" })).toBe("[::1]:[4300]");
  });

  it("binds both scripts to loopback unless the environment says otherwise", () => {
    for (const name of ["dev", "start"] as const) {
      expect(nextArgs(name)).toBe(`next ${name} -H 127.0.0.1 -p 4300`);
      expect(nextArgs(name, { APP_HOST: "", APP_PORT: "" })).toBe(
        `next ${name} -H 127.0.0.1 -p 4300`,
      );
      expect(nextArgs(name, { APP_HOST: "0.0.0.0", APP_PORT: "4301" })).toBe(
        `next ${name} -H 0.0.0.0 -p 4301`,
      );
    }
  });

  /** What the warning line `make -n <target>` prints would say, run by the shell. */
  function warningSaid(target: string, vars: readonly string[], env: Record<string, string> = {}) {
    const { status, stdout, stderr } = make(["-n", target, ...vars], env);
    expect(status, stderr).toBe(0);
    const line = stdout.split("\n").find((printed) => printed.startsWith('echo "Warning:'));
    expect(line, stdout).toBeDefined();
    const said = spawnSync("sh", ["-c", line!], { cwd: probeDir, encoding: "utf-8" });
    expect(said.status, said.stderr).toBe(0);
    return said.stdout.trim();
  }

  it("warns before a server listens beyond loopback, and only then", () => {
    const warning = "opens this server beyond this machine";
    for (const target of ["run", "start"]) {
      for (const vars of [
        [],
        ["APP_HOST="],
        ["APP_HOST=127.0.0.2"],
        ["APP_HOST=::1"],
        ["APP_HOST=localhost"],
      ]) {
        const { status, stdout, stderr } = make(["-n", target, ...vars]);
        expect(status, stderr).toBe(0);
        expect(stdout).not.toContain(warning);
      }
      for (const vars of [
        ["APP_HOST=0.0.0.0"],
        ["APP_HOST=192.168.1.20"],
        ["APP_HOST=127.0.0.1 ::"],
      ]) {
        const { status, stdout, stderr } = make(["-n", target, ...vars]);
        expect(status, stderr).toBe(0);
        expect(stdout).toContain(warning);
      }
      expect(warningSaid(target, [], { APP_HOST: "0.0.0.0" })).toMatch(
        new RegExp(`^Warning: APP_HOST=0\\.0\\.0\\.0 ${warning}\\.`),
      );
    }
  });

  it("names the host in the warning exactly as set, without running any of it", () => {
    expect(warningSaid("run", [`APP_HOST=$(touch pwned) 'x'`])).toMatch(
      /^Warning: APP_HOST=\$\(touch pwned\) 'x' opens/,
    );
    expect(existsSync(path.join(probeDir, "pwned"))).toBe(false);
  });

  it("says where the servers listen in make help", () => {
    expect(make(["help"]).stdout).toContain("The servers listen on 127.0.0.1, port 4300");
    expect(make(["help", "APP_HOST=0.0.0.0"]).stdout).toContain(
      "The servers listen on 0.0.0.0, port 4300",
    );
    expect(make(["help", "APP_HOST=", "APP_PORT="]).stdout).toContain(
      "The servers listen on 127.0.0.1, port 4300",
    );
  });

  it("guards the default port when APP_PORT is blank, as the scripts use it", () => {
    // A blank port would hand lsof `-iTCP:`, which it rejects, and the guard
    // would pass while Playwright reused whatever holds 4300.
    for (const [vars, env] of [
      [["APP_PORT="], {}],
      [[], { APP_PORT: "" }],
    ] as const) {
      const { status, stdout, stderr } = make(["-n", "port-check", ...vars], env);
      expect(status, stderr).toBe(0);
      expect(stdout).toContain("lsof -nP -iTCP:4300 -sTCP:LISTEN");
      expect(stdout).not.toContain("-iTCP: ");
    }
  });

  it("does not take a bracketed IPv6 host for loopback, since Next cannot bind it", () => {
    expect(warningSaid("run", ["APP_HOST=[::1]"])).toMatch(/^Warning: APP_HOST=\[::1\] opens/);
  });
});
