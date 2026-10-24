"""Pipelex-product wire models — the snake_case JSON shapes the hosted-product routes speak.

These mirror `pipelex-sdk-js/src/product-models.ts`. They are the management surface
the hosted product (`/v1/me`, `/v1/methods` and its examples, `/v1/organizations`, `/v1/branding`, `/v1/billing/*`,
`/v1/pipelex-api-keys`, `/v1/onboarding/submit`,
`/v1/resolve-storage-url`, `/v1/upload`, `/v1/files`, `/v1/runs`) drives.

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
from typing import Annotated, Any, Literal, Self, TypeAlias, cast

from mthds.method_tree.file_entry import FileEntry
from mthds.method_tree.models import MethodTree
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, TypeAdapter, ValidationInfo, model_validator

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


class MethodCopiedFrom(BaseModel):
    """The method a copy was made from, as it stood at the copy — `MethodData.copied_from`.

    Opaque ids only, never a name: the original may have changed or been erased since, and its organization
    may be one the reader does not belong to, so nothing here is a link the reader can follow unless they
    belong to that organization.
    """

    model_config = ConfigDict(extra="allow")

    org_id: str
    """The canonical id of the organization that holds the original."""

    method_id: str
    """The original's method id."""

    draft_digest: str | None = None
    """The digest of the original's draft the copy took; `None` for an empty draft."""


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

    copied_from: MethodCopiedFrom | None = None
    """The method this one was copied from, on a method `copy_method` made; `None` on a method created afresh,
    and from a platform that predates copies. Written once, when the copy is made, and never rewritten. The
    list rows (`MethodSummary`) do not carry it."""


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


# ── Method copies (`/v1/methods/{id}/copy`, `/v1/methods/{id}/copies`) ──────
#
# A copy is a new, unpublished method in a destination organization holding the original's draft, its form
# inputs and its saved examples, each stored file they name copied into the destination. The original stays as
# it was, and keeps a marker of each copy made of it.


class MethodCopyOutcome(StrEnum):
    """What a copy did — the discriminant of `MethodCopyResult`."""

    COPIED = "copied"
    """The copy exists in the destination."""

    REFUSED = "refused"
    """A bundle of the draft names stored files the copy cannot rely on, and nothing was written: files the
    destination cannot read, or, in a duplicate, files under the original's run files, which erasing the original
    would remove."""


class MethodCopyRefusalReason(StrEnum):
    """Why a copy was refused, the `reason` of `MethodCopyRefused`."""

    BUNDLE_NAMES_OTHER_STORAGE = "bundle_names_other_storage"
    """A `.mthds` file of the draft holds a `pipelex-storage://` reference the copy cannot rely on: one the
    destination cannot read, which every run there would refuse, or, in a duplicate, one under the original
    method's own run files (`pipelex-storage://<org_id>/<method_id>/…`), which erasing the original would remove,
    failing every run of the duplicate."""


class BundleStorageReference(BaseModel):
    """One stored file a bundle of the draft names that keeps it from being copied: a file the destination cannot
    read, or, in a duplicate, a file under the original's run files, which erasing the original would remove.
    """

    model_config = ConfigDict(extra="allow")

    path: str
    """The tree path of the `.mthds` file that holds the reference."""

    uri: str
    """The `pipelex-storage://` reference as the file writes it, a malformed one included."""


class MethodCopied(BaseModel):
    """A copy that was made: `method` is the copy, in the destination, `copied_from` included."""

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodCopyOutcome.COPIED]
    method: MethodData

    examples_copied: int
    """How many saved examples the copy holds, each a new example at `input_revision` 1."""

    stored_files_copied: int
    """How many distinct stored files were copied into the destination for the copy's inputs."""


class MethodCopyRefused(BaseModel):
    """A copy refused before anything was written: a bundle of the draft names stored files the copy cannot rely on.

    Those are files the destination cannot read, which every run there would refuse, and, in a duplicate, files
    under the original method's own run files, which erasing the original would remove. The person removes or
    replaces each reference in the original and copies again, since rewriting the bundle would change the
    author's code without asking them.
    """

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodCopyOutcome.REFUSED]
    reason: MethodCopyRefusalReason

    message: str
    """What was refused and what to do, for a person."""

    references: list[BundleStorageReference]
    """Every reference the destination cannot read and, in a duplicate, every reference under the original's run
    files, ordered by bundle path, then by reference."""


