"""Pipelex's `POST /v1/validate` 200-diagnostic union, the hosted twin of the MTHDS one.

The MTHDS Protocol layer (`mthds.protocol.models`) declares the brand-neutral verdict
shapes: `ValidationReport` (`is_valid: true`), `InvalidValidationReport` (`is_valid: false`),
and the `ValidationResult` discriminated union, whose faults and warnings are the standard's
`ProblemItem`s under registered codes. The hosted plane answers `validate` with the same items, the
faults in `errors[]` and the advisory findings in `warnings[]`, and with members of its own beside them:
the valid arm carries the runtime's structural artifacts. So the two arms here stand alone rather than
narrowing the standard's, and type their items as the standard's `ProblemItem`, read member by member
(`pipelex_sdk.problem_items.ProblemItems`), so that one malformed member never fails the verdict.

These shapes are **Pipelex-branded implementation envelopes**, so they live here in
`pipelex-sdk`, not in the brand-neutral `mthds` package — mirroring `pipelex-sdk-js/src/models.ts`
and the documented brand boundary (`docs/architecture.md` → "Brand boundary"). The report/union
types carry the `Pipelex` prefix; the supporting types (`DryRunStatus`, `ValidatedPipeEntry`,
`LiftablePipeEntry`, `TreeFileRead`, `TreeFileUse`) stay neutrally named — branding the envelope,
not the field names inside it. The items, their suggested fixes and their fix operations are the
standard's own (`ProblemItem`, `SuggestedFix`, `FixOp` in `mthds.protocol.problem.models`).

Two members of the valid arm are deliberately **not** Pipelex's to declare. `pipe_io_contracts`
and `input_form` are the standard's own recommended extension fields of the validate report, each
with a normative page and a client model since `mthds` v0.9.0, so they are narrowed here **by
import** — `PipeIOContracts` from `mthds.protocol.pipe_io_contracts`, `InputForm` from
`mthds.protocol.input_form`. That keeps the "this SDK is transport, it does not own these types"
principle intact while the payloads stop being opaque: there is one declaration per language, and
an import cannot drift from it the way a restatement could. The types are used, never re-exported —
a consumer that wants to name a node's type (`ListField`, `PresenceMarker`, …) imports it from
`mthds.protocol` directly, where it belongs. `bundle_blueprint` and `graph_spec` stay opaque for
the reason that used to cover all four: no published package declares them, so a type here could
only be a copy.

Strictness composes rather than spreads. The imported artifacts are **closed** shapes
(`extra="forbid"`) — a member this `mthds` version does not define is version drift, refused at the
parse — while the report envelope around them stays extension-open (`extra="allow"`), so an
unrelated field a future server adds to the report still parses and still rides `model_extra`.

`PipelexAPIClient.validate()` returns this `PipelexValidationResult` (parsed via
`PipelexValidationResultAdapter`); the protocol base `MthdsAPIClient.validate()` returns the
neutral `mthds` `ValidationResult`.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Final, Literal, TypeAlias

from mthds.protocol.input_form import InputForm
from mthds.protocol.output_form import OutputForm
from mthds.protocol.pipe_io_contracts import PipeIOContracts
from mthds.protocol.problem.models import ProblemItem
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from pipelex_sdk._pydantic_utils import empty_list_factory_of
from pipelex_sdk.problem_items import ProblemItems

VALIDATION_VIEW_INPUT_FORM: Final[str] = "input_form"
"""A `views` token — asks for `PipelexValidationReport.input_form`.

Deliberately a constant rather than a closed enum: the request boundary is open, the server
resolves the tokens as a set and lenient-ignores the ones it does not know (never a `422`), so
a stale token must never fail a call.
"""

VALIDATION_VIEW_OUTPUT_FORM: Final[str] = "output_form"
"""A `views` token — asks for `PipelexValidationReport.output_form`.

