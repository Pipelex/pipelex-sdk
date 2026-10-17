# A saved method's tree

A saved method holds a **method tree**: the files a method is made of, each at its tree path, the same tree a run takes as `files`. The draft holds one, and each published version holds the one it was published from. A tree is named by its **tree digest**, `sha256:` and the SHA-256 of its listing, so two methods holding the same files hold the same digest. Both are defined by the MTHDS standard (`mthds/docs/spec/method-tree.md`), and the `mthds` package lists a tree from a directory with `listMethodTree`, whose `MethodTree` a save takes as it is.

The platform keeps each file once per organization, as a blob named by its SHA-256, so a save sends only the files the organization does not hold yet, and a read lists the files with a short-lived link to each one's bytes.

## Saving a tree

`createMethod(input)` and `writeDraft(methodId, input)` take the tree in one of three forms (`MethodTreeInput`):

| Form | What it is | How it is sent |
|---|---|---|
| `files` | The standard's map of file entries (`MethodFiles` from `mthds/protocol`): a text, `{ base64 }`, or `{ sha256, size }` for bytes the organization already holds. | As given. |
| `tree` | A `MethodTreeSource`: a tree's `files` (each with its `path`, `size` and `sha256`), its `digest`, and `readFile(path)` giving each file's bytes. The `MethodTree` `listMethodTree` returns is one. | Inline when small, by hash otherwise (below). |
| `contents` | Each file's bytes (`Uint8Array`) or its text, by tree path. | Inline when small, by hash otherwise (below). |

A tree given as `tree` or `contents` is sent **inline** when its inline map weighs `INLINE_TREE_MAX_BYTES` (256 KiB) or less, written as JSON with no whitespace and measured in UTF-8, or when the platform keeps no blob store, which its version handshake says (`blob_store`). Inline, a file whose bytes are UTF-8 travels as its text and any other as `{ base64 }`. Otherwise the client asks `POST /v1/blobs/missing` which files the organization lacks, naming the tree's digest, uploads each one it lacks once, at most eight at a time, straight to the upload target the platform names, under the client's request time limit (`requestTimeoutMs`, twenty minutes unless the client was built with another), and sends every file by hash. These are the rules the `mthds` package's own clients follow, so the tree a save sends is the tree a run would send. A file uploaded once is never uploaded again, by this method or any other of the organization.

A text in `contents` is encoded in UTF-8, and a text a file cannot hold, one carrying a lone surrogate, is refused, as is a value that is neither a string nor a `Uint8Array`. A `MethodTree` reads a file again whenever its bytes are sent, inline or as an upload, and checks it against the hash its listing recorded, so a file changed since the listing is refused by `mthds` rather than sent as another tree than the one listed. Saving reads no Node module of its own: hashing is Web Crypto's.

```ts
import { listMethodTree } from "mthds";

const tree = await listMethodTree("methods/receipts", { limits: await client.methodTreeLimits() });
const method = await client.createMethod({ name: "Receipts", tree });

const draft = await client.writeDraft(method.method_id, {
  contents: { "main.mthds": source, "helpers/fx.py": helper },
  expected_updated_at: method.updated_at,
});
```

**A draft write replaces the whole tree.** `writeDraft` refuses a draft that gives no tree, and `files: null` empties the draft. `createMethod` with no tree creates a method with an empty draft. The client refuses two forms at once, and a `tree` or `contents` holding no file, with a `RequestArgumentError` before anything is sent.

**What is uploaded is what the listing names.** Before each upload the client hashes the bytes a tree's `readFile` gives and refuses them, with a `RequestArgumentError`, unless they have the size and the SHA-256 the tree lists for them: a blob is stored under its hash for the whole organization, so a hand-built `MethodTreeSource` whose `readFile` disagrees with its listing never stores other bytes under that hash. An answer of `POST /v1/blobs/missing` asking for a blob the tree does not hold is the platform's fault, not the caller's: it is an `ApiResponseError` of an answer the SDK cannot read, verdict `runtime` and not retryable, thrown before any upload.