MethodCopyResult: TypeAlias = Annotated[
    MethodCopied | MethodCopyRefused,
    Field(discriminator="outcome"),
]
"""The answer of `copy_method`, a `200` discriminated on `outcome`, because a bundle the copy cannot rely on
is a verdict about the method, not a failure of the request. Branch on `outcome` (`match result:` over its
classes), never on the status: a destination the caller may not write to, a stale token, a method being deleted
or a copy past its bounds raise `ApiResponseError` instead, since they produce no verdict."""

MethodCopyResultAdapter: TypeAdapter[MethodCopyResult] = TypeAdapter(MethodCopyResult)  # pylint: disable=invalid-name
"""The single parse path for a copy's answer — built once at import (TypeAdapter construction is expensive)."""


class MethodCopyLimit(BaseModel):
    """The bound a `422` `method_copy_too_large` names, in its problem document's `limit` member.

    Read it with `MethodCopyLimit.model_validate(error.problem_document["limit"])`: `max_stored_files`, the most
    distinct stored files one copy copies, or `max_stored_bytes`, the most bytes they add up to, each set per
    deployment; its `value`, and what the copy `reached`. Removing examples, or the files they hold, brings the
    copy under it.
    """

    model_config = ConfigDict(extra="allow")

    name: Literal["max_stored_files", "max_stored_bytes"]
    value: int
    reached: int


class MethodCopyMarker(BaseModel):
    """The original's record of one copy made of it — a row of `list_method_copies`.

    It names the destination by its id alone, never its name, so the listing tells no reader the name of an
    organization they do not belong to: show a destination's name only from the reader's own memberships. The
    marker stays when its copy is erased, and the copy then reads as not found.
    """

    model_config = ConfigDict(extra="allow")

    copy_method_id: str
    """The copy's method id, in the destination organization."""

    destination_org_id: str
    """The canonical id of the organization the copy was made in."""

    copied_by_user_id: str
    """The canonical id of the member who made the copy."""

    copied_at: str
    """ISO 8601 UTC instant the copy's row was written."""


class MethodCopyPage(BaseModel):
    """One page of a method's copies — `{items, next_cursor}`, in the order of the copies' ids.

    The order says nothing of when each copy was made. The cursor is opaque: pass it straight back as `cursor`,
    and treat a `None` as the last page; `next_cursor` is required, as on every page model. A method never copied,
    and a copy, which names its original through `copied_from` and has no copies of its own, answer an empty page.
    """

    model_config = ConfigDict(extra="allow")

    items: list[MethodCopyMarker]
    next_cursor: str | None


# ── Method examples (`/v1/methods/{id}/examples`) ────────────────────────
#
# An example is a named set of inputs saved on a method, so the method can be run on them again in
# one gesture, with the latest run of exactly those inputs. Like the method, it is shared across the
# organization: every role reads and runs any example, and every role that may change methods
# (`admin` and `member`) saves, edits and deletes any of them. `input_revision` starts at 1
# and rises each time the inputs change, which clears `latest_run_id`; a run is recorded as the
# latest only against the revision whose inputs it used (`record_method_example_latest_run`). The
# build assistant keeps one example current with its test inputs, `kept_by_assistant`, through its
# own save (`save_assistant_method_example`), which never writes over a person's edit.

#: The largest integer a JavaScript number holds exactly, `Number.MAX_SAFE_INTEGER`: `@pipelex/sdk` refuses an
#: example whose `input_revision` lies past it in either direction, and so does `MethodExample`.
_LARGEST_EXACT_REVISION = 2**53 - 1


class MethodExample(BaseModel):
    """One saved example of a method.

    What `create_method_example`, `get_method_example`, `update_method_example`, both arms of
    `record_method_example_latest_run` and of `save_assistant_method_example` answer, and a row of
    `list_method_examples`.

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

    kept_by_assistant: StrictBool
    """Whether the build assistant keeps this example's inputs current with its test inputs: `True` on an
    example the assistant's save created, `False` on every other, and `False` from the first inputs change a
    person makes (`update_method_example` with new inputs). A rename leaves it as it is. Required, as
    `@pipelex/sdk` requires it: an example without it is an answer the SDK cannot read."""


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


class MethodExampleAssistantSaveOutcome(StrEnum):
    """What the build assistant's save did — the discriminant of `MethodExampleAssistantSaveResult`."""

    KEPT = "kept"
    """The named example was still the assistant's at the revision read, and now holds the inputs, its name untouched."""

    CREATED = "created"
    """No example was named, or a person's edit, another save or a deletion landed first: a new example
    flagged as the assistant's holds the inputs, under the save's `name`."""


