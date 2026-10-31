# The repository's documentation

These pages describe the repository as a whole. Each package documents itself in its own `docs/` directory.

- [`layout.md`](layout.md) — the directories, why each stands on its own, what lives at the root, how a worktree installs, and where the code came from.
- [`ci.md`](ci.md) — the pull-request checks: what runs when, the two required aggregates, the templates' standalone and next-SDK twins, and where each source repository's checks run now.
- [`release-model.md`](release-model.md) — the repository's one version, how a release selects the packages it ships, the release workflow that tags and publishes it, how a breaking SDK change reaches the templates, and the sprint prereleases of `@pipelex/sdk`.
- [`export.md`](export.md) — how the starters stay GitHub template repositories, generated from their directories here by the release's export job, and the scheduled comparison that watches them.
- [`live-accounts.md`](live-accounts.md) — the account the live suites act for against the hosted plane, QA Builder in QA SDK (dev), handed over by the workspace's `test-account run`, and the check each suite runs before its first case, the production refusal included.
- [`live-create-proofs.md`](live-create-proofs.md) — the live proofs of the method-app templates' `make create`, taken by hand against the hosted API before a release that touches a template's gesture or the code its projects run, since no workflow holds an API key.
