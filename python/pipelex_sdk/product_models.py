"""Pipelex-product wire models — the snake_case JSON shapes the hosted-product routes speak.

These mirror `pipelex-sdk-js/src/product-models.ts`. They are the management surface
the hosted product (`/v1/me`, `/v1/methods` and its examples, `/v1/organizations`, `/v1/branding`, `/v1/billing/*`,
`/v1/pipelex-api-keys`, `/v1/onboarding/submit`,
`/v1/resolve-storage-url`, `/v1/upload`, `/v1/runs`) drives.

The wire is snake_case. Each model holds only the fields the product actually
consumes — not a speculative mirror of every server field. Response models are
extension-open (`extra="allow"`): an unknown server field is preserved, not
rejected — the SDK never has to ship just to read a newly-added field. Input
models name exactly what the routes accept.

These are Pipelex-branded (the hosted product surface), so they live in this SDK,
not in `mthds`. `RunHistoryItem.status` and `PipelineRun.status` reuse the run-lifecycle `RunStatus`.

A saved method has a draft and published versions. Its DRAFT is a tree of files, the MTHDS
standard's method tree, which the platform holds in the organization's blob store and the method
names by digest (`draft_digest`), with the editor's form inputs (`input_data`); it is written freely
by `write_draft` and never validated on write. A VERSION is an immutable copy of the draft, numbered
from 1 and never reused, written only by `publish_method` and only when the draft validates and runs.
A read of a method or of a version lists its tree's files, each with a short-lived link to its bytes
(`SavedMethodFile`). A bare `method_id` runs
the latest published version, `mt_…@<n>` a fixed version and `mt_…@draft` the draft; the
method routes themselves take a bare id (`pipelex_sdk.method_selector.parse_method_selector`
strips a suffix).
"""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Annotated, Any, Literal, TypeAlias

from mthds.method_tree.file_entry import FileEntry
from mthds.method_tree.models import MethodTree
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, TypeAdapter

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


class SavedMethodFile(BaseModel):
    """One file of a saved method's tree, as `get_method` and `get_method_version` serve it.

    The platform holds a saved tree's files in the organization's blob store, and a read lists them,
    in tree path order, each with a short-lived link to its bytes. A client holding a file whose
    `sha256` matches already holds those bytes, and `PipelexAPIClient.write_method_tree` brings the
    whole tree back to disk.
    """

    model_config = ConfigDict(extra="allow")

    path: str
    """The file's tree path, relative to the method's root, `/`-separated."""

    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    """The SHA-256 of the file's bytes, 64 lowercase hexadecimal characters; a listing naming anything else is an answer the SDK cannot read."""

    size: int = Field(ge=0)
    """The file's length in bytes."""

    url: str = Field(repr=False)
    """A presigned `GET` of the file's bytes, valid until `expires_at`. It is a bearer credential: it
    needs no API key, and anyone holding it can read the file until it expires, so it is never logged,
    and a file's `repr` leaves it out."""

    expires_at: str
    """When `url` stops working, an ISO-8601 UTC instant about fifteen minutes after the read. Read the
    method again for fresh links."""


class MethodVersionSummary(BaseModel):
    """One published version without its files.

    What `list_method_versions` lists, what a method read carries as `latest_published`, and
    what a publish answers as `version`.
    """

    model_config = ConfigDict(extra="allow")

    version: int
    """The version number, from 1, never reused and never renumbered."""

    tree_digest: str | None = None
    """The digest of the version's method tree, `sha256:` and 64 lowercase hexadecimal characters: the
    SHA-256 of the tree's listing, the same function as the method's `draft_digest`, so equal digests
    mean the same files. `None` for a version stored before methods were trees and not yet rewritten as
    one, which the platform can neither serve nor run."""

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
    """One published version with its files — `get_method_version`.

    It carries no `name`, which belongs to the method and changes without a publish, and no
    `input_data`, which is the editor's form state and not part of what a caller runs.
    """

    method_id: str

    files: list[SavedMethodFile]
    """The version's tree, one file per entry in tree path order, each with a link to its bytes.
    `PipelexAPIClient.write_method_tree` writes it to disk."""


