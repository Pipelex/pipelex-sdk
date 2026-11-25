"""The artifact stack's wire models, options and verdict — the shapes `pipelex_sdk.artifacts`
produces and consumes, and the defaults its operations apply.

They live in a module of their own, beside `product_models` and `crate_models`, because
`pipelex_sdk.errors` types two of its artifact errors with them (`ScopeUnavailableError.scope`,
`ArtifactAuthenticationError.verdict`) and the operations module imports those errors — one home for
the shapes keeps that from being an import cycle. Mirrors the types of `pipelex-sdk-js`'s
`src/artifacts.ts`, which needs no such split because TypeScript tolerates the cycle.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from pipelex_sdk._pydantic_utils import empty_list_factory_of
from pipelex_sdk.runs import RunArtifact
from pipelex_sdk.stored_texts import StoredTextKind

# ── Constants ────────────────────────────────────────────────────────

#: The scheme of a durable storage reference.
PIPELEX_STORAGE_SCHEME = "pipelex-storage://"

#: How many references one bulk resolve request takes — the route's bound, fixed by the platform
#: contract rather than configured per deployment. A longer list is a `422`, so `resolve_artifacts`
#: chunks at this size.
BULK_RESOLVE_MAX_URIS = 100

#: The per-file byte cap. An accident guard against filling a disk from a runaway output, not a
#: judgment about artifact size: a produced file is server-side, so a caller cannot shrink it the
#: way they can shrink an upload.
DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024

#: The per-file budget for connecting, receiving the headers and reading the body.
DEFAULT_ARTIFACT_TIMEOUT_SECONDS = 120.0

#: The cap on the bytes one `download_artifacts` call writes in total.
DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024

#: How many artifacts one `download_artifacts` call has in flight at once.
DEFAULT_DOWNLOAD_CONCURRENCY = 4

#: The cap on one stored text's bytes `load_stored_texts` applies: the runtime's own cap on what it
#: reads from storage.
DEFAULT_STORED_TEXT_MAX_BYTES = 100 * 1024 * 1024

#: The cap on the bytes of all the stored texts of one `load_stored_texts` call together. Every loaded value is held
#: until the load ends, as bytes and then as a string that can take several times as many, so the load itself must be
#: bounded, not only each text: 256 MiB leaves room for two texts at the per-text cap while keeping what one load holds
#: to a few hundred MiB of the process's memory.
DEFAULT_STORED_TEXT_MAX_TOTAL_BYTES = 256 * 1024 * 1024

#: How many stored texts one `load_stored_texts` call reads at once.
DEFAULT_STORED_TEXT_CONCURRENCY = 8

#: The `StoredTextLoadError` reason of a result that cannot say which of its values are stored texts
#: (`pipelex_sdk.artifacts.lacks_stored_text_concepts`); `wait_for_result` keeps polling through it for a while.
STORED_TEXT_CONCEPTS_MISSING = "concepts_missing"


# ── Types ────────────────────────────────────────────────────────────


class ArtifactScope(StrEnum):
    """Which of a run's artifacts `download_artifacts` walks for references."""

    MAIN_STUFF = "main_stuff"
    WORKING_MEMORY = "working_memory"

    @property
    def results_field(self) -> str:
        """The `RunResults` field this scope walks."""
        match self:
            case ArtifactScope.MAIN_STUFF:
                return "main_stuff"
            case ArtifactScope.WORKING_MEMORY:
                return "working_memory"

    @property
    def run_artifact(self) -> RunArtifact:
        """The one result artifact this scope needs, so a download by run id reads nothing else."""
        match self:
            case ArtifactScope.MAIN_STUFF:
                return RunArtifact.MAIN_STUFF
            case ArtifactScope.WORKING_MEMORY:
                return RunArtifact.WORKING_MEMORY


