"""The artifact stack — the download twin of `prepare_inputs`, in layers so each operation is
usable without the next:

- `locate_artifacts(value)` — a pure walk of any JSON-shaped value for the strings that ARE
  `pipelex-storage://` references, each with every `$`-rooted path it sits at. `collect_artifacts`
  is the same walk's bare references. No network, no key.
- `resolve_artifacts(client, uris)` — the platform's bulk resolve route over a whole list,
  chunked at the route's bound, one verdict per reference.
- `fetch_artifact(client, uri)` — an async context manager yielding a bounded stream for one
  reference: resolved fresh, timed out, redirects refused, the byte cap enforced mid-stream, no
  credentials forwarded, headers neutral.
- `download_artifacts(client, ...)` — a run's produced files saved under a directory by a bounded
  pool of tasks, each named after the field it fills (`artifact_filename`), as a produced verdict.

A produced file is never embedded in a run's results: the content carries its durable
`pipelex-storage://` reference beside a signed `public_url` that expires on the provider's
schedule. Nothing here reads that embedded link — every link is minted fresh by the platform, and
re-minted when it has expired by the time a task reaches it. See `docs/artifact-download.md`.

Python counterpart of `pipelex-sdk-js`'s `src/artifacts.ts`, with the idiomatic ports the SDK
already makes elsewhere: seconds instead of milliseconds, an `asyncio.Semaphore` instead of a
worker pool, `asyncio` cancellation instead of an `AbortSignal`, and an async context manager
instead of a returned `Response` (an httpx stream is only live inside its own block).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import errno
import json
import math
import os
import re
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any, BinaryIO, Protocol, TypeAlias, cast
from urllib.parse import unquote, unquote_to_bytes, urlsplit

import httpx
from httpx._decoders import SUPPORTED_DECODERS  # ruff: ignore[import-private-name]
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.problem.client_problems import make_client_problem
from mthds.protocol.problem.registry import CoreCode
from mthds.runners.api.problem import transport_failure_problem
from pydantic import BaseModel, ValidationError

from pipelex_sdk._answer_json import dumps_as_javascript
from pipelex_sdk._url_origin import ComparableOrigin, comparable_origin
from pipelex_sdk.artifact_models import (
    BULK_RESOLVE_MAX_URIS,
    PIPELEX_STORAGE_SCHEME,
    STORED_TEXT_CONCEPTS_MISSING,
    ArtifactItemError,
    ArtifactLocation,
    ArtifactScope,
    BulkResolvedStorageUrls,
    DownloadArtifactsOptions,
    DownloadArtifactsResult,
    DownloadedArtifact,
    DownloadedKind,
    FetchArtifactOptions,
    LoadStoredTextsOptions,
    ResolvedArtifact,
    StoredReferences,
    StoredTextLocation,
)
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    ArtifactAuthenticationError,
    ArtifactFetchError,
    ArtifactOperationError,
    FieldNotIncludedError,
    RunFailedError,
    RunStillRunningError,
    ScopeUnavailableError,
    StoredTextLoadError,
    argument_invalid_problem,
    response_unreadable_problem,
)
from pipelex_sdk.runs import RunArtifact, RunResultCompleted, RunResultFailed, RunResultRunning, RunResults
from pipelex_sdk.stored_texts import (
    STORED_TEXT_REFERENCE_FIELDS,
    STORED_TEXT_VALUE_FIELDS,
    StoredTextKind,
    child_node,
    describes_concept,
    main_stuff_concept_ref,
    main_stuff_node,
    stored_text_kind_of_node,
    working_memory_node,
)

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator, AsyncIterator, Sequence
    from contextlib import AbstractAsyncContextManager

    from mthds.protocol.input_form import InputFormItem
    from mthds.protocol.problem.models import Problem

    from pipelex_sdk.runs import RunResultState

# ── Constants ────────────────────────────────────────────────────────

#: A link this close to its `expires_at` is re-resolved rather than fetched: the object store checks
#: the signature when the request arrives, and a few seconds of clock skew between the platform and
#: this process must not turn a link the platform still considers live into a `403`.
_EXPIRY_MARGIN_SECONDS = 10.0

#: Longest filename `download_artifacts` writes, extension included.
_MAX_FILENAME_LENGTH = 128

#: Longest extension taken from a storage key, dot excluded. Anything longer after the key's last
#: dot is read as part of a name rather than as an extension, and the content type's extension is
#: used instead.
_MAX_EXTENSION_LENGTH = 10

#: Stems Windows reserves for a device, in any case and whatever the extension: `aux.png` there
#: names the auxiliary device, not a file. A stem is a field name the method author chose, so
#: `$.aux.url` would otherwise reach one.
_WINDOWS_DEVICE_STEM = re.compile(r"con|prn|aux|nul|com[0-9]|lpt[0-9]", re.IGNORECASE)

#: An object key rendered as `.key` in a path; any other key is rendered as `["…"]`.
_IDENTIFIER_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

#: The three steps a rendered path is read back from, each matched where the last one ended.
_KEY_STEP = re.compile(r"\.([A-Za-z_][A-Za-z0-9_]*)")
_INDEX_STEP = re.compile(r"\[([0-9]+)\]")
_QUOTED_STEP = re.compile(r'\[("(?:[^"\\]|\\.)*")\]', re.DOTALL)

#: A `%` that does not open a two-digit escape, which makes `decodeURIComponent` refuse the segment.
_BARE_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")

#: Ceiling on collision suffixes before the never-overwrite rule gives up.
_MAX_UNIQUE_ATTEMPTS = 10_000

#: How much of a body one read takes before it is written.
_STREAM_CHUNK_BYTES = 64 * 1024

#: The extension to add when the storage key has none and the resolved content type is one of the
#: artifact types a run produces. Deliberately short: an unknown type simply gets no extension,
#: never a guessed one.
_EXTENSION_BY_CONTENT_TYPE: dict[str, str] = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
    "text/csv": ".csv",
    "application/json": ".json",
}

#: The extension a saved stored text takes from the MIME type its reference states, the text types the runtime stores
#: as. A stored text is named by its MIME type, never by its storage key.
_TEXT_EXTENSION_BY_MIME_TYPE: dict[str, str] = {
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
    "application/json": ".json",
}

#: The codings the installed httpx decodes for us, read from its own decoder table (the one place
#: that knows): `br` and `zstd` join it only when their optional packages are installed, and
#: `x-gzip` never does. A coding it did not decode keeps its header, since the bytes handed on are
#: still encoded.
_DECODED_CODINGS = frozenset(SUPPORTED_DECODERS) - {"identity"}

_SKIPPED_CREDENTIAL = "The download stopped on a credential failure before this artifact was fetched."


# ── The client surfaces the operations need ──────────────────────────


class BulkResolveClient(Protocol):
    """The client surface `resolve_artifacts` needs — the raw bulk resolve call. Typed as
    `PipelexAPIClient.resolve_storage_urls_bulk`'s own signature, so the client satisfies it
    structurally and a test can inject a fake.
    """

    async def resolve_storage_urls_bulk(self, uris: list[str]) -> BulkResolvedStorageUrls: ...


class ArtifactFetchClient(BulkResolveClient, Protocol):
    """What the operations that fetch a resolved link need on top — `fetch_artifact` and `load_stored_texts`: the
    origin the client is configured with, the one on which a plain-http link is fetched without `allow_http`.
    """

    @property
    def origin_url(self) -> str:
        """The origin (`scheme://host[:port]`) of the client's configured base URL. A resolved link on it
        is fetched over plain http without `allow_http`, since the client already sends its API key there.
        """
        ...


class ArtifactCapableClient(ArtifactFetchClient, Protocol):
    """What `download_artifacts` needs on top: the single-shot result lookup, for the `run_id` arm and for
    the concepts that tell a stored text from a file.
    """

    async def get_run_result(
        self,
        run_id: str,
        *,
        artifacts: Sequence[RunArtifact] | None = None,
        load_stored_texts: bool = True,
    ) -> RunResultState: ...


# ── locate_artifacts / collect_artifacts ─────────────────────────────

#: One step of a path into a walked value: an object key, or an array index.
_PathSegment: TypeAlias = str | int


@dataclass
class _LocatedReference:
    """A reference as the walk records it: the raw segments of every path it was found at.

    `download_artifacts` names its files from these segments directly, so it never parses a rendered
    path back; `found_at` is only their rendering.
    """

    uri: str
    paths: list[tuple[_PathSegment, ...]]
    #: Set for a stored text's reference, found only when the walk was asked for texts.
    text_kind: StoredTextKind | None = None
    text_reference: dict[str, Any] | None = None


def is_storage_reference(value: str) -> bool:
    """A string that IS a storage reference: the scheme, then at least one character."""
    return value.startswith(PIPELEX_STORAGE_SCHEME) and len(value) > len(PIPELEX_STORAGE_SCHEME)


def is_loadable_stored_text_url(url: str) -> bool:
    """A `url` a stored text may be loaded from: a `pipelex-storage://` reference, resolved through the platform's bulk
    route to a link it signs, or a `data:` URL, decoded where it is. A stored text at any other URL is never fetched, so a
    method cannot have the SDK read a host the caller did not choose: the loader refuses it as `unsupported_url`.

    The file walks (`locate_stored_references`, `download_artifacts`) report the first kind only, since a `data:` URL
    holds its value inline and has nothing to resolve or save.
    """
    return is_storage_reference(url) or url.startswith("data:")


def _stored_text_reference_url(value: Any, kind: StoredTextKind) -> str | None:
    """The `url` of a stored text's reference, `value` sitting where the concept is a stored text: an object carrying a
    string `url` and no value field. `None` for anything else, an inline value included. The one recognition the walk
    and the loader share, each then applying its own rule to the URL.
    """
    if not isinstance(value, dict):
        return None
    reference = cast("dict[str, Any]", value)
    url = reference.get("url")
    if not isinstance(url, str) or reference.get(kind.value_field) is not None:
        return None
    return url


def locate_artifacts(value: Any, node: InputFormItem | None = None) -> list[ArtifactLocation]:
    """Every `pipelex-storage://` reference inside a JSON-shaped value, each with every path at which
    it occurs.

    The references are deduplicated and kept in discovery order (the order of their first sighting),
    and each one's `found_at` lists its paths in walk order, so `found_at[0]` is where it was first
    seen. The string test is `collect_artifacts`'s: a string counts only when it IS a reference. A
    path is rooted at `$`, the walked value itself; an object key matching `^[A-Za-z_][A-Za-z0-9_]*$`
    is written `.key`, any other key `["…"]` in JSON string escaping, and an array index `[n]`. The
    runtime serializes a produced image or document as content carrying its reference in `url`, so a
    typical path ends there: `$.rooms[3].staged_photo.url`, `$.items[0].url`, or `$.url` for an
    output that is one image. Pure — no network, no key. Mappings, sequences and pydantic models are
    walked alike, a model by its `model_dump()` keys.

    `node` is the descriptor node of the walked value, the standard's output-form node for a run's
    output (`pipelex_sdk.stored_texts.main_stuff_node` finds it in the run's results). Given, the walk
    follows the concept at each path and skips a stored text — a `Text`, `Markdown`, `Html` or `JSON`
    value, or one refining them, which the runtime may hold by a `pipelex-storage://` reference too —
    since a stored text is a value of the run, never a file. Without it, nothing says what a value is,
    so every reference counts. A result read with its stored texts loaded, the default, holds none.
    """
    return [_render_location(located) for located in _walk_references(value, with_paths=True, node=node)]


def collect_artifacts(value: Any, node: InputFormItem | None = None) -> list[str]:
    """Every `pipelex-storage://` reference inside a JSON-shaped value, deduplicated, in discovery
    order — the references of `locate_artifacts`, without their paths.

    A string counts only when it IS a reference — the whole string, scheme first, with something
    after the scheme; text that merely contains one does not. The scheme is unambiguous, so this walk
    is a contract rather than a heuristic: the runtime serializes a produced image or document as
    content carrying its reference in `url`, beside an expiring `public_url` this walk ignores. Pure
    — no network, no key — so a consumer can count or list a run's produced files without resolving
    any of them. Mappings, sequences and pydantic models are walked alike, so `results.main_stuff`
    (a parsed JSON value) and a whole `RunResults` both work. `node` skips the stored texts by concept,
    as on `locate_artifacts`.
    """
    return [located.uri for located in _walk_references(value, with_paths=False, node=node)]


def locate_stored_references(value: Any, node: InputFormItem | None = None) -> StoredReferences:
    """Every `pipelex-storage://` reference inside a JSON-shaped value, told apart by concept: the stored files, exactly
    as `locate_artifacts` answers them, and the stored texts, each with what its reference states.

    Each list is deduplicated and in discovery order. A stored text is found where `node` describes a stored-text
    concept (`pipelex_sdk.stored_texts.stored_text_kind_of_node`) and the value there is its reference, a
    `pipelex-storage://` `url` with no value field. Without `node` nothing says what a value is, so every reference is
    a file: a file count one too high, never a file hidden. For a run's output, `node` is
    `pipelex_sdk.stored_texts.main_stuff_node` of its results. Pure — no network.
    """
    references = StoredReferences()
    for located in _walk_references(value, with_paths=True, node=node, include_texts=True):
        if located.text_kind is None:
            references.files.append(_render_location(located))
        else:
            references.texts.append(_render_text_location(located, located.text_kind))
    return references


def _walk_references(
    value: Any,
    *,
    with_paths: bool,
    node: InputFormItem | None = None,
    include_texts: bool = False,
) -> list[_LocatedReference]:
    """The walk both public functions share: depth first, keys in mapping order.

    With `with_paths` off it records each reference once and no path at all, which is what
    `collect_artifacts` needs: copying the trail for every occurrence costs memory in proportion to
    occurrences times depth, where the deduplicated list needs only one entry per unique reference.
    """
    # A dict keeps insertion order, which is the order of first sighting.
    by_uri: dict[str, _LocatedReference] = {}
    trail: list[_PathSegment] = []

    def record(uri: str, path: tuple[_PathSegment, ...], text_kind: StoredTextKind | None, text_reference: dict[str, Any] | None) -> None:
        known = by_uri.get(uri)
        if known is None:
            known = _LocatedReference(uri=uri, paths=[], text_kind=text_kind, text_reference=text_reference)
            by_uri[uri] = known
        if with_paths:
            known.paths.append(path)

    def visit(current: Any, described: InputFormItem | None) -> None:
        if isinstance(current, BaseModel):
            visit(current.model_dump(), described)
            return
        # A stored text is a value of the run, never a file: its reference is recorded as a text when asked for, and
        # never counts as a file.
        kind = stored_text_kind_of_node(described)
        if kind is not None:
            url = _stored_text_reference_url(current, kind) if include_texts else None
            if url is not None and is_storage_reference(url):
                record(url, (*trail, "url"), kind, cast("dict[str, Any]", current))
            return
        if isinstance(current, str):
            if is_storage_reference(current):
                record(current, tuple(trail), None, None)
            return
        if isinstance(current, dict):
            mapping = cast("dict[Any, Any]", current)
            for key, entry in mapping.items():
                # A JSON object's keys are strings; any other key is read as the string it prints as.
                segment = key if isinstance(key, str) else str(key)
                trail.append(segment)
                visit(entry, child_node(described, mapping, segment))
                trail.pop()
            return
        if isinstance(current, (list, tuple)):
            sequence = cast("list[Any]", current)
            for index_item, item in enumerate(sequence):
                trail.append(index_item)
                visit(item, child_node(described, sequence, index_item))
                trail.pop()

    visit(value, node)
    return list(by_uri.values())


def _render_location(located: _LocatedReference) -> ArtifactLocation:
    return ArtifactLocation(uri=located.uri, found_at=[_render_path(segments) for segments in located.paths])


def _render_text_location(located: _LocatedReference, kind: StoredTextKind) -> StoredTextLocation:
    reference = located.text_reference or {}
    size = reference.get("size")
    mime_type = reference.get("mime_type")
    preview = reference.get("preview")
    return StoredTextLocation(
        uri=located.uri,
        found_at=[_render_path(segments) for segments in located.paths],
        kind=kind,
        size=size if isinstance(size, int) and not isinstance(size, bool) else None,
        mime_type=mime_type if isinstance(mime_type, str) else None,
        preview=preview if isinstance(preview, str) else None,
    )


def _render_path(segments: Sequence[_PathSegment]) -> str:
    """Segments to the `$`-rooted notation `found_at` carries."""
    rendered = ["$"]
    for segment in segments:
        if isinstance(segment, int):
            rendered.append(f"[{segment}]")
        elif _IDENTIFIER_KEY.fullmatch(segment):
            rendered.append(f".{segment}")
        else:
            rendered.append(f"[{_json_string(segment)}]")
    return "".join(rendered)


def _json_string(key: str) -> str:
    """A key as `JSON.stringify` writes it, so a path reads the same from either SDK (`dumps_as_javascript`)."""
    return dumps_as_javascript(key)


def _parse_path(path: str) -> list[_PathSegment] | None:
    """The `$`-rooted notation back to segments, for a location that reaches `artifact_filename` from
    outside the walk. The rendering is lossless, so this is exact for every path the walk produced;
    anything else is `None`.
    """
    if not path.startswith("$"):
        return None
    segments: list[_PathSegment] = []
    position = 1
    while position < len(path):
        key_step = _KEY_STEP.match(path, position)
        if key_step is not None:
            segments.append(key_step.group(1))
            position = key_step.end()
            continue
        index_step = _INDEX_STEP.match(path, position)
        if index_step is not None:
            segments.append(int(index_step.group(1)))
            position = index_step.end()
            continue
        quoted_step = _QUOTED_STEP.match(path, position)
        if quoted_step is None:
            return None
        try:
            decoded: Any = json.loads(quoted_step.group(1))
        except json.JSONDecodeError:
            return None
        if not isinstance(decoded, str):
            return None
        segments.append(decoded)
        position = quoted_step.end()
    return segments


# ── artifact_filename ────────────────────────────────────────────────


def artifact_filename(location: ArtifactLocation, content_type: str | None, scope: ArtifactScope) -> str:
    """The bare filename a reference is saved under, named after the field it fills: the path in
    `location.found_at[0]`, where the reference was first seen.

    1. A final object key `url` is dropped, since the runtime's image and document contents carry
       their reference there; a reference under any other key keeps that key, and a `url` key that
       is not final is kept.
    2. Each key is reduced to `[A-Za-z0-9_]`, every other character (`-` and `.` included) becoming
       `_`; an index stays its decimal digits.
    3. The segments are joined with `-`. An empty result — the reference is the walked value itself,
       or its `url` — becomes the scope's name.
    4. Over the filename length cap (128 characters, extension included), the tail is kept: whole
       leading segments are dropped first, since the last ones are the specific ones, and a single
       segment still too long is cut to fit.
    5. A stem Windows reserves for a device (`con`, `prn`, `aux`, `nul`, `com0` to `com9`,
       `lpt0` to `lpt9`, in any case) gets a trailing `_`, so `$.aux.url` is saved as `aux_.png`.
    6. The extension is the storage key's own, reduced to `[A-Za-z0-9]`, when it has a short one;
       otherwise the content type's, for the types a run produces; otherwise there is none. A stored
       text (a `StoredTextLocation`, or a verdict item of kind `text`) is named by its MIME type
       instead, never by its storage key: `.txt`, `.md`, `.html` or `.json`, else its kind's.

    So `$.rooms[3].staged_photo.url` is saved as `rooms-3-staged_photo.png`, and `$.url` in
    `main_stuff` as `main_stuff.png`. The stem is ASCII letters, digits, `_` and the `-` joins, never
    empty and never a device name, so the name can only ever be a regular file directly inside the
    target directory. A collision on disk is not this function's concern: `download_artifacts`
    suffixes the stem (`name-1.ext`) on exclusive creation, so a file is never overwritten. A
    `DownloadedArtifact` is an `ArtifactLocation`, so a verdict item can be passed as it is.

    Raises `ArtifactOperationError` for a location that is not an `ArtifactLocation`, one whose
    `found_at[0]` is not a path in the notation `locate_artifacts` writes, or an unknown scope.
    """
    checked_scope = _require_scope(scope)
    # A caller can hand anything here — the old signature's bare uri string among them — and every
    # shape must reach the documented refusal rather than an AttributeError.
    loose = cast("object", location)
    if not isinstance(loose, ArtifactLocation):
        msg = f"artifact_filename needs an ArtifactLocation, as locate_artifacts answers; got a {type(loose).__name__}."
        raise ArtifactOperationError(msg, problem=argument_invalid_problem(argument="location", reason="not_a_location"))
    first = loose.found_at[0] if loose.found_at else None
    segments = _parse_path(first) if first is not None else None
    if segments is None:
        msg = f'artifact_filename needs a location whose first "found_at" entry is a path such as "$.items[0].url"; got {first!r}.'
        raise ArtifactOperationError(msg, problem=argument_invalid_problem(argument="location", reason="not_a_path"))
    extension: str
    if isinstance(loose, StoredTextLocation):
        extension = _text_extension_for(loose.kind, loose.mime_type or content_type)
    elif isinstance(loose, DownloadedArtifact) and loose.kind.is_text:
        extension = _text_extension_for(StoredTextKind.TEXT, content_type or loose.content_type)
    else:
        extension = _extension_for(loose.uri, content_type)
    return _filename_for(segments, extension=extension, scope=checked_scope)


def _filename_for(segments: Sequence[_PathSegment], *, extension: str, scope: ArtifactScope) -> str:
    """The naming rule of `artifact_filename`, over the walk's own segments."""
    named = segments[:-1] if segments and segments[-1] == "url" else segments
    words: list[str] = []
    for segment in named:
        word = str(segment) if isinstance(segment, int) else re.sub(r"[^A-Za-z0-9_]", "_", segment)
        # Only the empty key reduces to nothing, and it says nothing about the field.
        if word:
            words.append(word)
    stem = _fit_stem(words or [scope], _MAX_FILENAME_LENGTH - len(extension))
    # A device stem is at most four characters, so the `_` cannot overrun the cap.
    if _WINDOWS_DEVICE_STEM.fullmatch(stem):
        stem += "_"
    return stem + extension


def _fit_stem(words: Sequence[str], budget: int) -> str:
    """The words joined with `-` within `budget` characters, keeping the tail."""
    start = 0
    length = sum(len(word) for word in words) + len(words) - 1
    while length > budget and start < len(words) - 1:
        length -= len(words[start]) + 1
        start += 1
    return "-".join(words[start:])[:budget]


def _extension_for(uri: str, content_type: str | None) -> str:
    """`.ext` for the saved file — the storage key's own, else the content type's — or `""`."""
    from_key = _storage_key_extension(uri)
    if from_key:
        return f".{from_key}"
    if content_type is None:
        return ""
    return _EXTENSION_BY_CONTENT_TYPE.get(content_type.split(";")[0].strip().lower(), "")


def _text_extension_for(kind: StoredTextKind, mime_type: str | None) -> str:
    """`.ext` for a saved stored text — its MIME type's, else its kind's — never its storage key's."""
    if mime_type is not None:
        named = _TEXT_EXTENSION_BY_MIME_TYPE.get(mime_type.split(";")[0].strip().lower())
        if named is not None:
            return named
    match kind:
        case StoredTextKind.TEXT:
            return ".txt"
        case StoredTextKind.HTML:
            return ".html"
        case StoredTextKind.JSON:
            return ".json"


def _storage_key_extension(uri: str) -> str:
    r"""The extension the storage key's last segment carries, without its dot, reduced to
    `[A-Za-z0-9]` — or `""` when it has none, or none that short.

    The segment is what follows the last `/` or `\` once the scheme, query and fragment are gone,
    percent-decoded when it decodes; a leading dot is not an extension.
    """
    key = uri.removeprefix(PIPELEX_STORAGE_SCHEME)
    key = re.split(r"[?#]", key, maxsplit=1)[0]
    parts = [part for part in re.split(r"[\\/]", key) if part]
    decoded = _decode_uri_component(parts[-1]) if parts else ""
    dot = decoded.rfind(".")
    if dot <= 0:
        return ""
    extension = re.sub(r"[^A-Za-z0-9]", "", decoded[dot + 1 :])
    return extension if len(extension) <= _MAX_EXTENSION_LENGTH else ""


def _decode_uri_component(segment: str) -> str:
    """`decodeURIComponent`, or the segment as typed where the JS twin's call would throw.

    `unquote` alone is lenient twice over — it keeps a `%` that opens no escape and replaces bytes
    that are not UTF-8 — where `decodeURIComponent` refuses the whole segment, so the same key would
    otherwise yield a different extension in each SDK.
    """
    if _BARE_PERCENT.search(segment):
        return segment
    try:
        return unquote(segment, errors="strict")
    except UnicodeDecodeError:
        return segment


def _extension_of(name: str) -> str:
    """`os.path.splitext` for a bare filename: `.ext`, or `""` (a leading dot is not an extension)."""
    dot = name.rfind(".")
    return name[dot:] if dot > 0 else ""


def _require_scope(scope: ArtifactScope) -> ArtifactScope:
    """The scope as the enum, or the refusal naming the two there are."""
    try:
        return ArtifactScope(scope)
    except ValueError as exc:
        msg = f'"scope" must be "main_stuff" or "working_memory", got {scope!r}.'
        raise ArtifactOperationError(msg, problem=argument_invalid_problem(argument="scope", reason="unknown_value")) from exc


# ── resolve_artifacts ────────────────────────────────────────────────


async def resolve_artifacts(client: BulkResolveClient, uris: list[str]) -> list[ResolvedArtifact]:
    """Resolve a list of references through the bulk route, chunked at `BULK_RESOLVE_MAX_URIS` per
    request, and answer one `ResolvedArtifact` per reference in request order, duplicates included.

    Per-reference failure is a value on the item; only what is not about a reference raises — the
    route's whole-request refusals as `ApiResponseError` (a caller with no organization, a malformed
    request, a signing failure, or a `404` from a deployment that does not serve the route) and an
    unreachable host as `ApiUnreachableError`. An empty list resolves to an empty list with no
    request made.
    """
    items: list[ResolvedArtifact] = []
    for start in range(0, len(uris), BULK_RESOLVE_MAX_URIS):
        chunk = list(uris[start : start + BULK_RESOLVE_MAX_URIS])
        answer = await client.resolve_storage_urls_bulk(chunk)
        if len(answer.items) != len(chunk):
            msg = (
                f"The bulk resolve route answered {len(answer.items)} item(s) for {len(chunk)} reference(s) — "
                "a malformed answer, so no reference can be matched to its verdict."
            )
            raise ArtifactOperationError(msg, problem=response_unreadable_problem(status=200))
        items.extend(answer.items)
    return items


# ── fetch_artifact ───────────────────────────────────────────────────


@dataclass(frozen=True)
class _FetchBounds:
    """The bounds every fetch runs under, defaults filled in and validated."""

    max_bytes: int
    timeout_seconds: float
    allow_http: bool
    #: The origin of the client's configured base URL, on which a plain-http link is fetched without
    #: `allow_http`; `None` when that base URL has no comparable origin.
    client_origin: ComparableOrigin | None


class ArtifactStream:
    """A bounded, header-neutral view of the object store's response for one reference.

    `status_code` and `headers` are the store's own — the one change being that a `Content-Encoding`
    httpx already decoded is dropped with the encoded `Content-Length`, since the bytes handed on are
    the decoded ones. A proxy relaying this response owns its hygiene (`X-Content-Type-Options`, a
    sandboxing CSP, a controlled `Content-Disposition`, private caching) and must set those itself,
    because this object does not.

    The body is read through `aiter_bytes()` or `read()`, either of which raises `ArtifactFetchError`
    (`too_large`) the moment the bytes cross the call's `max_bytes`.
    """

    def __init__(self, uri: str, response: httpx.Response, max_bytes: int) -> None:
        self.uri = uri
        self.status_code = response.status_code
        self.headers = _decoded_headers(response.headers)
        self.content_type: str | None = self.headers.get("content-type")
        self._response = response
        self._max_bytes = max_bytes

    async def aiter_bytes(self, chunk_size: int = _STREAM_CHUNK_BYTES) -> AsyncIterator[bytes]:
        """Yield the body in chunks, cutting it the moment it crosses the byte cap."""
        total = 0
        async for chunk in self._response.aiter_bytes(chunk_size):
            total += len(chunk)
            if total > self._max_bytes:
                msg = f"The artifact crossed the {_format_mib(self._max_bytes)} cap mid-stream."
                raise ArtifactFetchError(msg, uri=self.uri, reason="too_large", status=self.status_code, problem=_over_the_cap(self._max_bytes))
            yield chunk

    async def read(self) -> bytes:
        """The whole body in memory, under the same cap. For a large artifact, iterate instead."""
        parts: list[bytes] = []
        async for chunk in self.aiter_bytes():
            parts.append(chunk)
        return b"".join(parts)


def _new_storage_client(timeout_seconds: float) -> httpx.AsyncClient:
    """The httpx client the object store is fetched with: our own, never the API client's.

    It carries no credential of ours (the link's authorization is in its query string, and nothing
    must ride along to the store), refuses redirects rather than following them, and bounds every
    stalled connect, read and write at the call's budget — the per-stall bound a total timeout alone
    does not give.
    """
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds), follow_redirects=False)


