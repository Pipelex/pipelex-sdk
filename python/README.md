# pipelex-sdk

The Python client for the [Pipelex](https://www.pipelex.com) hosted API.

`pipelex-sdk` is the Python counterpart of [`@pipelex/sdk`](https://www.npmjs.com/package/@pipelex/sdk), exactly as [`mthds`](https://pypi.org/project/mthds/) (the `mthds-python` package) is the Python counterpart of the `mthds` npm package. It is the **hosted superset**: the five normative MTHDS Protocol routes (inherited from `mthds`) **plus** the durable run lifecycle **plus** the Pipelex product surface (methods, organizations, billing, API keys, onboarding, storage, run records).

One-way dependency: `pipelex-sdk → mthds`.

## Install

```bash
pip install pipelex-sdk
```

## Run a method from the command line

The package publishes the `pipelex-sdk` command, so a method runs on the hosted API with nothing to install but [uv](https://docs.astral.sh/uv/):

```bash
export PIPELEX_API_KEY=<your key>
uvx pipelex-sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs-template > inputs.json
uvx pipelex-sdk run --method github.com/acme/methods/receipt-review@v1.0.0 --inputs inputs.json
```

`--method` takes a published address, a catalog id (`mt_…`, which runs the method's latest published version, `mt_…@<n>` for a fixed version or `mt_…@draft` for its draft) or a local `.mthds` file or bundle directory. The run's main output is printed as JSON on stdout, and the run id, each uploaded file and every error go to stderr; Ctrl-C leaves the run going on the server and names it. `uvx pipelex-sdk script --method <address | mt_id>` checks the method and writes a short shell script that runs it with this SDK's version pinned. The key comes from `PIPELEX_API_KEY` only, and no `.env` file is read. The command is the twin of `npx @pipelex/sdk`, held to the same recorded cases; [`docs/cli.md`](docs/cli.md) describes it.

## Configuration

The **API key** resolves, in order: explicit `api_key` argument → `PIPELEX_API_KEY` → anonymous. The token is **optional** — anonymous access works against the protocol routes (e.g. a local bare runner); the product routes return `401`.

The **base URL** resolves, in order: explicit `base_url` argument → `PIPELEX_BASE_URL` → the hosted default `https://api.pipelex.com`. The base URL is host-only (no path/query/fragment); every endpoint composes as `{base}/v1/{endpoint}`.

The SDK never reads the `mthds` resolver (`MTHDS_API_KEY` / `MTHDS_BASE_URL` / `~/.mthds/config`) — those settings configure the vendor-neutral `mthds` tooling and whichever runner it targets, not this Pipelex client.

`request_timeout_seconds` (constructor argument, default 20 min) is the time limit of the routes that can take long: the blocking `execute`, `validate`, `models`, and a `start` carrying a bundle (`mthds_contents`, `files` or `bundle_b64`) or a `method_ref`, which the server resolves before it answers. `version` and any other `start` answer fast, so they take `request_timeout_seconds` capped at the 30-second poll budget, the hosted gateway's own cut-off. The SDK's own polls and product requests keep budgets of their own.

`app_info` (constructor argument, an `AppInfo` from `pipelex_sdk.user_agent`) puts your application's name in front of the SDK's own tokens in the `User-Agent` that every request carries — `acme-invoicer/1.4.0 pipelex-sdk-python/0.11.0 mthds-python/0.15.0 python/3.12.4 (linux; x86_64)` — which the platform uses to attribute traffic in its analytics. The header follows the spec `conformance/specs/client-identification.md`, in the `conformance` repository, where the cross-repo specs sit beside the tests that verify them; see [`docs/client-identification.md`](docs/client-identification.md).

The client is **async-only** (httpx `AsyncClient`) and is an async context manager.

## Quickstart

```python
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.validation_models import VALIDATION_VIEW_INPUT_FORM


async def main() -> None:
    async with PipelexAPIClient() as client:
        # 1. Validate an MTHDS bundle. The verdict is always returned (never raised):
        #    a 200 discriminated on `is_valid`, carrying `rendered_markdown`.
        #    Structured views are opt-in: asking for `input_form` here is what populates
        #    `report.input_form` (the per-pipe input-form descriptors); omit `views` and the
        #    request body carries no `views` key at all.
        report = await client.validate([bundle_text], views=[VALIDATION_VIEW_INPUT_FORM])
        print(report.rendered_markdown)
        if not report.is_valid:
            return

        # 2. Run a method end-to-end. `start_and_wait` self-heals across runner kinds:
        #    durable start+poll on the hosted API, blocking execute on a bare runner.
        result = await client.start_and_wait(
            pipe_code="my_pipe",
            inputs={"topic": "quantum computing"},
        )

        # 3. Read the output. Every completed run delivers a resolved `main_stuff`
        #    (the full working memory also rides `pipe_output` on the blocking path).
        print(result.main_stuff)
```

### Run a published method by address

A method reaches every method-taking call in exactly one of three forms: inline source, a `method_ref` address (`github.com/<owner>/<repo>[/<selector>][@<tag>]`, resolved by the server — pipelex-api >= 0.21.0; on `api.pipelex.com` availability follows the platform deploy that forwards it), or a hosted `method_id` (`mt_…`, resolved by the platform). A `method_ref` pairs with nothing — it is a complete run source — and its runs carry typed provenance:

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

A saved method has a draft, written freely and never validated, and immutable published versions numbered from 1. `updated_at` is the draft's token: echo it so no write or publish takes a draft you have not seen. The method routes take a bare id, and `parse_method_selector` strips a suffix:

```python
from pipelex_sdk.method_selector import parse_method_selector
from pipelex_sdk.product_models import MethodDraftInput, MethodPublishRefused

method = await client.get_method("mt_123")
draft = await client.write_draft("mt_123", MethodDraftInput(mthds="domain = 'demo'\n", expected_updated_at=method.updated_at))
result = await client.publish_method("mt_123", expected_draft_updated_at=draft.updated_at)
if isinstance(result, MethodPublishRefused):
    print(result.message, result.validation)
else:
    print(f"version {result.version.version}")  # published, or unchanged
versions = await client.list_method_versions("mt_123")  # newest first
parsed = parse_method_selector("mt_123@3")  # ParsedMethodSelector(method_id="mt_123", version=3)
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

`all_pipes=True` keys the three maps by every pipe instead, and `include_files=True` echoes the closure's `.mthds` files. `prepare_inputs` reads its signature from this route, so it needs an API that serves `POST /v1/pipe-io`.

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

A reference the runner cannot read at all (blank, a sigil alone, too long) or an unknown category raises `ApiResponseError`, a `422` whose `error_type` is `InvalidModelReference` or `InvalidModelCategory`.

### Long runs: start + poll explicitly

Behind the hosted gateway, a synchronous `execute()` is cut off at ~30s and surfaces a `PipelineExecuteTimeoutError` pointing here. For long methods, drive the durable lifecycle yourself — the run survives client disconnects and is resumable by `pipeline_run_id`:

```python
ack = await client.start(pipe_code="long_pipe", inputs={...})
result = await client.wait_for_result(ack.pipeline_run_id)
```

### When a run is refused: `ApiResponseError` says why and what to do next

A method the plane will not run — a bundle naming a model the deck does not serve, a pipe whose output cannot be assembled — is refused before any result exists: `start`, `execute` and `start_and_wait` raise `ApiResponseError` on the `422`. Its message names the request, gives the reason and, on its own line, the next step the plane advises, so printing the error is already actionable:

```text
API POST /v1/start failed (422): Pipe 'draft_pitch' (PipeLLM), field 'model': Model handle 'gpt-5.1' was not found in the model deck

Did you mean: gpt-5.5, gpt-5.4, gpt-5.6-sol, gpt-5.4-pro, gpt-5.6-luna
Next step: Edit the bundle as each validation error says: apply its suggested fix where it has one, after confirming an unsafe one
```

A program reads the same thing as fields:

```python
from pipelex_sdk.errors import ApiResponseError

try:
    result = await client.start_and_wait(pipe_code="pitch_product", mthds_contents=[bundle])
except ApiResponseError as exc:
    if exc.error_domain == "input":
        for item in exc.validation_errors or []:
            print(f"{item.pipe_code}: {item.message}")  # the failing pipe, typed as ValidationErrorItem
        if exc.user_action is not None:
            print(f"Next step: {exc.user_action.detail}")
    raise
```

`validation_errors` is set when the runner itemized its refusal at load; a run that failed during execution carries the pipe in `server_message` instead (`Pipe 'analyze_topics' failed (review_topics → analyze_topics): …`).

### When a run fails: `RunFailedError` carries the run's report

A run that ends without a result — `FAILED`, `CANCELLED`, `TERMINATED` or `TIMED_OUT` — makes `wait_for_result`, `start_and_wait` and `download_artifacts` raise `RunFailedError`. Its message already names the status and the reason (`Run finished with status FAILED: <message>`), `status` is the typed `RunStatus`, and `error` is the run's stored error report, typed whole as `RunErrorReport` (`pipelex_sdk.error_models`): the runner's `error_type`, `message`, `title`, `type_uri`, `error_domain`, `error_category`, `retryable`, `user_action`, `model`, `provider`, `provider_metadata`, `validation_errors`, and anything newer on `model_extra`. `error` is `None` for a run that ended with no report, such as a cancelled one.

```python
from pipelex_sdk.errors import RunFailedError

try:
    result = await client.wait_for_result(run_id)
except RunFailedError as exc:
    report = exc.error
    if report is None:
        print(f"Run {exc.run_id} ended {exc.status} without a report.")
    else:
        print(f"{report.title}: {report.user_action.detail if report.user_action else report.message}")
        if report.retryable:
            ...  # the same run may succeed if started again
```

Branch on `error_domain` (`input`, `config`, `runtime`), `type_uri` and `retryable`, never on the wording of `message`. The report is the runner's verbose one, so `message` and `provider_metadata` can hold a model provider's raw text: what a person should see of it is your application's decision. The same report is on `RunRead.error` when you read the run's status, on `RunResultFailed.error` from `get_run_result`, and on `RunHistoryItem.error` in the run lists.

### API errors: branch on `type_uri` and `error_domain`, not the HTTP status

Every `/v1` route raises a typed `ApiResponseError` on a non-2xx answer, carrying the members of the RFC 9457 problem document: the protocol routes (`execute`, `start`, `validate`, `models`, `version`), the run status and results reads, and the product routes — the account, methods, organization, billing, API-key, onboarding, storage and upload methods, `codegen`, `resolve`, `pipe_io` and `check_model_reference`, and the run records (`list_runs`, `iterate_runs`, `get_run_detail`, `update_run`). It is `mthds`'s own `ApiResponseError` narrowed, so `except mthds.runners.api.exceptions.ApiResponseError` catches it too; `health` raises `PipelineRequestError`, and `docs/architecture.md` lists the error regimes. The branch fields are `type_uri`, the problem's `type`, a stable URI naming the error class that every problem carries, and `error_domain`, the coarse class (`input` means the caller can fix it, `config` that a configuration change is needed, `runtime` that execution failed). `error_domain` is carried only by the problems the runner renders — a run route's refusal, and those of `codegen`, `resolve`, `pipe_io` and `check_model_reference`, which the hosted API relays from the runner — and is `None` on the platform's own problems, such as those of the account, billing and API-key routes, which name their class by `type_uri` alone:

```python
from pipelex_sdk.errors import ApiResponseError

try:
    created = await client.create_pipelex_api_key(label="ci")
    print(created.api_key)  # plaintext — returned only once
except ApiResponseError as exc:
    if exc.type_uri == "https://pipelex.com/errors/pipelex_api_key_limit_reached":
        print("Per-account key limit reached — revoke an old key first.")
    elif exc.type_uri == "https://pipelex.com/errors/validation_failed":
        print(f"Fix the request: {exc.server_message}")
    else:
        print(f"Unexpected failure, request id {exc.request_id}")
        raise
```

On a problem the runner rendered, branch on `error_domain` for the class — `if exc.error_domain == "input":` shows the caller what to fix, whatever the exact error. The rest of the document rides beside them: `server_message` (the `detail`), `title`, `instance`, `retryable`, `user_action` (the `mthds` `UserAction`, kept only when it has a `kind` and a non-empty `detail`), `error_category`, the platform's field-level `errors`, `validation_errors` for a bundle fault, and `request_id` for a support request, read from the body or from the `X-Request-ID` header. The answer itself stays reachable as plain data: `status`, `headers` (lower-case names, so `exc.headers.get("retry-after")` reads a `429`'s delay) and `request_url`. `code` (the platform's closed code, such as `conflict`) and `error_type` (the runner's exception class name) are each surface's own finer code — useful for display and support, not the field to branch on. `problem` is the decoded document whole, for any member the SDK does not name.

### No answer at all: `ApiUnreachableError`

When a request gets no answer — a refused connection, a host name that does not resolve, a TLS failure, a timeout — every method of the client raises `ApiUnreachableError`, never httpx's own exception: the protocol routes (`execute`, `start`, `validate`, `models`, `version`) as well as the run reads, `wait_for_result`, `start_and_wait`, the product routes and `health`. It carries `api_url`, the base URL that could not be reached, and `code`: `ABORT_TIMEOUT` when the client's own time limit ran out once the request had reached the API, while it was sent or answered, and otherwise the name of the httpx failure (`ConnectError`, `ReadError`, `ConnectTimeout`, `PoolTimeout`, …), which stays reachable as `__cause__`. Like `ApiResponseError`, it is a `PipelineRequestError`, so one `except PipelineRequestError` covers every failed request. A blocking `execute` cut off by a timeout after about 28 seconds raises `PipelineExecuteTimeoutError` instead, pointing at `start_and_wait`.

```python
from pipelex_sdk.errors import ApiUnreachableError

try:
    result = await client.start_and_wait(pipe_code="pitch_product", mthds_contents=[bundle])
except ApiUnreachableError as exc:
    print(f"Could not reach the Pipelex API at {exc.api_url} ({exc.code}); check PIPELEX_BASE_URL and your network.")
```

## Public import paths (no barrel)

There is no barrel import — package `__init__.py` files stay empty. Import each symbol from its module:

- **Client & construction** — `from pipelex_sdk.client import PipelexAPIClient, DEFAULT_API_BASE_URL, MthdsFile`
- **Run lifecycle types** — `from pipelex_sdk.runs import RunStatus, RunPublic, RunRead, RunResults, RunResultState, WaitForResultOptions, PollInfo`
- **Error reports** — `from pipelex_sdk.error_models import RunErrorReport, UserAction, ProviderErrorMetadata, MigrationErrorBlock, FieldError`
- **Product wire models** — `from pipelex_sdk.product_models import UserProfile, MethodData, MethodWriteInput, MethodDraftInput, MethodVersion, MethodVersionSummary, MethodPublished, MethodPublishUnchanged, MethodPublishRefused, Membership, MembershipsResponse, SubscriptionResponse, PlanView, InvoiceView, OnboardingSubmission, UploadInput, UploadedFile, RunHistoryItem, RunDetail, ...`, with the catalog-source readers beside them: `method_source_to_contents` turns a fetched `MethodData.mthds` into the `mthds_contents` a run or a validate takes, and `MethodFile` / `parse_method_files` / `serialize_method_files` are the codec for a method's custom PipeFunc `python`.
- **Method selectors** — `from pipelex_sdk.method_selector import parse_method_selector, ParsedMethodSelector`
- **Validation verdict types** — `from pipelex_sdk.validation_models import PipelexValidationResult, PipelexValidationReport, PipelexInvalidReport, ValidationErrorItem, SuggestedFix, VALIDATION_VIEW_INPUT_FORM, ...`
- **Crate routes** — `from pipelex_sdk.crate_models import ResolveRequest, CodegenRequest, PipeIORequest, PipeIOValidReport, CrateInvalidReport, MthdsFileItem, ...`, the requests and the two 200 arms of `resolve`, `codegen` and `pipe_io`
- **Model reference check** — `from pipelex_sdk.model_reference_models import ModelReferenceVerdict, PresetReferenceVerdict, AliasReferenceVerdict, WaterfallReferenceVerdict, HandleReferenceVerdict, PresetMatch, AliasMatch, WaterfallMatch, HandleMatch, ModelCheckCategory, ModelReferenceKind, ModelReferenceResolution, ...`, the verdict of `check_model_reference`, one arm per reference kind
- **Codegen tree** — `from pipelex_sdk.codegen_writer import write_codegen_tree, CodegenTreeWriteReport` to write one, `from pipelex_sdk.codegen_check import run_codegen_check, CodegenCheckReport, CodegenDrift, DriftCategory` to verify one, with the format primitives in `pipelex_sdk.codegen_lock` (`CodegenLock`, `parse_lock`, `load_lock`, `validate_artifact_path`, ...) and `pipelex_sdk.codegen_stamp` (`STAMPABLE_SUFFIXES`, `is_stampable_artifact_path`, `compute_content_hash`, `parse_stamped`, ...)
- **Typed errors** — `from pipelex_sdk.errors import ApiResponseError, ApiUnreachableError, PipelineExecuteTimeoutError, PagingNotTerminatingError, RunFailedError, RunTimeoutError, RunLifecycleUnavailableError, RunStillRunningError, CodegenError, CodegenLockError, MethodErrorCode, ...`
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

See `CLAUDE.md` for the coding standards and `docs/architecture.md` for the design (including the parity map against `@pipelex/sdk`).

## License

MIT — see [LICENSE](./LICENSE).
