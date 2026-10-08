"""Pipelex-product wire models — the snake_case JSON shapes the hosted-product routes speak.

These mirror `pipelex-sdk-js/src/product-models.ts`. They are the management surface
the hosted product (`/v1/me`, `/v1/methods`, `/v1/organizations`, `/v1/billing/*`,
`/v1/pipelex-api-keys`, `/v1/onboarding/submit`,
`/v1/resolve-storage-url`, `/v1/upload`, `/v1/runs`) drives.

The wire is snake_case. Each model holds only the fields the product actually
consumes — not a speculative mirror of every server field. Response models are
extension-open (`extra="allow"`): an unknown server field is preserved, not
rejected — the SDK never has to ship just to read a newly-added field. Input
models name exactly what the routes accept.

These are Pipelex-branded (the hosted product surface), so they live in this SDK,
not in `mthds`. `RunHistoryItem.status` and `PipelineRun.status` reuse the run-lifecycle `RunStatus`.

A saved method has a draft and published versions. The method's content fields (`mthds`,
`python`, `input_data`) are its DRAFT, written freely by `write_draft` and never validated on
write. A VERSION is an immutable copy of the draft, numbered from 1 and never reused, written
only by `publish_method` and only when the draft validates and runs. A bare `method_id` runs
the latest published version, `mt_…@<n>` a fixed version and `mt_…@draft` the draft; the
method routes themselves take a bare id (`pipelex_sdk.method_selector.parse_method_selector`
strips a suffix).
"""

from __future__ import annotations

import json
from enum import StrEnum
from typing import Annotated, Any, Literal, TypeAlias, cast

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, field_serializer, field_validator

from pipelex_sdk._pydantic_utils import empty_list_factory_of
from pipelex_sdk.error_models import LenientRunErrorReport
from pipelex_sdk.runs import RunStatus
from pipelex_sdk.validation_models import PipelexValidationResult

# ── User profile (`/v1/me`) ─────────────────────────────────────────────


class UserProfile(BaseModel):
    """The authenticated user's profile — `GET /v1/me`."""

    model_config = ConfigDict(extra="allow")

    email: str
    user_id: str
    full_name: str
    #: ISO timestamp the user completed onboarding; absent/None until they do.
    onboarding_completed_at: str | None = None


# ── Methods catalog (`/v1/methods`) ──────────────────────────────────────


