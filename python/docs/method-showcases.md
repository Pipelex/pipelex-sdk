# A method's showcases

A **showcase** is a completed run of a method, frozen: its inputs, its main output, the forms and contracts that describe them, and a private copy of every stored file they name. It exists so that people can see what a method really produces without spending credit. It differs from what sits beside it: an **example** is the builder's private test bench, whose output is whatever its latest run left, and a **layout's written sample** is invented, while a showcase is real output that stays exactly as it was frozen.

The client reaches the hosted API's `POST` and `GET /v1/methods/{method_id}/showcases`, `GET` and `DELETE /v1/methods/{method_id}/showcases/{showcase_id}`, and `GET /v1/methods/{method_id}/versions/{version}/showcases[/{showcase_id}]`. The models are in `pipelex_sdk/method_showcase_models.py`. The platform's own account of the contract is `platform/docs/method-showcases.md` in `pipelex-server`. This page is the twin of `@pipelex/sdk`'s `docs/method-showcases.md`.

```python
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.method_showcase_models import MethodShowcaseFrozen, MethodShowcaseRefused, MethodShowcaseUnchanged

async with PipelexAPIClient() as client:
    # A builder freezes a completed run of the draft, then publishes.
    verdict = await client.freeze_method_showcase("mt_abc123", run_id="run_1", name="March receipt")
    match verdict:
        case MethodShowcaseFrozen() | MethodShowcaseUnchanged():
            print(verdict.showcase.showcase_id)
        case MethodShowcaseRefused():
            print(verdict.reason, verdict.message)

    # Any reader of a published version, another organization's on a public method included.
    summaries = await client.list_method_version_showcases("mt_abc123", 3)
    detail = await client.get_method_version_showcase("mt_abc123", 3, summaries.items[0].showcase_id)
    print(detail.document.main_stuff, [file_entry.file_name for file_entry in detail.files])
```

## Freezing a run

| Method | Route | Answer |
|---|---|---|
| `freeze_method_showcase(method_id, *, run_id, name, idempotency_key=None)` | `POST /v1/methods/{id}/showcases` | A `MethodShowcaseFreezeResult`, a `200` discriminated on `outcome` |

`run_id` is a run's `pipeline_run_id`. The body is closed, and the client sends these fields and nothing else. Freezing precedes publishing: a builder freezes a run of the draft, so a showcase can exist before the version that shows it, and another organization reads one only through a published version holding its tree.

A run that cannot be frozen is a verdict about the run, not a failure of the request, so branch on `outcome` (`match result:` over its classes), never on the status:

| Arm | `outcome` | Fields | When |
|---|---|---|---|
| `MethodShowcaseFrozen` | `frozen` | `showcase`, a new summary | The run was frozen. |
| `MethodShowcaseUnchanged` | `unchanged` | `showcase`, the one that stands | This run is already a showcase, whatever has happened to its tree since. Nothing is written, and the name in the request is ignored. |
| `MethodShowcaseRefused` | `refused` | `reason`, `message` | The run cannot be frozen, and nothing was written. |

| `reason` | When |
|---|---|
| `run_not_usable` | The run is not this method's in this organization, did not complete, kept no results (a blocking `execute` stores none), stored no output or forms, does not say which pipe it ran, or kept no record of inputs its pipe declares. |
| `tree_not_current` | The run's tree is neither the draft's nor the latest published version's, or the run records none. |
| `file_not_readable` | The document names a file that is gone or outside the organization, or holds a signed link the freeze could not rewrite. |
| `too_large` | A stored artifact of the run, the document, the number of files or their total size is past what one showcase holds. |
| `too_many` | The tree already holds as many showcases as one tree keeps. |

`reason` is read open, typed `MethodShowcaseRefusalReason | str`: a reason a later platform adds arrives as its raw string, still a verdict, so show its `message` when you do not handle it. An `outcome` that is none of these, a `showcase` that does not read as a summary, and a refusal whose `reason` or `message` is not a string are each an answer the SDK cannot read, raised as an `ApiResponseError` coded `client.response_unreadable`.

**Who may freeze.** The write changes the method, so it takes an `admin` or a `member` of the method's organization; a `runner` is refused with `403` `auth.forbidden`. Other refusals are raised as `ApiResponseError`: `404` `pipelex.catalog.not_found` for a method the organization does not hold, `409` `pipelex.catalog.being_deleted` during its erasure, `422` `request.invalid` for a body that does not validate, and `503` `runtime.unavailable`, with `retry` `yes`, past the freeze's deadline.

