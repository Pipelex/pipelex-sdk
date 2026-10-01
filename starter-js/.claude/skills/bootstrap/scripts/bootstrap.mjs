#!/usr/bin/env node
/**
 * Rename the pipelex-starter-js template placeholders to a real project.
 *
 * This is the deterministic engine behind the `/bootstrap` skill. It does the
 * mechanical, error-prone part — substituting the template name in its two
 * spellings across config, docs, UI and skills, resetting the version and
 * changelog, and applying the license choice — so the skill (and the human)
 * can focus on collecting good inputs and verifying the result.
 *
 * Why a script instead of a pile of Edit calls: the same name appears in two
 * forms (npm slug / display title) scattered across many files, and the
 * license choice touches several files at once (LICENSE, package.json, the
 * README license line — and the changelog reset adds another). Doing that by
 * hand once is fine; doing it reliably every time someone clones the template
 * is exactly what a script is for. It supports --dry-run, and its transforms
 * are exported for the anchor-drift test that lives next to it.
 *
 * The script only transforms files. It does NOT touch git, run `npm install`,
 * run the checks, or remove the bootstrap skill — the SKILL.md orchestrates
 * those so each step stays reviewable and the script stays a pure transform.
 * Re-running on an already-bootstrapped repo requires --force: the transforms
 * only know the template's tokens, so re-runs are not fully idempotent (the
 * changelog is reset again, and a license-type change doesn't restore wording
 * the first run already replaced). Zero dependencies; runs on the same
 * Node 22+ the project needs.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The template's placeholders, in their two spellings. Everything the script
// does is ultimately "turn these into the user's chosen name".
export const TEMPLATE_NAME = "pipelex-starter-js"; // npm package name / repo slug
export const TEMPLATE_TITLE = "Pipelex Starter"; // human-facing display name (page H1, <title>)

// Fresh projects restart here — package.json and CHANGELOG.md must agree.
export const RESET_VERSION = "0.1.0";

// The two long-form description placeholders. README and CLAUDE.md carry the
// same sentence modulo the leading article, so anchor each exactly.
const README_DESCRIPTION =
  "A minimal Next.js 16 starter that calls the [Pipelex](https://pipelex.com) API via the [`@pipelex/sdk`](https://www.npmjs.com/package/@pipelex/sdk) SDK to run AI methods (`.mthds` bundles) from a TypeScript app.";
const CLAUDE_DESCRIPTION =
  "Minimal Next.js 16 starter that calls the [Pipelex](https://pipelex.com) API via the [`@pipelex/sdk`](https://www.npmjs.com/package/@pipelex/sdk) SDK to run AI methods (`.mthds` bundles) from a TypeScript app.";
const LAYOUT_DESCRIPTION = "Minimal Next.js app calling Pipelex via the @pipelex/sdk SDK.";

// CLAUDE.md's template-only charter paragraph, stripped by --clean.
const CHARTER_MARKER = "This repo is a **reference template**.";

// npm package name rules (legacy-strict subset: new packages must be lowercase
// URL-safe, optionally scoped). Anything else breaks `npm install` later.
const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.error(`warning: ${message}`);
}

export function validateName(name) {
  if (!NAME_RE.test(name) || name.length > 214) {
    fail(
      `invalid package name ${JSON.stringify(name)}: use lowercase letters, digits, '-', '.', '_',` +
        ` optionally scoped (e.g. 'invoice-extractor' or '@acme/invoice-extractor').`,
    );
  }
}

/** Today's date in the machine's local timezone (toISOString would give UTC,
 * which can lag a day behind for anyone east of Greenwich). */
