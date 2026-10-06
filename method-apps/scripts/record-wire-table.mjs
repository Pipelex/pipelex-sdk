#!/usr/bin/env node
/**
 * The wire-format table: what the form kernel sends for a value, recorded so
 * that `cli-python` can be held to it.
 *
 * Two templates fill a run's inputs. `webapp-js` fills them through the
 * TypeScript form kernel, `@pipelex/mthds-form`; `cli-python` fills them from
 * its command line, through a port of that kernel's payload rules. A method
 * must receive the same inputs from both, so this script runs the real kernel,
 * the one `webapp-js` has installed, over every contract fixture `webapp-js`
 * carries and over `wire-table/every-kind.json`, which reaches the field kinds
 * those fixtures do not, and writes what it sends into `cli-python`'s tests:
 *
 * - `cli-python/tests/fixtures/wire/contracts/<fixture>.json`, each fixture's
 *   contracts in the shape of the `contracts.json` the CLI reads;
 * - `cli-python/tests/fixtures/wire/table.json`, one case per pipe and per set
 *   of inputs given (every input, the required ones only, none): the value
 *   each input's control holds, the option values the CLI is given for the same
 *   value, and the kernel's verdict, the inputs it sends or the inputs it says
 *   are missing.
 *
 * `cli-python/tests/test_wire_table.py` replays the table through the CLI. It
 * lives here, at the family's root, because it reads two templates, and a
 * template never reaches above its own directory.
 *
 * `node scripts/record-wire-table.mjs` rewrites the files; `--check` compares
 * them with what it would write, byte for byte, and exits 1 on a difference.
 * Node reads `webapp-js`'s TypeScript fixtures directly, which Node 22 before
 * 22.18 does only under `--experimental-strip-types`.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The family's root. */
export const FAMILY_ROOT = path.resolve(import.meta.dirname, "..");

/** The installed form kernel the table is recorded from. */
export const KERNEL_DIR = path.join(
  FAMILY_ROOT,
  "webapp-js",
  "node_modules",
  "@pipelex",
  "mthds-form",
);

/** The contract fixtures `webapp-js` carries, each a module exporting the three payloads. */
export const FIXTURES_DIR = path.join(
  FAMILY_ROOT,
  "webapp-js",
  "src",
  "test",
  "fixtures",
  "contracts",
);

/** The contract assembled to reach the field kinds no fixture does. */
export const EVERY_KIND = path.join(FAMILY_ROOT, "scripts", "wire-table", "every-kind.json");

/** Where the recording goes. */
export const OUT_DIR = path.join(FAMILY_ROOT, "cli-python", "tests", "fixtures", "wire");

/** The field kinds one value on the command line carries; a list of them is a repeatable option. */
const SCALAR_KINDS = new Set([
  "text",
  "prose",
  "date",
  "number",
  "boolean",
  "enum",
  "document",
  "image",
]);

/** The scheme an uploaded file's reference carries. */
const STORAGE = "pipelex-storage://";

/** The sets of inputs each pipe is recorded with. */
export const CASES = ["every input", "required only", "nothing"];

/** The recorded files' text: two-space JSON and a final newline, so a recording is byte-stable. */
export function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The value a control holds for a node, by kind, the same for every recording. */
export function sample(node, name, variant) {
  switch (node.kind) {
    case "text":
      return node.format === "time" ? "15:40:00" : `A ${name}`;
    case "prose":
      return `Some ${name}.\nOn two lines.`;
    case "number":
      return node.integer ? (node.minimum ?? 3) : 2.5;
    case "boolean":
      return variant === "required only";
    case "enum":
      return node.choices[node.choices.length - 1];
    case "date":
      return node.datetime ? "2026-07-06T15:40:00Z" : "2026-07-06";
    case "document":
      return { url: `https://example.com/files/${name}.pdf` };
    case "image":
      return { url: `${STORAGE}wire-table/${name}.png`, filename: `${name}.png` };
    case "object": {
      const value = {};
      for (const child of node.fields) {
        if (!child.required && variant !== "every input") continue;
        const nested = nestedSample(child, child.name);
        if (nested !== undefined) value[child.name] = nested;
      }
      return value;
    }
    case "list": {
      const count = node.item_count ?? 2;
      return Array.from({ length: count }, (_, index) =>
        sample(node.item, `${name}-${index + 1}`, variant),
      );
    }
    case "unknown":
      return JSON.stringify({ json_obj: { answer: 42 } });
    default:
      throw new Error(`no sample for the kind ${node.kind}`);
  }
}

/** A value inside a structure, which the CLI takes as JSON: files are URLs there, and an unknown is left out. */
function nestedSample(node, name) {
  switch (node.kind) {
    case "image":
      return { url: `https://example.com/files/${name}.png` };
    case "unknown":
      return undefined;
    case "object":
      return sample(node, name, "every input");
    case "list":
      return [nestedSample(node.item, `${name}-1`)].filter((item) => item !== undefined);
    default:
      return sample(node, name, "every input");
  }
}

/** How `cli-python` takes an input: one value, a repeatable value, or JSON. */
export function optionStyle(field) {
  if (field.kind === "list" && SCALAR_KINDS.has(field.item.kind)) return "repeatable";
  if (SCALAR_KINDS.has(field.kind)) return "scalar";
  return "json";
}

