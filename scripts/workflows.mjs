#!/usr/bin/env node
/**
 * Render, or check, the root's twins of every template's CI workflows.
 *
 * GitHub reads a repository's workflows only from `.github/workflows/` at its
 * root, while each template keeps its own workflows in its directory, because
 * they travel into every project made from it. So the root runs twins of them,
 * rendered from the template's files rather than written by hand, so that a
 * twin cannot drift from its source silently. Each template workflow
 * `<template>/.github/workflows/<file>` gets up to two twins, named after the
 * template's slug, its path with every `/` replaced by `-`:
 *
 * - The standalone twin, `<slug>-<file>`, is a reusable workflow, and the root
 *   CI calls it. Each job that checks out extracts the template with
 *   `git archive` into `../standalone/<slug>`, a folder beside the checkout
 *   rather than inside it, gives the copy a repository of its own, and runs its
 *   steps there. So the template installs from the registry with its own
 *   lockfile, exactly as a project made from it would, and nothing at the
 *   repository root can reach it.
 * - The next-SDK twin, `<slug>-next-sdk-<file>`, runs the same jobs on a
 *   pull-request trigger of its own, and after the template's install step it
 *   installs the SDK the template depends on, built from the same commit, over
 *   the registry's copy. It is reported, not required. A template that depends
 *   on no SDK, and a workflow with no install step, get none.
 *
 *   node scripts/workflows.mjs <template>...          write every twin
 *   node scripts/workflows.mjs --check <template>...  exit 1 on a missing, stale or orphaned twin
 *
 * The rendering is a text transform, not a YAML round trip, so a twin keeps
 * the source's comments and layout, and the same source always renders the
 * same twin. It replaces the top-level `on:` block whole, adds the template to
 * the workflow's name and to each job's, and changes nothing in a job that
 * does not check out, such as an aggregator reading only `needs`. In a job
 * that checks out, it sets the job's run steps to the extracted folder, adds
 * the extraction step right after the checkout, points every
 * `${{ github.workspace }}` at the extracted folder, and gives an npm cache the
 * template's lock file, the monorepo's copy of the one the extraction carries.
 * A setup-uv step is left exactly as written: uv finds the project from the
 * working directory of the steps that run it.
 *
 * It refuses a source it cannot render faithfully rather than guessing: a
 * quoted name, a job that already sets `defaults`, a job that calls a reusable
 * workflow, a job that checks out with no inline `runs-on` to set its working
 * directory after, a job that checks out twice or runs a step before its
 * checkout, a flow mapping, a `cache:` input other than npm's whichever action
 * takes it, `github.workspace` anywhere the rewrite cannot reach, the shell's
 * `GITHUB_WORKSPACE`, a workflow with no job that checks out, and everything
 * GitHub resolves from the repository root rather than from the template's
 * directory — a key named for a path, a file or a directory, a local action,
 * and `hashFiles`. For a next-SDK twin, it also refuses a job with more than
 * one install step, and an install written inside a multi-line `run:`. An
 * action input that holds a path under any other name is not recognised, so a
 * new workflow's twins are read before they are committed. It also refuses to
 * write over a hand-written root workflow that has a twin's name.
 *
 * Zero dependencies; runs on the Node the templates already need.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOWS_DIR = ".github/workflows";

/** How a twin's first line opens, which is how a rendered file is told from a hand-written one. */
export const TWIN_MARKER = "# Rendered by `make workflows` from ";

/**
 * The SDKs a template can depend on, each with the directory it is built from.
 * A template's next-SDK twin installs the one it depends on.
 */
export const SDKS = [
  { package: "@pipelex/sdk", ecosystem: "npm", dir: "js" },
  { package: "pipelex-sdk", ecosystem: "pypi", dir: "python" },
];

export class TwinError extends Error {
  constructor(message) {
    super(message);
    this.name = "TwinError";
  }
}

/** A template's path as one name: `method-apps/webapp-js` is `method-apps-webapp-js`. */
export function slugOf(template) {
  return template.replaceAll("/", "-");
}

/**
 * Where a twin extracts its template, relative to the checkout: beside it
 * rather than inside it, so that nothing at the repository root can reach it.
 */
export function extractedDir(template) {
  return `../standalone/${slugOf(template)}`;
}

/** The root file a template workflow's standalone twin is rendered into. */
export function standaloneTwinName(template, file) {
  return `${slugOf(template)}-${file}`;
}

