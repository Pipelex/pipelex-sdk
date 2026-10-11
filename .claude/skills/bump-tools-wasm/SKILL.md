---
name: bump-tools-wasm
description: Move js/ in pipelex-sdk onto a newer published @pipelex/tools-wasm, the offline lint and format engine the `.mthds` edit hook bundles, from the repository root. Reads vscode-pipelex's changelog for the engine versions in between, weighs each entry against the hook's two seams (the engine's API and the MTHDS schema it embeds), moves the exact pin and the lock, runs js/'s gate, rebuilds the hook bundle and checks its provenance line, sweeps the bundle before and after over the MTHDS Test Corpus the engine was released against and probes the forms the corpus does not cover, writes the js/ changelog entry, files the pipelex-plugins re-vendor, and carries the work through its ledger item, its worktree, a /rev pass and a pull request to dev. Use when, in pipelex-sdk or one of its worktrees, someone says "bump tools-wasm", "bump @pipelex/tools-wasm", "move the hook onto the new engine", "pin the new tools-wasm", "vscode-pipelex just released", "the hook's schema is behind", "check-hook-fresh says the bundle is stale", or picks up a ledger item asking pipelex-sdk to pin an engine release so the hook can be re-vendored. Not for trying an unreleased engine, which is `PIPELEX_TOOLS_WASM_PATH`, not for re-vendoring in pipelex-plugins, which is its `make vendor-hook`, and not for the SDK or the form kernel in the templates, which are /bump-sdk and /bump-mthds-form.
---

# Bump @pipelex/tools-wasm in js/

`@pipelex/tools-wasm` is a devDependency of `js/`, pinned to an exact version with no caret. It is the engine the `.mthds` post-edit hook lints and formats with, and it embeds the MTHDS JSON Schema, so the pinned version decides which forms the hook blocks. `npm run build:hook` inlines it into `js/dist-hooks/check.mjs`, and pipelex-plugins vendors that bundle into every agent plugin. The published `@pipelex/sdk` tarball does not ship the bundle, so a bump changes nothing for an npm consumer of the SDK; it changes what every builder's hook accepts once pipelex-plugins re-vendors.

The schema travels through four repositories, each step a build or a publish:

    pipelex (derived/mthds_schema.json)
      -> vscode-pipelex (engine release, tag pipelex-tools-wasm/vX.Y.Z, npm publish)
      -> pipelex-sdk js/ (this skill: the pin, then npm run build:hook)
      -> pipelex-plugins (make vendor-hook; its make check-hook-fresh release gate)

`js/docs/architecture.md` explains why the pin is exact, and pipelex-plugins' `docs/hooks.md` ("Where the embedded schema comes from", "Re-vendoring check.mjs") describes the last step and its guards.

## Step 1 — Read the state

Reading is free in the main checkout, so this step and the next two run wherever the session stands. From the repository root:

```bash
node -p "require('./js/package.json').devDependencies['@pipelex/tools-wasm']"
node -p "require('./js/package-lock.json').packages['node_modules/@pipelex/tools-wasm'].version"
npm view @pipelex/tools-wasm version
git -C ../vscode-pipelex fetch --tags --quiet
git -C ../vscode-pipelex tag -l 'pipelex-tools-wasm/v*' --sort=-v:refname | head -3
```

The first two come from tracked files, so they answer in a checkout where `js/` was never installed, and they should agree. The tags are fetched, never checked out; `../vscode-pipelex` is the same relative path from a worktree.

- **A tag newer than what `npm view` reports** usually means the engine was released moments ago. vscode-pipelex's `Releases` workflow publishes from the tag (`gh run list -R Pipelex/vscode-pipelex --workflow releases.yaml --limit 8`), and npm can take a while to make a new version installable after the publish job prints `+ @pipelex/tools-wasm@X.Y.Z` and "Your package is being processed" (more than a quarter of an hour has been seen). `npm view` can name the version several minutes before the registry serves its tarball, so the test that it is installable is the tarball itself: `curl -sfI "$(npm view @pipelex/tools-wasm@<version> dist.tarball)" >/dev/null && echo installable`. Never install from a checkout or a tarball URL to get ahead of it: a bundle built that way reads `(local checkout …)` in its provenance and pipelex-plugins refuses to ship it. A failed or missing `Releases` run means nothing was published, which is vscode-pipelex's to fix, so file it there.
- **`PIPELEX_TOOLS_WASM_PATH` set in the shell** makes `build:hook` bundle a local engine instead of the pin. Every build in this skill runs with it removed (`env -u PIPELEX_TOOLS_WASM_PATH`).
- **`js/` is already on the latest published version**: say so and stop, unless the user named another version.

## Step 2 — Pick the target

The target is the latest published version unless the invocation named another, so do not ask when there is no choice to make. A named version may be ahead of `npm view` (published but not yet installable, see above, in which case wait) or behind it, as long as it is above the pin. A version below the pin is a downgrade, and a downgrade is not a bump: say so and stop, since undoing an engine release means reading its changelog backwards and is planned by a person. Call it `TARGET`, without a `v`, and call the current pin `PINNED`.

## Step 3 — Read what changed, against the hook's seams

vscode-pipelex keeps one `CHANGELOG.md` for every component it ships. Its version headings are the repository's (`## [0.20.0] - 2026-10-12`), not the engine's, and each entry ends with the component versions it shipped in, such as `(plxt 0.11.0, pipelex-tools-py 0.5.0, @pipelex/tools-wasm 0.5.0)`. Read it as it stood at the engine's tag, `git -C ../vscode-pipelex show pipelex-tools-wasm/v<TARGET>:CHANGELOG.md`, and take every entry whose annotation names `@pipelex/tools-wasm` at a version above `PINNED` and up to `TARGET`. Older entries sometimes describe a change to the shared engine ("every consumer of the engine moves together") without naming `@pipelex/tools-wasm` in the annotation, so also read the entries in those sections that change the bundled schema or the shared engine.

A diff between the two engine tags confirms which seams moved before reading a word: `git -C ../vscode-pipelex diff --stat pipelex-tools-wasm/v<PINNED> pipelex-tools-wasm/v<TARGET> -- crates/taplo-common/schemas crates/pipelex-tools-wasm crates/pipelex-common js/tools-wasm/src test-data/mthds-corpus`. A section that changes only the corpus, with no component annotation, changes what the Step 6 sweep runs and not what the hook does.

Hold each entry against the two seams the hook has:

- **The engine's API.** `js/src/hooks/claude-mthds-check.ts` imports the module (`initialize`, `lintMthds`, `formatMthds`), and the diagnostics it returns are read as the SDK's own `Diagnostic` from `js/src/models.ts` and rendered by `renderDiagnosticLine` in `js/src/hooks/check-core.ts` (`kind`, `severity`, `message`, and the span). `npm diff --diff=@pipelex/tools-wasm@<PINNED> --diff=@pipelex/tools-wasm@<TARGET> dist/index.d.ts` shows the type surface between the two (empty output means it did not move). A renamed export or a field the SDK's `Diagnostic` requires going missing turns the type check red in Step 6, which is the seam working; a changed meaning of `severity` or a new `kind` passes the type check and still changes what the block reason says, so read those entries rather than trusting the gate.
- **The embedded schema.** Every schema entry changes what the hook does to a builder's edit: a form newly accepted stops being blocked, and a form newly refused starts being blocked, even when it validated yesterday. `(Breaking)` at the end of an entry's bold title is the workspace's breaking marker, and in this changelog it almost always means a refusal. Give each such entry a verdict: which edits the hook now blocks. The corpus sweep in Step 6 turns these verdicts into evidence.

Present the entries newest first with the verdicts beside them. List every newly blocked form for the user, since every builder meets it once pipelex-plugins re-vendors.

## Step 4 — Find the ledger item and make the worktree

Every change here lands through a ledger item and a worktree: the ledger's guard refuses edits in the main checkout, and `/ledger-land` refuses a topic branch that names no item.

1. **Look before filing**: `ledger similar "tools-wasm <TARGET>" --repo pipelex-sdk`. The usual source of one is pipelex-plugins or the engine's release, filed with `--after-release vscode-pipelex@pipelex-tools-wasm/v<TARGET>` so it becomes ready once the tag lands. When the item found is still `blocked_by` vscode-pipelex's release or publish item although Step 1 showed the version installable, tell the user, with the tag, the `Releases` run and the served tarball as the evidence; closing that item is its owner's gesture, not this skill's.
2. **If there is none, file one**: `ledger new --owner pipelex-sdk/js --type task --complexity trivial --topic tools-wasm-<TARGET with dots as dashes> --title "Pin js/ on @pipelex/tools-wasm <TARGET>, so the edit hook can be re-vendored on its schema" --gist "tools-wasm <TARGET> pin"`. Raise the complexity when Step 3 found an API change.
3. **File the downstream re-vendor now, unless one exists.** `ledger show <id>` prints a `blocks:` line, and a pipelex-plugins item there is the re-vendor; failing that, `ledger similar "re-vendor check.mjs tools-wasm" --repo pipelex-plugins`, whose matches may name no version, since one `make vendor-hook` serves any engine. When there is none: `ledger new --owner pipelex-plugins --type task --complexity trivial --title "Re-vendor check.mjs on @pipelex/tools-wasm <TARGET>" --gist "re-vendor hook tools-wasm <TARGET>" --blocked-by <id> --discovered-from <id>`. Until pipelex-plugins runs `make vendor-hook` from a pipelex-sdk `dev` carrying this pin, its `make check-hook-fresh` release gate reports the bundle stale, and builders keep the old schema.
4. **Make the worktree**: `wt add --for <id>` creates `_pipelex-sdk--<topic>` on `feature/<Topic>`. Move into it and run `ledger claim <id> --renew`. A session already in that worktree only renews the claim. A subagent cannot move itself: it prefixes each `Bash` call with `cd <worktree> &&` and names the worktree's path in every other file call.

Everything from here on runs in the worktree.

## Step 5 — Move the pin

In the worktree's `js/`:

1. **Build the hook once on the pinned engine and keep a copy outside the tree**: `npm ci && env -u PIPELEX_TOOLS_WASM_PATH npm run build:hook`, then copy `dist-hooks/check.mjs` to the session's scratchpad as `check-before.mjs`. `wt add` does not install `js/` (the root's `make install` only wires the git hooks), so the `npm ci` is needed. Sweep this copy against the target's corpus now, with the second command of Step 6.3: it needs only the target's tag, so it can run while npm is still processing the release, and its failures list exactly the entries whose verdict the bump flips.
2. **Install the target exactly**: `npm install --save-exact @pipelex/tools-wasm@<TARGET>`. Without `--save-exact` npm writes `^<TARGET>`, and the pin stops being the version the bundle's provenance names. Confirm that both `node -p` lines from Step 1 now read `TARGET` and the manifest has no caret.
3. **Read the lock's diff**: `git diff --stat` names `js/package.json` and `js/package-lock.json` only, and the lock has two hunks: the root package's `devDependencies` line, which mirrors the manifest, and the `node_modules/@pipelex/tools-wasm` entry (its version, `resolved` and `integrity`). Anything else moved means the install resolved more than the engine; restore the lock from `HEAD` and install again rather than shipping an unread dependency move.
4. **Search for the old version in prose**: `grep -rn "<PINNED>" js/docs js/README.md js/src`. The docs name the pin's policy rather than its value today; if one does name it, update it. Dated `CHANGELOG.md` entries stay as they are.

