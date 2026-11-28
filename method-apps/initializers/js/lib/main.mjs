/**
 * `create-method-app`: write a template of the family into a directory, make
 * the pristine commit where nothing of the user's is at stake, and run the
 * copy's own gesture: `npm install`, then `npm run create`. Nothing it runs
 * needs `make` or a POSIX shell, so it runs on Windows as elsewhere.
 *
 * The order is the safety story:
 *
 *  1. **A preflight that leaves nothing behind.** The arguments and the
 *     template; Node at or above the template's `engines` floor; npm unless
 *     `--no-create`, and `git` unless `--no-git`; `--method` and
 *     `PIPELEX_API_KEY` unless `--no-create`, the key tested for presence and
 *     never printed; the destination rule; git's reading of the destination,
 *     and an identity when a commit will be made. It writes nothing but a
 *     missing destination inside another repository's work tree, made so that
 *     git reads it as the directory it will be, and the throwaway repository
 *     in which a new repository's identity is read when none shows outside
 *     one, or always under a path another repository ignores, and removes
 *     each before going on. Each failure is a `refused:` verdict naming the fix.
 *  2. **The write**, exclusive, removing what it created when it cannot finish.
 *  3. **Git**: a new repository on `main` outside any work tree or where the
 *     enclosing repository ignores the destination, then the pristine commit;
 *     the commit alone at the root of a repository with no commit yet; nothing
 *     inside another repository's work tree, or with `--no-git`.
 *  4. **`npm install`, then `npm run create`**, unless `--no-create`, streamed
 *     or logged.
 *  5. **The report**: the gesture's warnings, the git outcome, and the verdict
 *     line, last.
 *
 * The initializer never prompts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { HELP_HINT, parseArgs, USAGE } from "./args.mjs";
import { destinationProblem, nearestExisting, readDestination } from "./destination.mjs";
import {
  commitPristine,
  hasIdentity,
  hasIdentityForInit,
  ignoresEveryFile,
  pristineByHand,
  pristineMessage,
  readGit,
  templateOrigin,
} from "./git.mjs";
import {
  createWords,
  extractWarnings,
  npmInvocation,
  npmProblem,
  onPath,
  runCreate,
  stampInstall,
} from "./npm.mjs";
import { decodePack, PackError } from "./pack.mjs";
import { loadTable, PACKAGE_ROOT } from "./templates.mjs";
import { EXIT_OK, inTurn, npmCommand, shellQuote, Verdict } from "./verdict.mjs";
import { DestinationChanged, Interrupted, writeTree } from "./write.mjs";

export const PACKS_DIR = path.join(PACKAGE_ROOT, "templates");

/** This package's own version. */
export function ownVersion() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

/** Compare two `X.Y.Z` versions. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** The template's pack, from the package. */
export function loadPack(packDir, template) {
  const file = path.join(packDir, `${template}.pack`);
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw Verdict.failed(
      "write",
      `this copy of the initializer carries no packed ${template} (${file}); a checkout of the family packs it with npm run pack-templates. Nothing was written.`,
    );
  }
  let pack;
  try {
    pack = decodePack(buffer);
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    throw Verdict.failed("write", `${file} is unreadable: ${error.message}. Nothing was written.`);
  }
  if (pack.template !== template) {
    throw Verdict.failed(
      "write",
      `${file} holds ${pack.template}, not ${template}. Nothing was written.`,
    );
  }
  return pack;
}

/** The `engines.node` floor of a packed template, as `X.Y.Z`. */
function nodeFloor(pack) {
  const manifest = pack.files.find((file) => file.path === "package.json");
  const engines = manifest && JSON.parse(manifest.data.toString("utf8")).engines?.node;
  return /^>=(\d+\.\d+\.\d+)$/.exec(engines ?? "")?.[1] ?? null;
}

