// The workflow twins: what a rendering carries, what it refuses, and what the
// check reports. Run with `node --test` — the root has no dependencies.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  ROOT,
  TWIN_MARKER,
  TwinError,
  WORKFLOWS_DIR,
  compareTwins,
  renderTwin,
  writeTwins,
} from "./workflows.mjs";

const SOURCE = `name: Lint check

on:
  pull_request:

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Run check
        run: make check
`;

const UV_SOURCE = `name: Tests check

on:
  pull_request:

jobs:
  tests:
    name: Tests
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python-version: ["3.11", "3.13"]
    steps:
      - uses: actions/checkout@v4

      - name: Set up uv
        uses: astral-sh/setup-uv@v7
        with:
          enable-cache: true
          python-version: \${{ matrix.python-version }}

      - name: Install dependencies
        run: uv sync --locked

      - name: Run unit tests
        run: make agent-test
`;

const WD = "working-directory: app-py";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway family with one template carrying the given workflows. */
function family(workflows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-twins-"));
  roots.push(root);
  const dir = path.join(root, "app-js", WORKFLOWS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(workflows))
    fs.writeFileSync(path.join(dir, file), text);
  return root;
}

describe("renderTwin", () => {
  const twin = renderTwin("app-js", "lint-check.yml", SOURCE);

  it("opens with the marker naming its source", () => {
    assert.ok(twin.startsWith(`${TWIN_MARKER}app-js/${WORKFLOWS_DIR}/lint-check.yml`));
  });

  it("names the template in the workflow and the job", () => {
    assert.match(twin, /^name: Lint check \(app-js\)$/m);
    assert.match(twin, /^ {4}name: Lint \(app-js\)$/m);
    assert.match(twin, /^ {6}- name: Set up Node.js$/m);
  });

  it("runs every step inside the template, with the template's npm cache", () => {
    assert.match(
      twin,
      /runs-on: ubuntu-latest\n {4}defaults:\n {6}run:\n {8}working-directory: app-js\n/,
    );
    assert.match(twin, /cache: "npm"\n {10}cache-dependency-path: app-js\/package-lock\.json\n/);
  });

  it("keeps everything else as it was", () => {
    const body = twin.split("\n").slice(3).join("\n");
    const stripped = body
      .replace(/ \(app-js\)$/gm, "")
      .replace(/\n {4}defaults:\n {6}run:\n {8}working-directory: app-js/, "")
      .replace(/\n {10}cache-dependency-path: app-js\/package-lock\.json/, "");
    assert.equal(stripped, SOURCE);
  });

  it("points every spelling of the npm cache at the template's lock file", () => {
    for (const spelling of ["cache: npm", "cache: 'npm'", 'cache: "npm" # the lock file']) {
      const rendered = renderTwin(
        "app-js",
        "lint-check.yml",
        SOURCE.replace('cache: "npm"', spelling),
      );
      assert.ok(
        rendered.includes(
          `          ${spelling}\n          cache-dependency-path: app-js/package-lock.json\n`,
        ),
        spelling,
      );
    }
  });

  it("runs every job inside the template", () => {
    const twoJobs = `${SOURCE}  build:\n    runs-on: \${{ matrix.os }}\n    steps:\n      - run: make build\n`;
    const rendered = renderTwin("app-js", "lint-check.yml", twoJobs);
    assert.equal(
      rendered.match(/\n {4}defaults:\n {6}run:\n {8}working-directory: app-js\n/g).length,
      2,
    );
  });

  it("refuses what it cannot carry faithfully", () => {
    const cases = [
      SOURCE.replace("name: Lint check", 'name: "Lint check"'),
      SOURCE.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash",
      ),
      SOURCE.replace(
        '          cache: "npm"',
        '          cache: "npm"\n          cache-dependency-path: package-lock.json',
      ),
      SOURCE.replace(
        "        run: make check",
        "        run: make check\n        working-directory: sub",
      ),
      SOURCE.replace("  pull_request:", "  pull_request:\n    paths:\n      - src/**"),
      SOURCE.replace("  pull_request:", "  pull_request:\n    paths-ignore:\n      - docs/**"),
      SOURCE.replace('          node-version: "22"', "          node-version-file: .nvmrc"),
      SOURCE.replace("      - uses: actions/checkout@v4", "      - uses: ./.github/actions/setup"),
      SOURCE.replace(
        '          cache: "npm"',
        "          cache: \"npm\"\n          key: ${{ hashFiles('package-lock.json') }}",
      ),
      SOURCE.replace('          cache: "npm"', "          cache: yarn"),
      SOURCE.replace(
        '        with:\n          node-version: "22"\n          cache: "npm"',
        '        with: { node-version: "22", cache: "npm" }',
      ),
      SOURCE.replace("name: Lint check\n", ""),
      `${SOURCE}  build:\n    runs-on:\n      labels: [ubuntu-latest]\n    steps:\n      - run: make build\n`,
      `${SOURCE}  shared:\n    uses: octo-org/shared/.github/workflows/x.yml@v1\n`,
      SOURCE.replace("    runs-on: ubuntu-latest", "    runs-on: \n      group: build-runners"),
      SOURCE.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on: # the larger runners\n      labels: [ubuntu-latest]",
      ),
    ];
    for (const source of cases) {
      assert.throws(() => renderTwin("app-js", "lint-check.yml", source), TwinError);
    }
  });
});

