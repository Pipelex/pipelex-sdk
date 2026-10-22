# An organization's files

A **file** is the record the hosted platform keeps of a stored object: a member's upload, a test file made for a method, or a file a run made that reached its result. The bytes stay where they were written, and a run, a form or an example still points at them by their `pipelex-storage://` address; the record adds what the bytes lack, the name a person sees, a kind, a type, a size and where the file came from. A file belongs to the organization: every role of it reads every file of it, as every role reads every run. The client reaches the list on the hosted API's `GET /v1/files`, and the types are in `src/product-models.ts`. The platform's own contract is `platform/docs/files.md` in `pipelex-server`.

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

## The methods

| Method | Route | Answer |
|---|---|---|
| `listFiles(query?)` | `GET /v1/files` | One `FilePage`, `{ items, nextCursor }`, newest first. |
| `iterateFiles(query?)` | the same, page after page | Every file the query selects, as an async iterator. |

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

**An empty `format` or `mediaType` is refused before any request** with a `RequestArgumentError`, since a list with no value would be sent as no parameter at all and list every format; a value that is not a list of strings is a `TypeError`, a bug in the calling code. Everything else the API checks itself: a `limit` out of range, an unknown `kind`, more than 100 values of `format` or `mediaType`, or an id that cannot be one is a `422`; a date bound that is not an instant with an offset, a range whose start is after its end, or a cursor of another list or other filters is a `400`; and a run that is not the organization's is a `404` `run_not_found`. Each is an `ApiResponseError` ([errors.md](./errors.md)).

## Paging

**Only a `null` `nextCursor` ends a list.** The platform applies the filters to the rows a page reads and never refills the page, so a filtered page can hold fewer rows than `limit`, or none, and still carry a cursor; a client keeps asking until the cursor is `null`. **A cursor is bound to the list and the filters that issued it**, so a client passes it back with the same query, and passing it to another is a `400`.

`iterateFiles` does both: it sends the same query with every page, keeps going through an empty page that carries a cursor, stops on a `null` cursor or on a cursor the server failed to advance, and throws `PagingNotTerminatingError` past a page ceiling no real list reaches, through the loop `iterateMethods`, `iterateRuns` and `iterateMethodExamples` share. A page whose `items` is not an array, or whose `next_cursor` is neither a string nor `null`, is an `ApiResponseError` of an answer the SDK cannot read (`runtime`, not retryable), never a page the iterator walks.

## Uploading a test file

What an upload is recorded as travels with it to `POST /v1/upload`: its `kind`, `uploaded` when omitted, and for a `test` file the bare catalog id of the method it is for, `method_id`. A test file is a statement about a method, so the platform holds it to what changing that method takes. The pair is spelled the same on every surface that sends it: `UploadInput` (the raw `upload`), `UploadFileOptions` (`uploadFile`) and `prepareInputs`' nested `upload` member, which applies to every file the preparation uploads. `UploadKind` names the two kinds, and `UploadKindOptions` the pair.

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

**The pair is checked before any file is read**, as the upload route checks it, so a request the route would refuse with a `422` is an `InputPreparationError` instead: a `kind` that is neither `uploaded` nor `test`, a `method_id` that is not a catalog id or carries a version suffix, `kind: "test"` without a `method_id`, and a `method_id` without `kind: "test"`. `null` reads as absent. `prepareInputs` names the members it refuses `upload.kind` and `upload.method_id`.

**A test file the route refuses for what it claims is a `TestFileRefusedError`**, whose `code` says why: `role_not_permitted`, the `403` of a caller whose role may not change methods, such as a runner, which an admin of the organization must change (`config`), or which the caller avoids by uploading the file as `uploaded`; `method_not_found`, the `404` of a method that is not one of the organization's (`input`); and `method_being_deleted`, the `409` of a method being erased (`input`). It carries the `status`, the `filename` it was sending and the `methodId` it named, and wraps the `ApiResponseError` as `cause`, whose verdict it takes. These refusals are read off the platform's code, never the status alone: a `403` without `role_not_permitted` is still a refused credential (`UploadAuthenticationError`), and a `404` is still a deployment without upload (`UnsupportedUploadCapabilityError`) unless the upload named a method and the platform answered its domain miss, `not_found` with the `input` domain, rather than the `config` `404` of a route it does not serve ([input-preparation.md](./input-preparation.md#error-and-capability-behavior)).