/** Everything a run reads from outside, so a test can substitute each. */
export function resolveDeps(deps = {}) {
  const env = deps.env ?? process.env;
  return {
    cwd: deps.cwd ?? process.cwd(),
    env,
    npm: deps.npm ?? npmInvocation(env),
    out: deps.out ?? process.stdout,
    packDir: deps.packDir ?? PACKS_DIR,
    nodeVersion: deps.nodeVersion ?? process.versions.node,
    signal: deps.signal,
    tmpDir: deps.tmpDir ?? os.tmpdir(),
    table: deps.table ?? loadTable(),
  };
}

/** Choose the template, refusing one this initializer does not serve and an option it does not take. */
function chooseTemplate(args, table) {
  const template = args.template ?? table.defaultTemplate;
  if (!Object.hasOwn(table.templates, template)) {
    const other = table.otherEcosystemOf(template);
    if (other?.initializer !== undefined) {
      throw Verdict.refused(
        "other-ecosystem",
        `${template} is not a Node template, and ${other.initializer} serves it: run ${other.initializer} <dir> --template ${template} --method …`,
      );
    }
    if (other?.copyOut !== undefined) {
      throw Verdict.refused(
        "other-ecosystem",
        `${template} is not a Node template, and no initializer serves it yet: copy it out of a release of Pipelex/pipelex-sdk as ${other.copyOut} shows, then run its make create`,
      );
    }
    throw Verdict.refused(
      "unknown-template",
      `${template} is not a template of the family this initializer serves; it serves ${Object.keys(table.templates).join(", ")}`,
    );
  }
  const takes = new Set(table.variablesOf(template));
  for (const [variable, flag] of Object.entries(args.given)) {
    if (!takes.has(variable)) {
      throw Verdict.refused(
        "unknown-option",
        `${flag} is not an option of ${template}'s npm run create`,
      );
    }
  }
  return template;
}

function insideTemplateCheckout(dest, origin) {
  return Verdict.refused(
    "inside-template-checkout",
    `${dest} is inside a checkout of ${origin}, a template's own repository, not a place for a project: choose a directory outside it`,
  );
}

/** The preflight's git reading, as the plan the write follows. */
function planGit(args, dest, found, env) {
  const from = found.kind === "missing" ? nearestExisting(dest) : dest;
  if (args.noGit) {
    // --no-git makes no repository, but a template's own checkout is no place
    // for a project either way, so it is refused whenever git can read it.
    const origin = onPath("git", env) ? templateOrigin({ from, env }) : null;
    if (origin !== null) throw insideTemplateCheckout(dest, origin);
    return {
      commit: false,
      init: false,
      line: "git: --no-git, so nothing was initialized or committed.",
    };
  }
  const reading = readGit({
    dest,
    from,
    destExists: found.kind !== "missing",
    destHasGit: found.kind === "lone-git",
    env,
  });
  let plan;
  switch (reading.kind) {
    case "template-checkout":
      throw insideTemplateCheckout(dest, reading.origin);
    case "unreadable-git":
      throw Verdict.refused(
        "not-empty",
        `${dest} holds a .git that git does not read as a repository; the template is written only into a directory that is missing, empty or holds nothing but a repository's .git`,
      );
    case "root":
      if (reading.history) {
        throw Verdict.refused(
          "repository-has-history",
          `${dest} is a repository with commits whose working tree holds nothing but .git, so every tracked file shows as deleted, and the pristine commit would record that deletion: start in a new directory, or restore the files first`,
        );
      }
      if (reading.staged.length > 0) {
        const shown = reading.staged.slice(0, 3).join(", ");
        const more = reading.staged.length > 3 ? ` and ${reading.staged.length - 3} more` : "";
        throw Verdict.refused(
          "repository-has-staged-files",
          `${dest} is a repository with no commit whose index already holds ${shown}${more}, which the pristine commit would record beside the template: start in a new directory, or empty the index first with git -C ${shellQuote(dest)} rm -r -q --cached .`,
        );
      }
      plan = { commit: true, init: false };
      break;
    case "inside":
      return {
        commit: false,
        init: false,
        inside: reading.toplevel,
        line: `git: ${dest} is inside the work tree of ${reading.toplevel}, so no repository was made and nothing was committed; the project is new files in that repository.`,
      };
    case "ignored":
      // The enclosing repository does not version the destination, so the
      // project gets a repository of its own, as outside every work tree.
      plan = { commit: true, init: true, ignoredBy: reading.toplevel };
      break;
    default:
      plan = { commit: true, init: true };
  }
  const identity = plan.init
    ? hasIdentityForInit({ dest, from, enclosed: reading.kind === "ignored", env })
    : hasIdentity({ cwd: from, env });
  if (!identity) {
    throw Verdict.refused(
      "no-git-identity",
      "git has no identity to make the pristine commit with: set one with git config --global user.name '…' and git config --global user.email '…', or pass --no-git",
    );
  }
  return plan;
}

