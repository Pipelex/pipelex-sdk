// @vitest-environment node
//
// Pins where `npm run dev` and `npm run start` listen, which is a safety
// property rather than a convenience: loopback unless the person widens it.
// Both scripts run `scripts/run-next.mts`, which reads `APP_HOST` and
// `APP_PORT` itself, so this holds on every system, Windows included, where npm
// runs a script with `cmd.exe` and a shell's `${APP_HOST:-…}` is not expanded.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { nextArgs, nextBin } from "./run-next.mts";
import { REPO_ROOT } from "./shared.mts";

const SPAWNS = { timeout: 60_000 };

const scripts = (
  JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  }
).scripts;

describe("where npm run dev and npm run start listen", () => {
  it("runs both through scripts/run-next.mts, with no shell expansion", () => {
    for (const name of ["dev", "start"] as const) {
      expect(scripts[name]).toBe(`node --experimental-strip-types scripts/run-next.mts ${name}`);
      expect(scripts[name]).not.toContain("$");
    }
  });

  it("binds next to loopback and 4300 unless the environment says otherwise", () => {
    for (const mode of ["dev", "start"]) {
      expect(nextArgs(mode, {})).toEqual([mode, "-H", "127.0.0.1", "-p", "4300"]);
      expect(nextArgs(mode, { APP_HOST: "", APP_PORT: " " })).toEqual([
        mode,
        "-H",
        "127.0.0.1",
        "-p",
        "4300",
      ]);
      expect(nextArgs(mode, { APP_HOST: "0.0.0.0", APP_PORT: "4301" })).toEqual([
        mode,
        "-H",
        "0.0.0.0",
        "-p",
        "4301",
      ]);
    }
  });

  it("passes next's own options on, after the host and port", () => {
    expect(nextArgs("dev", {}, ["--turbopack"])).toEqual([
      "dev",
      "-H",
      "127.0.0.1",
      "-p",
      "4300",
      "--turbopack",
    ]);
  });

  it("refuses any other mode", () => {
    expect(() => nextArgs("build", {})).toThrow(/usage: run-next\.mts dev\|start/);
    expect(() => nextArgs("", {})).toThrow(/usage/);
  });

  it("runs the next this project installed", () => {
    expect(nextBin()).toBe(path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next"));
  });

  it("says so and exits 2 when run without a mode", SPAWNS, () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "scripts/run-next.mts"],
      { cwd: REPO_ROOT, encoding: "utf-8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: run-next.mts dev|start");
  });
});