class MethodDeletionState(StrEnum):
    """Where a method is in the erasure cascade; absent on a normal method."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    FAILED = "failed"


class MethodFile(BaseModel):
    """One named source file of a stored method — the at-rest catalog form.

    This is the shape the hosted platform persists for a method's custom PipeFunc Python:
    a JSON `[{name, content}]` array in one wire string. It is deliberately distinct from
    two neighbours that look similar and are not: `MthdsFile` (`client.py`) is the *validate*
    input, content plus an optional provenance URI; `MthdsFileItem` (`crate_models.py`) is
    the *crate* closure entry. Three shapes for three surfaces — do not merge them.
    """

    model_config = ConfigDict(extra="allow")

    #: Bundle-relative path, e.g. `"funcs/price.py"`.
    name: str
    #: The file's UTF-8 text content.
    content: str


_METHOD_FILES_ADAPTER: TypeAdapter[list[MethodFile]] = TypeAdapter(list[MethodFile])
"""Built once at import — TypeAdapter construction is expensive."""

_METHOD_FILES_SHAPE = "a JSON array of {name, content} entries"


def _is_blank(content: str) -> bool:
    """A file carries no source when its content is empty or whitespace-only."""
    return not content.strip()


def _decode_method_source(source: str) -> Any:
    """Decode a stored source string, with every way the decoder can refuse one as a `ValueError`.

    The two readers of a stored source apply different shape rules to what comes back — see
    `method_source_to_contents` for why — but they must fail identically on text the decoder
    cannot take at all, so that rule lives here and in one place. `json.loads` refuses in two
    ways: `JSONDecodeError` for malformed text, and `RecursionError` — which is NOT a
    `ValueError` — for a source nested past a depth that is an interpreter build constant,
    because `json.loads` recurses where `JSON.parse` iterates. Converting both gives each
    caller the failure its own contract promises: `MethodData`'s validator turns this
    `ValueError` into the `ValidationError` a caller catches (pydantic converts only
    `ValueError`), and `method_source_to_contents` reads it as "not the catalog form".
    """
    try:
        return json.loads(source)
    except json.JSONDecodeError as exc:
        msg = f"Method file source is not valid JSON; expected {_METHOD_FILES_SHAPE}."
        raise ValueError(msg) from exc
    except RecursionError as exc:
        msg = f"Method file source is nested too deeply to decode; expected {_METHOD_FILES_SHAPE}."
        raise ValueError(msg) from exc


def _is_catalog_entry(entry: object) -> bool:
    """The catalog gate the platform and `@pipelex/sdk` both apply: an object carrying both keys.

    Key presence alone, with no check on either value's type — mirroring
    `pipelex_platform.services.method_resolution.method_source_to_contents` and
    `@pipelex/sdk`'s `isFileEntry`. Each entry's value types are filtered afterwards, per entry.
    """
    return isinstance(entry, dict) and "name" in entry and "content" in entry


def parse_method_files(source: str | None) -> list[MethodFile]:
    """Parse the catalog wire string into method files.

    A blank source (`None`, `""`, whitespace) and an empty JSON array both yield `[]`.
    A JSON `[{name, content}]` array yields those files, with blank-content entries
    dropped so the round-trip with `serialize_method_files` is stable.

    Raises:
        ValueError: For anything else — a non-array JSON value, an entry that is not a
            `{name: str, content: str}` object, unparseable text, or a source nested more
            deeply than the decoder can descend. Reached through `MethodData`'s validator,
            this surfaces as a `pydantic.ValidationError`, the same way any other malformed
            response body fails here.
    """
    if source is None or _is_blank(source):
        return []

    parsed = _decode_method_source(source)

    try:
        files = _METHOD_FILES_ADAPTER.validate_python(parsed)
    except ValidationError as exc:
        msg = f"Method file source must be {_METHOD_FILES_SHAPE}."
        raise ValueError(msg) from exc

    return [file for file in files if not _is_blank(file.content)]


def serialize_method_files(files: list[MethodFile]) -> str:
    """Serialize method files to the catalog wire string.

    Blank-content entries are dropped (a zero-source file is not persisted), and an empty
    result serializes to `""` — the platform's "no source" / "clear the field" sentinel —
    never to the literal `"[]"`. Only `name` and `content` cross the wire; anything an
    extension-open `MethodFile` picked up on the way in is not written back.
    """
    kept = [file for file in files if not _is_blank(file.content)]
    if not kept:
        return ""
    return json.dumps([{"name": file.name, "content": file.content} for file in kept])


def method_source_to_contents(mthds: str | None) -> list[str]:
    """Read a stored method's polymorphic `mthds` source as the bundle contents a call takes.

    `MethodData.mthds` is polymorphic at rest. The webapp editor writes the catalog
    file-array — the JSON `[{name, content}]` string the gate below recognizes — while a
    row written before that editor, or by hand, holds the `.mthds` source itself as plain
    text. A caller holding one of those strings cannot tell which it has, so this resolves
    it to the `list[str]` that `run`, `start` and `validate` take as `mthds_contents`.

    An empty list means the method carries no MTHDS source — a row that exists but is not
    runnable yet. It is never a failure to read one: this function does not raise.

    **The catalog gate is key presence, and each entry's types are filtered afterwards.** An
    array is the catalog form when every entry is an object carrying both a `name` and a
    `content` key, whatever those values hold; an entry whose `content` is not a non-blank
    string is then dropped and its siblings are kept. So
    `[{"name": "a", "content": "x"}, {"name": "b", "content": 1}]` reads as `["x"]`.

    That rule is not this SDK's preference — it reproduces, deliberately and character for
    character, what the server does with the same stored row: the platform's own
    `method_source_to_contents` (`pipelex_platform/services/method_resolution.py`, the resolver
    that expands a `method_id` run) and `@pipelex/sdk`'s `methodSourceToContents`. A client-side
    reader of a server-stored field exists so a caller can do locally what the platform does
    with that row, and a reader that disagrees with the code which actually runs the method is a
    reader that lies, however defensible its own rule. One stored method therefore has one
    observable reading across `method_id`, `@pipelex/sdk` and this SDK. This was ruled against a
    stricter reading that took a partly malformed array as a bundle; `docs/architecture.md` carries
    the ruling and the three readers it compares.

    The cost of the ruled rule is real and is not this function's to fix: a file whose `content`
    is not a string vanishes from the bundle without a word. That is a property of the format's
    decoder, shared by all three readers, so it is fixed once in the platform rather than three
    times in its clients.

    This is consequently NOT a pure delegation to `parse_method_files`. That function reads
    `MethodData.python`, whose entries are a typed `[{name: str, content: str}]` catalog with no
    second at-rest shape to tell apart, so it stays strict and rejects what this accepts. The two
    share what must not drift — the decoder (`_decode_method_source`) and blankness
    (`_is_blank`) — and nothing else.

    Lesser divergences from the JS twin follow from the decoder rather than from this function,
    and they flip in both directions: `json.loads` accepts `NaN` and `Infinity`, which
    `JSON.parse` refuses, and refuses an integer literal past CPython's digit cap, which
    `JSON.parse` accepts; blankness here is Python's `str.strip`, not ECMAScript's, so the two
    disagree on a source of only U+FEFF and on one of only U+0085. `mthds.protocol.method_files`
    closes all of these and is the adoption target once its exception base class is settled.

    Args:
        mthds: The stored source, as `MethodData.mthds` carries it. `None` is tolerated
            although the model types it `str`, so a contract-violating response body reads
            as "no source" rather than raising — the twin's own defensive guard.

    Returns:
        One content string per bundle file: the non-blank string contents of the catalog
        file-array, or the whole source as a single bundle when it is not that form.
    """
    if mthds is None or _is_blank(mthds):
        # A blank source is no source, not a bundle of whitespace — and `None` although the
        # model types the field `str`, the twin's own defensive guard. `_is_blank` is the
        # parser's predicate rather than a second one, so the two readings of one stored
        # source cannot drift apart on what blank means.
        return []

    try:
        parsed: Any = _decode_method_source(mthds)
    except ValueError:
        # Text the decoder cannot take — not JSON at all, or nested past what it can descend —
        # so the whole source is one legacy bare bundle. A `.mthds` file may legally open with a
        # digit or a brace, which is why a decode failure is a bundle rather than an error.
        return [mthds]

    if isinstance(parsed, list) and all(_is_catalog_entry(entry) for entry in cast("list[Any]", parsed)):
        # Vacuously true for `[]`, which is the webapp editor's "no files" sentinel and yields
        # no contents — read as a bundle it would send the two characters `[]` to the runner.
        entries = cast("list[dict[str, Any]]", parsed)
        contents: list[str] = []
        for entry in entries:
            content: Any = entry["content"]
            if isinstance(content, str) and not _is_blank(content):
                contents.append(content)
        return contents

    return [mthds]


def _python_files_from_wire(value: object) -> object:
    """Convert the catalog wire string of a `python` field into `MethodFile` entries.

    A `str` or `None` is the wire form and goes through `parse_method_files`; anything else (a
    list, from programmatic construction) passes through to normal validation.
    """
    if value is None or isinstance(value, str):
        return parse_method_files(value)
    return value


class MethodVersionSummary(BaseModel):
    """One published version without its sources.

    What `list_method_versions` lists, what a method read carries as `latest_published`, and
    what a publish answers as `version`.
    """

    model_config = ConfigDict(extra="allow")

    version: int
    """The version number, from 1, never reused and never renumbered."""

    source_digest: str
    """SHA-256 of the canonical form of the version's two file sets (`.mthds` and Python), as 64
    lowercase hex characters — the same function as the method's `draft_digest`, so equal digests
    mean the same sources would run."""

    crate_fingerprint: str | None = None
    """The runner's `crate.fingerprint` for the bundle (`POST /v1/resolve`), which covers its
    meaning rather than its bytes. `None` when the runner validated the bundle but could not
    resolve it in memory, as for a bundle that depends on another method by address."""

    runner_version: str | None = None
    """The version of the runner that validated the bundle and computed the fingerprint."""

    description: str | None = None
    """The bundle's top-level `description` at publish time."""

    published_at: str
    """ISO-8601 UTC instant of the publish."""

    published_by: str
    """The publisher's canonical user id, or `system:publish-initial` for a version the one-time
    migration wrote for a method saved before versions existed."""


