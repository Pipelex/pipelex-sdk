// @vitest-environment node
//
// Anchor-drift and behavior tests for the bootstrap script.
//
// Some of the script's transforms hang on exact string anchors in living
// template files (CLAUDE.md, src/site.ts). These tests copy the real target
// files into a temp dir and run the real CLI against them, so any template edit
// that breaks an anchor fails CI here instead of silently rotting the bootstrap
// on a consumer's machine.
//
// A bootstrapped project no longer carries those anchors — that is what the
// bootstrap does — so every test that reads the real files runs only while this
// repo is still the template. Without that guard the project's own `make all`
// would fail between the bootstrap and the step that deletes this skill.

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { URL, fileURLToPath } from "node:url";

import {
  REMOVALS,
  RESET_VERSION,
  TARGETS,
  TEMPLATE_NAME,
  TEMPLATE_ONLY_BEGIN,
  TEMPLATE_ONLY_END,
  TEMPLATE_TITLE,
  TEMPLATE_URL,
  resolveLicense,
  stripTemplateOnly,
  stripTemplateParagraph,
  titleFromName,
  transformPackageJson,
  transformSite,
} from "./bootstrap.mjs";

const SCRIPT = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "../../../..");
const IS_TEMPLATE =
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).name === TEMPLATE_NAME;

// Formatting the rewritten files through Prettier needs the repo's own config
// beside them, or the temp copies would print at Prettier's defaults.
const SUPPORT_FILES = [".prettierrc", ".prettierignore"];

// A test that runs the real CLI spawns Node, and the rewriting ones run
// Prettier inside it too, which is slow on a busy machine: vitest's 5-second
// default would fail the template's `make all` whenever the machine is loaded.
const SPAWNS = { timeout: 60_000 };

const tempRoots = [];
afterAll(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

function copyInto(root, rel) {
  const src = path.join(REPO_ROOT, rel);
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

/** Copy the script's real target files from the repo into a fresh temp dir. */
function makeTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  tempRoots.push(root);
  for (const { rel } of TARGETS) copyInto(root, rel);
  for (const rel of [...REMOVALS, ...SUPPORT_FILES]) copyInto(root, rel);
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

/** How the script names a removal: a directory with its trailing slash, a file without. */
function shownRemoval(rel) {
  return fs.statSync(path.join(REPO_ROOT, rel)).isDirectory() ? `${rel}/` : rel;
}

/** Everything a project keeps that could name the create gesture, as repo-relative paths. */
function keptTextFiles() {
  const skipped = new Set(["node_modules", ".next", ".git", "wip", "test-results"]);
  // Rendered or reset whole by the bootstrap, trimmed structurally (package.json),
  // or removed by the gesture itself once it has run (the bootstrap skill).
  const rewritten = new Set(["README.md", "CHANGELOG.md", "package.json", "package-lock.json"]);
  const found = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (skipped.has(child) || child === ".claude/skills/bootstrap") continue;
      if (REMOVALS.some((removed) => child === removed || child.startsWith(`${removed}/`)))
        continue;
      if (entry.isDirectory()) visit(child);
      else if (
        entry.isFile() &&
        !rewritten.has(child) &&
        /\.(md|mts|ts|tsx|mjs|js|json|yml|css)$|^Makefile$/.test(entry.name)
      )
        found.push(child);
    }
  };
  visit("");
  return found;
}

/**
 * The values `src/site.ts` holds, read by evaluating its object literal rather
 * than by matching text: the formatter is free to pick either quote style.
 */