/**
 * The commands to run next, without --dry-run, quoted for this system's shell
 * and in order: `cd` into the copy, then `npm run create`, after the
 * `npm install` it needs unless `installed`, npm spelled as a person types it
 * there (`npmCommand`).
 */
export function nextCreate(
  dest,
  table,
  template,
  values,
  { installed = false, platform = process.platform } = {},
) {
  const forwarded = { ...values };
  delete forwarded.DRY_RUN;
  const words = createWords(
    table.variablesOf(template),
    forwarded,
    table.switches,
    table.required,
  ).map((word) => shellQuote(word, platform));
  if (values[table.required] === undefined) words.unshift("<method>");
  const npm = npmCommand(platform);
  const create = `${npm} run create -- ${words.join(" ")}`;
  return inTurn([
    `cd ${shellQuote(dest, platform)}`,
    ...(installed ? [] : [`${npm} install`]),
    create,
  ]);
}

/** The commands to run once the app is created: `cd` into it, then `npm run serve`. */
export function nextServe(dest, platform = process.platform) {
  return inTurn([`cd ${shellQuote(dest, platform)}`, `${npmCommand(platform)} run serve`]);
}

async function create(argv, d, say, state) {
  const { table } = d;
  const args = parseArgs(argv, table);
  if (args.help || args.version) return { help: args.help, version: args.version };
  if (args.dir === undefined || args.dir.trim() === "") {
    throw Verdict.refused(
      "usage",
      `no directory given: name the one to create the project in ${HELP_HINT}`,
    );
  }
  const template = chooseTemplate(args, table);
  const pack = loadPack(d.packDir, template);

  const floor = nodeFloor(pack);
  if (floor !== null && compareVersions(d.nodeVersion, floor) < 0) {
    throw Verdict.refused(
      "node-too-old",
      `${template} needs Node ${floor} or later, and this is Node ${d.nodeVersion}: switch to a newer Node, then run this again`,
    );
  }
  const missing = [];
  if (!args.noCreate) {
    const npmMissing = npmProblem(d.npm, d.env);
    if (npmMissing !== null) missing.push(npmMissing);
  }
  if (!args.noGit && !onPath("git", d.env)) {
    missing.push("git is not on the PATH: install it, or pass --no-git to make no repository");
  }
  if (missing.length > 0) throw Verdict.refused("missing-tool", missing.join("; "));
  if (!args.noCreate && args.values[table.required] === undefined) {
    throw Verdict.refused(
      "no-method",
      "pass --method with a .mthds file or a directory of them, a catalog id (mt_…, mt_…@<version> or mt_…@draft) or a package address (github.com/owner/repo[/package][@tag]), or --no-create to write the template alone",
    );
  }
  if (!args.noCreate && !d.env.PIPELEX_API_KEY?.trim()) {
    throw Verdict.refused(
      "no-key",
      "PIPELEX_API_KEY is not set: export it in this shell for npm run create, which never copies it into the project, or pass --no-create and write .env.local yourself before running npm run create",
    );
  }

  const dest = path.resolve(d.cwd, args.dir);
  let found;
  try {
    found = readDestination(dest);
  } catch (error) {
    // A file where a directory of the path should be, or a directory that
    // cannot be read: the preflight stops here, and nothing was written.
    if (typeof error?.code !== "string") throw error;
    throw Verdict.refused(
      "unusable-destination",
      `${dest} cannot be read (${error.message}): choose a directory whose path is made of directories you can read`,
    );
  }
  const problem = destinationProblem(dest, found);
  if (problem !== null) throw Verdict.refused("not-empty", problem);
  const git = planGit(args, dest, found, d.env);

  const values = { ...args.values };
  if (values[table.required] !== undefined) {
    const candidate = path.resolve(d.cwd, values[table.required]);
    if (fs.existsSync(candidate)) values[table.required] = candidate;
  }

  // ── The write ──
  if (d.signal?.aborted) {
    throw Verdict.failed(
      "write",
      `${d.signal.reason ?? "a signal"} interrupted the run before anything was written`,
    );
  }
  say(`create-method-app: writing ${template} ${pack.version} (${pack.source}) into ${dest}`);
  try {
    await writeTree(dest, pack.files, { signal: d.signal });
  } catch (error) {
    const left = error.left?.length
      ? ` It could not remove ${error.left.join(", ")}, which it had created.`
      : "";
    if (error instanceof DestinationChanged) {
      throw Verdict.refused(
        "not-empty",
        `${destinationProblem(dest, error.found)}, found when it was read again before the write.${left}`,
      );
    }
    const cause =
      error instanceof Interrupted ? error.message : `the write failed: ${error.message}`;
    throw Verdict.failed("write", `${cause}; what it had created was removed.${left}`);
  }
  say(`create-method-app: wrote ${pack.files.length} files`);

  // ── Git ──
  state.phase = "commit";
  let gitLine = git.line;
  if (git.inside !== undefined && ignoresEveryFile({ dest, env: d.env })) {
    gitLine = `git: ${dest} is inside the work tree of ${git.inside}, which ignores every file of the project but not its directory, so no repository was made and the project is under no version control.`;
  }
  if (git.commit) {
    const message = pristineMessage(pack);
    try {
      const sha = commitPristine({
        dest,
        init: git.init,
        paths: pack.files.map((file) => file.path),
        message,
        env: d.env,
      });
      const committed = `${sha.slice(0, 12)}, "${message}"`;
      if (git.ignoredBy !== undefined) {
        gitLine = `git: ${git.ignoredBy} ignores ${dest}, so the project got a repository of its own: made on main, with the template committed as ${committed}.`;
      } else if (git.init) {
        gitLine = `git: made a repository on main and committed the template as ${committed}.`;
      } else {
        gitLine = `git: committed the template as the repository's first commit, ${committed}.`;
      }
    } catch (error) {
      for (const line of error.message.split("\n")) say(line);
      throw Verdict.failed(
        "commit",
        `git refused the pristine commit (above). The copy stands in ${dest}: commit it with ${inTurn(pristineByHand({ dest, init: git.init, message, quote: shellQuote }))}, then run ${nextCreate(dest, table, template, values)}`,
      );
    }
  }

  if (args.noCreate) {
    say(gitLine);
    return { line: `copied ${dest}; next: ${nextCreate(dest, table, template, values)}` };
  }

  // ── npm install, then npm run create ──
  state.phase = "create";
  const stands = git.commit ? "The copy and its commit stand" : "The copy stands";
  if (d.signal?.aborted) {
    say(gitLine);
    throw Verdict.failed(
      "create",
      `${d.signal.reason ?? "a signal"} interrupted the run before npm install started. ${stands} in ${dest}; run ${nextCreate(dest, table, template, values)}`,
    );
  }
  let logFile;
  if (args.quiet) {
    logFile = path.join(fs.mkdtempSync(path.join(d.tmpDir, "create-method-app-")), "create.log");
    say(
      `create-method-app: running npm install and npm run create in ${dest}; their output goes to ${logFile}`,
    );
  } else {
    say(`create-method-app: running npm install and npm run create in ${dest}\n`);
  }
  const words = createWords(table.variablesOf(template), values, table.switches, table.required);
  const result = await runCreate(words, {
    npm: d.npm,
    cwd: dest,
    env: d.env,
    out: d.out,
    logFile,
    signal: d.signal,
  });

  const warnings = extractWarnings(result.output);
  say("");
  say(warnings.length > 0 ? "warnings from npm run create:" : "warnings from npm run create: none");
  for (const warning of warnings) say(`  ${warning}`);
  say(gitLine);
  if (result.error?.stuck) {
    throw Verdict.failed(
      "create",
      `${d.signal?.reason ?? "a signal"} interrupted npm ${result.step}, and ${result.error.message}: stop it yourself. ${stands} in ${dest}.`,
    );
  }
  if (result.error !== null) {
    throw Verdict.failed(
      "create",
      `npm could not be run: ${result.error.message}. ${stands} in ${dest}.`,
    );
  }
  const interrupted = d.signal?.aborted ? (d.signal.reason ?? "a signal") : null;
  if (result.status !== 0) {
    // Elsewhere a stopped step ends by a signal; on Windows, which has none,
    // it ends with a status, and the interruption is what stopped it.
    let how = `exited ${result.status}`;
    if (result.status === null) how = `was stopped by ${result.signal}`;
    else if (interrupted !== null) how = `was stopped by ${interrupted}`;
    const said = args.quiet ? `the end of its log, ${logFile},` : "its own message above";
    if (result.step === "install") {
      throw Verdict.failed(
        "create",
        `npm install ${how}, so npm run create did not start. ${stands} in ${dest}, and ${said} says why; once that is fixed, run ${nextCreate(dest, table, template, values)}`,
      );
    }
    throw Verdict.failed(
      "create",
      `npm run create ${how}. ${stands} in ${dest}, and ${said} says what to run next: a refusal before it wrote anything can be fixed and run again, and a failure after it cannot.`,
    );
  }
  if (result.step === "install") {
    // The install succeeded, and an interruption came before the gesture.
    throw Verdict.failed(
      "create",
      `${interrupted ?? "a signal"} interrupted the run before npm run create started. ${stands} in ${dest}, its dependencies installed; run ${nextCreate(dest, table, template, values, { installed: true })}`,
    );
  }
  if (values.DRY_RUN) {
    return {
      line: `copied ${dest} (npm run create --dry-run changed nothing); next: ${nextCreate(dest, table, template, values, { installed: true })}`,
    };
  }
  stampInstall(dest);
  return { line: `created ${dest}; next: ${nextServe(dest)}` };
}

/**
 * The whole run, verdict included. Returns the exit code; prints the verdict
 * last. An error nothing anticipated becomes the verdict of the phase it
 * happened in.
 */
export async function run(argv, deps = {}) {
  const d = resolveDeps(deps);
  const say = (line) => d.out.write(`${line}\n`);
  const state = { phase: "write" };
  let verdict;
  try {
    const done = await create(argv, d, say, state);
    if (done.help) {
      say(
        `create-method-app ${ownVersion()} — start a Pipelex method app from the family's template.\n\n${USAGE}`,
      );
      return EXIT_OK;
    }
    if (done.version) {
      say(ownVersion());
      return EXIT_OK;
    }
    say(done.line);
    return EXIT_OK;
  } catch (error) {
    verdict =
      error instanceof Verdict
        ? error
        : Verdict.failed(state.phase, `${error instanceof Error ? error.message : String(error)}`);
  }
  say(verdict.line);
  return verdict.exitCode;
}
