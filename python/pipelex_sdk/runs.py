"""Run-lifecycle models for the hosted polling surface (`/v1/runs/*`).

Long method runs outlive the hosted gateway's ~30s synchronous cap, so the SDK
submits a run (`POST /v1/start`), then polls a self-healing endpoint by bare
`pipeline_run_id` until the run reaches a terminal state. All state lives behind the id
(DynamoDB + Temporal on the platform), so a caller can drop the poll loop and
resume later with just the id.

Polling is NOT part of the MTHDS Protocol — it is a hosted-API extension. A
bare runner 404s these routes, which the client translates into
`RunLifecycleUnavailableError`.

The lifecycle types **defined here are owned by this SDK** (not imported from
`mthds`): the run lifecycle is a Pipelex-branded hosted surface, mirroring
`pipelex-sdk-js/src/runs.ts`. During the transition (HANDOFF Phase 2) the same
shapes still exist in `mthds-python`; that duplication is deliberate and is
removed from `mthds-python` in Phase 6, leaving these as the single home.

Three things in this module are deliberately NOT owned here, and all reuse rather
than redefine. `RunResults.pipe_output` and `RunResults.working_memory` are typed
with the protocol's own `DictPipeOutputAbstract` and `DictWorkingMemoryAbstract`
wire models from `mthds` — a shared wire contract the `pipelex` runtime also builds
on, not a lifecycle concept. The three I/O artifacts
on `RunResults` (`pipe_io_contracts`, `input_form`, `output_form`) are the standard's
own, typed by importing `mthds.protocol` exactly as the validate report does — one
declaration per language, nothing to drift from. `TokensUsageRecord` mirrors the
runtime's own record: inference accounting is a Pipelex runtime extension the MTHDS
Protocol does not model, so the hosted API is what pins that wire contract; this SDK
follows the shape, it does not define it.

Wire contract mirrors `pipelex-platform`:
    POST /v1/start                           -> RunResultStart   (start, 202)
    GET  /v1/runs/{pipeline_run_id}/status   -> RunRead          (status, self-healing)
    GET  /v1/runs/{pipeline_run_id}/results  -> 202 / 200 / 409  (results; `?artifacts=` narrows the 200)
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Annotated, Any, Literal, TypeAlias

from mthds.protocol.input_form import InputForm
from mthds.protocol.models import RunResultStart
from mthds.protocol.output_form import OutputForm
from mthds.protocol.pipe_io_contracts import PipeIOContracts
from mthds.runners.api.models import DictPipeOutputAbstract, DictWorkingMemoryAbstract
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidatorFunctionWrapHandler, WrapValidator, field_validator

from pipelex_sdk._pydantic_utils import none_when_it_does_not_fit
from pipelex_sdk.error_models import LenientRunErrorReport

if TYPE_CHECKING:
    from collections.abc import Callable


# ── Status ──────────────────────────────────────────────────────────


class RunStatus(StrEnum):
    """Hosted run lifecycle status. Mirrors `pipelex_shared.schemas.run.RunStatus`.

    Run states are a hosted-implementation concept — the protocol defines none.
    `STARTED` is deprecated server-side but kept here for historical rows.
    """

    PENDING = "PENDING"
    STARTED = "STARTED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    TERMINATED = "TERMINATED"
    TIMED_OUT = "TIMED_OUT"

    @property
    def is_terminal(self) -> bool:
        """True if the run has reached a terminal state (no further transitions)."""
        match self:
            case RunStatus.COMPLETED | RunStatus.FAILED | RunStatus.CANCELLED | RunStatus.TERMINATED | RunStatus.TIMED_OUT:
                return True
            case RunStatus.PENDING | RunStatus.STARTED | RunStatus.RUNNING:
                return False

    @property
    def is_success(self) -> bool:
        """True only for `COMPLETED`; every other terminal status is a failure."""
        match self:
            case RunStatus.COMPLETED:
                return True
            case (
                RunStatus.PENDING
                | RunStatus.STARTED
                | RunStatus.RUNNING
                | RunStatus.FAILED
                | RunStatus.CANCELLED
                | RunStatus.TERMINATED
                | RunStatus.TIMED_OUT
            ):
                return False


# ── Result artifacts ────────────────────────────────────────────────


class RunArtifact(StrEnum):
    """One result artifact the results read can be asked for, named by the response field it fills.

    `get_run_result(run_id, artifacts=[...])` sends the selection as `?artifacts=a,b`, and the
    platform then reads, re-signs and returns only those artifacts: a field that was not asked for
    is ABSENT from the body, where a field that was asked for but never written is `null`.
    `TOKENS_USAGES` names the usage envelope, so asking for it fills `usage_assembly_error` too.
    Mirrors the platform's own `RunArtifact`.
    """

    GRAPH_SPEC = "graph_spec"
    PIPE_IO_CONTRACTS = "pipe_io_contracts"
    INPUT_FORM = "input_form"
    OUTPUT_FORM = "output_form"
    MAIN_STUFF = "main_stuff"
    WORKING_MEMORY = "working_memory"
    TOKENS_USAGES = "tokens_usages"

    @property
    def results_fields(self) -> tuple[str, ...]:
        """The `RunResults` fields this artifact fills on the hosted results read."""
        match self:
            case RunArtifact.TOKENS_USAGES:
                return ("tokens_usages", "usage_assembly_error")
            case (
                RunArtifact.GRAPH_SPEC
                | RunArtifact.PIPE_IO_CONTRACTS
                | RunArtifact.INPUT_FORM
                | RunArtifact.OUTPUT_FORM
                | RunArtifact.MAIN_STUFF
                | RunArtifact.WORKING_MEMORY
            ):
                return (self,)


# ── Responses ───────────────────────────────────────────────────────


class MethodProvenance(BaseModel):
    """Provenance of a `method_ref` run — a Pipelex-API extension on the run acks.

    The package's resolved full address, the requested tag (`None` for a bare address,
    which resolves the default branch at HEAD), and the commit SHA that was actually
    fetched — the SHA is what keeps the run explainable when a tag moves. Attached to
    the `POST /v1/start` 202 ack (`PipelexRunResultStart.method_provenance`) and the
    blocking execute response (`PipelexExecuteResult.method_provenance`) for
    `method_ref` runs, absent (or `None`) otherwise. Extension-open (`extra="allow"`)
    like every wire model here, so a future server field is preserved.
    """

    model_config = ConfigDict(extra="allow")

    address: str
    tag: str | None = None
    commit_sha: str


class PipelexRunResultStart(RunResultStart):
    """The `POST /v1/start` 202 ack as the Pipelex API returns it — the protocol's
    `RunResultStart` plus the server's `method_provenance` extension, populated for
    `method_ref` runs and absent (`None`) otherwise, and the hosted platform's
    `method_version`, populated for `method_id` runs. The base is extension-open, so
    any other implementation field still rides `model_extra`.
    """

    pipeline_run_id: str = Field(min_length=1)
    """The run the server accepted. An empty id names no run, so an acknowledgement carrying one is an
    answer the SDK cannot read, as one without the member is."""

    method_provenance: MethodProvenance | None = None

    method_version: int | Literal["draft"] | None = None
    """Which version of the stored method a `method_id` run runs: the latest published version's
    number for a bare id, the pinned number for `mt_…@<n>`, `"draft"` for `mt_…@draft`. `None`
    for any other run, and on a server that does not resolve version selectors."""


class RunPublic(BaseModel):
    """A run record — the BASE shape of the run-lifecycle read surface.

    Only the base fields are declared here. An implementation may return more
    (identity, workflow ids, storage URLs, anything else) — those are
    server-specific response fields, never named in this SDK. The model is
    extension-open (`extra="allow"`): unknown fields are preserved and remain
    accessible as attributes, mirroring the request-side `extra` passthrough.
    """

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: str
    pipe_code: str | None = None
    status: RunStatus
    created_at: str
    finished_at: str | None = None
    #: Why the run failed — the stored report as the platform serves it, the runner's STRICT
    #: projection, whole and typed (see `pipelex_sdk.error_models`). The runner writes it for a run
    #: that fails while it runs; the platform writes one in the runner's shape for a run it ends or
    #: settles itself (a workflow task that kept failing, a timeout, a workflow that vanished). A
    #: cancelled, terminated or timed-out run holds a report when a completion callback carried one,
    #: and a timed-out run otherwise the platform's timeout report. `None` for a completed run, and
    #: for one that ended with no stored report (one whose start failed, a blocking `execute` run, one
    #: cancelled, terminated or given its status by hand with no completion callback carrying a
    #: report, one that ended before the platform wrote reports of its own). Read leniently, so a
    #: report written by another runner version never fails the read carrying it.
    error: LenientRunErrorReport = None
    #: Which version of its stored method the run ran: the version number for a run addressed by a
    #: bare `method_id` (the latest published version) or by `mt_…@<n>`, `"draft"` for one
    #: addressed by `mt_…@draft`, and `None` for a run of an inline source. A hosted extension,
    #: `None` on a server that does not record it.
    method_version: int | Literal["draft"] | None = None
    #: The digest of the files the run ran, in the canonical form of `MethodData.draft_digest`;
    #: `None` when the platform never held the files, as on a `method_ref` run, or does not record it.
    source_digest: str | None = None


class DegradationReason(StrEnum):
    """Why a status read is `degraded` — `RunDegradation.reason`.

    - `STATUS_UNAVAILABLE`: the platform could not reach the workflow engine, so `status` is the last
      one recorded. It says nothing about the run itself, which may be fine; read again after
      `retry_after_seconds`.
    - `WORKFLOW_TASK_FAILING`: `status` is live, and the run is not making progress. The workflow task
      that drives it has failed `failed_attempts` times in a row since `failing_since`; the workflow
      engine keeps retrying it, and if it is still failing at `ends_at` the platform ends the run
      `FAILED` with a `WorkflowTaskKeptFailingError` report.

    Read open, as `RunDegradation.reason` types it: a reason a later platform adds arrives as its raw
    string rather than failing the read, and a consumer that does not know it should not tell the
    person the run is fine.
    """

    STATUS_UNAVAILABLE = "status_unavailable"
    WORKFLOW_TASK_FAILING = "workflow_task_failing"


class RunDegradation(BaseModel):
    """What a `degraded` status read means for this run — `RunRead.degradation`.

    Branch on `reason` (see `DegradationReason`), never on the wording of `message`. Extension-open
    (`extra="allow"`), so a member a later platform adds rides `model_extra`. Read leniently, so it
    never fails the poll carrying it: `reason` must be a string, and a degradation without one reads as
    `None` as a whole (`LenientRunDegradation`), since it cannot be branched on; each other field that
    does not fit its type reads as `None` and the rest stands.
    """

    model_config = ConfigDict(extra="allow")

    #: Why the read is degraded: the `DegradationReason` member when this SDK knows the reason, its raw
    #: string otherwise.
    reason: Annotated[DegradationReason | str, Field(union_mode="left_to_right")]
    #: What the platform says about it, in a sentence. For `workflow_task_failing` it says how many
    #: attempts have failed in a row, that the run is not making progress and when the platform will
    #: end it. It does not quote the worker's own failure text, which only a platform run locally with
    #: `ERROR_DISCLOSURE=verbose` adds. `failed_attempts` and `ends_at` carry the same facts as fields.
    message: str | None = None
    #: How many times in a row the run's workflow task has failed; `None` for `status_unavailable`.
    #: Strictly an integer, as `@pipelex/sdk` reads it: a string or a boolean reads as `None`.
    failed_attempts: StrictInt | None = None
    #: ISO-8601 instant of the first failure in the current run of failures. `None` when the platform
    #: could not find the recorded failure in the workflow's history, and always for `status_unavailable`.
    failing_since: str | None = None
    #: ISO-8601 instant at which the platform ends the run `FAILED` if its workflow task is still
    #: failing. `None` when the platform could not find the recorded failure: it then does not end the
    #: run itself, and the run's own time limit ends it `TIMED_OUT`. Always `None` for
    #: `status_unavailable`.
    ends_at: str | None = None

    @field_validator("message", "failed_attempts", "failing_since", "ends_at", mode="wrap")
    @classmethod
    def _read_a_field_that_does_not_fit_as_none(cls, value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
        return none_when_it_does_not_fit(value, handler)


#: The type of `RunRead.degradation`: a degradation read field by field as `RunDegradation` says, and a
#: value that is not one at all — not an object, or without a string `reason` — read as `None`, so the
#: status read carrying it always answers.
LenientRunDegradation: TypeAlias = Annotated[RunDegradation | None, WrapValidator(none_when_it_does_not_fit)]


class RunRead(RunPublic):
    """A run read through the self-healing status path (`RunPublic` + `degraded`, `degradation`,
    `request_id` and the `Retry-After` hint).

    `degraded` is true when the read is not a plain fresh reading of a healthy run, and
    `degradation.reason` says which of two things holds (see `DegradationReason`): the platform could
    not reach the workflow engine and `status` is the last one recorded (`status_unavailable`, paired
    with `retry_after_seconds`), or `status` is live and the run is stuck, its workflow task failing
    until the platform ends it (`workflow_task_failing`). So `degraded` alone no longer means the run is
    fine. A platform older than the degradation sends `degraded` with no `degradation`; read that as
    `status_unavailable`, the only meaning `degraded` had then.
    """

    degraded: bool = False
    #: What `degraded` means for this run; `None` whenever `degraded` is false, and on a platform that
    #: predates it. Read leniently (`LenientRunDegradation`).
    degradation: LenientRunDegradation = None
    #: The id of the request that started the run — the one to quote to support. `None` for a run saved
    #: before the platform recorded it, and on a server that does not serve it.
    request_id: str | None = None
    #: The `Retry-After` header's delay, in seconds, lifted by the client when the platform sent one.
    retry_after_seconds: int | None = None


class TokensUsageRecord(BaseModel):
    """One inference call's token usage — the client-facing wire record.

    Mirrors the runtime's `TokensUsageRecord`. Inference accounting is a Pipelex runtime
    extension — the MTHDS Protocol does not model it — so the hosted API is what pins this
    wire contract. The same shape rides both surfaces: the durable `tokens_usages.json`
    artifact that the hosted results route relays, and the blocking execute response's
    `pipe_output.tokens_usages`.

    Every field is optional and the model is extension-open **on purpose**. A record the
    current runtime emits always carries the full key set (a field with no value is an
    explicit `null`, never an omitted key), so callers may read any field without an
    existence check. But durable artifacts written before the contract shipped are relayed
    verbatim and never migrated: such a record parses here with `cost` and `pipe_code` unset
    and keeps its legacy `job_metadata` / `unit_costs` in `model_extra`.

    The enum-ish fields are open sets on the wire and stay plain `str` here — never frozen
    enums — so runtime enum churn is non-breaking for consumers.
    """

    model_config = ConfigDict(extra="allow")

    #: Kind of inference. Known values: `llm`, `img_gen`, `extract`, `search`.
    model_type: str | None = None
    #: Human model name (e.g. `gpt-4o`).
    inference_model_name: str | None = None
    #: Provider/platform model id (e.g. `gpt-4o-2024-11-20`).
    inference_model_id: str | None = None
    #: The pipe that made the call — what makes per-pipe cost attribution possible.
    pipe_code: str | None = None
    #: Known values: `llm_job`, `img_gen_job`, `extract_job`, `search_job`, `jinja2_job`, `mock_job`.
    job_category: str | None = None
    #: Known values: `llm_gen_text`, `llm_gen_object`, `img_gen_text_to_image`, `extract_pages`,
    #: `search_sourced_answer`, `search_structured`.
    unit_job_id: str | None = None
    #: Raw provider-reported token counts, keyed by token category (`input`, `input_cached`,
    #: `output`, `output_reasoning`, …). `input` is the joined total and `input_cached` a subset
    #: of it — the categories are NOT additive, so summing them double-counts.
    nb_tokens_by_category: dict[str, int] | None = None
    #: Computed USD cost of this call. `None` when the model has no rate table at all (own-GPU,
    #: mock, dry run); `0` means a rate table existed and priced the call at zero. The underlying
    #: rate table never crosses the wire and there is no run-level aggregate — sum the records.
    #: Strict and finite: a string, a bool or a NaN on the wire fails the whole results body's
    #: parse rather than reaching a sum as a number.
    cost: float | None = Field(default=None, strict=True, allow_inf_nan=False)
    #: ISO 8601 start of the call.
    started_at: str | None = None
    #: ISO 8601 end of the call. Duration is derivable from the pair and deliberately not shipped.
    completed_at: str | None = None


class RunResults(BaseModel):
    """Result artifacts for a completed run — `GET /v1/runs/{pipeline_run_id}/results`.

    `main_stuff` is the resolved main output content, and a completed run read in full ALWAYS
    carries one (the pipelex >= 0.37 main-stuff invariant): on the hosted path it is the
    `main_stuff.json` S3 artifact relayed verbatim; on the bare-runner blocking path the SDK resolves
    it from the returned working memory via the run's `main_stuff_name`, so both paths deliver the
    same content shape. A completed run that cannot deliver a main stuff it was asked for raises
    `MissingMainStuffError`. Extension-open (`extra="allow"`): any other server artifact the SDK
    does not name is preserved on `model_extra` rather than dropped.

    Every field but `pipeline_run_id` is optional, and two readings of an optional field are
    distinct on purpose. A key the hosted body did not carry is not in `model_fields_set` and reads
    `None`; a key relayed as `null` is in the set and reads `None` too. With an artifact selection
    (`get_run_result(run_id, artifacts=[...])`) that is exactly "not requested" against "requested
    but never written": the platform leaves an unselected artifact out of the body and relays a
    selected-but-unwritten one as `null`. `carries(artifact)` asks the question by artifact rather
    than by field name. The blocking path always answers for every field, so each is set there.
    Every field is walked on `docs/run-results.md`.
    """

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: str
    #: The resolved main output content — never `None` on a completed run whose read asked for it (no
    #: selection, or one naming `RunArtifact.MAIN_STUFF`): the client raises `MissingMainStuffError`
    #: rather than hand back a result without it. Absent (not in `model_fields_set`, reading `None`)
    #: only when a selection left it out. Typed `Any` because the content is polymorphic (a
    #: structured output is an object of the concept's fields, a multiple output the
    #: `{"items": [...]}` envelope the runtime's `ListContent` serialises to, a native is wrapped
    #: too — `{"text": ...}`, `{"number": ...}`) and may be a valid empty value (an empty `items`,
    #: an empty `text`).
    main_stuff: Any = None
    #: The executed graph — the same document a local run writes as `graphspec.json`: `meta.mode`
    #: `"live"`, one node per pipe with its status, its timings and its own usage. It reaches the
    #: client on both paths: the hosted path relays the `graphspec.json` artifact verbatim, and on
    #: the blocking path the SDK lifts it off `pipe_output`. `None` when the runner assembled no
    #: graph (see `graph_assembly_error`) or, on the hosted path, when the artifact was not yet
    #: written. Typed `Any` on purpose — no published Python package declares the graph spec, so a
    #: type here could only be a copy that drifts.
    graph_spec: Any = None
    #: Non-`None` when the runner's graph assembly failed for the run — the graph's twin of
    #: `usage_assembly_error`, and the only thing that separates "the graph broke" from "this run
    #: produced no graph". Lifted off `pipe_output` on the blocking path; the hosted results body
    #: carries nothing of the kind yet, so on that path the key is absent (not in `model_fields_set`)
    #: until the platform writes and relays it.
    graph_assembly_error: str | None = None
    #: Per-pipe input/output contracts for the library the run executed against, keyed by namespaced
    #: `pipe_ref` (`domain.code`) — the standard's `PipeIOContracts`, the same artifact `POST
    #: /v1/validate` reports and the same one a local run writes beside its graph as
    #: `pipe_io_contracts.json`. Imported from `mthds.protocol` rather than restated, under the
    #: standing ruling that keeps the standard's artifacts declared once per language
    #: (`docs/architecture.md`). It is what says what a `graph_spec` node's data IS: the graph
    #: carries the values, this carries their concepts and their schemas. Read it together with
    #: `output_form` — a renderer takes the pair or neither. A closed shape: a member the pinned
    #: `mthds` does not define fails the parse of the whole results body, which the client raises as
    #: the `ApiResponseError` of an answer it cannot read (`docs/run-results.md` says what that costs on
    #: each path). The hosted results body relays it as its own key, so it is set on that path:
    #: `None` for a run whose artifact was not written.
    pipe_io_contracts: PipeIOContracts | None = None
    #: Per-pipe input-form descriptors for that same library — the standard's `InputForm`, keyed
    #: over the same `pipe_ref` set as `pipe_io_contracts`, describing each declared input as a
    #: typed field rather than a schema. It is what lets a rendered run show its own inputs as
    #: values; a renderer treats it as optional even when it has the other two. `None` on the same
    #: terms as `pipe_io_contracts`.
    input_form: InputForm | None = None
    #: Per-pipe OUTPUT-form descriptors for that same library — the standard's `OutputForm`, the twin
    #: of `input_form` on the other side of the pipe, keyed over the same `pipe_ref` set. The
    #: descriptor says what the result IS and the contract's `output.json_schema` names the property
    #: its payload arrives under, which together are everything a renderer needs to lay a run's
    #: result out without inspecting the value. `None` on the same terms as `pipe_io_contracts`.
    output_form: OutputForm | None = None
    #: Non-`None` when the runner's build of the three I/O artifacts failed for the run — their twin
    #: of `graph_assembly_error`, and the only thing that separates "describing the data broke" from
    #: "this run described none". Lifted off `pipe_output` on the blocking path; absent on the hosted
    #: path until the platform writes and relays it.
    pipe_io_artifacts_error: str | None = None
    #: The run's whole working memory — every named stuff it held when it finished, the inputs it was
    #: given and the intermediates it produced as well as the main output, as the standard's
    #: `DictWorkingMemoryAbstract` (`root` keyed by stuff name, `aliases` mapping a role such as
    #: `main_stuff` onto one of those names). It reaches the client on both paths: the hosted path
    #: relays the `working_memory.json` artifact as its own key, and on the blocking path the SDK
    #: lifts it off `pipe_output.working_memory`, which the standard declares as a required field —
    #: so it is always set there. `None` on the hosted path when the platform relayed `null` (the
    #: artifact was not written); absent from `model_fields_set`, and `None` too, when the body did
    #: not carry the key at all. Extension-open at every level, so a runner's per-stuff extras
    #: (`stuff_code`, `stuff_name`, …) ride `model_extra` rather than being dropped.
    working_memory: DictWorkingMemoryAbstract | None = None
    #: Bare runner's native pipe output — the full working memory, blocking-execute path only;
    #: `None` on the hosted path. Supplementary: `main_stuff`, the graph pair, the three I/O
    #: artifacts, the working memory and the usage pair are all lifted out of it onto fields that
    #: read the same on both paths; kept for consumers that want the runner's envelope exactly as it
    #: arrived, `pipeline_run_id` and all. Extension-open, so the Pipelex
    #: extension fields the runner rides on it stay reachable via `model_extra` in their **raw**
    #: form — the usage pair, the graph pair, the `pipe_io_artifacts` envelope. Read the lifted
    #: fields instead: same data, validated, and present on the hosted path too.
    pipe_output: DictPipeOutputAbstract | None = None
    #: Per-call usage records — token counts by category, computed `cost` in USD, model id — for
    #: LLM and img-gen/extract/search calls alike. On the hosted path this is the
    #: `tokens_usages.json` artifact's record list relayed verbatim; on the blocking path it is the
    #: execute response's `pipe_output.tokens_usages`. `None` whenever assembly produced no list —
    #: it was off, it broke (see `usage_assembly_error`), or (hosted) the run was delivered before
    #: the artifact existed; `[]` when assembly ran and no inference happened.
    tokens_usages: list[TokensUsageRecord] | None = None
    #: Non-`None` when the runner's usage assembly failed for the run. The ONLY field that
    #: separates "usage broke" from "usage was off" / "pre-artifact run" — all three leave
    #: `tokens_usages` as `None`, so a caller that cares must branch on this, not on the list.
    usage_assembly_error: str | None = None

    def carries(self, artifact: RunArtifact) -> bool:
        """Whether the results body carried `artifact` at all, whatever its value.

        `False` means the read did not ask for it (a selection that left it out), so its field reads
        `None` without saying anything about the run. `True` with a `None` value means the artifact
        was asked for and the platform relayed `null`: it was never written. Always `True` on the
        blocking path, which answers for every field.
        """
        return all(field_name in self.model_fields_set for field_name in artifact.results_fields)


# ── Single-shot result lookup outcome (discriminated on `state`) ─────


class RunResultRunning(BaseModel):
    """HTTP 202 — the run is in-flight; poll again after `retry_after_seconds`."""

    state: Literal["running"] = "running"
    pipeline_run_id: str
    retry_after_seconds: int | None = None


class RunResultCompleted(BaseModel):
    """HTTP 200 — the run is `COMPLETED`; `result` carries the artifacts."""

    state: Literal["completed"] = "completed"
    pipeline_run_id: str
    result: RunResults


class RunResultFailed(BaseModel):
    """HTTP 409 — the run reached a terminal non-`COMPLETED` status.

    Built from the platform's problem document: `message` is its `detail`, which names the status and
    then the report's own message (`Run finished with status FAILED: <message>`), `status` is its
    `run_status` member, and `error` is its `error` member, the run's stored report typed whole — the
    same object the status read serves as `RunRead.error`. `error` is `None` for a run that ended with
    no stored report.
    """

    state: Literal["failed"] = "failed"
    pipeline_run_id: str
    status: RunStatus
    message: str
    error: LenientRunErrorReport = None


RunResultState: TypeAlias = Annotated[
    RunResultRunning | RunResultCompleted | RunResultFailed,
    Field(discriminator="state"),
]


# ── Polling options ─────────────────────────────────────────────────


@dataclass(frozen=True)
class PollInfo:
    """Progress info handed to a `WaitForResultOptions.on_poll` callback before each sleep."""

    attempt: int
    elapsed_seconds: float


@dataclass
class WaitForResultOptions:
    """Tuning for `wait_for_result`'s poll loop.

    The client is async-native: cancellation is via `asyncio.CancelledError`
    (the Python analog of mthds-js's `AbortSignal`), so there is no `signal`
    field — cancel the awaiting task instead.
    """

    interval_seconds: float = 2.0
    timeout_seconds: float = 1200.0
    on_poll: Callable[[PollInfo], None] | None = None