class MethodVersionPage(BaseModel):
    """One page of a method's published versions, newest first, without their files — `{items, next_cursor}`.

    Same opaque-cursor contract as `MethodPage`: pass `next_cursor` straight back, and a `None`
    means the last page. Versions are read whole on the server, so a page may be short while
    `next_cursor` is set. A method never published answers an empty page.
    """

    model_config = ConfigDict(extra="allow")

    items: list[MethodVersionSummary]
    next_cursor: str | None


class MethodData(BaseModel):
    """One saved method — `create_method`, `write_draft`, `rename_method`, and the `method` of every
    publish outcome. `get_method` answers a `MethodDetail`, which adds the draft's files.

    Its draft is a tree of files, named here by its digest alone (`draft_digest`), with the form
    inputs (`input_data`); the latest published version is summarized in `latest_published`. The
    publish state a client shows is derived, never stored: never published (`latest_version` is
    `None`), published with the draft unchanged (`draft_digest` is not `None` and equals
    `latest_published.tree_digest`), or published with the draft ahead.
    """

    model_config = ConfigDict(extra="allow")

    method_id: str
    name: str
    org_id: str
    created_by_user_id: str
    description: str | None = None
    """The draft's description, which the platform reads from its files on every draft write: the
    top-level `description` of the first `.mthds` file that declares one."""

    deletion_state: MethodDeletionState | None = None
    #: The editor's form inputs, saved with the draft and outside its digest.
    input_data: dict[str, Any] | None = None
    #: Legacy persisted output spec; optional.
    pipe_output: dict[str, Any] | None = None

    created_at: str
    updated_at: str
    """**The draft's token.** It moves on every draft write and on nothing else: creation sets it,
    and neither a rename nor a publish moves it. Echo it verbatim — the platform compares the
    strings — as `expected_updated_at` on the next `write_draft`, or as `expected_draft_updated_at`
    on `publish_method`, so neither ever overwrites or publishes a draft the caller has not seen."""

    draft_digest: str | None = None
    """The digest of the draft's method tree, `sha256:` and 64 lowercase hexadecimal characters: the
    SHA-256 of the tree's listing. `None` for an empty draft. `input_data` is outside it, so saving
    only the form inputs moves the token and leaves the digest as it was."""

    latest_version: int | None = None
    """The number of the latest published version; `None` when the method was never published."""

    latest_published: MethodVersionSummary | None = None
    """The latest published version's summary; `None` when the method was never published."""


class MethodDetail(MethodData):
    """One saved method with its draft's files — `get_method`."""

    files: list[SavedMethodFile]
    """The draft's tree, the one `draft_digest` names, one file per entry in tree path order, each with
    a link to its bytes; an empty list for an empty draft. `PipelexAPIClient.write_method_tree` writes it
    to disk."""