class MethodVersion(MethodVersionSummary):
    """One published version with its sources — `get_method_version`.

    It carries no `name`, which belongs to the method and changes without a publish, and no
    `input_data`, which is the editor's form state and not part of what a caller runs.
    """

    method_id: str
    mthds: str
    """The version's `.mthds` source, in the same stored form as `MethodData.mthds`; read it with
    `method_source_to_contents`."""

    python: list[MethodFile] = Field(default_factory=empty_list_factory_of(MethodFile))
    """The version's custom PipeFunc source files, converted from the wire string exactly as
    `MethodData.python` is."""

    @field_validator("python", mode="before")
    @classmethod
    def _parse_python_files(cls, value: object) -> object:
        """Convert the catalog wire string into `MethodFile` entries."""
        return _python_files_from_wire(value)


class MethodVersionPage(BaseModel):
    """One page of a method's published versions, newest first, without their sources — `{items, next_cursor}`.

    Same opaque-cursor contract as `MethodPage`: pass `next_cursor` straight back, and a `None`
    means the last page. Versions are read whole on the server, so a page may be short while
    `next_cursor` is set. A method never published answers an empty page.
    """

    model_config = ConfigDict(extra="allow")

    items: list[MethodVersionSummary]
    next_cursor: str | None = None


class MethodData(BaseModel):
    """One saved method — `get_method`, `create_method`, `write_draft`, `rename_method`, and the
    `method` of every publish outcome.

    Its content fields ARE the draft; the latest published version is summarized in
    `latest_published`. The publish state a client shows is derived, never stored: never
    published (`latest_version` is `None`), published with the draft unchanged (`draft_digest ==
    latest_published.source_digest`), or published with the draft ahead (they differ).
    """

    model_config = ConfigDict(extra="allow")

    method_id: str
    name: str
    #: The draft's `.mthds` bundle source, polymorphic at rest and left exactly as the platform
    #: stored it: the catalog `[{name, content}]` array the webapp editor writes, or a bare bundle
    #: as plain text. Read it with `method_source_to_contents`, which resolves either shape to the
    #: `mthds_contents` a run or a validate takes exactly as the platform's own resolver reads the
    #: same row; unlike `python`, it is not converted here.
    mthds: str
    org_id: str
    created_by_user_id: str
    description: str | None = None
    deletion_state: MethodDeletionState | None = None
    #: The editor's form inputs, saved with the draft and outside both digests.
    input_data: dict[str, Any] | None = None
    #: Legacy persisted output spec; optional.
    pipe_output: dict[str, Any] | None = None
    python: list[MethodFile] = Field(default_factory=empty_list_factory_of(MethodFile))
    """The draft's custom PipeFunc source files.

    On the wire this is one string — the JSON text of a `[{name, content}]` array, or `""`
    for a method with no custom Python. The validator below converts at the boundary so
    callers never see that string."""

    created_at: str
    updated_at: str
    """**The draft's token.** It moves on every draft write and on nothing else: creation sets it,
    and neither a rename nor a publish moves it. Echo it verbatim — the platform compares the
    strings — as `expected_updated_at` on the next `write_draft`, or as `expected_draft_updated_at`
    on `publish_method`, so neither ever overwrites or publishes a draft the caller has not seen."""

    draft_digest: str
    """The draft's digest: SHA-256 of the canonical form of its two file sets, 64 lowercase hex
    characters. `input_data` is outside it, so saving only the form inputs moves the token and
    leaves the digest as it was."""

    latest_version: int | None = None
    """The number of the latest published version; `None` when the method was never published."""

    latest_published: MethodVersionSummary | None = None
    """The latest published version's summary; `None` when the method was never published."""

    @field_validator("python", mode="before")
    @classmethod
    def _parse_python_files(cls, value: object) -> object:
        """Convert the catalog wire string into `MethodFile` entries."""
        return _python_files_from_wire(value)


