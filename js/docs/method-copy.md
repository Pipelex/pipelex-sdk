# Copying a method into another organization

A stored method belongs to the organization that holds it, and access to it comes from membership in that organization. `copyMethod` makes a new method in another organization the caller may change methods in, holding the original's draft, its form inputs and its saved examples, and leaves the original as it was. It is how a method reaches a team from the personal workspace that holds it, how it moves from a team into the caller's personal workspace, and, with the method's own organization as the destination, how a method is duplicated. `listMethodCopies` lists the copies made of a method, so a surface can say where they went. The client reaches them on the hosted API's `POST /v1/methods/{method_id}/copy` and `GET /v1/methods/{method_id}/copies`, and the types are in `src/product-models.ts`.

```ts
import { PipelexApiClient } from "@pipelex/sdk";

const client = new PipelexApiClient();
const method = await client.getMethod("mt_abc123");
const result = await client.copyMethod(
  method.method_id,
  { destination_org_id: "org_team", expected_draft_updated_at: method.updated_at },
  { idempotencyKey: crypto.randomUUID() },
);
if (result.outcome === "refused") {
  for (const { path, uri } of result.references) console.error(`${path} names ${uri}`);
} else {
  console.log(`copied as ${result.method.method_id} in ${result.method.org_id}`);
}
```

## The methods

| Method | Route | Answer |
|---|---|---|
| `copyMethod(methodId, { destination_org_id, name?, expected_draft_updated_at? }, { idempotencyKey? })` | `POST /v1/methods/{id}/copy` | A `MethodCopyResult`, discriminated on `outcome`: `copied` or `refused`. |
| `listMethodCopies(methodId, { limit?, cursor? })` | `GET /v1/methods/{id}/copies` | One `MethodCopyPage`, `{ items, nextCursor }`, of `MethodCopyMarker` rows. `limit` is 1 to 100, 50 by default. |

Both take a bare catalog id, as every method route does, and refuse a suffixed one (`mt_…@3`) with a `RequestArgumentError` before anything is sent.

**The copy's body is closed.** The client sends `destination_org_id` and, when given, `name` and `expected_draft_updated_at`, and nothing else; a `null` reads as not given. `destination_org_id` is the canonical id of the destination, as a membership's `org_id` gives it; `name` is the copy's name, the original's when it is left out; `expected_draft_updated_at` is the original's draft token the caller last saw (`MethodData.updated_at`). A `destination_org_id` that is not a non-empty string, and a `name` or a token given that is not a string, are refused with a `RequestArgumentError` before any request.

**Only a web session may copy.** A Pipelex API key belongs to one organization and cannot speak for another, so the platform refuses a copy sent with one `403` `forbidden`, whatever its role. The listing is a read, open to every member of the method's organization and to every credential.

## What a copy holds

| Part of the method | In the copy |
|---|---|
| The draft's files | The same tree, held in the destination, so the copy's `draft_digest` equals the original's |
| `name` | The original's, unless the request names another |
| `description` | The original's, which comes from the same tree |
| `input_data` | The original's form inputs, every stored file they name in the original's organization copied into the destination |
| Saved examples | Every example, in its order, each with a new id, at `input_revision` 1, with no latest run and the copier as its author, its inputs' stored files copied as the form inputs' are |
| Published versions | None: the copy starts unpublished, its `latest_version` and `latest_published` `null`, and its own publish makes version 1 |
| Runs | None: a run stays in the organization that ran it and was billed for it |
| `method_id`, `org_id`, `created_by_user_id`, `created_at` | A new id, the destination, the copier and the moment of the copy |
| `copied_from` | `{ org_id, method_id, draft_digest }` of the original, as it stood at the copy |

**The copy takes the draft, never the latest published version.** The draft is what the person sees in the editor, and the copy goes through its own first publish anyway; an invalid draft is copied as it is, and the copy's publish refuses it as it would any draft. With `expected_draft_updated_at`, the copy takes exactly the draft the caller last saw: a draft that moved since is a `409` `method_update_conflict`, and nothing is copied. A client that has just saved the editor's pending edits sends the token that save answered.