class MethodExampleAssistantKept(BaseModel):
    """The named example now holds the assistant's inputs; `example` is the example as it now stands."""

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodExampleAssistantSaveOutcome.KEPT]
    example: MethodExample


class MethodExampleAssistantCreated(BaseModel):
    """A new example, flagged as the assistant's, holds the inputs; `example` is it, at revision 1."""

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodExampleAssistantSaveOutcome.CREATED]
    example: MethodExample


MethodExampleAssistantSaveResult: TypeAlias = Annotated[
    MethodExampleAssistantKept | MethodExampleAssistantCreated,
    Field(discriminator="outcome"),
]
"""The answer of `save_assistant_method_example`, a `200` discriminated on `outcome`. Finding that a person took
the assistant's example is the expected course of events whenever a person edits its inputs while it works, so it
is answered rather than raised. Branch on `outcome` (`match result:` over its classes); the `example` of either
arm is the assistant's from then on."""

MethodExampleAssistantSaveResultAdapter: TypeAdapter[MethodExampleAssistantSaveResult] = TypeAdapter(MethodExampleAssistantSaveResult)  # pylint: disable=invalid-name
"""The single parse path for an assistant save's answer — built once at import (TypeAdapter construction is expensive)."""


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
    image's size in pixels for a raster, oriented as a browser draws it, and for an SVG its `width` and
    `height` in pixels when both are in absolute units, which is the size a browser draws it at, else the
    width and height of its `viewBox`; an SVG's may be fractional. Their ratio is the logo's shape, which
    sizes its box before the image loads.
    """

    model_config = ConfigDict(extra="allow")

    uri: str
    """The platform's own copy of the logo, `pipelex-storage://<org_id>/branding/<uuid>.<ext>`, never the upload
    URI the write sent: the platform copies a logo it accepts, under a fresh uuid each time, so the same bytes
    attached again get a new URI. Sending it back unchanged in its slot keeps the logo. `resolve_storage_url`
    turns it into a short-lived link to its bytes."""

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
      keep it, or `None` to remove it. Any other URI, a run's or a method's file, a stale `branding/` copy
      or the other slot's logo, is refused as `logo_not_an_upload`, so a logo cannot move between slots by
      its URI. The platform reads and measures an upload before it accepts it, keeps its own copy under
      `branding/`, whose URI it answers, and erases the copy a write replaces or clears; the upload is left
      as it is.
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


class UploadKind(StrEnum):
    """What an upload is recorded as, sent with it to `POST /v1/upload` — the kinds a caller may claim.

    A subset of `FileKind`: no caller may claim to have generated a file, which only a run does, so
    `generated` is not a kind an upload carries.
    """

    UPLOADED = "uploaded"
    """A person's file, what an upload is recorded as when it names no kind."""

    TEST = "test"
    """A test input made for one method, such as the inputs a build assistant makes to try it, which
    names that method in `method_id`."""


class UploadInput(BaseModel):
    """Upload payload — base64 `data` (the multipart hop is browser→BFF only).

    `kind` and `method_id` say what the upload is recorded as and are sent only when given. `upload`
    sends them as they are and the upload route checks them, refusing with a `422` a `kind="test"`
    without a `method_id`, a `method_id` without `kind="test"`, and a `method_id` that is not a bare
    catalog id; `upload_file` and `prepare_inputs` check them first, before any file is read.
    """

    filename: str
    data: str
    content_type: str
    kind: UploadKind | None = None
    """What the upload is recorded as; the platform records `uploaded` when it is `None`."""
    method_id: str | None = None
    """The bare catalog id of the method a `test` file is for, required with `kind="test"` and refused
    without it."""


class UploadedFile(BaseModel):
    """An uploaded file's storage handle — `POST /v1/upload`: its reference, the name as sent and
    the `file_id` of the record the platform wrote for it.

    An answer with no non-empty `uri` names no stored file, so it does not validate, and `upload`
    raises the `ApiResponseError` of an answer the SDK cannot read, as `@pipelex/sdk` does.
    `file_id` is `None` only from a deployment that predates file records, which answers none.
    """

    model_config = ConfigDict(extra="allow")

    uri: str = Field(min_length=1)
    filename: str
    file_id: str | None = None