class MethodWriteInput(BaseModel):
    """The create payload — `create_method`.

    A new method holds this as its draft and has no version yet. Its draft is then written with
    `write_draft` (`MethodDraftInput`) and its name changed with `rename_method`.
    """

    name: str
    mthds: str
    input_data: dict[str, Any] | None = None
    python: list[MethodFile] | None = None
    """The custom PipeFunc source files, serialized to the catalog wire string; `None` or an
    empty list, the method has none."""

    @field_serializer("python")
    def _serialize_python_files(self, value: list[MethodFile] | None) -> str | None:
        """Render the file list as the catalog wire string, leaving `None` for `exclude_none`."""
        if value is None:
            return None
        return serialize_method_files(value)


class MethodDraftInput(BaseModel):
    """The draft write — `write_draft`, `PUT /v1/methods/{id}/draft`.

    It never validates: a draft may be invalid, and an autosave of work in progress often is. The
    body is the fields the caller SET (`model_dump(exclude_unset=True)`), which is what gives each
    optional field its three-way meaning: a field left unset is not sent.
    """

    mthds: str
    """The draft's `.mthds` files, in the stored serialized form. Required."""

    python: list[MethodFile] | None = None
    """The custom PipeFunc source files. Left unset (or `None`), the stored Python is **kept**; an
    empty list serializes to `""`, the platform's clear sentinel, which **erases** it; a non-empty
    list **replaces** it. A replace, not a merge."""

    input_data: dict[str, Any] | None = None
    """The editor's form inputs. Left unset, the stored inputs are **kept**; set to `None`, they
    are **cleared**; any other value **replaces** them."""

    expected_updated_at: str | None = None
    """The draft token the caller last saw — the `updated_at` of the method it last read or wrote,
    echoed verbatim. With it the write is a compare-and-swap: a draft that moved since is refused
    with a `409` whose `code` is `method_update_conflict`, and nothing is written. Unset or `None`,
    the write is last-writer-wins."""

    @field_serializer("python")
    def _serialize_python_files(self, value: list[MethodFile] | None) -> str | None:
        """Render the file list as the catalog wire string; `None` stays `None`, which the platform reads as "keep"."""
        if value is None:
            return None
        return serialize_method_files(value)


