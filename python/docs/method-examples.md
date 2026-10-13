# A method's saved examples

An **example** is a named set of inputs saved on a stored method, so the method can be run on them again in one gesture, together with the latest run of exactly those inputs. A method has any number of them. Like the method itself, an example belongs to the organization: any member reads, edits, runs and deletes any example of any of its methods, and `created_by_user_id` only records who saved it. The client reaches them on the hosted API's `/v1/methods/{method_id}/examples` routes, and the models are in `pipelex_sdk/product_models.py`. This page is the twin of `@pipelex/sdk`'s `docs/method-examples.md`.

## The example

`MethodExample`, extension-open like every response model:

| Field | Meaning |
|---|---|
| `example_id` | `ex_…`, minted by the platform. |
| `method_id` | The bare id of the method it belongs to. |
| `name` | 1 to 200 characters, not blank. |
| `inputs` | A JSON object: the inputs as a run of the method takes them, returned exactly as they were saved, an integer as an `int` and `3.0` as a `float`. |
| `input_revision` | Starts at 1 and rises by one each time the inputs change. |
| `latest_run_id` | The latest run of the current inputs, or `None`. It may name a run deleted since, whose read then answers `404`. The platform always sends it, so an example without it is an answer the SDK cannot read, never one with no latest run, as `@pipelex/sdk` reads it. |
| `created_by_user_id`, `created_at`, `updated_at` | Who saved it, when, and when it last changed. |

An example holds no output and no baseline: its result is its latest run's, read by the run's id (`get_run_result`).

## The methods

| Method | Route | Answer |
|---|---|---|
| `create_method_example(method_id, *, name, inputs, run_id=None)` | `POST /v1/methods/{id}/examples` | The `MethodExample` as stored, at revision 1. With `run_id`, a run of this method that used exactly these inputs, that run is its latest. |
| `list_method_examples(method_id, *, limit=None, cursor=None)` | `GET /v1/methods/{id}/examples` | One `MethodExamplePage`, `items` and `next_cursor`, oldest first, inputs included. `limit` is 1 to 100, 50 by default. |
| `iterate_method_examples(method_id, *, limit=None)` | the same, page after page | Every example, oldest first, as an async iterator. |
| `get_method_example(method_id, example_id)` | `GET /v1/methods/{id}/examples/{example_id}` | The `MethodExample`. |
| `update_method_example(method_id, example_id, *, name=None, inputs=None)` | `PATCH /v1/methods/{id}/examples/{example_id}` | The `MethodExample` as it now stands. |
| `record_method_example_latest_run(method_id, example_id, *, run_id, input_revision)` | `PUT /v1/methods/{id}/examples/{example_id}/latest-run` | A `MethodExampleLatestRunResult`: `MethodExampleLatestRunRecorded` or `MethodExampleLatestRunStale`, each with the `example`. |
| `delete_method_example(method_id, example_id)` | `DELETE /v1/methods/{id}/examples/{example_id}` | `None`; the platform answers `204`. |

Every method takes a bare catalog id and refuses a suffixed one (`mt_x@3`) with `RequestArgumentError` before sending, as the other method routes do, and refuses a method id or an example id that is empty, `.` or `..`, or that holds a lone surrogate, the same way, as every route that puts an id in its path does ([What is refused](#what-is-refused-and-where)). The bodies are closed on the platform, so the client sends the fields the route takes: a keyword left at `None` is not sent.

**The list is paged by an opaque cursor.** Pass `next_cursor` back as `cursor`; `None` is the last page. The platform reads examples whole and stops a read at 1 MB, so a page may be short while `next_cursor` is set: a caller that wants every example follows the cursor, which `iterate_method_examples` does through the loop `iterate_methods` and `iterate_runs` share, stopping on a `None` cursor or one the server failed to advance and raising `PagingNotTerminatingError` past the same page ceiling.

## Revisions and the latest run

**New inputs raise the revision and clear the latest run.** An edit whose `inputs` differ from the stored ones sets `input_revision` to the next number and `latest_run_id` to `None`, since the run no longer shows what the inputs produce. The platform compares the inputs as canonical JSON with sorted keys, so the same inputs sent again, in another key order included, change nothing, while `3` becoming `3.0` is a change. Python reads and sends JSON numbers as they are spelled, an `int` as an `int` and `3.0` as a `float`, so inputs read from an example and sent back unchanged change nothing; `@pipelex/sdk` reads an integer past 2^53 as a `bigint` and sends it back exactly too, but reads `3.0` as `3`, so it cannot say the same of a float (its `docs/method-examples.md`). A rename alone keeps both. The edit takes no revision or token of its own: concurrent edits are serialized on the platform, which answers a retryable `503` with nothing written when they kept landing under one.

**A run is recorded against the revision the client names.** To run an example and keep its result, read the example, start a run with its `inputs`, and record that run with the `input_revision` you read:

```python
from pipelex_sdk.product_models import MethodExampleLatestRunStale

example = await client.get_method_example(method_id, example_id)
started = await client.start(method_id=method_id, inputs=example.inputs)
verdict = await client.record_method_example_latest_run(method_id, example_id, run_id=started.pipeline_run_id, input_revision=example.input_revision)
if isinstance(verdict, MethodExampleLatestRunStale):
    ...  # Someone edited the inputs while the run was in flight: verdict.example holds them now.
```

The write is conditioned on the example still holding that revision. **A stale run is a verdict, not an error**: a run outlasting an edit is the expected course of events whenever someone edits an example while one of its runs is in flight, so the platform answers a `200` discriminated on `outcome`, as it does for a publish, and both arms carry the example as it stands. Branch on the arm (`match verdict:` over its classes, or `verdict.outcome`, a `MethodExampleLatestRunOutcome`); an answer off the union is one the SDK cannot read, raised as an `ApiResponseError` (`runtime`, not retryable) with pydantic's refusal as its cause. The platform trusts the revision and does not compare the run's own inputs with the example's, so record a run only against the revision whose inputs it was started with. A run recorded when the example is created goes in `create_method_example`'s `run_id` instead.

## What is refused, and where

The client refuses before sending, with `RequestArgumentError` (`input`, not retryable):

- a suffixed method id, on every method;
- a method id or an example id that is empty, `.` or `..`, or that is not a `str`: httpx resolves a dot segment before the request leaves, so an example id `..` would address the method itself, and deleting it would erase the method, while an empty example id would address the examples list;
- a method id or an example id holding a lone surrogate, which has no UTF-8 spelling and so cannot enter a URL;
- a `create_method_example` whose `run_id` is given but is empty or not a `str`;
- an `update_method_example` naming neither `name` nor `inputs`;
- a `record_method_example_latest_run` whose `run_id` is not a non-empty `str` or whose `input_revision` is not a positive integer (a `bool`, a `float` and a numeric string included), the example id checked first, then the run id, then the revision.

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