The save is refused, with the `ApiResponseError` of its problem, when the platform will not take the tree:

| Status and `code` | When |
|---|---|
| `422` `invalid_method_files` | The map breaks the standard's rules, a path that is not a tree path or two paths that collide among them; the problem's `tree_refusal` names the rule. |
| `422` `method_tree_too_large` | The tree passes one of the deployment's limits, which the problem's `limit` names. |
| `422` `blob_mismatch` | A hash entry states another size than the blob the organization holds under that hash. |
| `422` `missing_blobs` | A hash entry names bytes the organization does not hold. A save built from `tree` or `contents` uploads every blob it names first, so it meets this only if a blob was removed between the upload and the save; the client does not retry it. |
| `413` `payload_too_large` | The method would leave no room for the summary a publish adds. |

An upload that fails throws `MethodFileTransferError` with `operation` `upload`, and the method is not saved (below).

The crate routes, `resolve`, `codegen` and `pipeIo`, and `prepareInputs`, which reads `pipeIo`, take the method's tree in the same three forms and send a `tree` or `contents` by the same rules, so a tree too large to send inline is uploaded once and then read by hash. There an upload that fails means the request was not sent ([crate-routes.md](./crate-routes.md#the-shared-envelope)).

## The deployment's limits

`methodTreeLimits()` returns the limits the deployment holds a tree to, `{ maxFileCount, maxFileSize, maxTotalSize }`, read from `limits.method_tree` of the public version handshake (`GET /v1/version`), in the shape `listMethodTree` takes as its `limits` option. A limit the server does not announce is absent, a value that is not a positive integer is left out rather than trusted, and none is ever assumed, so a bare runner, which announces none, yields no limit. The client asks for the handshake once and keeps its answer, as it keeps the run lifecycle's availability, so `methodTreeLimits` and every save sent by hash read the same answer; a handshake that fails is asked again on the next call. Listed under those limits, a tree the platform would refuse for its size is refused while it is listed, with `mthds`'s `TreeLimitExceededError` naming the limit, before any file is hashed.

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

`MethodFileTransferError` is thrown when a file could not be moved between this machine and storage. `operation` says which way (`upload` for a save or a crate request, `download` for `writeMethodTree`), `code` why, `sha256` which bytes, `path` the tree path when one is known, and `status` storage's HTTP status when it answered. Neither its message nor any member carries the link, nor storage's error body, which can echo the signed request, and it keeps no `cause`: the failure `fetch` throws for a request that got no answer can quote the URL, so only its network code (`ECONNREFUSED`, `ABORT_TIMEOUT`) reaches the message.

| `code` | When | Retryable |
|---|---|---|
| `unreachable` | Storage gave no answer: the connection failed or the time limit ran out. | yes |
| `storage_error` | Storage timed out or throttled the request (`408`, `429`) or failed (a `5xx` other than `501`). | yes |
| `refused` | Storage refused the request with any other status, an expired link among them. Read the method again for fresh links. | no |
| `mismatch` | A download's bytes are not the file the listing names: another size, or another SHA-256. | yes |

Its `errorDomain` is always `runtime`. An upload to a target that asks for a create-only write (`If-None-Match`) and answers `412` is not a failure: the bytes are already stored.

## What changed from the source fields

A method used to hold its source as two strings, `mthds` (a bundle, or the JSON text of a file array) and `python` (the JSON text of the custom PipeFunc files), and a version carried `source_digest`. Both fields are gone from every read and every write, with no alias kept: a method is a tree, a version's digest is `tree_digest`, and the publish state is derived from the two digests, the draft unchanged when `draft_digest` is not `null` and equals `latest_published.tree_digest`. `methodSourceToContents`, `getMethodClosure` and `EmptyMethodSourceError` went with them.

A run's `source_digest` is something else, and stays: the SHA-256 of the sources a run sent as text, 64 hex digits with no prefix. `RunDetail` also carries the run's `tree_digest` and `crate_fingerprint`, each `null` for a run that recorded none.