describe("renderTwin with setup-uv", () => {
  const twin = renderTwin("app-py", "tests-check.yml", UV_SOURCE);

  it("runs setup-uv in the template, set as the first of its inputs", () => {
    assert.match(twin, new RegExp(`\\n {8}with:\\n {10}${WD}\\n {10}enable-cache: true\\n`));
  });

  it("keeps everything else as it was", () => {
    const body = twin.split("\n").slice(3).join("\n");
    const stripped = body
      .replace(/ \(app-py\)$/gm, "")
      .replace(/\n {4}defaults:\n {6}run:\n {8}working-directory: app-py/, "")
      .replace(`\n          ${WD}`, "");
    assert.equal(stripped, UV_SOURCE);
  });

  it("carries the step's own cache settings, which setup-uv reads inside the template", () => {
    for (const source of [
      UV_SOURCE.replace("          enable-cache: true\n", ""),
      UV_SOURCE.replace("enable-cache: true", "enable-cache: false"),
      UV_SOURCE.replace(
        "          enable-cache: true",
        "          enable-cache: true\n          cache-dependency-glob: |\n            uv.lock\n            pyproject.toml",
      ),
    ]) {
      const rendered = renderTwin("app-py", "tests-check.yml", source);
      assert.ok(rendered.includes(`        with:\n          ${WD}\n`), source);
    }
  });

  it("matches the indentation of the step's inputs, past a comment", () => {
    const deeper = UV_SOURCE.replace(
      "          enable-cache: true\n          python-version",
      "            # the cache is keyed on the template's files\n              enable-cache: true\n              python-version",
    );
    const rendered = renderTwin("app-py", "tests-check.yml", deeper);
    assert.ok(
      rendered.includes(
        `# the cache is keyed on the template's files\n              ${WD}\n              enable-cache: true\n`,
      ),
    );
  });

  it("reads the whole step, whatever the order of its keys", () => {
    const usesLast = UV_SOURCE.replace(
      "      - name: Set up uv\n        uses: astral-sh/setup-uv@v7\n        with:",
      "      - name: Set up uv\n        with:",
    ).replace(
      "          python-version: ${{ matrix.python-version }}\n",
      "          python-version: ${{ matrix.python-version }}\n        uses: astral-sh/setup-uv@v7\n",
    );
    const rendered = renderTwin("app-py", "tests-check.yml", usesLast);
    assert.ok(rendered.includes(`        with:\n          ${WD}\n          enable-cache: true\n`));
  });

  it("reads a step whose dash stands alone on its line, and every step after it", () => {
    const bare = UV_SOURCE.replace(
      "      - uses: actions/checkout@v4",
      "      -\n        uses: actions/checkout@v4",
    ).replace(
      "      - name: Set up uv\n",
      "      - # uv, with the template's Python\n        name: Set up uv\n",
    );
    const rendered = renderTwin("app-py", "tests-check.yml", bare);
    assert.ok(rendered.includes(`        with:\n          ${WD}\n`));
    const alone = UV_SOURCE.replace(
      "      - name: Set up uv\n        uses: astral-sh/setup-uv@v7\n        with:\n          enable-cache: true\n          python-version: ${{ matrix.python-version }}\n",
      "      -\n        uses: astral-sh/setup-uv@v7\n",
    );
    assert.throws(() => renderTwin("app-py", "tests-check.yml", alone), TwinError);
  });

  it("runs every setup-uv step of every job in the template", () => {
    const twoJobs = `${UV_SOURCE}  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: astral-sh/setup-uv@v7\n        with:\n          python-version: "3.13"\n      - run: make check\n`;
    const rendered = renderTwin("app-py", "tests-check.yml", twoJobs);
    assert.equal(rendered.split(`with:\n          ${WD}\n`).length - 1, 2);
  });

  it("leaves another action's inputs alone", () => {
    const other = UV_SOURCE.replace("astral-sh/setup-uv@v7", "example/setup-tool@v1");
    const rendered = renderTwin("app-py", "tests-check.yml", other);
    assert.ok(!rendered.includes(`with:\n          ${WD}`));
  });

  it("refuses a setup-uv step it cannot run in the template", () => {
    const withBlock =
      "        with:\n          enable-cache: true\n          python-version: ${{ matrix.python-version }}\n";
    const cases = {
      "a working directory of its own": UV_SOURCE.replace(
        "          enable-cache: true",
        "          enable-cache: true\n          working-directory: app-py",
      ),
      "no with block": UV_SOURCE.replace(withBlock, ""),
      "an empty with block": UV_SOURCE.replace(withBlock, "        with:\n"),
      "a quoted action with no inputs": UV_SOURCE.replace(
        "astral-sh/setup-uv@v7\n" + withBlock,
        '"astral-sh/setup-uv@v7"\n',
      ),
      "the last step of the file": `${UV_SOURCE}      - uses: astral-sh/setup-uv@v7\n`,
    };
    for (const [label, source] of Object.entries(cases)) {
      assert.notEqual(source, UV_SOURCE, label);
      assert.throws(() => renderTwin("app-py", "tests-check.yml", source), TwinError, label);
    }
  });

  it("names the line a refusal is about", () => {
    assert.throws(
      () =>
        renderTwin(
          "app-py",
          "tests-check.yml",
          UV_SOURCE.replace(
            "        with:\n          enable-cache: true\n          python-version: ${{ matrix.python-version }}\n",
            "",
          ),
        ),
      /"uses: astral-sh\/setup-uv@v7": setup-uv reads its settings from its working directory/,
    );
  });
});

