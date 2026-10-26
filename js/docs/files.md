# An organization's files

A **file** is the record the hosted platform keeps of a stored object: a member's upload, a test file made for a method, or a file a run made that reached its result. The bytes stay where they were written, and a run, a form or an example still points at them by their `pipelex-storage://` address; the record adds what the bytes lack, the name a person sees, a kind, a type, a size and where the file came from. A file belongs to the organization: every role of it reads every file of it, as every role reads every run. The client reaches them on the hosted API's `/v1/files` routes, a run's files on `GET /v1/runs/{run_id}/files` and the copy into a method's draft on `POST /v1/methods/{method_id}/draft/files/from-file`, and the types are in `src/product-models.ts`. The platform's own contract is `platform/docs/files.md` in `pipelex-server`.

The point of the list for a program is the `uri` on every row: a run's inputs take it as they take any address, so an agent or an app can find "the invoice uploaded this morning" and run a method on it without uploading it again.

## A row — `FileSummary`

| Field | Meaning |
|---|---|
| `file_id` | The record's id, `fl_…`. |
| `uri` | The `pipelex-storage://` address of the bytes. |
| `name` | The name shown and used for downloads. It starts as the name the file arrived with and changes with a rename. |
| `media_type` | The MIME type the object is stored under. |
| `format` | The format key the list's `format` filter matches: `pdf`, `docx`, `image`, `html` and the rest of the runtime's table. |
| `size` | The byte size. |
| `kind` | A `FileKind`: `uploaded`, a person's upload or a run's inline input; `generated`, a file a run made whose result reaches it; `test`, a test input made for one method. |
| `origin` | A `FileOrigin`, who or what made the file, each member `null` where the kind fills no value: `surface`, the surface an upload came through as its `User-Agent` declared it (`app`, `mcp`, `cli`, `n8n`, `hook`, `sdk`, `raw_http`), which is provenance to show and never authority; `run_id`, the run that made it; `method_id`, the method whose run made it or the method a test file was made for; `method_version`, the version number or `"draft"` that ran. |
| `created_at` | The ISO-8601 instant the record was made. |
| `created_by` | The member the file is attributed to: the uploader, or the member who started the run that made it. |