class MethodPublishOutcome(StrEnum):
    """What a publish did with the draft — the discriminant of `MethodPublishResult`."""

    PUBLISHED = "published"
    UNCHANGED = "unchanged"
    REFUSED = "refused"


class MethodPublishRefusalReason(StrEnum):
    """Why a draft was not published."""

    INVALID = "invalid"
    """The draft does not validate."""

    NOT_RUNNABLE = "not_runnable"
    """The draft validates with pending signatures: valid, but it does not run yet."""


class MethodPublished(BaseModel):
    """A publish that wrote a new version; `version` is its summary."""

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodPublishOutcome.PUBLISHED]
    version: MethodVersionSummary
    method: MethodData


class MethodPublishUnchanged(BaseModel):
    """A publish with nothing to publish: the draft's digest equals the latest version's, so no runner was asked.

    `version` is that existing latest version. Also the answer to the loser of two concurrent
    publishes of the same draft.
    """

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodPublishOutcome.UNCHANGED]
    version: MethodVersionSummary
    method: MethodData


class MethodPublishRefused(BaseModel):
    """A publish the draft's content refused: nothing was published.

    `message` says why — for `not_runnable`, that the draft "is valid but does not run yet" — and
    `validation` is the runner's `POST /v1/validate` answer for the draft, verbatim: an invalid
    arm whose `validation_errors` say what to fix, or, for `not_runnable`, the valid arm.
    """

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodPublishOutcome.REFUSED]
    reason: MethodPublishRefusalReason
    message: str
    validation: PipelexValidationResult
    method: MethodData


