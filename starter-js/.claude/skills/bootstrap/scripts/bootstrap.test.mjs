// @vitest-environment node
//
// Anchor-drift and behavior tests for the bootstrap script.
//
// The script's transforms hang on exact string anchors in living template
// files (README.md, CLAUDE.md, src/app/layout.tsx, ...). These tests copy the
// real target files into a temp dir and run the real CLI against them, so any
// template edit that breaks an anchor fails CI here instead of silently
// rotting the /bootstrap flow on a consumer's machine. They live inside
// .claude/skills/bootstrap/ on purpose: the skill's final cleanup step removes
// them together with the script on bootstrapped repos.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

import {
  RESET_VERSION,
  TARGETS,
  TEMPLATE_NAME,
  TEMPLATE_TITLE,
  resolveLicense,
  titleFromName,
} from "./bootstrap.mjs";

const SCRIPT = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "../../../..");

const tempRoots = [];
afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** Copy the script's real target files from the repo into a fresh temp dir. */
function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  tempRoots.push(root);
  for (const { rel } of TARGETS) {
    const src = path.join(REPO_ROOT, rel);
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return root;
}

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

/** An empty temp dir to use as a harmless --root for failure-path tests. */
function makeEmptyRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-empty-"));
  tempRoots.push(root);
  return root;
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function baseArgs(root, overrides = {}) {
  const values = {
    "--root": root,
    "--name": "invoice-extractor",
    "--title": "Invoice Extractor",
    "--description": "Extracts invoices.",
    ...overrides,
  };
  return Object.entries(values).flat();
}