@asynccontextmanager
async def _stream_resolved_url(
    storage_client: httpx.AsyncClient,
    uri: str,
    download_url: str,
    bounds: _FetchBounds,
) -> AsyncGenerator[ArtifactStream, None]:
    """The bounded fetch of an already-resolved link — the half of `fetch_artifact` that
    `download_artifacts` shares, its links coming from one bulk resolve ahead of the tasks.
    """
    checked_url = _checked_url(uri, download_url, allow_http=bounds.allow_http, client_origin=bounds.client_origin)
    try:
        async with asyncio.timeout(bounds.timeout_seconds):
            try:
                async with storage_client.stream("GET", checked_url) as response:
                    refusal = _status_refusal(uri, response)
                    if refusal is not None:
                        raise refusal
                    declared = _declared_length(response.headers)
                    if declared is not None and declared > bounds.max_bytes:
                        msg = f"The artifact is {_format_mib(declared)}, over the {_format_mib(bounds.max_bytes)} cap."
                        raise ArtifactFetchError(
                            msg, uri=uri, reason="too_large", status=response.status_code, problem=_over_the_cap(bounds.max_bytes)
                        )
                    yield ArtifactStream(uri, response, bounds.max_bytes)
            except httpx.InvalidURL as exc:
                # Not an `HTTPError`: httpx refuses the link at request build, before any transport.
                msg = "The platform resolved the reference to a link that is not a valid absolute URL."
                raise ArtifactFetchError(msg, uri=uri, reason="unsupported_url") from exc
            except httpx.TimeoutException as exc:
                msg = f"Fetching the artifact timed out after {bounds.timeout_seconds}s."
                raise ArtifactFetchError(msg, uri=uri, reason="timeout", problem=_out_of_time(bounds.timeout_seconds)) from exc
            except (httpx.TransportError, httpx.DecodingError) as exc:
                msg = f"The artifact could not be fetched: {exc}."
                problem = _unreachable_store(exc, link=checked_url, timeout_seconds=bounds.timeout_seconds)
                raise ArtifactFetchError(msg, uri=uri, reason="network", problem=problem) from exc
            except httpx.HTTPError as exc:
                msg = f"The artifact could not be fetched: {exc}."
                raise ArtifactFetchError(msg, uri=uri, reason="network") from exc
    except TimeoutError as exc:
        msg = f"Fetching the artifact timed out after {bounds.timeout_seconds}s."
        raise ArtifactFetchError(msg, uri=uri, reason="timeout", problem=_out_of_time(bounds.timeout_seconds)) from exc