# ── An organization's files (`/v1/files`) ────────────────────────────────
#
# A file is the record the platform keeps of a stored object: a member's upload, a test file made
# for a method, or a file a run made that reached its result, each with the name a person sees, its
# type, its size and where it came from. A run, a form or an example still points at the bytes by
# their `pipelex-storage://` address, the record's `uri`, which a run's inputs take as they take any
# address (see `docs/files.md`). The values a later platform may add to (a kind, a role, a mark)
# are read open: the enum member when this SDK knows the value, its raw string otherwise, so a
# `match` on one needs a branch for a string. The fields a caller branches on to act (an archive's
# `state`, a run's files' `state`, a copy's `blob`) are read closed, as `@pipelex/sdk` checks them.


class FileKind(StrEnum):
    """What made a file. Read open on `FileSummary.kind`; also the `kind` filter of `list_files`."""

    UPLOADED = "uploaded"
    """A person's upload, or a run's inline input."""

    GENERATED = "generated"
    """A file a run made whose result reaches it."""

    TEST = "test"
    """A test input made for one method, which its `origin.method_id` names."""


class FileOrigin(BaseModel):
    """Who or what made a file, as far as the platform knows it.

    Each kind fills a different part, and the rest is `None`: an upload names the surface it came
    through; a generated file or a run's inline input names the run, its method and the version or draft
    that ran; a test file names the surface it came through and the method it was made for. The member
    a file is attributed to is the record's `created_by`, never repeated here.
    """

    model_config = ConfigDict(extra="allow")

    surface: str | None = None
    """The surface an upload came through, as its request's `User-Agent` declared it (`app`, `mcp`, `cli`,
    `n8n`, `hook`, `sdk`, `raw_http`, and more as surfaces are added); `None` for a run's files.
    Self-declared, so it is provenance to show, never authority."""

    run_id: str | None = None
    """The run that made the file; `None` for an upload."""

    method_id: str | None = None
    """The method whose run made the file, or the method a test file was made for; `None` otherwise."""

    method_version: int | Literal["draft"] | None = None
    """The published version number or `"draft"` that ran, for a file made by a saved method's run."""


class FileSummary(BaseModel):
    """One row of a file list, what a list or a picker shows — `list_files`.

    A list never holds a file a run made along the way, nor an upload whose bytes have not been seen stored.
    """

    model_config = ConfigDict(extra="allow")

    file_id: str
    """The record's id, `fl_…`."""

    uri: str
    """The `pipelex-storage://` address of the bytes, which a run's inputs take as they take any address."""

    name: str
    """The name shown and used for downloads; it starts as the name the file arrived with and changes with a rename."""

    media_type: str
    """The MIME type the object is stored under."""

    format: str
    """The format key the list's `formats` filter matches: `pdf`, `docx`, `image`, `html` and the rest of the runtime's table."""

    size: int
    """The byte size."""

    kind: Annotated[FileKind | str, Field(union_mode="left_to_right")]
    """What made the file: the `FileKind` member when this SDK knows the kind, its raw string otherwise."""

    origin: FileOrigin

    created_at: str
    """ISO-8601 instant the record was made."""

    created_by: str
    """The member the file is attributed to: the uploader, or the member who started the run that made it."""


class FilePage(BaseModel):
    """One page of an organization's files, newest first (in the order of their addresses under `run_id`).

    `next_cursor` is opaque: pass it straight back to `list_files` with the same filters to continue;
    `None` means this was the last page. A filtered page can hold fewer rows than `limit`, or none, and
    still carry a `next_cursor`: only a `None` cursor ends the list, and `iterate_files` keeps following
    the cursor through such a page.
    """

    model_config = ConfigDict(extra="allow")

    items: list[FileSummary]
    next_cursor: str | None


class FileRole(StrEnum):
    """For a file a run made, whether the run's result reaches it. Read open on `FileRecord.role`."""

    FINAL = "final"
    """An output of the run."""

    INTERMEDIATE = "intermediate"
    """A file made along the way, which no list of the organization's files holds."""


class FileState(StrEnum):
    """Whether a file's bytes are stored. Read open on `FileRecord.state`."""

    STORED = "stored"
    PENDING = "pending"
    """An upload whose bytes have not been seen; only a read by id or by address answers one."""