MethodPublishResult: TypeAlias = Annotated[
    MethodPublished | MethodPublishUnchanged | MethodPublishRefused,
    Field(discriminator="outcome"),
]
"""The answer of `publish_method`, a `200` discriminated on `outcome`, because each arm is a verdict
about the draft's content. Branch on `outcome` (`match result:` over the three classes), never on
the status: a stale token, a method being deleted, a draft with no `.mthds` file or an unreachable
runner raise `ApiResponseError` instead, since they produce no verdict about the content."""

MethodPublishResultAdapter: TypeAdapter[MethodPublishResult] = TypeAdapter(MethodPublishResult)  # pylint: disable=invalid-name
"""The single parse path for a publish answer — built once at import (TypeAdapter construction is expensive)."""


class MethodSummary(BaseModel):
    """One row of the paged method index — `GET /v1/methods`.

    Deliberately **not** a `MethodData`: no `mthds`, no `python`, no `updated_at`, because
    none of them is in the index projection. Putting `mthds` back is exactly what restored
    the truncation bug paging was introduced to fix. A method mid-deletion still appears
    here — so a UI can render "Deleting…" — while `get_method` refuses it with a `409`.
    """

    model_config = ConfigDict(extra="allow")

    method_id: str
    name: str
    description: str | None = None
    created_at: str
    deletion_state: MethodDeletionState | None = None


class MethodPage(BaseModel):
    """One page of the method index — `{items, next_cursor}`.

    The cursor is opaque: pass it straight back as `cursor` to get the next page, and treat
    a `None` as the last page. There is no total by design — counting a catalog costs a full
    scan, and no caller needs one.
    """

    model_config = ConfigDict(extra="allow")

    items: list[MethodSummary]
    next_cursor: str | None = None


class MethodDeletionAccepted(BaseModel):
    """The `202` acceptance of `DELETE /v1/methods/{id}`.

    Returned the moment the erasure is CLAIMED and handed off, not when it completes.
    Nothing in this body means "done": completion is the method's row disappearing from
    `list_methods`. What the body buys a caller is a claim it can log and correlate
    (`deletion_job_id`) plus the state the cascade started in.
    """

    model_config = ConfigDict(extra="allow")

    method_id: str
    deletion_state: MethodDeletionState
    deletion_job_id: str


# ── Organizations (`/v1/organizations`) ──────────────────────────────────


class OrgRole(StrEnum):
    """A member's role within an organization."""

    ADMIN = "admin"
    MEMBER = "member"


class Membership(BaseModel):
    """One organization membership."""

    model_config = ConfigDict(extra="allow")

    org_id: str
    #: None for the implicit personal org (no backing WorkOS organization).
    workos_organization_id: str | None
    name: str
    is_personal: bool
    role_in_org: OrgRole


class MembershipsResponse(BaseModel):
    """The caller's memberships + the active org's feature flags — `GET /v1/organizations/memberships`."""

    model_config = ConfigDict(extra="allow")

    memberships: list[Membership]
    active_org_feature_flags: list[str]


# ── Billing (`/v1/billing/*`) ────────────────────────────────────────────


class SubscriptionResponse(BaseModel):
    """The active org's subscription state — `GET /v1/billing/subscription`."""

    model_config = ConfigDict(extra="allow")

    plan: str | None
    status: str | None
    can_use_service: bool
    renews_at: str | None = None
    ends_at: str | None = None


class PlanView(BaseModel):
    """One available plan (with `is_current`) — `GET /v1/billing/plans`."""

    model_config = ConfigDict(extra="allow")

    slug: str
    name: str
    price_display: str
    monthly_price_cents: int
    period: str
    features: list[str]
    highlight: bool
    is_current: bool