class ArtifactItemError(BaseModel):
    """Why one reference failed — a value, never a raised error.

    `code` is the resolve route's own per-reference code (`pipelex.storage.uri_invalid`, `pipelex.org.mismatch`, and a
    self-hosted runner's `auth.forbidden` whose `requirement` is `read_scope_under_caller` for a reference outside the
    caller's scope) or one of the fetch boundary's (see `ArtifactFetchError`), plus the download's own
    `resolve_failed`, `total_limit_exceeded`, `write_failed` and `aborted`. `detail` is the sentence a person reads,
    and `params` the parameters the route's code declares, when the route sent them.
    """

    model_config = ConfigDict(extra="allow")

    code: str
    detail: str
    params: dict[str, Any] | None = None

    @property
    def requirement(self) -> str | None:
        """The `requirement` the route's refusal names in its `params`, when it names one."""
        requirement = (self.params or {}).get("requirement")
        return requirement if isinstance(requirement, str) else None


class ResolvedArtifact(BaseModel):
    """One reference's resolution — the bulk resolve route's item, verbatim.

    Either the link fields are set and `error` is `None`, or `error` is set and the three link fields
    are `None`. A consumer branches on `error`, never on an HTTP status: the request was a `200`
    whenever every reference got a verdict.
    """

    model_config = ConfigDict(extra="allow")

    #: The reference exactly as sent.
    uri: str
    #: A presigned link, fetchable now and for about fifteen minutes.
    url: str | None = None
    #: UTC expiry of the link, ISO 8601.
    expires_at: str | None = None
    #: The platform's content-type guess from the reference's extension; `None` when it has none.
    content_type: str | None = None
    error: ArtifactItemError | None = None


class BulkResolvedStorageUrls(BaseModel):
    """The wire response of `POST /v1/resolve-storage-url/bulk` — one item per requested reference,
    in request order.
    """

    model_config = ConfigDict(extra="allow")

    items: list[ResolvedArtifact] = Field(default_factory=empty_list_factory_of(ResolvedArtifact))


class FetchArtifactOptions(BaseModel):
    """The bounds `fetch_artifact` applies. Every one has a safe default."""

    model_config = ConfigDict(extra="forbid")

    #: Refuse (before a byte is read) and cut (mid-stream) a body over this many bytes. Default 1 GiB.
    max_bytes: int = DEFAULT_ARTIFACT_MAX_BYTES
    #: Budget for the whole exchange — connect, headers and body. Default 120 s.
    timeout_seconds: float = DEFAULT_ARTIFACT_TIMEOUT_SECONDS
    #: Accept a plain `http:` link on any origin. Off by default: a general-purpose library does not
    #: fetch over plain http silently. A plain `http:` link on the origin of the client's configured
    #: base URL, which a self-hosted runner hands out, is accepted without it, since the client
    #: already sends its API key there. The local compose stack's object store hands out plain
    #: `http:` links on another origin, which is the case this opts into.
    allow_http: bool = False


class LoadStoredTextsOptions(BaseModel):
    """The bounds `load_stored_texts` applies. Every one has a safe default."""

    model_config = ConfigDict(extra="forbid")

    #: Refuse a stored text over this many bytes: against the size its reference states before anything is sent,
    #: then while reading it. Default 100 MiB, the runtime's own cap on what it reads from storage, so a text the
    #: runtime could read is never one the SDK refuses.
    max_bytes: int = DEFAULT_STORED_TEXT_MAX_BYTES
    #: Refuse the load once its stored texts together cross this many bytes: against the sizes their references state
    #: before anything is sent, then counted as the bytes arrive, every read in flight then stopped. Default 256 MiB
    #: (`DEFAULT_STORED_TEXT_MAX_TOTAL_BYTES`).
    max_total_bytes: int = DEFAULT_STORED_TEXT_MAX_TOTAL_BYTES
    #: Budget for each text's exchange — connect, headers and body. Default 120 s.
    timeout_seconds: float = DEFAULT_ARTIFACT_TIMEOUT_SECONDS
    #: Accept a plain `http:` link on any origin, as the local stack's object store hands out. Off by default; a
    #: plain `http:` link on the origin of the client's configured base URL is accepted without it.
    allow_http: bool = False
    #: How many texts are read at once. Default 8.
    concurrency: int = DEFAULT_STORED_TEXT_CONCURRENCY