/** The root file a template workflow's next-SDK twin is rendered into. */
export function nextSdkTwinName(template, file) {
  return `${slugOf(template)}-next-sdk-${file}`;
}

/** A YAML scalar as written after its key, without a trailing comment or its quotes. */
function scalar(text) {
  return text
    .replace(/(^|\s+)#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}

/** A mapping key on its line: the column it starts at, its name, and what follows it. */
function keyOf(line) {
  const match = /^( *)(?:-( +))?([\w-]+):(?: +(.*))?$/.exec(line);
  if (!match) return null;
  const column = match[1].length + (match[2] === undefined ? 0 : 1 + match[2].length);
  return { column, dash: match[2] !== undefined, key: match[3], value: (match[4] ?? "").trim() };
}

/** A value that opens a block scalar, whose text sits on the lines below it. */
const BLOCK_SCALAR = /^[|>][-+0-9]*\s*(#.*)?$/;

/** The one spelling of the workspace the rewrite reaches. */
const WORKSPACE = /\$\{\{\s*github\.workspace\s*\}\}/g;

/** Whether a command is a template's install: `npm ci`, or one ending with `make install`. */
function isInstall(command) {
  return command === "npm ci" || /(^|\s)make install$/.test(command);
}

/**
 * Read a workflow into what the rendering needs: its lines, where its
 * top-level name and `on:` block are, and, for each job, its name line, its
 * `runs-on` line, its steps with the lines each spans, and its `cache:` inputs.
 * It throws a TwinError on a line no twin could carry faithfully.
 */
function parseWorkflow(origin, source) {
  const lines = source.replace(/\n$/, "").split("\n");
  const refuse = (line, why) => {
    throw new TwinError(`${origin}: cannot render "${line.trim()}": ${why}`);
  };
  const names = [];
  const workspace = [];
  const jobs = [];
  let on = null;
  let top = null;
  let job = null;
  // The job's steps list, once its `steps:` key is read: the key's column,
  // then the column of its items' dashes once the first is read.
  let steps = null;
  let step = null;
  // The column of the key whose block scalar is being read, if one is.
  let block = null;
  const closeJob = (at) => {
    if (job) job.end = at - 1;
    job = null;
    steps = null;
    step = null;
  };
  // What an expression reaches, on any line outside the `on:` block.
  const expressions = (line, at) => {
    if (line.includes("hashFiles(")) refuse(line, "hashFiles reads from the repository root");
    if (/\$\{?GITHUB_WORKSPACE\b/.test(line)) {
      refuse(
        line,
        "the shell's GITHUB_WORKSPACE is the repository root: write ${{ github.workspace }}, which the twin rewrites",
      );
    }
    const mentions = line.match(/github\.workspace/g)?.length ?? 0;
    if (mentions !== (line.match(WORKSPACE)?.length ?? 0)) {
      refuse(line, "github.workspace is rewritten only when written as ${{ github.workspace }}");
    }
    if (mentions > 0) workspace.push(at);
  };

  for (const [at, line] of lines.entries()) {
    const indent = /^ */.exec(line)[0].length;
    const blank = /^\s*$/.test(line);
    // A block scalar's text: every blank line, and every line deeper than its key.
    if (block !== null && (blank || indent > block)) {
      if (!blank) {
        expressions(line, at);
        if (step) {
          step.last = at;
          if (step.runBlock && isInstall(line.trim())) step.hiddenInstall ??= at;
        }
      }
      continue;
    }
    block = null;
    // A blank line or a comment says nothing about where a block ends.
    if (blank || /^\s*#/.test(line)) continue;

    if (indent === 0) {
      closeJob(at);
      const key = /^("on"|'on'|[\w-]+):(?: +(.*))?$/.exec(line);
      if (!key) refuse(line, "a top-level line that is not a key");
      top = key[1].replace(/["']/g, "");
      if (top === "on") {
        if (on) refuse(line, "a second on: block");
        on = { start: at, end: at };
        continue;
      }
      expressions(line, at);
      if (top === "name") {
        if (/^["']/.test(key[2] ?? "")) refuse(line, "a quoted name");
        names.push(at);
      }
      if (BLOCK_SCALAR.test(key[2] ?? "")) block = 0;
      continue;
    }
    // The `on:` block is replaced whole, so nothing in it is read.
    if (top === "on") {
      on.end = at;
      continue;
    }

    expressions(line, at);
    if (/^\s+(- )?[\w-]*(path|paths|file|files|directory)(-ignore)?:/.test(line)) {
      refuse(line, "a key naming a path is read from the repository root");
    }
    if (/^\s+(- )?uses:\s*["']?\.\//.test(line)) {
      refuse(line, "a local action is read from the repository root");
    }
    if (/^\s+(- )?[\w-]+:\s*\{(?!\{)/.test(line)) {
      refuse(line, "the keys of a flow mapping are not read");
    }
    const key = keyOf(line);
    if (key && BLOCK_SCALAR.test(key.value)) block = key.column;
    if (top !== "jobs") continue;

    if (indent === 2 && key && !key.dash) {
      closeJob(at);
      job = {
        name: key.key,
        start: at,
        end: null,
        nameLine: null,
        runsOn: null,
        steps: [],
        caches: [],
        checkout: null,
      };
      jobs.push(job);
      continue;
    }
    if (!job) continue;

    if (steps) {
      const dash = /^ *-( |$)/.test(line);
      if (steps.dash === null && dash && indent >= steps.key) steps.dash = indent;
      if (dash && indent === steps.dash) {
        // A dash may stand alone on its line, with the step's first key on the next.
        step = {
          start: at,
          last: at,
          dash: indent,
          keys: key ? key.column : null,
          uses: null,
          run: null,
          runBlock: false,
          hiddenInstall: null,
        };
        job.steps.push(step);
      } else if (indent <= (steps.dash ?? steps.key)) {
        steps = null;
        step = null;
      } else if (step) {
        step.last = at;
        step.keys ??= indent;
      }
    }
    if (step && key && key.column === step.keys) {
      if (key.key === "uses") step.uses = scalar(key.value);
      if (key.key === "run") {
        if (BLOCK_SCALAR.test(key.value)) step.runBlock = true;
        else step.run = scalar(key.value);
      }
    }
    if (key && key.key === "cache") {
      if (scalar(key.value) !== "npm") {
        refuse(
          line,
          "only an npm cache is pointed at the template's lock file, whichever action takes it",
        );
      }
      job.caches.push({ at, column: key.column });
    }
    if (indent === 4 && key && !key.dash) {
      if (key.key === "name") {
        if (/^["']/.test(key.value)) refuse(line, "a quoted name");
        job.nameLine = at;
      }
      if (key.key === "runs-on") job.runsOn = at;
      if (key.key === "defaults") refuse(line, "the job already sets defaults");
      if (key.key === "uses") {
        refuse(line, "a job that calls a reusable workflow runs it from the repository root");
      }
      if (key.key === "steps") steps = { key: 4, dash: null };
    }
  }
  closeJob(lines.length);

  if (names.length !== 1) {
    throw new TwinError(`${origin}: expected one top-level name, found ${names.length}`);
  }
  if (!on) throw new TwinError(`${origin}: no top-level on: block to replace`);
  for (const each of jobs) {
    for (const [index, candidate] of each.steps.entries()) {
      if (!/^actions\/checkout(@|$)/.test(candidate.uses ?? "")) continue;
      if (each.checkout) refuse(lines[candidate.start], "a job that checks out more than once");
      const early = each.steps.slice(0, index).find((s) => s.run !== null || s.runBlock);
      if (early) {
        refuse(
          lines[early.start],
          "a step that runs before the checkout would run in the extracted template, which the step after the checkout makes",
        );
      }
      each.checkout = candidate;
    }
  }
  return { lines, names, on, jobs, workspace };
}

/** The step that extracts the template as the export ships it, at a steps list's dash column. */
function extractionStep(template, dash) {
  const at = " ".repeat(dash);
  const dir = extractedDir(template);
  return [
    `${at}- name: Extract ${template} as the export ships it`,
    `${at}  working-directory: .`,
    `${at}  run: |`,
    `${at}    rm -rf ${dir} && mkdir -p ${dir}`,
    `${at}    git archive HEAD:${template} | tar -x -C ${dir}`,
    `${at}    cd ${dir}`,
    `${at}    git init -q -b main`,
    `${at}    git add -A -f`,
    `${at}    git -c user.name=ci -c user.email=ci@localhost commit -q -m "${template}, as a project made from it starts"`,
  ];
}

/**
 * The step that installs the SDK built from this commit over the registry's copy. The SDK is
 * installed the way its own CI job installs it, `make install` in its directory, rather than
 * with `npm ci`, which the runner's bundled npm refuses on the SDK's lockfile.
 */
function nextSdkStep(sdk, dash) {
  const at = " ".repeat(dash);
  const name = `${at}- name: Install ${sdk.package} built from this commit`;
  if (sdk.ecosystem === "npm") {
    return [
      name,
      `${at}  run: |`,
      `${at}    mkdir -p "$RUNNER_TEMP/next-sdk"`,
      `${at}    (cd "$GITHUB_WORKSPACE/${sdk.dir}" && make install && npm pack --pack-destination "$RUNNER_TEMP/next-sdk")`,
      `${at}    npm install --no-save "$RUNNER_TEMP"/next-sdk/*.tgz`,
    ];
  }
  return [
    name,
    `${at}  run: |`,
    `${at}    uv build --wheel --out-dir "$RUNNER_TEMP/next-sdk" "$GITHUB_WORKSPACE/${sdk.dir}"`,
    `${at}    uv pip install --python .venv/bin/python --reinstall-package ${sdk.package} "$RUNNER_TEMP"/next-sdk/*.whl`,
  ];
}

/** Render one twin; `sdk` is null for the standalone twin. */
function render(template, file, source, sdk) {
  const origin = `${template}/${WORKFLOWS_DIR}/${file}`;
  const { lines, names, on, jobs, workspace } = parseWorkflow(origin, source);
  const refuse = (at, why) => {
    throw new TwinError(`${origin}: cannot render "${lines[at].trim()}": ${why}`);
  };
  const dir = extractedDir(template);
  const twin = sdk ? nextSdkTwinName(template, file) : standaloneTwinName(template, file);
  const text = [...lines];
  const after = lines.map(() => []);
  const dropped = new Set();
  // A new step is set off by a blank line when the step it follows is.
  const insertStep = (at, step) => {
    after[at].push(...(/^\s*$/.test(lines[at + 1] ?? "x") ? ["", ...step] : step));
  };

  const checkingOut = jobs.filter((job) => job.checkout);
  if (checkingOut.length === 0) {
    throw new TwinError(`${origin}: no job checks out the template, so there is nothing to run`);
  }
  for (const at of workspace) {
    if (!checkingOut.some((job) => at >= job.start && at <= job.end)) {
      refuse(at, "github.workspace is rewritten only in a job that checks out");
    }
  }

  text[on.start] = (
    sdk
      ? [
          "on:",
          "  pull_request:",
          "    paths:",
          `      - "${template}/**"`,
          `      - "${sdk.dir}/**"`,
          `      - "${WORKFLOWS_DIR}/${twin}"`,
        ]
      : ["on:", "  workflow_call:"]
  ).join("\n");
  for (let at = on.start + 1; at <= on.end; at += 1) dropped.add(at);

  let installs = 0;
  for (const job of checkingOut) {
    for (let at = job.start; at <= job.end; at += 1) {
      text[at] = text[at].replace(WORKSPACE, `\${{ github.workspace }}/${dir}`);
    }
    if (job.runsOn === null) {
      throw new TwinError(
        `${origin}: job "${job.name}" checks out but has no inline runs-on to set the working directory after`,
      );
    }
    if (scalar(keyOf(lines[job.runsOn]).value) === "") {
      refuse(job.runsOn, "a runs-on value that is not inline");
    }
    after[job.runsOn].push("    defaults:", "      run:", `        working-directory: ${dir}`);
    for (const cache of job.caches) {
      after[cache.at].push(
        `${" ".repeat(cache.column)}cache-dependency-path: ${template}/package-lock.json`,
      );
    }
    insertStep(job.checkout.last, extractionStep(template, job.checkout.dash));
    if (!sdk) continue;
    const hidden = job.steps.find((step) => step.hiddenInstall !== null);
    if (hidden) {
      refuse(
        hidden.hiddenInstall,
        "an install inside a multi-line run is not found: give it a step of its own, so the next SDK can follow it",
      );
    }
    const own = job.steps.filter((step) => step.run !== null && isInstall(step.run));
    if (own.length > 1) {
      refuse(
        own[1].start,
        "a job with more than one install step, so the next SDK has no one place",
      );
    }
    for (const step of own) insertStep(step.last, nextSdkStep(sdk, step.dash));
    installs += own.length;
  }
  if (sdk && installs === 0) return null;

  for (const at of [...names, ...jobs.map((job) => job.nameLine)]) {
    if (at !== null) text[at] += sdk ? ` (${template}, next SDK)` : ` (${template})`;
  }
  const header = sdk
    ? [
        `${TWIN_MARKER}${origin} — edit that file and re-render.`,
        `# It tests ${template}, extracted as the export ships it, against ${sdk.package} built from the`,
        "# same commit, installed over the registry's copy. It is reported, not required.",
      ]
    : [
        `${TWIN_MARKER}${origin} — edit that file and re-render.`,
        `# It runs ${template} extracted exactly as the export ships it, installed from the registry`,
        "# with its own lockfile, as a project made from it would be. The root CI calls it.",
      ];
  const out = [...header];
  for (const [at, line] of text.entries()) {
    if (!dropped.has(at)) out.push(line);
    out.push(...after[at]);
  }
  return `${out.join("\n")}\n`;
}

/** Render the standalone twin of one template workflow, or throw a TwinError naming what it cannot carry. */
export function renderStandaloneTwin(template, file, source) {
  return render(template, file, source, null);
}

/**
 * Render the next-SDK twin of one template workflow against one of `SDKS`, or
 * return null when no job that checks out has an install step for the SDK to
 * follow.
 */
export function renderNextSdkTwin(template, file, source, sdk) {
  return render(template, file, source, sdk);
}

/** The strings of a pyproject.toml's `[project]` dependencies, which may span lines. */
export function pyprojectDependencies(text) {
  const lines = text.split("\n");
  let inProject = false;
  for (const [at, line] of lines.entries()) {
    const table = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (table) {
      inProject = table[1].trim() === "project";
      continue;
    }
    const key = inProject && /^\s*dependencies\s*=\s*\[/.exec(line);
    if (!key) continue;
    // Read from the opening bracket to the one that closes it, which a
    // requirement's extras, in brackets inside its string, do not.
    const rest = [line.slice(key[0].length), ...lines.slice(at + 1)].join("\n");
    const found = [];
    for (let i = 0; i < rest.length && rest[i] !== "]"; i += 1) {
      if (rest[i] === "#") i = rest.indexOf("\n", i) < 0 ? rest.length : rest.indexOf("\n", i);
      else if (rest[i] === '"' || rest[i] === "'") {
        const end = rest.indexOf(rest[i], i + 1);
        if (end < 0) break;
        found.push(rest.slice(i + 1, end));
        i = end;
      }
    }
    return found;
  }
  return [];
}

/** A Python requirement's distribution name, normalized as PyPI compares names. */
function requirementName(requirement) {
  const name = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(requirement)?.[1];
  return name ? name.toLowerCase().replace(/[-_.]+/g, "-") : null;
}

/**
 * The SDK a template depends on, or null: one its package.json lists in its
 * dependencies or devDependencies, or one its pyproject.toml's `[project]`
 * dependencies require.
 */
export function templateSdk(root, template) {
  const dir = path.join(root, template);
  const needs = new Set();
  const manifest = path.join(dir, "package.json");
  if (fs.existsSync(manifest)) {
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    for (const field of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(pkg[field] ?? {})) needs.add(`npm:${name}`);
    }
  }
  const pyproject = path.join(dir, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    for (const requirement of pyprojectDependencies(fs.readFileSync(pyproject, "utf8"))) {
      needs.add(`pypi:${requirementName(requirement)}`);
    }
  }
  const found = SDKS.filter((sdk) => needs.has(`${sdk.ecosystem}:${sdk.package}`));
  if (found.length > 1) {
    throw new TwinError(
      `${template}: depends on ${found.map((sdk) => sdk.package).join(" and ")}, and a next-SDK twin installs one SDK`,
    );
  }
  return found[0] ?? null;
}

/** The workflow files a template carries, sorted. */
export function templateWorkflows(root, template) {
  const dir = path.join(root, template, WORKFLOWS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();
}

/** Every twin one template calls for: `[{ file, kind, text }]`, kind `standalone` or `next-sdk`. */
export function templateTwins(root, template) {
  if (!fs.existsSync(path.join(root, template))) {
    throw new TwinError(`${template}: no such template directory`);
  }
  const sdk = templateSdk(root, template);
  const twins = [];
  for (const file of templateWorkflows(root, template)) {
    const source = fs.readFileSync(path.join(root, template, WORKFLOWS_DIR, file), "utf8");
    const standalone = renderStandaloneTwin(template, file, source);
    twins.push({ file: standaloneTwinName(template, file), kind: "standalone", text: standalone });
    const next = sdk && renderNextSdkTwin(template, file, source, sdk);
    if (next) twins.push({ file: nextSdkTwinName(template, file), kind: "next-sdk", text: next });
  }
  return twins;
}

/** Every twin the templates call for, keyed by its root file name. */
export function expectedTwins(root, templates) {
  const twins = new Map();
  for (const template of templates) {
    for (const { file, text } of templateTwins(root, template)) {
      if (twins.has(file)) throw new TwinError(`two twins would be rendered into ${file}`);
      twins.set(file, text);
    }
  }
  return twins;
}

/** The standalone twins' file names, the reusable workflows the root CI calls. */
export function standaloneTwins(root, templates) {
  return templates.flatMap((template) =>
    templateTwins(root, template)
      .filter((twin) => twin.kind === "standalone")
      .map((twin) => twin.file),
  );
}

/** The next-SDK twins' file names, which run on their own trigger and are never called. */
export function nextSdkTwins(root, templates) {
  return templates.flatMap((template) =>
    templateTwins(root, template)
      .filter((twin) => twin.kind === "next-sdk")
      .map((twin) => twin.file),
  );
}

/** The rendered files already at the root, by name. Hand-written workflows are not listed. */
export function renderedAtRoot(root) {
  const dir = path.join(root, WORKFLOWS_DIR);
  if (!fs.existsSync(dir)) return new Map();
  const found = new Map();
  for (const file of fs.readdirSync(dir).sort()) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    if (text.startsWith(TWIN_MARKER)) found.set(file, text);
  }
  return found;
}

/** What differs between the twins on disk and the ones the templates call for. */
export function compareTwins(root, templates) {
  const expected = expectedTwins(root, templates);
  const present = renderedAtRoot(root);
  const problems = [];
  for (const [file, text] of expected) {
    const onDisk = fs.existsSync(path.join(root, WORKFLOWS_DIR, file))
      ? fs.readFileSync(path.join(root, WORKFLOWS_DIR, file), "utf8")
      : null;
    if (onDisk === null) problems.push({ file, kind: "missing" });
    else if (!onDisk.startsWith(TWIN_MARKER)) {
      throw new TwinError(
        `${WORKFLOWS_DIR}/${file} is hand-written but has a twin's name: rename it, or the template workflow it would be overwritten by`,
      );
    } else if (onDisk !== text) problems.push({ file, kind: "stale" });
  }
  for (const file of present.keys()) {
    if (!expected.has(file)) problems.push({ file, kind: "orphaned" });
  }
  return { expected, problems };
}

export function writeTwins(root, templates) {
  const { expected, problems } = compareTwins(root, templates);
  fs.mkdirSync(path.join(root, WORKFLOWS_DIR), { recursive: true });
  for (const { file, kind } of problems) {
    const target = path.join(root, WORKFLOWS_DIR, file);
    if (kind === "orphaned") fs.rmSync(target);
    else fs.writeFileSync(target, expected.get(file), "utf8");
  }
  return problems;
}

export function main(argv) {
  const check = argv.includes("--check");
  const templates = argv.filter((arg) => arg !== "--check");
  if (templates.length === 0 || templates.some((arg) => arg.startsWith("-"))) {
    console.error("usage: node scripts/workflows.mjs [--check] <template>...");
    return 2;
  }
  try {
    if (check) {
      const { problems } = compareTwins(ROOT, templates);
      if (problems.length === 0) {
        console.log("Workflow twins are current.");
        return 0;
      }
      for (const { file, kind } of problems) console.error(`${kind}: ${WORKFLOWS_DIR}/${file}`);
      console.error("Run `make workflows` to re-render them, and commit the result.");
      return 1;
    }
    const changed = writeTwins(ROOT, templates);
    for (const { file, kind } of changed) {
      console.log(`${kind === "orphaned" ? "removed" : "rendered"} ${WORKFLOWS_DIR}/${file}`);
    }
    if (changed.length === 0) console.log("Workflow twins are already current.");
    return 0;
  } catch (err) {
    if (err instanceof TwinError) {
      console.error(`error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