describe("compareTwins and writeTwins", () => {
  it("renders the missing twins, then finds nothing to do", () => {
    const root = family({ "lint-check.yml": SOURCE });
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, [
      { file: "app-js-lint-check.yml", kind: "missing" },
    ]);
    writeTwins(root, ["app-js"]);
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, []);
  });

  it("reports a twin whose source changed, and re-renders it", () => {
    const root = family({ "lint-check.yml": SOURCE });
    writeTwins(root, ["app-js"]);
    fs.writeFileSync(
      path.join(root, "app-js", WORKFLOWS_DIR, "lint-check.yml"),
      SOURCE.replace("make check", "make lint"),
    );
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, [
      { file: "app-js-lint-check.yml", kind: "stale" },
    ]);
    writeTwins(root, ["app-js"]);
    assert.match(
      fs.readFileSync(path.join(root, WORKFLOWS_DIR, "app-js-lint-check.yml"), "utf8"),
      /make lint/,
    );
  });

  it("reports a hand edit of a twin as stale", () => {
    const root = family({ "lint-check.yml": SOURCE });
    writeTwins(root, ["app-js"]);
    const twin = path.join(root, WORKFLOWS_DIR, "app-js-lint-check.yml");
    fs.appendFileSync(twin, "# a note\n");
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, [
      { file: "app-js-lint-check.yml", kind: "stale" },
    ]);
  });

  it("removes a twin whose source is gone, and leaves a hand-written workflow alone", () => {
    const root = family({ "lint-check.yml": SOURCE });
    writeTwins(root, ["app-js"]);
    fs.writeFileSync(path.join(root, WORKFLOWS_DIR, "family-check.yml"), "name: Family\n");
    fs.rmSync(path.join(root, "app-js", WORKFLOWS_DIR, "lint-check.yml"));
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, [
      { file: "app-js-lint-check.yml", kind: "orphaned" },
    ]);
    writeTwins(root, ["app-js"]);
    assert.deepEqual(fs.readdirSync(path.join(root, WORKFLOWS_DIR)), ["family-check.yml"]);
  });

  it("refuses to write over a hand-written workflow that has a twin's name", () => {
    const root = family({ "deploy.yml": SOURCE });
    const handWritten = path.join(root, WORKFLOWS_DIR, "app-js-deploy.yml");
    fs.mkdirSync(path.dirname(handWritten), { recursive: true });
    fs.writeFileSync(handWritten, "name: Deploy\n");
    assert.throws(() => compareTwins(root, ["app-js"]), TwinError);
    assert.throws(() => writeTwins(root, ["app-js"]), TwinError);
    assert.equal(fs.readFileSync(handWritten, "utf8"), "name: Deploy\n");
  });

  it("refuses a template directory that does not exist", () => {
    const root = family({});
    assert.throws(() => compareTwins(root, ["cli-js"]), TwinError);
  });
});

describe("this repository", () => {
  it("carries a current twin of every template workflow", () => {
    const makefile = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const templates = /^TEMPLATES := (.+)$/m.exec(makefile)[1].trim().split(/\s+/);
    assert.deepEqual(compareTwins(ROOT, templates).problems, []);
  });
});
