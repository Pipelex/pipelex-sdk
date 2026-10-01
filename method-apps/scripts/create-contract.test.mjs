// The `make create` contract. The scaffold skill (`skills/pipelex-scaffold` in
// pipelex-plugins) copies one template out and runs its `make create` with the
// same variables whichever template it copied, so every template must forward
// each of them to its gesture the same way: the same flag, the value exactly as
// typed, nothing for a variable left blank or only exported by the shell. This
// runs `make -n create` in every template and compares what each one forwards.
// Run with `node --test` — the root has no dependencies.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { EXTRAS, REQUIRED, SHARED, SWITCHES } from "./create-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A value that shows whether it reached the gesture exactly as typed. */
const valueOf = (name) => (SWITCHES.has(name) ? "1" : `${name} Bob's "$5" \`x\``);

const makefile = fs.readFileSync(path.join(ROOT, "Makefile"), "utf8");
const TEMPLATES = /^TEMPLATES := (.+)$/m.exec(makefile)[1].trim().split(/\s+/);

/** Split a shell line into words, undoing its quoting. Enough for what make prints. */
function words(line) {
  const out = [];
  let word = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated quote in: ${line}`);
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= "";
      for (i += 1; i < line.length && line[i] !== '"'; i += 1) {
        if (line[i] === "\\" && /["\\$`]/.test(line[i + 1] ?? "")) i += 1;
        word += line[i];
      }
    } else if (c === "\\") {
      word = (word ?? "") + (line[i + 1] ?? "");
      i += 1;
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) out.push(word);
  return out;
}

/** The environment of every run, without anything that would reach make as a request. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ["MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES"]) delete env[key];
  for (const names of [SHARED, ...Object.values(EXTRAS)]) {
    for (const name of names) delete env[name];
  }
  return { ...env, ...extra };
}

/** The words of the command `make -n create` prints to run the gesture: the line carrying METHOD. */
function invocation(template, vars, env = cleanEnv()) {
  const args = Object.entries(vars).map(([name, value]) => `${name}=${value}`);
  const printed = execFileSync(
    "make",
    ["-n", "--no-print-directory", "-C", path.join(ROOT, template), "create", ...args],
    { encoding: "utf8", env },
  );
  const lines = printed
    .split("\n")
    .filter(Boolean)
    .map(words)
    .filter((w) => w.includes(valueOf(REQUIRED)));
  assert.equal(lines.length, 1, `${template}: expected one line forwarding ${REQUIRED}`);
  return lines[0];
}

/** What a run adds to the baseline: the words between their common head and tail. */
function added(baseline, run) {
  let head = 0;
  while (head < baseline.length && baseline[head] === run[head]) head += 1;
  let tail = 0;
  while (
    tail < baseline.length - head &&
    baseline[baseline.length - 1 - tail] === run[run.length - 1 - tail]
  ) {
    tail += 1;
  }
  return run.slice(head, run.length - tail);
}

/** How a template forwards each variable: its words with the value written `{value}`. */
function forwarding(template, names) {
  const base = { [REQUIRED]: valueOf(REQUIRED) };
  const baseline = invocation(template, base);
  const result = {};
  const at = baseline.indexOf(valueOf(REQUIRED));
  result[REQUIRED] = /^--[a-z]/.test(baseline[at - 1] ?? "")
    ? `${baseline[at - 1]} {value}`
    : "{value}, positional";
  for (const name of names) {
    if (name === REQUIRED) continue;
    const extra = added(baseline, invocation(template, { ...base, [name]: valueOf(name) }));
    result[name] = extra.map((w) => (w === valueOf(name) ? "{value}" : w)).join(" ");
  }
  return result;
}

/** The variables a template's `create` recipe reads, from its Makefile. */
function recipeVariables(template) {
  const text = fs.readFileSync(path.join(ROOT, template, "Makefile"), "utf8");
  const rule = /^create:.*\n((?:\t.*\n)*)/m.exec(text);
  assert.ok(rule, `${template}: no create rule`);
  const names = new Set();
  for (const m of rule[1].matchAll(
    /\$\((?:call (?:opt|flag|given|require),|value )([A-Z][A-Z0-9_]*)/g,
  )) {
    names.add(m[1]);
  }
  return names;
}

describe("make create", () => {
  const forwarded = Object.fromEntries(
    TEMPLATES.map((t) => [t, forwarding(t, [...SHARED, ...(EXTRAS[t] ?? [])])]),
  );

  it("forwards every shared variable in every template", () => {
    for (const template of TEMPLATES) {
      for (const name of SHARED) {
        assert.ok(forwarded[template][name], `${template} does not forward ${name}`);
      }
    }
  });

  it("forwards each shared variable the same way in every template", () => {
    const [reference, ...others] = TEMPLATES;
    for (const template of others) {
      for (const name of SHARED) {
        assert.equal(
          forwarded[template][name],
          forwarded[reference][name],
          `${name}: ${template} forwards "${forwarded[template][name]}", ${reference} forwards "${forwarded[reference][name]}"`,
        );
      }
    }
  });

  it("forwards a value as one word, exactly as typed, and a switch as a flag alone", () => {
    for (const template of TEMPLATES) {
      for (const [name, how] of Object.entries(forwarded[template])) {
        if (name === REQUIRED) continue;
        const expected = SWITCHES.has(name) ? /^--[a-z][a-z-]*$/ : /^--[a-z][a-z-]* \{value\}$/;
        assert.match(how, expected, `${template}: ${name} is forwarded as "${how}"`);
      }
    }
  });

  it("forwards each declared extra, and reads no variable that is neither shared nor declared", () => {
    for (const template of TEMPLATES) {
      for (const name of EXTRAS[template] ?? []) {
        assert.ok(forwarded[template][name], `${template} does not forward its extra ${name}`);
      }
      const known = new Set([...SHARED, ...(EXTRAS[template] ?? [])]);
      for (const name of recipeVariables(template)) {
        assert.ok(
          known.has(name),
          `${template}'s create reads ${name}: add it to SHARED in scripts/create-contract.mjs if the scaffold passes it to every template, or to EXTRAS["${template}"] there`,
        );
      }
    }
  });

  it("forwards nothing for a variable left blank or only exported by the shell", () => {
    const optional = SHARED.filter((n) => n !== REQUIRED);
    for (const template of TEMPLATES) {
      const base = { [REQUIRED]: valueOf(REQUIRED) };
      const baseline = invocation(template, base);
      const blanks = Object.fromEntries(optional.map((n) => [n, ""]));
      assert.deepEqual(invocation(template, { ...base, ...blanks }), baseline, template);
      const exported = cleanEnv(Object.fromEntries(optional.map((n) => [n, valueOf(n)])));
      assert.deepEqual(invocation(template, base, exported), baseline, template);
      const off = invocation(template, {
        ...base,
        ...Object.fromEntries([...SWITCHES].map((n) => [n, "0"])),
      });
      assert.deepEqual(off, baseline, `${template}: a switch given as 0`);
    }
  });
});
