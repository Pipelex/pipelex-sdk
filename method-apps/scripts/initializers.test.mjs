// The family's initializers: every template of `TEMPLATES` is served by exactly
// one of them, and each one's table of templates takes the variables of the
// `make create` contract, no more and no fewer. An initializer's table is the
// `templates.json` at its root, whatever its language, so this reads each
// `initializers/<language>/templates.json`. Run with `node --test`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { EXTRAS, REQUIRED, SHARED, SWITCHES } from "./create-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INITIALIZERS = path.join(ROOT, "initializers");

const makefile = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
const TEMPLATES = /^TEMPLATES := (.+)$/m.exec(makefile)[1].trim().split(/\s+/);

/** Every initializer's table, by its directory's name. */
const tables = Object.fromEntries(
  fs
    .readdirSync(INITIALIZERS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [
      entry.name,
      JSON.parse(fs.readFileSync(path.join(INITIALIZERS, entry.name, "templates.json"), "utf8")),
    ]),
);

describe("the initializers", () => {
  it("serve every template of the family, each by exactly one initializer", () => {
    for (const template of TEMPLATES) {
      const servedBy = Object.keys(tables).filter((name) => template in tables[name].templates);
      assert.equal(
        servedBy.length,
        1,
        `${template} is served by ${servedBy.length === 0 ? "no initializer" : servedBy.join(" and ")}: add it to the templates.json of exactly one`,
      );
    }
  });

  it("serve nothing that is not a template of the family, and only their own ecosystem's", () => {
    for (const [name, table] of Object.entries(tables)) {
      assert.equal(
        table.ecosystem,
        name,
        `initializers/${name} declares ecosystem ${table.ecosystem}`,
      );
      assert.ok(
        table.default in table.templates,
        `initializers/${name}: its default is not in its table`,
      );
      for (const template of Object.keys(table.templates)) {
        assert.ok(
          TEMPLATES.includes(template),
          `initializers/${name} serves ${template}, which TEMPLATES does not name`,
        );
        assert.ok(
          template.endsWith(`-${name}`),
          `initializers/${name} serves ${template}, a template of another ecosystem`,
        );
      }
    }
  });

  it("take the create contract's variables, and each template's declared extras", () => {
    for (const [name, table] of Object.entries(tables)) {
      assert.deepEqual(table.create.shared, SHARED, `initializers/${name}: create.shared`);
      assert.deepEqual(
        new Set(table.create.switches),
        SWITCHES,
        `initializers/${name}: create.switches`,
      );
      assert.equal(table.create.required, REQUIRED, `initializers/${name}: create.required`);
      for (const [template, { extras }] of Object.entries(table.templates)) {
        assert.deepEqual(
          extras,
          EXTRAS[template] ?? [],
          `initializers/${name}: ${template}'s extras`,
        );
      }
    }
  });
});
