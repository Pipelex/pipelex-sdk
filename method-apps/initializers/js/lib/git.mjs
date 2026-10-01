/**
 * Git, read before anything is written, and one outcome for each case:
 *
 *   inside no work tree                    → a new repository on main, then the pristine commit
 *   the root of a repository with no commit → the pristine commit, its first
 *     … whose index already holds an entry → refused: repository-has-staged-files
 *   the root of a repository with history  → refused: repository-has-history
 *   where another repository ignores it    → a new repository on main, then the pristine commit
 *   inside another repository's work tree  → no repository and no commit
 *   inside a checkout of a template        → refused: inside-template-checkout
 *
 * A directory holding only `.git` whose repository has commits is one whose
 * working tree shows every tracked file deleted, and landing the template on it
 * would fold that deletion into the commit. One with no commit can still hold
 * staged entries, a file added and then deleted from the directory, and the
 * pristine commit would record them beside the template. A repository planted
 * inside another one's work tree makes the enclosing one fail `git add -A`
 * until the nested one has a commit, and then see an embedded repository, so
 * the project becomes new files in the enclosing repository instead, as
 * `create-next-app` does. A path the enclosing repository ignores is the
 * exception: a repository nested there is as invisible to it as plain files
 * would be, and without one the project would be under no version control at
 * all, so it gets a repository of its own, as outside every work tree. What
 * counts is the directory: one the enclosing repository does not ignore gets
 * no repository even when every file in it is ignored, as under a `*` that a
 * later pattern lifts from every directory, since a repository there would
 * still show in the enclosing one's status, and the report then says the
 * project is under no version control.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The repositories whose checkouts are templates, read from `origin`: the
 * family's own, and the starters. Running the initializer inside one would
 * make a project of a template's checkout.
 */
export const TEMPLATE_ORIGINS =
  /[/:](pipelex\/(pipelex-method-apps|pipelex-starter-js|pipelex-starter-python)|mthds-ai\/mthds-starter-js)(\.git)?\/?$/i;

/**
 * Variables that point git at a repository other than the one it would find
 * from the directory it runs in. A hook or a wrapper can leave them set, and
 * the reading must be about the destination.
 */
const REDIRECTING = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

export function gitEnv(env) {
  const clean = { ...env };
  for (const name of REDIRECTING) delete clean[name];
  return clean;
}

