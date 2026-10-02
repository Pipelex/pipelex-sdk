// The workflow twins: what a rendering carries, what it refuses, and what the
// check reports. Run with `node --test` — the root has no dependencies.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  ROOT,
  SDKS,
  TWIN_MARKER,
  TwinError,
  WORKFLOWS_DIR,
  compareTwins,
  expectedTwins,
  nextSdkTwins,
  pyprojectDependencies,
  renderNextSdkTwin,
  renderStandaloneTwin,
  standaloneTwins,
  templateSdk,
  writeTwins,
} from "./workflows.mjs";

const NPM = SDKS.find((sdk) => sdk.ecosystem === "npm");
const PYPI = SDKS.find((sdk) => sdk.ecosystem === "pypi");

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

/** SOURCE with an install step, as the templates' Node workflows are. */
const NPM_SOURCE = SOURCE.replace(
  "      - name: Run check",
  "      - name: Install dependencies\n        run: npm ci\n\n      - name: Run check",
);

const PY_SOURCE = `name: Lint check

on:
  pull_request:
    branches:
      - main
      - "release/v[0-9]+.[0-9]+.[0-9]+"

jobs:
  lint:
    name: Lint (\${{ matrix.python-version }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        python-version: ["3.11", "3.13"]
    env:
      VIRTUAL_ENV: \${{ github.workspace }}/.venv

    steps:
      - uses: actions/checkout@v4

      - name: Set up Python \${{ matrix.python-version }}
        uses: actions/setup-python@v4
        with:
          python-version: \${{ matrix.python-version }}

      - name: Install dependencies
        run: PYTHON_VERSION=\${{ matrix.python-version }} make install

      - name: Run ruff lint merge check
        run: make merge-check-ruff-lint

  lint-all:
    name: Lint (all versions)
    runs-on: ubuntu-latest
    needs: lint        # wait for every matrix leg
    if: always()

    steps:
      - name: Fail if any matrix leg failed
        run: |
          if [ "\${{ needs.lint.result }}" != "success" ]; then
            exit 1
          fi
`;

const UV_SOURCE = `name: package-check

on:
  pull_request:

jobs:
  uv-lock-check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Install uv
        uses: astral-sh/setup-uv@v3
        with:
          enable-cache: true

      - name: Check if uv.lock is up to date
        run: |
          uv lock --locked
          git diff --exit-code uv.lock
`;

/** The extraction step a twin of `template` (slug `slug`) adds after the checkout. */
const extraction = (template, slug) => `      - name: Extract ${template} as the export ships it
        working-directory: .
        run: |
          rm -rf ../standalone/${slug} && mkdir -p ../standalone/${slug}
          git archive HEAD:${template} | tar -x -C ../standalone/${slug}
          cd ../standalone/${slug}
          git init -q -b main
          git add -A -f
          git -c user.name=ci -c user.email=ci@localhost commit -q -m "${template}, as a project made from it starts"
`;

