# Crate routes (`/v1/resolve`, `/v1/codegen`, `/v1/pipe-io`)

Three routes project a **closure** of MTHDS files into the artifacts downstream tooling actually consumes: `resolve` emits the **normalized library crate**, `codegen` projects that crate into **stamped typed artifacts** plus their lock, and `pipeIo` derives a method's **pipe I/O contracts, input form and output form** without a dry run. They are Pipelex API extensions rather than MTHDS Protocol operations — but note the ownership split: the _crate_ and the three I/O artifacts are standard-owned (the MTHDS Library Crate Format, and the standard's pipe I/O contracts and form descriptors), while the HTTP surface serving them, and every type projection on top of the crate, are ours.

> **`resolve` and `codegen` are served on every hosted origin, and by any `pipelex-api` runner.** On the hosted plane a route is reachable only when the gateway's API-key allowlist and the platform's tooling proxy both list its path — each enumerates routes explicitly, and an unlisted path answers a gateway `403 {"message":"Forbidden"}`, refused before any service sees the request, so not even an RFC 7807 problem body. `resolve` and `codegen` are listed by both.
>
> Measured 2026-08-23 against `api.pipelex.com` (`pipelex-hosted@0.10.1`) with a real API key: an empty body to either route comes back as an RFC 7807 `422` naming the missing fields — a request-shape verdict only a route that reached the service can produce — and a real closure comes back as a `200` carrying the artifacts. `api-dev.pipelex.com` has served them since 2026-08-13. Use a key when re-measuring: unauthenticated, every path answers `401` whether or not it is allowlisted, so a keyless probe cannot tell the two states apart.
>
> **`pipe-io` is newer.** A runner serves it from `pipelex-api` v0.33.0, and types its pipe-selection refusals `EntryPipeNotFoundError` and `EntryPipeAmbiguousError` from v0.33.1, which is what `prepareInputs` branches on (see [What throws](#what-throws)); v0.33.0 typed them as the generic `ValidationError`. A hosted origin serves the route once the platform's tooling proxy and the gateway's allowlist both list it, and until then it answers the gateway's `403 {"message":"Forbidden"}`. `prepareInputs` reads this route, so it needs an origin that serves it.
>
> **`lint` / `format` are the exception and answer `403` on both origins.** That blocks nothing, because linting and formatting `.mthds` are toolchain capabilities rather than hosted ones: `plxt` carries both, and the post-edit hook this repo builds (`npm run build:hook`, vendored into `pipelex-plugins`) runs them offline through `@pipelex/tools-wasm` with no credentials — from the published package, `client.lint` / `client.format` are the documented fallback, against a runner. Exposing them on the hosted origins is a known, non-critical item on the platform's list, tracked in the workspace ledger as L-260929-b58f26.

## The shared envelope

All three take the same closure selector — the method's tree, a `method_ref`, or a hosted `method_id`, exactly one (the strict tooling XOR) — and the tree may bring its dependencies:

```ts
interface CrateRequestBase {
  files?: MethodFiles; // the protocol's map: tree path → text, { base64 } or { sha256, size }
  directory?: string; // or a directory on disk, listed by the mthds package (Node only)
  tree?: MethodTreeSource; // or a listed tree, sent inline or by hash
  contents?: Readonly<Record<string, Uint8Array | string>>; // or each file's bytes or text by tree path
  dependencies?: Record<string, MethodFiles>; // beside the tree: the packages it calls by address
  method_ref?: string; // address form server-resolved; registry form reserved → 501
  read_scope?: string; // Pipelex-API extension; the hosted platform stamps its own
}

interface PipelexHostedToolingExtensions {
  method_id?: string; // hosted-only — the platform resolves the stored method server-side
}
```

**The tree is the MTHDS protocol's `files` map**, the shape `validate`, the runs and the method catalog take: each key a tree path, each value the file's text, `{ base64 }` for bytes that are not text, or `{ sha256, size }` naming a blob the organization already holds. The runner writes the tree whole and loads it as the method's library directory, so every `.mthds` bundle is named by its tree path and every other file, a `PipeDocGen` template beside its bundle for instance, is one a step may read. The tree is given in exactly one of four forms, as a run, a validation and a save take it ([method-trees.md](./method-trees.md)):

- `files`, the map, posted as given with no round trip;
- `directory`, a directory on disk, listed by the `mthds` package's lister under the standard's membership rule and the deployment's limits, in Node only;
- `tree`, a listed source such as the `MethodTree` the `mthds` package's `listMethodTree` returns;
- `contents`, each file's bytes or text keyed by its tree path.

A `directory`, `tree` or `contents` travels as a run or a save sends it ([method-trees.md](./method-trees.md#how-a-tree-travels)): the client reads the version handshake first, then sends the tree inline when its map weighs no more than the lower of `INLINE_TREE_MAX_BYTES` (256 KiB) and the announced `max_inline_bytes`, and otherwise, against an API that declares a blob store, by hash after asking `POST /v1/blobs/missing` which blobs the organization lacks and uploading each one once; against an API with no blob store it sends the tree inline whatever its weight, refusing one past `max_inline_bytes`. A blob that fails to upload throws `MethodFileTransferError`, whose message ends "so the request was not sent", and the route is never asked. Two forms at once, a directory the lister refuses, and a `tree` holding no file, are refused with `RequestArgumentError` before any request. A `files` map is never checked client-side: a key or an entry the tree's rule refuses is the server's `422`.

**An empty map is absent**, as in the Python SDK: `files: {}` or `files: null`, `contents: {}`, `directory: ""` and `dependencies: {}` are not sent, so an empty map never reaches the wire as a second selector, and `{ files: {}, method_id: "mt_…" }` posts the `method_id` alone. A value that is not a map, such as a list, is not absent: it is posted as given and refused by the server.

When the request carries a `read_scope`, the blob route is asked under it, as `POST /v1/blobs/missing?read_scope=…`, so the missing blobs are uploaded into the store the request's hash entries are read from; each upload target the runner answers is signed for that scope, so the uploads need nothing more. The hosted platform's own blob route reads the caller's organization and ignores the query, as it does the request's `read_scope`.

**Stopping a call.** Each route takes a second argument, `CrateRouteOptions`, whose `signal` is read before each step a `directory`, `tree` or `contents` costs — the version handshake, the directory's listing, the blob route, each read and each upload of a missing blob — and before the request itself. Once it has aborted, nothing further starts and the call throws the abort; a request already sent runs to its end, since the routes take no transport options (a static route's budget is the client's own). `prepareInputs` passes its `signal` here, so an abort during the handshake leaves the blob route, the uploads and `POST /v1/pipe-io` unasked.

When the engine can attribute a diagnostic to a file, the `validation_errors[]` item's `source` names it by its tree path. Treat that attribution as best-effort, not a guarantee — which is why `ValidationErrorItem.source` is typed optional and why the `resolve` sample below reads `err.source ?? "?"`. Some arms don't populate it: graph-level `dry_run` and `pipe_factory` items have no single owning file, and a `main_pipe` naming a nonexistent pipe currently reports its provenance in the message prose while leaving the structured field unset.

`dependencies` carries the method packages the tree calls by address, each a `files` map keyed by its address, posted as given. They are loaded beside the method, never merged into it, so a cross-package call resolves without the server fetching anything. A call into a package nothing shipped makes the closure invalid, a `200` verdict whose `unresolved_package_dependency` item names the package; `dependencies` without the tree is the server's `422`.

An **address-form** `method_ref` (`github.com/<owner>/<repo>[/<selector>][@<tag>]`) is resolved by the server through the same fetch path as a `method_ref` run: the package's whole tree is read from the commit at the tag and loaded as a sent tree is, with the packages it ships under its own `.mthds/methods/` beside it. Any non-address reference stays reserved and answers `501`.

`method_id` is the hosted platform's selector, and it is a **pass-through**: nothing is expanded client-side — the platform resolves the id against the org's catalog and injects the stored tree as `files` before the runner sees the request. A bare `mt_…` names the method's latest published version, `mt_…@<n>` the fixed version `n` and `mt_…@draft` its draft, and the suffix rides the string untouched. It is meaningless against a bare runner (no catalog). An unknown or foreign-org id is a `404` (indistinguishable by design); a bare id of a method never published is a `409` `method_not_published`, whose detail names `mt_…@draft`; a version the method never published is a `404` `method_version_not_found`; a malformed suffix is a `422`; a stored method with no MTHDS source is a `422`.

`read_scope` is a Pipelex-API extension naming the scope the request reads the method under: a hash entry of the tree resolves in that scope's blob store. A caller of a bare runner may send it; **the hosted platform stamps it from the caller's organization and drops one the caller sent**, so a hosted caller never needs it.

Supplying **no** selector or **more than one** is a request-shape `422` — the tooling routes are stateless, so there is no linkage exception; a second selector could only be ignored, which is the worst contract of the three. The SDK does not model the XOR in the type system — the union would force the overwhelmingly common `{ files }` call site to pick a branch for no gain, and the server's answer is a typed `ApiResponseError` either way. Only the four forms of the tree are checked client-side, because the client has to choose how to send it.

A caller facing a bare runner, which has no catalog to resolve an id against, expands a stored method itself: it reads the method's tree with `getMethod` or `getMethodVersion`, writes it to disk with `writeMethodTree`, and sends it from there as a `tree` ([method-trees.md](./method-trees.md)).

The files the closure's steps read, such as a `PipeDocGen` step's `template_file`, are files of the tree like any other, at the tree path the step names. A step whose template file the tree does not hold makes the closure invalid, a `200` verdict saying so ([method-trees.md](./method-trees.md#the-files-a-step-reads)).

A `method_ref` makes the server fetch the repository before it answers, so the client gives a call carrying one a fetch-sized budget (three minutes) instead of the 30-second default. On the hosted API the gateway caps every request at about 30 seconds whatever the client allows, so a cold `method_ref` clone can answer a `502`; retrying clears it once the runner has cached the clone.

## `resolve` — the normalized crate

Resolution is a first-class language operation alongside validation: the closure is loaded and statically validated, then emitted with fully qualified refs, refinement flattened, natives materialized, and a fingerprint set.

```ts
const result = await client.resolve({ files: { "method.mthds": src } });

if (!result.is_valid) {
  for (const err of result.validation_errors) console.error(`${err.source ?? "?"}: ${err.message}`);
  return;
}

console.log(result.crate.fingerprint); // rides INSIDE the crate, not beside it
```

Two things to internalize:

- **`fingerprint` and `mthds_version` are crate members**, not siblings of `crate`.
- **Compare `fingerprint` values; never hash the crate yourself.** The fingerprint is a property of the _logical_ crate, not of an encoding: the server hashes `{concepts, pipes, domains}` with each provenance `source` stripped, excluding `source_map`, `mthds_version` and `fingerprint` itself. And these are not the bytes `pipelex resolve --format json` prints — the CLI pretty-prints, the route answers compact JSON. Same logical crate, different serialization. Hashing `JSON.stringify(result.crate)` and comparing it against `result.crate.fingerprint` will mismatch on every call, and will look like tampering.
- **`crate` is typed as opaque transport** (`Record<string, unknown>`). Its schema belongs to the MTHDS standard; restating it here would be a second source of truth, free to drift from the one the server emits.

`resolve` runs **no dry-run sweep**. A valid verdict says the library resolves, never that it runs — runnability is `validate`'s vocabulary.

## `codegen` — stamped artifacts and the trust chain

`codegen` resolves the same way, then projects the crate through **two explicit axes**:

| Axis     | Values                                                  | Notes                                                          |
| -------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `kind`   | `types`                                                 | The crate's whole concept set. Per-pipe kinds are future work.  |
| `target` | `ts-zod`, `python-pydantic`, `python-structures`         | `ts-zod` is the natural one for TypeScript consumers.           |

```ts
const result = await client.codegen({ files, kind: "types", target: "ts-zod" });
if (!result.is_valid) return;

for (const artifact of result.artifacts) await writeFile(artifact.path, artifact.content);
await writeFile(result.lock_filename, result.lock); // "codegen.lock", beside the artifacts
```

**The trust chain is the reason the lock rides along.** Write every artifact at its `path` and the `lock` content as `lock_filename`, both **verbatim**, and the resulting tree is byte-identical to what a local `pipelex codegen types` run produces — same stamps, same lock — so the offline `pipelex codegen check` passes on it. Reformatting an artifact, or re-serializing the lock through your own TOML writer, breaks that chain. There is deliberately **no** server-side check route: the check is offline by design.

`crate_fingerprint` and `engine_version` say what the artifacts were generated _from_ — the crate `resolve` would have returned for the same closure, and the pipelex engine that emitted them.

The SDK stays transport-only: it hands you the artifacts and does not write files for you. Verifying a committed tree later is the other half of the chain, and that half needs no server at all — see [the offline check](#the-offline-check--runcodegencheck) below.

### `pipe_ref` is rejected, not ignored

`kind: "types"` is concept-set-wide, so passing `pipe_ref` alongside it is a request-shape **`422`**. Silently ignoring the selector would mislead a caller into believing the artifacts were narrowed to one pipe. The field exists on the request for the future per-pipe kinds.

## `pipeIo` — a method's I/O artifacts, without a validation

`pipeIo` resolves the closure the way `resolve` does, selects a pipe, and returns the method's three I/O artifacts — the standard's `PipeIOContracts`, `InputForm` and `OutputForm`, typed by importing them from `mthds/protocol` — with the selection and the runnability facts beside them. It runs **no dry-run sweep**, so it costs one load and one derivation where `validate` dry-runs every pipe. Read it to show a method, to prepare its inputs (`prepareInputs` does) or to generate types for it; stay on `validate` for the dry-run verdict or the dry-run graph.

```ts
const result = await client.pipeIo({ method_ref: "github.com/Pipelex/methods/documents" });
if (!result.is_valid) return;

const form = result.input_form[result.pipe_ref!]; // the entry pipe's input form
```

The request is the shared envelope plus three optional fields, posted verbatim:

| Field           | Default | Meaning                                                                                                   |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `pipe_ref`      | none    | The qualified `domain.pipe_code` to describe. Omitted, the server's selection chain decides.              |
| `all_pipes`     | `false` | Describe every pipe the closure loads instead of the selected one.                                        |
| `include_files` | `false` | Echo the text of the method's own `.mthds` bundles as `files`, a map from tree path to text.              |

**Selection.** The request's `pipe_ref`; else the `main_pipe` of the `METHODS.toml` at the tree's root, sent in the tree or fetched with a package; else the closure's `main_pipe`, when exactly one domain declares one. A `pipe_ref` that names no pipe, and — without `all_pipes` — a chain that finds no entry pipe or several, are refused with a `422` whose `errorType` names the refusal (see [What throws](#what-throws)). The server does not refuse a bare code yet: a bare ref that matches one pipe resolves across domains, and the answer reports the qualified ref. With `all_pipes: true` the route never refuses for want of an entry pipe, so a method that declares none is still describable.

The valid arm (`PipeIOValidReport`):

- `pipe_ref` — the qualified ref the selection resolved, read off the resolved pipe and never echoed from the request; `null` only under `all_pipes` when nothing resolves.
- `pipe_io_contracts`, `input_form`, `output_form` — the three maps, sharing one key set: the resolved `pipe_ref` alone by default, every pipe under `all_pipes`. For a closure `validate` also accepts, each equals `validate`'s same-named field restricted to the same keys, null members such as a contract's `item_count: null` included.
- `default_pipe_ref` — the method's own entry pipe, the selection chain without the request's `pipe_ref`, or `null` when that chain finds none or several. A request that omits `pipe_ref` always answers `pipe_ref === default_pipe_ref`. It is **not** `validate`'s field of the same name, which is the run default and names the first of several declaring domains where this route refuses to choose.
- `pending_signatures`, `is_runnable` — what they mean on `validate`, read off the loaded library with no dry run, so a method whose dry run would fail is still reported runnable here.
- `files` — present only with `include_files: true`: the text of each `.mthds` bundle of the method's own tree, keyed by its tree path — the request's bundles for a sent tree, whatever form or entry carried them, the fetched package's bundles keyed by their path from the package root for a `method_ref`, the stored tree's bundles for a hosted `method_id`. The tree's other files and the bundles of its dependencies are never included. Absent, not empty, otherwise.

`is_valid: true` means what it means on `resolve`: the closure parsed, loaded and passed static validation. The invalid arm is the shared `CrateInvalidReport`, and it carries no artifacts, no selection and no files, whatever the request asked for.

## The response is a verdict, not a payload

All three routes return a **discriminated 200**, the same discipline as `validate`: an unresolvable closure is the _successful product_ of the call (the request was well-formed; the library was not), so it rides a 200 with `is_valid: false` and the shared `CrateInvalidReport`, carrying the same structured `validation_errors[]` as `validate`'s invalid arm.

**Branch on `is_valid` before reading the arm.** A consumer that only catches throws will render a success over an unusable result, because nothing threw.

## What throws

Only a **no-verdict** condition, as the typed `ApiResponseError` — branch on its `status` and `errorType`, never on its message:

| Status        | Cause                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `422`         | Request shape: no closure selector or more than one, `dependencies` without the tree, an unknown `kind`/`target`, a `pipe_ref` on `kind: "types"`, a fetched package with no `.mthds` file, a stored method with no MTHDS source, a `method_id` whose version suffix is malformed. |
| `422`         | The tree's refusals, as on `validate`: `InvalidMethodFiles` for a key or an entry the tree's rule refuses (a `files` that is not a map among them), `MissingBlobs` for a hash the server does not hold, `MethodTreeTooLarge` past the tree's limits, `InvalidBundle` for a tree holding no `.mthds` bundle. |
| `422`         | On `pipeIo`, a pipe selection the route refuses: `errorType` `EntryPipeNotFoundError` for a `pipe_ref` that names no pipe or a method with no entry pipe, `EntryPipeAmbiguousError` for a code that matches pipes in several domains or several `main_pipe` declarations. The `serverMessage` names the candidates where there are some. |
| `404`         | Unknown or foreign-org `method_id` (indistinguishable by design); no package at a `method_ref` address.     |
| `404`         | `code` `method_version_not_found`: a `mt_…@<n>` naming a version the method never published.               |
| `409`         | `code` `method_not_published`: a bare `method_id` of a method never published; `mt_…@draft` reaches its draft. |
| `501`         | Registry-form `method_ref` — reserved, not implemented (the address form resolves).                         |
| `401` / `403` | Auth, or on a hosted origin a route the gateway does not list yet (`403 {"message":"Forbidden"}`).          |
| `403`         | `CustomCodeRequiresSandbox` for a tree holding a `.py` file on a deployment that is not sandbox-hosted, `MethodStructuresRefusedError` for one whose Python declares a structure class on one that is; `ReadScopeForbidden` for a `read_scope` a `jwt` caller may not read under. |
| `502`         | On a hosted origin, a cold `method_ref` clone that outran the gateway's 30-second cap; a retry clears it.   |
| `5xx`         | Server fault, including on `pipeIo` a pipe whose artifacts cannot be derived.                               |

Note the split: a bad **closure** is a 200 verdict; a bad **request** throws.

Before any request, a `directory`, `tree` or `contents` can also throw: `RequestArgumentError` for two forms of the tree, a directory the lister refuses, a tree holding no file or one too heavy to send inline to an API with no blob store, and `MethodFileTransferError` for a blob that could not be uploaded, so the request was not sent ([errors.md](./errors.md)).

(The offline check below is not a route and throws its own `CodegenLockError` instead — it never reaches the network.)

## The offline check — `runCodegenCheck`

A consumer that commits the generated tree needs a CI gate over it. That gate is `runCodegenCheck`, and it is **pure**: no filesystem, no network, no API key, no `PipelexApiClient`. You walk your own tree and hand in the text; the SDK owns the verdict.

The reason it is a separate, engine-free step is the same reason there is no server-side check route. Regeneration is a **dev action** — it needs the engine, so it is `codegen` above. The check is a **CI action** — it needs only a hash function. Keeping them apart is what stops an upstream template improvement from reddening a consumer's CI on a tree nobody touched.

```ts
import { isStampableArtifactPath, runCodegenCheck } from "@pipelex/sdk";

const report = await runCodegenCheck({
  lockContent: await readFile("src/generated/echo/codegen.lock", "utf8"),
  // Every file under the lock's directory, recursively, with paths relative to it.
  files: await readTree("src/generated/echo", isStampableArtifactPath),
});

if (!report.isCurrent) {
  for (const drift of report.drifts) {
    console.error(`${drift.category}: ${drift.path} — ${drift.detail}`);
  }
  process.exit(1);
}
```

A `codegen()` response feeds straight in with no mapping — `GeneratedArtifact` and `CodegenTreeFile` are structurally identical on purpose, so `runCodegenCheck({ lockContent: result.lock, files: result.artifacts })` type-checks and reports `isCurrent`. That is worth doing right after a regeneration, before writing anything to disk.

The function is `async` because it hashes through **WebCrypto** (`crypto.subtle`) rather than `node:crypto`, so the check adds no Node builtin to the barrel's import graph. (That is not the same as the barrel being browser-bundleable today: `upload.ts` still names `node:fs/promises`, so a browser-targeting bundler must mark `node:*` external.) One caveat that never bites a CI script but should not surprise anyone: `crypto.subtle` is secure-context-only, so a browser page must be served over https (or localhost).

### The algorithm

Each locked artifact is located in the supplied tree and the hash of the body **below its stamp** is recomputed. Absent is a drift; a body that no longer hashes to what the stamp or the lock records is a drift. Then, in the other direction, a stamped file the lock does not track is a drift — the stale-artifact class a per-file stamp can never catch on its own, and the reason the lock rides along with the artifacts at all.

The verdict is a structured report, never an exit code alone: `drifts` enumerates the drifting artifacts by category, and `isCurrent` is exactly `drifts.length === 0`. Drift order is deterministic — locked-artifact drifts first, then orphans, each sorted by path — so a consumer can print it, snapshot it, or diff two runs.

The report also carries `crateFingerprint` and `engineVersion`, read off the lock header. The check itself never compares them against anything (that would need the engine), but surfacing them is what lets a caller ask the question the check deliberately does not: _is this committed tree even from the crate my method resolves to today?_ — a live `codegen()` response's `crate_fingerprint` is the value to compare against.

### The drift taxonomy

| Category      | What it means                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `missing`     | Listed in the lock, absent from the tree you handed in.                                               |
| `modified`    | Present, stamp self-consistent, but the body no longer matches the **locked** hash — regenerate.      |
| `hand-edited` | Present, but its stamp is gone, unparseable, or disagrees with the body below it — someone edited it. |
| `orphan`      | A stamped file the lock does not track — yesterday's artifact, left behind. Remove or regenerate.     |

Two properties of that table are load-bearing and are pinned by tests:

- **At most one drift per locked path, and `hand-edited` outranks `modified`.** A hand edit trips both conditions; reporting it twice would print the same file under two contradictory categories.
- **An orphan only has to _look_ stamped.** A stray whose stamp is corrupt below the begin-marker line still counts — using the stricter parse there would silently ignore exactly the stale file the lock exists to catch.

The category values are the canonical strings `pipelex codegen check` uses, and so are the `detail` sentences, verbatim. A consumer switching between the CLI and this helper reads the same report.

### Where it knowingly differs from the CLI

Verdict parity is the design constraint, and the stamp-header text rules mirror Python's exactly — the line-boundary set, the strip set, the drive-prefix rule, and the comment-prefix gate over the header region are all matched deliberately, each pinned by a test. These differences remain:

- **The projection line is shape-checked, not vocabulary-checked.** pipelex resolves `kind` and `target` against its own enums, which cannot lag its own emitter; an SDK copy can. So a stamp reading `projection: types / rust-serde` from a newer engine verifies here and would be `hand-edited` there. Tightening it would report every artifact of such a tree as a hand edit — the failure mode is worse than the gap, and it is pinned in both directions.
- **The "not valid UTF-8" branch cannot arise.** `content` reaches the check already decoded, so the caller owns that verdict — see the decode obligation above.
- **A TOML float is accepted as a lock version, where pipelex calls it malformed.** `lock_version = 1.0` is a float upstream and not an `int`, so the CLI refuses it; the TOML parser here decodes it to the same `1` as the integer, so this reader cannot tell them apart and reads version 1. Not deliberate so much as unavoidable, and unreachable with any emitter — the divergence is a no-verdict there against a verdict here, on a lock nothing writes.

### The lock format version

`codegen.lock` opens with `lock_version`, and this build reads version 1. The field exists because the reader is deliberately strict *within* a version — an unknown key is a malformed lock, not a field to ignore — and that strictness is unworkable *across* versions without it.

Four rules, mirroring the CLI exactly:

- **A lock with no `lock_version` key is version 1.** The field was introduced with version 1, so every lock written before it existed is already conformant and nothing on disk needs migrating.
- **The version is read _before_ the key set is validated.** This is the load-bearing ordering. The other way round, a lock from a newer codegen is rejected over whichever new key it happens to carry — an opaque shape complaint about a key the writer was entitled to add, instead of a verdict naming the version and saying what to upgrade.
- **A version this build does not know is refused**, with a message that names the version found and which side to upgrade. A version *greater* than the one read means the lock came from a newer codegen; anything else (`0`, negative, non-integer) is malformed rather than futuristic.
- **Strictness within a known version stays.** An unexpected key in a version-1 lock is still a no-verdict.

So the upgrade path is: publish an SDK that tolerates the new version *before* the pipelex release that starts writing it. A reader that has not learned a version yet fails loudly and actionably rather than silently guessing at a shape it was not written for.

### The caller's obligations

The pure input moves the tree-reading obligations onto you. Each one, unmet, produces a **wrong verdict** rather than an error — so none of them can be left implicit:

- **Pass each file's text as read, without reformatting it.** The hash is over exact UTF-8 bytes, and the stamp parser requires the text to _start with_ the begin-marker line. Re-encoding, inserting a BOM, or running Prettier over a generated artifact all report `hand-edited`.
- **Line endings are the one exception, and they are handled for you.** `\r\n` and lone `\r` are normalized to `\n` before anything is parsed or hashed, mirroring the universal-newline translation pipelex's own reader applies. A Windows checkout under `core.autocrlf=true` is therefore **not** a false hand-edit here, exactly as it is not one for the CLI. Committing generated artifacts with a `.gitattributes` entry (`src/generated/** -text`) is still worth doing for diff hygiene; it is not load-bearing for the verdict.
- **Walk the whole tree, recursively, from the lock's directory**, and pass paths relative to it. An incomplete list yields a wrong verdict in either direction: an omitted _locked_ file is reported `missing` though it sits on disk, and an omitted _orphan_ is never seen at all — `isCurrent: true`, a false negative on precisely the drift class orphan detection exists for. Filter your walk with `isStampableArtifactPath` (or `STAMPABLE_ARTIFACT_SUFFIXES`) so it picks up exactly what the check considers; a file of any other type is skipped rather than rejected, which is what lets you park a sidecar such as `sources.json` beside the lock. Pruning vendor and VCS directories and skipping symlinks is walk policy and stays with you — moot for a per-method generated directory, which holds nothing else.
- **Decode the bytes yourself.** `content` is already a `string`, so pipelex's "not valid UTF-8, therefore not generated output" branch cannot arise here. A file you could not decode is not generated output: report it yourself, or leave it out and accept the `missing` drift.

### What it deliberately does not verify

It never compares a stamp's `crate_fingerprint` against the lock's, and it never re-resolves the crate. Both need the engine, which is the whole point of the offline split — and both are questions the caller can ask itself with `crateFingerprint` in hand.

### What the check throws

`CodegenLockError`, and only for a **no-verdict** condition: a malformed lock, a lock format version this build cannot read, an unknown key in it, or a path — in the lock or in your `files` — that is not a safe canonical artifact path (absolute, drive-prefixed, backslashed, control-charactered, `..`-bearing, empty, duplicated, or, for a locked path, of a type codegen does not stamp). None of these is a drift: the check could not produce a verdict at all, which is a distinct outcome and typically a distinct exit code. It deliberately does not derive from `PipelineRequestError` — nothing was requested over the wire.

A `"./types.ts"` spelling is worth calling out, because it is the one a hand-rolled walk produces by accident: left to resolve as-is it would report both a `missing` and an `orphan` for the same file, so it throws instead.