class MethodWriteInput(BaseModel):
    """The create payload — `create_method`, `POST /v1/methods`.

    A new method holds its tree as its draft and has no version yet. Its draft is then written with
    `write_draft` (`MethodDraftInput`) and its name changed with `rename_method`.

    The tree is given in one of three forms, or in none for an empty draft, and the client refuses two
    together before anything is sent:

    - `files`, the MTHDS standard's map of file entries, the same `files` a run takes, sent as given;
    - `tree`, a tree listed from a directory (`PipelexAPIClient.list_method_tree`), or the `Path` of
      a directory or of a `.mthds` file, which the client lists the same way, or
    - `contents`, each file's bytes or text by tree path,

    the last two sent inline when the tree is small and by hash otherwise, after uploading the files
    the platform lacks (`mthds`'s `prepare_files`). Closed: the retired `mthds` and `python` fields are
    refused rather than dropped.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    files: dict[str, FileEntry] | None = None
    tree: MethodTree | Path | None = None
    contents: dict[str, bytes | str] | None = None
    input_data: dict[str, Any] | None = None


class MethodDraftInput(BaseModel):
    """The draft write — `write_draft`, `PUT /v1/methods/{id}/draft`.

    It never validates: a draft may be invalid, and an autosave of work in progress often is. The
    write replaces the draft's whole tree, given in exactly one of the forms `MethodWriteInput`
    takes: `files` (where an explicit `None` empties the draft), `tree` or `contents`. Closed: the
    retired `mthds` and `python` fields are refused rather than dropped.
    """

    model_config = ConfigDict(extra="forbid")

    files: dict[str, FileEntry] | None = None
    """The draft's tree as a map of file entries, sent as given. Set to `None`, the draft is emptied."""

    tree: MethodTree | Path | None = None
    """The draft's tree, listed from a directory, or the `Path` of a directory or of a `.mthds` file, which the client lists."""

    contents: dict[str, bytes | str] | None = None
    """The draft's files, each one's bytes or text by tree path."""

    input_data: dict[str, Any] | None = None
    """The editor's form inputs. Left unset, the stored inputs are **kept**; set to `None`, they
    are **cleared**; any other value **replaces** them."""

    expected_updated_at: str | None = None
    """The draft token the caller last saw — the `updated_at` of the method it last read or wrote,
    echoed verbatim. With it the write is a compare-and-swap: a draft that moved since is refused
    with a `409` whose `code` is `method_update_conflict`, and nothing is written. Unset or `None`,
    the write is last-writer-wins."""


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
about the draft's content. Branch on `outcome` (`match result:` over its classes), never on
the status: a stale token, a method being deleted, a draft with no `.mthds` file or an unreachable
runner raise `ApiResponseError` instead, since they produce no verdict about the content."""

MethodPublishResultAdapter: TypeAdapter[MethodPublishResult] = TypeAdapter(MethodPublishResult)  # pylint: disable=invalid-name
"""The single parse path for a publish answer — built once at import (TypeAdapter construction is expensive)."""


class MethodSummary(BaseModel):
    """One row of the paged method index — `GET /v1/methods`.

    Deliberately **not** a `MethodData`: no `updated_at`, because the index projection orders
    by the immutable `created_at`, and no files, which `get_method` lists. A method mid-deletion
    still appears here — so a UI can render "Deleting…" — while `get_method` refuses it with a `409`.

    The row carries the method's publish state, so a list tells its methods apart without
    reading each one: never published (`latest_version` is `None`), published with the draft
    unchanged (`draft_digest` is not `None` and equals `latest_published.tree_digest`), or
    published with the draft ahead. The three fields read as `None` from a platform that does not
    serve them.
    """

    model_config = ConfigDict(extra="allow")

    method_id: str
    name: str
    description: str | None = None
    created_at: str
    deletion_state: MethodDeletionState | None = None

    latest_version: int | None = None
    """The number of the latest published version; `None` when the method was never published."""

    latest_published: MethodVersionSummary | None = None
    """The latest published version's summary; `None` when the method was never published."""

    draft_digest: str | None = None
    """The digest of the draft's method tree, as on `MethodData.draft_digest`; `None` for an empty
    draft. Compare it with `latest_published.tree_digest` only when both are strings."""


class MethodPage(BaseModel):
    """One page of the method index — `{items, next_cursor}`.

    The cursor is opaque: pass it straight back as `cursor` to get the next page, and treat
    a `None` as the last page. There is no total by design — counting a catalog costs a full
    scan, and no caller needs one. `next_cursor` is required, as on every page model: the platform
    always sends it, so a page without it is an answer the SDK cannot read, never the last page,
    which would end an iterator early without a word.

    Under `q` or `published` a page can hold fewer rows than `limit`, or none, and still carry a
    `next_cursor`: the filters run after the index read, so an empty page is not the end of the
    list, and only a `None` cursor is. `iterate_methods` keeps following the cursor through such
    a page.
    """

    model_config = ConfigDict(extra="allow")

    items: list[MethodSummary]
    next_cursor: str | None


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


# ── Method examples (`/v1/methods/{id}/examples`) ────────────────────────
#
# An example is a named set of inputs saved on a method, so the method can be run on them again in
# one gesture, with the latest run of exactly those inputs. Like the method, it is shared across the
# organization: any member reads, edits, runs and deletes any example. `input_revision` starts at 1
# and rises each time the inputs change, which clears `latest_run_id`; a run is recorded as the
# latest only against the revision whose inputs it used (`record_method_example_latest_run`).

#: The largest integer a JavaScript number holds exactly, `Number.MAX_SAFE_INTEGER`: `@pipelex/sdk` refuses an
#: example whose `input_revision` lies past it in either direction, and so does `MethodExample`.
_LARGEST_EXACT_REVISION = 2**53 - 1


