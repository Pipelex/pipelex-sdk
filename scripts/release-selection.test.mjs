// The release selection: which units a release proposes, what it does with a
// hold-back, and what it refuses. Each test builds a throwaway git repository,
// commits and tags it as releases would, and asks the selection what the next
// release ships. Run with `node --test` — the root has no dependencies.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  REPO,
  ROOT,
  SelectionError,
  main,
  newestRelease,
  nextMinor,
  parseArgs,
  parseSprints,
  proposeUnits,
  releaseReading,
  renderMarkdown,
  selectRelease,
  sprintNeeds,
} from "./release-selection.mjs";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// The machine's own git configuration stays out of the throwaway repositories:
// no hooks, no signing, no identity it may lack.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Release Test",
  GIT_AUTHOR_EMAIL: "release-test@example.com",
  GIT_COMMITTER_NAME: "Release Test",
  GIT_COMMITTER_EMAIL: "release-test@example.com",
};

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" }).trim();
}

const pkg = (version) => `${JSON.stringify({ name: "x", version }, null, 2)}\n`;
const pyproject = (version) => `[project]\nname = "x"\nversion = "${version}"\n`;

/** Write files under the repository, a null text deleting the file. */
function write(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (text === null) {
      fs.rmSync(full);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

/** Commit the files on the branch checked out, and return the commit's SHA. */
function commit(root, files, message = "change") {
  write(root, files);
  git(root, "add", "-A");
  // Empty when a release tags a tree it did not change, such as the import's.
  git(root, "commit", "-q", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/** A release as the workflow makes it: VERSION and the shipped manifests moved, one commit, its tag. */
function release(root, version, manifests) {
  commit(root, { VERSION: `${version}\n`, ...manifests }, `Release v${version}`);
  git(root, "tag", `v${version}`);
}

/**
 * A repository shaped like this one: an SDK in each ecosystem, one template,
 * and a family of manifests that ship as one, every manifest at `version`.
 */
function repository(version = "0.1.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-selection-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "dev");
  commit(
    root,
    {
      VERSION: `${version}\n`,
      "js/package.json": pkg(version),
      "js/src/index.ts": "export {};\n",
      "python/pyproject.toml": pyproject(version),
      "python/src/client.py": "",
      "starter/package.json": pkg(version),
      "apps/web-js/package.json": pkg(version),
      "apps/init/js/package.json": pkg(version),
      "apps/docs/family.md": "# The family\n",
    },
    "import",
  );
  return root;
}

const UNITS = ["js", "python", "starter", "apps:web-js,init/js"];
const unit = (result, name) => result.units.find((each) => each.name === name);
const reasons = (result) => Object.fromEntries(result.units.map((each) => [each.name, each.reason]));
const kinds = (result) => result.refusals.map((refusal) => refusal.kind);

/**
 * One open sprint whose members are given as `[id, owner, state, merges, closed]`, as
 * `ledger sprint status --json` reads them: a closed member's close time and the merge commits
 * its landing recorded. A closed member given no time closes an hour from now, after every tag a
 * test makes, so the date never reads it as shipped and only its merges can.
 */
function sprint(members, { id = "L-000000-sprint", status = "open" } = {}) {
  return {
    id,
    status,
    members: members.map(([memberId, owner, state, merges = [], closed]) => ({
      id: memberId,
      title: "work",
      type: "task",
      repo: owner.split("/")[0],
      owner,
      state,
      closed: state === "closed" ? (closed ?? new Date(Date.now() + HOUR).toISOString()) : null,
      merges,
    })),
  };
}

const HOUR = 60 * 60 * 1000;

/** When git says a tag was made, moved by `offset` milliseconds, as the ledger writes a close time. */
function around(root, tag, offset) {
  const made = git(root, "for-each-ref", "--format=%(creatordate:iso-strict)", `refs/tags/${tag}`);
  return new Date(Date.parse(made) + offset).toISOString();
}

describe("the first release", () => {
  it("proposes every unit, since none has a tag of its own", () => {
    const root = repository("0.28.1");
    write(root, { "python/pyproject.toml": pyproject("0.16.0") });
    commit(root, {});
    const result = selectRelease(root, UNITS, { sprints: [] });
    assert.equal(result.ok, true);
    assert.equal(result.first_release, true);
    assert.deepEqual(reasons(result), {
      js: "no-tag",
      python: "no-tag",
      starter: "no-tag",
      apps: "no-tag",
    });
    assert.deepEqual(result.selected, ["js", "python", "starter", "apps"]);
  });

  it("starts the shared line at the next minor above the highest version shipped", () => {
    const root = repository("0.5.7");
    commit(root, { VERSION: "0.28.1\n", "js/package.json": pkg("0.28.1") });
    const result = selectRelease(root, UNITS);
    assert.equal(result.first_release_version, "0.29.0");
    assert.equal(nextMinor(["0.2.1", "0.16.0", "0.28.1", "0.5.7"]), "0.29.0");
  });

  it("refuses to hold anything back", () => {
    const root = repository();
    const result = selectRelease(root, UNITS, { sprints: [], hold: ["starter"] });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ["first-release"]);
    assert.ok(result.selected.includes("starter"));
  });
});

describe("a unit with no tag of its own", () => {
  it("is proposed after other units have shipped", () => {
    const root = repository();
    release(root, "0.1.0", {});
    // A unit added after the first release has never shipped from here.
    commit(root, { "go/package.json": pkg("0.0.1") });
    const result = selectRelease(root, [...UNITS, "go"]);
    assert.equal(result.first_release, false);
    assert.equal(unit(result, "go").reason, "no-tag");
    assert.equal(unit(result, "go").proposed, true);
    assert.deepEqual(result.selected, ["go"]);
  });
});

describe("an unchanged unit", () => {
  it("is not proposed, while a changed one is", () => {
    const root = repository();
    release(root, "0.1.0", {});
    commit(root, { "js/src/index.ts": "export const a = 1;\n" });
    const result = selectRelease(root, UNITS);
    assert.deepEqual(reasons(result), {
      js: "changed",
      python: "unchanged",
      starter: "unchanged",
      apps: "unchanged",
    });
    assert.deepEqual(result.selected, ["js"]);
  });

  it("cannot be held back, since there is nothing to hold", () => {
    const root = repository();
    release(root, "0.1.0", {});
    commit(root, { "js/src/index.ts": "export const a = 1;\n" });
    const result = selectRelease(root, UNITS, { sprints: [], hold: ["python"] });
    assert.deepEqual(kinds(result), ["not-proposed"]);
  });

  it("makes a selection of nothing a refusal", () => {
    const root = repository();
    release(root, "0.1.0", {});
    const result = selectRelease(root, UNITS);
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ["nothing-selected"]);
  });

  it("is read from the committed tree, so an uncommitted change proposes nothing", () => {
    const root = repository();
    release(root, "0.1.0", {});
    write(root, { "js/src/index.ts": "export const uncommitted = 1;\n" });
    assert.equal(unit(selectRelease(root, UNITS), "js").reason, "unchanged");
  });
});

describe("a unit held back", () => {
  it("is proposed again at the next release, until it ships", () => {
    const root = repository();
    release(root, "0.1.0", {});
    commit(root, {
      "js/src/index.ts": "export const a = 1;\n",
      "python/src/client.py": "A = 1\n",
    });

    // v0.2.0 ships the SDK in JavaScript and holds the Python one back.
    const first = selectRelease(root, UNITS, { sprints: [], hold: ["python"] });
    assert.equal(first.ok, true);
    assert.deepEqual(first.selected, ["js"]);
    assert.deepEqual(first.held, ["python"]);
    release(root, "0.2.0", { "js/package.json": pkg("0.2.0") });

    // At the next release nothing touched python/, yet it differs from v0.1.0, where it last shipped.
    const next = selectRelease(root, UNITS);
    assert.equal(unit(next, "js").reason, "unchanged");
    assert.equal(unit(next, "python").tag, "v0.1.0");
    assert.equal(unit(next, "python").reason, "changed");
    assert.deepEqual(next.selected, ["python"]);

    // Once it ships, it is compared with its new tag.
    release(root, "0.3.0", { "python/pyproject.toml": pyproject("0.3.0") });
    assert.equal(unit(selectRelease(root, UNITS), "python").reason, "unchanged");
  });
});

describe("the method apps", () => {
  it("are one unit, compared over their whole directory", () => {
    const root = repository();
    release(root, "0.1.0", {});
    // A change outside both manifests' directories still proposes the family.
    commit(root, { "apps/docs/family.md": "# The family, revised\n" });
    const result = selectRelease(root, UNITS);
    assert.deepEqual(result.selected, ["apps"]);
    assert.deepEqual(unit(result, "apps").manifests, [
      "apps/web-js/package.json",
      "apps/init/js/package.json",
    ]);
  });

  it("are proposed whole when only the template changed, and held back whole", () => {
    const root = repository();
    release(root, "0.1.0", {});
    commit(root, { "apps/web-js/src/page.tsx": "export {};\n", "js/src/index.ts": "//\n" });
    const result = selectRelease(root, UNITS, { sprints: [], hold: ["apps"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.held, ["apps"]);
    assert.deepEqual(result.selected, ["js"]);
    // The template is not a unit of its own.
    const typo = selectRelease(root, UNITS, { sprints: [], hold: ["web-js"] });
    assert.deepEqual(kinds(typo), ["unknown"]);
  });

  it("refuse to be compared when their manifests disagree", () => {
    const root = repository();
    commit(root, { "apps/init/js/package.json": pkg("0.0.9") });
    assert.throws(() => proposeUnits(root, UNITS), SelectionError);
  });

  it("are the unit a sprint member in any of their directories needs", () => {
    const root = repository();
    release(root, "0.1.0", {});
    const merge = commit(root, { "apps/web-js/src/page.tsx": "export {};\n", "js/src/index.ts": "//\n" });
    const sprints = [sprint([["L-1", `${REPO}/apps/web-js`, "closed", [merge]]])];
    const result = selectRelease(root, UNITS, { sprints, hold: ["apps"] });
    assert.deepEqual(kinds(result), ["sprint"]);
  });
});

describe("a hold-back an open sprint needs", () => {
  /**
   * Two units changed after the first release, so that holding one back still leaves a release.
   * Each change is a commit of its own, the merge a member's landing records.
   */
  function changed() {
    const root = repository();
    release(root, "0.1.0", {});
    const js = commit(root, { "js/src/index.ts": "export const a = 1;\n" });
    const python = commit(root, { "python/src/client.py": "A = 1\n" });
    return { root, js, python };
  }

  /** `changed()`, then v0.2.0 shipping both changes, then a further change to each unit, so both are proposed again. */
  function shippedOnce() {
    const { root, js, python } = changed();
    release(root, "0.2.0", { "js/package.json": pkg("0.2.0"), "python/pyproject.toml": pyproject("0.2.0") });
    commit(root, { "js/src/index.ts": "export const a = 2;\n", "python/src/client.py": "A = 2\n" });
    return { root, js, python };
  }

  it("is refused while no release tag contains the member's merge", () => {
    const { root, python } = changed();
    const sprints = [sprint([["L-1", `${REPO}/python`, "closed", [python]]])];
    const result = selectRelease(root, UNITS, { sprints, hold: ["python"] });
    assert.equal(result.ok, false);
    assert.deepEqual(kinds(result), ["sprint"]);
    assert.match(
      result.refusals[0].message,
      /L-1 \(closed\) in sprint L-000000-sprint landed in python\/ and no release has shipped it yet/,
    );
    assert.match(result.refusals[0].message, /once a release tag contains the sprint's work/);
    assert.doesNotMatch(result.refusals[0].message, /item/);
    assert.deepEqual(result.held, []);
    assert.ok(result.selected.includes("python"));
  });

  it("is refused for a member merged and not yet closed, whose landing has recorded no merge", () => {
    const { root } = shippedOnce();
    const sprints = [sprint([["L-1", `${REPO}/python`, "merged"]])];
    assert.deepEqual(kinds(selectRelease(root, UNITS, { sprints, hold: ["python"] })), ["sprint"]);
  });

  it("is refused when a member owned by the root has landed, since it names no directory", () => {
    const { root, python } = changed();
    const sprints = [sprint([["L-1", REPO, "closed", [python]]])];
    const result = selectRelease(root, UNITS, { sprints, hold: ["python"] });
    assert.deepEqual(kinds(result), ["sprint-root"]);
    assert.deepEqual(result.root_sprint_needs.map((need) => need.member), ["L-1"]);
  });

  it("is allowed once the newest release tag contains every merge the member's landing recorded", () => {
    const { root, js, python } = shippedOnce();
    const sprints = [
      sprint([
        ["L-1", `${REPO}/python`, "closed", [python, js]],
        ["L-2", REPO, "closed", [js]],
      ]),
    ];
    const result = selectRelease(root, UNITS, { sprints, hold: ["python"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.held, ["python"]);
    assert.deepEqual(unit(result, "python").sprint_needs, []);
    assert.deepEqual(result.root_sprint_needs, []);
  });

  it("is refused while one of the member's merges is missing from the tag", () => {
    const { root, python } = shippedOnce();
    const later = commit(root, { "python/src/client.py": "A = 3\n" });
    const sprints = [sprint([["L-1", `${REPO}/python`, "closed", [python, later]]])];
    assert.deepEqual(kinds(selectRelease(root, UNITS, { sprints, hold: ["python"] })), ["sprint"]);
  });

  it("reads the tag on main's merge commit as carrying what dev held when the release branch was cut, and nothing merged after", () => {
    const root = repository();
    release(root, "0.1.0", {});
    git(root, "branch", "main");
    const before = commit(root, { "python/src/client.py": "A = 1\n" });
    git(root, "checkout", "-q", "-b", "release/v0.2.0");
    commit(root, { VERSION: "0.2.0\n", "python/pyproject.toml": pyproject("0.2.0") }, "Release v0.2.0");
    git(root, "checkout", "-q", "dev");
    const after = commit(root, { "python/src/client.py": "A = 2\n", "js/src/index.ts": "export const a = 1;\n" });
    git(root, "checkout", "-q", "main");
    git(root, "merge", "-q", "--no-ff", "--no-edit", "-m", "Release v0.2.0 (#1)", "release/v0.2.0");
    git(root, "tag", "v0.2.0");
    // The landing's back-merge brings main into dev, which does not put dev's later work in the tag.
    git(root, "checkout", "-q", "dev");
    git(root, "merge", "-q", "--no-ff", "--no-edit", "-m", "Merge main into dev", "main");

    const shipped = [sprint([["L-1", `${REPO}/python`, "closed", [before]]])];
    const result = selectRelease(root, UNITS, { sprints: shipped, hold: ["python"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.selected, ["js"]);
    const owed = [sprint([["L-2", `${REPO}/python`, "closed", [after]]])];
    assert.deepEqual(kinds(selectRelease(root, UNITS, { sprints: owed, hold: ["python"] })), ["sprint"]);
  });

  it("reads a member closed with no merge recorded by date: shipped when the newest release tag was made after it closed", () => {
    const { root } = shippedOnce();
    const before = [sprint([["L-1", `${REPO}/python`, "closed", [], around(root, "v0.2.0", -HOUR)]])];
    assert.equal(selectRelease(root, UNITS, { sprints: before, hold: ["python"] }).ok, true);
    const after = [sprint([["L-1", `${REPO}/python`, "closed", [], around(root, "v0.2.0", HOUR)]])];
    assert.deepEqual(kinds(selectRelease(root, UNITS, { sprints: after, hold: ["python"] })), ["sprint"]);
  });

  it("reads a recorded merge no base branch holds, such as a stacked pull request's, by date", () => {
    const { root, python } = shippedOnce();
    git(root, "checkout", "-q", "-b", "feature/Lower");
    const stacked = commit(root, { "python/src/stacked.py": "B = 1\n" });
    git(root, "checkout", "-q", "dev");
    const before = [sprint([["L-1", `${REPO}/python`, "closed", [python, stacked], around(root, "v0.2.0", -HOUR)]])];
    assert.equal(selectRelease(root, UNITS, { sprints: before, hold: ["python"] }).ok, true);
    const after = [sprint([["L-1", `${REPO}/python`, "closed", [python, stacked], around(root, "v0.2.0", HOUR)]])];
    assert.deepEqual(kinds(selectRelease(root, UNITS, { sprints: after, hold: ["python"] })), ["sprint"]);
  });

  it("counts every base branch the ledger names, staging included, as a line a release still owes", () => {
    const { root } = shippedOnce();
    git(root, "checkout", "-q", "-b", "staging");
    const promoted = commit(root, { "python/src/promoted.py": "C = 1\n" });
    git(root, "checkout", "-q", "dev");
    const sprints = [sprint([["L-1", `${REPO}/python`, "closed", [promoted], around(root, "v0.2.0", -HOUR)]])];
    assert.deepEqual(kinds(selectRelease(root, UNITS, { sprints, hold: ["python"] })), ["sprint"]);
  });

  it("reads a merge git here does not hold by date only once the fetched dev was made after the member closed", () => {
    const { root } = shippedOnce();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    const sprints = [sprint([["L-1", `${REPO}/python`, "closed", [missing], around(root, "v0.2.0", -HOUR)]])];
    // Nothing fetched here can place the merge, and a fetch is what would.
    assert.deepEqual(kinds(selectRelease(root, UNITS, { sprints, hold: ["python"] })), ["sprint"]);
    // A fetched dev made since the close would have brought the merge, had it landed there.
    git(root, "update-ref", "refs/remotes/origin/dev", "HEAD");
    assert.equal(selectRelease(root, UNITS, { sprints, hold: ["python"] }).ok, true);
  });

  it("ignores work not landed, cancelled, of another repository, of another unit, or of a sprint no longer open", () => {
    const { root, js, python } = changed();
    const sprints = [
      sprint([
        ["L-1", `${REPO}/python`, "pr-open"],
        ["L-2", `${REPO}/python`, "cancelled"],
        ["L-3", "pipelex-sdk-python", "closed", [python]],
        ["L-4", `${REPO}/js`, "closed", [js]],
      ]),
      sprint([["L-5", `${REPO}/python`, "closed", [python]]], { id: "L-000000-closed", status: "closed" }),
    ];
    const result = selectRelease(root, UNITS, { sprints, hold: ["python"] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.held, ["python"]);
    assert.deepEqual(unit(result, "js").sprint_needs.map((need) => need.member), ["L-4"]);
  });

  it("cannot be checked without the sprint reading", () => {
    const { root } = changed();
    assert.throws(() => selectRelease(root, UNITS, { hold: ["python"] }), SelectionError);
  });
});

describe("releaseReading", () => {
  it("reads nothing as shipped while the repository has no release tag", () => {
    const root = repository();
    const merge = commit(root, { "js/src/index.ts": "//\n" });
    const [member] = sprint([["L-1", `${REPO}/js`, "closed", [merge], "2000-01-01T00:00:00Z"]]).members;
    assert.equal(releaseReading(root)(member, "L-1"), false);
  });

  it("refuses a close time that is not a time", () => {
    const root = repository();
    release(root, "0.1.0", {});
    const [member] = sprint([["L-1", `${REPO}/js`, "closed", [], "yesterday"]]).members;
    assert.throws(() => releaseReading(root)(member, "L-1 in L-000000-sprint"), SelectionError);
  });
});

describe("newestRelease", () => {
  it("is the highest release tag by version, never a prerelease or another tag", () => {
    const root = repository();
    assert.equal(newestRelease(root), null);
    for (const tag of ["v0.9.0", "v0.10.0", "v0.11.0-rc.1", "w1.0.0", "v2", "v3.0.0/x"]) git(root, "tag", tag);
    assert.equal(newestRelease(root), "v0.10.0");
  });
});

describe("sprintNeeds", () => {
  it("refuses a member whose owner no unit covers", () => {
    const units = [{ name: "js", dir: "js" }];
    const sprints = [sprint([["L-1", `${REPO}/rust`, "closed"]])];
    assert.throws(() => sprintNeeds(sprints, units, { shipped: () => false }), SelectionError);
  });
});

describe("parseSprints", () => {
  it("reads every open sprint's list, or one sprint's object", () => {
    const one = sprint([["L-1", `${REPO}/js`, "queued"]]);
    assert.equal(parseSprints(JSON.stringify([one])).length, 1);
    assert.equal(parseSprints(JSON.stringify(one))[0].id, "L-000000-sprint");
  });

  it("refuses what is not a sprint reading", () => {
    for (const text of ["not json", "null", "[{}]", '[{"id": "L-1", "status": "open"}]']) {
      assert.throws(() => parseSprints(text), SelectionError, text);
    }
    const bad = sprint([["L-1", `${REPO}/js`, "closed", [], 3]]);
    assert.throws(() => parseSprints(JSON.stringify(bad)), SelectionError);
  });

  it("refuses a member whose merges are not a list of commit SHAs, so nothing else reaches git", () => {
    const [member] = sprint([["L-1", `${REPO}/js`, "closed"]]).members;
    for (const merges of [undefined, "abc1234", ["--output=x"], ["ABC1234"], ["abc12"], [1234567]]) {
      const reading = { id: "L-2", status: "open", members: [{ ...member, merges }] };
      assert.throws(() => parseSprints(JSON.stringify(reading)), SelectionError, JSON.stringify(merges));
    }
  });
});

describe("parseArgs", () => {
  it("reads the options and the units", () => {
    assert.deepEqual(
      parseArgs(["--sprints", "-", "--hold", "js", "--hold", "python", "--json", "--ref", "dev", "js"]),
      { ref: "dev", sprints: "-", hold: ["js", "python"], json: true, specs: ["js"] },
    );
    for (const bad of [[], ["--hold"], ["--hold", "--json", "js"], ["--bogus", "js"]]) {
      assert.throws(() => parseArgs(bad), SelectionError, bad.join(" "));
    }
  });
});

describe("main", () => {
  /** Run the command line against a repository, collecting what it prints. */
  async function run(root, argv, stdin = "") {
    const out = [];
    const err = [];
    const code = await main(argv, {
      root,
      stdin: async () => stdin,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("prints the Markdown report, exits 0 on a selection and 1 on a refusal", async () => {
    const root = repository();
    const stands = await run(root, UNITS);
    assert.equal(stands.code, 0);
    assert.match(stands.out, /^# Release selection at `HEAD`/);
    assert.match(stands.out, /\*\*Selected:\*\* `js`, `python`, `starter`, `apps`\./);
    const refused = await run(root, ["--sprints", "-", "--hold", "js", ...UNITS], "[]");
    assert.equal(refused.code, 1);
    assert.match(refused.out, /## Refused/);
  });

  it("prints JSON whose ok field is the verdict", async () => {
    const root = repository();
    const { code, out } = await run(root, ["--json", ...UNITS]);
    assert.equal(code, 0);
    const result = JSON.parse(out);
    assert.equal(result.ok, true);
    assert.equal(result.first_release, true);
  });

  it("exits 2 when no selection can be made", async () => {
    const root = repository();
    assert.equal((await run(root, [])).code, 2);
    assert.equal((await run(root, ["--ref", "nowhere", ...UNITS])).code, 2);
    assert.equal((await run(root, ["--sprints", "-", ...UNITS], "not json")).code, 2);
    assert.equal((await run(root, ["--sprints", path.join(root, "missing.json"), ...UNITS])).code, 2);
    assert.equal((await run(root, ["nowhere"])).code, 2);
  });
});

describe("renderMarkdown", () => {
  it("names each unit's reason and the sprint work it carries", () => {
    const root = repository();
    release(root, "0.1.0", {});
    commit(root, { "js/src/index.ts": "export const a = 1;\n" });
    const sprints = [sprint([["L-1", `${REPO}/js`, "merged"]])];
    const text = renderMarkdown(selectRelease(root, UNITS, { sprints }));
    assert.match(text, /\| `js` \| 0\.1\.0 \| yes: changed since `v0\.1\.0` \| L-1 \(merged\) in sprint L-000000-sprint \|/);
    assert.match(text, /\| `python` \| 0\.1\.0 \| no: unchanged since `v0\.1\.0` \| none \|/);
    assert.match(text, /The selection stands\./);
  });
});

describe("this repository", () => {
  it("selects over the root Makefile's units, the method apps as one", () => {
    const makefile = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const units = /^UNITS := (.+)$/m.exec(makefile)[1].trim().split(/\s+/);
    assert.ok(units.includes("method-apps:webapp-js,cli-python,initializers/js"));
    const { units: proposed } = proposeUnits(ROOT, units);
    assert.deepEqual(
      proposed.map((each) => each.name),
      ["js", "python", "starter-js", "starter-python", "method-apps"],
    );
    for (const each of proposed) assert.ok(["no-tag", "changed", "unchanged"].includes(each.reason));
  });
});
