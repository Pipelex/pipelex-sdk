# A method's tree

A method is a **method tree**: the files it is made of, each at its tree path — its bundles, its manifest when it has one, and every file a step reads or that travels with the method, such as a `PipeDocGen` step's template. A tree is named by its **tree digest**, `sha256:` and the SHA-256 of its listing, so two methods holding the same files hold the same digest. Both are defined by the MTHDS standard (`mthds/docs/spec/method-tree.md`), and on the wire a tree is the protocol's `files` map, each key a tree path and each value the file's text, `{ base64 }` for bytes that are not text, or `{ sha256, size }` for bytes the receiver already holds.

Every call that takes a method takes its tree the same way: the runs (`execute`, `start`, `startAndWaitForResult`), `validate`, the crate routes (`resolve`, `codegen`, `pipeIo`), `prepareInputs`, and the saves (`createMethod`, `writeDraft`). A saved method holds one too: the draft holds one, and each published version holds the one it was published from. The platform keeps each file once per organization, as a blob named by its SHA-256, so a request sends only the files the organization does not hold yet, and a read lists the files with a short-lived link to each one's bytes.

## The four forms of a tree

A call takes the tree in exactly one of four forms (`MethodTreeForms`):

| Form | What it is | How it is sent |
|---|---|---|
| `directory` | The method's directory on disk. **Node only.** | Listed, then inline when small and by hash otherwise (below). |
| `contents` | Each file's bytes (`Uint8Array`) or its text, by tree path, a map held in memory. | Inline when small, by hash otherwise. |
| `tree` | A `MethodTreeSource`: a tree's `files` (each with its `path`, `size` and `sha256`), its `digest`, and `readFile(path)` giving each file's bytes. The `MethodTree` the `mthds` package's `listMethodTree` returns is one. | Inline when small, by hash otherwise. |
| `files` | The protocol's map of file entries (`MethodFiles` from `mthds/protocol`). | As given. |

```ts
// A run of the method in a directory: the client lists it, and sends what the API lacks.
const results = await client.startAndWaitForResult({
  directory: "methods/receipts",
  inputs: { receipt: "https://example.com/receipt.png" },
});

// The same method validated from memory, its template among its files.
const verdict = await client.validate({
  contents: {
    "receipts.mthds": source,
    "templates/receipt.docx": await readFile("methods/receipts/templates/receipt.docx"),
  },
});
```

**A directory is listed by the standard's lister.** The client loads the `mthds` package's `listMethodTree` when a call gives a `directory`, and lists it under the MTHDS standard's membership rule and Manifest Discovery: the tree is rooted at the nearest `METHODS.toml` at or above the directory, else at the directory itself, and holds every file the rule keeps. Hidden entries, `node_modules`, `__pycache__`, what a `.gitignore` or the manifest's `exclude` keeps out, and **a run's inputs file** (`inputs.json`, `inputs.toml`) never travel with the method. A tree holding a symbolic link or a special file is refused rather than followed. The directory is listed under the limits the deployment announces (below), so a tree the deployment would refuse for its size is refused while it is listed, before any file is hashed. Every refusal is a `RequestArgumentError` naming the call and the directory, whose `cause` is `mthds`'s `MethodTreeError`, with its `code` (`not_found`, `symbolic_link`, `limit_exceeded`, `empty_tree` and the rest). Listing needs Node: a browser gives `contents`, `tree` or `files`.

**A map in memory.** A text in `contents` is encoded in UTF-8, and a text a file cannot hold, one carrying a lone surrogate, is refused, as is a value that is neither a string nor a `Uint8Array`. The keys are sent as they are, and the platform refuses one that is not a tree path with the `422` `invalid_method_files` naming it.

**One form, and never an empty tree.** Two forms at once are refused with a `RequestArgumentError` before anything is read or sent. A `files` map, `contents` or a `tree` holding no file is refused too on the run routes and on `validate`, as the standard refuses it: a tree holds at least one file. On the crate routes and in `prepareInputs`, an empty map is absent instead, so it never reaches the wire as a second selector, and in a save `files: null` empties the draft. An empty `directory` string is absent everywhere.