function siteValues(text) {
  const match = /export const SITE = (\{[\s\S]*?\n\});/.exec(text);
  if (!match) throw new Error("src/site.ts: `export const SITE = {…};` not found");
  return { ...vm.runInNewContext(`(${match[1]})`) };
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

describe.skipIf(!IS_TEMPLATE)("bootstrap.mjs against the template's files", SPAWNS, () => {
  it("rewrites every target file with zero warnings", () => {
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

    // The README is the project's own; the template is named once, as provenance.
    const readme = read(root, "README.md");
    expect(readme.startsWith("# Invoice Extractor\n\nExtracts invoices.\n")).toBe(true);
    expect(readme).not.toContain(TEMPLATE_TITLE);
    const provenance = `[${TEMPLATE_NAME}](${TEMPLATE_URL})`;
    expect(readme.split(provenance)).toHaveLength(2);
    expect(readme.replace(provenance, "")).not.toContain(TEMPLATE_NAME);
    expect(readme).toContain("[MIT license](LICENSE)");

    const claude = read(root, "CLAUDE.md");
    expect(claude).not.toContain(TEMPLATE_NAME);
    expect(claude).not.toContain("This directory is a **template**.");
    expect(claude).toContain("# invoice-extractor");
    expect(claude).toContain("Extracts invoices.");

    expect(read(root, "AGENTS.md")).not.toContain(TEMPLATE_NAME);

    expect(siteValues(read(root, "src/site.ts"))).toEqual({
      title: "Invoice Extractor",
      description: "Extracts invoices.",
    });

    const year = new Date().getFullYear();
    expect(read(root, "LICENSE")).toContain(`Copyright (c) ${year} Acme Corp`);
    expect(read(root, "CHANGELOG.md")).toMatch(/## \[v0\.1\.0\] - \d{4}-\d{2}-\d{2}/);

    // What only the template needs does not travel into a project: the create
    // gesture, with everything that describes it.
    for (const rel of REMOVALS) {
      expect(res.stdout).toContain(`removed ${shownRemoval(rel)}`);
      expect(fs.existsSync(path.join(root, rel))).toBe(false);
    }
    expect(pkg.scripts.create).toBeUndefined();
    expect(pkg.scripts["add-method"]).toBeDefined();
    for (const rel of ["Makefile", "CLAUDE.md", "AGENTS.md", "docs/ci.md"]) {
      const text = read(root, rel);
      expect(text).not.toContain(TEMPLATE_ONLY_BEGIN);
      expect(text).not.toContain(TEMPLATE_ONLY_END);
      expect(text).not.toMatch(/make create|npm run create/);
    }
    expect(read(root, "Makefile")).not.toMatch(/^create:/m);
    expect(read(root, "Makefile")).toMatch(/^add-method:/m);
    // A doubled blank line is what a careless removal leaves in the one file
    // Prettier does not format.
    expect(read(root, "Makefile")).not.toMatch(/\n\n\n/);
  });

  it("names the create gesture, the mono-repo and every removed file only in what a project does not keep", () => {
    // Every other mention would describe, in a project, a gesture that is gone,
    // a repository the project was never part of, or a file that is not there.
    // A removed file is looked for by its path and, since a relative link names
    // it by its bare name, by that name too; a directory only by its path.
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const removedNames = REMOVALS.flatMap((rel) =>
      fs.statSync(path.join(REPO_ROOT, rel)).isDirectory() ? [rel] : [rel, path.basename(rel)],
    );
    const removedPattern = new RegExp(
      `(?<![\\w-])(?:${removedNames.map(escape).join("|")})(?![\\w-])`,
    );
    const leaks = keptTextFiles().filter((rel) => {
      const text = read(REPO_ROOT, rel);
      let kept = text.includes(TEMPLATE_ONLY_BEGIN) ? stripTemplateOnly(text, rel) : text;
      // The charter paragraph goes too: `make create` always passes --clean.
      if (rel === "CLAUDE.md") kept = stripTemplateParagraph(kept);
      return (
        /make create|npm run create|scripts\/create\.mts|lib\/create\.mts|pipelex-method-apps|mono-repo/.test(
          kept,
        ) || removedPattern.test(kept)
      );
    });
    expect(leaks).toEqual([]);
  });

  it("names the template in CLAUDE.md's heading and nowhere else", () => {
    // A token pass renames every occurrence, so a mention in prose would be
    // renamed into a sentence about the project that no longer makes sense.
    const claude = read(REPO_ROOT, "CLAUDE.md");
    expect(claude.startsWith(`# ${TEMPLATE_NAME}\n`)).toBe(true);
    expect(claude.split(TEMPLATE_NAME)).toHaveLength(2);
    expect(claude).not.toContain(TEMPLATE_TITLE);
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
    expect(siteValues(read(root, "src/site.ts")).title).toBe("Cash $$ Tracker");
    const license = read(root, "LICENSE");
    expect(license).toContain("AT&T $& Holdings");
    expect(license).not.toContain("{holder}");
  });

  it("writes a JSX-significant title as a string literal, never as markup", () => {
    const root = makeTempRepo();
    const title = 'Bob\'s <Lab> & {Co} "Quoted"';
    const res = runScript([...baseArgs(root, { "--title": title }), "--clean"]);
    expect(res.status).toBe(0);
    // Prettier may re-quote the literal; what matters is the value it holds.
    expect(siteValues(read(root, "src/site.ts")).title).toBe(title);
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
    for (const rel of REMOVALS) {
      expect(res.stdout).toContain(`remove  ${shownRemoval(rel)}`);
      expect(fs.existsSync(path.join(root, rel))).toBe(true);
    }
  });

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

  it("states a proprietary license in the README it renders", () => {
    const root = makeTempRepo();
    const res = runScript([
      ...baseArgs(root),
      "--license",
      "proprietary",
      "--license-holder",
      "Acme Corp",
      "--clean",
    ]);
    expect(res.status).toBe(0);
    expect(read(root, "README.md")).toContain("This project is proprietary");
    expect(JSON.parse(read(root, "package.json")).license).toBe("UNLICENSED");
  });
});

describe("bootstrap.mjs input guards", SPAWNS, () => {
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

  it("strips each template-only passage with its markers, collapsing the blank it leaves", () => {
    const text = [
      "keep one",
      "",
      "# template-only:begin",
      "create:",
      "\tnpm run create",
      "# template-only:end",
      "",
      "keep two",
      "<!-- template-only:begin -->",
      "gone",
      "<!-- template-only:end -->",
      "keep three",
      "",
    ].join("\n");
    expect(stripTemplateOnly(text, "x")).toBe("keep one\n\nkeep two\nkeep three\n");
  });

  it("leaves a file whose passage is never closed exactly as it was", () => {
    const text = "a\n# template-only:begin\nb\n";
    expect(stripTemplateOnly(text, "x")).toBe(text);
  });

  it("drops the create script from package.json and keeps every other", () => {
    const pkg = JSON.parse(
      transformPackageJson(
        JSON.stringify({
          name: TEMPLATE_NAME,
          description: "d",
          scripts: { dev: "next dev", create: "node scripts/create.mts", "add-method": "x" },
        }),
        { name: "app", title: "App" },
        { description: "App.", lic: resolveLicense("mit", null, 2026) },
      ),
    );
    expect(pkg.scripts).toEqual({ dev: "next dev", "add-method": "x" });
  });

  it("rewrites only the SITE object, leaving the doc comment that names its keys", () => {
    const source = [
      "/** The title: and description: below are the app's identity. */",
      "export const SITE = {",
      '  title: "Old",',
      "  description:",
      '    "Old description.",',
      "};",
      "",
    ].join("\n");
    const updated = transformSite(source, { title: "New" }, { description: 'A "quoted" one.' });
    expect(updated).toContain("/** The title: and description: below are the app's identity. */");
    expect(updated).toContain('title: "New",');
    expect(updated).toContain('description:\n    "A \\"quoted\\" one.",');
  });
});