const defaults = (slug) =>
  `    defaults:\n      run:\n        working-directory: ../standalone/${slug}\n`;

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway repository with one template, its manifest, and the workflows given. */
function repository(workflows, { template = "app-js", manifest = { name: "app" } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-twins-"));
  roots.push(root);
  const dir = path.join(root, template, WORKFLOWS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(workflows))
    fs.writeFileSync(path.join(dir, file), text);
  if (typeof manifest === "string") {
    fs.writeFileSync(path.join(root, template, "pyproject.toml"), manifest);
  } else if (manifest) {
    fs.writeFileSync(path.join(root, template, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

describe("renderStandaloneTwin", () => {
  const twin = renderStandaloneTwin("app-js", "lint-check.yml", SOURCE);

  it("opens with the marker naming its source", () => {
    assert.ok(twin.startsWith(`${TWIN_MARKER}app-js/${WORKFLOWS_DIR}/lint-check.yml`));
    assert.match(twin.split("\n")[1], /^# It runs app-js extracted exactly as the export ships it/);
  });

  it("names the template in the workflow and the job", () => {
    assert.match(twin, /^name: Lint check \(app-js\)$/m);
    assert.match(twin, /^ {4}name: Lint \(app-js\)$/m);
    assert.match(twin, /^ {6}- name: Set up Node.js$/m);
  });

  it("is a reusable workflow, whatever the source's triggers", () => {
    assert.match(twin, /\non:\n {2}workflow_call:\n\njobs:\n/);
    for (const on of [
      "on: pull_request",
      "on: [push, pull_request]",
      'on:\n  pull_request:\n    branches:\n      - main\n    paths:\n      - "src/**"',
    ]) {
      const rendered = renderStandaloneTwin(
        "app-js",
        "lint-check.yml",
        SOURCE.replace("on:\n  pull_request:", on),
      );
      assert.match(rendered, /\non:\n {2}workflow_call:\n\njobs:\n/, on);
      assert.doesNotMatch(rendered, /pull_request|push|branches|paths/, on);
    }
  });

  it("extracts the template right after the checkout, and runs every step there", () => {
    assert.ok(
      twin.includes(
        `    runs-on: ubuntu-latest\n${defaults("app-js")}    steps:\n      - uses: actions/checkout@v4\n\n${extraction("app-js", "app-js")}\n      - name: Set up Node.js\n`,
      ),
    );
  });

  it("extracts after a checkout step written over several lines", () => {
    const rendered = renderStandaloneTwin("app-py", "package-check.yml", UV_SOURCE);
    assert.ok(
      rendered.includes(
        `      - name: Checkout code\n        uses: actions/checkout@v4\n\n${extraction("app-py", "app-py")}\n      - name: Install uv\n`,
      ),
    );
  });

  it("names the extracted folder after the template's whole path", () => {
    const rendered = renderStandaloneTwin("family/app-js", "lint-check.yml", SOURCE);
    assert.ok(rendered.includes(extraction("family/app-js", "family-app-js")));
    assert.ok(rendered.includes(defaults("family-app-js")));
    assert.match(rendered, /cache-dependency-path: family\/app-js\/package-lock\.json\n/);
  });

  it("points the npm cache at the monorepo's copy of the template's lock file", () => {
    assert.match(twin, /cache: "npm"\n {10}cache-dependency-path: app-js\/package-lock\.json\n/);
    for (const spelling of ["cache: npm", "cache: 'npm'", 'cache: "npm" # the lock file']) {
      const rendered = renderStandaloneTwin(
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

  it("keeps everything else as it was", () => {
    const body = twin.split("\n").slice(3).join("\n");
    const restored = body
      .replace(/ \(app-js\)$/gm, "")
      .replace("on:\n  workflow_call:", "on:\n  pull_request:")
      .replace(defaults("app-js"), "")
      .replace(`\n${extraction("app-js", "app-js")}`, "")
      .replace(/\n {10}cache-dependency-path: app-js\/package-lock\.json/, "");
    assert.equal(restored, SOURCE);
  });

  it("renders the same twin every time", () => {
    assert.equal(renderStandaloneTwin("app-js", "lint-check.yml", SOURCE), twin);
  });

  it("rewrites the workspace to the extracted folder in a job that checks out", () => {
    const rendered = renderStandaloneTwin("app-py", "lint-check.yml", PY_SOURCE);
    assert.match(
      rendered,
      /^ {6}VIRTUAL_ENV: \$\{\{ github\.workspace \}\}\/\.\.\/standalone\/app-py\/\.venv$/m,
    );
    assert.doesNotMatch(rendered, /github\.workspace \}\}\/\.venv/);
  });

  it("leaves a job that does not check out as written, apart from its name", () => {
    const rendered = renderStandaloneTwin("app-py", "lint-check.yml", PY_SOURCE);
    const aggregator = rendered.slice(rendered.indexOf("  lint-all:"));
    assert.equal(
      aggregator,
      PY_SOURCE.slice(PY_SOURCE.indexOf("  lint-all:")).replace(
        "Lint (all versions)",
        "Lint (all versions) (app-py)",
      ),
    );
    assert.equal(rendered.match(/working-directory: \.\.\/standalone\/app-py$/gm).length, 1);
  });

  it("leaves a setup-uv step exactly as written", () => {
    const rendered = renderStandaloneTwin("app-py", "package-check.yml", UV_SOURCE);
    assert.ok(
      rendered.includes(
        "      - name: Install uv\n        uses: astral-sh/setup-uv@v3\n        with:\n          enable-cache: true\n\n",
      ),
    );
    const bare = UV_SOURCE.replace("        with:\n          enable-cache: true\n", "");
    assert.ok(
      renderStandaloneTwin("app-py", "package-check.yml", bare).includes(
        "        uses: astral-sh/setup-uv@v3\n\n",
      ),
    );
  });

  it("runs every job that checks out in the extracted folder", () => {
    const twoJobs = `${SOURCE}  build:\n    runs-on: \${{ matrix.os }}\n    steps:\n      - uses: actions/checkout@v4\n      - run: make build\n`;
    const rendered = renderStandaloneTwin("app-js", "lint-check.yml", twoJobs);
    assert.equal(rendered.split(defaults("app-js")).length - 1, 2);
    assert.ok(
      rendered.endsWith(
        `    steps:\n      - uses: actions/checkout@v4\n${extraction("app-js", "app-js")}      - run: make build\n`,
      ),
    );
  });

  it("reads a step whose dash stands alone on its line", () => {
    const bare = SOURCE.replace(
      "      - uses: actions/checkout@v4",
      "      -\n        uses: actions/checkout@v4",
    );
    const rendered = renderStandaloneTwin("app-js", "lint-check.yml", bare);
    assert.ok(
      rendered.includes(
        `      -\n        uses: actions/checkout@v4\n\n${extraction("app-js", "app-js")}\n`,
      ),
    );
  });

  it("refuses what it cannot carry faithfully", () => {
    const cases = {
      "a quoted workflow name": SOURCE.replace("name: Lint check", 'name: "Lint check"'),
      "a quoted job name": SOURCE.replace("    name: Lint", "    name: 'Lint'"),
      "no top-level name": SOURCE.replace("name: Lint check\n", ""),
      "no on block": SOURCE.replace("on:\n  pull_request:\n", ""),
      "a job that sets defaults": SOURCE.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash",
      ),
      "a cache-dependency-path": SOURCE.replace(
        '          cache: "npm"',
        '          cache: "npm"\n          cache-dependency-path: package-lock.json',
      ),
      "a step's working directory": SOURCE.replace(
        "        run: make check",
        "        run: make check\n        working-directory: sub",
      ),
      "a node-version-file": SOURCE.replace(
        '          node-version: "22"',
        "          node-version-file: .nvmrc",
      ),
      "a local action": SOURCE.replace(
        "      - uses: actions/checkout@v4",
        "      - uses: actions/checkout@v4\n      - uses: ./.github/actions/setup",
      ),
      hashFiles: SOURCE.replace(
        '          cache: "npm"',
        "          cache: \"npm\"\n          key: ${{ hashFiles('package-lock.json') }}",
      ),
      "a cache other than npm's": SOURCE.replace('          cache: "npm"', "          cache: yarn"),
      "a flow mapping": SOURCE.replace(
        '        with:\n          node-version: "22"\n          cache: "npm"',
        '        with: { node-version: "22", cache: "npm" }',
      ),
      "a runs-on block": SOURCE.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on:\n      labels: [ubuntu-latest]",
      ),
      "a runs-on group": SOURCE.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on: \n      group: build-runners",
      ),
      "a runs-on with only a comment": SOURCE.replace(
        "    runs-on: ubuntu-latest",
        "    runs-on: # the larger runners\n      labels: [ubuntu-latest]",
      ),
      "a checking-out job with no runs-on": SOURCE.replace("    runs-on: ubuntu-latest\n", ""),
      "a call to a reusable workflow": `${SOURCE}  shared:\n    uses: octo-org/shared/.github/workflows/x.yml@v1\n`,
      "no job that checks out": SOURCE.replace("      - uses: actions/checkout@v4\n", ""),
      "a second checkout": SOURCE.replace(
        "      - uses: actions/checkout@v4",
        "      - uses: actions/checkout@v4\n      - uses: actions/checkout@v4",
      ),
      "a step that runs before the checkout": SOURCE.replace(
        "      - uses: actions/checkout@v4",
        "      - run: echo early\n      - uses: actions/checkout@v4",
      ),
      "the shell's workspace": SOURCE.replace(
        "        run: make check",
        '        run: make -C "$GITHUB_WORKSPACE" check',
      ),
      "the workspace inside a larger expression": SOURCE.replace(
        "        run: make check",
        "        run: make -C ${{ format('{0}', github.workspace) }} check",
      ),
      "the workspace outside a job that checks out": SOURCE.replace(
        "jobs:",
        "env:\n  CACHE: ${{ github.workspace }}/.cache\n\njobs:",
      ),
    };
    for (const [label, source] of Object.entries(cases)) {
      assert.notEqual(source, SOURCE, label);
      assert.throws(
        () => renderStandaloneTwin("app-js", "lint-check.yml", source),
        TwinError,
        label,
      );
    }
  });

  it("names the line a refusal is about", () => {
    assert.throws(
      () =>
        renderStandaloneTwin(
          "app-js",
          "lint-check.yml",
          SOURCE.replace('          cache: "npm"', "          cache: yarn"),
        ),
      /app-js\/\.github\/workflows\/lint-check\.yml: cannot render "cache: yarn"/,
    );
  });
});

describe("renderNextSdkTwin", () => {
  const twin = renderNextSdkTwin("app-js", "tests-check.yml", NPM_SOURCE, NPM);

  it("says what it tests, and names the SDK in the workflow and the job", () => {
    assert.ok(twin.startsWith(`${TWIN_MARKER}app-js/${WORKFLOWS_DIR}/tests-check.yml`));
    assert.match(twin.split("\n")[1], /against @pipelex\/sdk built from the/);
    assert.match(twin.split("\n")[2], /reported, not required/);
    assert.match(twin, /^name: Lint check \(app-js, next SDK\)$/m);
    assert.match(twin, /^ {4}name: Lint \(app-js, next SDK\)$/m);
  });

  it("runs on a pull request touching the template, the SDK or the twin itself", () => {
    assert.ok(
      twin.includes(
        'on:\n  pull_request:\n    paths:\n      - "app-js/**"\n      - "js/**"\n      - ".github/workflows/app-js-next-sdk-tests-check.yml"\n\njobs:\n',
      ),
    );
    const python = renderNextSdkTwin("app-py", "lint-check.yml", PY_SOURCE, PYPI);
    assert.ok(python.includes('      - "app-py/**"\n      - "python/**"\n'));
    assert.doesNotMatch(python, /branches:/);
  });

  it("installs the npm SDK built from this commit right after the template's install", () => {
    assert.ok(
      twin.includes(`      - name: Install dependencies
        run: npm ci

      - name: Install @pipelex/sdk built from this commit
        run: |
          mkdir -p "$RUNNER_TEMP/next-sdk"
          (cd "$GITHUB_WORKSPACE/js" && npm ci && npm pack --pack-destination "$RUNNER_TEMP/next-sdk")
          npm install --no-save "$RUNNER_TEMP"/next-sdk/*.tgz

      - name: Run check
`),
    );
  });

  it("installs the Python SDK built from this commit right after the template's install", () => {
    const python = renderNextSdkTwin("app-py", "lint-check.yml", PY_SOURCE, PYPI);
    assert.ok(
      python.includes(`      - name: Install dependencies
        run: PYTHON_VERSION=\${{ matrix.python-version }} make install

      - name: Install pipelex-sdk built from this commit
        run: |
          uv build --wheel --out-dir "$RUNNER_TEMP/next-sdk" "$GITHUB_WORKSPACE/python"
          uv pip install --python .venv/bin/python --reinstall-package pipelex-sdk "$RUNNER_TEMP"/next-sdk/*.whl

      - name: Run ruff lint merge check
`),
    );
  });

  it("transforms the jobs as the standalone twin does", () => {
    const python = renderNextSdkTwin("app-py", "lint-check.yml", PY_SOURCE, PYPI);
    assert.ok(python.includes(defaults("app-py")));
    assert.ok(
      python.includes(`      - uses: actions/checkout@v4\n\n${extraction("app-py", "app-py")}`),
    );
    assert.match(python, /\$\{\{ github\.workspace \}\}\/\.\.\/standalone\/app-py\/\.venv$/m);
    assert.match(python, /^ {4}name: Lint \(all versions\) \(app-py, next SDK\)$/m);
  });

  it("is not rendered for a workflow with no install step", () => {
    assert.equal(renderNextSdkTwin("app-js", "lint-check.yml", SOURCE, NPM), null);
    assert.equal(renderNextSdkTwin("app-py", "package-check.yml", UV_SOURCE, PYPI), null);
  });

  it("refuses a job with two install steps, and an install inside a multi-line run", () => {
    const twice = NPM_SOURCE.replace(
      "        run: npm ci\n",
      "        run: npm ci\n\n      - name: Again\n        run: make install\n",
    );
    assert.throws(() => renderNextSdkTwin("app-js", "tests-check.yml", twice, NPM), TwinError);
    const hidden = SOURCE.replace(
      "      - name: Run check\n        run: make check",
      "      - name: Install and check\n        run: |\n          npm ci\n          make check",
    );
    assert.throws(() => renderNextSdkTwin("app-js", "tests-check.yml", hidden, NPM), TwinError);
    assert.doesNotThrow(() => renderStandaloneTwin("app-js", "tests-check.yml", twice));
  });
});

describe("templateSdk", () => {
  it("finds the SDK in a package.json's dependencies or devDependencies", () => {
    const deps = repository({}, { manifest: { dependencies: { "@pipelex/sdk": "^0.26.0" } } });
    assert.equal(templateSdk(deps, "app-js"), NPM);
    const dev = repository({}, { manifest: { devDependencies: { "@pipelex/sdk": "^0.26.0" } } });
    assert.equal(templateSdk(dev, "app-js"), NPM);
    const none = repository({}, { manifest: { dependencies: { "@pipelex/sdk-extra": "1" } } });
    assert.equal(templateSdk(none, "app-js"), null);
  });

  it("finds the SDK among a pyproject.toml's [project] dependencies, by its normalized name", () => {
    const pyproject = (dependency) =>
      `[project]\nname = "app"\ndependencies = [\n  "mthds>=0.17.0",\n  "${dependency}",\n]\n\n[tool.uv]\ndev-dependencies = ["pipelex-sdk"]\n`;
    for (const dependency of ["pipelex-sdk>=0.14.0", "Pipelex_SDK[cli] >= 0.14", "pipelex.sdk"]) {
      const root = repository({}, { template: "app-py", manifest: pyproject(dependency) });
      assert.equal(templateSdk(root, "app-py"), PYPI, dependency);
    }
    const other = repository({}, { template: "app-py", manifest: pyproject("pipelex-sdkx") });
    assert.equal(templateSdk(other, "app-py"), null);
  });

  it("reads the strings of the [project] dependencies, extras and comments included", () => {
    assert.deepEqual(
      pyprojectDependencies(
        '[tool.x]\ndependencies = ["no"]\n\n[project]\ndependencies = [ # what it needs\n  "a[x,y]>=1",\n  \'b\', # a comment ]\n]\n',
      ),
      ["a[x,y]>=1", "b"],
    );
  });
});

describe("compareTwins and writeTwins", () => {
  it("renders the missing twins, then finds nothing to do", () => {
    const root = repository({ "lint-check.yml": SOURCE });
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, [
      { file: "app-js-lint-check.yml", kind: "missing" },
    ]);
    writeTwins(root, ["app-js"]);
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, []);
  });

  it("renders a next-SDK twin beside the standalone one only when the template has an SDK", () => {
    const sdk = { dependencies: { "@pipelex/sdk": "^0.26.0" } };
    const withSdk = repository(
      { "lint-check.yml": SOURCE, "tests-check.yml": NPM_SOURCE },
      { manifest: sdk },
    );
    assert.deepEqual(
      [...expectedTwins(withSdk, ["app-js"]).keys()],
      ["app-js-lint-check.yml", "app-js-tests-check.yml", "app-js-next-sdk-tests-check.yml"],
    );
    assert.deepEqual(standaloneTwins(withSdk, ["app-js"]), [
      "app-js-lint-check.yml",
      "app-js-tests-check.yml",
    ]);
    assert.deepEqual(nextSdkTwins(withSdk, ["app-js"]), ["app-js-next-sdk-tests-check.yml"]);
    const withoutSdk = repository({ "tests-check.yml": NPM_SOURCE });
    assert.deepEqual(nextSdkTwins(withoutSdk, ["app-js"]), []);
  });

  it("renders a Python template's two twins", () => {
    const root = repository(
      { "lint-check.yml": PY_SOURCE, "package-check.yml": UV_SOURCE },
      { template: "app-py", manifest: '[project]\ndependencies = ["pipelex-sdk>=0.14"]\n' },
    );
    writeTwins(root, ["app-py"]);
    assert.deepEqual(fs.readdirSync(path.join(root, WORKFLOWS_DIR)).sort(), [
      "app-py-lint-check.yml",
      "app-py-next-sdk-lint-check.yml",
      "app-py-package-check.yml",
    ]);
  });

  it("reports a twin whose source changed, and re-renders it", () => {
    const root = repository({ "lint-check.yml": SOURCE });
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
    const root = repository({ "lint-check.yml": SOURCE });
    writeTwins(root, ["app-js"]);
    const twin = path.join(root, WORKFLOWS_DIR, "app-js-lint-check.yml");
    fs.appendFileSync(twin, "# a note\n");
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, [
      { file: "app-js-lint-check.yml", kind: "stale" },
    ]);
  });

  it("removes a twin whose source is gone, and leaves a hand-written workflow alone", () => {
    const root = repository({ "lint-check.yml": SOURCE });
    writeTwins(root, ["app-js"]);
    fs.writeFileSync(path.join(root, WORKFLOWS_DIR, "ci.yml"), "name: CI\n");
    fs.rmSync(path.join(root, "app-js", WORKFLOWS_DIR, "lint-check.yml"));
    assert.deepEqual(compareTwins(root, ["app-js"]).problems, [
      { file: "app-js-lint-check.yml", kind: "orphaned" },
    ]);
    writeTwins(root, ["app-js"]);
    assert.deepEqual(fs.readdirSync(path.join(root, WORKFLOWS_DIR)), ["ci.yml"]);
  });

  it("refuses to write over a hand-written workflow that has a twin's name", () => {
    const root = repository({ "deploy.yml": SOURCE });
    const handWritten = path.join(root, WORKFLOWS_DIR, "app-js-deploy.yml");
    fs.mkdirSync(path.dirname(handWritten), { recursive: true });
    fs.writeFileSync(handWritten, "name: Deploy\n");
    assert.throws(() => compareTwins(root, ["app-js"]), TwinError);
    assert.throws(() => writeTwins(root, ["app-js"]), TwinError);
    assert.equal(fs.readFileSync(handWritten, "utf8"), "name: Deploy\n");
  });

  it("refuses a template directory that does not exist", () => {
    const root = repository({});
    assert.throws(() => compareTwins(root, ["cli-js"]), TwinError);
  });
});

describe("this repository", () => {
  const makefile = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
  const templates = /^TEMPLATES := (.+)$/m.exec(makefile)[1].trim().split(/\s+/);

  it("carries a current twin of every template workflow", () => {
    assert.deepEqual(compareTwins(ROOT, templates).problems, []);
  });

  it("calls every standalone twin from ci.yml, and no next-SDK twin", () => {
    const ci = fs.readFileSync(path.join(ROOT, WORKFLOWS_DIR, "ci.yml"), "utf8");
    const called = [...ci.matchAll(/^\s+uses: \.\/\.github\/workflows\/(\S+)\s*$/gm)].map(
      (match) => match[1],
    );
    for (const file of standaloneTwins(ROOT, templates)) {
      assert.ok(called.includes(file), `ci.yml does not call ${file}`);
    }
    for (const file of nextSdkTwins(ROOT, templates)) {
      assert.ok(!called.includes(file), `ci.yml calls ${file}, which is reported, not required`);
    }
    for (const file of called) {
      assert.ok(fs.existsSync(path.join(ROOT, WORKFLOWS_DIR, file)), `ci.yml calls ${file}`);
    }
  });
});
