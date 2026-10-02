# Agent instructions — pipelex-method-apps

The guide for AI coding agents at this repository's root is [`CLAUDE.md`](CLAUDE.md), and each template directory carries its own `CLAUDE.md` and `AGENTS.md` for work inside it. Everything there applies regardless of which agent you are. The rules that cause real damage when missed:

- **A template directory must work on its own**: a project is a copy of that directory alone, so nothing in it may reach above it.
- **Edit a template's workflows in its directory, then run `make workflows`** at the repository's root, one level up, and commit the rendered twins with the change. Never hand-edit a root workflow that opens with `# Rendered by`.
- **Never bump a version by hand**: only a release moves the repository's `VERSION` and the manifests it ships, the template's and the initializer's together.
- **After any change, run `make all` in this directory.** Prefer `make agent-test` over `make test` when only the tests are needed.
