# pipelex-method-cli-python

A command-line tool that runs one [MTHDS](https://mthds.ai) method through the [Pipelex](https://pipelex.com) API with [`pipelex-sdk`](https://pypi.org/project/pipelex-sdk/), printing the method's result as JSON on stdout.

This is a **template**: it ships no method. A copy of it becomes the command for one method, named after it, whose only command runs that method and whose flags choose how the run is followed. The result is the method's output as JSON on stdout and nothing else, so the command pipes into `jq` or a script the same way wherever it runs; progress, the run id, the cost report, downloaded files and errors all go to stderr.

## Requirements

- [uv](https://docs.astral.sh/uv/getting-started/installation/), which installs the Python the project needs (3.11 to 3.14) if you do not have it.
- `make`, `curl` and `tar`, which macOS and most Linux distributions ship.
- A Pipelex API key, from [app.pipelex.com](https://app.pipelex.com), for anything that talks to the API. Installing, checking and testing the template need none.

## Start a project from the template

Copy the template out of a release of [`Pipelex/pipelex-sdk`](https://github.com/Pipelex/pipelex-sdk/releases), whose notes list the method apps among what it shipped, into a new directory. Nothing else is needed: no Node, no clone of the repository.

```bash
TAG=vX.Y.Z   # a pipelex-sdk release that shipped the method apps
mkdir my-cli
curl -fsSL "https://codeload.github.com/Pipelex/pipelex-sdk/tar.gz/refs/tags/$TAG" \
  | tar -xz -C my-cli --strip-components=3 "pipelex-sdk-${TAG#v}/method-apps/cli-python"
cd my-cli
git init -q && git add -A && git commit -q -m "pipelex-method-cli-python $TAG, as copied"
make install
```

Then turn it into the command for your method, where `METHOD` is a `.mthds` file or a directory of them, a method id from your organization's catalog (`mt_…`), or a published method's address:

```bash
make create METHOD=./receipt_review.mthds
```

**`make create` is not written yet in this version of the template.** It reads its whole argument contract, the method-app family's, and then refuses, changing nothing. Until it lands, the template installs, checks, tests and builds, and its command explains that it holds no method:

```bash
.venv/bin/pipelex-method-cli-python --help
```

## Running the method

Once the project holds a method, its command runs it. With the project's own name in place of `my-cli`:

```bash
my-cli --inputs inputs.json                    # start the run, follow it here, print the result
my-cli --inputs inputs.json --blocking         # run it in one request instead
RUN_ID=$(my-cli --inputs inputs.json --detach) # start it, print its id alone, and return
my-cli --resume "$RUN_ID"                      # follow a run started earlier, and print its result
my-cli --inputs - < inputs.json | jq .         # read the inputs from stdin, pipe the result
```

`--inputs` takes a JSON object mapping each of the method's input names to its value, in the shape `mthds run --inputs` takes. Run the command as `.venv/bin/my-cli …` from the project's directory once `make install` has built the environment, or install it once with `uv tool install .` to have it on your `PATH`. Never run it through `uv run`, which re-syncs the environment against `uv.lock` first and silently undoes `make use-local`.

- **A run is followed here by default.** It starts on the server, its id is printed on stderr at once, and a status line follows it until its result arrives. **Ctrl-C leaves the run going on the server**, prints the `--resume` command that picks it up again, and exits with code 130.
- **`--blocking`** runs the method in one request. Behind the hosted API that request is cut off after about 30 seconds, so it suits a short method; the error says to drop the flag when a run hits that limit. A server that cannot hold runs, such as a local runner without a run store, answers a run started without `--blocking` with an error that names the flag: the command never falls back on its own.
- **`--detach`** starts the run and prints its id alone on stdout, for a script to collect later with `--resume`.
- **Files the method produced**, such as images, are downloaded under `outputs/<run-id>/`, or into the directory `--out DIR` names; `--no-download` skips them. Their paths are printed on stderr.
- **The cost report**, the model calls the run made and what they cost, follows the result on stderr.

The exit code is 0 on success; 1 when the run or a request failed, when the API key is missing, or when a produced file did not come down or is missing from an earlier download; 2 for a command line it refuses; and 130 after Ctrl-C.

## Configuration

The command reads `PIPELEX_API_KEY` and `PIPELEX_BASE_URL` from the shell, or from a `.env` file in the directory it runs from or any directory above it, a variable already set in the shell winning over the file. `.env.example` lists both; `PIPELEX_BASE_URL` defaults to the hosted API, `https://api.pipelex.com`.

## Commands

| Command | What it does |
| --- | --- |
| `make install` | Install the project and its development tools into `.venv`, as `uv.lock` pins them |
| `make check` | Lint and check the formatting with ruff, and type-check with pyright in strict mode |
| `make test` | Run the tests, which need no key and no network |
| `make all` | `check`, `test` and `build`: run it after any change |
| `make format` | Sort the imports and format the code |
| `make build` | Build the wheel and the source distribution into `dist/` |
| `make lock` | Regenerate `uv.lock` after editing the dependencies |
| `make agent-check`, `make agent-test` | `check` and the tests, silent on success, installing first when `.venv` is missing |
| `make use-local`, `make use-published`, `make local-status` | Switch `pipelex-sdk` and `mthds` between local checkouts and the PyPI releases (below) |

Every tool runs from `.venv/bin/`, never through `uv run`, so a package installed over the locked one stays in place until you switch it back.

## Developing against local checkouts

`make use-local` installs a checkout of `Pipelex/pipelex-sdk` (its `python/` directory is the SDK) and, when it is there, a checkout of `Pipelex/mthds-python`, as editable packages in place of the PyPI releases, so an edit to either takes effect at once. It looks for both in the project's parent directory; `SIBLINGS_DIR=<dir>` names another parent, and `SDK_DIR=<dir>` and `MTHDS_DIR=<dir>` name either checkout directly. `make use-published` puts back the versions `uv.lock` pins, and `make local-status` says which is installed. Neither changes `pyproject.toml` or `uv.lock`.

<!-- template-only:begin -->

## Developing the template

This directory is the `cli-python/` member of the method-app family, `method-apps/` in the [`Pipelex/pipelex-sdk`](https://github.com/Pipelex/pipelex-sdk) repository, whose [`docs/family.md`](https://github.com/Pipelex/pipelex-sdk/blob/main/method-apps/docs/family.md) describes the family. Its gate is `make all` here, or `make -C method-apps all` from the repository's root; its workflows run in that repository through the root's rendered twins, and its history is the family's [`CHANGELOG.md`](https://github.com/Pipelex/pipelex-sdk/blob/main/method-apps/CHANGELOG.md). [`CLAUDE.md`](CLAUDE.md) is the guide for working on it, and [`docs/lineage.md`](docs/lineage.md) records what it took from the Python starter.

<!-- template-only:end -->

## License

[MIT](LICENSE)