**A list never holds a file a run made along the way** (an intermediate file, which the run's result does not reach), **nor an upload whose bytes have not been seen stored**, nor anything of another organization.

## The whole record — `FileRecord`

A file read by its id or its address, renamed, or listed among a run's files is answered whole: a `FileRecord` is a `FileSummary` with five more fields.

| Field | Meaning |
|---|---|
| `source_uri` | The address the record was written under before another run or an example took the file and the platform copied it into the organization's `assets/`, `null` until then. The record keeps its `file_id`, its names and its place on every list when it moves; its `uri` becomes the copy's. |
| `original_name` | The name the file arrived with, never changed. A rename adds this name's extension to the new name when it lacks it ([below](#renaming-a-file)). |
| `sha256` | The lowercase hexadecimal hash of the bytes, or `null` for a file stored before every writer sent one. |
| `role` | A `FileRole` for a generated file, `final` (it reached the run's result) or `intermediate` (made along the way); `null` for every other kind. |
| `state` | A `FileState`: `stored`, or `pending` while an upload's bytes have not been seen. Only a read by id or by address can answer a `pending` record, since no list holds one. |

## The methods

| Method | Route | Answer |
|---|---|---|
| `listFiles(query?)` | `GET /v1/files` | One `FilePage`, `{ items, nextCursor }`, newest first. |
| `iterateFiles(query?)` | the same, page after page | Every file the query selects, as an async iterator. |
| `getFile(fileId, { usesLimit?, usesCursor? })` | `GET /v1/files/{file_id}` | A `FileDetail`: the whole record, the methods whose lists hold it and one page of its uses. |
| `getFilesByUri(uri, { runId? })` | `GET /v1/files/by-uri` | A `FileRecordList`, `{ items }`: every record holding the address, the one to show first. |
| `renameFile(fileId, { name })` | `PATCH /v1/files/{file_id}` | The `FileRecord` as it now stands. |
| `linkFiles(files)` | `POST /v1/files/links` | A `FileLinksResult`, `{ items }`: one `FileLink` per requested file, in order, each a link or an error. |
| `requestFileArchive(request)` | `POST /v1/files/archives` | The `FileArchive`, `queued`. |
| `getFileArchive(archiveId)` | `GET /v1/files/archives/{archive_id}` | The `FileArchive` as it stands, with a link to the zip once it is `ready`. |
| `listRunFiles(runId, { limit?, cursor? })` | `GET /v1/runs/{run_id}/files` | One `RunFilesPage`: the run's inputs, outputs, intermediate files and web links, with `nextCursor`. |
| `copyFileIntoDraft(methodId, { file_id, path, expected_updated_at? })` | `POST /v1/methods/{method_id}/draft/files/from-file` | A `DraftFileFromFileResult`, discriminated on `blob`. |

Every method putting an id in its path refuses one that is empty, `.` or `..`, or that holds a lone surrogate, with `RequestArgumentError` before sending, as every route of the SDK does, and every body is closed on the platform, so the client sends the fields the route takes and nothing else an untyped caller adds, a `null` member reading as not given. Every role of the organization reads every file, link and archive of it; only a rename and the copy into a draft are refused to some roles, each saying which below.

```ts
const page = await client.listFiles({ q: "invoice", kind: "uploaded", format: ["pdf"] });
for (const file of page.items) console.log(file.name, file.uri);

// A method's files: what its runs and examples took or made.
for await (const file of client.iterateFiles({ methodId: "mt_abc123" })) {
  if (file.kind === "test") console.log("test input", file.name);
}
```

## The query — `ListFilesQuery`

Every member is optional, and each is sent only when given, so an empty `q`, cursor or date is sent and refused by the API rather than dropped into an unfiltered list. The members follow the SDK's camelCase, as `ListRunsQuery`'s do, and each is sent under the API's own name.

| Member | Sent as | Meaning |
|---|---|---|
| `methodId` | `method_id` | The method's list, by its bare catalog id: the files its runs and examples took or made. |
| `runId` | `run_id` | The run's own list: its final outputs and its inline inputs, **in the order of their addresses** rather than newest first. Beside `methodId`, the run's list when the method is the run's own, and an empty page otherwise. The files a run took from the organization as inputs are not in it. |
| `createdBy` | `created_by` | One member's files by user id, or `"me"` for the caller's own: their uploads and their runs' outputs. |
| `kind` | `kind` | `uploaded`, `generated` or `test`. |
| `format` | `format`, repeated | Only the files of one of these format keys, one parameter per value (`format=pdf&format=image`), at most 100. |
| `mediaType` | `media_type`, repeated | Only the files of one of these MIME types, one parameter per value, at most 100. |
| `createdFrom`, `createdTo` | `created_from`, `created_to` | ISO-8601 **instants** with an offset, both inclusive. A bare date or a naive timestamp is a `400`, since only the caller knows which time zone's day it means. |
| `q` | `q` | A case-insensitive search in the name and the name the file arrived with, at most 200 characters. |
| `limit` | `limit` | Page size, 1 to 200, 50 by default. |
| `cursor` | `cursor` | The previous page's `nextCursor`. `iterateFiles` takes no cursor: it follows its own. |

`methodId`, `runId` and `createdBy` choose which list serves the page, and with none of them it is the organization's. The other members filter that list.

**An empty `format` or `mediaType` is refused before any request** with a `RequestArgumentError`, since a list with no value would be sent as no parameter at all and list every format; a value that is not a list of strings is a `TypeError`, a bug in the calling code. Everything else the API checks itself: a `limit` out of range, an unknown `kind`, more than 100 values of `format` or `mediaType`, or an id that cannot be one is a `422`; a date bound that is not an instant with an offset, a range whose start is after its end, or a cursor of another list or other filters is a `400`; and a run that is not the organization's is a `404` `run.not_found`. Each is an `ApiResponseError` ([errors.md](./errors.md)).

## Paging

**Only a `null` `nextCursor` ends a list.** The platform applies the filters to the rows a page reads and never refills the page, so a filtered page can hold fewer rows than `limit`, or none, and still carry a cursor; a client keeps asking until the cursor is `null`. **A cursor is bound to the list and the filters that issued it**, so a client passes it back with the same query, and passing it to another is a `400`.

`iterateFiles` does both: it sends the same query with every page, keeps going through an empty page that carries a cursor, stops on a `null` cursor or on a cursor the server failed to advance, and throws `PagingNotTerminatingError` past a page ceiling no real list reaches, through the loop `iterateMethods`, `iterateRuns` and `iterateMethodExamples` share. A page whose `items` is not an array, or whose `next_cursor` is neither a string nor `null`, is an `ApiResponseError` of an answer the SDK cannot read (`client.response_unreadable`), never a page the iterator walks.

## One file and its uses

`getFile` answers a `FileDetail`: the file's `FileRecord`, its `method_ids`, the methods whose lists hold it, and `uses`, a `FileUsePage` of the examples that hold its address, then the runs that took it. Each `FileUse` names the `uri` it holds, its `holder_type` (`example` or `run`), its `holder_id`, the `method_id` it belongs to, its `created_at`, its `created_by` and its `method_version`. A use names an address, so every record holding that address shows the same uses.

**`created_by` names who made the use's holder**: the member who started the run, or who saved the example, copied onto the use when it was recorded, so a client tells its own runs among a file's uses by comparing it with the `user_id` that `getMe()` answers, without reading any run. It is `null` on a use recorded before uses carried it, until the platform's stored-files migration fills it, and on every use from a platform that predates the member, which leaves it out and `getFile` reads as `null`, never `undefined`; `getFile` reads a member that is not a string as `null` too, so the field is always a string or `null`. A `null` therefore says that the creator is unknown, never that nobody made the holder.

**`method_version` names the version its run ran**: the published version's number, or the string `"draft"` for a run of the method's draft, copied from the run onto the use when it was recorded, so a client tells a run of a published version from a run of the draft without reading any run. It is `null` on an example's use, which runs nothing, on a run of an inline source, which has no saved method, and on a run's use recorded before uses carried it, until the platform's stored-files migration fills it. A platform that predates the member leaves it out, and `getFile` reads that as `null`, never `undefined`; it reads a value that is neither an integer nor `"draft"`, a number with a fraction included, as `null` too, so the field is always an integer, `"draft"` or `null`.

```ts
const detail = await client.getFile("fl_0199");
for (const use of detail.uses.items) {
  console.log(use.holder_type, use.holder_id, use.created_by, use.method_version);
}
if (detail.uses.next_cursor !== null) {
  const more = await client.getFile("fl_0199", { usesCursor: detail.uses.next_cursor });
}
```

The uses are paged inside the answer, so their cursor keeps the platform's spelling, `uses.next_cursor`, and goes back as `usesCursor`; `usesLimit` is 1 to 200, 50 by default. A record whose upload looked unfinished past the upload grant's lifespan is settled by the read, which answers it `stored` when its bytes are there. A file that is not the organization's is a `404` `pipelex.storage.not_found`. An answer whose `uses` is not a page of `items` and `next_cursor` is an `ApiResponseError` of an answer the SDK cannot read (`client.response_unreadable`).

## The records of an address

Several records hold one address when several members uploaded the same bytes, each under the name they gave it. `getFilesByUri` answers every one, **the first being the one a surface shows**: with `runId`, the records of the member who started that run come first, so a run's inputs show the name its starter gave the file; then the caller's; then the rest, each group oldest first. A record whose upload has not finished is answered with its `state`, `pending`. **An address no record holds answers an empty `items`**, which is how a client tells a file stored before the platform kept records, never an error.

```ts
const { items } = await client.getFilesByUri(input.uri, { runId: run.pipeline_run_id });
const shown = items[0]?.name ?? input.uri.split("/").pop();
```

A `uri` that is not a non-empty string is refused before any request. The platform answers `422` `pipelex.storage.uri_invalid` for a malformed address, `403` `pipelex.org.mismatch` for another organization's, `404` `run.not_found` for a run that is not the organization's and `422` `request.invalid` for an address over 512 characters.

## Renaming a file

`renameFile` changes the file's `name` alone, never its bytes, its address or its `original_name`, and answers the record as it now stands. **Read the saved name from the answer**, since the platform holds every name to one rule: it removes the characters no list or header can show (control and format characters, a right-to-left override among them), trims the ends, refuses a name with nothing left, and adds the file's own extension, the one its `original_name` ends with, when the name does not already end with it, case aside. `March invoice` becomes `March invoice.pdf`, `March.docx` becomes `March.docx.pdf`, and a file whose original name has no extension, `Makefile` or `.env`, gains none. A form can show the name the rule will save as the person types, from the record's `original_name`.

```ts
const renamed = await client.renameFile("fl_0199", { name: "March invoice" });
console.log(renamed.name); // "March invoice.pdf"
```

**An `admin` or a `member` renames any file; any other role, a runner among them, renames only the files whose record names it as `created_by`**: its own uploads and the outputs of the runs it started. Past that the platform answers `403` `auth.forbidden`, its `detail` naming the caller's role. A `name` that is not a string is refused before any request; a name over 512 characters or with nothing left once cleaned is a `422` `request.invalid`, and a file that is not the organization's a `404` `pipelex.storage.not_found`.

## Links that name the file

`linkFiles` asks for fresh links to read files, each named by exactly one of its record's id, `{ file_id }`, and its address, `{ uri }`, at most 100 in one request. The answer holds exactly one `FileLink` per requested file, in the request's order. **Branch on each item's `error`, never on the status**: the request is a `200` whenever every file got a verdict.

- A linked file carries `url`, a presigned `GET` valid for fifteen minutes, its `expires_at`, the `name` a download saves under and its `media_type`, with `error` `null`.
- A file that got no link carries `error`, a `FileLinkError` `{ code, detail }`, and `null` `url`, `expires_at`, `name` and `media_type`: `not_found` for an unknown file id, `conflict` for a file whose upload has not finished, `invalid_storage_uri` for a malformed address and `forbidden` for another organization's. `code` is typed as a string, so a code a later platform adds still reads.

```ts
const { items } = await client.linkFiles([{ file_id: "fl_0199" }, { uri: input.uri }]);
for (const link of items) {
  if (link.error === null) window.open(link.url);
  else console.warn(link.error.code, link.error.detail);
}
```

**Each link is signed with a `Content-Disposition` naming the file**, so a download saves under the name a person sees rather than the bytes' hash. It opens in place for an image, a PDF or plain text and downloads for every other type, SVG, HTML and XML included, so a file that could run scripts never opens from a link. A file named by its id is linked under its record's name; an address under the name of its first stored record, the caller's before another member's, whose id the item's `file_id` then names.

**A link is a bearer capability.** Keep it out of logs and ask again for a fresh one rather than storing it. The SDK keeps it out of its own errors: an answer it cannot read, one that is not one item per requested file or whose item carries neither a link nor an error, is an `ApiResponseError` whose `responseBody` replaces every `url` member and every link's query with `[redacted]` ([errors.md](./errors.md)). An item that does not name exactly one of `file_id` and `uri` as a non-empty string, or a `files` that is not a list, is refused before any request. The platform answers `422` `request.invalid` for more than 100 files, and a `500` `pipelex.storage.not_configured` when it cannot sign at all.

## A zip of files

The platform cannot build a zip inside a request, so a zip takes two calls. `requestFileArchive` queues the archive and answers at once, `queued`; `getFileArchive` reads it until its `state` is `ready`, whose `url` downloads the zip, or `failed`, whose `failure` says why. **An archive is never a file**: no list shows it, and it is gone a day after it was asked for, when a read of it answers `404` `pipelex.storage.not_found` as for an id never seen.

The request names the files by exactly one of two members, and both are refused before any request when neither or both is given:

- `file_ids`, a non-empty list of the organization's file ids, in the order the zip holds them. An id given twice is zipped once, and a file made along the way is allowed.
- `run_id`, a run of the organization, whose zip holds what went in and what came out of it: the stored files of its inputs, then its final outputs. Never a file it made along the way, nor an input given as a web link, which the platform holds no bytes of.

`name`, optional, is the name the zip downloads under. The platform makes it a download's name, taking out what no file system accepts and ending it in `.zip`; omitted, or with nothing usable left, it is `files-<run_id>.zip` for a run and `files-<YYYYMMDD-HHMMSS>.zip`, the request's instant in UTC, otherwise. Read the saved name from the archive's `name`.

```ts
let archive = await client.requestFileArchive({ file_ids: selected, name: "March invoices" });
while (archive.state === "queued" || archive.state === "building") {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  archive = await client.getFileArchive(archive.archive_id);
}
if (archive.state === "ready") window.location.assign(archive.url!);
else console.warn(archive.failure?.code, archive.failure?.detail);
```

**Branch on `state`.** `queued` and `building` mean read it again shortly: a zip of a few files is ready within seconds, and the largest the caps allow within a few minutes. The SDK has no waiting helper, since how long to wait and how to show it is the caller's. `ready` carries `url`, a presigned `GET` valid for fifteen minutes and signed with a `Content-Disposition` naming the archive's `name`, with `url_expires_at`, `archive_bytes`, the zip's own size, and `ready_at`. Each read signs a fresh link, so a caller that let one lapse reads the archive again. `failed` carries a `FileArchiveFailure`: `file_gone`, a selected file deleted before the zip was ready, or `build_failed`, and the remedy for both is a new request. An archive still `queued` or `building` an hour after it was asked for reads as `failed`. `url` and `url_expires_at` are `null` in every state but `ready`, and an answer the SDK cannot read hides the link in its error as `linkFiles`' does.

| Field | Meaning |
|---|---|
| `archive_id` | `arc_…`, the id `getFileArchive` takes. |
| `name` | The name the zip downloads under. |
| `state` | A `FileArchiveState`: `queued`, `building`, `ready` or `failed`. |
| `source`, `run_id` | `files` for a request by `file_ids`, `run` for one by `run_id`, whose `run_id` the archive then carries; `null` otherwise. |
| `file_count`, `total_bytes` | How many files the zip holds and their total size before compression. |
| `created_at`, `expires_at` | When it was asked for, and when it is gone, a day later. |
| `archive_bytes`, `ready_at` | The zip's own size and when it was ready; `null` until then. |
| `failure` | A `FileArchiveFailure`, `{ code, detail }`, on a `failed` archive; `null` otherwise. |
| `url`, `url_expires_at` | The link to the zip and when it lapses, on a `ready` archive; `null` otherwise. |

**A selection past a cap is a `422` `pipelex.files.archive_too_large`**, checked before anything is written or queued: at most 500 files, or 2,000,000,000 bytes in all. Its problem's `limit` member, read from the error's `problem` and typed `FileArchiveLimit`, names the cap, `max_files` or `max_total_bytes`, its `value` and what the selection `reached`, so a client can tell the person how far over the selection is and split it. A run's count stops as soon as it passes the cap, so for a run `reached` is one more than the cap.

```ts
try {
  await client.requestFileArchive({ file_ids: selected });
} catch (err) {
  if (err instanceof ApiResponseError && err.code === "pipelex.files.archive_too_large") {
    const limit = err.problem.limit as FileArchiveLimit;
    console.warn(`${limit.name}: ${limit.reached} over ${limit.value}`);
  }
}
```

The other refusals of a request: `422` `request.invalid` for more than 1,000 ids listed or an id longer than one can be; `404` `pipelex.storage.not_found` for a file that is not the organization's, the `detail` naming up to five of them, or a run whose files hold nothing stored to zip; `404` `run.not_found` for a run that is not the organization's; `409` `run.not_finished`, `retry` `yes`, for a run whose files are not all recorded yet, which the same request clears a few seconds after the run ends, and a `409` with `retry` `no` for a selected file whose upload has not finished; and `503` `runtime.unavailable`, `retry` `yes`, when the archive could not be queued. Each is an `ApiResponseError` whose problem's `domain` and `retry` say what to do ([errors.md](./errors.md)).

## A run's files

`listRunFiles` answers a `RunFilesPage` of what went in, what came out and what was made along the way, sorted by where each file sits in the run. Each `RunFileEntry` carries its `mark` (`input`, `final` or `intermediate`), the `input_name` of the run's input that held an input given by its address (`null` for an inline input and for every file the run made), its `uri` and the `FileRecord` a surface shows for it, `null` for an input no record holds.

| Member | Meaning |
|---|---|
| `pipeline_run_id` | The run. |
| `state` | A `RunFilesState`: `listing` until the platform has recorded every file of the run, a few seconds after it ends, then `listed`. |
| `inputs` | What went in: the inputs given by their address, with the record of the member who started the run first, then the inline inputs. |
| `outputs` | The run's final outputs. |
| `intermediates` | The files the run made along the way, which no list of the organization's files holds. |
| `links` | The inputs given as a web link, each a `RunInputLink` with its `input_name`, its `url` and the `warning` that replaying the run needs the link to still serve the same file. The platform holds no record or bytes of them. |
| `nextCursor` | The cursor of the next page, or `null` on the last, read from the platform's `next_cursor` as every page of the SDK reads it. |

```ts
let page = await client.listRunFiles(runId);
while (page.state === "listing") {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  page = await client.listRunFiles(runId);
}
for (const entry of page.outputs) console.log(entry.file?.name ?? entry.uri);
```

**Take the list as whole only once `state` is `listed`.** The run's own records, its outputs, its intermediate files and its inline inputs, are paged by address with `limit` (1 to 200) and `cursor`; the inputs given by address and the links come on the first page only. Pass `nextCursor` back as `cursor` until it is `null`. A run that is not the organization's is a `404`, exactly as one that does not exist; a run id holding a character outside letters, digits, `_` and `-`, or a cursor another listing issued, is a `400`; and a `limit` outside 1 to 200 is a `422`. A page whose `state` is neither, whose four lists are not arrays, or whose `next_cursor` is neither a string nor `null`, is an `ApiResponseError` of an answer the SDK cannot read.

## Adding a file to a method's draft

`copyFileIntoDraft` copies one of the organization's files into a method's draft at `path`, such as `assets/logo.png`, replacing a file already there: the app's "Add to method files". The bytes are copied by the storage service itself, so they never cross the client or the API whatever their size, and the method file then lives apart from its source: erasing the file's record, the run that made it or the method it came from leaves it readable.

The answer is a `DraftFileFromFileResult`, a `200` discriminated on `blob`: `copied`, or `already_held` when the organization's blob store already held the bytes and nothing was copied. Both carry the `file` as the draft's tree now names it, `{ path, sha256, size }`, and the `method` as the draft write stored it, a `MethodData` whose `updated_at` is the new draft token.

```ts
const method = await client.getMethod("mt_abc123");
const added = await client.copyFileIntoDraft("mt_abc123", {
  file_id: "fl_0199",
  path: "assets/logo.png",
  expected_updated_at: method.updated_at,
});
let draftToken = added.method.updated_at;
```

**With `expected_updated_at`, the write is a compare-and-swap on the draft token**, refused with `409` `pipelex.catalog.update_conflict` when the draft has moved on; without it, the file is added to the draft as it stands, never erasing someone else's save. It takes a bare catalog id, as `writeDraft` does, and refuses a `file_id` or a `path` that is not a non-empty string, or an `expected_updated_at` that is not a string, before any request. It is a write of the method, so the platform answers `403` `auth.forbidden` to a role that may not change methods, such as a runner; and `404` for an unknown method or a file that is not the organization's, `409` `pipelex.catalog.being_deleted`, `409` for a file whose upload has not finished or whose stored bytes do not match its record, `422` `method.package_invalid` for a path the draft cannot hold, such as `.env` or `../logo.png`, and `422` `method.package_invalid` past the deployment's limits. An answer whose `blob` is neither arm's, or whose `file` or `method` is not an object, is an answer the SDK cannot read.

## Uploading a test file

What an upload is recorded as travels with it to `POST /v1/upload` or `POST /v1/upload/grant`: its `kind`, `uploaded` when omitted, and for a `test` file the bare catalog id of the method it is for, `method_id`. A test file is a statement about a method, so the platform holds it to what changing that method takes. The pair is spelled the same on every surface that sends it: `UploadInput` (the raw `upload`), `UploadGrantInput` (`requestUploadGrant`, [input-preparation.md](./input-preparation.md#uploading-with-a-grant--requestuploadgrant--uploadwithgrant)), `UploadFileOptions` (`uploadFile`) and `prepareInputs`' nested `upload` member, which applies to every file the preparation uploads. `UploadKind` names the two kinds, and `UploadKindOptions` the pair.

```ts
// One file the build assistant made to try a method:
await client.uploadFile("cases/invoice.pdf", { kind: "test", method_id: "mt_abc123" });

// Every file a preparation uploads, recorded as test files of the method it prepares:
const prepared = await client.prepareInputs({
  method_id: "mt_abc123",
  inputs: { invoice: "cases/invoice.pdf" },
  upload: { kind: "test", method_id: "mt_abc123" },
});
```

`upload` is nested so that its `method_id`, the method a test file is for, never reads as the request's own `method_id` selector, which names the method whose inputs are prepared and excludes `method_ref` and the method's tree.

**The pair is checked before any file is read**, as the upload route checks it, so a request the route would refuse with a `422` is an `InputPreparationError` instead: a `kind` that is neither `uploaded` nor `test`, a `method_id` that is not a catalog id or carries a version suffix, `kind: "test"` without a `method_id`, and a `method_id` without `kind: "test"`. `null` reads as absent. `prepareInputs` names the members it refuses `upload.kind` and `upload.method_id`. `requestUploadGrant` sends its description as given, so the grant route's own `422` refuses a pair it would not take, and its refusals of a test file are the `ApiResponseError` the route answered.

**A test file the route refuses for what it claims is a `TestFileRefusedError`**, whose `reason` says why: `role_not_permitted`, the `403` `auth.forbidden` of a caller whose role may not change methods, such as a runner, which an admin of the organization must change, or which the caller avoids by uploading the file as `uploaded`; `method_not_found`, the `404` `pipelex.catalog.not_found` of a method that is not one of the organization's; and `method_being_deleted`, the `409` `pipelex.catalog.being_deleted` of a method being erased. It carries the `status`, the `filename` it was sending and the `methodId` it named, and wraps the `ApiResponseError` as `cause`, whose problem it carries. These refusals are read off the platform's code, never the status alone: a `403` of any other code is still a refused credential (`UploadAuthenticationError`), and a `404` is still a deployment without upload (`UnsupportedUploadCapabilityError`) unless the upload named a method and the platform answered `pipelex.catalog.not_found`, rather than the `404` of a route it does not serve ([input-preparation.md](./input-preparation.md#error-and-capability-behavior)).