class MethodExample(BaseModel):
    """One saved example of a method.

    What `create_method_example`, `get_method_example`, `update_method_example` and both arms of
    `record_method_example_latest_run` answer, and a row of `list_method_examples`.

    Its fields are read strictly, as `@pipelex/sdk` reads them, so both SDKs refuse the same answers: a
    field of another type is never coerced, so a revision of `"2"`, `True` or `2.0` is no revision, and
    an example breaking a field raises the `ApiResponseError` of an answer the SDK cannot read. The one
    answer the two read apart is a revision spelled `2.0`, which JavaScript reads as the number `2` and
    cannot tell from it.
    """

    model_config = ConfigDict(extra="allow")

    example_id: StrictStr
    """The example's id, `ex_…`, minted by the platform."""

    method_id: StrictStr
    """The bare id of the method the example belongs to."""

    name: StrictStr
    """The example's name, 1 to 200 characters and not blank."""

    inputs: dict[str, Any] = Field(strict=True)
    """The inputs a run of the example sends, a JSON object returned exactly as it was saved: an integer
    stays an `int` and `3.0` a `float`."""

    input_revision: StrictInt = Field(ge=-_LARGEST_EXACT_REVISION, le=_LARGEST_EXACT_REVISION)
    """Starts at 1 and rises by one each time the inputs change. Send it, as read when the run was
    started, to `record_method_example_latest_run`. An integer a JavaScript number holds exactly, as
    `@pipelex/sdk` requires."""

    latest_run_id: StrictStr | None
    """The latest run of the current inputs, `None` when none was recorded since they last changed. It
    may name a run deleted since, which then reads as not found. Required, as on every example the
    platform answers: an example without it is an answer the SDK cannot read, never one with no latest
    run."""

    created_by_user_id: StrictStr
    """The canonical id of the member who saved the example; it confers nothing."""

    created_at: StrictStr
    """ISO-8601 UTC instant of the example's creation."""

    updated_at: StrictStr
    """ISO-8601 UTC instant of its last change: its name, its inputs or its latest run."""


class MethodExamplePage(BaseModel):
    """One page of a method's examples, oldest first, inputs included — `{items, next_cursor}`.

    Same opaque-cursor contract as `MethodPage`: pass `next_cursor` straight back, and a `None` means
    the last page. Examples are read whole on the server, and a read stops at 1 MB, so a page may be
    short while `next_cursor` is set; `iterate_method_examples` follows it.
    """

    model_config = ConfigDict(extra="allow")

    items: list[MethodExample]
    next_cursor: str | None


class MethodExampleLatestRunOutcome(StrEnum):
    """What a latest-run write did — the discriminant of `MethodExampleLatestRunResult`."""

    RECORDED = "recorded"
    """The run is now the example's latest."""

    STALE = "stale"
    """The example's inputs are no longer the ones the run used, and nothing was written."""


class MethodExampleLatestRunRecorded(BaseModel):
    """The run is now the example's latest; `example` is the example as it now stands."""

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodExampleLatestRunOutcome.RECORDED]
    example: MethodExample


class MethodExampleLatestRunStale(BaseModel):
    """The run used inputs the example no longer holds, and nothing was written.

    `example` is the example as it stands, with its current revision and latest run.
    """

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodExampleLatestRunOutcome.STALE]
    example: MethodExample


MethodExampleLatestRunResult: TypeAlias = Annotated[
    MethodExampleLatestRunRecorded | MethodExampleLatestRunStale,
    Field(discriminator="outcome"),
]
"""The answer of `record_method_example_latest_run`, a `200` discriminated on `outcome`. A stale run is the
expected end of a run that outlasted an edit of the example's inputs, a verdict about the run rather than
a failed request, so it is answered rather than raised. Branch on `outcome` (`match result:` over its
classes), never on the status: an unknown example, a run that is not the method's or a method being
deleted raise `ApiResponseError` instead."""

MethodExampleLatestRunResultAdapter: TypeAdapter[MethodExampleLatestRunResult] = TypeAdapter(MethodExampleLatestRunResult)  # pylint: disable=invalid-name
"""The single parse path for a latest-run answer — built once at import (TypeAdapter construction is expensive)."""


# ── Organizations (`/v1/organizations`) ──────────────────────────────────


