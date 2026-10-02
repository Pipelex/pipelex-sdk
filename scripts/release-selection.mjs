#!/usr/bin/env node
/**
 * Propose the units a release of this repository ships, and check the
 * hold-backs the person cutting it asks for.
 *
 * A unit is proposed when its directory differs from the one at
 * `v<the version its own manifest carries>`, the release it last shipped in,
 * so a unit held back at one release keeps being proposed until it ships. A
 * unit with no such tag in the repository has never shipped from here and is
 * always proposed, which at the first release is every unit
 * (docs/release-model.md).
 *
 *   node scripts/release-selection.mjs [--ref <rev>] [--sprints <file | ->]
 *                                      [--hold <unit>]... [--json] <unit>...
 *
 * A unit is spelled as scripts/versions.mjs spells it: a directory such as
 * `js`, or `dir:sub1,sub2` for one whose manifests ship as one, such as
 * `method-apps:webapp-js,initializers/js`, which is compared over the whole
 * `method-apps/` directory. Everything is read from the committed tree at
 * `--ref` (HEAD by default): `VERSION`, each manifest and each directory's
 * tree, so an uncommitted change proposes nothing.
 *
 * A hold-back is refused in four cases: the unit is not proposed; no unit has
 * a tag of its own yet, so this is the first release, which ships every
 * package; an open sprint has a landed member in the unit's directory that no
 * closed release of this repository has shipped since it landed, since the
 * sprint machinery reads the whole repository as shipped once the release
 * item closes; or an open sprint has such a member owned by the repository's
 * root, which names no directory and so refuses every hold-back.
 *
 * The sprint reading is the JSON of `ledger sprint status --remote --json`,
 * handed in as a file or on stdin (`--sprints -`), and it is required with
 * `--hold`. This script asks nothing of the ledger or the network; it reads
 * git and the files it is given.
 *
 * The report is Markdown, or JSON with `--json`, whose `ok` field is the
 * verdict. The exit code is 0 when the selection stands, 1 when it is refused
 * or selects nothing, and 2 when no selection could be made: a usage error, a
 * ref or a manifest git cannot read, a unit whose manifests disagree, or a
 * sprint reading that is not one.
 *
 * Zero dependencies; runs on the Node the templates already need.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { VersionError, compareVersions, parseUnit, pyprojectVersion } from "./versions.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The repository's ledger key: sprint members owned by it, or by one of its members, are this repository's. */
export const REPO = "pipelex-sdk";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// The states `ledger sprint status` gives a member whose branch is in the base: `merged`, which
// only `--remote` can see, and `closed`, which the landing turns a merged member into.
const LANDED = new Set(["merged", "closed"]);

const USAGE =
  "usage: node scripts/release-selection.mjs [--ref <rev>] [--sprints <file | ->] [--hold <unit>]... [--json] <dir | dir:sub1,sub2>...";

export class SelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SelectionError";
  }
}

