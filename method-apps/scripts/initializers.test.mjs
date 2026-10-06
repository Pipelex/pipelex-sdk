// The family's initializers: every template of `TEMPLATES` whose ecosystem has
// an initializer is served by exactly one of them, and each one's table of
// templates takes the variables of the `make create` contract, no more and no
// fewer. An initializer's table is the `templates.json` at its root, whatever
// its language, so this reads each `initializers/<language>/templates.json`. A
// template's ecosystem is the last word of its name, `js` for `webapp-js`, and
// an ecosystem whose initializer is not written yet has no directory there: its
// templates are served by none until it is, and every other initializer sends
// a request for one of them to the copy-out its README shows. Run with
// `node --test`.

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

/** A template's ecosystem: the last word of its name, `python` for `cli-python`. */
function ecosystemOf(template) {
  return template.slice(template.lastIndexOf("-") + 1);
}

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
  it("serve every template whose ecosystem has an initializer, each by exactly one", () => {
    for (const template of TEMPLATES) {
      const servedBy = Object.keys(tables).filter((name) => template in tables[name].templates);
      if (!(ecosystemOf(template) in tables)) {
        // Its ecosystem has no initializer yet, so nothing can serve it: the
        // next test refuses a table serving another ecosystem's template.
        assert.equal(servedBy.length, 0, `${template} is served by ${servedBy.join(" and ")}`);
        continue;
      }
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

  it("send another ecosystem's template to its initializer, or to its README's copy-out while it has none", () => {
    for (const [name, table] of Object.entries(tables)) {
      const others = new Set(TEMPLATES.map(ecosystemOf).filter((ecosystem) => ecosystem !== name));
      assert.deepEqual(
        new Set(Object.keys(table.otherEcosystems)),
        others,
        `initializers/${name}: otherEcosystems names every other ecosystem of TEMPLATES, and only those`,
      );
      for (const [ecosystem, other] of Object.entries(table.otherEcosystems)) {
        const where = `initializers/${name}: otherEcosystems.${ecosystem}`;
        if (ecosystem in tables) {
          assert.deepEqual(
            Object.keys(other),
            ["initializer"],
            `${where} names that ecosystem's initializer`,
          );
          continue;
        }
        assert.deepEqual(
          Object.keys(other),
          ["copyOut"],
          `${where} has no initializer to name yet`,
        );
        for (const template of TEMPLATES.filter((t) => ecosystemOf(t) === ecosystem)) {
          const url = new URL(other.copyOut.replaceAll("{template}", template));
          assert.equal(
            `${url.origin}${url.pathname}`,
            `https://github.com/Pipelex/pipelex-sdk/tree/main/method-apps/${template}`,
            `${where} points at ${template}'s directory`,
          );
          const readme = fs.readFileSync(path.join(ROOT, template, "README.md"), "utf8");
          const anchors = [...readme.matchAll(/^#{1,6} (.+)$/gm)].map(([, heading]) =>
            heading
              .trim()
              .toLowerCase()
              .replace(/[^\w\- ]/g, "")
              .replaceAll(" ", "-"),
          );
          assert.ok(
            anchors.includes(url.hash.slice(1)),
            `${template}'s README has no heading ${url.hash}`,
          );
        }
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