/** Run git, returning its status and trimmed output. */
export function git(args, { cwd, env }) {
  const result = spawnSync("git", args, { cwd, env: gitEnv(env), encoding: "utf8" });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * Read git at the destination. `from` is the destination when it exists, or
 * its nearest existing ancestor. Returns one of:
 *
 *   { kind: "outside" }
 *   { kind: "template-checkout", origin }
 *   { kind: "root", history: boolean, staged: string[] }   `staged` is read only when there is no history
 *   { kind: "ignored", toplevel }   the repository whose work tree it is in ignores it
 *   { kind: "inside", toplevel }
 *   { kind: "unreadable-git" }   the destination holds a `.git` git does not read as its repository
 */
export function readGit({ dest, from, destExists, destHasGit, env }) {
  const top = git(["rev-parse", "--show-toplevel"], { cwd: from, env });
  if (top.status !== 0) return destHasGit ? { kind: "unreadable-git" } : { kind: "outside" };

  const origin = templateOrigin({ from, env });
  if (origin !== null) return { kind: "template-checkout", origin };

  // `--show-prefix` prints nothing at a repository's root, which needs no path
  // comparison and so survives symlinks and letter case.
  if (destExists) {
    const prefix = git(["rev-parse", "--show-prefix"], { cwd: dest, env });
    if (prefix.status === 0 && prefix.stdout === "") {
      const head = git(["rev-parse", "-q", "--verify", "HEAD"], { cwd: dest, env });
      if (head.status === 0) return { kind: "root", history: true, staged: [] };
      const index = git(["ls-files", "-z"], { cwd: dest, env });
      return { kind: "root", history: false, staged: index.stdout.split("\0").filter(Boolean) };
    }
    if (destHasGit) return { kind: "unreadable-git" };
  }
  if (ignores({ dest, from, env })) return { kind: "ignored", toplevel: top.stdout };
  return { kind: "inside", toplevel: top.stdout };
}

/**
 * Whether the repository `from` stands in ignores `dest` as a directory, by
 * every source git reads: its `.gitignore` files, its `info/exclude` and the
 * user's `core.excludesFile`. That is exactly when a repository nested there is
 * invisible to it.
 *
 * Git reads a path as a directory only when one stands there, so a missing
 * destination is made for the question and removed after it. A trailing slash
 * is no substitute: it makes git test an empty last name as well, which `*` and
 * `my-app/*` match, so a `*` that a later pattern lifts from every directory
 * would read a directory it re-includes as ignored. For the same reason the
 * directory is named from its parent, with no slash, since asked from inside
 * it as `./` git tests it with one. The name starts with `./` because git
 * reads a leading `:` as pathspec magic, and `--literal-pathspecs` is refused
 * by `check-ignore`. The directory is named where it physically is: a
 * destination that is a symlink sits in one repository's work tree and points
 * into another's, the one every other reading of the destination sees, and
 * that one is the repository whose ignores count. Any answer but a plain yes, a
 * directory that cannot be made or resolved included, reads as not ignored,
 * since mistaking a tracked destination for an ignored one would plant a
 * repository in the user's tracked tree. A directory that holds a tracked path
 * reads as not ignored whatever the patterns say, whether or not its files are
 * still on disk.
 */
function ignores({ dest, from, env }) {
  return withDirectories({ dest, from }, false, () => {
    const real = fs.realpathSync(dest);
    const name = `./${path.basename(real)}`;
    return git(["check-ignore", "-q", "--", name], { cwd: path.dirname(real), env }).status === 0;
  });
}

/**
 * Whether the repository whose work tree holds `dest` shows none of the files
 * written there, every one of them being ignored, though the directory is not.
 * An empty status does not say so alone: a project the enclosing repository
 * tracks, deleted and then written again as it was, shows nothing either, so
 * its index must hold nothing under `dest` as well.
 */
export function ignoresEveryFile({ dest, env }) {
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", "."], {
    cwd: dest,
    env,
  });
  if (status.status !== 0 || status.stdout !== "") return false;
  const tracked = git(["ls-files", "--", "."], { cwd: dest, env });
  return tracked.status === 0 && tracked.stdout === "";
}

/**
 * Answer with every missing directory from `from`, the destination's nearest
 * existing ancestor, down to `dest` made for the call and removed after it.
 * Returns what `answer` returns, or `fallback` when a directory cannot be made
 * or `answer` throws.
 *
 * It removes only what it made, as the write does. Each missing directory is
 * made without `recursive`, so a path that stands there already, a dangling
 * symlink the reading took for missing, or one another process creates
 * meanwhile fails the call instead of being taken over and removed. The
 * directories go deepest first and only while empty, so what another process
 * writes into one meanwhile stays.
 */
function withDirectories({ dest, from }, fallback, answer) {
  const missing = [];
  for (let at = dest; at !== from && path.dirname(at) !== at; at = path.dirname(at)) {
    missing.unshift(at);
  }
  const made = [];
  try {
    for (const dir of missing) {
      fs.mkdirSync(dir);
      made.push(dir);
    }
    return answer();
  } catch {
    return fallback;
  } finally {
    for (const dir of made.reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Not empty: another process wrote into it, and what it wrote stays.
      }
    }
  }
}

/** The `origin` of the repository `from` stands in when it is a template's own, or null. */
export function templateOrigin({ from, env }) {
  const origin = git(["remote", "get-url", "origin"], { cwd: from, env });
  return origin.status === 0 && TEMPLATE_ORIGINS.test(origin.stdout) ? origin.stdout : null;
}