function localDate() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function titleFromName(name) {
  const bare = name.includes("/") ? name.split("/")[1] : name;
  return bare
    .split(/[-._]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// License handling
// ---------------------------------------------------------------------------

const PROPRIETARY_LICENSE = `Copyright (c) {year} {holder}

All rights reserved.

This software and its associated documentation (the "Software") are the
proprietary and confidential property of {holder}. Unauthorized copying,
distribution, modification, public display, or use of the Software, in whole or
in part, via any medium, is strictly prohibited without the express prior
written permission of {holder}.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
`;

const OTHER_LICENSE = `Copyright (c) {year} {holder}

This project is licensed under the {spdx} license.

Replace this file with the full text of the {spdx} license — you can obtain it
from https://spdx.org/licenses/{spdx}.html
`;

/**
 * Resolve the license choice into the forms the call-sites need: `kind` drives
 * the LICENSE body, `npmField` is the value for package.json's `license` field
 * (npm's convention for closed-source is the literal "UNLICENSED"), and
 * `holder`/`year` fill the copyright notice.
 */
export function resolveLicense(value, holder, year) {
  const norm = (value || "mit").trim().toLowerCase();
  if (norm === "" || norm === "mit") {
    return { kind: "mit", npmField: "MIT", holder, year };
  }
  if (["proprietary", "all-rights-reserved", "all rights reserved", "unlicensed"].includes(norm)) {
    return { kind: "proprietary", npmField: "UNLICENSED", holder, year };
  }
  // Anything else is treated as a raw SPDX id (e.g. Apache-2.0). We set the
  // field and write a stub, but can't author arbitrary license text for them.
  return { kind: "other", npmField: value.trim(), holder, year };
}

// ---------------------------------------------------------------------------
// File transforms
// ---------------------------------------------------------------------------

/** Escape a value for a double-quoted JS/TSX string literal. */
export function jsString(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/** Wrap a user value for use as a replace()/replaceAll() replacement: passed
 * as a string it would expand $-patterns ($&, $', $$, ...) and silently
 * corrupt the output; a callback is always taken literally. */
function literally(value) {
  return () => value;
}

/** Substitute both spellings of the template name with the new ones. */
export function applyNameTokens(text, names) {
  return text
    .replaceAll(TEMPLATE_NAME, literally(names.name))
    .replaceAll(TEMPLATE_TITLE, literally(names.title));
}

/**
 * Soften the template's self-references in prose ("the starter ...") — these
 * appear in user-facing error messages (errors.ts), a Makefile comment, e2e
 * spec comments, and "this starter" asides in CLAUDE.md and the release
 * skill. A bootstrapped project is not a starter, and the errors.ts strings
 * are shown to the app's end users at runtime.
 */
export function applyStarterProse(text) {
  return text
    .replaceAll('"I just cloned the starter"', '"I just cloned the repo"')
    .replaceAll("The starter", "This app")
    .replaceAll("the starter", "this app")
    .replaceAll("This starter", "This app")
    .replaceAll("this starter", "this app");
}

/**
 * package.json is structured data, so transform it as data rather than text.
 * New keys (license / author / repository) are inserted right after
 * `description` to keep the file tidy, since plain assignment would append
 * them at the bottom.
 */
export function transformPackageJson(text, names, opts) {
  const pkg = JSON.parse(text);
  const inserted = {};
  inserted.license = opts.lic.npmField;
  if (opts.authorName && opts.authorEmail) {
    inserted.author = `${opts.authorName} <${opts.authorEmail}>`;
  } else if (opts.authorName) {
    inserted.author = opts.authorName;
  }
  if (opts.repoUrl) {
    inserted.repository = opts.repoUrl;
  }

  const out = {};
  for (const [key, value] of Object.entries(pkg)) {
    if (key in inserted) continue; // re-inserted in order below
    out[key] = value;
    if (key === "description") {
      Object.assign(out, inserted);
    }
  }
  out.name = names.name;
  out.version = RESET_VERSION; // fresh project, fresh semver — CHANGELOG.md is reset to match
  out.description = opts.description;
  return JSON.stringify(out, null, 2) + "\n";
}

export function transformReadme(text, names, opts) {
  if (text.includes(README_DESCRIPTION)) {
    text = text.replace(README_DESCRIPTION, literally(opts.description));
  } else {
    warn("README.md: template description paragraph not found; left as-is.");
  }

  // License line: reflect the chosen license in the README's License section.
  if (opts.lic.kind === "proprietary") {
    const anchor =
      "This project is licensed under the [MIT license](LICENSE). Runtime dependencies are distributed under their own licenses via npm.";
    if (text.includes(anchor)) {
      text = text.replace(
        anchor,
        "This project is proprietary — all rights reserved. See the [LICENSE](LICENSE) file. Runtime dependencies are distributed under their own licenses via npm.",
      );
    } else {
      warn("README.md: MIT license line not found; update the License section manually.");
    }
  } else if (opts.lic.kind === "other") {
    if (text.includes("[MIT license](LICENSE)")) {
      text = text.replace(
        "[MIT license](LICENSE)",
        literally(`[${opts.lic.npmField} license](LICENSE)`),
      );
    } else {
      warn("README.md: MIT license link not found; update the License section manually.");
    }
  }

  return applyNameTokens(text, names);
}

/**
 * Remove CLAUDE.md's template-only paragraph (the "reference template" charter)
 * when --clean is passed: a bootstrapped project is no longer a template, and
 * keeping the paragraph would steer every future Claude session toward
 * template-maintainer behavior instead of building the user's app.
 */
export function stripTemplateParagraph(text) {
  const start = text.indexOf(CHARTER_MARKER);
  if (start === -1) {
    warn("CLAUDE.md: template charter paragraph not found (already stripped?); skipped.");
    return text;
  }
  // Match the paragraph end on LF or CRLF (Windows clones with core.autocrlf
  // check out CRLF working trees, where indexOf("\n\n") would miss).
  const end = /\r?\n\r?\n/.exec(text.slice(start));
  if (!end) {
    warn("CLAUDE.md: template charter paragraph has no end boundary; left as-is.");
    return text;
  }
  return text.slice(0, start) + text.slice(start + end.index + end[0].length);
}

export function transformClaudeMd(text, names, opts) {
  text = applyStarterProse(text);
  if (text.includes(CLAUDE_DESCRIPTION)) {
    text = text.replace(CLAUDE_DESCRIPTION, literally(opts.description));
  } else {
    warn("CLAUDE.md: template description line not found; left as-is.");
  }
  if (opts.clean) {
    text = stripTemplateParagraph(text);
  }
  return applyNameTokens(text, names);
}

export function transformLayout(text, names, opts) {
  const descAnchor = `description: "${LAYOUT_DESCRIPTION}"`;
  if (text.includes(descAnchor)) {
    text = text.replace(descAnchor, literally(`description: "${jsString(opts.description)}"`));
  } else {
    warn("src/app/layout.tsx: template metadata description not found; left as-is.");
  }
  const titleAnchor = `"${TEMPLATE_TITLE}"`;
  if (text.includes(titleAnchor)) {
    text = text.replaceAll(titleAnchor, literally(`"${jsString(names.title)}"`));
  } else {
    warn("src/app/layout.tsx: template title not found; left as-is.");
  }
  return text;
}

/**
 * page.tsx renders the title as JSX text, so emit it as a string-literal
 * expression container ({"..."}). Raw substitution would let JSX-significant
 * characters break the build (<, {), trip eslint's no-unescaped-entities
 * (', "), or even evaluate as an expression in a server component.
 */
export function transformPage(text, names) {
  const anchor = `>${TEMPLATE_TITLE}<`;
  if (text.includes(anchor)) {
    text = text.replaceAll(anchor, literally(`>{${JSON.stringify(names.title)}}<`));
  } else {
    warn("src/app/page.tsx: template title heading not found; left as-is.");
  }
  return text.replaceAll(TEMPLATE_NAME, literally(names.name));
}

export function transformLicense(text, opts) {
  const lic = opts.lic;
  if (lic.kind === "mit") {
    if (!text.includes("Permission is hereby granted")) {
      warn(
        "LICENSE does not look like the MIT text (license changed on a previous run?) —" +
          " package.json will say MIT; fix LICENSE manually.",
      );
    }
    // Keep the MIT text; only refresh the copyright line when we have a
    // holder to put there (don't silently bump the template holder's year).
    if (lic.holder) {
      const line = /Copyright \(c\) \d{4} .*/;
      if (line.test(text)) {
        text = text.replace(line, literally(`Copyright (c) ${lic.year} ${lic.holder}`));
      } else {
        warn("LICENSE: copyright line not found; left as-is.");
      }
    } else {
      warn("LICENSE copyright line left untouched — pass --license-holder to claim it.");
    }
    return text;
  }
  const holder = lic.holder || "<COPYRIGHT HOLDER>";
  if (!lic.holder) {
    warn("no --license-holder given; LICENSE gets a placeholder holder.");
  }
  if (lic.kind === "proprietary") {
    return PROPRIETARY_LICENSE.replaceAll("{year}", literally(String(lic.year))).replaceAll(
      "{holder}",
      literally(holder),
    );
  }
  warn(
    `LICENSE becomes a stub for '${lic.npmField}' (used verbatim — SPDX ids are case-sensitive,` +
      ` e.g. Apache-2.0). Replace it with the full license text.`,
  );
  return OTHER_LICENSE.replaceAll("{year}", literally(String(lic.year)))
    .replaceAll("{holder}", literally(holder))
    .replaceAll("{spdx}", literally(lic.npmField));
}

/**
 * The template's changelog chronicles the template, not the user's project.
 * Start the new project's history at the reset version (matching the
 * package.json reset) in the same `## [vX.Y.Z] - date` format the release
 * skill expects.
 */
export function resetChangelog(_text, opts) {
  return `# Changelog

## [v${RESET_VERSION}] - ${opts.date}

### Added

- Initial project, bootstrapped from the [pipelex-starter-js](https://github.com/Pipelex/pipelex-starter-js) template
`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export const TARGETS = [
  { rel: "package.json", transform: transformPackageJson },
  { rel: "README.md", transform: transformReadme },
  { rel: "CLAUDE.md", transform: transformClaudeMd },
  // AGENTS.md carries the template name in its heading; a plain token pass is
  // enough — its rules are generic to any project built from this template.
  { rel: "AGENTS.md", transform: applyNameTokens },
  { rel: "LICENSE", transform: (text, _names, opts) => transformLicense(text, opts) },
  { rel: "CHANGELOG.md", transform: (text, _names, opts) => resetChangelog(text, opts) },
  { rel: "src/app/layout.tsx", transform: transformLayout },
  { rel: "src/app/page.tsx", transform: transformPage },
  {
    rel: ".claude/skills/release/SKILL.md",
    transform: (text, names) => applyNameTokens(applyStarterProse(text), names),
  },
  { rel: "src/lib/errors.ts", transform: (text) => applyStarterProse(text) },
  { rel: "Makefile", transform: (text) => applyStarterProse(text) },
];

export function run(root, names, opts) {
  // Guard: confirm this actually is the unbootstrapped template before we
  // start rewriting things — in a wrong directory or an already-bootstrapped
  // repo, proceeding would clobber that project's version, changelog and
  // identity. --force is the explicit opt-in for confirmed re-runs.
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fail(`no package.json found in ${root} — run this from the project root.`);
  }
  const pkgText = fs.readFileSync(pkgPath, "utf8");
  if (!pkgText.includes(`"name": "${TEMPLATE_NAME}"`)) {
    if (!opts.force) {
      fail(
        `package.json does not contain "name": "${TEMPLATE_NAME}" — this doesn't look like the` +
          ` un-bootstrapped template. Pass --force only if you really mean to re-bootstrap this` +
          ` repo (the changelog will be reset again).`,
      );
    }
    warn(`package.json does not contain "name": "${TEMPLATE_NAME}"; proceeding (--force).`);
  }

  console.log(`Bootstrapping template -> ${JSON.stringify(names.title)}`);
  console.log(`  name=${names.name}  title=${names.title}  license=${opts.lic.npmField}`);
  if (opts.dryRun) {
    console.log("  (dry run — no files will be modified)");
  }
  console.log("");
  console.log("Edits:");

  // Transform everything first, write second: a transform that throws (e.g.
  // on a hand-mangled package.json) must not leave a half-applied tree.
  const edits = [];
  for (const target of TARGETS) {
    const filePath = path.join(root, target.rel);
    if (!fs.existsSync(filePath)) {
      warn(`${target.rel}: not found, skipped.`);
      continue;
    }
    const original = fs.readFileSync(filePath, "utf8");
    const updated = target.transform(original, names, opts);
    if (updated === original) continue;
    edits.push({ rel: target.rel, filePath, updated });
  }
  for (const edit of edits) {
    if (opts.dryRun) {
      console.log(`  edit    ${edit.rel}`);
    } else {
      fs.writeFileSync(edit.filePath, edit.updated, "utf8");
      console.log(`  edited  ${edit.rel}`);
    }
  }
  if (edits.length === 0) {
    console.log("  (no content changes)");
  }
  console.log("");
  console.log(`Done. ${edits.length} file(s) ${opts.dryRun ? "would be " : ""}edited.`);
  if (!opts.dryRun) {
    console.log(
      "\nNext: sync the lock file (npm ci in CI validates its name/version) and run the gates:",
    );
    console.log("  npm install --package-lock-only && make all");
    console.log("Then review with `git status` and `git diff` before committing.");
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FLAGS = {
  "--name": "name",
  "--title": "title",
  "--description": "description",
  "--author-name": "authorName",
  "--author-email": "authorEmail",
  "--repo-url": "repoUrl",
  "--license": "license",
  "--license-holder": "licenseHolder",
  "--license-year": "licenseYear",
  "--root": "root",
};
const SWITCHES = { "--clean": "clean", "--dry-run": "dryRun", "--force": "force" };

export function parseArgs(argv) {
  const args = { clean: false, dryRun: false, force: false, root: "." };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in SWITCHES) {
      args[SWITCHES[arg]] = true;
    } else if (arg in FLAGS) {
      const value = argv[i + 1];
      // A value starting with "--" almost certainly means the real value was
      // dropped and the next flag would be swallowed (e.g. --dry-run becoming
      // a description — and the run turning real). Fail loudly instead.
      if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
      args[FLAGS[arg]] = value;
      i += 1;
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  if (!args.name) fail("--name is required (npm package name, e.g. 'invoice-extractor')");
  if (!args.description) fail("--description is required (one-line project description)");
  return args;
}

export function main(argv) {
  const args = parseArgs(argv);
  const name = args.name.trim();
  validateName(name);
  const title = (args.title || titleFromName(name)).trim();
  if (!title) fail("--title is empty");
  const description = args.description.trim();
  if (!description) fail("--description is empty");
  const names = { name, title };

  const rawYear = (args.licenseYear || "").trim();
  if (args.licenseYear !== undefined && !/^\d{4}$/.test(rawYear)) {
    fail(`invalid --license-year ${JSON.stringify(args.licenseYear)} (expected e.g. 2026)`);
  }
  const year = rawYear ? Number.parseInt(rawYear, 10) : new Date().getFullYear();
  const lic = resolveLicense(args.license, (args.licenseHolder || "").trim() || null, year);

  const authorName = (args.authorName || "").trim() || null;
  const authorEmail = (args.authorEmail || "").trim() || null;
  // A bare "<email>" author field is malformed npm metadata; name-only is fine.
  if (authorEmail && !authorName) {
    fail("--author-email given without --author-name — provide the author's name too.");
  }

  const opts = {
    description,
    authorName,
    authorEmail,
    repoUrl: (args.repoUrl || "").trim().replace(/\/+$/, "") || null,
    lic,
    clean: args.clean,
    force: args.force,
    dryRun: args.dryRun,
    date: localDate(),
  };
  run(path.resolve(args.root), names, opts);
}

// Only execute when invoked directly (`node bootstrap.mjs ...`) — importing
// the module (e.g. from the anchor-drift test) must not run the CLI.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