def _over_the_cap(max_bytes: int) -> Problem:
    """`client.download_limit_exceeded`, naming the byte cap a fetch crossed."""
    return make_client_problem(CoreCode.CLIENT_DOWNLOAD_LIMIT_EXCEEDED, params={"limit": max_bytes})


def _out_of_time(timeout_seconds: float) -> Problem:
    """`client.timeout`, naming the budget a fetch ran out of."""
    return make_client_problem(CoreCode.CLIENT_TIMEOUT, params={"seconds": timeout_seconds})


def _unreachable_store(failure: httpx.TransportError | httpx.DecodingError, *, link: str, timeout_seconds: float) -> Problem:
    """The transport's problem of a fetch that got no usable answer: `client.unreachable`, naming the store by its origin.

    It is the base's reading of a request that got no answer (`transport_failure_problem`), for a request
    that creates nothing; a timeout is read before it, as `client.timeout`. The store is named by the
    link's scheme and host alone, since the link's query string carries its authorization.
    """
    parsed = urlsplit(link)
    return transport_failure_problem(failure, creates_run=False, base_url=f"{parsed.scheme}://{parsed.netloc}", timeout_seconds=timeout_seconds)


def _os_error_reason(exc: OSError) -> str:
    """Why the system refused a file operation, as its error code (`EACCES`, `ENOTDIR`, …), else its class name."""
    if exc.errno is not None and exc.errno in errno.errorcode:
        return errno.errorcode[exc.errno]
    return type(exc).__name__


