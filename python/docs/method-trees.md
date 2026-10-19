# A saved method's tree

A saved method holds a **method tree**: the files a method is made of, each at its tree path, the same tree a run takes as `files`. The draft holds one, and each published version holds the one it was published from. A tree is named by its **tree digest**, `sha256:` and the SHA-256 of its listing, so two methods holding the same files hold the same digest. Both are defined by the MTHDS standard (`mthds/docs/spec/method-tree.md`), and this SDK reads and writes them through `mthds`'s own library, `mthds.method_tree`, so the tree a save sends is the tree a run or a validate would send.

The platform keeps each file once per organization, as a blob named by its SHA-256, so a save sends only the files the organization does not hold yet, and a read lists the files with a short-lived link to each one's bytes.

## Saving a tree

`create_method(MethodWriteInput)` and `write_draft(method_id, MethodDraftInput)` take the tree in one of three forms:

| Form | What it is | How it is sent |
|---|---|---|
| `files` | The standard's map of file entries (`mthds.method_tree.file_entry.FileEntry`): a text, `{"base64": …}`, or `{"sha256": …, "size": …}` for bytes the organization already holds. | As given. |
| `tree` | A tree listed from a directory or a `.mthds` file, by `list_method_tree`. | Inline when small, by hash otherwise (below). |
| `contents` | Each file's bytes, or its text, by tree path. | Inline when small, by hash otherwise (below). |

A tree given as `tree` or `contents` is sent **inline** when its inline map weighs 256 KiB or less, written as JSON with no whitespace, or when the platform keeps no blob store, which its version handshake says (`blob_store`). Otherwise the client asks `POST /v1/blobs/missing` which files the organization lacks, naming the tree's digest, uploads each one it lacks once, straight to the upload target the platform names, and sends every file by hash. This is `mthds`'s `prepare_files` and `prepare_files_from_contents`, run before the save. A file uploaded once is never uploaded again, by this method or any other of the organization.

An answer of `POST /v1/blobs/missing` this SDK cannot read, a body that is not JSON or not the route's answer, is the `ApiResponseError` of an answer the SDK cannot read, as on every other route. So is an answer asking for a blob the tree does not hold, which is the platform's fault and not the caller's: verdict `runtime`, not retryable, raised before any upload. Its upload targets are signed links, so `response_body` carries the answer with every link redacted, and the error chains at most a copy of pydantic's refusal whose values are redacted the same way. A call to `prepare_files` or `prepare_files_from_contents` of its own reads these answers the same way.

A text in `contents` is encoded in UTF-8, and a text a file cannot hold, one carrying a lone surrogate, is refused. Every file of a tree listed from a directory is read again before it is sent and checked against the hash its listing recorded, so a file changed since the listing raises `mthds`'s `TreeSourceError` rather than send another tree than the one listed.

```python
from pathlib import Path

from pipelex_sdk.product_models import MethodDraftInput, MethodWriteInput

tree = await client.list_method_tree(Path("methods/receipts"))
method = await client.create_method(MethodWriteInput(name="Receipts", tree=tree))

draft = await client.write_draft(
    method.method_id,
    MethodDraftInput(contents={"main.mthds": source, "helpers/fx.py": helper}, expected_updated_at=method.updated_at),
)
```

**A draft write replaces the whole tree.** `write_draft` refuses a draft that gives no tree, and an explicit `files=None` empties the draft. `create_method` with no tree creates a method with an empty draft. The client refuses two forms at once, and `contents` holding no file, with a `RequestArgumentError` before anything is sent; `mthds` refuses a `tree` holding no file the same way.

The save is refused, with the `ApiResponseError` of its problem, when the platform will not take the tree:

| Status and `code` | When |
|---|---|
| `422` `invalid_method_files` | The map breaks the standard's rules, a path that is not a tree path or two paths that collide among them; the problem's `tree_refusal` names the rule. |
| `422` `method_tree_too_large` | The tree passes one of the deployment's limits, which the problem's `limit` names. |
| `422` `blob_mismatch` | A hash entry states another size than the blob the organization holds under that hash. |
| `422` `missing_blobs` | A hash entry names bytes the organization does not hold. A save built from `tree` or `contents` uploads every blob it names first, so it meets this only if a blob was removed between the upload and the save; the client does not retry it. |
| `413` `payload_too_large` | The method would leave no room for the summary a publish adds. |

An upload that fails raises `MethodFileTransferError` with `operation` `upload`, and the method is not saved (below).

## The deployment's limits

`method_tree_limits()` returns the limits the deployment holds a tree to, as `mthds.method_tree.models.TreeLimits`: the most files, the largest file and the largest total, read from `limits.method_tree` of the public version handshake (`GET /v1/version`). A limit the server does not announce is left unset, and none is ever assumed, so a bare runner, which announces none, yields no limit. `list_method_tree(path)` lists a tree under those limits, off the event loop, so a tree the platform would refuse for its size is refused while it is listed, with `mthds`'s `TreeLimitError` naming the limit, before any file is hashed.

## Reading a tree

`get_method(method_id)` answers a `MethodDetail`: the method, with `files`, the draft's tree listed in tree path order. `get_method_version(method_id, version)` answers a `MethodVersion`: the version's summary, with the same `files`. Each file is a `SavedMethodFile`:

| Field | Meaning |
|---|---|
| `path` | Its tree path. |
| `sha256` | The SHA-256 of its bytes, 64 lower-case hex digits. |
| `size` | Its size in bytes. |
| `url` | A link to its bytes, signed by storage, which any HTTP client reads with no credential. |
| `expires_at` | When the link stops working, about fifteen minutes after the read. |

An empty draft lists no file and has a `draft_digest` of `None`. The listing pages are lighter: `list_methods` rows and `list_method_versions` summaries carry the digest and no files.

**A link is a bearer credential.** Anyone holding it reads the file until it expires, so it belongs in no log, message or stored record; this SDK puts it in none of its errors, and a `SavedMethodFile`'s `repr` leaves it out. A read that fails because a link expired succeeds once the method is read again.

An answer of these two routes the SDK cannot read, a listing whose `sha256` is not 64 lower-case hex digits or whose `size` is negative among them, is an `ApiResponseError` that reaches no link either: `response_body` has every `url` member and every link's query replaced by `[redacted]`, and the error's chain holds no failure that holds the body. A pydantic refusal is chained as a copy keeping each error's type and location, so a caller can still read which member was refused, its values redacted the same way; a body that is not JSON chains nothing, since `json.JSONDecodeError` holds the whole document. Neither the cause nor the context of the error is the original failure, so no traceback prints it.

A method whose draft names a tree the platform holds no record of answers `get_method` with a `409` whose verdict is `runtime`, and a version stored before methods were trees and never rewritten as one names no tree to serve, so `get_method_version` answers it with `409` `conflict`, whose verdict is `runtime` too.

## Writing a tree to disk

`write_method_tree(files, destination=…)` writes a listing to disk, each file at its tree path under `destination`:

```python
detail = await client.get_method("mt_123")
await client.write_method_tree(detail.files, destination=Path("receipts"))
```

Each file is downloaded through its link, at most eight at a time, by an HTTP client apart from the API client, so neither the API key nor any header of this client goes to storage. A file holds its turn until its bytes are on disk, so no more than eight are held in memory at once, and each download runs under `request_timeout_seconds` for its whole exchange, the body included, so a body that stalls once its headers arrived times out too. Each file's size and SHA-256 are checked against the listing, so what lands on disk is the tree the digest names. The first failure stops the write, the downloads still running cancelled. The files are written into a fresh hidden directory beside `destination`, which takes the name `destination` only once every file is written, so a failed, interrupted or cancelled write leaves nothing under that name and removes what it wrote. The checks on disk, the directories, the move into place and the cleanup run off the event loop.

`destination` is made absolute and normalized first, without following a symbolic link, so a relative one, `Path(".")` included, names the directory it means, and the hidden directory sits beside it rather than inside it. It must not exist, or must be an empty directory: one holding anything is refused, rather than written into or replaced, and so is the root of a filesystem. An empty directory is replaced by the written tree's directory, so a process whose working directory it was has to change into it again. A listing holding a path that is not a tree path, the same path twice, or two paths that collide once case-folded or where one names a directory of the other, is refused too. Each refusal is a `RequestArgumentError` raised before any download. An empty listing writes an empty directory.

## When a transfer fails

`MethodFileTransferError` is raised when a file could not be moved between this machine and storage. `operation` says which way (`upload` for a save, `download` for `write_method_tree`), `code` why, `sha256` which bytes, `path` the tree path when one is known, and `status` storage's HTTP status when it answered. Neither its message nor any member carries the link, nor storage's error body, which can echo the signed request, and it keeps neither a cause nor a context: the `mthds` error an upload refusal starts as quotes that body, and httpx's error for a request that got no answer, or whose body httpx could not decode (`DecodingError`), holds the request and its URL.

| `code` | When | Retryable |
|---|---|---|
| `unreachable` | Storage gave no answer: the connection failed, the time limit ran out (`TimeoutError` in the message), or the body could not be decoded. An upload that got no answer carries no `sha256`, since `mthds` does not say which blob it was. | yes |
| `storage_error` | Storage timed out or throttled the request (`408`, `429`) or failed (a `5xx` other than `501`). | yes |
| `refused` | Storage refused the request with any other status, an expired link among them. Read the method again for fresh links. | no |
| `mismatch` | A download's bytes are not the file the listing names: another size, or another SHA-256. | yes |

Its `error_domain` is always `runtime`. An upload to a target that asks for a create-only write and answers `412` is not a failure: the bytes are already stored.

## What changed from the source fields

A method used to hold its source as two strings, `mthds` (a bundle, or the JSON text of a file array) and `python` (the JSON text of the custom PipeFunc files), and a version carried `source_digest`. Both fields are gone from every read and every write, with no alias kept: a method is a tree, a version's digest is `tree_digest`, and the publish state is derived from the two digests, the draft unchanged when `draft_digest` is not `None` and equals `latest_published.tree_digest`. `method_source_to_contents`, `MethodFile`, `parse_method_files` and `serialize_method_files` went with them.

A run's `source_digest` is something else, and stays: the SHA-256 of the sources a run sent as text, 64 hex digits with no prefix. `RunDetail` also carries the run's `tree_digest` and `crate_fingerprint`, each `None` for a run that recorded none.
