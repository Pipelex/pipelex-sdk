# A method's saved examples

An **example** is a named set of inputs saved on a stored method, so the method can be run on them again in one gesture, together with the latest run of exactly those inputs. A method has any number of them. Like the method itself, an example belongs to the organization: any member reads, edits, runs and deletes any example of any of its methods, and `created_by_user_id` only records who saved it. The client reaches them on the hosted API's `/v1/methods/{method_id}/examples` routes, and the types are in `src/product-models.ts`.

## The example

| Field | Meaning |
|---|---|
| `example_id` | `ex_…`, minted by the platform. |
| `method_id` | The bare id of the method it belongs to. |
| `name` | 1 to 200 characters, not blank. |
| `inputs` | A JSON object: the inputs as a run of the method takes them, returned exactly as they were saved, an integer as an integer and `3.0` as a float. |
| `input_revision` | Starts at 1 and rises by one each time the inputs change. |
| `latest_run_id` | The latest run of the current inputs, or `null`. It may name a run deleted since, whose read then answers `404`. |
| `created_by_user_id`, `created_at`, `updated_at` | Who saved it, when, and when it last changed. |

An example holds no output and no baseline: its result is its latest run's, read by the run's id (`getRunResult`).

## The methods

| Method | Route | Answer |
|---|---|---|
| `createMethodExample(methodId, { name, inputs, run_id? })` | `POST /v1/methods/{id}/examples` | The `MethodExample` as stored, at revision 1. With `run_id`, a run of this method that used exactly these inputs, that run is its latest. |
| `listMethodExamples(methodId, { limit?, cursor? })` | `GET /v1/methods/{id}/examples` | One `MethodExamplePage`, `{ items, nextCursor }`, oldest first, inputs included. `limit` is 1 to 100, 50 by default. |
| `iterateMethodExamples(methodId, { limit? })` | the same, page after page | Every example, oldest first, as an async iterator. |
| `getMethodExample(methodId, exampleId)` | `GET /v1/methods/{id}/examples/{example_id}` | The `MethodExample`. |
| `updateMethodExample(methodId, exampleId, { name?, inputs? })` | `PATCH /v1/methods/{id}/examples/{example_id}` | The `MethodExample` as it now stands. |
| `recordMethodExampleLatestRun(methodId, exampleId, { run_id, input_revision })` | `PUT /v1/methods/{id}/examples/{example_id}/latest-run` | A `MethodExampleLatestRunResult`: `{ outcome: "recorded" \| "stale", example }`. |
| `deleteMethodExample(methodId, exampleId)` | `DELETE /v1/methods/{id}/examples/{example_id}` | Nothing; the platform answers `204`. |

Every method takes a bare catalog id and refuses a suffixed one (`mt_x@3`) with `RequestArgumentError` before sending, as the other method routes do. The bodies are closed on the platform, so the client sends the fields the route takes and nothing else an untyped caller adds.

**The list is paged by an opaque cursor.** Pass `nextCursor` back as `cursor`; `null` is the last page. The platform reads examples whole and stops a read at 1 MB, so a page may be short while `nextCursor` is set: a caller that wants every example follows the cursor, which `iterateMethodExamples` does through the loop `iterateMethods` and `iterateRuns` share, stopping on a `null` cursor or one the server failed to advance and throwing `PagingNotTerminatingError` past the same page ceiling.

## Revisions and the latest run

**New inputs raise the revision and clear the latest run.** An edit whose `inputs` differ from the stored ones sets `input_revision` to the next number and `latest_run_id` to `null`, since the run no longer shows what the inputs produce. The platform compares the inputs as canonical JSON with sorted keys, so the same inputs sent again, in another key order included, change nothing, while `3` becoming `3.0` is a change. A rename alone keeps both. The edit takes no revision or token of its own: concurrent edits are serialized on the platform, which answers a retryable `503` with nothing written when they kept landing under one.

**A run is recorded against the revision the client names.** To run an example and keep its result, read the example, start a run with its `inputs`, and record that run with the `input_revision` you read:

```ts
const example = await client.getMethodExample(methodId, exampleId);
const started = await client.start({ method_id: methodId, inputs: example.inputs });
const verdict = await client.recordMethodExampleLatestRun(methodId, exampleId, {
  run_id: started.pipeline_run_id,
  input_revision: example.input_revision,
});
if (verdict.outcome === "stale") {
  // Someone edited the inputs while the run was in flight: verdict.example holds them now.
}
```

The write is conditioned on the example still holding that revision. **A stale run is a verdict, not an error**: a run outlasting an edit is the expected course of events whenever someone edits an example while one of its runs is in flight, so the platform answers a `200` discriminated on `outcome`, as it does for a publish, and both arms carry the example as it stands. Branch on `outcome`; an answer whose `outcome` is neither, or that carries no `example` object, is an answer the SDK cannot read, thrown as an `ApiResponseError` (`runtime`, not retryable). The platform trusts the revision and does not compare the run's own inputs with the example's, so record a run only against the revision whose inputs it was started with. A run recorded when the example is created goes in `createMethodExample`'s `run_id` instead.

## What is refused, and where

The client refuses before sending, with `RequestArgumentError` (`input`, not retryable):

- a suffixed method id, on every method;
- an empty example id, which would address the examples list rather than an example, or one that is not a string;
- an `updateMethodExample` naming neither `name` nor `inputs` (a `null` field counts as not given, as the platform reads it);
- a `recordMethodExampleLatestRun` whose `run_id` is not a non-empty string or whose `input_revision` is not a positive integer.

The platform refuses the rest, each as an `ApiResponseError` whose `code` names it (see [errors.md](./errors.md)):

| `code` | Status | When |
|---|---|---|
| `not_found` | `404` | An unknown method or example, an example already deleted included. |
| `run_not_found` | `404` | A `run_id`, on the create or the latest-run write, that is not one of this method's runs in the caller's organization; nothing is written. |
| `method_being_deleted` | `409` | The method's erasure has started. Its examples are erased with it. |
| `payload_too_large` | `413` | An example larger than one stored item holds. |
| `validation_failed` | `422` | A name empty, blank or over 200 characters, inputs that are not a JSON object, a `limit` outside 1 to 100, or an example id longer than one can be (64 characters). |
| `malformed_request` | `400` | A cursor the listing did not issue for this method. |

Every write is `403` to a read-only (`purpose=sandbox`) key, which may still read the examples.