class FileRecord(FileSummary):
    """One file's whole record — what `rename_file` answers, each record `get_files_by_uri` lists, and the
    `file` of a run's file entry; `get_file` answers it with its methods and uses (`FileDetail`).
    """

    source_uri: str | None = None
    """The address the record was written under, once another run or an example took the file and the
    platform copied it into the organization's `assets/`; `uri` is then the copy's. `None` until then."""

    original_name: str
    """The name the file arrived with, never changed: a rename changes `name` alone."""

    sha256: str | None = None
    """The SHA-256 of the bytes in lowercase hexadecimal, or `None` for a file stored before every writer sent one."""

    role: Annotated[FileRole | str | None, Field(union_mode="left_to_right")] = None
    """For a file a run made, `final` or `intermediate`; `None` for the other kinds."""

    state: Annotated[FileState | str, Field(union_mode="left_to_right")]
    """`stored`, or `pending` while an upload's bytes have not been seen."""


class FileUseHolderType(StrEnum):
    """What holds an address a use links. Read open on `FileUse.holder_type`."""

    RUN = "run"
    """A run that took the address as an input."""

    EXAMPLE = "example"
    """An example whose inputs hold the address."""


class FileUse(BaseModel):
    """An address taken as an input by a run, or held by an example.

    A use names an address, not a record, so every record holding the address shows the same uses; a
    file a run made names that run in its `origin`, never as a use.
    """

    model_config = ConfigDict(extra="allow")

    uri: str
    """The `pipelex-storage://` address used."""

    holder_type: Annotated[FileUseHolderType | str, Field(union_mode="left_to_right")]

    holder_id: str
    """The run's id or the example's id."""

    method_id: str | None = None
    """The method of the run or of the example; `None` for a run of no saved method."""

    created_at: str
    """ISO-8601 instant the use was recorded."""


class FileUsePage(BaseModel):
    """One page of a file's uses, the examples that hold its address first, then the runs that took it.

    Pass `next_cursor` back to `get_file` as `uses_cursor` for the next page; `None` means there is none.
    """

    model_config = ConfigDict(extra="allow")

    items: list[FileUse]
    next_cursor: str | None


class FileDetail(FileRecord):
    """One file with what links it to the organization's methods, runs and examples — `get_file`."""

    method_ids: list[str]
    """The methods whose list of files holds this one, because one of their runs or examples took or made it."""

    uses: FileUsePage
    """One page of the file's uses."""


class FileRecordList(BaseModel):
    """The records holding one address — `get_files_by_uri` — in the order a surface picks the one to show, the first being it.

    Empty for an address no record holds, such as a file stored before the platform kept records.
    """

    model_config = ConfigDict(extra="allow")

    items: list[FileRecord]


class FileLinkTarget(BaseModel):
    """One file to link — `link_files` — named by exactly one of its record's id and its address.

    `FileLinkTarget(file_id="fl_…")` or `FileLinkTarget(uri="pipelex-storage://…")`. Both, neither, or an
    empty one raise pydantic's `ValidationError` at construction, as the platform would refuse the whole
    request with a `422`; `None` reads as not given.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    file_id: str | None = Field(default=None, min_length=1)
    uri: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _names_exactly_one(self) -> Self:
        if (self.file_id is None) == (self.uri is None):
            msg = "name the file to link by exactly one of `file_id` and `uri`"
            raise ValueError(msg)
        return self


class FileLinkError(BaseModel):
    """Why one file got no link — a value, never a raised error.

    `code` is `not_found` (an unknown file, or one deleted meanwhile), `conflict` (a file whose upload has
    not finished), `invalid_storage_uri` (a malformed address) or `forbidden` (another organization's
    address), and stays a `str` so a code a later platform adds still reads; `detail` is the sentence a
    person reads.
    """

    model_config = ConfigDict(extra="allow")

    code: str
    detail: str


class FileLinked(BaseModel):
    """A requested file's link: a presigned `GET` valid for fifteen minutes, and `error` is `None`."""

    model_config = ConfigDict(extra="allow")

    file_id: str | None
    """The record linked: the one asked for, or for an address, the record whose name the link carries;
    `None` for an address no record holds, a file stored before records existed."""

    uri: str
    """The address the link reads."""

    name: str
    """The name the download saves under, which the link's `Content-Disposition` carries."""

    media_type: str
    """The file's type, which decides whether a browser shows it in place or downloads it."""

    url: str
    """A presigned `GET` of the file, valid for fifteen minutes; a bearer capability, so keep it out of logs."""

    expires_at: str
    """ISO-8601 UTC instant the link stops working."""

    error: None


