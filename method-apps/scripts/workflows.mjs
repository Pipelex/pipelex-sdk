#!/usr/bin/env node
/**
 * Render, or check, the root's twin of every template's CI workflows.
 *
 * GitHub reads a repository's workflows only from `.github/workflows/` at its
 * root, while each template keeps its own workflows in its directory, because
 * they travel into every project created from it. So the root runs a twin of
 * each: the same jobs and steps, run inside the template's directory. The twin
 * is rendered from the template's file rather than written by hand, so the two
 * cannot drift apart silently.
 *
 *   node scripts/workflows.mjs <template>...          write every twin
 *   node scripts/workflows.mjs --check <template>...  exit 1 on a missing, stale or orphaned twin
 *
 * The rendering is a text transform, not a YAML round trip, so the twin keeps
 * the source's comments and layout. It refuses a source it cannot render
 * faithfully rather than guessing: a quoted name, a job that already sets
 * `defaults`, a job without an inline `runs-on` to set the working directory
 * after, a flow mapping, a `cache:` input other than npm's whichever action
 * takes it, a setup-uv step with no `with:` block, and everything GitHub
 * resolves from the repository root rather than from the template's directory
 * — a key named for a path, a file or a directory, a local action, and
 * `hashFiles`. An action input that holds a path under any other name is not
 * recognised, so a new workflow's twin is read before it is committed. It also
 * refuses to write over a hand-written root workflow that has a twin's name.
 *
 * Two actions are carried into the template's directory. An npm cache gets
 * `cache-dependency-path: <template>/package-lock.json` after its `cache:`
 * line. A setup-uv step gets `working-directory: <template>` as the first of
 * its inputs, because setup-uv reads everything from that directory — the uv
 * version, the Python, where the virtual environment goes, and the files its
 * cache glob matches — and it defaults to the repository root, where a twin
 * would read none of the template's settings and cache against every
 * template's lock.
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

export class TwinError extends Error {
  constructor(message) {
    super(message);
    this.name = "TwinError";
  }
}

/** A YAML scalar as written after its key, without a trailing comment or its quotes. */
function scalar(text) {
  return text
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
}

/** The root file a template's workflow is twinned into. */
export function twinName(template, file) {
  return `${template}-${file}`;
}