/** What git prints, trimmed, or null when the command fails: a lookup whose miss is an answer. */
function lookup(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** The commit a revision names, or null. */
function commitOf(root, rev) {
  return lookup(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
}

/** The tree of a directory at a commit, or null when the commit has no such directory. */
export function treeAt(root, commit, dir) {
  const sha = lookup(root, ["rev-parse", "--verify", "--quiet", `${commit}:${dir}`]);
  if (sha === null) return null;
  return lookup(root, ["cat-file", "-t", sha]) === "tree" ? sha : null;
}

/** A file's text at a commit, or null when the commit has no such file. */
function fileAt(root, commit, file) {
  try {
    return execFileSync("git", ["cat-file", "blob", `${commit}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/** Where a directory declares its version at a commit, and what it says (null when it says nothing). */
function manifestAt(root, commit, ref, dir) {
  const pkg = fileAt(root, commit, `${dir}/package.json`);
  if (pkg !== null) {
    let parsed;
    try {
      parsed = JSON.parse(pkg);
    } catch (err) {
      throw new SelectionError(`${dir}/package.json at ${ref} is not JSON: ${err.message}`);
    }
    return { manifest: `${dir}/package.json`, version: parsed.version ?? null };
  }
  const pyproject = fileAt(root, commit, `${dir}/pyproject.toml`);
  if (pyproject !== null) {
    return { manifest: `${dir}/pyproject.toml`, version: pyprojectVersion(pyproject) };
  }
  throw new SelectionError(`${dir} has no package.json or pyproject.toml at ${ref} to read a version from`);
}

/**
 * Each unit's proposal at `ref`: the version its manifests carry, its tag, and
 * whether its directory differs from the one at that tag.
 */
export function proposeUnits(root, specs, { ref = "HEAD" } = {}) {
  const commit = commitOf(root, ref);
  if (commit === null) throw new SelectionError(`${ref} names no commit in ${root}`);
  const text = fileAt(root, commit, "VERSION");
  if (text === null) throw new SelectionError(`VERSION is missing at ${ref}`);
  const version = text.trim();
  if (!SEMVER.test(version)) {
    throw new SelectionError(`VERSION at ${ref} holds ${JSON.stringify(version)}, not a version`);
  }
  const parsed = specs.map(parseUnit);
  const names = parsed.map((unit) => unit.name);
  const repeated = names.find((name, i) => names.indexOf(name) !== i);
  if (repeated !== undefined) throw new SelectionError(`${repeated} is named twice as a unit`);
  const units = parsed.map((unit) => {
    const read = unit.manifests.map((dir) => manifestAt(root, commit, ref, dir));
    const versions = [...new Set(read.map((each) => each.version))];
    if (versions.length > 1) {
      throw new SelectionError(
        `${unit.name} ships as one, but its manifests disagree at ${ref}: ${read.map((each) => `${each.manifest} carries ${each.version ?? "no version"}`).join(", ")} (make check-versions)`,
      );
    }
    const [own] = versions;
    if (own === null || !SEMVER.test(own)) {
      throw new SelectionError(
        `${read[0].manifest} carries ${own === null ? "no version" : JSON.stringify(own)} at ${ref}, so ${unit.name} has no tag to compare with`,
      );
    }
    const tree = treeAt(root, commit, unit.dir);
    if (tree === null) throw new SelectionError(`${unit.dir}/ is not a directory at ${ref}`);
    const tag = `v${own}`;
    const tagged = commitOf(root, `refs/tags/${tag}`);
    let reason;
    if (tagged === null) reason = "no-tag";
    else reason = treeAt(root, tagged, unit.dir) === tree ? "unchanged" : "changed";
    return {
      name: unit.name,
      dir: unit.dir,
      manifests: read.map((each) => each.manifest),
      version: own,
      tag,
      tagged: tagged !== null,
      reason,
      proposed: reason !== "unchanged",
    };
  });
  return { ref, commit, version, units };
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The sprints of a `ledger sprint status --json` reading: one sprint's object, or every open sprint's list. */
export function parseSprints(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new SelectionError(`the sprint reading is not JSON: ${err.message}`);
  }
  const sprints = Array.isArray(data) ? data : [data];
  const notOne = (why) =>
    new SelectionError(`the sprint reading is not one from \`ledger sprint status --json\`: ${why}`);
  for (const sprint of sprints) {
    if (!isObject(sprint) || typeof sprint.id !== "string") throw notOne("a sprint without an id");
    if (typeof sprint.status !== "string" || !Array.isArray(sprint.members)) {
      throw notOne(`${sprint.id} has no status or no members`);
    }
    for (const member of sprint.members) {
      const fields = ["id", "repo", "owner", "state", "type"];
      if (!isObject(member) || fields.some((field) => typeof member[field] !== "string")) {
        throw notOne(`a member of ${sprint.id} lacks one of ${fields.join(", ")}`);
      }
      if (member.closed !== null && typeof member.closed !== "string") {
        throw notOne(`${member.id} in ${sprint.id} has a closed field that is neither null nor a time`);
      }
    }
  }
  return sprints;
}

function instant(text, where) {
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new SelectionError(`${where} was closed at ${JSON.stringify(text)}, not a time`);
  return at;
}

/**
 * The landed work each open sprint still waits to see shipped, by unit: every
 * member of this repository that has landed (merged or closed), is not itself
 * a release, and was not followed by a closed release of the repository in
 * the same sprint. Members owned by the repository's root name no unit and
 * are listed apart.
 */
export function sprintNeeds(sprints, units, { repo = REPO } = {}) {
  const byUnit = new Map(units.map((unit) => [unit.name, []]));
  const root = [];
  for (const sprint of sprints) {
    if (sprint.status !== "open") continue;
    const own = sprint.members.filter((member) => member.repo === repo && member.state !== "cancelled");
    const releases = own
      .filter((member) => member.type === "release" && member.state === "closed" && member.closed !== null)
      .map((member) => instant(member.closed, `${member.id} in ${sprint.id}`));
    for (const member of own) {
      if (member.type === "release" || !LANDED.has(member.state)) continue;
      const landed = member.closed === null ? null : instant(member.closed, `${member.id} in ${sprint.id}`);
      if (landed !== null && releases.some((at) => at >= landed)) continue;
      const need = { sprint: sprint.id, member: member.id, owner: member.owner, state: member.state };
      if (member.owner === repo) {
        root.push(need);
        continue;
      }
      const sub = member.owner.startsWith(`${repo}/`) ? member.owner.slice(repo.length + 1) : null;
      const unit =
        sub === null ? undefined : units.find((each) => sub === each.dir || sub.startsWith(`${each.dir}/`));
      if (unit === undefined) {
        throw new SelectionError(
          `${member.id}, a member of sprint ${sprint.id}, is owned by ${member.owner}, which no unit covers: the units and the ledger's members of ${repo} disagree`,
        );
      }
      byUnit.get(unit.name).push(need);
    }
  }
  return { byUnit, root };
}

/** The next minor above the highest of these versions: where the first release starts the shared line. */
export function nextMinor(versions) {
  const highest = versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const [, major, minor] = SEMVER.exec(highest);
  return `${major}.${Number(minor) + 1}.0`;
}

const listed = (needs) =>
  needs.map((need) => `${need.member} (${need.state}) in sprint ${need.sprint}`).join(", ");

/**
 * The proposal at `ref`, the hold-backs applied, and every refusal:
 * `{ ok, version, first_release, first_release_version, units, selected, held, refusals, ... }`.
 */
export function selectRelease(root, specs, { ref = "HEAD", sprints = null, hold = [], repo = REPO } = {}) {
  const proposal = proposeUnits(root, specs, { ref });
  const { units } = proposal;
  if (hold.length > 0 && sprints === null) {
    throw new SelectionError(
      "a hold-back needs the sprint reading: pass `--sprints` with the output of `ledger sprint status --remote --json`",
    );
  }
  const firstRelease = units.every((unit) => !unit.tagged);
  const needs = sprints === null ? null : sprintNeeds(sprints, units, { repo });
  const refusals = [];
  const held = new Set();
  for (const name of new Set(hold)) {
    const unit = units.find((each) => each.name === name);
    if (unit === undefined) {
      refusals.push({
        kind: "unknown",
        unit: name,
        message: `${name} is not a unit; the units are ${units.map((each) => each.name).join(", ")}.`,
      });
    } else if (!unit.proposed) {
      refusals.push({
        kind: "not-proposed",
        unit: name,
        message: `${name} is unchanged since ${unit.tag}, so it is not proposed and there is nothing to hold back.`,
      });
    } else if (firstRelease) {
      refusals.push({
        kind: "first-release",
        unit: name,
        message: `Holding back ${name} is refused: no unit has a tag of its own yet, so this is the repository's first release, which ships every package at one number (docs/release-model.md).`,
      });
    } else if (needs.byUnit.get(name).length > 0) {
      refusals.push({
        kind: "sprint",
        unit: name,
        message: `Holding back ${name} is refused: ${listed(needs.byUnit.get(name))} landed in ${unit.dir}/ and has not shipped, and an open sprint reads the whole repository as shipped once this release's item closes (docs/release-model.md). Ship ${name} in this release.`,
      });
    } else if (needs.root.length > 0) {
      refusals.push({
        kind: "sprint-root",
        unit: name,
        message: `Holding back ${name} is refused: ${listed(needs.root)}, owned by the repository's root, landed and has not shipped, so the selection cannot tell which directory its work is in. Hold nothing back while it stands, or, when its work lies in one member's directory, re-own it there (\`ledger set-owner <id> ${repo}/<member>\`) and select again.`,
      });
    } else {
      held.add(name);
    }
  }
  const selected = units.filter((unit) => unit.proposed && !held.has(unit.name)).map((unit) => unit.name);
  if (selected.length === 0) {
    refusals.push({
      kind: "nothing-selected",
      unit: null,
      message:
        held.size > 0
          ? "Nothing is selected: every proposed unit is held back, and a release ships at least one."
          : "Nothing is selected: every unit is unchanged since it last shipped, so there is nothing to release.",
    });
  }
  return {
    ok: refusals.length === 0,
    ref: proposal.ref,
    commit: proposal.commit,
    version: proposal.version,
    first_release: firstRelease,
    first_release_version: firstRelease
      ? nextMinor([proposal.version, ...units.map((unit) => unit.version)])
      : null,
    units: units.map((unit) => ({
      ...unit,
      selected: selected.includes(unit.name),
      held: held.has(unit.name),
      sprint_needs: needs === null ? null : needs.byUnit.get(unit.name),
    })),
    root_sprint_needs: needs === null ? null : needs.root,
    selected,
    held: [...held],
    refusals,
  };
}

const code = (text) => `\`${text}\``;

function proposedCell(unit) {
  if (unit.held) return "held back";
  switch (unit.reason) {
    case "no-tag":
      return "yes: it has never shipped from this repository";
    case "changed":
      return `yes: changed since ${code(unit.tag)}`;
    default:
      return `no: unchanged since ${code(unit.tag)}`;
  }
}

/** The report an agent reads. */
export function renderMarkdown(result) {
  const lines = [`# Release selection at ${code(result.ref)} (${result.commit.slice(0, 12)})`, ""];
  lines.push(
    result.first_release
      ? `${code("VERSION")} is ${result.version}. This is the repository's first release: no unit has a tag of its own, so every unit is proposed and ships, at ${result.first_release_version}, the next minor above the highest version any of them has shipped (docs/release-model.md).`
      : `${code("VERSION")} is ${result.version}. Each unit is compared with the tag of the version its manifest carries, the release it last shipped in.`,
    "",
  );
  const sprintsRead = result.root_sprint_needs !== null;
  lines.push(
    "| Unit | Last shipped as | Proposed | Landed sprint work not yet shipped |",
    "| --- | --- | --- | --- |",
  );
  for (const unit of result.units) {
    const needs = !sprintsRead ? "not read" : unit.sprint_needs.length > 0 ? listed(unit.sprint_needs) : "none";
    lines.push(`| ${code(unit.name)} | ${unit.version} | ${proposedCell(unit)} | ${needs} |`);
  }
  lines.push("");
  if (sprintsRead && result.root_sprint_needs.length > 0) {
    lines.push(
      `Landed sprint work owned by the repository's root, not yet shipped: ${listed(result.root_sprint_needs)}. It names no directory, so no unit can be held back while it stands.`,
      "",
    );
  }
  if (!sprintsRead) {
    lines.push("The sprint reading was not given, so no hold-back can be checked.", "");
  }
  const names = (list) => (list.length > 0 ? list.map(code).join(", ") : "none");
  lines.push(`**Selected:** ${names(result.selected)}.`, `**Held back:** ${names(result.held)}.`, "");
  if (result.ok) {
    lines.push("The selection stands.");
  } else {
    lines.push("## Refused", "");
    for (const refusal of result.refusals) lines.push(`- ${refusal.message}`);
  }
  return lines.join("\n");
}

/** The command line, read into options; a SelectionError on anything it cannot read. */
export function parseArgs(argv) {
  const options = { ref: "HEAD", sprints: null, hold: [], json: false, specs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--ref" || arg === "--sprints" || arg === "--hold") {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith("-") && value !== "-")) {
        throw new SelectionError(`${arg} takes a value`);
      }
      i += 1;
      if (arg === "--ref") options.ref = value;
      else if (arg === "--sprints") options.sprints = value;
      else options.hold.push(value);
    } else if (arg.startsWith("-")) {
      throw new SelectionError(`${arg} is not an option`);
    } else {
      options.specs.push(arg);
    }
  }
  if (options.specs.length === 0) throw new SelectionError("no unit given");
  return options;
}

/**
 * Everything on stdin, read as a stream: a synchronous read of a pipe fails with
 * EAGAIN while the command writing it, `ledger sprint status`, is still working.
 */
async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

export async function main(
  argv,
  {
    root = ROOT,
    stdin = readStdin,
    out = (text) => console.log(text),
    err = (text) => console.error(text),
  } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof SelectionError)) throw error;
    err(`error: ${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    let sprints = null;
    if (options.sprints !== null) {
      let text;
      if (options.sprints === "-") {
        text = await stdin();
      } else {
        try {
          text = fs.readFileSync(options.sprints, "utf8");
        } catch (error) {
          throw new SelectionError(`cannot read the sprint reading ${options.sprints}: ${error.message}`);
        }
      }
      sprints = parseSprints(text);
    }
    const result = selectRelease(root, options.specs, {
      ref: options.ref,
      sprints,
      hold: options.hold,
    });
    out(options.json ? JSON.stringify(result, null, 2) : renderMarkdown(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof SelectionError || error instanceof VersionError) {
      err(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