class InvoiceView(BaseModel):
    """One past invoice — `GET /v1/billing/invoices`."""

    model_config = ConfigDict(extra="allow")

    id: str
    created_at: str
    status: str
    amount_cents: int
    currency: str
    card_brand: str | None
    card_last_four: str | None
    refunded: bool
    download_url: str | None


class CheckoutResponse(BaseModel):
    """A Stripe checkout session URL — `POST /v1/billing/checkout`."""

    model_config = ConfigDict(extra="allow")

    checkout_url: str | None = None


class ChangePlanResponse(BaseModel):
    """The outcome of switching plan — `POST /v1/billing/change-plan`."""

    model_config = ConfigDict(extra="allow")

    plan: str | None = None
    status: str | None = None
    charged_immediately: bool | None = None
    resumed: bool | None = None


class BillingPortalResponse(BaseModel):
    """A Stripe billing-portal session URL — `GET /v1/billing/portal`."""

    model_config = ConfigDict(extra="allow")

    portal_url: str | None = None


# ── Pipelex API keys (`/v1/pipelex-api-keys`, `plx_sk_…`) ────────────────


class PipelexApiKey(BaseModel):
    """One Pipelex API key (metadata only — never the plaintext)."""

    model_config = ConfigDict(extra="allow")

    id: str
    label: str
    prefix: str
    created_at: str
    last_used_at: str | None
    expires_at: str | None


class PipelexApiKeyCreated(BaseModel):
    """The create/rotate response — the plaintext `api_key` is returned ONCE."""

    model_config = ConfigDict(extra="allow")

    api_key: str
    id: str
    label: str
    prefix: str
    created_at: str


class PipelexApiKeyList(BaseModel):
    """The caller's Pipelex API keys — `GET /v1/pipelex-api-keys`."""

    model_config = ConfigDict(extra="allow")

    keys: list[PipelexApiKey]


# ── Onboarding (`/v1/onboarding/submit`) ─────────────────────────────────


class OnboardingRole(StrEnum):
    """The respondent's role."""

    DEVELOPER = "developer"
    FOUNDER = "founder"
    DATA_SCIENTIST = "data_scientist"
    RESEARCHER = "researcher"
    OTHER = "other"


class OnboardingCurrentTool(StrEnum):
    """The respondent's current tool."""

    LANGCHAIN = "langchain"
    CREWAI = "crewai"
    LLAMAINDEX = "llamaindex"
    CUSTOM = "custom"
    NONE = "none"
    OTHER = "other"


class OnboardingInputType(StrEnum):
    """A kind of material the respondent works with."""

    DOCUMENTS = "documents"
    IMAGES = "images"
    VIDEOS = "videos"
    AUDIO = "audio"
    STRUCTURED_DATA = "structured_data"
    TEXT = "text"


class OnboardingHeardFrom(StrEnum):
    """Where the respondent heard about Pipelex."""

    TWITTER = "twitter"
    YOUTUBE = "youtube"
    HACKERNEWS = "hackernews"
    DISCORD = "discord"
    FRIEND = "friend"
    GOOGLE = "google"
    CONFERENCE = "conference"
    OTHER = "other"


class OnboardingSubmission(BaseModel):
    """The onboarding questionnaire payload — `POST /v1/onboarding/submit`."""

    role: OnboardingRole
    company: str | None = None
    use_case: str
    process_to_transform: str
    input_types: list[OnboardingInputType]
    material_domain: str
    current_tool: OnboardingCurrentTool
    current_tool_other: str | None = None
    heard_from: OnboardingHeardFrom


# ── Storage (`/v1/resolve-storage-url`, `/v1/upload`) ────────────────────


class ResolvedStorageUrl(BaseModel):
    """A storage URI resolved to a presigned URL — `POST /v1/resolve-storage-url`."""

    model_config = ConfigDict(extra="allow")

    url: str
    expires_at: str
    content_type: str | None