The twin of the above on the other side of the pipe. Named as a constant for the same reason:
a caller passing the literal string gets no help from a type checker when the token changes."""


class DryRunStatus(StrEnum):
    """Per-pipe dry-run sweep outcome on `ValidatedPipeEntry.status`."""

    SUCCESS = "SUCCESS"
    FAILURE = "FAILURE"
    SKIPPED = "SKIPPED"


class LiftablePipeEntry(BaseModel):
    """One pipe the runtime may skip (lift) when an optional slot resolves absent."""

    model_config = ConfigDict(extra="allow")

    pipe_ref: str
    """Namespaced ref of the liftable pipe."""

    within_pipe_ref: str
    """Namespaced ref of the controller in whose flow the lift happens."""

    skipped_when_absent: list[str] = Field(default_factory=list)
    """The slot names whose absence lifts the pipe."""

    absence_source: str
    """Where the possible absence originates (human-readable)."""


class TreeFileUse(StrEnum):
    """What a step reads a file of its method tree as, mirroring pipelex's `TreeFileUse`.

    A report reads it open on `TreeFileRead.use`: a runner of a later version may add a use as another
    kind of step comes to read files of its tree, and a use this SDK does not know keeps its raw string
    rather than failing the whole verdict.
    """

    TEMPLATE = "template"
    """The template a `PipeDocGen` step fills, named by its `template_file`."""

    TEMPLATE_ASSET = "template_asset"
    """An image, a stylesheet or a font that a `PipeDocGen` step's HTML template names by a literal
    relative URL, or that one of its stylesheets names."""

    PYTHON_MODULE = "python_module"
    """The module defining the function a `PipeFunc` step calls, named by the import path of its
    `function_name`."""


class TreeFileRead(BaseModel):
    """One file of its method tree a step reads, an entry of `PipelexValidationReport.tree_files_read`.

    A reader model, extension-open like the report's other entries, where the runtime declares its own
    copy closed.
    """

    model_config = ConfigDict(extra="allow")

    tree_path: str
    """The file's path from the root of the method's tree, with forward slashes, such as
    `templates/invoice.html`, never a path on the server. A file sent in `resources` is named by its
    key, its `.` segments and repeated slashes collapsed as the runner collapses them."""

    use: Annotated[TreeFileUse | str, Field(union_mode="left_to_right")]
    """What the step reads the file as: a `TreeFileUse` member, or the raw string of a use this SDK
    does not know, so a `match` on it says what an unknown use does."""


class ValidatedPipeEntry(BaseModel):
    """One entry of `PipelexValidationReport.validated_pipes[]`."""

    model_config = ConfigDict(extra="allow")

    pipe_ref: str
    status: DryRunStatus


class PipelexValidationReport(BaseModel):
    """The valid arm with pipelex's structural artifacts (`is_valid: true`).

    Extension-open: a member a later server adds rides `model_extra`.
    """

    model_config = ConfigDict(extra="allow")

    is_valid: Literal[True] = True
    bundle_blueprint: dict[str, Any] = Field(default_factory=dict)
    """The parsed bundle, carried opaquely: no published package declares its shape, so a type
    here could only be a copy free to drift from the runtime that emits it."""

    default_pipe_ref: str | None = None
    """The qualified `pipe_ref` a selector-less run would execute, or `None` when the closure
    declares no `main_pipe` (or a fetched manifest's `main_pipe` resolves to no pipe).

    Manifest-aware for a fetched package, which is what makes it outrank a `bundle_blueprint` read:
    a published package may name its entry pipe in `METHODS.toml` alone, and the blueprint never
    carries a manifest. Optional and read leniently — a runner that predates the field simply sends
    nothing. It is the run default, and not `pipe_io`'s field of the same name, which states `None`
    where several domains declare a `main_pipe` rather than naming the first."""

    pipe_io_contracts: PipeIOContracts = Field(default_factory=dict)
    """The per-pipe I/O contracts, typed by importing the standard's own client models.

    `PipeIOContracts` is `dict[pipe_ref, PipeIOContract]` (`mthds.protocol.pipe_io_contracts`), so a
    declared input slot reads as typed members — `concept_ref`, a three-valued `presence`
    (`PresenceMarker`), a `multiplicity` (`IOMultiplicity`), the `item_count` that is non-null exactly
    on the fixed arm, and its `json_schema` — and the output side reads its own asymmetric shape
    (a two-valued `optional`, because `!` is rejected on an output). Its `json_schema` is required
    too since `mthds` 0.13.0, but states the concept's CONTENT MODEL rather than a caller's
    argument: where a plural input's schema is a bare array, a plural output's is that model's list
    envelope. The artifact belongs to the standard, so it is imported rather than restated: one
    declaration per language is what makes drift impossible, which is precisely what keeping it
    opaque used to buy.

    Contracts are **closed** shapes: a member this `mthds` version does not define is version drift
    and fails the parse. That closure is scoped to the artifact — the report around it stays
    extension-open — and it is the reason a contract from a runner predating the presence/multiplicity
    reshape no longer parses.

    Defaults to an empty map rather than `None`: the Pipelex valid arm always states the artifact, so
    no caller has to test for its absence."""

    graph_spec: Any = None
    """The execution graph, carried opaquely for the same reason as `bundle_blueprint`."""

    validated_pipes: list[ValidatedPipeEntry] = Field(default_factory=empty_list_factory_of(ValidatedPipeEntry))
    pending_signatures: list[str] = Field(default_factory=list)
    is_runnable: bool = True
    message: str = ""
    mthds_contents: list[str] | None = None
    warnings: ProblemItems = Field(default_factory=empty_list_factory_of(ProblemItem))
    """Advisory findings on a bundle that is nonetheless valid — they never flip `is_valid` — one problem
    item each with the code its finding's type names.

    Same item type as the invalid arm's `errors[]`, so one reader serves both, member by member. Defaults
    empty rather than being required, so a body from a runner predating the field still parses; that
    default is also what a clean bundle yields, so no caller can tell the two apart."""

    liftable_pipes: list[LiftablePipeEntry] = Field(default_factory=empty_list_factory_of(LiftablePipeEntry))
    """The pipes the runtime may skip when an optional slot resolves absent.

    Defaults empty for the same reason as `warnings`: an older runner's body must keep parsing."""

    tree_files_read: dict[str, list[TreeFileRead]] = Field(default_factory=dict)
    """Per step, the files of the method's tree it reads, keyed by namespaced `pipe_ref` over the same
    set as `pipe_io_contracts`, each file by its tree path with what the step reads it as.

    A `PipeDocGen` step reads its template and the images, stylesheets and fonts its HTML template
    names by literal relative URLs; a `PipeFunc` step reads the module of its function when that module
    is a file of the tree. A step that reads no file of the tree, a controller included, has an empty
    list. The paths come from what each step already names, so a client can show which step uses a file
    without parsing the method.

    Defaults to an empty map so a body from a runner predating the field still parses. Unlike the
    lists' defaults, the empty map is not what a current runner says of a method with pipes, since it
    lists every pipe it validated; a caller that must tell an older runner apart checks
    `"tree_files_read" in report.model_fields_set`."""

    tree_file_readers: dict[str, list[str]] = Field(default_factory=dict)
    """The per-file view of `tree_files_read`: each tree path a step reads, in sorted order, to the
    namespaced refs of the steps that read it, each listed once.

    A file of the tree with no entry is read by no step: the bundles themselves, a README, a package's
    `__init__.py` beside its modules. Defaults empty for the same reason as `tree_files_read`."""

    input_form: InputForm | None = None
    """Per-pipe input-form descriptors, keyed exactly like `pipe_io_contracts`, typed by importing
    the standard's own client models.

    `InputForm` is `dict[pipe_ref, PipeInputFormDescriptor]` (`mthds.protocol.input_form`), whose
    `fields` are the recursive `InputFormField` union discriminated on `kind`: narrow a node with
    `match node: case ListField(): ...` or an `isinstance` check, importing the per-kind models from
    `mthds.protocol.input_form`. Imported rather than restated, for the same reason as the contracts,
    and closed the same way.

    The recursion changes layer, and a consumer narrowing it has to follow. Since `mthds` v0.10.0 the
    union is split in two by whether the node names itself: a top-level field is the **named** union
    (`TextField`, `DocumentField`, …, each requiring `name: str`), while a `ListField.item` is the
    **nameless** counterpart (`TextItem`, `DocumentItem`, …), which refuses a `name` at the parse. So
    a list's item narrows to `DocumentItem`, never `DocumentField` — and since each `*Field` derives
    from its `*Item`, only the item layer is a safe narrowing target at that position.

    Optional on purpose: it is present only when the request named the `input_form` view
    (`VALIDATION_VIEW_INPUT_FORM`), and an older runner emitted it unconditionally — `None` by
    default is the one typing that reads a body from either runner correctly."""

    output_form: OutputForm | None = None
    """Opt-in structured view: the per-pipe output-form descriptors, the twin of `input_form` on
    the other side of the pipe, requested through `views: ["output_form"]`.

    One `field` rather than a list of them, and no `presence` or `gating` — those are facts of a
    slot a caller fills, and a result is not one. Read together with that pipe's
    `output.json_schema` off `pipe_io_contracts`: the descriptor says what the result IS, the
    schema names the property its payload arrives under, and a consumer holding one but not the
    other is back to inferring the other from the value."""

    rendered_markdown: str | None = None
    """Opt-in Pipelex-API presentation extra: the server-rendered Markdown view of the verdict,
    present only when the request asked for it (`render: ["markdown"]`); absent (None) otherwise."""


class PipelexInvalidReport(BaseModel):
    """The invalid arm listing its faults as problem items (`is_valid: false`).

    It carries one problem item per fault (`errors[]`, non-empty on every invalid verdict the server sends,
    read member by member, so an item whose `code` or `detail` is not a string is skipped and a malformed
    member is left out of its item), best-effort `pending_signatures`, `is_runnable: false` and a
    human-readable `message`. It gains
    none of the valid arm's additions: `warnings` and `input_form` derive from a crate that was
    never assembled, so the invalid arm never carries them. Extension-open: a member a later server
    adds rides `model_extra`.
    """

    model_config = ConfigDict(extra="allow")

    is_valid: Literal[False] = False
    errors: ProblemItems = Field(default_factory=empty_list_factory_of(ProblemItem))
    """One problem item per fault, each with its own `code`, `detail`, `params`, `location` and, when the
    server has one, its `suggested_fix`. A list that is absent or is no list reads as none, as `@pipelex/sdk`
    reads it."""

    pending_signatures: list[str] = Field(default_factory=list)
    is_runnable: Literal[False] = False
    message: str

    rendered_markdown: str | None = None
    """Opt-in Pipelex-API presentation extra: the server-rendered Markdown view of the invalid
    verdict, present only when the request asked for it (`render: ["markdown"]`); absent otherwise."""


PipelexValidationResult: TypeAlias = Annotated[
    PipelexValidationReport | PipelexInvalidReport,
    Field(discriminator="is_valid"),
]
"""Pipelex's `POST /v1/validate` 200 response — discriminated on `is_valid`."""


PipelexValidationResultAdapter: TypeAdapter[PipelexValidationResult] = TypeAdapter(PipelexValidationResult)  # pylint: disable=invalid-name
"""The single parse path for a 200 `/validate` body — built once at import (TypeAdapter construction is expensive).

Routes on the `is_valid` discriminant: a present `True` → `PipelexValidationReport`, a present
`False` → `PipelexInvalidReport`. A body missing/with-a-bad `is_valid` cannot be tagged and raises
`pydantic.ValidationError`, so a malformed 200 can never be mistaken for a valid verdict.
"""
