// @vitest-environment node
//
// Pins how the scripts run npm on every system: `npm run serve` starts the dev
// script with it. Windows is held here on any system, since the answer depends
// only on what it is given.

import { describe, expect, it } from "vitest";

import { npmInvocation } from "./npm.mts";

describe("how the scripts run npm", () => {
  it("runs the npm that npm run names, with this Node, on every system", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(npmInvocation({ npm_execpath: "/x/npm-cli.js" }, platform, "/bin/node")).toEqual({
        command: "/bin/node",
        args: ["/x/npm-cli.js"],
      });
    }
  });

  it("takes npm from the PATH outside npm, except on Windows", () => {
    expect(npmInvocation({}, "linux", "/bin/node")).toEqual({ command: "npm", args: [] });
    // pnpm, yarn and npx name a script that is not npm's: npm on the PATH again,
    // never that script run as npm, whatever its extension.
    for (const named of [
      "/x/pnpm",
      "/x/pnpm/bin/pnpm.cjs",
      "/x/.yarn/releases/yarn-4.5.0.cjs",
      "/x/npm/bin/npx-cli.js",
    ]) {
      expect(npmInvocation({ npm_execpath: named }, "darwin", "/bin/node"), named).toEqual({
        command: "npm",
        args: [],
      });
    }
    // On Windows, npm's own script is still told by its name, with either slash.
    const node = "C:\\nodejs\\node.exe";
    expect(npmInvocation({ npm_execpath: "C:\\x\\pnpm.cjs" }, "win32", node).args).toEqual([
      "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    ]);
    expect(npmInvocation({ npm_execpath: "C:\\y\\npm-cli.js" }, "win32", node).args).toEqual([
      "C:\\y\\npm-cli.js",
    ]);
  });

  it("runs the npm installed beside node.exe on Windows, never npm.cmd", () => {
    const node = "C:\\Program Files\\nodejs\\node.exe";
    expect(npmInvocation({}, "win32", node)).toEqual({
      command: node,
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    });
  });
});
