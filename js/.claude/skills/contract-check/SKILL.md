---
name: contract-check
description: Detect interface-contract drift between @pipelex/sdk's client surface and the wire specs it implements (defaults to comparing against the release the SDK last shipped in, but the user can specify any tag or commit). Compares the PipelexApiClient request/response shapes against the specs that govern it in the workspace root's docs/specs/, which the skill's spec table lists (../../docs/specs/ from js/). Use when the user says "check the contract", "contract review", "contract check", "did we break the contract", "check interfaces", "API contract", "protocol drift", "compare to vX.Y.Z", or before shipping/releasing a version that touches the client wire surface. Also run by the repository root's /release skill when a release ships the SDK and touched its wire surface.
---

# Contract Check

Detects discrepancies between the wire surface `@pipelex/sdk` implements and the specs that document it. The SDK's `PipelexApiClient` is a client of the Pipelex hosted API: it re-implements the official MTHDS protocol routes (`execute` / `start` / `validate` / `models` / `version`) using `mthds/protocol` types, and adds the Pipelex-product routes (methods catalog, organizations, billing, API keys, storage, onboarding). A discrepancy means the code and the spec disagree — but this skill does NOT presume which side is wrong. The code may need fixing, the spec may need updating, or both. That judgment belongs to the human reviewing the report.

Run this skill's commands from `js/`, the SDK's directory in `Pipelex/pipelex-sdk`: the spec paths below and the paths Step 2 diffs are relative to it.

## Prerequisites: Locate the Specs

The specs live in the workspace root's `docs/specs/`, which is `../../docs/specs/` relative to `js/`: the workspace root is the parent of this repository's root, whether that root is the main checkout or a worktree, since worktrees sit flat at the workspace root. Before doing anything else:

1. Check that the directory `../../docs/specs/` exists.
2. Check that it contains every spec of the table below.

If the directory is missing or does not contain the expected spec files, **stop immediately** and tell the user the specs directory was not found and they need access to the workspace-root `docs`/`specs`.

### The spec set in scope

This table is the one map from the SDK's code to the specs that govern it; Step 4 reads it.

| Spec | What it governs in the SDK |
|---|---|
| `pipelex-mthds-protocol.md` | **implements/consumes** — the protocol routes `client.ts` re-implements (`execute`, `start`, `validate`, `models`, `version`): the validation report and its union, the model deck, the version handshake, the RFC 7807 errors, `pipe_ref` identity, and the records on run artifacts (concept refs, absence records, `TokensUsage`, in `models.ts` and `runs.ts`) |
| `pipelex-validation-api.md` | **implements/consumes** — the `/v1/validate` verdict surface (`PipelexValidationResult` discriminated on `is_valid`, presentation-vs-contract) |
| `pipelex-platform-api.md` | **consumes** — the hosted routes beyond the protocol, whose Rule 5 names the SDKs as their clients: the typed hosted options and the reserved-keys guard (`client.ts`, `RESERVED_EXTRA_KEYS` and `buildExtensions`); the method-selection law, one selector among inline, `method_ref` and `method_id`, which `client.ts` enforces before sending; run creation and the two starts; the run state, the status poll and the results fetch with its 202/200/409 matrix and `?artifacts=` (`runs.ts`); the failed run's 409 (`errors.ts`); storage resolve and bulk resolve with its bound (`artifacts.ts`); the identity probe `GET /v1/me`; and the run history, `GET` and `PUT /v1/runs/{id}` (`client.ts`, `product-models.ts`) |
| `pipelex-hosted-envelope.md` | **consumes** — the error envelope and the native codes of the platform's problem documents (`errors.ts`, `error-models.ts`) |
| `pipelex-codegen.md` | **consumes/implements** — the route envelopes of `/v1/resolve`, `/v1/codegen`, `/v1/pipe-io` and `/v1/build/{inputs,output,runner}` (`client.ts`, and `prepare-inputs.ts`, which reads the pipe I/O response), and the lock format and offline check algorithm (`codegen-check.ts`) |
| `pipelex-api-mthds-tools.md` | **consumes** — `/v1/lint` and `/v1/format` and their shared diagnostic contract (`client.ts`, `models.ts`) |
| `mthds-input-form-descriptor.md` | **consumes** — the input-form descriptor as the pipe I/O route carries it (`prepare-inputs.ts`) |
| `mthds-package-references.md` | **consumes** — the `method_ref` address form the SDK passes through, and the provenance triple a run's start and execute responses carry (`MethodProvenance` in `models.ts`) |
| `client-identification.md` | **implements** — the `User-Agent` every request carries (`user-agent.ts`), and the hook's own `pipelex-mthds-check` token (`hooks/validate-client.ts`) |