/** Render the root twin of one template workflow, or throw a TwinError naming what it cannot carry. */
export function renderTwin(template, file, source) {
  const origin = `${template}/${WORKFLOWS_DIR}/${file}`;
  const refuse = (line, why) => {
    throw new TwinError(`${origin}: cannot render "${line.trim()}": ${why}`);
  };
  const out = [];
  let names = 0;
  let inJobs = false;
  const jobs = [];
  let job = null;
  // The job's steps list, once its `steps:` key is read: the key's indentation,
  // then the indentation of its items' dashes once the first is read.
  let steps = null;
  // The step being read, for the inputs of the action it uses: its `uses` line
  // when that names setup-uv, the indentation of its `with:` key while that
  // block's first input is awaited, and where that first input went.
  let step = null;
  // A setup-uv step is given the template as its working directory once the
  // whole step is read, since its `uses` may come after its `with`.
  const closeStep = () => {
    if (step?.uv) {
      if (!step.firstInput) {
        refuse(
          step.uv,
          "setup-uv reads its settings from its working directory: give the step a `with:` block, so the twin can set it to the template",
        );
      }
      const { at, indent } = step.firstInput;
      out.splice(at, 0, `${indent}working-directory: ${template}`);
    }
    step = null;
  };
  // Every job must have had the working directory placed after its runs-on.
  const closeJob = () => {
    closeStep();
    steps = null;
    if (job && !job.placed) {
      throw new TwinError(
        `${origin}: job "${job.name}" has no inline runs-on to set the working directory after`,
      );
    }
    job = null;
  };
  for (const line of source.replace(/\n$/, "").split("\n")) {
    if (/^[^\s#]/.test(line)) {
      closeJob();
      inJobs = /^jobs:\s*(#.*)?$/.test(line);
    }
    // A blank line or a comment says nothing about where a step ends. A dash
    // may stand alone on its line, with the step's first key on the next.
    if (steps && /^\s*[^\s#]/.test(line)) {
      const indent = /^ */.exec(line)[0].length;
      const dash = /^ *-(\s|$)/.test(line);
      if (steps.dash === null && dash && indent >= steps.key) steps.dash = indent;
      if (dash && indent === steps.dash) {
        closeStep();
        step = { uv: null, withKey: null, firstInput: null };
      } else if (indent <= (steps.dash ?? steps.key)) {
        closeStep();
        steps = null;
      }
      if (step) {
        // The line after `with:` is its first input when it sits deeper, and
        // otherwise the block is empty. `out.length` is where this line goes.
        if (step.withKey !== null && !step.firstInput) {
          if (indent > step.withKey) {
            step.firstInput = { at: out.length, indent: /^ */.exec(line)[0] };
          } else step.withKey = null;
        }
        const withKey = /^( *)(- )?with:\s*(#.*)?$/.exec(line);
        if (withKey) step.withKey = withKey[1].length + (withKey[2] ? 2 : 0);
      }
    }
    const jobKey = inJobs && /^ {2}([\w-]+):\s*(#.*)?$/.exec(line);
    if (jobKey) {
      closeJob();
      job = { name: jobKey[1], placed: false };
      jobs.push(job);
    }
    const name = /^( {4})?name: (.*)$/.exec(line);
    if (name && (name[1] === undefined || inJobs)) {
      if (/^["']/.test(name[2])) refuse(line, "a quoted name");
      out.push(`${line} (${template})`);
      if (name[1] === undefined) names += 1;
      continue;
    }
    if (/^\s+(- )?[\w-]*(path|paths|file|files|directory)(-ignore)?:/.test(line)) {
      refuse(line, "a key naming a path is read from the repository root");
    }
    if (/^\s+(- )?uses:\s*["']?\.\//.test(line)) {
      refuse(line, "a local action is read from the repository root");
    }
    if (line.includes("hashFiles(")) refuse(line, "hashFiles reads from the repository root");
    if (/^\s+(- )?[\w-]+:\s*\{(?!\{)/.test(line)) {
      refuse(line, "the keys of a flow mapping are not read");
    }
    if (inJobs && /^ {4}defaults:/.test(line)) refuse(line, "the job already sets defaults");
    out.push(line);
    if (job && /^ {4}steps:\s*(#.*)?$/.test(line)) steps = { key: 4, dash: null };
    if (step && /^\s+(- )?uses:\s*["']?astral-sh\/setup-uv(?=[@"'\s]|$)/.test(line)) step.uv = line;
    if (job && /^ {4}runs-on:/.test(line)) {
      if (!/^ {4}runs-on: *[^\s#]/.test(line)) refuse(line, "a runs-on value that is not inline");
      out.push("    defaults:", "      run:", `        working-directory: ${template}`);
      job.placed = true;
    }
    const cache = /^(\s+)(- )?cache:(.*)$/.exec(line);
    if (cache) {
      if (scalar(cache[3]) !== "npm") {
        refuse(
          line,
          "only an npm cache is pointed at the template's lock file, whichever action takes it",
        );
      }
      const indent = cache[1] + (cache[2] ? "  " : "");
      out.push(`${indent}cache-dependency-path: ${template}/package-lock.json`);
    }
  }
  closeJob();
  if (names !== 1) throw new TwinError(`${origin}: expected one top-level name, found ${names}`);
  if (jobs.length === 0) throw new TwinError(`${origin}: no job to run in ${template}`);
  const header = [
    `${TWIN_MARKER}${origin} — edit that file and re-render.`,
    "# GitHub reads workflows only at the repository root, and the template's own copy travels",
    "# into every project created from it, so the root runs this twin inside the template.",
  ];
  return `${[...header, ...out].join("\n")}\n`;
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

/** Every twin the templates call for, keyed by its root file name. */
export function expectedTwins(root, templates) {
  const twins = new Map();
  for (const template of templates) {
    if (!fs.existsSync(path.join(root, template))) {
      throw new TwinError(`${template}: no such template directory`);
    }
    for (const file of templateWorkflows(root, template)) {
      const source = fs.readFileSync(path.join(root, template, WORKFLOWS_DIR, file), "utf8");
      twins.set(twinName(template, file), renderTwin(template, file, source));
    }
  }
  return twins;
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
  if (templates.length === 0) {
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
