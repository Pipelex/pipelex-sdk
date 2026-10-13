# A method's saved examples

An **example** is a named set of inputs saved on a stored method, so the method can be run on them again in one gesture, together with the latest run of exactly those inputs. A method has any number of them. Like the method itself, an example belongs to the organization: any member reads, edits, runs and deletes any example of any of its methods, and `created_by_user_id` only records who saved it. The client reaches them on the hosted API's `/v1/methods/{method_id}/examples` routes, and the types are in `src/product-models.ts`.

## The example

| Field | Meaning |
|---|---|
| `example_id` | `ex_…`, minted by the platform. |
| `method_id` | The bare id of the method it belongs to. |
| `name` | 1 to 200 characters, not blank. |
| `inputs` | A JSON object: the inputs as a run of the method takes them. The platform answers them exactly as they were saved; the client reads an integer past `Number.MAX_SAFE_INTEGER` as a `bigint` holding its exact digits and every other number as a double, so `3.0` reads as `3` ([below](#numbers-in-an-examples-inputs)). |
| `input_revision` | Starts at 1 and rises by one each time the inputs change. |
| `latest_run_id` | The latest run of the current inputs, or `null`. It may name a run deleted since, whose read then answers `404`. |
| `created_by_user_id`, `created_at`, `updated_at` | Who saved it, when, and when it last changed. |

An example holds no output and no baseline: its result is its latest run's, read by the run's id (`getRunResult`).

## The methods

| Method | Route | Answer |
|---|---|---|
| `createMethodExample(methodId, { name, inputs, run_id? })` | `POST /v1/methods/{id}/examples` | The `MethodExample` as stored, at revision 1. With `run_id`, a run of this method that used exactly these inputs, that run is its latest. |
| `listMethodExamples(methodId, { limit?, cursor? })` | `GET /v1/methods/{id}/examples` | One `MethodExamplePage`, `{ items, nextCursor }`, oldest first, inputs included. `limit` is 1 to 100, 50 by default. |
| `iterateMethodExamples(methodId, { limit? })` | the same, page after page | Every example, oldest first, as an async iterator. A method id it cannot take is refused at the call, before the iterator is pulled. |
| `getMethodExample(methodId, exampleId)` | `GET /v1/methods/{id}/examples/{example_id}` | The `MethodExample`. |
| `updateMethodExample(methodId, exampleId, { name?, inputs? })` | `PATCH /v1/methods/{id}/examples/{example_id}` | The `MethodExample` as it now stands. |
| `recordMethodExampleLatestRun(methodId, exampleId, { run_id, input_revision })` | `PUT /v1/methods/{id}/examples/{example_id}/latest-run` | A `MethodExampleLatestRunResult`: `{ outcome: "recorded" \| "stale", example }`. |
| `deleteMethodExample(methodId, exampleId)` | `DELETE /v1/methods/{id}/examples/{example_id}` | Nothing; the platform answers `204`. |

Every method takes a bare catalog id and refuses a suffixed one (`mt_x@3`) with `RequestArgumentError` before sending, as the other method routes do, and refuses a method id or an example id that is empty, `.` or `..`, or that holds a lone surrogate, the same way, as every route that puts an id in its path does ([What is refused](#what-is-refused-and-where)). The bodies are closed on the platform, so the client sends the fields the route takes and nothing else an untyped caller adds.

**Every example the client hands back has been checked.** Each route answering one, the page rows and the latest-run verdict's `example` included, checks it once, against every field the Python SDK's model requires, with the strict type that model holds it to: string `example_id`, `method_id`, `name`, `created_by_user_id`, `created_at` and `updated_at`, object `inputs`, `input_revision` an integer within `Number.MAX_SAFE_INTEGER` either way, and `latest_run_id` present as a string or `null`. An example breaking one is an answer the SDK cannot read, thrown as an `ApiResponseError` (`runtime`, not retryable) whose message names the field, so a missing `latest_run_id` never reads as an example with no latest run, and a revision of `"2"` or `true` is never read as one. Both SDKs refuse the same answers but one: a revision spelled `2.0`, which JavaScript reads as the number `2` and cannot tell from it, while the Python SDK refuses the float.

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

A run started this way sends the inputs the example holds, digit for digit, an integer past `Number.MAX_SAFE_INTEGER` included ([below](#numbers-in-an-examples-inputs)). The write is conditioned on the example still holding that revision. **A stale run is a verdict, not an error**: a run outlasting an edit is the expected course of events whenever someone edits an example while one of its runs is in flight, so the platform answers a `200` discriminated on `outcome`, as it does for a publish, and both arms carry the example as it stands. Branch on `outcome`; an answer whose `outcome` is neither, or whose `example` is not an example the client can read, is an answer the SDK cannot read, thrown as an `ApiResponseError` (`runtime`, not retryable). The platform trusts the revision and does not compare the run's own inputs with the example's, so record a run only against the revision whose inputs it was started with. A run recorded when the example is created goes in `createMethodExample`'s `run_id` instead.

## Numbers in an example's inputs

The platform stores an example's inputs as JSON text and answers them exactly as they were saved, but JavaScript reads every JSON number as a double, which holds an integer exactly only up to `Number.MAX_SAFE_INTEGER` (2^53 - 1). Inputs saved by another client, the Python SDK or a raw request, can hold a larger one, such as `12345678901234567891`, which a double reads as `12345678901234567000`. Sent back, to `updateMethodExample` or as a run's inputs, the rounded number would overwrite the saved inputs, clearing the latest run, or run the method on inputs nobody saved and record that run under the revision that holds the real ones, since the platform trusts the revision it is given.

**So the client keeps such an integer exact.** Every answer carrying an example, the page of `listMethodExamples` and the verdict of `recordMethodExampleLatestRun` included, is read with `parseExactJson`, which reads an integer past `Number.MAX_SAFE_INTEGER` in either direction, at any depth of the inputs, as a `bigint` holding its exact digits, and every other value as `JSON.parse` reads it. Every request body is written with `stringifyExactJson`, which writes a `bigint` as those digits where `JSON.stringify` throws, so inputs read from an example go back unchanged, whichever route they are sent to. One such example never makes a page unreadable: the page reads whole, that integer as a `bigint`. A run's inputs and outputs are read the same way, so an example saved from a run's inputs keeps every digit too; [exact-integers.md](./exact-integers.md) lists every exact read, says what a `bigint` asks of code showing the inputs as JSON text (`stringifyExactJson(example.inputs, 2)`, and `parseExactJson` to read edited text back), and what a runtime without the JSON source-text proposal refuses rather than rounds.

**A float keeps its value, not its spelling.** A float with no fractional part, `3.0`, reads as `3` and goes back as `3`, as it does everywhere in JavaScript; the value is the same, so a run started with it runs as saved. The platform compares inputs as canonical JSON, though, where `3` and `3.0` differ, so `updateMethodExample` given inputs read from an example that held one raises `input_revision` and clears `latest_run_id`, though the caller changed nothing. Send `inputs` only when the person changed them; a rename sent alone keeps the revision and the latest run. Inputs saved from JavaScript never hold a `3.0`, since JavaScript cannot write one.

## What is refused, and where

The client refuses before sending, with `RequestArgumentError` (`input`, not retryable):

- a suffixed method id, on every method;
- a method id or an example id that is empty, `.` or `..`, or that is not a string: the URL resolves a dot segment before the request leaves, so an example id `..` would address the method itself, and deleting it would erase the method, while an empty example id would address the examples list;
- a method id or an example id holding a lone surrogate, which has no UTF-8 spelling and so cannot enter a URL;
- a `createMethodExample` without its `name` or its `inputs` (a `null` one counting as not given), or whose `run_id` is given but is not a non-empty string, a `null` reading as not given;
- an `updateMethodExample` naming neither `name` nor `inputs` (a `null` field counts as not given, as the platform reads it);
- a `recordMethodExampleLatestRun` whose `run_id` is not a non-empty string or whose `input_revision` is not a positive integer, the example id checked first, then the run id, then the revision;
- an `iterateMethodExamples` whose method id any method above refuses, at the call itself rather than when the iterator is first pulled;
- a body JSON cannot carry, such as inputs holding a cycle, or a `bigint` on a runtime without `JSON.rawJSON` ([exact-integers.md](./exact-integers.md)).

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