A `run_id` or a `name` that is not a non-empty `str` is a `RequestArgumentError` before any request. `idempotency_key` is sent as the `Idempotency-Key` header. A freeze sent again without a key is safe in itself, since freezing a run already frozen answers `unchanged`.

## Withdrawing a showcase

| Method | Route | Answer |
|---|---|---|
| `withdraw_method_showcase(method_id, showcase_id, *, idempotency_key=None)` | `DELETE /v1/methods/{id}/showcases/{showcase_id}` | Nothing, on a `204` |

The row goes first, which closes every read at once, and then its stored document and files. It runs no check, even on a public method's last showcase, because taking down something published by mistake must never be refused; the method then stays public, and its next publish needs a showcase. What another organization already copied stays theirs.

A second withdrawal is a `404` `pipelex.catalog.not_found` with `params.resource` `example`, so a withdrawal whose answer was lost reads as a failure when sent again without a key. Send it under the same `idempotency_key` and it is answered as the first was. A `runner` is refused with `403` `auth.forbidden`.

## Reading showcases

| Method | Route | Who | Answer |
|---|---|---|---|
| `list_method_version_showcases(method_id, version)` | `GET /v1/methods/{id}/versions/{n}/showcases` | Every reader of the version | The showcases of the tree it holds, oldest first |
| `get_method_version_showcase(method_id, version, showcase_id)` | `GET …/versions/{n}/showcases/{showcase_id}` | The same | One showcase in full |
| `list_method_showcases(method_id)` | `GET /v1/methods/{id}/showcases` | The holding organization's members alone | Every showcase across every tree, each naming its digest, oldest first |
| `get_method_showcase(method_id, showcase_id)` | `GET /v1/methods/{id}/showcases/{showcase_id}` | The same | One showcase in full |

**Another organization never reads a showcase of a tree no published version holds**: a version's read looks the showcase up under the digest that version names, and the holder's routes answer another organization a `404`, public method or not.

**A summary** (`MethodShowcaseSummary`) is `showcase_id`, `name`, `pipe_ref`, `tree_digest` and `frozen_at`. A list's `items` are read entry by entry, so an entry that does not read as a summary is left out, and an answer whose `items` is not a list is one the SDK cannot read.

**A detail** (`MethodShowcaseDetail`) adds `document` and `files`. `document` holds `inputs`, `main_stuff`, `input_form`, `output_form` and `pipe_io_contracts`, relayed as they were stored. `files` lists `address`, `file_name`, `media_type`, `size_bytes` and `url` for every stored file the document names. A detail is held whole, unlike a list: one that breaks its shape, a `document` member left out or a `files` entry included, is an answer the SDK cannot read, raised with its signed links redacted.

**A document never holds a signed link.** After a freeze, an image that was a stored link is an `src="pipelex-storage://…"` address, and a renderer replaces each address with the `url` of the matching entry of `files`. `url` is a short-lived presigned `GET` of the file's bytes: a bearer credential, left out of the model's `repr`, which belongs on a server and never in a browser.

The refusals are raised as `ApiResponseError`: `404` `pipelex.catalog.not_found` for an unknown method or another organization's internal one (`params.resource` `method`), a version never published (`params.resource` `version`), and a showcase the route does not hold (`params.resource` `example`, since the values of that parameter are the published registry's); `409` `pipelex.catalog.being_deleted` during the erasure of the caller's own method. A `version` that is not a positive `int` and a showcase id that is empty, `.` or `..`, holds a lone surrogate or is not a `str` are refused with `RequestArgumentError` before any request.

## Fields reserved for later

The platform answers these, and nothing fills them yet, so that the SDKs are released once:

- `showcase_id` on an example (`MethodExample.showcase_id`), `None` for now, and cleared with `latest_run_id` when the inputs change. A platform that predates it leaves it out, read as `None`.
- `SHOWCASE_MISSING` on a publish's refusal (`MethodPublishRefusalReason`), which the platform states and does not raise yet.
- `showcases_copied` and `layouts_copied` on a copy's verdict (`MethodCopied`), which stay `0`. A platform that predates them leaves them out, read as `0`.

`GET /v1/version` lists `method_showcases` in its `extensions` when the platform serves these routes. The SDK types no field for it: read it off `version()`, as the [layouts' discovery](./method-layouts.md) does.