## Step 6 — Run the gate and the proofs

1. **The gate**: `make -C js agent-check` and `make -C js agent-test`. The type check is where an API change shows. On a red gate, connect the failure to the Step 3 entry that caused it before proposing a fix. Nothing in `js/`'s tests runs the engine, so a green gate says the hook still compiles against it, not that it lints as the release says.
2. **The bundle and its provenance**: `env -u PIPELEX_TOOLS_WASM_PATH npm run build:hook` in `js/`, then `sed -n 3p dist-hooks/check.mjs` must end `+ @pipelex/tools-wasm <TARGET> (npm)`. The SDK commit in that line is the worktree's, which is expected; pipelex-plugins rebuilds from `dev` when it re-vendors. Note the bundle's size beside the old one's (`wc -c`), since the inlined WASM dominates it and a large jump is worth a line on the item.
3. **The corpus sweep**, from the worktree's root:

   ```bash
   python3 -I .claude/skills/bump-tools-wasm/scripts/sweep_corpus.py --ref pipelex-tools-wasm/v<TARGET>
   python3 -I .claude/skills/bump-tools-wasm/scripts/sweep_corpus.py --ref pipelex-tools-wasm/v<TARGET> --bundle <scratchpad>/check-before.mjs
   ```

   The script reads the MTHDS Test Corpus vscode-pipelex carried at the engine's tag (`test-data/mthds-corpus/`, read with `git archive`, no checkout moved) and runs the bundle on every entry as a Claude `PostToolUse` `Write`, offline, from a temporary copy. Its rule is the corpus contract's, the one pipelex-plugins' corpus test applies: an entry whose `error.*` tag has `fails_at = "schema"` in the corpus's `vocabulary.toml` must block with a schema diagnostic, and every other entry must pass with nothing on stdout or stderr. It exits 0 on a pass, 1 on a broken rule and 2 when it could not answer, with a Markdown report. The hook fails open and answers only with JSON on stdout, so a bundle that crashes, prints anything else or hangs past a minute on some entry is reported as could not answer, naming the entry, rather than as a broken rule, since the corpus cannot judge a bundle that gives no verdict.

   - **The new bundle must pass.** A failure is a disagreement between the engine and the corpus it was released against, or between the engine and how the hook drives it: it is not fixed by loosening the hook. Read the failing entry and its diagnostic, then file on vscode-pipelex when the engine refuses a form its own corpus says is valid (or accepts a fault), or fix `js/src/hooks/` here when the hook's handling is what went wrong.
   - **The old bundle is expected to fail** (it was swept in Step 5.1), and its failures are the evidence of what the bump changes: every entry listed is a form whose verdict flips, "should pass" ones being forms the hook stops blocking and "should block" ones being forms it starts blocking. They should match the Step 3 verdicts; an unexplained one is worth reading before going on.
   - **A tag that carries no corpus** (engine releases before the corpus was vendored) answers 2: say the sweep could not run and rely on the changelog reading alone.