def fetch_artifact(
    client: ArtifactFetchClient,
    uri: str,
    options: FetchArtifactOptions | None = None,
) -> AbstractAsyncContextManager[ArtifactStream]:
    """A bounded stream for one reference, as an async context manager.

    The link is minted fresh through the bulk route, then fetched with redirects refused (a presigned
    link has no reason to redirect, and one that does is refused rather than followed), no headers of
    ours (the link carries its own authorization in the query string, and nothing must ride along to
    the object store), a budget covering the headers and the body, and a byte cap checked against
    `Content-Length` before a byte is read and again on every chunk.

    Only a `2xx` is yielded. Anything else raises `ArtifactFetchError` with a `code` (a redirect, a
    refused or vanished object, a store fault, a declared oversize, a timeout, a network fault, an
    unusable link, or the route's own per-reference refusal); a body that crosses the cap mid-stream
    raises the same error type (`too_large`) out of the iteration. Cancelling the awaiting task
    propagates `asyncio.CancelledError` as-is. Whole-request failures of the resolve step propagate
    unchanged (`ApiResponseError`, `ApiUnreachableError`).

    Usage:
        async with fetch_artifact(client, uri) as stream:
            async for chunk in stream.aiter_bytes():
                ...
    """
    return _fetch_artifact(client, uri, options)


@asynccontextmanager
async def _fetch_artifact(
    client: ArtifactFetchClient,
    uri: str,
    options: FetchArtifactOptions | None = None,
) -> AsyncGenerator[ArtifactStream, None]:
    """`fetch_artifact`'s body — resolve one reference fresh, then stream its link under the bounds."""
    bounds = _validated_bounds(options or FetchArtifactOptions(), origin_url=client.origin_url)
    resolved = await resolve_artifacts(client, [uri])
    entry = resolved[0]
    if entry.error is not None:
        raise ArtifactFetchError(entry.error.detail, uri=uri, reason=entry.error.code, requirement=entry.error.requirement)
    if entry.url is None:
        msg = "The bulk resolve route answered an item with neither a link nor an error."
        raise ArtifactOperationError(msg, problem=response_unreadable_problem(status=200))
    storage_client = _new_storage_client(bounds.timeout_seconds)
    try:
        async with _stream_resolved_url(storage_client, uri, entry.url, bounds) as stream:
            yield stream
    finally:
        await storage_client.aclose()


def _validated_bounds(options: FetchArtifactOptions, *, origin_url: str) -> _FetchBounds:
    """The per-file bounds, refusing nonsense before anything is resolved. `origin_url` is the client's own
    origin, the one on which a plain-http link is fetched without `allow_http`.
    """
    _require_positive("max_bytes", options.max_bytes)
    _require_positive("timeout_seconds", options.timeout_seconds)
    return _FetchBounds(
        max_bytes=options.max_bytes,
        timeout_seconds=options.timeout_seconds,
        allow_http=options.allow_http,
        client_origin=comparable_origin(origin_url),
    )


def _require_positive(name: str, value: float) -> None:
    """Refuse a bound that is not a positive, finite number."""
    if not math.isfinite(value) or value <= 0:
        msg = f'"{name}" must be a positive number, got {value}.'
        raise ArtifactOperationError(msg, problem=argument_invalid_problem(argument=name, reason="not_positive"))


def _checked_url(uri: str, download_url: str, *, allow_http: bool, client_origin: ComparableOrigin | None) -> str:
    """The boundary-approved link, or the typed refusal saying why it is not fetched.

    A plain-http link is fetched when the caller opted in with `allow_http`, or when its origin is
    `client_origin`, the origin of the client's configured base URL: the client already sends its API key
    there, so a link to it reveals nothing the client does not already trust that server with. That is how a
    self-hosted runner listening on plain http hands back what it stores. Both origins are compared in
    `comparable_origin`'s form.
    """
    try:
        parsed = urlsplit(download_url)
    except ValueError as exc:
        msg = "The platform resolved the reference to a link that is not a valid absolute URL."
        raise ArtifactFetchError(msg, uri=uri, reason="unsupported_url") from exc
    if not parsed.scheme or not parsed.netloc:
        msg = "The platform resolved the reference to a link that is not a valid absolute URL."
        raise ArtifactFetchError(msg, uri=uri, reason="unsupported_url")
    scheme = parsed.scheme.lower()
    if scheme == "http" and not allow_http and (client_origin is None or comparable_origin(download_url) != client_origin):
        msg = (
            "The platform resolved the reference to a plain http link on an origin other than the client's own, which is "
            "refused by default; pass allow_http=True to accept it (the local stack's object store hands out such links)."
        )
        raise ArtifactFetchError(msg, uri=uri, reason="plain_http_refused")
    if scheme not in {"http", "https"}:
        msg = f'The platform resolved the reference to a "{scheme}" link, which is not fetched; only http(s) links are.'
        raise ArtifactFetchError(msg, uri=uri, reason="unsupported_url")
    if parsed.username or parsed.password:
        msg = "The platform resolved the reference to a link carrying credentials, which is not fetched."
        raise ArtifactFetchError(msg, uri=uri, reason="unsupported_url")
    return download_url


def _status_refusal(uri: str, response: httpx.Response) -> ArtifactFetchError | None:
    """The typed refusal for a non-2xx store answer, or `None` when the status is a `2xx`."""
    status = response.status_code
    if 300 <= status < 400:
        msg = f"The resolved link redirected (HTTP {status}); redirects are not followed."
        return ArtifactFetchError(msg, uri=uri, reason="redirect_refused", status=status)
    # The link is minted per call, so a 401/403 is the store refusing a fresh signature (clock skew,
    # a signing misconfiguration) rather than an expired link.
    if status in {401, 403}:
        msg = f"The object store refused the resolved link (HTTP {status})."
        return ArtifactFetchError(msg, uri=uri, reason="store_refused", status=status)
    if status in {404, 410}:
        msg = f"The stored file is no longer available (HTTP {status})."
        return ArtifactFetchError(msg, uri=uri, reason="not_found", status=status)
    if status < 200 or status >= 300:
        msg = f"The object store answered HTTP {status} for the resolved link."
        return ArtifactFetchError(msg, uri=uri, reason="store_error", status=status)
    return None


def _decoded_headers(headers: httpx.Headers) -> httpx.Headers:
    """The store's headers as they describe the body we hand on.

    When httpx has decoded every coding the `Content-Encoding` lists, the stream is the decoded bytes:
    the encoding and the encoded length are dropped, or a proxy relaying the response would label
    plain bytes as compressed and give the wrong length. Any other encoding is passed through with the
    still-encoded body it describes.
    """
    raw = headers.get("content-encoding", "")
    codings = [coding.strip().lower() for coding in raw.split(",")]
    codings = [coding for coding in codings if coding and coding != "identity"]
    if not codings or not all(coding in _DECODED_CODINGS for coding in codings):
        return headers
    decoded = httpx.Headers(headers)
    del decoded["content-encoding"]
    if "content-length" in decoded:
        del decoded["content-length"]
    return decoded


def _declared_length(headers: httpx.Headers) -> int | None:
    """The body's declared length, or `None` when it is absent or unreadable."""
    raw = headers.get("content-length")
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _format_mib(byte_count: float) -> str:
    """A byte count as MiB, for the sentence a person reads."""
    mib = byte_count / (1024 * 1024)
    return f"{int(mib)} MiB" if mib.is_integer() else f"{mib:.1f} MiB"


# ── load_stored_texts ────────────────────────────────────────────────

