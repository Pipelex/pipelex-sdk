# Pipelex SDK

The Pipelex client surface in one repository: the clients of the [Pipelex](https://pipelex.com) hosted API in TypeScript and Python, the starter templates built on them, and the method-app templates with the initializer that writes them.

| Directory | What it is | Get it |
| --- | --- | --- |
| [`js/`](js/) | `@pipelex/sdk`, the TypeScript client | `npm install @pipelex/sdk` |
| [`python/`](python/) | `pipelex-sdk`, the Python client | `pip install pipelex-sdk` |
| [`starter-js/`](starter-js/) | A Next.js starter app calling Pipelex through `@pipelex/sdk` | "Use this template" on [`Pipelex/pipelex-starter-js`](https://github.com/Pipelex/pipelex-starter-js) |
| [`starter-python/`](starter-python/) | A Python command-line starter calling Pipelex through `pipelex-sdk` | "Use this template" on [`Pipelex/pipelex-starter-python`](https://github.com/Pipelex/pipelex-starter-python) |
| [`method-apps/`](method-apps/) | The method-app templates, a Next.js web app and a Python command-line tool, and `@pipelex/create-method-app`, which writes the web app around your method | `npm create @pipelex/method-app@latest my-app -- --method <bundle>`; the Python one is copied out of a release's tag, as [its README](method-apps/cli-python/README.md) shows |

Each directory's `README.md` is the guide for using it.

## Contributing

Pull requests target `dev`. Each package directory is a project of its own, with its own `Makefile`, manifest and lockfile, and it installs itself the first time its checks run:

```bash
make install                 # wire the git hooks; installs no package
make -C js agent-check       # one directory's checks, installing it first if needed
make -C js agent-test        # one directory's tests, silent on success
make agent-check agent-test  # every directory
```

A first contribution is asked to sign the [contributor license agreement](CLA.md) on its pull request. [`docs/`](docs/) describes the repository's layout, its release model and how the starters are published.

## License

[MIT](LICENSE), © Evotis S.A.S. Each package carries its own copy of the license.