## How a tree travels

A tree given as a `directory`, `contents` or `tree` is sent by the rule the `mthds` package's `MthdsApiClient` follows, so the tree a save sends is the tree a run would send. The client reads the API's version handshake first (`GET /v1/version`) and keeps its answer for five minutes, so every call in that time reads the same answer and a deployment that changes is read afresh soon after ([below](#the-deployments-limits)):

- **When the API keeps a blob store** (`blob_store: true`), a tree whose inline map weighs no more than the inline threshold travels **inline**, with no further round trip. The map is weighed as the request spends it, its JSON with no whitespace, in UTF-8, and the threshold is the lower of `INLINE_TREE_MAX_BYTES` (256 KiB) and the `max_inline_bytes` the handshake announces. Inline, a file whose bytes are UTF-8 travels as its text and any other as `{ base64 }`, so a binary file weighs its Base64. A heavier tree travels **by hash**: the client asks `POST /v1/blobs/missing` which files the receiver lacks, naming the tree's digest, uploads each one it lacks once, at most eight at a time, straight to the upload target the platform names, under the client's request time limit (`requestTimeoutMs`, twenty minutes unless the client was built with another), and sends every file as `{ sha256, size }`. A file uploaded once is never uploaded again, by this method or any other of the organization. A `404` from the blob route says the kept handshake is stale, the API having lost its blob store since it was read: the client forgets the handshake and prepares the tree once more on a fresh one.
- **When the API keeps no blob store**, which a bare runner usually does, the whole tree travels inline whatever its weight, held to the `max_inline_bytes` the handshake announces: a heavier tree is refused with a `RequestArgumentError` before anything is sent, since the API would refuse it. The files' listed sizes are checked first, since the inline map weighs at least that much, so a tree whose files alone pass the limit is refused before any of them is read; the message says which was measured, the files alone or the inline map, with its weight and the limit.

A `files` map is sent as given, with no handshake. A run's `start` carrying a tree, a run that names a `method_ref`, and a start whose `extra` carries a method bundle (`mthds_contents` or `bundle_b64`, as the `pipelex-sdk` command sends one) get the client's request ceiling rather than the 30-second start budget, since the body can be large. On the crate routes, a request whose `files` carry more than `INLINE_TREE_MAX_BYTES` inline, as a tree sent to an API keeping no blob store or a `files` map given as is may, gets the request ceiling too rather than the 30-second budget of a static route ([crate-routes.md](./crate-routes.md)).

**A refusal of the tree's size is sent once more.** When the API refuses a tree the client prepared, a `directory`, `contents` or `tree`, as past one of its limits (a `422` coded `method_tree_too_large`, or `method.package_invalid` naming a limit, or of type `MethodTreeTooLarge`), the handshake that announced the limits may be stale: the client forgets it, prepares the tree again on a fresh one and sends the request once more, as `mthds`'s client does. A `files` map given as is was not prepared from the handshake, so it is not sent again, and neither is a `start` under an idempotency key, since the platform binds the key to the refusal it stores.

**Stopping a call.** A call that takes a `signal` (`validate`, `startAndWaitForResult`, the crate routes, `prepareInputs`) reads it before each step a `directory`, `contents` or `tree` costs and hands it to the step's request, so an abort stops the version handshake, the directory's listing, the blob route, a file's read and an upload already under way, and nothing further starts.

A `MethodTree` reads a file again whenever its bytes are sent, inline or as an upload, and checks it against the hash its listing recorded, so a file changed since the listing is refused by `mthds` rather than sent as another tree than the one listed. Apart from listing a directory, sending a tree reads no Node module: hashing is Web Crypto's, and Base64 is written by the SDK.

**What is uploaded is what the listing names.** Before each upload the client hashes the bytes a tree's `readFile` gives and refuses them, with a `RequestArgumentError`, unless they have the size and the SHA-256 the tree lists for them: a blob is stored under its hash for the whole organization, so a hand-built `MethodTreeSource` whose `readFile` disagrees with its listing never stores other bytes under that hash. An answer of `POST /v1/blobs/missing` asking for a blob the tree does not hold is the platform's fault, not the caller's: it is an `ApiResponseError` of an answer the SDK cannot read, verdict `runtime` and not retryable, thrown before any upload. An upload that fails throws `MethodFileTransferError` with `operation` `upload`, and the request is not sent or the method not saved ([below](#when-a-transfer-fails)).

**A blob that went missing.** A request whose hash entries name a blob the API does not hold is refused with a `422` `missing_blobs` listing them all, which also releases a start's idempotency key. A request built from a `directory`, `contents` or `tree` uploads every blob it names first, so it meets this only if a blob was removed between the upload and the request. The client answers it as `mthds`'s client does: a `422` problem coded `request.blobs_missing`, whose `params.missing_blobs` names blobs the tree holds, has those blobs asked of the blob route again, uploaded and the request sent once more, while the platform's `missing_blobs` code is not read as one and is thrown, so sending the same call again asks the blob route afresh and uploads what is missing.

On the crate routes, `read_scope` is the scope the blob route is asked under, so the blobs are uploaded into the store the request's hash entries are read from; the hosted platform reads the caller's organization whatever the request says ([crate-routes.md](./crate-routes.md#the-shared-envelope)).

## The files a step reads

A file a step reads, such as a `PipeDocGen` step's `template_file` (the Word, Excel or PowerPoint template it fills, or the HTML template it prints as a PDF), is a file of the tree like any other, at the tree path the step names from the root. A `directory` sends it with the bundles; a `contents` or `files` map carries it under its tree path. A step that names a file the tree does not hold cannot load: on `validate`, `pipeIo`, `resolve` and `codegen` that is an `is_valid: false` verdict whose validation error says the file is missing, `prepareInputs` throws it as a `MethodLoadError`, and on `execute` and `start` it is a `422` `ValidateBundleError`, whose `validationErrors` say the same.

### The template check's warnings

A dry run hands an office template file of the tree to the document engine's template check. An error finding fails the step's dry run, and so the verdict, as a `dry_run` validation error on the step. A warning finding, such as a field of the template that matches no input, rides the valid verdict's `warnings` as a `template_check_warning` item:

| Member | Value |
| --- | --- |
| `category` | `dry_run` |
| `error_type` | `template_check_warning` |
| `pipe_code`, `domain_code` | The `PipeDocGen` step |
| `template_file` | The template file as the step names it; `null` for a step of the server's own library, whose path is never shown |
| `template_location` | The place in the file the finding names, in the engine's words (a defined name, a table, a cell, a shape, a tag); `null` when it names none |
| `message` | The finding in words |

The warnings come in families, always in this order: `optional_force_redundant`, `input_presence_vacuous`, the `hint_*` lints, then `template_check_warning`. None of them flips `is_valid`.

```ts
if (verdict.is_valid) {
  for (const warning of verdict.warnings) {
    if (warning.error_type === "template_check_warning") {
      console.warn(`${warning.template_file ?? "?"} ${warning.template_location ?? ""}: ${warning.message}`);
    }
  }
}
```

## Saving a tree

`createMethod(input)` and `writeDraft(methodId, input)` take the tree in the four forms (`MethodTreeInput`), and send it by the rule above.

```ts
const method = await client.createMethod({ name: "Receipts", directory: "methods/receipts" });

const draft = await client.writeDraft(method.method_id, {
  contents: { "main.mthds": source, "helpers/fx.py": helper },
  expected_updated_at: method.updated_at,
});
```

**A draft write replaces the whole tree.** `writeDraft` refuses a draft that gives no tree, and `files: null` empties the draft. `createMethod` with no tree creates a method with an empty draft. A `contents` or `tree` holding no file is refused before anything is sent.

The save is refused, with the `ApiResponseError` of its problem, when the platform will not take the tree:

| Status and `code` | When |
|---|---|
| `422` `invalid_method_files` | The map breaks the standard's rules, a path that is not a tree path or two paths that collide among them; the problem's `tree_refusal` names the rule. |
| `422` `method_tree_too_large` | The tree passes one of the deployment's limits, which the problem's `limit` names. |
| `422` `blob_mismatch` | A hash entry states another size than the blob the organization holds under that hash. |
| `422` `missing_blobs` | A hash entry names bytes the organization does not hold (above). |
| `413` `payload_too_large` | The method would leave no room for the summary a publish adds. |

## The deployment's limits

The version handshake (`GET /v1/version`) announces the limits the deployment holds a tree to under `limits.method_tree`: `max_files`, `max_file_bytes`, `max_total_bytes` and `max_inline_bytes`. A limit the server does not announce is absent, a value that is not a positive integer is left out rather than trusted, and none is ever assumed, so a bare runner, which announces none, yields no limit. The client keeps the handshake's answer for five minutes (`HANDSHAKE_TTL_MS` in `src/method-trees.ts`), so every call in that time reads the same answer, and asks again once it is older; a handshake that fails is asked again on the next call. A `404` from the blob route and a refusal of the tree's size each drop the kept answer at once, since each says it may be stale ([above](#how-a-tree-travels)).

`methodTreeLimits()` returns the three listing limits, `{ maxFileCount, maxFileSize, maxTotalSize }`, in the shape `listMethodTree` takes as its `limits` option, for a caller listing a tree of its own; a `directory` given to a call is listed under them already. Listed under those limits, a tree the platform would refuse for its size is refused while it is listed, with `mthds`'s `TreeLimitExceededError` naming the limit, before any file is hashed. The inline limit, `max_inline_bytes`, is no listing limit: the client applies it when it chooses how a tree travels.

```ts
import { listMethodTree } from "mthds";

const tree = await listMethodTree("methods/receipts", { limits: await client.methodTreeLimits() });
const method = await client.createMethod({ name: "Receipts", tree });
```

## Reading a tree

`getMethod(methodId)` answers a `MethodDetail`: the method, with `files`, the draft's tree listed in tree path order. `getMethodVersion(methodId, version)` answers a `MethodVersion`: the version's summary, with the same `files`. Each file is a `SavedMethodFile`:

| Field | Meaning |
|---|---|
| `path` | Its tree path. |
| `sha256` | The SHA-256 of its bytes, 64 lower-case hex digits. |
| `size` | Its size in bytes. |
| `url` | A link to its bytes, signed by storage, which any HTTP client reads with no credential. |
| `expires_at` | When the link stops working, about fifteen minutes after the read. |

An empty draft lists no file and has a `draft_digest` of `null`. The listing pages are lighter: `listMethods` rows and `listMethodVersions` summaries carry the digest and no files. The writes, `createMethod`, `writeDraft` and `renameMethod`, answer `MethodData`, the method without its files.

**A link is a bearer credential.** Anyone holding it reads the file until it expires, so it belongs in no log, message or stored record; this SDK puts it in none of its errors, not even when the answer that carried it cannot be read. A read that fails because a link expired succeeds once the method is read again.

A method whose draft names a tree the platform holds no record of answers `getMethod` with a `409` whose verdict is `runtime`, and a version stored before methods were trees and never rewritten as one names no tree to serve, so `getMethodVersion` answers it with `409` `conflict`, whose verdict is `runtime` too. An answer whose `files` is not a listing, each entry with its string `path`, `url` and `expires_at`, a `sha256` of 64 lower-case hex digits and a non-negative integer `size`, is an `ApiResponseError` naming the entry at fault. Such an answer, like any other the SDK cannot read from these two routes or from `POST /v1/blobs/missing`, reaches its error redacted: `responseBody` has every `url` member and every link's query replaced by `[redacted]`, and the error keeps no `cause`, since a parse failure can quote the body.

## Writing a tree to disk

`writeMethodTree(files, { destination })` writes a listing to disk, each file at its tree path under `destination`. It runs in Node only, and loads Node's file system modules when it is called:

```ts
const detail = await client.getMethod("mt_123");
await client.writeMethodTree(detail.files, { destination: "receipts" });
```

Each file is downloaded through its link, at most eight at a time, with no credential and no header of this client, following no redirect, under the client's request time limit (`requestTimeoutMs`), which covers the whole download, the body included: a body that stalls once its headers arrived fails with the timeout's code, `ABORT_TIMEOUT`. Each file's size and SHA-256 are checked against the listing, and no more than its listed size and one byte is read, so what lands on disk is the tree the digest names. The files are written into a fresh hidden directory beside `destination`, which takes the name `destination` only once every file is written, so a failed or interrupted write leaves nothing under that name and removes what it wrote.

`destination` must not exist, or must be an empty directory: one holding anything is refused, rather than written into or replaced. A listing holding a path that is not a tree path, the same path twice, or two paths that collide once case-folded or where one names a directory of the other, is refused too. Each refusal is a `RequestArgumentError` thrown before any download. An empty listing writes an empty directory.

## When a transfer fails

`MethodFileTransferError` is thrown when a file could not be moved between this machine and storage. `operation` says which way (`upload` for a request or a save that sends a tree by hash, `download` for `writeMethodTree`), `code` why, `sha256` which bytes, `path` the tree path when one is known, and `status` storage's HTTP status when it answered. Neither its message nor any member carries the link, nor storage's error body, which can echo the signed request, and it keeps no `cause`: the failure `fetch` throws for a request that got no answer can quote the URL, so only its network code (`ECONNREFUSED`, `ABORT_TIMEOUT`) reaches the message.

| `code` | When | Retryable |
|---|---|---|
| `unreachable` | Storage gave no answer: the connection failed or the time limit ran out. | yes |
| `storage_error` | Storage timed out or throttled the request (`408`, `429`) or failed (a `5xx` other than `501`). | yes |
| `refused` | Storage refused the request with any other status, an expired link among them. Read the method again for fresh links. | no |
| `mismatch` | A download's bytes are not the file the listing names: another size, or another SHA-256. | yes |

Its `errorDomain` is always `runtime`. An upload to a target that asks for a create-only write (`If-None-Match`) and answers `412` is not a failure: the bytes are already stored.

## What changed from the source fields

A run and a validation used to take a method as inline `.mthds` texts (`mthds_contents`, with `mthds_sources` naming them on `validate`), a zipped bundle (`bundle_b64`), or a `files` map of texts, with the files a step reads sent beside it as `resources`. They take its tree now, as every other call does, and `validateFiles`, `MthdsFile`, `ValidateFilesOptions`, `BundleResources` and the SDK's own copy of the runner's path rule for `resources` are gone, with no alias kept. A field the client no longer names still passes through `extra` to a runner that reads it.

A method used to hold its source as two strings, `mthds` (a bundle, or the JSON text of a file array) and `python` (the JSON text of the custom PipeFunc files), and a version carried `source_digest`. Both fields are gone from every read and every write, with no alias kept: a method is a tree, a version's digest is `tree_digest`, and the publish state is derived from the two digests, the draft unchanged when `draft_digest` is not `null` and equals `latest_published.tree_digest`. `methodSourceToContents`, `getMethodClosure` and `EmptyMethodSourceError` went with them.

A run's `source_digest` is something else, and stays: the SHA-256 of the sources a run sent as text, 64 hex digits with no prefix. `RunDetail` also carries the run's `tree_digest` and `crate_fingerprint`, each `null` for a run that recorded none.