class OrgRole(StrEnum):
    """A member's role within an organization — `Membership.role_in_org`.

    - `ADMIN`: does what a member does, and manages the organization's members, their roles and its
      invitations.
    - `MEMBER`: builds, publishes and runs the organization's methods.
    - `RUNNER`: runs the versions the organization published, and changes no method.

    Read open, as `Membership.role_in_org` types it: a role a later platform adds arrives as its raw
    string rather than failing the whole response, so a `match` over a membership's role needs a branch
    for a string this enum does not name. What a role may do is the platform's to decide: a call it
    refuses to the caller's role raises `ApiResponseError`, whatever this enum says.
    """

    ADMIN = "admin"
    MEMBER = "member"
    RUNNER = "runner"


class Membership(BaseModel):
    """One organization membership."""

    model_config = ConfigDict(extra="allow")

    org_id: str
    #: None for the implicit personal org (no backing WorkOS organization).
    workos_organization_id: str | None
    name: str
    is_personal: bool
    #: The caller's role in the organization: the `OrgRole` member when this SDK knows the role, its raw
    #: string otherwise.
    role_in_org: Annotated[OrgRole | str, Field(union_mode="left_to_right")]


class MembershipsResponse(BaseModel):
    """The caller's memberships + the active org's feature flags — `GET /v1/organizations/memberships`."""

    model_config = ConfigDict(extra="allow")

    memberships: list[Membership]
    active_org_feature_flags: list[str]


# ── Organization branding (`/v1/branding`, `/v1/organizations/{id}/branding`) ──
#
# An organization may set up to two logos and two colour sets of three colours, which its shared
# method apps and the apps scaffolded from the method-app template wear. Every member and every API
# key reads it with `get_branding`; an admin writes it with `update_organization_branding`. Both
# answer the same `OrganizationBranding`. See `docs/organization-branding.md`.


class BrandingColors(BaseModel):
    """One colour set: the button, accent and header colours, each `#rrggbb` in lower case, or `None` when not set.

    The platform always sends all three colours.
    """

    model_config = ConfigDict(extra="allow")

    action: str | None
    """The button colour."""

    accent: str | None
    """The accent colour: links, the active tab, the brand ink."""

    header: str | None
    """The header band's colour."""


class LogoDescriptor(BaseModel):
    """What the platform recorded about a logo when it accepted it.

    `content_type` is the type the platform read from the file's own bytes, never the type the upload
    declared: `image/png`, `image/jpeg`, `image/webp` or `image/svg+xml`. `width` and `height` are the
    image's size in pixels for a raster, oriented as a browser draws it, and for an SVG the width and
    height of its `viewBox` (else of its `width` and `height` in pixels), which may be fractional. Their
    ratio is the logo's shape, which sizes its box before the image loads.
    """

    model_config = ConfigDict(extra="allow")

    uri: str
    """The platform's own copy of the logo, `pipelex-storage://<org_id>/branding/<uuid>.<ext>`, never the upload
    URI the write sent: the platform copies a logo it accepts. Sending it back unchanged in its slot keeps the
    logo. `resolve_storage_url` turns it into a short-lived link to its bytes."""

    sha256: str
    """The SHA-256 of the logo's bytes, 64 lower-case hexadecimal digits: a cache key for them."""

    content_type: str
    width: float
    height: float


class OrganizationBranding(BaseModel):
    """An organization's branding — what `get_branding` and `update_organization_branding` answer.

    `colors` is the light set and `dark_colors` the dark one, used in dark mode only: a dark colour that
    is `None` falls back to the light colour of the same role, and a light one that is `None` to
    Pipelex's own palette. A logo is `None` when its slot is empty. A personal workspace, or a team that
    set nothing, answers every colour and logo `None`.
    """

    model_config = ConfigDict(extra="allow")

    org_id: str
    org_name: str
    """The organization's display name, the wordmark a client shows when it has no logo."""

    colors: BrandingColors
    dark_colors: BrandingColors
    square_logo: LogoDescriptor | None
    """The square logo, for the organization menu and small headers."""

    wide_logo: LogoDescriptor | None
    """The wide logo, at least one and a half times as wide as it is tall, for an app's header."""


class BrandingColorsUpdate(BaseModel):
    """Changes to one colour set — part of an `OrganizationBrandingUpdate`.

    A field set to a colour sets it, a field set to `None` clears it, and a field left unset keeps its value.
    A colour is `#rrggbb` in either case, stored in lower case; the platform refuses anything else with
    a `422` `validation_failed` whose `errors[]` entry names the field, such as `colors.action`.
    """

    model_config = ConfigDict(extra="forbid")

    action: str | None = None
    accent: str | None = None
    header: str | None = None


