# A method's saved examples

An **example** is a named set of inputs saved on a stored method, so the method can be run on them again in one gesture, together with the latest run of exactly those inputs. A method has any number of them. Like the method itself, an example belongs to the organization: every role of it reads and runs any example of any of its methods, every role that may change its methods (`admin` and `member`) saves, edits and deletes any of them and records their latest runs, and `created_by_user_id` only records who saved it. A runner is refused every example write with a `403` `role_not_permitted`. The client reaches them on the hosted API's `/v1/methods/{method_id}/examples` routes, and the models are in `pipelex_sdk/product_models.py`. This page is the twin of `@pipelex/sdk`'s `docs/method-examples.md`.

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
| `kept_by_assistant` | Whether the build assistant keeps this example's inputs current with its test inputs: `True` on an example the assistant's save created, `False` on every other, and `False` from the first inputs change a person makes. A rename leaves it as it is ([below](#the-build-assistants-example)). |
| `created_by_user_id`, `created_at`, `updated_at` | Who saved it, when, and when it last changed. |

**The fields are read strictly, as `@pipelex/sdk` reads them**, so both SDKs refuse the same answers: a field of another type is never coerced, so an `input_revision` of `"2"`, `True` or `2.0` is no revision, and neither is one past 2^53 - 1 in either direction, the largest integer a JavaScript number holds exactly, and a `kept_by_assistant` that is not a JSON boolean, or that is missing, is no flag. An example breaking a field is an answer the SDK cannot read, raised as an `ApiResponseError` (`client.response_unreadable`) with pydantic's refusal as its cause. The one answer the two SDKs read apart is a revision spelled `2.0`, which JavaScript reads as the number `2` and cannot tell from it.

An example holds no output and no baseline: its result is its latest run's, read by the run's id (`get_run_result`).

## The methods

| Method | Route | Answer |
|---|---|---|
| `create_method_example(method_id, *, name, inputs, run_id=None)` | `POST /v1/methods/{id}/examples` | The `MethodExample` as stored, at revision 1. With `run_id`, a run of this method that used exactly these inputs, that run is its latest. |
| `list_method_examples(method_id, *, limit=None, cursor=None)` | `GET /v1/methods/{id}/examples` | One `MethodExamplePage`, `items` and `next_cursor`, oldest first, inputs included. `limit` is 1 to 100, 50 by default. |
| `iterate_method_examples(method_id, *, limit=None)` | the same, page after page | Every example, oldest first, as an async iterator. A method id it cannot take is refused at the call, before the iterator is iterated. |
| `get_method_example(method_id, example_id)` | `GET /v1/methods/{id}/examples/{example_id}` | The `MethodExample`. |
| `update_method_example(method_id, example_id, *, name=None, inputs=None)` | `PATCH /v1/methods/{id}/examples/{example_id}` | The `MethodExample` as it now stands. |
| `record_method_example_latest_run(method_id, example_id, *, run_id, input_revision)` | `PUT /v1/methods/{id}/examples/{example_id}/latest-run` | A `MethodExampleLatestRunResult`: `MethodExampleLatestRunRecorded` or `MethodExampleLatestRunStale`, each with the `example`. |
| `delete_method_example(method_id, example_id)` | `DELETE /v1/methods/{id}/examples/{example_id}` | `None`; the platform answers `204`. |
| `save_assistant_method_example(method_id, *, name, inputs, example_id=None, input_revision=None)` | `POST /v1/methods/{id}/examples/assistant-save` | A `MethodExampleAssistantSaveResult`: `MethodExampleAssistantKept` or `MethodExampleAssistantCreated`, each with the `example`. |

Every method takes a bare catalog id and refuses a suffixed one (`mt_x@3`) with `RequestArgumentError` before sending, as the other method routes do, and refuses a method id or an example id that is empty, `.` or `..`, or that holds a lone surrogate, the same way, as every route that puts an id in its path does ([What is refused](#what-is-refused-and-where)). The bodies are closed on the platform, so the client sends the fields the route takes: a keyword left at `None` is not sent.

**The list is paged by an opaque cursor.** Pass `next_cursor` back as `cursor`; `None` is the last page. The platform reads examples whole and stops a read at 1 MB, so a page may be short while `next_cursor` is set: a caller that wants every example follows the cursor, which `iterate_method_examples` does through the loop `iterate_methods` and `iterate_runs` share, stopping on a `None` cursor or one the server failed to advance and raising `PagingNotTerminatingError` past the same page ceiling.

## Revisions and the latest run

**New inputs raise the revision and clear the latest run.** An edit whose `inputs` differ from the stored ones sets `input_revision` to the next number and `latest_run_id` to `None`, since the run no longer shows what the inputs produce, and `kept_by_assistant` to `False`, since those inputs are a person's. The platform compares the inputs as canonical JSON with sorted keys, so the same inputs sent again, in another key order included, change nothing, while `3` becoming `3.0` is a change. Python reads and sends JSON numbers as they are spelled, an `int` as an `int` and `3.0` as a `float`, so inputs read from an example and sent back unchanged change nothing; `@pipelex/sdk` reads an integer past 2^53 as a `bigint` and sends it back exactly too, but reads `3.0` as `3`, so it cannot say the same of a float (its `docs/method-examples.md`). A rename alone keeps both. The edit takes no revision or token of its own: concurrent edits are serialized on the platform, which answers a `503` `runtime.unavailable`, `retry` `yes`, with nothing written when they kept landing under one.

**A run is recorded against the revision the client names.** To run an example and keep its result, read the example, start a run with its `inputs`, and record that run with the `input_revision` you read:

```python
from pipelex_sdk.product_models import MethodExampleLatestRunStale

example = await client.get_method_example(method_id, example_id)
started = await client.start(method_id=method_id, inputs=example.inputs)
verdict = await client.record_method_example_latest_run(method_id, example_id, run_id=started.pipeline_run_id, input_revision=example.input_revision)
if isinstance(verdict, MethodExampleLatestRunStale):
    ...  # Someone edited the inputs while the run was in flight: verdict.example holds them now.
```

The write is conditioned on the example still holding that revision. **A stale run is a verdict, not an error**: a run outlasting an edit is the expected course of events whenever someone edits an example while one of its runs is in flight, so the platform answers a `200` discriminated on `outcome`, as it does for a publish, and both arms carry the example as it stands. Branch on the arm (`match verdict:` over its classes, or `verdict.outcome`, a `MethodExampleLatestRunOutcome`); an answer off the union is one the SDK cannot read, raised as an `ApiResponseError` (`client.response_unreadable`) with pydantic's refusal as its cause. The platform trusts the revision and does not compare the run's own inputs with the example's, so record a run only against the revision whose inputs it was started with. A run recorded when the example is created goes in `create_method_example`'s `run_id` instead.

## The build assistant's example

The build assistant writes test inputs for the method it is building and keeps one example of the method current with them, so that a person finds its latest inputs saved and can run them again. **A person's edit is never written over.** `save_assistant_method_example` is that save, and `kept_by_assistant` says whose an example is: `True` on an example the assistant's save created, `False` from the first inputs change made through `update_method_example`, after which the example is the person's. A rename leaves the flag as it is, and a create through `create_method_example` is a person's and never flagged.

The assistant names the example it read and the revision it read it at. Find its example as the method's newest with `kept_by_assistant` true, the last such in `list_method_examples`' oldest-first order, and send its `example_id` with its `input_revision`:

```python
from pipelex_sdk.product_models import MethodExample, MethodExampleAssistantCreated

assistants: MethodExample | None = None
async for example in client.iterate_method_examples(method_id):
    if example.kept_by_assistant:
        assistants = example
saved = await client.save_assistant_method_example(
    method_id,
    name="Assistant test inputs",
    inputs=test_inputs,
    example_id=assistants.example_id if assistants else None,
    input_revision=assistants.input_revision if assistants else None,
)
if isinstance(saved, MethodExampleAssistantCreated):
    ...  # A person took the previous example, or there was none: saved.example is the assistant's now.
```

The platform writes the inputs into the named example only while it still exists, still carries the flag and still holds that revision, in one conditional write it never retries, and answers `kept` with the example, its revision raised and its latest run cleared as any inputs change does, its name untouched since a person may have chosen it. Otherwise, when a person's edit, another save or a deletion landed first, and when no example is named, which is how the first save on a method creates the assistant's example, it saves the inputs as a new example flagged as the assistant's under `name`, at revision 1, and answers `created`. **Both are a `200` verdict**, since a person taking the example while the assistant works is the expected course of events; branch on the arm (`match saved:` over its classes, or `saved.outcome`, a `MethodExampleAssistantSaveOutcome`). An answer off the union is one the SDK cannot read, raised as an `ApiResponseError` (`client.response_unreadable`). A retry of a save that landed answers `kept` and writes nothing again. The SDK has no helper finding the assistant's example, since the caller already lists the examples it shows.

The client sends `name`, `inputs` and, when given, `example_id` with `input_revision`, and nothing else, a keyword left at `None` reading as not given. `name` is the name a new example takes, so it is required even when the save names an example, whose own name a `kept` save leaves alone.

## What is refused, and where

The client refuses before sending, with `RequestArgumentError` (`client.argument_invalid`):

- a suffixed method id, on every method;
- a method id or an example id that is empty, `.` or `..`, or that is not a `str`: httpx resolves a dot segment before the request leaves, so an example id `..` would address the method itself, and deleting it would erase the method, while an empty example id would address the examples list;
- a method id or an example id holding a lone surrogate, which has no UTF-8 spelling and so cannot enter a URL;
- a `create_method_example` whose `name` or `inputs` is `None`, which would be sent as `null`, or whose `run_id` is given but is empty or not a `str`;
- an `iterate_method_examples` whose method id any method above refuses, at the call itself rather than when the iterator is first iterated;
- an `update_method_example` naming neither `name` nor `inputs`;
- a `save_assistant_method_example` whose `name` or `inputs` is `None`, whose `example_id` is given but is not a non-empty `str`, whose `input_revision` is given but is not a positive integer (a `bool` and a `float` included), or that gives only one of the two;
- a `record_method_example_latest_run` whose `run_id` is not a non-empty `str` or whose `input_revision` is not a positive integer (a `bool`, a `float` and a numeric string included), the example id checked first, then the run id, then the revision.

The platform refuses the rest, each as an `ApiResponseError` whose problem's `code` names it (see [errors.md](./errors.md)):

| `code` | Status | When |
|---|---|---|
| `pipelex.catalog.not_found` | `404` | An unknown method or example, an example already deleted included. |
| `run.not_found` | `404` | A `run_id`, on the create or the latest-run write, that is not one of this method's runs in the caller's organization; nothing is written. |
| `auth.forbidden` | `403` | Any example write by a role that may not change methods, such as a runner, which an admin of the organization must change. |
| `pipelex.catalog.being_deleted` | `409` | The method's erasure has started. Its examples are erased with it. |
| `request.too_large` | `413` | An example larger than one stored item holds. |
| `input.reference_not_found` | `422` | A save, the create, an inputs edit or the assistant's, whose inputs hold a file a run made whose object is no longer stored, since that run was deleted; its `missing_files` member names every such address, and nothing is saved. The platform copies a run's file an example takes into the organization's store, so the example outlives the run that made it. |
| `request.invalid` | `422` | A name empty, blank or over 200 characters, inputs that are not a JSON object, a `limit` outside 1 to 100, an example id longer than one can be (64 characters), or a cursor the listing did not issue for this method. |

Every write is `403` to a read-only (`purpose=sandbox`) key, which may still read the examples.