class FileLinkRefused(BaseModel):
    """A requested file that got no link: `error` says why, and the link fields are `None`."""

    model_config = ConfigDict(extra="allow")

    file_id: str | None
    """The file id as requested, or `None` when the file was named by its address."""

    uri: str | None
    """The address as requested, or `None` when the file was named by its id."""

    name: None
    media_type: None
    url: None
    expires_at: None
    error: FileLinkError


FileLink: TypeAlias = FileLinked | FileLinkRefused
"""One requested file's link, or why it has none. Branch on the class (`match link:`), never on the HTTP status:
the request is a `200` whenever every file got a verdict."""


class FileLinksResult(BaseModel):
    """The answer of `link_files`: exactly one `FileLink` per requested file, in the request's order.

    Read with the count of files requested in its validation context (`requested_files`), so an answer
    holding another count is refused as one the SDK cannot read.
    """

    model_config = ConfigDict(extra="allow")

    items: list[FileLink]

    @model_validator(mode="after")
    def _one_item_per_requested_file(self, info: ValidationInfo) -> Self:
        context = cast("object", info.context)
        requested = cast("dict[str, object]", context).get("requested_files") if isinstance(context, dict) else None
        if isinstance(requested, int) and len(self.items) != requested:
            msg = f"an answer to a request for {requested} file(s) holds {len(self.items)} item(s)"
            raise ValueError(msg)
        return self


class FileArchiveState(StrEnum):
    """Where an archive stands, the field a caller branches on. Read closed, as `@pipelex/sdk` checks it."""

    QUEUED = "queued"
    """Read it again shortly."""

    BUILDING = "building"
    """Read it again shortly."""

    READY = "ready"
    """Its `url` downloads the zip."""

    FAILED = "failed"
    """Its `failure` says why; a new request is the remedy."""


class FileArchiveSource(StrEnum):
    """How an archive's files were chosen. Read open on `FileArchive.source`."""

    FILES = "files"
    """By their ids, `file_ids`."""

    RUN = "run"
    """As one run's files, `run_id`."""


class FileArchiveFailureCode(StrEnum):
    """Why an archive failed. Read open on `FileArchiveFailure.code`; asking again is the remedy for both."""

    FILE_GONE = "file_gone"
    """A selected file was deleted before the zip was ready."""

    BUILD_FAILED = "build_failed"
    """The build failed, or did not finish within the hour, or the archive could not be queued."""


class FileArchiveFailure(BaseModel):
    """What a failed archive says about its failure."""

    model_config = ConfigDict(extra="allow")

    code: Annotated[FileArchiveFailureCode | str, Field(union_mode="left_to_right")]
    detail: str
    """A sentence for a person, naming the file when one was gone."""


class FileArchive(BaseModel):
    """One zip of an organization's files — what `request_file_archive` (`queued`) and `get_file_archive` answer.

    An archive is never a file: no list shows it, and it is gone a day after it was asked for, past
    `expires_at`, when reading it answers `404`.
    """

    model_config = ConfigDict(extra="allow")

    archive_id: str
    """The archive's id, `arc_…`."""

    name: str
    """The name the zip downloads under, ending in `.zip`."""

    state: FileArchiveState

    source: Annotated[FileArchiveSource | str, Field(union_mode="left_to_right")]

    run_id: str | None = None
    """The run whose files the archive holds, for a `run` archive; `None` otherwise."""

    file_count: int
    """How many files the zip holds."""

    total_bytes: int
    """The files' total size in bytes, before compression."""

    created_at: str
    """ISO-8601 instant the archive was asked for."""

    expires_at: str
    """ISO-8601 instant after which the archive is gone and reads as unknown, a day after `created_at`."""

    archive_bytes: int | None = None
    """The zip's own size in bytes, once it is ready; `None` until then."""

    ready_at: str | None = None
    """ISO-8601 instant the zip was complete; `None` until then."""

    failure: FileArchiveFailure | None = None
    """Why the archive failed; `None` unless `state` is `failed`."""

    url: str | None = None
    """A presigned `GET` of the zip, valid for fifteen minutes and signed with a `Content-Disposition` naming
    `name`, set only on a read of a `ready` archive; each read signs a fresh one. A bearer capability, so keep
    it out of logs."""

    url_expires_at: str | None = None
    """ISO-8601 instant `url` stops working; `None` without a link."""