The routes with no spec — the methods catalog, organizations, billing, API keys, onboarding, `/v1/upload`, `/v1/upload/grant`, `/v1/build/concept` and `/v1/build/pipe-spec` — have nothing to drift from: a contract-visible change there is reported as unspecified, under the unmatched additions, never as a discrepancy. **Before reporting a change as unspecified, search the specs for it**, since a route or field this table does not place may still be specified: `grep -rln "<the route or the field>" ../../docs/specs/`. `command-surface-map.md` gives the cross-repo view; consult it for context.

## Step 1 — Identify the Baseline

If the user specified a baseline (e.g. "compare to v0.29.0"), use it. Otherwise default to the release the SDK last shipped in: the tag `v<version>` of the version `package.json` carries, since a release moves that version only when it ships `@pipelex/sdk`. The newest tag of the repository is not that release whenever a later one held the SDK back, and taking it would skip the wire changes the SDK has not shipped yet. While that tag does not exist, which is the case before the repository's first release, the baseline is the import commit `e64f53500b5ba9c6ed0d5b413039eb8b13a7d49e`, whose `js/` is `@pipelex/sdk` 0.28.1 verbatim. Fetch the tags first, so that a checkout that has not seen the latest release does not fall back to an older baseline; the snippet stops when it cannot read the version, and says why when it falls back:

```bash
git fetch --tags --quiet origin || echo "could not fetch the tags: a release this checkout has not seen is missed" >&2
if ! version=$(node -p "require('./package.json').version"); then
  echo "no package.json here: run this from js/" >&2
elif git rev-parse --quiet --verify "refs/tags/v$version" >/dev/null; then
  echo "v$version"
else
  echo "no tag v$version, so the SDK has not shipped from this repository yet: the baseline is the import commit, @pipelex/sdk 0.28.1" >&2
  echo e64f53500b5ba9c6ed0d5b413039eb8b13a7d49e
fi
```

On a release branch after its bump, `package.json` carries a version no tag names yet, and the fallback is wrong there: name `v<the version package.json carried before the bump>` instead, which the base branch's `js/package.json` still carries, since the previous release's tag is not the SDK's last release whenever that release held the SDK back. Confirm the baseline with the user before proceeding.

## Step 2 — Detect Contract-Affecting Changes

Diff the baseline against HEAD over the SDK's sources and its changelog:

```bash
git diff --relative <baseline> HEAD --name-only -- src/ CHANGELOG.md
```

The whole of `src/` is diffed rather than a list of files, because the wire surface spans most of its modules — `client.ts` (the routes), `models.ts` and `product-models.ts` (the request and response models), `errors.ts` and `error-models.ts` (the typed errors and the problem documents), `runs.ts` (the run lifecycle), the upload and artifact modules, and `index.ts` (what the package exports) — and a list goes stale as soon as a module is added. Step 3 separates the contract-visible changes from the internal ones. `--relative` prints the paths relative to `js/`, as Step 3 takes them back.

If **no files changed**, report that no contract-affecting changes were detected and stop. Otherwise proceed.

## Step 3 — Classify the Changes

For each changed file, get the diff (`git diff <baseline> HEAD -- <file>`) and classify each change as:

- **Contract-visible**: changes to route paths, request/response models, wire-shape fields, request headers (the `User-Agent` and its tokens), HTTP status semantics, error shapes/types, or the validate verdict discriminant; changes to a client-side guard that enforces a spec clause, such as the reserved-keys guard, the method-selector checks or the bulk-resolve bound; and changes to the codegen lock's format or to the offline check's verdicts, which never touch the wire.
- **Internal-only**: refactors, logging, cosmetic changes that change none of the above.

Also scan CHANGELOG entries since the baseline for mentions of new/removed/renamed routes or fields, changed verdict/error protocol, or HTTP status semantics.

## Step 4 — Review Against Specs

For each contract-visible change, read the relevant spec and determine:

1. **Is the change documented in the spec?**
2. **Does the change contradict the spec?**
3. **Is the change absent from the spec?**

The spec to read is the one the table under **The spec set in scope** maps the changed module, route or field to, under `../../docs/specs/`; a change it does not place is searched for there before it is reported as unspecified.

**When citing a spec surface, note its conformance status.** Each verified surface carries a `> Verified by:` line pointing at the `conformance/` test that exercises it (or an explicit unverified marker). Include that target so the reviewer knows whether a test already guards it.

## Step 5 — Report

Produce a **self-contained** report (readable by an agent in another repo). Start with a header block (date, repo `@pipelex/sdk`, branch, baseline, target HEAD, specs checked), then a summary table (Discrepancies / Unmatched additions / Aligned changes with counts and a one-line verdict), then detailed sections:

- **Discrepancies** — for each: what the code does (file:line), what the spec says (file:section + conformance status), and which side moved. Do NOT prescribe the fix.
- **Unmatched additions** — behaviors present in only code or only spec; state which side has it.
- **Aligned changes** — brief list for completeness.

## Step 6 — File the Actionable Findings as Ledger Items

The report is printed, never saved to a file: a saved report is the ad hoc follow-up list the workspace ledger replaced. Each discrepancy or unmatched addition that somebody must act on becomes one workspace ledger item. Aligned changes stay in the printed report.

- **Ask which side moves before filing.** This skill does not decide whether the code or the spec is wrong, so the owner comes from the user's answer: a code fix is owned by `pipelex-sdk/js`, a spec edit by `workspace`, since `docs/specs/` lives in the meta-repo. A finding the user leaves undecided is filed as a `decision` owned by `workspace`, its body naming both sides.
- **Fix in place what belongs here, except under a release.** A finding whose fix is a small, obvious change in this repo is made in this session, after asking the user; it is filed only when it is genuinely out of scope. When the repository root's `/release` runs this skill, nothing is fixed in place: the release commit stages only its own files by name, so a fix made in the release worktree would stay uncommitted or ride into `main` without a topic branch and its `/rev`. File it instead.
- **Check for an existing item first**, since this check runs before every release and the same drift resurfaces: `ledger list --ref skill:contract-check --status open`. When an open item covers the finding, record the sighting on it (`ledger note <id> "Still open at baseline <baseline> → HEAD <short-sha>."`) and name the id in the report.
- **File the rest** with `ledger new --owner <repo> --type bug|spec|task|decision --title "…" --gist "…" --ref skill:contract-check`, the body carrying the report's evidence for that finding (file:line, spec section, conformance status), so an agent in `docs` or `conformance` can act without this repo. The `/ledger` skill has the full command reference.

## Notes

- **Specs and conformance are a linked pair.** If a finding's resolution is to edit a spec, the matching `conformance/` test must change in the same commit, and `make check-spec-links` (run in the `conformance/` repo) must pass — it enforces the bidirectional `> Verified by:` ↔ `pytestmark = pytest.mark.spec(...)` links.
- The most critical surface is the protocol wire shape, because AI agents, the plugin, and `pipelex-app` depend on its exact format.
- This skill detects discrepancies — it does not assign blame. Code, spec, or both may need updating. That's a human decision.