#: The result artifacts the concept at each path is read from.
_CONCEPT_ARTIFACTS: tuple[RunArtifact, ...] = (RunArtifact.WORKING_MEMORY, RunArtifact.OUTPUT_FORM, RunArtifact.INPUT_FORM)


@dataclass(frozen=True)
class _StoredTextSite:
    """One stored text the walk found: where it sits, what it holds, and its reference."""

    segments: tuple[_PathSegment, ...]
    kind: StoredTextKind
    url: str
    reference: dict[str, Any]

    @property
    def path(self) -> str:
        return _render_path(self.segments)


async def load_stored_texts(
    client: ArtifactFetchClient,
    results: RunResults,
    options: LoadStoredTextsOptions | None = None,
) -> RunResults:
    """A run's result with every stored text in `main_stuff` loaded.

    Each value the runtime holds by reference, `{url, size, mime_type, preview}`, is replaced by its inline form,
    `{text}`, `{inner_html}` (its `css_class` kept) or `{json_obj}`, which is the shape the generated types parse. The
    result readers (`get_run_result`, `wait_for_result`, `start_and_wait_for_result`) call it by default; a caller
    holding a result read with `load_stored_texts=False` calls it later.

    Which values are stored texts is decided by concept, never by URL or MIME type: the concept at each path comes
    from the run's working memory and output form (`pipelex_sdk.stored_texts.main_stuff_node`), so the results must
    carry them. A result that cannot say (no working memory naming the main stuff, or a concept of the method's own
    that no form describes) is returned as it is when nothing in `main_stuff` is shaped like a stored text's reference;
    when something is, it raises `StoredTextLoadError` with the reason `concepts_missing` rather than hand a reference
    on where a text is promised (`lacks_stored_text_concepts`). The runtime writes `output_form` after `main_stuff`, so
    a read can land in between: `wait_for_result` keeps polling through that window for a few polls before it raises.

    A `pipelex-storage://` reference is resolved through the platform's bulk route, at most `BULK_RESOLVE_MAX_URIS` per
    request, and its signed link fetched under the same bounds as `fetch_artifact`; a link within ten seconds of its
    `expires_at` when its read is about to start, having waited behind the other reads, is resolved again first. A
    `data:` URL is decoded, its size bounded from its length before it is. A stored text under any other URL
    (`is_loadable_stored_text_url`) is refused before anything is sent, since fetching it would read a host the method
    chose rather than the caller; a result read with `load_stored_texts=False` keeps it as written. The bytes are UTF-8
    by the standard's rule, and a JSON value is the object they serialize.

    Each text is bounded by `options.max_bytes` (100 MiB by default) and the load as a whole by
    `options.max_total_bytes` (256 MiB by default), both checked first against the sizes the references state, before
    anything is sent, then as the bytes arrive; the first text that fails stops every other read in flight.

    The result passed in is never changed: a new one is returned, or the same one when there is nothing to load.

    Raises:
        StoredTextLoadError: Naming the text that could not be loaded, where it sits and why, a whole-request failure of
            the resolve route included (`resolve_failed`, the route's error as its cause), the load's total over
            `max_total_bytes` as `total_limit_exceeded`, and a result that does not say which values are texts as
            `concepts_missing`.
        ArtifactOperationError: For nonsense bounds.
    """
    if results.main_stuff is None:
        return results
    if lacks_stored_text_concepts(results):
        raise _concepts_missing_error(results)
    node = main_stuff_node(results)
    if node is None:
        return results
    loaded = await _load_stored_text_values(client, results.main_stuff, node, options or LoadStoredTextsOptions(), run_id=results.pipeline_run_id)
    if loaded is results.main_stuff:
        return results
    return results.model_copy(update={"main_stuff": loaded})


def may_hold_stored_texts(value: Any) -> bool:
    """Whether a value holds anything shaped like a stored text's reference, which is what makes a read that left the
    concepts out read them again: an object carrying a string `url`, no inline value field, and a `size` or a
    `preview`, which the runtime sets on every reference it stores and an image or a document content never carries.
    So an output of images and documents alone answers `False`. `True` says only that the concepts are worth reading,
    the concept at each path still deciding; `False` says no stored text the runtime made can be there.
    """
    if isinstance(value, BaseModel):
        return may_hold_stored_texts(value.model_dump())
    if isinstance(value, (list, tuple)):
        return any(may_hold_stored_texts(item) for item in cast("list[Any]", value))
    if not isinstance(value, dict):
        return False
    fields = cast("dict[str, Any]", value)
    if (
        isinstance(fields.get("url"), str)
        and all(fields.get(field_name) is None for field_name in STORED_TEXT_VALUE_FIELDS)
        and ("size" in fields or "preview" in fields)
    ):
        return True
    return any(may_hold_stored_texts(entry) for entry in fields.values())


def lacks_stored_text_concepts(results: RunResults) -> bool:
    """Whether a completed result cannot say which values of its `main_stuff` are stored texts while something there
    is shaped like one's reference (`may_hold_stored_texts`).

    The working memory names no main stuff, or its concept is the method's own and no `output_form` / `input_form`
    node describes it, so a text in one of its fields could not be told from any other value. A native concept needs no
    form: the walk knows its shape. The runtime writes `output_form` after `main_stuff`, so a read can land in between;
    `load_stored_texts` then raises `StoredTextLoadError` (`concepts_missing`) rather than hand a reference on.
    """
    if results.main_stuff is None or not may_hold_stored_texts(results.main_stuff):
        return False
    concept_ref = main_stuff_concept_ref(results)
    if concept_ref is None:
        return True
    return not describes_concept(concept_ref, results)


def _concepts_missing_error(results: RunResults) -> StoredTextLoadError:
    """The `concepts_missing` failure, naming the first value shaped like a stored text's reference."""
    shaped = _first_reference_shape(results.main_stuff, ())
    segments, url = shaped or ((), "")
    path = _render_path(segments)
    msg = (
        f"The stored text at {path} could not be loaded: the result does not say which of its values are stored texts "
        "(its working_memory or its output_form is missing), so none is handed on as its reference; read the result "
        "again in a moment, or with load_stored_texts=False to see it as written."
    )
    problem = response_unreadable_problem(status=200, pipeline_run_id=results.pipeline_run_id)
    return StoredTextLoadError(msg, uri=url, path=path, reason=STORED_TEXT_CONCEPTS_MISSING, problem=problem)


def _first_reference_shape(value: Any, segments: tuple[_PathSegment, ...]) -> tuple[tuple[_PathSegment, ...], str] | None:
    """The first value `may_hold_stored_texts` answers for, depth first, with where it sits and its `url`."""
    if isinstance(value, BaseModel):
        value = value.model_dump()
    if isinstance(value, (list, tuple)):
        for index_item, item in enumerate(cast("list[Any]", value)):
            found = _first_reference_shape(item, (*segments, index_item))
            if found is not None:
                return found
        return None
    if not isinstance(value, dict):
        return None
    fields = cast("dict[str, Any]", value)
    url = fields.get("url")
    if (
        isinstance(url, str)
        and all(fields.get(field_name) is None for field_name in STORED_TEXT_VALUE_FIELDS)
        and ("size" in fields or "preview" in fields)
    ):
        return segments, url
    for key, entry in fields.items():
        found = _first_reference_shape(entry, (*segments, key))
        if found is not None:
            return found
    return None


def carries_concept_artifacts(selection: Sequence[RunArtifact] | None) -> bool:
    """Whether a results read narrowed to `selection` carried every artifact the concept at each path is read from:
    the working memory and both forms. `None`, a read of every artifact, does.
    """
    return selection is None or all(artifact in selection for artifact in _CONCEPT_ARTIFACTS)


async def with_concept_artifacts(
    client: ArtifactCapableClient,
    results: RunResults,
    *,
    selection: Sequence[RunArtifact] | None,
) -> RunResults:
    """The concept facts of a run's results: the results themselves when their read carried the working memory and
    the forms (`selection` `None` reads every artifact), else those three read again by the run's id and set beside
    the results. Nothing is read when nothing is missing, and a second read that finds no completed run leaves the
    results as they are.
    """
    if selection is None:
        return results
    missing = [artifact for artifact in _CONCEPT_ARTIFACTS if artifact not in selection]
    if not missing:
        return results
    state = await client.get_run_result(results.pipeline_run_id, artifacts=missing, load_stored_texts=False)
    if not isinstance(state, RunResultCompleted):
        return results
    concepts = {str(artifact): getattr(state.result, str(artifact)) for artifact in missing}
    return results.model_copy(update=concepts)


#: Takes a count of bytes from the load's budget of `max_total_bytes`, answering whether the load's texts together are
#: still within it.
_TakeBytes: TypeAlias = Callable[[int], bool]


async def _load_stored_text_values(
    client: ArtifactFetchClient,
    value: Any,
    node: InputFormItem,
    options: LoadStoredTextsOptions,
    *,
    run_id: str | None,
) -> Any:
    """`value` with its stored texts loaded, walked with `node`; `value` itself when it holds none."""
    sites = _find_stored_texts(value, node)
    if not sites:
        return value
    if options.concurrency < 1:
        msg = f'"concurrency" must be a positive integer, got {options.concurrency}.'
        raise ArtifactOperationError(msg, problem=argument_invalid_problem(argument="concurrency", reason="not_positive"))
    _require_positive("max_total_bytes", options.max_total_bytes)
    bounds = _validated_bounds(
        FetchArtifactOptions(max_bytes=options.max_bytes, timeout_seconds=options.timeout_seconds, allow_http=options.allow_http),
        origin_url=client.origin_url,
    )
    max_total_bytes = options.max_total_bytes

    # One read per distinct URL, named by the first place it was found.
    first_site: dict[str, _StoredTextSite] = {}
    for site in sites:
        first_site.setdefault(site.url, site)
    urls = list(first_site)

    # Refused before anything is sent: a text whose reference states a size over the cap on one text, and texts whose
    # stated sizes together are over the load's cap.
    declared_total = 0
    for url in urls:
        site = first_site[url]
        size = site.reference.get("size")
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            continue
        if size > bounds.max_bytes:
            raise _over_text_cap(site, bounds.max_bytes, size=size)
        declared_total += size
        if declared_total > max_total_bytes:
            raise _over_load_cap(site, max_total_bytes)

    references = [url for url in urls if is_storage_reference(url)]
    resolved = dict(zip(references, await _resolve_for_texts(client, references, first_site), strict=True))

    # Every byte read counts against the load's budget, whatever the references state.
    held = 0

    def take(byte_count: int) -> bool:
        nonlocal held
        held += byte_count
        return held <= max_total_bytes

    texts: dict[str, Any] = {}
    semaphore = asyncio.Semaphore(options.concurrency)
    storage_client = _new_storage_client(bounds.timeout_seconds)

    async def load_one(url: str) -> None:
        async with semaphore:
            site = first_site[url]
            entry = resolved.get(url)
            # A link resolved before the reads ahead of it is resolved again just before its own read.
            if entry is not None and entry.error is None and _is_expired(entry.expires_at):
                entry = (await _resolve_for_texts(client, [url], first_site))[0]
            raw = await _read_stored_bytes(storage_client, site, entry, bounds, max_total_bytes=max_total_bytes, take=take)
            texts[url] = _decode_stored_value(site, raw, run_id=run_id)

    # The first failure stops every other read, those waiting and those in flight, and is raised once they have all
    # settled; a cancellation of the load cancels them the same way.
    tasks = [asyncio.create_task(load_one(url)) for url in urls]
    try:
        for finished in asyncio.as_completed(tasks):
            await finished
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await storage_client.aclose()

    loaded = copy.deepcopy(value.model_dump() if isinstance(value, BaseModel) else value)
    for site in sites:
        loaded = _replace_at(loaded, site.segments, _loaded_form(site, texts[site.url]))
    return loaded