describe("bootstrap.mjs anchors", () => {
  it("rewrites every target file with zero warnings against the current template files", () => {
    const root = makeTempRepo();
    const res = runScript([
      ...baseArgs(root),
      "--author-name",
      "Ada Lovelace",
      "--author-email",
      "ada@example.com",
      "--repo-url",
      "https://github.com/acme/invoice-extractor",
      "--license-holder",
      "Acme Corp",
      "--clean",
    ]);
    expect(res.status).toBe(0);
    // Any "warning:" here means a template file drifted away from an anchor.
    expect(res.stderr).toBe("");
    for (const { rel } of TARGETS) {
      expect(res.stdout).toContain(`edited  ${rel}`);
    }

    const pkg = JSON.parse(read(root, "package.json"));
    expect(pkg.name).toBe("invoice-extractor");
    expect(pkg.version).toBe(RESET_VERSION);
    expect(pkg.license).toBe("MIT");
    expect(pkg.author).toBe("Ada Lovelace <ada@example.com>");
    expect(pkg.repository).toBe("https://github.com/acme/invoice-extractor");
    expect(pkg.description).toBe("Extracts invoices.");

    const readme = read(root, "README.md");
    expect(readme).not.toContain(TEMPLATE_NAME);
    expect(readme).not.toContain(TEMPLATE_TITLE);
    expect(readme).toContain("Extracts invoices.");

    const claude = read(root, "CLAUDE.md");
    expect(claude).not.toContain(TEMPLATE_NAME);
    expect(claude).not.toContain("This repo is a **reference template**.");
    expect(claude).not.toMatch(/this starter/i);
    expect(claude).toContain("Extracts invoices.");

    expect(read(root, "src/app/page.tsx")).toContain('>{"Invoice Extractor"}<');
    const layout = read(root, "src/app/layout.tsx");
    expect(layout).toContain('"Invoice Extractor"');
    expect(layout).toContain('description: "Extracts invoices."');

    const year = new Date().getFullYear();
    expect(read(root, "LICENSE")).toContain(`Copyright (c) ${year} Acme Corp`);
    expect(read(root, "CHANGELOG.md")).toMatch(/## \[v0\.1\.0\] - \d{4}-\d{2}-\d{2}/);

    expect(read(root, "src/lib/errors.ts")).not.toMatch(/the starter/i);
    expect(read(root, "Makefile")).not.toMatch(/the starter/i);
    const releaseSkill = read(root, ".claude/skills/release/SKILL.md");
    expect(releaseSkill).not.toContain(TEMPLATE_NAME);
    expect(releaseSkill).not.toMatch(/this starter/i);
  });

  it("keeps $-patterns in user values literal instead of expanding them", () => {
    const root = makeTempRepo();
    const res = runScript([
      ...baseArgs(root, {
        "--name": "cash-tracker",
        "--title": "Cash $$ Tracker",
        "--description": "Costs $' and $& and $$ per month.",
      }),
      "--license-holder",
      "AT&T $& Holdings",
      "--clean",
    ]);
    expect(res.status).toBe(0);
    expect(read(root, "README.md")).toContain("Costs $' and $& and $$ per month.");
    expect(read(root, "src/app/page.tsx")).toContain(JSON.stringify("Cash $$ Tracker"));
    const license = read(root, "LICENSE");
    expect(license).toContain("AT&T $& Holdings");
    expect(license).not.toContain("{holder}");
  });

  it("emits JSX-significant titles as a safe string-literal expression in page.tsx", () => {
    const root = makeTempRepo();
    const title = "Bob's <Lab> & {Co}";
    const res = runScript([...baseArgs(root, { "--title": title }), "--clean"]);
    expect(res.status).toBe(0);
    const page = read(root, "src/app/page.tsx");
    expect(page).toContain(`>{${JSON.stringify(title)}}<`);
    expect(page).not.toContain(`>${title}<`);
  });

  it("--dry-run reports the plan without modifying any file", () => {
    const root = makeTempRepo();
    const before = new Map(TARGETS.map(({ rel }) => [rel, read(root, rel)]));
    // --license-holder so LICENSE registers a change too (MIT without a
    // holder deliberately leaves it untouched).
    const res = runScript([
      ...baseArgs(root),
      "--license-holder",
      "Acme Corp",
      "--clean",
      "--dry-run",
    ]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("dry run");
    for (const { rel } of TARGETS) {
      expect(res.stdout).toContain(`edit    ${rel}`);
      expect(read(root, rel)).toBe(before.get(rel));
    }
  });
});

describe("bootstrap.mjs guards", () => {
  it("refuses to run on a non-template repo unless --force is passed", () => {
    const root = makeTempRepo();
    expect(runScript([...baseArgs(root), "--clean"]).status).toBe(0);

    // The repo is now bootstrapped — a plain re-run must hard-fail...
    const rerun = runScript([...baseArgs(root, { "--name": "other-app" })]);
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain("--force");

    // ...and --force is the explicit opt-in.
    expect(runScript([...baseArgs(root, { "--name": "other-app" }), "--force"]).status).toBe(0);
  });

  it("warns when default MIT keeps the template's copyright holder", () => {
    const root = makeTempRepo();
    const before = read(root, "LICENSE");
    const res = runScript([...baseArgs(root), "--clean"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("--license-holder");
    expect(read(root, "LICENSE")).toBe(before);
  });

  it("warns when the MIT license field is applied over a non-MIT LICENSE body", () => {
    const root = makeTempRepo();
    fs.writeFileSync(
      path.join(root, "LICENSE"),
      "Copyright (c) 2026 Acme Corp\n\nAll rights reserved.\n",
    );
    const res = runScript([...baseArgs(root), "--license-holder", "Acme Corp", "--clean"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("does not look like the MIT");
  });

  it("rejects a flag value that was swallowed by the next flag", () => {
    const res = runScript([
      "--root",
      makeEmptyRoot(),
      "--name",
      "my-app",
      "--description",
      "--dry-run",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("missing value for --description");
  });

  it.each([
    [["--description", "d."], "--name is required"],
    [["--name", "my-app"], "--description is required"],
    [["--name", "Bad Name", "--description", "d."], "invalid package name"],
    [["--name", "my-app", "--description", "d.", "--title", "   "], "--title is empty"],
    [["--name", "my-app", "--description", "   "], "--description is empty"],
    [["--name", "my-app", "--description", "d.", "--license-year", "2026abc"], "license-year"],
    [["--name", "my-app", "--description", "d.", "--author-email", "a@b.c"], "--author-name"],
    [["--name", "my-app", "--description", "d.", "--oops", "x"], "unknown argument"],
  ])("fails fast on bad input: %j", (args, message) => {
    // Pin --root to an empty temp dir: if a case ever passes validation
    // unexpectedly, the run hits "no package.json found" instead of
    // bootstrapping the real repo (--root defaults to ".").
    const res = runScript(["--root", makeEmptyRoot(), ...args]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(message);
  });
});

describe("bootstrap.mjs helpers", () => {
  it("derives titles from package names, scope stripped", () => {
    expect(titleFromName("invoice-extractor")).toBe("Invoice Extractor");
    expect(titleFromName("@acme/invoice-extractor")).toBe("Invoice Extractor");
    expect(titleFromName("my_cool.app")).toBe("My Cool App");
  });

  it("resolves license choices to npm field values", () => {
    expect(resolveLicense(undefined, null, 2026).npmField).toBe("MIT");
    expect(resolveLicense("Proprietary", "Acme", 2026).npmField).toBe("UNLICENSED");
    expect(resolveLicense("Apache-2.0", "Acme", 2026)).toMatchObject({
      kind: "other",
      npmField: "Apache-2.0",
    });
  });
});