class FileArchiveLimit(BaseModel):
    """The cap a `422` `file_archive_too_large` names, in its problem document's `limit` member.

    Read it with `FileArchiveLimit.model_validate(error.problem_document["limit"])`: `max_files` (500) or
    `max_total_bytes` (2,000,000,000), its `value`, and what the selection `reached`. For a run, the count
    stops as soon as it passes the cap, so `reached` is one more than `max_files` and means "at least".
    """

    model_config = ConfigDict(extra="allow")

    name: Literal["max_files", "max_total_bytes"]
    value: int
    reached: int


class DraftFileBlob(StrEnum):
    """What the copy into a draft did in the organization's blob store, the field its answer is discriminated on."""

    COPIED = "copied"
    """The bytes were copied under their SHA-256."""

    ALREADY_HELD = "already_held"
    """The store held the bytes, and nothing was copied."""


class DraftFileAdded(BaseModel):
    """The copied file as the draft's tree now names it."""

    model_config = ConfigDict(extra="allow")

    path: str
    """Its tree path."""

    sha256: str
    """The SHA-256 of its bytes, in lowercase hexadecimal."""

    size: int
    """Its size in bytes."""


class DraftFileFromFileResult(BaseModel):
    """The answer of `copy_file_into_draft`, a `200` discriminated on `blob`.

    Both values carry the file as the draft names it and the method as the draft write stored it, whose
    `updated_at` is the new draft token.
    """

    model_config = ConfigDict(extra="allow")

    blob: DraftFileBlob
    file: DraftFileAdded
    method: MethodData


class RunFilesState(StrEnum):
    """Whether a run's records are all written, the field a reader of its files branches on. Read closed."""

    LISTING = "listing"
    """The platform is still recording the run's files: read the page again before taking it as whole."""

    LISTED = "listed"
    """Every file of the run is recorded."""


class RunFileMark(StrEnum):
    """Where a file sits in its run. Read open on `RunFileEntry.mark`."""

    INPUT = "input"
    """What went in."""

    FINAL = "final"
    """What came out."""

    INTERMEDIATE = "intermediate"
    """What was made along the way."""


class RunFileEntry(BaseModel):
    """One file of a run, with its mark and the record a surface shows for it."""

    model_config = ConfigDict(extra="allow")

    mark: Annotated[RunFileMark | str, Field(union_mode="left_to_right")]

    input_name: str | None = None
    """For an input given by its address, the run's input that held it; `None` for an inline input and for
    the files the run made."""

    uri: str
    """The address the run took or wrote; a record a take moved to a copy says where it lives now in its own `uri`."""

    file: FileRecord | None = None
    """The record a surface shows for the file: for an input, the one of the member who started the run first,
    then the caller's, then the oldest. `None` for an input address no record holds."""


class RunInputLink(BaseModel):
    """A web link the run's inputs held, which gets no record: the platform neither fetched nor kept what it served."""

    model_config = ConfigDict(extra="allow")

    input_name: str
    """The run's input that held the link."""

    url: str
    """The link, as the run was given it."""

    warning: str
    """Why the link matters to a replay of the run: it must still serve the same file."""


class RunFilesPage(BaseModel):
    """One page of a run's files, sorted by where they sit in the run — `list_run_files`.

    The inputs given by their address and the web links come on the first page only; the run's own records,
    its inline inputs, its final outputs and the files it made along the way, are paged by address.
    `next_cursor` is opaque: pass it straight back to `list_run_files`; `None` is the last page. `state` is
    `listing` until the platform has recorded every file of the run, a few seconds after it ends, so a client
    showing a run that just ended reads it again until it is `listed`.
    """

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: str
    state: RunFilesState
    inputs: list[RunFileEntry]
    """What went in: the inputs by address (first page only), then the inline inputs."""

    outputs: list[RunFileEntry]
    """What came out: the run's final outputs."""

    intermediates: list[RunFileEntry]
    """What was made along the way."""

    links: list[RunInputLink]
    """The web links the inputs held (first page only)."""

    next_cursor: str | None


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