class DownloadArtifactsOptions(FetchArtifactOptions):
    """The bounds and choices of one `download_artifacts` call, the per-file ones included."""

    #: `main_stuff` (the default) walks the run's main output. `working_memory` is the opt-in that
    #: also brings down the echoed inputs and every intermediate.
    scope: ArtifactScope = ArtifactScope.MAIN_STUFF
    #: How many artifacts are in flight at once. Default 4.
    concurrency: int = DEFAULT_DOWNLOAD_CONCURRENCY
    #: Cap on the bytes written by the whole call. Default 4 GiB. The item that would cross it is an
    #: item error; every later item is checked against the room the saved files leave.
    max_total_bytes: int = DEFAULT_DOWNLOAD_MAX_TOTAL_BYTES


class ArtifactLocation(BaseModel):
    """Where one `pipelex-storage://` reference sits in a walked value — what `locate_artifacts`
    answers per reference. `found_at` lists every path at which the reference occurs, in walk order,
    and is never empty: `found_at[0]` is where it was first seen, and the path a saved file is named
    after.

    A path is `$`-rooted: `$` is the walked value itself, an object key matching
    `^[A-Za-z_][A-Za-z0-9_]*$` is `.key`, any other key is `["…"]` in JSON string escaping, and an
    array index is `[n]` — `$.rooms[3].staged_photo.url`, `$.items[0].url`, `$["a key"].url`. It is
    the exact path of the string, the final `url` of a content object included.
    """

    #: The reference, exactly as it appears in the walked value.
    uri: str
    #: Every `$`-rooted path at which the reference occurs, in walk order.
    found_at: list[str]


class StoredTextLocation(ArtifactLocation):
    """Where one stored text sits in a walked value — a value the runtime holds by its `pipelex-storage://` reference,
    `{url, size, mime_type, preview}`, in place of its value field. `found_at` is the path of the reference's `url`, in
    the notation of `ArtifactLocation`, and the other fields are what the reference states, `None` when it states none.
    `artifact_filename` names its file by `mime_type`.
    """

    #: What the text holds once loaded: a text, an HTML fragment or a JSON object.
    kind: StoredTextKind
    #: The stored value's length in bytes.
    size: int | None = None
    #: The stored value's MIME type, which names its file when it is saved.
    mime_type: str | None = None
    #: The value's first characters.
    preview: str | None = None


class StoredReferences(BaseModel):
    """The storage references of a walked value, told apart by concept: the stored files, which `locate_artifacts`
    answers, and the stored texts.
    """

    files: list[ArtifactLocation] = Field(default_factory=empty_list_factory_of(ArtifactLocation))
    texts: list[StoredTextLocation] = Field(default_factory=empty_list_factory_of(StoredTextLocation))


class DownloadedKind(StrEnum):
    """What a reference of a download names: a stored file, or a stored text saved as a text file."""

    FILE = "file"
    TEXT = "text"

    @property
    def is_text(self) -> bool:
        match self:
            case DownloadedKind.FILE:
                return False
            case DownloadedKind.TEXT:
                return True


class DownloadedArtifact(ArtifactLocation):
    """One reference's outcome in a download verdict — one shape with nullable fields, like
    `ResolvedArtifact`: either `path` and `size` are set and `error` is `None`, or `error` is set and
    both are `None`. `found_at` says where the reference sits in the walked scope, the first path
    being the one that named the file, and `content_type` is the platform's guess from the
    reference's extension, known before the fetch; both are on both arms, so an item that was not
    saved still says which field it would have filled.

    It is an `ArtifactLocation`, so `artifact_filename` takes a verdict item as it is.
    """

    #: A stored file, or a stored text saved as a text file named by its MIME type.
    kind: DownloadedKind
    #: Absolute path of the written file.
    path: str | None = None
    content_type: str | None = None
    #: Bytes written.
    size: int | None = None
    error: ArtifactItemError | None = None


class DownloadArtifactsResult(BaseModel):
    """The produced verdict of `download_artifacts`.

    `len(artifacts)` is the count of references walked, errors included; an empty list over a present
    scope is a verdict ("this output references no stored file"), not an error.
    """

    scope: ArtifactScope
    #: One entry per reference, in discovery order.
    artifacts: list[DownloadedArtifact] = Field(default_factory=empty_list_factory_of(DownloadedArtifact))
    #: The absolute paths of the files saved, in the same order.
    saved_paths: list[str] = Field(default_factory=list)
    #: True when every walked reference was saved — vacuously true for an empty walk.
    all_saved: bool
