/**
 * The table of templates this initializer serves, read from `templates.json`
 * at the package's root, and the flags derived from it.
 *
 * The table is JSON rather than code so that the family's root can read every
 * initializer's table whatever its language: a root test fails when a template
 * of the family is served by no initializer or by more than one, and another
 * holds `create` to the `make create` contract every template forwards.
 *
 * Each create variable is a flag named after it: `NAME` is `--name`,
 * `AUTHOR_EMAIL` is `--author-email`, and a switch such as `DRY_RUN` is
 * `--dry-run`, taking no value. Those are also the flags of a template's own
 * `npm run create`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The initializer package's root: the directory holding `package.json`. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TABLE_FILE = path.join(PACKAGE_ROOT, "templates.json");

/** `AUTHOR_EMAIL` → `--author-email`. */
export function flagOf(variable) {
  return `--${variable.toLowerCase().replaceAll("_", "-")}`;
}

/** The table, with every flag it implies. */
export function loadTable(file = TABLE_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const switches = new Set(raw.create.switches);
  /** Every create variable any template takes, by its flag. */
  const variables = new Map();
  for (const variable of raw.create.shared) variables.set(flagOf(variable), variable);
  for (const template of Object.values(raw.templates)) {
    for (const variable of template.extras) variables.set(flagOf(variable), variable);
  }
  return {
    ecosystem: raw.ecosystem,
    defaultTemplate: raw.default,
    templates: raw.templates,
    required: raw.create.required,
    shared: raw.create.shared,
    switches,
    variables,
    otherEcosystems: raw.otherEcosystems,
    /** The variables one template's `make create` takes, in the order they are forwarded. */
    variablesOf(template) {
      return [...raw.create.shared, ...raw.templates[template].extras];
    },
    /** The command serving another ecosystem's template, or null. The suffix is the family's naming rule. */
    otherEcosystemOf(template) {
      const language = /-([a-z0-9]+)$/.exec(template)?.[1];
      if (language === undefined || language === raw.ecosystem) return null;
      return Object.hasOwn(raw.otherEcosystems, language) ? raw.otherEcosystems[language] : null;
    },
  };
}