def _over_text_cap(site: _StoredTextSite, max_bytes: int, *, size: int | None = None) -> StoredTextLoadError:
    """A stored text over the cap on one text; `size` when its reference or its length states it."""
    over = f"over the {_format_mib(max_bytes)} cap."
    stated = over if size is None else f"{_format_mib(size)}, {over}"
    msg = f"The stored text at {site.path} could not be loaded: it is {stated}"
    return StoredTextLoadError(msg, uri=site.url, path=site.path, reason="too_large", problem=_over_the_cap(max_bytes))


def _over_load_cap(site: _StoredTextSite, max_total_bytes: int) -> StoredTextLoadError:
    """A stored text that takes the load's texts together over `max_total_bytes`."""
    msg = (
        f"The stored text at {site.path} could not be loaded: with the texts loaded before it, the load is over its "
        f"{_format_mib(max_total_bytes)} total limit (max_total_bytes)."
    )
    return StoredTextLoadError(msg, uri=site.url, path=site.path, reason="total_limit_exceeded", problem=_over_the_cap(max_total_bytes))


async def _resolve_for_texts(client: BulkResolveClient, references: list[str], first_site: dict[str, _StoredTextSite]) -> list[ResolvedArtifact]:
    """The bulk resolve of the stored texts' references, a whole-request failure being the first text's load error."""
    try:
        return await resolve_artifacts(client, references)
    except (ApiResponseError, ApiUnreachableError, ArtifactOperationError) as exc:
        site = first_site[references[0]]
        status = exc.status if isinstance(exc, ApiResponseError) else None
        msg = f"The stored text at {site.path} could not be loaded: the platform's bulk resolve route failed: {exc}"
        raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason="resolve_failed", status=status, problem=exc.problem) from exc


def _find_stored_texts(value: Any, node: InputFormItem) -> list[_StoredTextSite]:
    """Every stored text's reference in `value`, in walk order, the concept at each path read off `node`.

    Raises:
        StoredTextLoadError: `unsupported_url` for a stored text whose `url` the loader never reads
            (`is_loadable_stored_text_url`), before anything is sent.
    """
    sites: list[_StoredTextSite] = []
    trail: list[_PathSegment] = []

    def visit(current: Any, described: InputFormItem | None) -> None:
        if isinstance(current, BaseModel):
            current = current.model_dump()
        kind = stored_text_kind_of_node(described)
        if kind is not None:
            url = _stored_text_reference_url(current, kind)
            if url is None:
                return
            site = _StoredTextSite(segments=tuple(trail), kind=kind, url=url, reference=cast("dict[str, Any]", current))
            if not is_loadable_stored_text_url(url):
                msg = (
                    f"The stored text at {site.path} could not be loaded: its url is neither a pipelex-storage:// reference "
                    "nor a data: URL, so it is not fetched; read the result with load_stored_texts=False to see it as written."
                )
                raise StoredTextLoadError(msg, uri=url, path=site.path, reason="unsupported_url")
            sites.append(site)
            return
        if isinstance(current, (list, tuple)):
            sequence = cast("list[Any]", current)
            for index_item, item in enumerate(sequence):
                trail.append(index_item)
                visit(item, child_node(described, sequence, index_item))
                trail.pop()
            return
        if isinstance(current, dict):
            mapping = cast("dict[str, Any]", current)
            for key, entry in mapping.items():
                trail.append(key)
                visit(entry, child_node(described, mapping, key))
                trail.pop()

    visit(value, node)
    return sites


async def _read_stored_bytes(
    storage_client: httpx.AsyncClient,
    site: _StoredTextSite,
    resolved: ResolvedArtifact | None,
    bounds: _FetchBounds,
    *,
    max_total_bytes: int,
    take: _TakeBytes,
) -> bytes:
    """The bytes of one stored text: a reference's signed link fetched, or a `data:` URL decoded. Nothing else is read.

    Every chunk is taken from the load's budget as it arrives, and the read is cut once the budget is crossed.
    """
    if site.url.startswith("data:"):
        decoded = _decode_data_url(site.url, bounds.max_bytes)
        match decoded:
            case _DataUrlRefusal.MALFORMED:
                msg = f"The stored text at {site.path} could not be loaded: its data URL does not decode."
                raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason="unsupported_url")
            case _DataUrlRefusal.TOO_LARGE:
                raise _over_text_cap(site, bounds.max_bytes)
            case bytes():
                if not take(len(decoded)):
                    raise _over_load_cap(site, max_total_bytes)
                return decoded
    if resolved is None:
        # Unreachable: the walk admits only a reference or a data: URL, and every reference is resolved first.
        msg = f"The stored text at {site.path} could not be loaded: its url was not resolved by the platform."
        raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason="unsupported_url")
    if resolved.error is not None:
        msg = f"The stored text at {site.path} could not be loaded: {resolved.error.detail}"
        raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason=resolved.error.code, requirement=resolved.error.requirement)
    if resolved.url is None:
        msg = f"The stored text at {site.path} could not be loaded: the bulk resolve route answered its item with neither a link nor an error."
        raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason="resolve_failed", problem=response_unreadable_problem(status=200))
    parts: list[bytes] = []
    try:
        async with _stream_resolved_url(storage_client, site.url, resolved.url, bounds) as stream:
            async for chunk in stream.aiter_bytes():
                if not take(len(chunk)):
                    raise _over_load_cap(site, max_total_bytes)
                parts.append(chunk)
    except ArtifactFetchError as exc:
        msg = f"The stored text at {site.path} could not be loaded: {exc}"
        raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason=exc.reason, status=exc.status, problem=exc.problem) from exc
    return b"".join(parts)


_BASE64_WHITESPACE = "\t\n\f\r "
"""The ASCII whitespace forgiving-base64 drops: tab, line feed, form feed, carriage return and space."""
_STRIP_BASE64_WHITESPACE = str.maketrans("", "", _BASE64_WHITESPACE)


_PERCENT_ESCAPE = re.compile(r"%[0-9A-Fa-f]{2}")
_PERCENT_COUNT_CHUNK = 1 << 20
"""The characters `_percent_decoded_length` encodes at once, so its count holds a few MiB at most."""


def _percent_decoded_length(payload: str, *, limit: int) -> int:
    """The bytes a percent-encoded payload decodes to, without decoding or copying it whole.

    Counted chunk by chunk: each chunk's UTF-8 length, less two bytes for each escape `%XX` it holds, which
    `unquote_to_bytes` turns into one byte. A chunk is never cut inside an escape, and the count stops once it passes
    `limit`.
    """
    count = 0
    start = 0
    while start < len(payload) and count <= limit:
        end = min(start + _PERCENT_COUNT_CHUNK, len(payload))
        # An escape that starts in the chunk's last two characters is kept whole in it.
        cut = payload.rfind("%", max(start, end - 2), end)
        if cut >= 0:
            end = min(cut + 3, len(payload))
        chunk = payload[start:end]
        escapes = sum(1 for _ in _PERCENT_ESCAPE.finditer(chunk))
        count += len(chunk.encode("utf-8", "surrogatepass")) - 2 * escapes
        start = end
    return count


class _DataUrlRefusal(StrEnum):
    """Why a `data:` URL was not decoded."""

    MALFORMED = "malformed"
    TOO_LARGE = "too_large"


def _decode_data_url(url: str, max_bytes: int) -> bytes | _DataUrlRefusal:
    """A `data:` URL's bytes, base64 or percent-encoded.

    `MALFORMED` when it does not decode, and `TOO_LARGE` when its bytes would be over `max_bytes`, told from the
    payload's length before anything is decoded: a base64 payload decodes to three bytes per four characters, less its
    padding, and a percent-encoded byte takes at most three characters.

    Base64 is read as the TypeScript SDK and `atob` read it (the WHATWG forgiving-base64 decode): ASCII whitespace
    dropped, at most two `=` of padding when the length is a multiple of four, and otherwise no padding needed, so the
    same `data:` URL loads in both SDKs. The size is bounded from a count of the payload's other characters before the
    whitespace is stripped, so a payload over the cap is never copied.
    """
    header, separator, payload = url.removeprefix("data:").partition(",")
    if not separator:
        return _DataUrlRefusal.MALFORMED
    if header.lower().endswith(";base64"):
        whitespace = sum(payload.count(char) for char in _BASE64_WHITESPACE)
        # At most two of the significant characters are padding.
        if (len(payload) - whitespace - 2) * 3 // 4 > max_bytes:
            return _DataUrlRefusal.TOO_LARGE
        data = payload.translate(_STRIP_BASE64_WHITESPACE) if whitespace else payload
        if len(data) % 4 == 0 and data.endswith("="):
            data = data[:-2] if data.endswith("==") else data[:-1]
        if len(data) % 4 == 1:
            return _DataUrlRefusal.MALFORMED
        if len(data) * 3 // 4 > max_bytes:
            return _DataUrlRefusal.TOO_LARGE
        try:
            return base64.b64decode(data + "=" * (-len(data) % 4), validate=True)
        except binascii.Error:
            return _DataUrlRefusal.MALFORMED
    if _percent_decoded_length(payload, limit=max_bytes) > max_bytes:
        return _DataUrlRefusal.TOO_LARGE
    decoded = unquote_to_bytes(payload)
    if len(decoded) > max_bytes:
        return _DataUrlRefusal.TOO_LARGE
    return decoded


