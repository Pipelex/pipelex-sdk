# Codegen: generated types from `.mthds` bundles

This is the reference for the code-generation workflow behind `src/generated/` — why it exists, how the commands relate, what the trust chain guarantees, and the workaround it currently carries. The day-to-day rules live in [`CLAUDE.md`](../CLAUDE.md) ("Generated types"); this document is the deeper "why" behind them.

## Why

Everything our tools can build deterministically should be built by them. Before codegen, the gallery this template was extracted from, `pipelex-starter-js`, hand-wrote in `src/types/` the very thing each method already declares in its `.mthds` bundle: the output concept's shape plus a hand-rolled runtime narrower per shape. That is a duplicated type surface with no drift guard — edit a bundle's structure and nothing tells you the TypeScript is now lying.

`@pipelex/sdk` exposes the crate routes: `client.codegen({ kind: "types", target: "ts-zod" })` projects a method's normalized library crate into stamped typed artifacts — a `types.ts` (zod schemas + inferred types), a `binder.ts` (typed `parse<Name>` / `serialize<Name>` pairs), and a `codegen.lock` — byte-identical to a local `pipelex codegen types` run. The same run additionally asks `/v1/validate` for the method's pipe IO contracts and **both** of its wire form descriptors (opting in with `views: ["input_form", "output_form"]`) and writes a `contracts.ts` (see [The contracts artifact](#the-contracts-artifact)), so one command keeps the output types, the input forms and the result view honest together. The SDK also ships `runCodegenCheck`, the pure offline drift check: a port of pipelex's `codegen check` that reaches the same verdict over the same bytes, down to the drift `detail` sentences.

The design goal in one sentence: **`npm run codegen` regenerates committed, typed, zod-validated artifacts for every method in `methods/`, `npm run codegen:check` proves offline that they are current, and the app's narrowers are thin adapters over the generated binders.**

## The commands

The npm scripts are the primary interface — this is a JS template and `npm run` is what its consumers reach for. The Make targets (`make codegen`, `make codegen-check`, `make codegen-verify`) are thin wrappers.

| Command                  | What it does                                                                                                                         | Needs network / key?                                       | When                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ |
| `npm run codegen`        | Regenerate `src/generated/<method>/` for every method in `methods/`, via `POST /v1/codegen`                                          | Yes — `PIPELEX_API_KEY` + a base URL that serves the route | Dev action: after editing any `.mthds` file            |
| `npm run codegen:check`  | Offline drift check of every generated tree against its `codegen.lock` and sources sidecar                                           | No — pure hashing                                          | CI action: part of `make check`, so `make all` runs it |
| `npm run codegen:verify` | Re-run `codegen()` live and compare its `crate_fingerprint` to each committed lock's — the _semantic_ staleness gate. Writes nothing | Yes — same as `codegen`                                    | Before a release, or in a keyed CI job                 |

Regeneration is the dev action, the offline check is the CI action — the split pipelex's codegen engine is designed around, so engine improvements never redden a consumer's CI. `npm run codegen` stays out of `make all` for the same reason `test-e2e` does: it needs a key and a network.

## Layout

```
methods/                              # <method> and <other-method> are your own methods' names
  <method>/main.mthds                 # source of truth — a bundle in this repo
  <other-method>/method.json          # source of truth — a selector naming a method elsewhere
src/generated/                        # committed, generated, never hand-edited
  <method>/
    types.ts                          # zod schemas + z.infer types — imports only `zod`
    binder.ts                         # parse<Name> / serialize<Name> over the schemas
    contracts.ts                      # PIPE_IO_CONTRACTS + INPUT_FORM + OUTPUT_FORM — the gate's contract, the forms' descriptor, the result's
    codegen.lock                      # pipelex trust-chain lock, written verbatim
    sources.json                      # app-owned staleness sidecar (see below)
  <other-method>/ …                   # same set per method
scripts/
  codegen.mts                         # CLI entry — npm run codegen
  codegen-check.mts                   # CLI entry — npm run codegen:check
  codegen-verify.mts                  # CLI entry — npm run codegen:verify
  add-method.mts                      # CLI entry — npm run add-method (see docs/add-method.md)
  lib/
    generate.mts                      # the generator: runGenerate, generateMethod, fetchGenerated, writeGenerated
    check.mts                         # the offline check: runCheck, checkMethod, summarizeVerdicts
    verify.mts                        # the keyed semantic gate: runVerify
    shared.mts                        # paths, walk, sha256, discoverMethods, readManifest, the sidecar
    api.mts                           # the network-facing half the keyed entry points share
    add-method.mts                    # the scaffold, over generate.mts's own fetch/write halves
tsconfig.scripts.json                 # type-checks scripts/, the tsconfig.e2e.json pattern
```

One generated tree per method, mirroring `methods/` one-to-one: each method is its own closure, so each gets its own crate, artifact set, and lock. The trees live under `src/` so the `@/` alias reaches them and `tsc` type-checks them as part of the app.

## Two source kinds

A method directory says where its method lives, and there are two answers. It holds either **`.mthds` files** — the bundle is in this repo — or a **`method.json` manifest** naming a method that lives elsewhere:

```json
{ "method_ref": "github.com/Pipelex/methods/text_stats@v0.1.1" }
```

Exactly one selector key, `method_ref` (a published package address) or `method_id` (a method saved under your key's organization), as a non-empty string; both keys, neither, an unknown key, or a non-string value is a refusal with no verdict, the way a non-UTF-8 source is. A directory holding **both** kinds is refused naming the two, because they would disagree about where the tree came from; a directory holding neither is skipped, as it always was.

`discoverMethods` returns a `MethodSource` discriminated on `kind`, with `name` and `sourceHashes` common to both arms — so every kind-blind gate reads those two members and needed no change at all. In particular:

- **The offline check is untouched in logic.** `compareSidecar` hashes `method.json` exactly the way it hashes a bundle, so editing a tag and forgetting to regenerate fails `make check` with the same "run `npm run codegen`" remedy. That is the feature, not a side effect: **bumping a published method's version is a one-line edit plus a regeneration.**
- **Orphan detection is unchanged** — a generated tree with no `methods/<name>/` behind it is still an orphan, and a method with no tree is still the other half.
- **`npm run codegen` regenerates both kinds in one pass.** A selector-sourced tree is not a second regeneration path; `make add-method` writes its tree by calling the generator's own halves, so a scaffolded tree is byte-for-byte the tree a regeneration would write.

What actually differs is two calls. For a bundle source, `validateFiles(files, { views: VALIDATE_VIEWS })` and `codegen({ files, … })`; for a selector source, `validate(selector, …, VALIDATE_VIEWS)` and `codegen({ ...selector, … })`. `VALIDATE_VIEWS` (`scripts/lib/shared.mts`) is the opt-in declared once, because `codegen:verify` re-renders a live response to compare against the bytes `codegen` wrote — one script asking for a view the other does not would read as drift on a tree nobody touched. `codegen:verify` branches the same way, re-resolving by selector where it re-resolves by files.

Two consequences worth stating plainly. A **`method_id`** slice regenerates only with a key of the same organization, since the catalog is org-scoped — which is why a published address is the portable form. And a selector is resolved **server-side**, so the base URL has to forward it; see the handshake below.

[`docs/add-method.md`](add-method.md) is the reference for the gesture that adds a method of either kind — it copies a bundle into `methods/<name>/` or writes a manifest there — and writes the app files around it.

**Committed, deliberately.** A template consumer must see the generated code without holding an API key, `git clone && make all` must pass keyless, and the diff of a regeneration is itself documentation of what a bundle edit changed. The offline check keeps the committed tree honest.

## The contracts artifact

`src/generated/<method>/contracts.ts` is the one artifact in the tree the codegen route does not produce. It carries three payloads of one `POST /v1/validate` call, all keyed by namespaced pipe ref and typed against the form kernel's re-exports through a type-only import: `PIPE_IO_CONTRACTS` (the `pipe_io_contracts` payload — what the run gate validates against, and where the result's payload schema lives on `output.json_schema`), `INPUT_FORM` (the wire input-form descriptor — what [the input forms](input-form.md) derive their fields from, co-walking the contract) and `OUTPUT_FORM` (its twin on the other side of the contract — one `field` node per pipe saying what the result IS, which the kernel's `buildResultField` pairs with the payload schema into the single field the result view renders). One file for all three, deliberately: same response, same keys, consumed together.

Two facts about the output side are worth stating because they are easy to get wrong. **Plurality is on the descriptor, never on the concept** — a `Concept[]` output is a `list` node whose `item` is the element, and a consumer reads that rather than the contract's `multiplicity`. And **the output contract's `json_schema` describes the payload, not a caller's argument**: `TextContent {text}` for a `native.Text` result, the list content model for a plural one. Mirroring the input side's plural rule and emitting a bare array there would describe a payload no runtime produces. They belong beside the types for exactly the same reason those are committed: a consumer must see them without a key, and the diff of a regeneration shows what a bundle edit changed.

`INPUT_FORM` and `OUTPUT_FORM` are emitted with an `as` assertion rather than a `:` annotation, and that is a workaround with an expiry: the deployed hosted engine still emits a `name` on a list's `item`, a member the standard's closed shape forbids and `InputFormItem` therefore does not declare, so tsc's excess-property check rejects the annotated literal. The output side inherits it exactly, because an output node is an input node minus its slot facts and a plural output is a `list` with the same `item`. The fix is upstream in pipelex 0.54.0 (#1155); once the hosted engine carries it, a regeneration drops the member and the emitter reverts to annotations so the compiler guards the emitted shapes again.

It is fetched with the SDK's `validateFiles`, not `validate`. Not for ergonomics: `validate` takes parallel `mthds_contents` / `mthds_sources` arrays and the server `422`s a length mismatch, so hand-building them is a latent bug that surfaces at the first two-bundle method. The call is placed **last** in the per-method sequence, after the codegen artifacts have passed their own self-check, so a failed validate leaves the tree untouched rather than half-updated. An `is_valid: false` verdict fails the method exactly like a failed codegen.

**It carries no codegen stamp, deliberately.** The SDK's orphan rule is "a _stamped_ file the lock does not track", and the writer deletes orphans — an emitter that imitated the stamped files beside it would produce a file that silently vanished on every regeneration.

That leaves it outside the lock's protection, which is not acceptable when the two artifacts beside it are protected against precisely this. Re-signing the lock locally was rejected — the lock signs what `POST /v1/codegen` returned, and forging that destroys the one property that makes a committed tree traceable to a server response. So the `sources.json` sidecar grew a second half: a `derived` map of artifact filename → SHA-256, written by the generator from the content it wrote, compared by the offline check. Two shapes inside it are load-bearing: the hash is taken from the **written content**, not a re-read, and the expected set is a **constant** (`DERIVED_ARTIFACTS`), never the sidecar's own keys — otherwise an empty `derived` map certifies itself. The check reports the usual four states: hand-edited, missing, unrecorded, and recorded-but-no-longer-generated.

`codegen:verify` covers it too, by re-fetching `/v1/validate` and comparing the **rendered bytes** (which is why the renderer is shared by all three scripts). The crate fingerprint says nothing about a different route's response, and an artifact no keyed gate covers is one nobody will notice has gone stale. One asymmetry with the fingerprint check: an engine bump is a _note_ there, because `engine_version` rides in every stamp; contracts carry no engine version, so any difference in them is a real content difference and is reported as a failure.

## The trust chain

**The server's artifacts are written verbatim.** Every `artifacts[]` entry lands at its `path` and the lock content at `codegen.lock`, byte-for-byte, so the tree is identical to a local `pipelex codegen types` run — same stamps, same lock — and the offline check holds. Editing an artifact or re-serializing the lock breaks the chain, which is why `src/generated/` is excluded from Prettier and ESLint (the emitter targets Prettier's defaults at 80 columns; this repo prints at 100, so a reformat would rewrite bytes and break every stamp). `tsc` keeps full coverage — the trees are inside `src/` and the base tsconfig — and that is the check that matters.

The generator also mirrors pipelex's own write discipline:

- **Write-if-changed** — no mtime churn, clean diffs, a full regeneration over a current tree is a true no-op.
- **Orphan cleanup defers to the checker.** Stale artifacts that dropped out of the set are removed, but the authority on what may be removed is `runCodegenCheck`'s own `orphan` verdict over the tree just written — not a filename test. A suffix test answers "could this file type be an artifact"; the SDK's orphan rule additionally requires the file to carry a codegen stamp. Deleting on the weaker test would destroy any hand-written sibling `.ts` a consumer parks in the tree — the very "sibling module" the generated header recommends for declaration merging. Deferring to the check makes the writer and the checker agree by construction.
- **A renamed lock is refused, not followed.** The offline check opens `codegen.lock` by name; if the server ever returns a different `lock_filename`, silently following it would leave the old lock in place for the check to keep validating — green, from the wrong file. The writer reports it and writes nothing.
- **Self-verify before writing.** The generator runs `runCodegenCheck` over the server's own response before touching disk; a tree that would fail its own check is never written.

## Two staleness gates, because they answer different questions

The offline check proves the tree matches the lock; it deliberately never proves the tree is current with the _bundles_, since that needs the engine. So there are two gates:

- **Offline (`codegen:check`, in `make check`)** — the `sources.json` sidecar. `npm run codegen` writes it beside each lock: the repo-relative path and SHA-256 of everything the method is generated from — every source `.mthds` in the closure, or the `method.json` manifest naming where it lives — compared on every check. Edit a bundle or bump a manifest's tag, forget to regenerate, and `make check` fails with "run `npm run codegen`" instead of shipping silently stale types. Coarse and knowingly so — a byte hash where the crate fingerprint is semantic, so reformatting a bundle trips a false "stale" whose remedy is a regeneration that write-if-changed turns into a clean no-op. Hashing normalizes CRLF and lone CR first, so a Windows checkout is not a false stale. The sidecar is app-owned, unstamped, and outside the lock (which stays byte-exact); the check also covers the whole-tree cases a single tree cannot see — a method with no generated tree, and a generated tree with no method behind it.
- **Keyed (`codegen:verify`)** — the semantic gate the sidecar approximates. The script re-runs `codegen()` live and compares its `crate_fingerprint` against each committed lock's, writing nothing. No false positives on reformatting — the fingerprint is semantic — but it needs a key and a network, so it stays out of `make all` and complements the sidecar rather than replacing it.

**Exit codes are a contract**: `0` current, `1` drift or stale sources, `2` no verdict. No-verdict causes: a missing or malformed lock; a `lock_version` this SDK build does not know (whose message names the version found and says to bump `@pipelex/sdk`, not to touch the tree); a refused symlink or special file; a non-UTF-8 `.mthds` source; or any other tree-read failure — in that last case the check prints the underlying message and never the regenerate remedy, which would claim a verdict the run did not produce. Aggregation across methods is by precedence — no-verdict outranks drift outranks current — because as long as any method could not be checked, the run has not produced the full verdict a `0` or `1` would claim. A per-category summary line (`N current · N drift · N no verdict`) at the end shows the mix the single exit code cannot.

## Gate fidelity policies

The verdicts above are only worth trusting because of a few deliberately loud policies in the shared layer (`scripts/lib/shared.mts`), each of which replaced a way the gate could be _silently wrong_:

- **Symlinks and special files are refused by name.** Anything under `methods/` or a generated tree that is not a regular file or a directory — a symlink, FIFO, or socket, including a symlinked tree root, method directory, or the `methods/` / `src/generated/` roots themselves — throws `SymlinkRefusedError` naming the path, and the check reports no verdict. Following symlinks would need cycle handling, and a symlinked `.mthds` used to drop out of the codegen closure _and_ `sources.json`, so editing it never tripped `stale-source`.
- **UTF-8 decoding is fatal.** Every text read goes through `readTextFile`, which throws `NonUtf8FileError` instead of substituting U+FFFD. A lossy decode could hash a corrupted artifact to its locked value and report it `current`. The error maps by ownership: in a generated tree it is drift (regenerating rewrites the file), in a `.mthds` source it is a refusal (regenerating would ship garbage to the API).
- **A case-mismatched tree gets a rename remedy, never a delete.** On a case-insensitive filesystem (macOS's default) the per-method check happily opens a tree whose on-disk name differs from the method's in case only and certifies it current; a byte-wise orphan scan would then print a delete remedy for that same tree. The scan case-folds the comparison and reports "rename `src/generated/<X>/` to `<y>`" as drift.
- **Orphan detection runs even when `methods/` is empty.** Generated trees left behind after the last method was removed report as orphans (drift), not "nothing to check". An app with no method and no leftover tree — the state the template ships in — is current, and a missing `methods/` directory counts as no method, since git keeps no empty directory.
- **The scripts are cwd-independent.** `REPO_ROOT` anchors on `import.meta.dirname`, not `process.cwd()`, so running a script from any directory produces the same verdict instead of a raw ENOENT.
- **A server-named artifact path may not escape its tree.** `codegen.mts` runs every `artifact.path` in the response through `isContainedPath` before the first write, and refuses the whole method — nothing written — if one resolves outside `src/generated/<method>/`. `writeIfChanged` creates directories recursively, so a `..` in a path the writer trusted would land a file wherever the process can reach, in a place no stamp guards and no check ever looks. This is the response half of the same exposure the base-URL guard below closes on the wire.
- **The keyed scripts refuse a plaintext `http:` base URL for any non-loopback host** (`assertSecureBaseUrl`; `localhost`, `*.localhost`, `127.0.0.1`, and `[::1]` are allowed). They send the API key as a bearer token and write server-supplied TypeScript into the repo, so a non-local plaintext URL exposes both on the wire.
- **A base URL that cannot resolve a selector is named before anything is fetched.** When any discovered source is selector-sourced, the keyed scripts ask `GET /v1/version` once and refuse — nothing written — if its `extensions` array lacks the kind they need, naming the base URL, the missing kind, and what it does advertise. Without the handshake the failure is a bare `403`, which on an env-scoped key says nothing at all about forwarding. Two cases deliberately **proceed** rather than refuse, because the handshake has no verdict to give and the real call's own error is the better message: the handshake itself failing, and a response that advertises no capabilities at all. `explain()` learns the matching resolution failures — a 404 from a selector call means the route is there and the method is not, so the server's own message (which for a bad address lists the packages the repository does contain) is printed **verbatim** rather than replaced by a guess about `PIPELEX_BASE_URL`.

**An engine bump restamps everything, and that is expected.** `engine_version` rides in the artifact stamps, so an upstream pipelex release restamps the whole tree with zero semantic change — `crate_fingerprint` is the semantic signal, and it stays put. `codegen:verify` reports an engine difference as a **note**, not a failure, leaving the whole-tree restamp to a deliberate commit.

## The narrowers are adapters, and the list workaround

Each `parseXxx(results: RunResults)` narrower in `src/types/` hands `wireOutput(results)` to the generated binder and translates a thrown `ZodError` into the app's tagged error model (`describeSchemaFailure` renders it through `z.prettifyError`, because a `ZodError`'s own `.message` is a JSON dump). Generated types flow to the components with their wire-native snake_case keys (`doc_type`, `public_url`); a camelCase mirror would be exactly the duplicated surface codegen removes.

**The runtime's explicit `null`s need no normalization.** The runtime serializes an unset optional concept field as an explicit `null`, and the ts-zod projection emits a non-required field as `.nullish()`, so the generated schema accepts the runtime's own payload as it arrives. An earlier projection emitted `.optional()`, which rejects `null`, and the gallery this template was extracted from carried a schema-guided strip, `dropWireNulls`, to bridge the two; the template does not carry it. A tree regenerated against an engine that still emits `.optional()` would reject such a payload with a message naming the field, which is the signal to regenerate against a current engine.

**`wireListOutput` is a workaround with an expiry.** A plural output (a `multiplicity` other than `single`) is one `ListContent` in the runtime, and the runtime renders it two ways. The blocking `execute` response hydrates the working memory before serializing it, so a `ListContent` arrives as its pydantic dump, a `{ items: [ … ] }` envelope. The durable `main_stuff.json` is written by the runtime's delivery executor, which forks: when the worker can hydrate the main stuff's concept class from its global registry — a native concept such as `native.Page` — it renders the same `{ items }` envelope; when it cannot — every concept a method declares itself, whose class lives only in the per-workflow registry — it falls back to the raw working memory, where `WorkingMemory.dump_for_transport()` serializes a `ListContent` as a plain list, so `main_stuff` is a bare array. Measured live against api-dev (engine 0.56.0) on 2026-09-05: a durable run of `documents.extract_text_pages` (`native.Page`) delivered `{ items: [ … ] }`, and a durable run of a catalog method producing a method-declared `CandidateMatch[]` delivered a bare array — the same method that answers `{ items }` in Blocking mode. So a plural narrower declaring either shape is broken in one execution mode. `wireListOutput(results)` unwraps a top-level `{ items }` when it sees one and leaves anything else alone; the adapter then parses `z.array(<Code>Schema)`. It normalizes values, never names, and it is deletable the day the runtime renders a list output one way on every path. Reported upstream to pipelex.

## What is deliberately not built

- **The manifest is the whole of the selector story on this side.** `method.json` names where a method lives and nothing else; the scripts gained a second source kind and no second regeneration path, no download-the-closure-locally mode, and no per-kind gate. Everything around a method's generated tree, for either kind — the app files, the registry entry — belongs to [`make add-method`](add-method.md), not here.
- **No `resolve` example.** Codegen subsumes it for this template's purpose; the bare crate becomes interesting only for fingerprint-based caching or a custom projection.
- **No generated-code edits, ever.** Customization rides sibling extension files; the adapters in `src/types/` _are_ that sibling layer here.
- **No watch mode, no build-time hook.** Regeneration stays an explicit dev action; wiring it into `next dev` or `next build` would put a network + key dependency inside the build. The sidecar check is the forgetting-guard.
- **No per-pipe kinds.** `kind: "types"` is concept-set-wide and is the only kind served today.

## Open questions

- **`sources.json` upstreaming**: if the staleness sidecar proves its worth, it may belong in the engine's own lock story rather than an app convention. The `derived` half is the stronger candidate — any host that commits a codegen tree and emits its own artifact into it faces the same hole, and the machinery is small but easy to get subtly wrong; its natural home is beside `runCodegenCheck` in `@pipelex/sdk`.
- **The wire descriptor landed at exactly the seam built for it — beside the contracts, not in place of them.** This bullet used to say the contracts artifact was a placeholder for a purpose-built input-form descriptor, and that adopting it would be a one-artifact change at one call site. That held: the descriptor arrived as `/v1/validate`'s `views: ["input_form"]` opt-in, the fetch in the generator gained one option and one field, and the artifact stayed one file. What the placeholder framing got wrong is that the descriptor _replaces_ the contracts: the kernel co-walks the contract for the two facts the wire deliberately omits (the scalar wrapper key, nested list bounds), and the run gate validates against the contract alone — so `contracts.ts` carries both payloads.
- **`lock_version` upgrade ordering**: an SDK that tolerates a new lock version must ship _before_ the pipelex release that starts writing it. If `make check` ever fails with a version message naming a version this SDK does not know, the fix is bumping `@pipelex/sdk`, not touching the generated tree.
