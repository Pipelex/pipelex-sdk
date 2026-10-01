# Agent instructions — pipelex-method-apps

The guide for AI coding agents at this repository's root is [`CLAUDE.md`](CLAUDE.md), and each template directory carries its own `CLAUDE.md` and `AGENTS.md` for work inside it. Everything there applies regardless of which agent you are. The rules that cause real damage when missed:

- **A template directory must work on its own**: a project is a copy of that directory alone, so nothing in it may reach above it.
- **Edit a template's workflows in its directory, then run `make workflows`** at the root and commit the rendered twins with the change. Never hand-edit a root workflow that opens with `# Rendered by`.
- **Never bump a version by hand**: `VERSION` and every template's manifest move together, in a release.
- **After any change, run `make all` at the root.** Prefer `make agent-test` over `make test` when only the tests are needed.