def _decode_stored_value(site: _StoredTextSite, raw: bytes, *, run_id: str | None) -> Any:
    """The value one stored text holds: its UTF-8 text, or for a JSON value the object that text serializes."""
    problem = response_unreadable_problem(status=200, pipeline_run_id=run_id)
    try:
        # The bytes as stored, a byte-order mark included: the value is exactly what was stored.
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        msg = f"The stored text at {site.path} could not be loaded: its bytes are not UTF-8 text."
        raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason="not_utf8", problem=problem) from exc
    match site.kind:
        case StoredTextKind.TEXT | StoredTextKind.HTML:
            return text
        case StoredTextKind.JSON:
            try:
                parsed: Any = json.loads(text)
            except json.JSONDecodeError as exc:
                msg = f"The stored text at {site.path} could not be loaded: its bytes are not JSON."
                raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason="not_json_object", problem=problem) from exc
            if not isinstance(parsed, dict):
                msg = f"The stored text at {site.path} could not be loaded: its JSON is not an object."
                raise StoredTextLoadError(msg, uri=site.url, path=site.path, reason="not_json_object", problem=problem)
            return cast("dict[str, Any]", parsed)


def _loaded_form(site: _StoredTextSite, value: Any) -> dict[str, Any]:
    """The inline form of a loaded stored text: its value field first, its other inline fields kept."""
    loaded: dict[str, Any] = {site.kind.value_field: value}
    loaded.update({key: entry for key, entry in site.reference.items() if key not in STORED_TEXT_REFERENCE_FIELDS})
    return loaded


def _replace_at(root: Any, segments: Sequence[_PathSegment], value: Any) -> Any:
    """`root` with the value at `segments` replaced, in place below the root; the new value itself at `$`."""
    if not segments:
        return value
    parent: Any = root
    for segment in segments[:-1]:
        parent = parent[segment]
    parent[segments[-1]] = value
    return root


# ── download_artifacts ───────────────────────────────────────────────


@dataclass
class _DownloadBudget:
    """The bytes the whole call may still write, and the flags that stop the tasks taking more.

    `committed` is the bytes of every file saved or being saved, a file in flight counting as the
    larger of its declared length and what it has written. Reserving the declared length up front is
    what stops parallel files from each passing the check and then all being cut together; a file
    that is unlinked gives its share back. Every item is checked against the room that leaves, on
    its own declared length: one refused item never skips a smaller one that still fits.
    """

    max_total_bytes: int
    committed: int = 0
    credential_failure: ApiResponseError | None = None


async def download_artifacts(
    client: ArtifactCapableClient,
    *,
    dir_path: str | Path,
    run_id: str | None = None,
    results: RunResults | None = None,
    options: DownloadArtifactsOptions | None = None,
) -> DownloadArtifactsResult:
    """Save a run's produced files under `dir_path`, and answer a produced verdict.

    Takes exactly one of `run_id` (the results are re-read, so a run is downloadable days later) or
    `results` (a `RunResults` in hand); walks the requested scope with `locate_artifacts`; resolves
    the whole set through the bulk route ahead of the tasks; then a bounded number of tasks
    (`concurrency`, held by an `asyncio.Semaphore`) each fetch, create their file exclusively and
    stream the body in, re-resolving any link that has expired by the time a task reaches it. The
    embedded `public_url` is never used. Each file is named after the field it fills, by
    `artifact_filename`'s rule, and never overwritten; a failed or cancelled download unlinks its
    partial file.

    Returns one entry per reference, errors as values. It raises only when no verdict can be produced:
    `RunStillRunningError` or `RunFailedError` for a run that has not completed, `FieldNotIncludedError`
    when the results read did not carry the scope's key, `ScopeUnavailableError` when the key was
    relayed as `None`, `ArtifactAuthenticationError` (carrying the verdict so far) when the resolve
    route refuses the credential, `ArtifactOperationError` for an unusable directory, an unknown
    scope or nonsense bounds, and the transport and lifecycle errors of the reads it makes
    (`ApiResponseError` for a deployment without the bulk route, `RunLifecycleUnavailableError` for a
    bare runner asked by id, `ApiUnreachableError`). Cancelling the awaiting task raises
    `asyncio.CancelledError` out of here, with every partial file unlinked first.
    """
    opts = options or DownloadArtifactsOptions()
    scope = _require_scope(opts.scope)
    bounds = _validated_bounds(opts, origin_url=client.origin_url)
    if opts.concurrency < 1:
        msg = f'"concurrency" must be a positive integer, got {opts.concurrency}.'
        raise ArtifactOperationError(msg, problem=argument_invalid_problem(argument="concurrency", reason="not_positive"))
    _require_positive("max_total_bytes", opts.max_total_bytes)

    # An empty `run_id` is no selector at all, and is refused here rather than sent to the results
    # read, which would answer a 404 about a run nobody named.
    if bool(run_id) == (results is not None):
        msg = "download_artifacts takes exactly one of `run_id` (the results are re-read) or `results` (a RunResults in hand)."
        raise ArtifactOperationError(msg, problem=argument_invalid_problem(argument="run_id", reason="not_exactly_one_selector"))
    read_results = results if results is not None else await _read_completed_results(client, cast("str", run_id), scope)
    walked = _scope_value(read_results, scope, read_here=results is None)

    # The concept at each path tells a stored text, a value of the run, from a file. A run read by id
    # asked for its scope alone, so its concepts are read beside it when the walk may need them.
    source = read_results
    if results is None and may_hold_stored_texts(walked):
        source = await with_concept_artifacts(client, read_results, selection=[scope.run_artifact])
    node: InputFormItem | None
    match scope:
        case ArtifactScope.MAIN_STUFF:
            node = main_stuff_node(source)
        case ArtifactScope.WORKING_MEMORY:
            node = working_memory_node(source)

    # The walk's own record names the files; `locations` is what the verdict reports. A stored text is saved too, as
    # a text file named by its MIME type.
    located = _walk_references(walked, with_paths=True, node=node, include_texts=True)
    if not located:
        return _assemble_verdict(scope, [])
    locations = [_download_location(reference) for reference in located]
    uris = [reference.uri for reference in located]

    target_dir = Path(dir_path).resolve()
    try:
        await asyncio.to_thread(target_dir.mkdir, parents=True, exist_ok=True)
    except OSError as exc:
        msg = f'The download directory "{target_dir}" cannot be created or used: {exc}.'
        # The environment refuses the download, not the run: someone fixes the directory.
        problem = make_client_problem(CoreCode.CLIENT_WRITE_FAILED, params={"path": str(target_dir), "reason": _os_error_reason(exc)})
        raise ArtifactOperationError(msg, problem=problem) from exc

    budget = _DownloadBudget(max_total_bytes=opts.max_total_bytes)
    try:
        resolved = await resolve_artifacts(client, uris)
    except ApiResponseError as exc:
        if not _is_credential_refusal(exc):
            raise
        verdict = _assemble_verdict(scope, [_item_error(location, None, "aborted", _SKIPPED_CREDENTIAL) for location in locations])
        msg = f"The resolve route refused the credential ({exc.status}); no artifact was downloaded."
        raise ArtifactAuthenticationError(msg, status=exc.status, verdict=verdict, cause=exc) from exc

    semaphore = asyncio.Semaphore(opts.concurrency)
    storage_client = _new_storage_client(bounds.timeout_seconds)
    try:
        outcomes = await asyncio.gather(
            *[
                _process_one(
                    client=client,
                    storage_client=storage_client,
                    semaphore=semaphore,
                    budget=budget,
                    bounds=bounds,
                    target_dir=target_dir,
                    scope=scope,
                    location=location,
                    name_path=located[index].paths[0],
                    text_kind=located[index].text_kind,
                    entry=resolved[index],
                )
                for index, location in enumerate(locations)
            ]
        )
    finally:
        await storage_client.aclose()

    verdict = _assemble_verdict(scope, list(outcomes))
    if budget.credential_failure is not None:
        status = budget.credential_failure.status
        msg = f"The resolve route refused the credential ({status}) part-way through the download; the verdict so far is on this error."
        raise ArtifactAuthenticationError(msg, status=status, verdict=verdict, cause=budget.credential_failure) from budget.credential_failure
    return verdict


async def _read_completed_results(client: ArtifactCapableClient, run_id: str, scope: ArtifactScope) -> RunResults:
    """Read a run's results by id, turning a run that has not completed into its typed error.

    Asks for the scope's one artifact only, so a download never pays for the graph, the forms or
    the usage it does not walk.
    """
    # Files only: the stored texts are values, which the walk skips by concept rather than loads.
    state = await client.get_run_result(run_id, artifacts=[scope.run_artifact], load_stored_texts=False)
    if isinstance(state, RunResultRunning):
        retry = state.retry_after_seconds
        hint = f" — retry in {retry}s." if retry is not None else "."
        msg = f"Run {run_id} is still running, so it has no artifacts to download yet{hint}"
        raise RunStillRunningError(msg, run_id=run_id, retry_after_seconds=retry)
    if isinstance(state, RunResultFailed):
        raise RunFailedError(state.message, run_id=run_id, status=state.status, problem=state.problem)
    completed: RunResultCompleted = state
    return completed.result


def _scope_value(results: RunResults, scope: ArtifactScope, *, read_here: bool) -> Any:
    """The artifact the scope names, or the typed error saying why there is none to walk.

    The two readings of an absent value are distinct, and only one of them is the platform's answer:
    a key the results read never carried is not in `model_fields_set` and is `FieldNotIncludedError`,
    where a key relayed as `None` is a value and is `ScopeUnavailableError`. When the results were read
    here (`read_here`), asking for the scope's artifact, an answer without its key broke the API's own
    contract, so its problem is `client.response_unreadable` rather than the caller's `client.argument_invalid`.
    """
    field_name = scope.results_field
    if field_name not in results.model_fields_set:
        if read_here:
            raise FieldNotIncludedError(field_name, problem=response_unreadable_problem(status=200))
        raise FieldNotIncludedError(field_name)
    value = getattr(results, field_name, None)
    if value is None:
        raise ScopeUnavailableError(scope, run_id=results.pipeline_run_id)
    return value


