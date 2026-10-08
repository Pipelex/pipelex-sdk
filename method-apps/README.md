# pipelex-method-apps

Templates for an app that runs [MTHDS](https://mthds.ai) methods through the [Pipelex](https://pipelex.com) API, one directory per shape and language. A template ships no method: it ships what every method needs, and one command turns a copy of it into the app for the method you have.

| Template                     | What a copy becomes                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`webapp-js/`](webapp-js/)   | A Next.js 16 web app that renders each method's input form and result view from the method's own contract, and runs it through [`@pipelex/sdk`](https://www.npmjs.com/package/@pipelex/sdk)                            |
| [`cli-python/`](cli-python/) | A Python command-line tool that runs the method through [`pipelex-sdk`](https://pypi.org/project/pipelex-sdk/) and prints its result as JSON on stdout; its `make create` turns a copy into the command for one method |

Looking for worked examples instead? [`pipelex-starter-js`](https://github.com/Pipelex/pipelex-starter-js) is the gallery the web app template was extracted from, with several demo methods presented as tabs, and [`pipelex-starter-python`](https://github.com/Pipelex/pipelex-starter-python) the one the command-line template was extracted from.

## Start a project from a template

A project is a copy of one template directory, and nothing else from this repository. One command writes the template into a new directory, commits it as it came, and runs the template's create gesture with your method; a second starts the app:

```bash
export PIPELEX_API_KEY=…                               # from app.pipelex.com
npm create @pipelex/method-app@latest my-app -- --method path/to/my_method.mthds
make -C my-app serve                                   # the URL, once the page answers; make stop stops it
```

`make serve` starts the dev server in the background and proves that the page answers; `make dev` runs it in the foreground instead. `--method` takes a `.mthds` file or a directory of them, a method id from your organization's catalog (`mt_…`, or `mt_…@<version>` and `mt_…@draft` to pin a version or run the draft), or a published package address. The initializer's [README](initializers/js/README.md) lists its options, what it does with git, and the verdict each run ends with. The template's own [README](webapp-js/README.md) and [`docs/create.md`](webapp-js/docs/create.md) say what the create gesture does and how to override what it derives.

The Python templates have no initializer yet: the command-line template's own [README](cli-python/README.md) copies it out of a release's tag with `curl` and `tar`, and its [`docs/create.md`](cli-python/docs/create.md) says what its `make create` does with your method.

## Working on the templates

Each template is self-contained: it has its own `Makefile`, its own `CLAUDE.md` and its own checks, and works from inside its directory exactly as it will in a project. The family root carries what belongs to the family, and runs every template's gate at once:

| Target                    | Purpose                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `make install`            | Install every template's dependencies                                                                       |
| `make check`              | The family's own checks, then every template's `make check`                                                 |
| `make test`               | The tests of the family's scripts and of the initializer, then every template's tests                       |
| `make all`                | `check`, `test`, then every template's build                                                                |
| `make check-family`       | Check the formatting of the family root's own files                                                         |
| `make use-local`          | Install this repository's SDK and the workspace's `mthds-form` or `mthds-python` checkout in every template |
| `make use-local-form`     | Install the workspace's `mthds-form` checkout alone into every template that uses the form kernel           |
| `make use-published`      | Restore the Pipelex packages each template's lock file pins                                                 |
| `make use-published-form` | Restore the `@pipelex/mthds-form` version the lock file pins, in every template that uses the form kernel   |
| `make local-status`       | Say, for every template, whether each Pipelex package comes from a sibling checkout or from its registry    |

`make help` lists them all. [`docs/family.md`](docs/family.md) explains the layout: why the repository's root twins each template's workflows, how the initializer carries the templates, how the family ships at the repository's version, and what a new template needs to join. The workflow twins and the version are checked at the repository's root, by its `make check-workflows` and `make check-versions`.

## License

This project is licensed under the [MIT license](LICENSE). Runtime dependencies are distributed under their own licenses.