class UploadInput(BaseModel):
    """Upload payload — base64 `data` (the multipart hop is browser→BFF only)."""

    filename: str
    data: str
    content_type: str


class UploadedFile(BaseModel):
    """An uploaded file's storage handle — `POST /v1/upload`."""

    model_config = ConfigDict(extra="allow")

    uri: str
    filename: str


# ── Run records (`/v1/runs`) ─────────────────────────────────────────────
#
# The run-lifecycle status/results/start routes already live on the client
# (`runs.py`); these are the remaining catalog-style paged list, the single-run
# detail read, and the admin-update route.


class RunHistoryItem(BaseModel):
    """One row of a method's run list — `GET /v1/runs?method_id=…`.

    What a run-history row shows, and nothing else: which run, its status, when it started and
    finished, which pipe it ran and, for a failed run, why. The rest of a run record — its
    organization, its creator, its method (the caller just named it), its workflow id, its result
    prefix — is either already known to the caller or only meaningful once a run is opened, which
    `get_run_detail` serves.
    """

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: str
    status: RunStatus
    created_at: str
    finished_at: str | None = None
    pipe_code: str | None = None
    """The pipe that ran, when it was named. A run that let the bundle's `main_pipe` decide
    has none to report, so the platform serves this as null."""

    error: LenientRunErrorReport = None
    """The run's stored report, kept on the row so opening a failed run from history shows why
    without another read. `None` on every run that did not fail."""

    method_version: int | Literal["draft"] | None = None
    """Which version of the method the run ran — a number, `"draft"`, or `None` for an inline
    source (see `PipelineRun.method_version`). The history lists the runs of every version and of
    the draft together, so this is how a row says which one it was."""

    source_digest: str | None = None
    """The digest of the files the run ran (see `PipelineRun.source_digest`)."""


class PipelineRun(BaseModel):
    """A whole run record — the base of `RunDetail`, the shape `GET /v1/runs/{id}` serves."""

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: str
    method_id: str | None = None
    """The stored method this run is linked to, when there is one. An ad-hoc run from an
    inline bundle belongs to no stored method, so the platform serves this as null."""

    pipe_code: str | None = None
    """The pipe that ran, when it was named. A run that let the bundle's `main_pipe` decide
    has none to report, so the platform serves this as null."""

    org_id: str | None = None
    created_by_user_id: str | None = None
    workflow_id: str | None = None
    status: RunStatus
    result_url: str | None = None
    error: LenientRunErrorReport = None
    created_at: str
    finished_at: str | None = None
    method_version: int | Literal["draft"] | None = None
    """Which version of its method the run ran: the version number for a run addressed by a bare
    id (the latest published version) or by `mt_…@<n>`, `"draft"` for one addressed by
    `mt_…@draft`, and `None` for a run of an inline source — or a run a platform recorded before
    it recorded versions."""

    source_digest: str | None = None
    """The digest of the files the run ran, in the canonical form of `MethodData.draft_digest`, so
    an inline run identical to a version records that version's `source_digest`. `None` when the
    platform never held the files, as on a `method_ref` run, or did not record it yet."""


class RunDetail(PipelineRun):
    """One run read on its own — `GET /v1/runs/{id}`.

    Adds the two heavy fields the list and the polled status deliberately leave out (their
    cost scales with page size and poll rate respectively). `mthds_contents` is what the run
    actually executed, and the only record of it: a method edited since the run no longer
    describes what happened.
    """

    mthds_contents: list[str] | None = None
    inputs: dict[str, Any] | None = None


class RunPage(BaseModel):
    """One page of a method's run list — `{items, next_cursor}`.

    Same opaque-cursor contract as `MethodPage`: pass `next_cursor` straight back, and a
    `None` means the last page.
    """

    model_config = ConfigDict(extra="allow")

    items: list[RunHistoryItem]
    next_cursor: str | None = None


class UpdateRunInput(BaseModel):
    """The admin/manual run-status patch — `status` is a free string here."""

    status: str
    result_url: str | None = None
    finished_at: str | None = None