class OrganizationBrandingUpdate(BaseModel):
    """The write of `update_organization_branding` — `PATCH /v1/organizations/{org_id}/branding`.

    Every field is optional, and only the fields set are sent: a value sets it, an explicit `None`
    clears it, and a field left unset keeps its value, so `OrganizationBrandingUpdate()` writes nothing
    and answers the branding as it stands.

    - `colors` and `dark_colors` take a `BrandingColorsUpdate`, or `None` to clear all three colours of
      that set.
    - `square_logo` and `wide_logo` take the `pipelex-storage://` URI of a file the organization
      uploaded on its own (`upload`) to set a new logo, the `uri` the branding answers for that slot to
      keep it, or `None` to remove it. Any other URI, such as a run's or a method's file, is refused as
      `logo_not_an_upload`. The platform reads and measures an upload before it accepts it, keeps its
      own copy under `branding/`, whose URI it answers, and erases the logo a write replaces or clears.
    """

    model_config = ConfigDict(extra="forbid")

    colors: BrandingColorsUpdate | None = None
    dark_colors: BrandingColorsUpdate | None = None
    square_logo: str | None = None
    wide_logo: str | None = None


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
    """An uploaded file's storage handle — `POST /v1/upload`.

    An answer with no non-empty `uri` names no stored file, so it does not validate, and `upload`
    raises the `ApiResponseError` of an answer the SDK cannot read, as `@pipelex/sdk` does.
    """

    model_config = ConfigDict(extra="allow")

    uri: str = Field(min_length=1)
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
    """The run's stored report, served as on the run detail (the runner's STRICT projection), so
    opening a failed run from history shows why without another read. `None` on a completed run and
    on one that ended without a report (see `RunErrorReport`)."""

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
    """The digest of the sources a run sent as text, `mthds_contents` or a `files` map of text
    entries, as 64 lowercase hexadecimal characters. Not a tree digest: a run's method tree is named
    by `RunDetail.tree_digest`. `None` when the platform never held the sources as text: a run of a
    saved method, a `method_ref` run, a map with a Base64 or hash entry, or a run recorded before it."""


class RunDetail(PipelineRun):
    """One run read on its own — `GET /v1/runs/{id}`.

    Adds the two heavy fields the list and the polled status deliberately leave out (their
    cost scales with page size and poll rate respectively). `mthds_contents` is what the run
    actually executed, and the only record of it: a method edited since the run no longer
    describes what happened.
    """

    mthds_contents: list[str] | None = None
    inputs: dict[str, Any] | None = None
    request_id: str | None = None
    """The id of the request that started the run — the one to quote to support, and the one the
    platform and the runner logged it under. `None` for a run saved before the platform recorded it,
    and on a server that does not serve it. The run list does not carry it; the status read does, as
    `RunRead.request_id`."""

    tree_digest: str | None = None
    """The tree digest (`sha256:` and 64 lowercase hexadecimal characters) of the method tree the run
    sent as `files`, the files it sent in `resources` joined to it: the run's method by content, in the
    form of `MethodData.draft_digest`, so a run of a tree identical to a version's records that
    version's `tree_digest`. `None` for a run that sent no tree, and on a run recorded before it."""

    crate_fingerprint: str | None = None
    """The fingerprint of the crate the runner loaded the run's method into, when the runner reported it."""


class RunPage(BaseModel):
    """One page of a method's run list — `{items, next_cursor}`.

    Same opaque-cursor contract as `MethodPage`: pass `next_cursor` straight back, and a
    `None` means the last page.

    Under `created_by` or `status` a page can hold fewer rows than `limit`, or none, and still
    carry a `next_cursor`: the platform applies them after the index read, so an empty page is not
    the end of the history, and only a `None` cursor is. `iterate_runs` keeps following the cursor
    through such a page.
    """

    model_config = ConfigDict(extra="allow")

    items: list[RunHistoryItem]
    next_cursor: str | None


class UpdateRunInput(BaseModel):
    """The admin/manual run-status patch — `status` is a free string here."""

    status: str
    result_url: str | None = None
    finished_at: str | None = None