/** One value on the command line for a scalar control: an uploaded file is given as its local name. */
function token(node, value, uploads) {
  switch (node.kind) {
    case "number":
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "document":
    case "image":
      if (value.url.startsWith(STORAGE)) {
        uploads[value.filename] = value.url;
        return value.filename;
      }
      return value.url;
    default:
      return value;
  }
}

/** The option values the CLI is given for the value a control holds. */
export function cliValues(kernel, field, value, uploads) {
  switch (optionStyle(field)) {
    case "repeatable":
      return value.map((item) => token(field.item, item, uploads));
    case "scalar":
      return [token(field, value, uploads)];
    default:
      // JSON is the value as the form holds it on the wire, which the kernel builds from the control.
      return [
        field.kind === "unknown"
          ? value
          : JSON.stringify(
              kernel.rjsfDataFromRunValues({ [field.name]: value }, [field])[field.name],
            ),
      ];
  }
}

/** The kernel's verdict on a form's values, as the table records it. */
function verdictOf(kernel, contract, fields, values) {
  const verdict = kernel.gateRunInputs(contract, kernel.rjsfDataFromRunValues(values, fields));
  if (verdict.ok) return { ok: true, inputs: verdict.inputs };
  return {
    ok: false,
    missing_inputs: verdict.missingInputs,
    errors: verdict.errors.map((error) => ({
      property: error.property ?? "",
      message: error.message ?? "",
    })),
  };
}

/** Every case of one fixture: each pipe, with each set of inputs given. */
export function casesOf(kernel, fixture, contracts) {
  const cases = [];
  for (const pipeRef of Object.keys(contracts.input_form).sort()) {
    const contract = contracts.pipe_io_contracts[pipeRef];
    const descriptor = contracts.input_form[pipeRef];
    const fields = kernel.buildRunFields(descriptor, contract.inputs);
    for (const variant of CASES) {
      const given = {};
      const values = {};
      const uploads = {};
      for (const field of fields) {
        const node = descriptor.fields.find((candidate) => candidate.name === field.name);
        if (variant === "nothing" || (variant === "required only" && !node.gating)) continue;
        const control = sample(node, node.name, variant);
        values[node.name] = control;
        given[node.name] = { control, cli: cliValues(kernel, field, control, uploads) };
      }
      cases.push({
        fixture,
        pipe_ref: pipeRef,
        case: variant,
        given,
        uploads,
        verdict: verdictOf(kernel, contract, fields, values),
      });
    }
  }
  return cases;
}

/** The fixtures, each with its contracts in the shape of a `contracts.json`, in name order. */
export async function loadFixtures() {
  const fixtures = [];
  const names = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith(".ts")).sort();
  for (const name of names) {
    const module = await import(pathToFileURL(path.join(FIXTURES_DIR, name)).href);
    fixtures.push({
      name: name.slice(0, -".ts".length),
      contracts: {
        comment: `The contract fixture webapp-js carries as src/test/fixtures/contracts/${name}, recorded as JSON by method-apps/scripts/record-wire-table.mjs. Do not edit.`,
        pipe_io_contracts: module.PIPE_IO_CONTRACTS,
        input_form: module.INPUT_FORM,
        output_form: module.OUTPUT_FORM,
      },
    });
  }
  fixtures.push({ name: "every-kind", contracts: JSON.parse(await readFile(EVERY_KIND, "utf8")) });
  return fixtures;
}

/** Every file of the recording, by its path under `OUT_DIR`, with its text. */
export async function recording() {
  const manifest = JSON.parse(await readFile(path.join(KERNEL_DIR, "package.json"), "utf8"));
  const kernel = await import(
    pathToFileURL(path.join(KERNEL_DIR, "dist", "core", "index.js")).href
  );
  const fixtures = await loadFixtures();
  const files = {};
  const cases = [];
  for (const { name, contracts } of fixtures) {
    files[path.join("contracts", `${name}.json`)] = render(contracts);
    cases.push(...casesOf(kernel, name, contracts));
  }
  files["table.json"] = render({
    comment:
      "What @pipelex/mthds-form sends for each case, recorded by method-apps/scripts/record-wire-table.mjs from the kernel webapp-js installs. " +
      "`control` is the value the form's control holds, `cli` the option values cli-python is given for the same value, and `uploads` the local files " +
      "a case names with the reference their upload answers. Do not edit: rerun the recorder.",
    kernel: `${manifest.name} ${manifest.version}`,
    cases,
  });
  return files;
}

async function main(argv) {
  const check = argv.includes("--check");
  const files = await recording();
  const differing = [];
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(OUT_DIR, relative);
    let current = null;
    try {
      current = await readFile(target, "utf8");
    } catch {
      current = null;
    }
    if (current === text) continue;
    differing.push(relative);
    if (!check) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    }
  }
  const where = path.relative(FAMILY_ROOT, OUT_DIR);
  if (check && differing.length > 0) {
    console.error(
      `The recorded wire table in ${where}/ is not what the kernel sends: ${differing.join(", ")}.`,
    );
    console.error(
      "Rerun `node scripts/record-wire-table.mjs` and commit the result, then make cli-python agree with it.",
    );
    return 1;
  }
  console.log(
    check
      ? `The wire table in ${where}/ is current.`
      : `Wrote ${differing.length ? differing.join(", ") : "nothing new"} in ${where}/.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