**A stored file named by an input is copied.** A `pipelex-storage://` address resolves only inside the organization it names, so every such address in the original's organization, in the form inputs and in each example's inputs, is copied into the destination's `assets/` under a new address, and the value is rewritten to it; a file named twice is copied once. A duplicate keeps an upload's address as it is, since the organization is the same, and copies only the files the original method's own runs stored, which erasing the original would sweep away. An address of another organization, a malformed one and one whose file is gone are kept unchanged. `stored_files_copied` counts the distinct files copied.

## The verdict

The answer is a `200` discriminated on `outcome`, as `publishMethod`'s is, because a bundle the destination cannot run is a verdict about the method, not a failure of the request. Branch on `outcome`, never on the status:

| `outcome` | Members | When |
|---|---|---|
| `copied` | `method`, the copy, a `MethodData` with its `copied_from`; `examples_copied`; `stored_files_copied` | The copy exists in the destination. |
| `refused` | `reason`, `bundle_names_other_storage`; `message`, a sentence for a person; `references`, every `{ path, uri }` the destination cannot read, ordered by path and then by reference | A `.mthds` file of the draft names a stored file outside the destination, which every run there would refuse. Nothing was written. |

A refused copy is fixed in the original: the person removes or replaces each reference the verdict names, then copies again. The platform does not rewrite the bundle, since that would change the author's code and the tree's digest without asking them. A duplicate is never refused this way, the original's storage being the destination's.

The client checks the member a caller branches on before it hands the answer back: an `outcome` that is neither arm's, a `copied` answer whose `method` is not an object, and a `refused` one whose `references` is not an array are each an answer the SDK cannot read, thrown as an `ApiResponseError`, `runtime` and not retryable.

## What is refused, and where

A non-2xx answer means no verdict could be produced, and none of them leaves anything a reader sees. Each is an `ApiResponseError`; branch on `code` and on the verdict, never on the status alone.

| Status | `code` | When |
|---|---|---|
| `403` | `forbidden` | The request is not from a web session. |
| `403` | `role_not_permitted` | The caller's role changes no method, `runner` or a role the platform does not know, in the method's organization or in the destination. `config`: the role must change. |
| `404` | `organization_not_found` | The destination is one the caller does not belong to, one whose invitation they have not accepted, one still being set up, or one that does not exist. The platform answers them alike, so it never says whether an organization exists. |
| `404` | `not_found` | An unknown method. The destination is judged first, so an unknown method in a destination the caller may not write to reads `organization_not_found`. |
| `409` | `method_being_deleted` | The original's erasure has started. |
| `409` | `method_update_conflict` | The draft moved since `expected_draft_updated_at`; `errors[0].field` names that member. Read the method again and copy with the fresh token. |
| `409` | `conflict` | The organization's record names a file of the draft its blob store does not hold, `runtime` and not retryable. |
| `413` | `payload_too_large` | A copied example, or the copy itself, does not fit in one stored item. |
| `422` | `validation_failed` | A body that does not validate, such as a name holding a lone surrogate. |
| `422` | `method_copy_too_large` | The copy passes one of its bounds on the stored files it copies. Its `problemDocument.limit`, typed `MethodCopyLimit`, names the bound, `max_stored_files` or `max_stored_bytes`, its `value` and what the copy `reached`. Removing examples, or the files they hold, brings it under. |
| `502` | `bad_gateway` | The platform could not read the caller's memberships. Retryable. |
| `500` | `storage_backend_failed` | Storage failed a read, a copy or a write. Retryable. |
| `503` | `service_unavailable` | The copy did not finish inside its deadline, or a stored file it copied was written over meanwhile. Retryable. |