/** Whether git can name an author and a committer, as a commit needs. */
export function hasIdentity({ cwd, env }) {
  return (
    git(["var", "GIT_AUTHOR_IDENT"], { cwd, env }).status === 0 &&
    git(["var", "GIT_COMMITTER_IDENT"], { cwd, env }).status === 0
  );
}

/**
 * Whether git can name an author and a committer for the commit in the
 * repository about to be made at `dest`. `from` is the destination or its
 * nearest existing ancestor, and `enclosed` says whether it lies in the work
 * tree of a repository that ignores the destination.
 *
 * Outside every repository, an identity git shows from `from` is one the new
 * repository will see too, but git reads no `includeIf "gitdir:…"` section
 * there, so an identity given only to the repositories under a directory is
 * invisible from `from`. When that reading finds none, and always when `from`
 * is enclosed, since it would then read the enclosing repository's own
 * configuration, which the new repository does not inherit, the question is
 * asked inside a throwaway repository made at `dest`, and what the probe made
 * is removed before the answer is returned.
 *
 * The missing directories are made and removed as `withDirectories` says, and
 * the `.git` is made without `recursive` too, so one that stands there already
 * fails the probe instead of being taken over and removed. A probe that cannot
 * be made answers no.
 */
export function hasIdentityForInit({ dest, from, enclosed, env }) {
  if (!enclosed && hasIdentity({ cwd: from, env })) return true;
  return withDirectories({ dest, from }, false, () => {
    const probe = path.join(dest, ".git");
    fs.mkdirSync(probe);
    try {
      return (
        git(["init", "-q"], { cwd: dest, env }).status === 0 && hasIdentity({ cwd: dest, env })
      );
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });
}

/** The pristine commit's message, in the scaffold skill's format. */
export function pristineMessage({ template, version, source }) {
  return `Start from Pipelex/pipelex-method-apps/${template} ${version} (${source})`;
}

/**
 * Initialize when asked, then make the pristine commit of exactly `paths`, the
 * files the write created. Returns the commit's SHA, or throws with git's own
 * message. Git's output is not shown on success.
 *
 * The repository is born on `main` through `symbolic-ref` rather than
 * `init -b`, which git before 2.28 does not know. The paths are added with
 * `--force` and read literally: a user's `core.excludesFile` or the
 * repository's `info/exclude` must not silently drop a file of the template
 * from a commit that claims to hold it as it came, and the template ignores
 * none of its own files.
 */
export function commitPristine({ dest, init, paths, message, env }) {
  const steps = [
    ...(init
      ? [
          ["init", ["init", "-q"]],
          ["symbolic-ref", ["symbolic-ref", "HEAD", "refs/heads/main"]],
        ]
      : []),
    ["add", ["--literal-pathspecs", "add", "--force", "--", ...paths]],
    ["commit", ["commit", "-q", "-m", message]],
  ];
  for (const [name, args] of steps) {
    const result = git(args, { cwd: dest, env });
    if (result.status !== 0) {
      const said = [result.stderr, result.stdout].filter(Boolean).join("\n");
      throw new Error(`git ${name} failed${said ? `:\n${said}` : ""}`);
    }
  }
  return git(["rev-parse", "HEAD"], { cwd: dest, env }).stdout;
}

/**
 * The commands a person runs to make the pristine commit by hand, once the
 * copy stands, joined with `&&` for a shell. `quote` quotes one word.
 */
export function pristineByHand({ dest, init, message, quote }) {
  const at = `git -C ${quote(dest)}`;
  return [
    ...(init ? [`${at} init -q`, `${at} symbolic-ref HEAD refs/heads/main`] : []),
    `${at} add --force -A`,
    `${at} commit -m ${quote(message)}`,
  ].join(" && ");
}
