# Agent instructions — pipelex-sdk

The guide for AI coding agents at this repository's root is [`CLAUDE.md`](CLAUDE.md), and each package directory carries its own `CLAUDE.md` for work inside it. Everything there applies regardless of which agent you are. The rules that cause real damage when missed:

- **A template's files belong to the person's project.** `starter-js/`, `starter-python/` and `method-apps/webapp-js/` ship whole to every project made from them, so nothing that serves only this repository's maintainers may live in one, and a template's own skills are never run here.
- **A template works on its own**: nothing in it may reach above its directory, and it installs its SDK from the registry, never from this tree.
- **Never bump a version by hand**: the root `VERSION` and each package's manifest move only in a release.
- **Before pushing, run `make -C <directory> agent-check` and `make -C <directory> agent-test`** for every directory a change touches.
