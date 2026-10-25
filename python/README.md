# pipelex-sdk

The Python client for the [Pipelex](https://www.pipelex.com) hosted API.

`pipelex-sdk` is the Python counterpart of [`@pipelex/sdk`](https://www.npmjs.com/package/@pipelex/sdk), exactly as [`mthds`](https://pypi.org/project/mthds/) (the `mthds-python` package) is the Python counterpart of the `mthds` npm package. It is the **hosted superset**: the five normative MTHDS Protocol routes (inherited from `mthds`) **plus** the durable run lifecycle **plus** the Pipelex product surface (methods, organizations, billing, API keys, onboarding, storage, an organization's files, run records).

One-way dependency: `pipelex-sdk → mthds`.

## Install

```bash
pip install pipelex-sdk
```

Installing `pipelex` 0.79 or later installs `pipelex-sdk` with it, pinned to one exact version, since it is the client behind `pipelex run --hosted`. In an environment that has `pipelex`, do not install or upgrade `pipelex-sdk` separately: that would move it off the version that `pipelex` release was built with.

## Run a method from the command line

The package publishes the `pipelex-sdk` command, so a method runs on the hosted API with nothing to install but [uv](https://docs.astral.sh/uv/):

```bash
export PIPELEX_API_KEY=<your key>
uvx pipelex-sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs-template > inputs.json
uvx pipelex-sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs inputs.json
```

`--method` takes a published address, a catalog id (`mt_…`, which runs the method's latest published version, `mt_…@<n>` for a fixed version or `mt_…@draft` for its draft) or a local `.mthds` file or bundle directory. The run's main output is printed as JSON on stdout, and the run id, each uploaded file and every error go to stderr; Ctrl-C leaves the run going on the server and names it. `uvx pipelex-sdk script --method <address | mt_id>` checks the method and writes a short shell script that runs it with this SDK's version pinned. The key comes from `PIPELEX_API_KEY` only, and no `.env` file is read, not even the one where `pipelex login` saves the key, `~/.pipelex/.env` or the `.env` under `PIPELEX_HOME` when that is set: to use that key, load the file into the shell first with `set -a; . "${PIPELEX_HOME:-$HOME/.pipelex}/.env"; set +a`. The command is the twin of `npx @pipelex/sdk`, held to the same recorded cases; [`docs/cli.md`](docs/cli.md) describes it.

## Configuration

The **API key** resolves, in order: explicit `api_key` argument → `PIPELEX_API_KEY` → anonymous. The token is **optional** — anonymous access works against the protocol routes (e.g. a local bare runner); the product routes return `401`.

**A key saved by `pipelex login` is not read.** `pipelex login`, and `pipelex init` when it signs you in, save the key as `PIPELEX_API_KEY` in `~/.pipelex/.env` (or in the `.env` of the directory `PIPELEX_HOME` names), but the client reads only its argument and the process environment, so a client constructed with no `api_key` sends no key and the hosted API refuses its runs. To use the saved key, either load the file into the shell before starting your program, `set -a; . "${PIPELEX_HOME:-$HOME/.pipelex}/.env"; set +a`, which finds it in either place and exports every variable it holds, or, when `pipelex` is installed, import `pipelex.system.environment` before constructing the client: importing it loads that file, then the working directory's `.env`, which wins, into the process environment.

The **base URL** resolves, in order: explicit `base_url` argument → `PIPELEX_BASE_URL` → the hosted default `https://api.pipelex.com`. The base URL is host-only (no path/query/fragment); every endpoint composes as `{base}/v1/{endpoint}`.

The SDK never reads the `mthds` resolver (`MTHDS_API_KEY` / `MTHDS_BASE_URL` / `~/.mthds/config`) — those settings configure the vendor-neutral `mthds` tooling and whichever runner it targets, not this Pipelex client.

`request_timeout_seconds` (constructor argument, default 20 min) is the time limit of the routes that can take long: the blocking `execute`, `validate`, `models`, and a `start` carrying the method's tree, a bundle riding `extra` (`mthds_contents` or `bundle_b64`) or a `method_ref`, which the server resolves before it answers. `version` and any other `start` answer fast, so they take `request_timeout_seconds` capped at the 30-second poll budget, the hosted gateway's own cut-off. The SDK's own polls and product requests keep budgets of their own.

`app_info` (constructor argument, an `AppInfo` from `pipelex_sdk.user_agent`) puts your application's name in front of the SDK's own tokens in the `User-Agent` that every request carries — `acme-invoicer/1.4.0 pipelex-sdk-python/0.11.0 mthds-python/0.15.0 python/3.12.4 (linux; x86_64)` — which the platform uses to attribute traffic in its analytics. The header follows the spec `conformance/specs/client-identification.md`, in the `conformance` repository, where the cross-repo specs sit beside the tests that verify them; see [`docs/client-identification.md`](docs/client-identification.md).

The client is **async-only** (httpx `AsyncClient`) and is an async context manager.

## Quickstart

```python
from pathlib import Path

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.validation_models import VALIDATION_VIEW_INPUT_FORM


async def main() -> None:
    # The method is the directory holding its tree. The client lists it with the standard's
    # lister, so a run's `inputs.json` never travels, and sends it inline when it is small and
    # by hash otherwise, uploading only the files the API does not hold yet.
    method_dir = Path("my_method")
    async with PipelexAPIClient() as client:
        # 1. Validate the method. The verdict is always returned (never raised):
        #    a 200 discriminated on `is_valid`, carrying `rendered_markdown`.
        #    Structured views are opt-in: asking for `input_form` here is what populates
        #    `report.input_form` (the per-pipe input-form descriptors); omit `views` and the
        #    request body carries no `views` key at all.
        report = await client.validate(tree=method_dir, views=[VALIDATION_VIEW_INPUT_FORM])
        print(report.rendered_markdown)
        if not report.is_valid:
            return

        # 2. Run it end-to-end. `start_and_wait` self-heals across runner kinds:
        #    durable start+poll on the hosted API, blocking execute on a bare runner.
        result = await client.start_and_wait(
            pipe_code="my_pipe",
            tree=method_dir,
            inputs={"topic": "quantum computing"},
        )

        # 3. Read the output. Every completed run delivers a resolved `main_stuff`
        #    (the full working memory also rides `pipe_output` on the blocking path).
        print(result.main_stuff)
```

### Run a published method by address

A method reaches every method-taking call in exactly one of three forms: its tree (`files`, `tree` or `contents`, as above and as a save takes it, see [`docs/method-trees.md`](docs/method-trees.md)), a `method_ref` address (`github.com/<owner>/<repo>[/<selector>][@<tag>]`, resolved by the server — pipelex-api >= 0.21.0; on `api.pipelex.com` availability follows the platform deploy that forwards it), or a hosted `method_id` (`mt_…`, resolved by the platform). A `method_ref` pairs with nothing — it is a complete run source — and its runs carry typed provenance:

```python
ack = await client.start(method_ref="github.com/Pipelex/methods/documents@v0.1.0", inputs={...})
print(ack.method_provenance.commit_sha)  # the SHA actually fetched — stable even if the tag moves
result = await client.wait_for_result(ack.pipeline_run_id)

# The tooling routes take the same selectors under a strict XOR (exactly one, no pairing):
report = await client.validate(method_ref="github.com/Pipelex/methods/documents@v0.1.0")
report = await client.validate(method_id="mt_123")

# A saved method's bare id runs its latest published version, `mt_…@3` version 3 and
# `mt_…@draft` its draft; the ack says which version runs.
ack = await client.start(method_id="mt_123@3", inputs={...})
print(ack.method_version)  # 3
```

### Draft, publish and pin a saved method

A saved method has a draft, written freely and never validated, and immutable published versions numbered from 1. Each is a method tree, the same files a run takes. `updated_at` is the draft's token: echo it so no write or publish takes a draft you have not seen. The method routes take a bare id, and `parse_method_selector` strips a suffix:

```python
from pathlib import Path

from pipelex_sdk.method_selector import parse_method_selector
from pipelex_sdk.product_models import MethodDraftInput, MethodPublishRefused

method = await client.get_method("mt_123")
tree = await client.list_method_tree(Path("methods/demo"))
draft = await client.write_draft("mt_123", MethodDraftInput(tree=tree, expected_updated_at=method.updated_at))
result = await client.publish_method("mt_123", expected_draft_updated_at=draft.updated_at)
if isinstance(result, MethodPublishRefused):
    print(result.message, result.validation)
else:
    print(f"version {result.version.version}")  # published, or unchanged
versions = await client.list_method_versions("mt_123")  # newest first
parsed = parse_method_selector("mt_123@3")  # ParsedMethodSelector(method_id="mt_123", version=3)
```

A save sends a small tree inline and a large one by hash, uploading first the files the organization does not hold yet, so a file is uploaded once. A read lists the files with a short-lived link to each one's bytes, and `write_method_tree` writes them to disk, each checked against its SHA-256 ([`docs/method-trees.md`](docs/method-trees.md)):

```python
detail = await client.get_method("mt_123")
await client.write_method_tree(detail.files, destination=Path("demo-copy"))
```

### Save examples and rerun them

An example is a named set of inputs saved on a method, with the latest run of exactly those inputs. A run is recorded against the revision whose inputs it used, so an edit of the inputs while it ran answers `stale`, a verdict rather than an error ([`docs/method-examples.md`](docs/method-examples.md)):

```python
from pipelex_sdk.product_models import MethodExampleLatestRunStale

example = await client.create_method_example("mt_123", name="March receipt", inputs={"total": 3})
started = await client.start(method_id="mt_123", inputs=example.inputs)
verdict = await client.record_method_example_latest_run(
    "mt_123", example.example_id, run_id=started.pipeline_run_id, input_revision=example.input_revision
)
if isinstance(verdict, MethodExampleLatestRunStale):
    print("edited since", verdict.example.input_revision)
async for saved in client.iterate_method_examples("mt_123"):  # every example, oldest first
    print(saved.name, saved.latest_run_id)
```

### Copy a method into a team

A copy is a new, unpublished method in an organization you may change methods in, holding the original's draft, its form inputs and its examples, the stored files they name copied with it, and `copied_from` naming the original. Only a web session may copy. A bundle naming storage the destination cannot read, or, in a duplicate, a file under the original's run files, which erasing the original would remove, answers `refused`, a verdict rather than an error, and the idempotency key makes a retry copy once ([`docs/method-copy.md`](docs/method-copy.md)):

```python
import uuid

from pipelex_sdk.product_models import MethodCopied

method = await client.get_method("mt_123")
result = await client.copy_method(
    "mt_123", destination_org_id="org_team", expected_draft_updated_at=method.updated_at, idempotency_key=str(uuid.uuid4())
)
if isinstance(result, MethodCopied):
    print(result.method.method_id, result.method.copied_from)
else:
    print(result.message, [reference.uri for reference in result.references])
copies = await client.list_method_copies("mt_123")  # where the copies went
```

### Find, link and zip the organization's files

The organization's files are its uploads, its test files and the files its runs made, newest first, and each row's `uri` goes into a run's inputs as any address does. A filtered page can be empty and still carry a `next_cursor`, which `iterate_files` follows. A link downloads a file under the name a person sees, a zip is queued, then read until it is ready, and an upload names the method it was made to try to be recorded as that method's test file ([`docs/files.md`](docs/files.md)):

```python
from pipelex_sdk.product_models import FileKind, FileLinked, FileLinkTarget, UploadKind

page = await client.list_files(q="invoice", kind=FileKind.UPLOADED, formats=["pdf"])
started = await client.start(method_id="mt_123", inputs={"invoice": {"url": page.items[0].uri}})
detail = await client.get_file(page.items[0].file_id)  # the whole record, with the runs and examples that used it
links = await client.link_files([FileLinkTarget(file_id=detail.file_id)])
for link in links.items:
    if isinstance(link, FileLinked):
        print(link.name, link.url)  # a fifteen-minute link: keep it out of logs
archive = await client.request_file_archive(run_id=started.pipeline_run_id)
# then get_file_archive(archive.archive_id) until its state is ready or failed.
run_files = await client.list_run_files(started.pipeline_run_id)  # what went in, came out and was made along the way
# An upload recorded as a test file of the method it was made to try.
await client.upload_file("cases/receipt.pdf", kind=UploadKind.TEST, method_id="mt_123")
```

### Read a method's inputs and outputs

`pipe_io()` returns a method's pipe I/O contracts, input form and output form in one call, without validating it (no dry run). The server selects the pipe — your `pipe_ref`, else the package manifest's `main_pipe`, else the closure's single `main_pipe` declaration — and the three artifacts are the standard's own models from `mthds.protocol`:

```python
from pipelex_sdk.crate_models import PipeIORequest, PipeIOValidReport

report = await client.pipe_io(PipeIORequest(method_ref="github.com/Pipelex/methods/documents@v0.1.0"))
if isinstance(report, PipeIOValidReport) and report.pipe_ref is not None:
    descriptor = report.input_form[report.pipe_ref]
    print([field.name for field in descriptor.fields], report.is_runnable)
```

`all_pipes=True` keys the three maps by every pipe instead, and `include_files=True` echoes the text of the method's own `.mthds` bundles as `files`, keyed by tree path. `prepare_inputs` reads its signature from this route, so it needs an API that serves `POST /v1/pipe-io`.

The crate routes take a method you hold as its tree, as a save does: `files`, the protocol's map from tree path to file entry, sent as given; `tree`, a `MethodTree` listed with `list_method_tree`; or `contents`, each file's bytes or text by tree path. A `tree` or `contents` too large to send inline is uploaded by hash first. `dependencies` carries the method packages the tree calls by address:

```python
tree = await client.list_method_tree(Path("methods/receipts"))
report = await client.pipe_io(PipeIORequest(tree=tree, include_files=True))
```

### Generate typed code into your project

`codegen()` projects a method into stamped typed artifacts plus their `codegen.lock`, and `write_codegen_tree` writes that response to disk verbatim, so the tree is byte-identical to a local `pipelex codegen types` run and no `pipelex` install is needed:

```python
from pathlib import Path

from pipelex_sdk.codegen_writer import write_codegen_tree
from pipelex_sdk.crate_models import CodegenRequest, CodegenValidReport

report = await client.codegen(CodegenRequest(method_ref="github.com/Pipelex/methods/documents@v0.1.0", target="python-pydantic"))
if not isinstance(report, CodegenValidReport):
    raise SystemExit(report.message)
written = write_codegen_tree(report, output_dir=Path("src/generated/documents"))
print(written.written, written.removed)
```

It never overwrites a file codegen does not own, rewrites only what changed, and prunes stamped artifacts that dropped out of the set. Commit the tree; do not run a formatter over it.

### Gate a committed tree in CI, with no key and no `pipelex`

`run_codegen_check` is the writer's counterpart: pure hashing over the tree and its lock, so it boots no engine, reaches no network and needs no API key. Point it at the directory you generated into:

```python
from pathlib import Path

from pipelex_sdk.codegen_check import run_codegen_check

report = run_codegen_check(root=Path("src/generated/documents"))
if not report.is_current:
    for drift in report.drifts:
        print(f"{drift.path}: {drift.category} — {drift.detail}")
    raise SystemExit(1)
```

The drift categories are `pipelex codegen check`'s, and so are the sentences: an artifact edited below its stamp is `hand-edited`, one off the locked hash is `modified`, one the lock tracks and disk has lost is `missing`, and a stamped file the lock does not track is an `orphan` — the stale-artifact class a per-file stamp cannot catch alone. The two readers reach the same verdict over the same bytes apart from two deliberate divergences, both documented in `docs/architecture.md`: this one accepts a projection line whose axes are outside its own vocabulary, where the CLI calls such a tree hand-edited, and it refuses a Python artifact that declares a PEP 263 source encoding, where the CLI calls that one current. Regeneration stays a developer action, because it needs the engine; the check is the CI action, because it needs only hashes, so an upstream template improvement never reddens your pipeline. Whether the tree still matches what the *method* resolves to is a separate question the engine alone can answer — compare `report.crate_fingerprint` against a live `codegen()` response to close it.

### Check a model reference

`check_model_reference()` asks the runner whether a reference a method's `model` field could name resolves, as what kind and to which model (`GET /v1/models/check`, served by `pipelex-api` from pipelex 0.78.0). A reference that resolves nowhere is a verdict, not an error, and the verdict is one arm per reference kind, so narrowing it types its `matches`:

```python
from pipelex_sdk.model_reference_models import ModelCheckCategory, ModelReferenceResolution, PresetReferenceVerdict

verdict = await client.check_model_reference("$writing-factual", category=ModelCheckCategory.LLM)
if verdict.resolution is ModelReferenceResolution.RESOLVED:
    for entry in verdict.matches:
        # `resolves_to` is None when the name exists but a run through it would reach no model.
        print(entry.category, entry.resolves_to or "warning: no model the runner can call")
    if isinstance(verdict, PresetReferenceVerdict):
        print(verdict.matches[0].description)
else:
    print(verdict.other_kinds, verdict.suggestions)  # what the caller may have meant
```

A reference the runner cannot read at all (blank, a sigil alone, too long) or an unknown category raises `ApiResponseError`, a `422` `request.invalid` whose problem's `location.field` is `reference` or `type`.

### Long runs: start + poll explicitly

Behind the hosted gateway, a synchronous `execute()` is cut off at ~30s and surfaces a `PipelineExecuteTimeoutError` pointing here. For long methods, drive the durable lifecycle yourself — the run survives client disconnects and is resumable by `pipeline_run_id`:

```python
ack = await client.start(pipe_code="long_pipe", inputs={...})
result = await client.wait_for_result(ack.pipeline_run_id)
```

To show the run advancing while it waits, pass `on_progress` in `WaitForResultOptions`: it is called with each fresher progress snapshot, a `RunProgress` whose `summary` is one line to show as it is and whose `invocations` say which pipes have started, ended or are stuck. A progress read that fails never fails the wait, and once the run has ended `get_run_progress(run_id)` reads the final snapshot ([`docs/run-results.md`](docs/run-results.md#following-a-run-while-it-runs--on_progress-and-get_run_progress)):

```python
from pipelex_sdk.runs import WaitForResultOptions

result = await client.wait_for_result(
    ack.pipeline_run_id,
    WaitForResultOptions(on_progress=lambda progress: print(progress.summary)),
)
```

### A start you can retry: `idempotency_key`

`start` and `start_and_wait` take an optional `idempotency_key`, sent as the `Idempotency-Key` header of `POST /v1/start`. The hosted API binds the key to the run the first request starts, so the same start sent again under the same key is answered with that run and starts nothing: a start whose answer was lost can be sent again without paying for a second run. Generate one key per run, and keep it with the arguments, unchanged, across that start's retries:

```python
import uuid

from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.models import RetryVerdict

idempotency_key = str(uuid.uuid4())
try:
    ack = await client.start(method_id="mt_abc123", inputs=inputs, idempotency_key=idempotency_key)
except PipelineRequestError as exc:
    match exc.problem.effective_retry:
        case RetryVerdict.OUTCOME_UNKNOWN:
            # The run may exist: under the same key, the same start is answered with it.
            ack = await client.start(method_id="mt_abc123", inputs=inputs, idempotency_key=idempotency_key)
        case RetryVerdict.YES | RetryVerdict.NO:
            raise
```

A key is 1 to 255 visible ASCII characters; a key reused with other arguments is refused with a `409` `request.idempotency_conflict`, and one whose earlier start is still being handled with a `409` `request.idempotency_key_in_use` whose `retry` is `yes` ([`docs/errors.md`](docs/errors.md#a-starts-idempotency-key--idempotency_key)). A bare runner ignores the header.

### Errors: every one carries its problem

Every error the SDK raises carries its failure as one problem document, the MTHDS standard's RFC 9457 document, under a registered code, as `exc.problem`, typed as the standard's `Problem`: the hosted API's own when it refused the request, the problem the platform stored when a run failed, and one the SDK builds under a `client.*` code for a failure it detects itself, such as a request that got no answer or an answer it cannot read. Every error raised over a request is a `PipelexRequestError`, itself the standard's `PipelineRequestError`, so one `except PipelineRequestError` covers them all. Read `problem.code` to branch on, `problem.effective_domain` for who must act (`input`, `method`, `account`, `operator` or `runtime`), `problem.effective_retry` for whether sending the same request again can succeed (`yes`, `no`, or `outcome_unknown` when a start may have created a run, which is looked up in the run history before anything is sent again, unless the start carried an `idempotency_key`, in which case sending it again unchanged recovers the run, [above](#a-start-you-can-retry-idempotency_key)), `problem.next_step` for what to do, `problem.retry_after`, and the `request_id` to hand to support. Branch on the problem, never on the HTTP status or the message.

```python
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.models import ProblemDomain, RetryVerdict

try:
    results = await client.start_and_wait(method_id="mt_abc123", inputs=inputs)
except PipelineRequestError as exc:
    problem = exc.problem
    match problem.effective_retry:
        case RetryVerdict.OUTCOME_UNKNOWN:
            return look_up_the_run_before_starting_again(problem)
        case RetryVerdict.YES:
            return schedule_retry(problem.retry_after)
        case RetryVerdict.NO:
            pass
    match problem.effective_domain:
        case ProblemDomain.INPUT | ProblemDomain.METHOD:
            for item in problem.errors or []:
                print(f"{item.location.pipe if item.location else '?'}: {item.detail}")
            print(f"Next step: {problem.next_step.detail}")
        case ProblemDomain.ACCOUNT | ProblemDomain.OPERATOR | ProblemDomain.RUNTIME:
            print(problem.detail)
    raise
```

A refused request raises an `ApiResponseError` whose `problem` is the hosted API's problem document as received, its `pipelex.*` code included, with every member the standard does not name, such as the `limit` a refusal past a bound names, on `problem.model_extra`; an answer whose body is no problem document, from the hosted edge, a gateway or a proxy, reads by its status. `status`, `status_text`, `response_body`, `headers` and `request_url` keep the answer itself. It is `mthds`'s own `ApiResponseError` narrowed, so `except mthds.runners.api.exceptions.ApiResponseError` catches it too. `MethodErrorCode` names the codes a method caller branches on, and `IdempotencyErrorCode` those of an `Idempotency-Key`.

A request that gets no answer — a refused connection, a host name that does not resolve, a TLS failure, a timeout — raises `ApiUnreachableError`, never httpx's own exception, with `api_url` the base URL and `network_code` the failure (`ABORT_TIMEOUT` when the client's own time limit ran out, otherwise httpx's class name). Its problem is `client.unreachable` or `client.timeout`, and `client.outcome_unknown` for a `start` or an `execute` that may have left this machine.

On the hosted API, a run that ends without completing raises a `RunFailedError` from `wait_for_result`, `start_and_wait` and `download_artifacts`, and comes back as the `failed` arm of `get_run_result`. Its `problem` is `run.failed`, naming the run and its terminal status, and its `run_error` is the run's own problem, which `run.failed` nests as `run_error`: why the run did not succeed, under its own code (`run.cancelled`, `model.unavailable`, `method.invalid`, …), with its own `retry` and `next_step`. It is `None` when the run ended with no problem stored. The same problem is `RunRead.error` when you read the run's status, `RunResultFailed.error` from `get_run_result`, and `RunHistoryItem.error` in the run lists.

```python
from pipelex_sdk.errors import RunFailedError

try:
    result = await client.wait_for_result(run_id)
except RunFailedError as exc:
    print(exc)  # names the run and its terminal status
    print(exc.run_error.next_step.detail if exc.run_error else "No next step was given.")
```

[`docs/errors.md`](docs/errors.md) gives each class's problem, the reading of an answer that is no problem document, and the case file both SDKs run.

## Public import paths (no barrel)

There is no barrel import — package `__init__.py` files stay empty. Import each symbol from its module:

- **Client & construction** — `from pipelex_sdk.client import PipelexAPIClient, DEFAULT_API_BASE_URL`
- **Run lifecycle types** — `from pipelex_sdk.runs import RunStatus, RunPublic, RunRead, RunResults, RunResultState, WaitForResultOptions, PollInfo`, and the progress snapshot `RunProgress`, `RunProgressStatus`, `ProgressInvocation`, `ProgressInvocationStatus`, `ProgressBatch`, `ProgressCondition`, `ProgressFailure`, `ProgressAttempt` with `is_fresher_run_progress`
- **Problems** — the standard's `Problem` and `ProblemItem` from `mthds.protocol.problem.models`; `from pipelex_sdk.answer_reading import read_hosted_answer` for the SDK's reading of an answer, and `from pipelex_sdk.problem_items import read_problem_items` for problem items read member by member
- **Product wire models** — `from pipelex_sdk.product_models import UserProfile, MethodData, MethodDetail, SavedMethodFile, MethodWriteInput, MethodDraftInput, MethodVersion, MethodVersionSummary, MethodPublished, MethodPublishUnchanged, MethodPublishRefused, Membership, MembershipsResponse, OrganizationBranding, OrganizationBrandingUpdate, BrandingColors, BrandingColorsUpdate, LogoDescriptor, SubscriptionResponse, PlanView, InvoiceView, OnboardingSubmission, UploadInput, UploadKind, UploadedFile, FileSummary, FileRecord, FileDetail, FileLinkTarget, FileLinked, FileLinkRefused, FileArchive, FileArchiveLimit, RunFilesPage, DraftFileFromFileResult, MethodExample, MethodExampleAssistantKept, MethodExampleAssistantCreated, RunHistoryItem, RunDetail, ...`; a method's tree is `mthds`'s own, `MethodTree` and `TreeLimits` from `mthds.method_tree.models` and `FileEntry` from `mthds.method_tree.file_entry`.
- **Method selectors** — `from pipelex_sdk.method_selector import parse_method_selector, ParsedMethodSelector`
- **Validation verdict types** — `from pipelex_sdk.validation_models import PipelexValidationResult, PipelexValidationReport, PipelexInvalidReport, TreeFileRead, TreeFileUse, VALIDATION_VIEW_INPUT_FORM, ...`
- **Crate routes** — `from pipelex_sdk.crate_models import ResolveRequest, CodegenRequest, PipeIORequest, PipeIOValidReport, CrateInvalidReport, ...`, the requests and the two 200 arms of `resolve`, `codegen` and `pipe_io`, which take the method's tree as `files`, `tree` or `contents`
- **Model reference check** — `from pipelex_sdk.model_reference_models import ModelReferenceVerdict, PresetReferenceVerdict, AliasReferenceVerdict, WaterfallReferenceVerdict, HandleReferenceVerdict, PresetMatch, AliasMatch, WaterfallMatch, HandleMatch, ModelCheckCategory, ModelReferenceKind, ModelReferenceResolution, ...`, the verdict of `check_model_reference`, one arm per reference kind
- **Codegen tree** — `from pipelex_sdk.codegen_writer import write_codegen_tree, CodegenTreeWriteReport` to write one, `from pipelex_sdk.codegen_check import run_codegen_check, CodegenCheckReport, CodegenDrift, DriftCategory` to verify one, with the format primitives in `pipelex_sdk.codegen_lock` (`CodegenLock`, `parse_lock`, `load_lock`, `validate_artifact_path`, ...) and `pipelex_sdk.codegen_stamp` (`STAMPABLE_SUFFIXES`, `is_stampable_artifact_path`, `compute_content_hash`, `parse_stamped`, ...)
- **Typed errors** — `from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError, PipelineExecuteTimeoutError, PagingNotTerminatingError, RunFailedError, RunTimeoutError, RunLifecycleUnavailableError, RunStillRunningError, CodegenError, CodegenLockError, MethodErrorCode, LogoRefusalCode, ...`
- **Version** — `from pipelex_sdk.version import __version__`
- **Client identification** — `from pipelex_sdk.user_agent import AppInfo, build_user_agent, is_token`
- **Protocol surface** (the MTHDS standard's wire types) comes from the `mthds` dependency — e.g. `from mthds.protocol.exceptions import PipelineRequestError`, `from mthds.protocol.models import ValidationResult` (the neutral verdict union that `PipelexValidationResult` narrows).
- **Input-form descriptors and pipe I/O contracts** come from `mthds` too, because they are the standard's artifacts and this SDK only carries them: `from mthds.protocol.input_form import InputForm, InputFormField, ListField, TextField, ...` and `from mthds.protocol.pipe_io_contracts import PipeIOContracts, PipeInputContract, PresenceMarker, IOMultiplicity, ...`. `PipelexValidationReport.input_form` and `.pipe_io_contracts` are typed with them, as are the three maps of `PipeIOValidReport` (with `mthds.protocol.output_form.OutputForm`), so a node narrows on its `kind` and a slot's presence and multiplicity read as enums — but `pipelex_sdk` does not re-export the vocabulary, and importing it from here is the one supported path.

## Development

```bash
make install      # create the venv and install all extras
make agent-check  # fix-imports + format + lint + pyright + mypy
make agent-test   # run the test suite quietly (prints only on failure)
make check        # full gate: agent-check aggregate + unused-imports + pylint
```

The package is developed on the Python that `.python-version` names, which uv reads, so `uv sync` and `uv run` build `.venv` on that version rather than on the newest Python installed on the machine. The next `make install` moves an environment built on another Python back to it, and `PYTHON_VERSION=<version> make install` builds it on another one: the `Makefile` exports the version it uses as `UV_PYTHON`, so every uv command it runs keeps to it.

See `CLAUDE.md` for the coding standards and `docs/architecture.md` for the design (including the parity map against `@pipelex/sdk`).

## License

MIT — see [LICENSE](./LICENSE).