4. **Probe what the corpus does not cover.** The corpus holds the forms its authors wrote, so a `(Breaking)` entry can refuse something no entry exercises: 0.5.0's reworked `PipeJudge` refuses every judge 0.4.0 accepted, and the corpus has no invalid judge to show it. For each Step 3 verdict the sweep left unproven, write the smallest `.mthds` that holds the form (a domain, a `main_pipe` and the one pipe) in the scratchpad, and run both bundles on it:

   ```bash
   python3 -I .claude/skills/bump-tools-wasm/scripts/sweep_corpus.py --probe <scratchpad>/<form>.mthds
   python3 -I .claude/skills/bump-tools-wasm/scripts/sweep_corpus.py --probe <scratchpad>/<form>.mthds --bundle <scratchpad>/check-before.mjs
   ```

   Each prints whether the hook blocks or passes the file, with its diagnostics, and exits 0. It exits 2, saying why, for a file that does not end in `.mthds`, which the hook ignores and so would pass on both bundles, and for a bundle that crashed or hung on it. A probe that flips between the two is a verdict proven; one that does not is a Step 3 reading to correct before the changelog repeats it.

## Step 7 — Write the changelog entry

In `js/CHANGELOG.md`, under `## [Unreleased]`, in `### Changed` (create either heading when it is missing, in the order `.claude/rules/changelog.md` at the workspace root gives), add one bullet in the workspace's shape: a bold title naming the hook, then what someone whose agent writes `.mthds` now sees. No `(Breaking)`: the published package's API and behaviour are unchanged, and the hook's consumers learn of newly blocked forms from the engine's own changelog and pipelex-plugins'. Restate the engine's schema entries as what the hook now blocks and stops blocking, drawn from the Step 6 sweep and probes, and leave out entries that reach neither seam (`plxt` commands, the extension, release machinery). The entry for 0.4.0 is the model:

```markdown
- **The `.mthds` check hook's lint engine moves to `@pipelex/tools-wasm` 0.4.0**: the bundle built by `npm run build:hook` now embeds `@pipelex/tools-wasm` 0.4.0, whose MTHDS schema accepts binding steps in a `PipeSequence`'s steps, a dotted `batch_over` on a sequence step, and the `PipeDocGen` and `PipeJudge` pipe types, and refuses dotted input names, so the hook no longer blocks those valid forms and blocks a dotted input name with a schema error.
```

When `[Unreleased]` already says the hook moved to an earlier engine version that was never released, edit that bullet so it names `TARGET` and describes the combined change, instead of adding a second one. A changelog entry never carries a ledger id. This skill never touches the root `VERSION` or `js/package.json`'s `version`; only a release moves them.

## Step 8 — Commit, review, and open the pull request

1. **Commit in the worktree, staging by name**: `js/package.json`, `js/package-lock.json`, `js/CHANGELOG.md`, and any doc or hook source Step 5 or 6 changed. The pre-commit hook runs; never pass `--no-verify`. A message such as `Pin @pipelex/tools-wasm <TARGET> in js/` is enough, since the pull request's title is what survives the squash.
2. **Record the readings on the item** with `ledger note <id> "…"`, once the last commit is made: the gate's result, the provenance line, both sweep summaries with the entries whose verdict flipped, the probes, the API diff's verdict, and the bundle size before and after. Leave the commit's SHA out, since an amend or a review fix would leave it stale and the branch already names the commit. Whoever lands the branch, and whoever re-vendors in pipelex-plugins, has none of this session's context.
3. **Run `/rev`.** It derives the depth from the diff and the item, and no topic branch merges into `dev` without a recorded pass. A pin and lock move with no hook change usually resolves to the lightest profile.
4. **Ask before pushing and opening the pull request**, since both are visible to others. The pull request targets `dev`. Its title is `<branch> · L-<id>`, adding ` — <gist>` only when the gist says something the branch does not. Its body is two or three sentences on what the hook now blocks and stops blocking, then `Closes L-<id>`.
5. **After the merge**, `/ledger-land` closes the item, and the re-vendor item filed in Step 4 becomes ready for pipelex-plugins. This skill never merges and never touches pipelex-plugins.

## Rules

- Stage files by name; never `git add .` or `git add -A`.
- Never push, open a pull request or merge without the user's explicit yes.
- Build and sweep only the npm engine: every `build:hook` here runs with `PIPELEX_TOOLS_WASM_PATH` removed, and the provenance line must say `(npm)`.
- Keep the pin exact; a caret in front of the engine's version is a bug.
- An engine that disagrees with its own corpus is vscode-pipelex's to fix: file it there instead of teaching the hook to tolerate it.
- Stop as soon as a step fails or the user wants to abort, and say where the work was left: the worktree, the item and its claim.