def _is_credential_refusal(exc: ApiResponseError) -> bool:
    """True for the resolve route refusing the caller's credential, which stops the whole download."""
    return exc.status in {401, 403}


class _DownloadLocation(ArtifactLocation):
    """A reference of a download: where it sits, whether it is a stored file or a stored text, and the MIME type a
    stored text's reference states.
    """

    kind: DownloadedKind
    stated_mime_type: str | None = None

    def content_type(self, resolved: str | None) -> str | None:
        """A stored text's MIME type is its reference's; otherwise the platform's guess from the key."""
        return self.stated_mime_type or resolved


def _download_location(located: _LocatedReference) -> _DownloadLocation:
    rendered = _render_location(located)
    if located.text_kind is None:
        return _DownloadLocation(uri=rendered.uri, found_at=rendered.found_at, kind=DownloadedKind.FILE)
    stated = (located.text_reference or {}).get("mime_type")
    return _DownloadLocation(
        uri=rendered.uri,
        found_at=rendered.found_at,
        kind=DownloadedKind.TEXT,
        stated_mime_type=stated if isinstance(stated, str) else None,
    )


def _item_error(location: _DownloadLocation, content_type: str | None, code: str, detail: str) -> DownloadedArtifact:
    """One reference's failure, as a value on the verdict — still saying where the reference sits."""
    return DownloadedArtifact(
        uri=location.uri,
        kind=location.kind,
        found_at=location.found_at,
        path=None,
        content_type=content_type,
        size=None,
        error=ArtifactItemError(code=code, detail=detail),
    )


def _is_expired(expires_at: str | None) -> bool:
    """True when a link is at or past its expiry, margin included; an unreadable stamp is not."""
    if expires_at is None:
        return False
    try:
        parsed = datetime.fromisoformat(expires_at)
    except ValueError:
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return (parsed - datetime.now(UTC)).total_seconds() <= _EXPIRY_MARGIN_SECONDS


async def _process_one(
    *,
    client: ArtifactCapableClient,
    storage_client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    budget: _DownloadBudget,
    bounds: _FetchBounds,
    target_dir: Path,
    scope: ArtifactScope,
    location: _DownloadLocation,
    name_path: Sequence[_PathSegment],
    text_kind: StoredTextKind | None,
    entry: ResolvedArtifact,
) -> DownloadedArtifact:
    """One reference's whole pipeline — the semaphore's slot, a re-resolve on expiry, then the save
    under the name its first path gives it.
    """
    uri = location.uri
    async with semaphore:
        if budget.credential_failure is not None:
            return _item_error(location, location.content_type(entry.content_type), "aborted", _SKIPPED_CREDENTIAL)
        if entry.error is None and _is_expired(entry.expires_at):
            try:
                entry = (await resolve_artifacts(client, [uri]))[0]
            except ApiResponseError as exc:
                if _is_credential_refusal(exc):
                    budget.credential_failure = exc
                    return _item_error(location, location.content_type(entry.content_type), "aborted", _SKIPPED_CREDENTIAL)
                msg = f"The expired link could not be re-resolved: {exc}."
                return _item_error(location, location.content_type(entry.content_type), "resolve_failed", msg)
            except (PipelineRequestError, ValidationError, ValueError) as exc:
                # Anything else the re-resolve can fail with — an unreachable host, a malformed
                # answer, a body that does not parse — is this one reference's error, never the
                # whole download's: the other references already have their links.
                msg = f"The expired link could not be re-resolved: {exc}."
                return _item_error(location, location.content_type(entry.content_type), "resolve_failed", msg)
        if entry.error is not None:
            return _item_error(location, location.content_type(None), entry.error.code, entry.error.detail)
        content_type = location.content_type(entry.content_type)
        if entry.url is None:
            msg = "The bulk resolve route answered an item with neither a link nor an error."
            return _item_error(location, content_type, "resolve_failed", msg)
        extension = _extension_for(uri, content_type) if text_kind is None else _text_extension_for(text_kind, content_type)
        return await _save_one(
            storage_client=storage_client,
            budget=budget,
            bounds=bounds,
            target_dir=target_dir,
            location=location,
            filename=_filename_for(name_path, extension=extension, scope=scope),
            download_url=entry.url,
            content_type=content_type,
        )


class _TargetFile:
    """A file created exclusively under the download directory, written in the background thread.

    Exclusive creation is what makes "never overwrite" true rather than merely likely: an
    exists-check followed by a write would race a concurrent task.
    """

    def __init__(self, handle: BinaryIO, path: Path) -> None:
        self._handle = handle
        self.path = path

    async def write(self, chunk: bytes) -> None:
        """Write one whole chunk; Python's buffered writer never returns a short write."""
        await asyncio.to_thread(self._handle.write, chunk)

    def close(self) -> None:
        """Close the handle, surfacing a failed flush."""
        self._handle.close()

    def remove(self) -> None:
        """Close and unlink, so nothing truncated is left under a final name.

        Synchronous on purpose: this runs on the cancellation path too, where another `await` could
        be interrupted before the partial file is gone.
        """
        try:
            self._handle.close()
        except OSError:
            pass
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass


def _open_unique_file(target_dir: Path, base_name: str) -> _TargetFile:
    """Create `base_name` under `target_dir` exclusively, suffixing the stem until a free name is found."""
    extension = _extension_of(base_name)
    stem = base_name[: len(base_name) - len(extension)]
    for attempt in range(_MAX_UNIQUE_ATTEMPTS):
        candidate = target_dir / (base_name if attempt == 0 else f"{stem}-{attempt}{extension}")
        try:
            descriptor = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            continue
        return _TargetFile(os.fdopen(descriptor, "wb"), candidate)
    msg = f"Could not find a free filename for {base_name} in {target_dir}."
    raise OSError(msg)


async def _save_one(
    *,
    storage_client: httpx.AsyncClient,
    budget: _DownloadBudget,
    bounds: _FetchBounds,
    target_dir: Path,
    location: _DownloadLocation,
    filename: str,
    download_url: str,
    content_type: str | None,
) -> DownloadedArtifact:
    """Fetch one resolved link and write it under the download directory as `filename`, suffixed on a
    collision, within the total budget.
    """
    uri = location.uri
    target: _TargetFile | None = None
    written = 0
    reserved = 0
    share_taken = False

    def share() -> int:
        return max(written, reserved)

    try:
        async with _stream_resolved_url(storage_client, uri, download_url, bounds) as stream:
            declared = _declared_length(stream.headers)
            reserved = declared if declared is not None else 0
            if budget.committed + reserved > budget.max_total_bytes:
                msg = (
                    f"Saving this {_format_mib(reserved)} artifact would take the download past its "
                    f"{_format_mib(budget.max_total_bytes)} total limit."
                )
                return _item_error(location, content_type, "total_limit_exceeded", msg)
            budget.committed += reserved
            share_taken = True

            try:
                # Synchronous on purpose: a cancellation landing inside a worker thread would leave a file
                # the handler below cannot see, and an exclusive create is not worth a thread.
                target = _open_unique_file(target_dir, filename)
            except OSError as exc:
                budget.committed -= share()
                share_taken = False
                msg = f"The file could not be created: {exc}."
                return _item_error(location, content_type, "write_failed", msg)

            async for chunk in stream.aiter_bytes():
                # Only the bytes past this file's reservation are new to the total.
                growth = max(written + len(chunk), reserved) - share()
                if budget.committed + growth > budget.max_total_bytes:
                    target.remove()
                    budget.committed -= share()
                    share_taken = False
                    msg = f"This artifact took the download past its {_format_mib(budget.max_total_bytes)} total limit."
                    return _item_error(location, content_type, "total_limit_exceeded", msg)
                budget.committed += growth
                written += len(chunk)
                try:
                    await target.write(chunk)
                except OSError as exc:
                    target.remove()
                    budget.committed -= share()
                    share_taken = False
                    msg = f"The file could not be written: {exc}."
                    return _item_error(location, content_type, "write_failed", msg)
    except ArtifactFetchError as exc:
        if target is not None:
            target.remove()
        if share_taken:
            budget.committed -= share()
        return _item_error(location, content_type, exc.reason, str(exc))
    except (httpx.HTTPError, OSError) as exc:
        # Every transport failure of the fetch is already an `ArtifactFetchError` (`network`), and every
        # failure to write the file a `write_failed`, so what reaches here is a fault the SDK cannot place:
        # `unknown`, never read as one a retry can pass, as `@pipelex/sdk`'s `classifyFailure` labels it.
        if target is not None:
            target.remove()
        if share_taken:
            budget.committed -= share()
        msg = f"The artifact could not be read: {exc}."
        return _item_error(location, content_type, "unknown", msg)
    except asyncio.CancelledError:
        # A cancelled download leaves nothing truncated behind, then lets the cancellation through.
        if target is not None:
            target.remove()
        if share_taken:
            budget.committed -= share()
        raise

    try:
        target.close()
    except OSError as exc:
        target.remove()
        budget.committed -= share()
        msg = f"The file could not be closed: {exc}."
        return _item_error(location, content_type, "write_failed", msg)

    # A body shorter than it declared gives the unused reservation back.
    budget.committed -= share() - written
    return DownloadedArtifact(
        uri=uri, kind=location.kind, found_at=location.found_at, path=str(target.path), content_type=content_type, size=written, error=None
    )


def _assemble_verdict(scope: ArtifactScope, artifacts: list[DownloadedArtifact]) -> DownloadArtifactsResult:
    """The verdict over one walk: the saved paths in discovery order, and whether every one was saved."""
    saved_paths = [artifact.path for artifact in artifacts if artifact.error is None and artifact.path is not None]
    return DownloadArtifactsResult(
        scope=scope,
        artifacts=artifacts,
        saved_paths=saved_paths,
        all_saved=len(saved_paths) == len(artifacts),
    )
