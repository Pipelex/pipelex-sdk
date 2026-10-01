# @pipelex/create-method-app

Start an app that runs an [MTHDS](https://mthds.ai) method through the [Pipelex](https://pipelex.com) API, with the method you already have:

```bash
export PIPELEX_API_KEY=…                               # from app.pipelex.com
npm create @pipelex/method-app@latest my-app -- --method ./receipt_review.mthds
make -C my-app serve
```

The first command writes the [`webapp-js`](https://github.com/Pipelex/pipelex-method-apps/tree/main/webapp-js) template of [`pipelex-method-apps`](https://github.com/Pipelex/pipelex-method-apps) into `my-app/`, commits it as it came, and runs the copy's own `make create`, which scaffolds the method, names the project after it and runs `make all`. The second starts the dev server in the background, proves that the page answers, and prints its URL; `make stop` stops it. `make dev` runs the same server in the foreground instead.

`--method` takes a `.mthds` file or a directory of them, a method id from your organization's catalog (`mt_…`), or a published package address (`github.com/Pipelex/methods/text_stats@v0.1.1`). A path is read from where you typed the command.

## What it needs

- **Node.js** at or above the template's floor (22.12 for `webapp-js`), `make`, and `git` unless you pass `--no-git`.
- **`PIPELEX_API_KEY`** in the environment, since a fresh copy has no `.env.local` for `make create` to read it from. `make create` copies it into the project's `.env.local`. The initializer only checks that it is set, and never prints it.
- **A directory that is missing, empty, or holds only `.git`.** Anything else, `.DS_Store` included, is refused, and nothing is written.

The package has no dependency. It carries the template inside it, packed from the family's repository at the commit it was published from, so `@X.Y.Z` writes exactly the X.Y.Z template and nothing is fetched from GitHub.

## Options

| Option                                                                                             | What it does                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--method <m>`                                                                                     | The method the app runs. Required unless `--no-create`.                                                                                                  |
| `--name`, `--title`, `--description`                                                               | The project's package name, title and description, which `make create` otherwise derives from the method.                                                |
| `--pipe`, `--method-name`, `--label`                                                               | The pipe to run, the method's directory name and its tab label, when the method does not settle them.                                                    |
| `--author-name`, `--author-email`, `--repo-url`, `--license`, `--license-holder`, `--license-year` | What the project says about who made it. Nothing is invented.                                                                                            |
| `--dry-run`                                                                                        | `make create` plans and prints the identity without changing a file. The copy and its commit stand, and the verdict names the real `make create` to run. |
| `--no-create`                                                                                      | Write the template and commit it, then stop. The verdict names the `make create` to run, after writing `.env.local` yourself, for instance.              |
| `--no-git`                                                                                         | Make no repository and no commit.                                                                                                                        |
| `--quiet`                                                                                          | Write `make create`'s output to a log and print its path, so the summary stays in view.                                                                  |
| `--template <name>`                                                                                | The template to write. `webapp-js` is the default and the only one.                                                                                      |

Each create option is named after the `make create` variable it sets (`--author-email` is `AUTHOR_EMAIL`), and reaches `make create` as one argument, so no value needs quoting beyond what your shell needs. A blank value is not passed on. Nothing is ever asked: a missing value is a refusal naming the option.

## Git

The initializer reads git before it writes anything:

| The destination                                                                                  | What happens                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Inside no repository                                                                             | A new repository on `main`, then the pristine commit                                                                             |
| A repository with no commit yet (a `git init` by hand, or a clone of an empty GitHub repository) | The pristine commit, as its first                                                                                                |
| A repository with no commit whose index already holds a file, added and then deleted             | Refused: the commit would record that file beside the template                                                                   |
| A repository with commits, holding only `.git`                                                   | Refused: every tracked file would show as deleted, and the commit would record that                                              |
| Inside another repository's work tree, at a path it ignores                                      | A new repository on `main`, then the pristine commit: that repository does not see the project                                   |
| Inside another repository's work tree                                                            | No repository and no commit: the project is new files in that repository. `--no-create` lets you commit the template there first |
| Inside a checkout of `pipelex-method-apps` or of a starter                                       | Refused, `--no-git` included whenever git is on the PATH                                                                         |

A path the enclosing repository ignores, such as a `tmp/` its `.gitignore` lists or anywhere under a home directory kept as a repository that ignores `*`, is one it does not version, so a project there gets a repository of its own rather than no version control at all. Every source git reads counts: the enclosing repository's `.gitignore` files, its `.git/info/exclude`, and your `core.excludesFile`. What counts is the directory itself, which a missing destination is made for a moment to let git read: a directory the enclosing repository does not ignore gets no repository even when every file in it is ignored, as under `*` followed by `!*/`, since a repository there would still show in the enclosing one's `git status`, and the `git:` line then says the project is under no version control. A destination that is a symlink is read where it points: the repository whose work tree holds its target is the one whose ignores count.

A commit needs a git identity, and a missing one is refused before anything is written. When git shows none outside a repository, the initializer asks again inside a throwaway repository at the destination, which it removes before going on, so an identity given only by an `includeIf "gitdir:…"` section is found. At a path another repository ignores, it always asks inside that throwaway repository, since an identity set in the enclosing repository's own configuration does not reach the new one.

The pristine commit reads `Start from Pipelex/pipelex-method-apps/webapp-js <version> (<sha>)`, so `make create`'s changes are a diff you can read before committing them. `make create` itself commits nothing.

## What it prints

A run ends with one verdict line, the last line it prints on standard output, whose first word is stable:

| Verdict                                                                                                                                             | Meaning                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `created <dir>; next: cd <dir> && make serve`                                                                                                       | The copy, the git outcome, and a green `make create`                                                                                                                                                              |
| `copied <dir>; next: …`                                                                                                                             | With `--no-create` or `--dry-run`: the copy and the git outcome, and the `make create` to run next                                                                                                                |
| `refused: not-empty`                                                                                                                                | The destination holds something other than a lone `.git`; nothing was written                                                                                                                                     |
| `refused: unusable-destination`                                                                                                                     | The destination cannot be read: a file stands where a directory of its path should be, or a directory on it cannot be read; nothing was written                                                                   |
| `refused: repository-has-history`, `refused: repository-has-staged-files`, `refused: inside-template-checkout`                                      | The git reading above; nothing was written                                                                                                                                                                        |
| `refused: no-method`, `no-key`, `missing-tool`, `node-too-old`, `no-git-identity`, `unknown-option`, `unknown-template`, `other-ecosystem`, `usage` | The preflight; nothing was written, and the line names the fix                                                                                                                                                    |
| `failed: write`                                                                                                                                     | The copy failed or was interrupted, and everything the initializer had created was removed; nothing else was touched                                                                                              |
| `failed: commit`                                                                                                                                    | Git refused the pristine commit, for instance through a global hook; the copy stands, and the line says how to commit it and what to run next                                                                     |
| `failed: create`                                                                                                                                    | `make create` did not succeed; the copy and its commit stand, and `make create`'s own message says what to run next: a refusal before it wrote anything can be fixed and run again, and a failure after it cannot |

Before the verdict come the warnings `make create` printed, each once, and the git outcome. The exit code is 0 for `created` and `copied` and 1 otherwise, but the verdict is the line to read.

Everything the initializer prints goes to standard output, `make create`'s output included when `--quiet` is not given. Under `npm create`, a run that exits 1 is followed by npm's own `npm error` lines on standard error, so read the verdict from standard output rather than from the last line of everything printed. `npm create --loglevel=silent @pipelex/method-app@latest …` removes npm's lines and leaves the initializer's alone.

A Python template gets its own initializer, run with `uvx create-pipelex-method-app`, and this one refuses it with `refused: other-ecosystem`.

## License

[MIT](LICENSE). The template it writes carries its own license, MIT, which the project can change with `--license`.