`MethodErrorCode` names `organization_not_found` and `method_copy_too_large` beside the other method codes ([errors.md](./errors.md#the-method-codes)).

```ts
import { ApiResponseError } from "@pipelex/sdk";
import type { MethodCopyLimit } from "@pipelex/sdk";

try {
  await client.copyMethod("mt_abc123", { destination_org_id: "org_team" });
} catch (err) {
  if (err instanceof ApiResponseError && err.code === "method_copy_too_large") {
    const limit = err.problemDocument?.limit as MethodCopyLimit;
    console.error(`${limit.name}: ${limit.reached} of at most ${limit.value}`);
  } else throw err;
}
```

## Retrying a copy — `idempotencyKey`

`copyMethod`'s last argument takes an `idempotencyKey`, sent as the `Idempotency-Key` header of the copy and not sent at all when absent or `null`. Generate one key per copy the caller means to make (a `crypto.randomUUID()` is a good one), and keep it, with the arguments unchanged, across that copy's retries. A key is 1 to 255 visible ASCII characters, `!` to `~`; anything else, an empty string included, is a `RequestArgumentError` before anything is sent, as a start's is.

| The copy | The answer |
|---|---|
| The first under the key | The copy is made, or refused, and its answer is stored under the key for 24 hours, scoped to the caller and the method's organization, unless it is a `5xx` or a refusal for its timing (`408`, `425` or `429`). |
| The same arguments under the same key, once the first was answered with a verdict, or with a `4xx` refusal other than one for its timing | The stored answer, and nothing more is copied: a copy whose answer was lost, as on a client timeout, makes one copy, not two, and a copy refused for its content is refused again. |
| The same arguments under the same key, after a `5xx` or a refusal for its timing, such as a `429` | A fresh attempt: neither is stored, the key was freed, and the failed copy left nothing visible. |
| The same arguments under the same key, while the first is still being handled, or while its stored answer cannot be read | A `409` `idempotency_key_in_use`, `runtime` and retryable, answered by the key and never stored: send it again under the same key in a few seconds. |
| Other arguments under the same key | A `409` `conflict`, `input` and not retryable. A changed copy, such as one with a fresh draft token, goes under a new key. |

Without a key, a copy whose answer was lost cannot be told from one that never ran, and sending it again may make a second copy. Even with one, a platform process that dies after writing the copy and before storing its answer can make a second copy on the retry, a rare window the creation of a method shares.

## The copies of a method

The original keeps a marker of each copy made of it, and `listMethodCopies` pages them. A `MethodCopyMarker` holds `copy_method_id`, `destination_org_id`, `copied_by_user_id` and `copied_at`. The destination is named by its id alone, never by its name, so the listing tells no reader the name of an organization they do not belong to: a surface shows a destination's name from the reader's own memberships (`listMemberships`), and a copy in an organization the reader does not belong to stays an id. The rows come in the order of the copies' ids, which says nothing of when each was made; sort by `copied_at` to show them by date.

Pass the page's `nextCursor` back as `cursor` to continue; `null` is the last page. A method never copied lists an empty page, as does a copy, which names its original through `copied_from` and has no copies of its own. A marker stays when its copy is erased, and the copy then reads as not found. The marker is written once the copy exists, and a failure to write it does not fail the copy, so a copy can, rarely, be missing from the list. The original's erasure and its discard delete its markers with it.

The listing answers `404` `not_found` for an unknown method, `409` `method_being_deleted` while its erasure runs, `400` `malformed_request` for a cursor it did not issue for that method, and `422` for a `limit` outside 1 to 100. A page whose `items` is not an array or whose `next_cursor` is neither a string nor `null` is an answer the SDK cannot read.

## `copied_from` on a method

Every read of a method, `getMethod` and the `method` of every write, carries `copied_from`: `{ org_id, method_id, draft_digest }` of the original on a copy, `null` on a method created afresh, and absent from a platform that predates copies. It is written once, when the copy is made, and never rewritten, so it names the draft the copy started from even after the original has changed or been erased. It holds opaque ids only, never a name, and the original's organization may be one the reader does not belong to. The list rows (`MethodSummary`) do not carry it.
