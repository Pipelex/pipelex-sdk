"""`prepare_inputs` — signature-driven input preparation. Names the method three ways,
resolves the target pipe's declared inputs from the standard's input-form descriptor,
interprets the caller's inputs top-down against it, uploads the file-bearing values, and
returns rewritten inputs (canonical content carrying `pipelex-storage://` in `url`) plus one
upload record per prepared asset. Python counterpart of `pipelex-sdk-js`'s `prepareInputs`.

The signature comes from ONE `POST /v1/pipe-io`, which selects the pipe server-side and returns
its input-form descriptor with no dry run, and the walk is discriminated on each descriptor
node's declared `kind` — never on the shape of a value. That is the whole point: the previous
source, the explicit inputs template, marked a file position by rendering a `{"url": …}` dict,
which is a side effect of a field being NAMED `url` rather than of its concept being an Image or
a Document. Two positions were misread as a result — an OPTIONAL nested file field, which the
required-only template never rendered, was left un-uploaded and its local path travelled to the
runner as a literal string; and a text field merely named `url` was read from disk and uploaded. The descriptor states the resolved
kind at every depth and includes optional fields, so both are gone.

See `docs/input-preparation.md`. The design of record is shared with `@pipelex/sdk` and
tracked as L-260829-300c50 in the workspace ledger.
"""

from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, NamedTuple, Protocol, assert_never, cast
from urllib.parse import unquote_to_bytes

from mthds.method_tree.models import MethodTree
from mthds.protocol.input_form import (
    BooleanItem,
    DateItem,
    DocumentItem,
    EnumItem,
    ImageItem,
    InputFormItem,
    ListItem,
    NumberItem,
    ObjectItem,
    ProseItem,
    TextItem,
    UnknownItem,
)
from pydantic import BaseModel, ValidationError

from pipelex_sdk.crate_models import CrateInvalidReport, PipeIORequest, PipeIOValidReport
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict
from pipelex_sdk.errors import (
    ApiResponseError,
    InputPreparationError,
    InvalidInputValueError,
    MethodLoadError,
    UploadNotAllowedError,
    UploadNotAllowedKind,
)
from pipelex_sdk.upload import UploadRecord, UploadSource, upload_file

if TYPE_CHECKING:
    from collections.abc import Callable

    from mthds.method_tree.file_entry import FileEntry

    from pipelex_sdk.crate_models import PipeIOResponse
    from pipelex_sdk.product_models import UploadedFile, UploadInput

PIPELEX_STORAGE_SCHEME = "pipelex-storage://"
_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

# How `/v1/pipe-io` says it refused the pipe selection, which `_fetch_signature` turns into an
# `InputPreparationError`: a `422` whose `error_type` is one of the engine's entry-lookup errors
# (pipelex-api >= 0.33.1). `EntryPipeNotFoundError` is an unknown `pipe_ref`, a manifest
# `main_pipe` the closure lacks, or no `pipe_ref` and no `main_pipe`; `EntryPipeAmbiguousError` is
# a bare code matching pipes in several domains, or no `pipe_ref` and several `main_pipe`s. Every
# other `422` — a malformed body, a `method_ref` that does not parse or fetch, a stored method with
# no source — is not a selection and stays the `ApiResponseError` it is. The names are the
# runner's exception classes; they live here alone, so a rename upstream is a one-line edit.
_HTTP_UNPROCESSABLE_ENTITY = 422
_PIPE_SELECTION_ERROR_TYPES: frozenset[str] = frozenset({"EntryPipeNotFoundError", "EntryPipeAmbiguousError"})


class PreparedInputs(BaseModel):
    """The result of `prepare_inputs`: rewritten inputs (copy-on-write) plus upload records.

    `inputs` is a copy of the caller's inputs with each file-bearing value rewritten to
    canonical content carrying `pipelex-storage://` in `url`. `uploads` carries one record
    per uploaded asset — pass-through references (http(s), existing storage URIs) produce none.
    """

    inputs: dict[str, Any]
    uploads: list[UploadRecord]


class _PrepareClient(Protocol):
    """The client surface `prepare_inputs` needs: raw `upload` plus `pipe_io` as the
    signature source. Typed as `PipelexAPIClient`'s own signatures so the client satisfies it
    structurally.
    """

    async def upload(self, upload_input: UploadInput) -> UploadedFile: ...

    async def pipe_io(self, request: PipeIORequest) -> PipeIOResponse: ...


class _PrepareContext:
    """Mutable state threaded through one preparation walk."""

    def __init__(self, client: _PrepareClient, *, allow_uploads: bool) -> None:
        self.client = client
        # False under `allow_uploads=False`: every upload-needing value is refused before it is read.
        self.allow_uploads = allow_uploads
        self.uploads: list[UploadRecord] = []
        # Dedup by source identity: same source (str/bytes/Path value) uploads once.
        self.dedup: dict[UploadSource, str] = {}


def _caller_selector(value: object, *, argument: str) -> str | None:
    """A caller-supplied selector, trimmed — `None` when absent, refused when not a string.

    The "empty is absent" rule, plus a boundary check. Coercing a non-string to `None` here
    would read `method_ref=123` as an absent selector and let it fall through to another one —
    defeating the exactly-one check this whole surface rests on — and would let a non-string
    `pipe_ref` silently take the default pipe instead of the one the caller named. Both are
    caller mistakes, and a caller mistake owes an `InputPreparationError` raised before any
    request.

    Deliberately local rather than reusing `client.py`'s `_normalized_selector`: that helper
    is private to the client boundary and raises `PipelineRequestError`, where every failure
    of this module owes an `InputPreparationError`.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    msg = f"Cannot prepare inputs: `{argument}` must be a string, got {type(value).__name__}."
    raise InputPreparationError(msg)


def _caller_files(value: object) -> dict[str, FileEntry] | None:
    """The caller's `files` map — `None` when absent or empty, refused when not a map.

    A `files` that is not a map, such as the retired list of `content` and `source` items, is a
    caller mistake rather than an absent selector: read as absent, a non-empty list beside a real
    selector would slip past the XOR, and alone it would fail later as pydantic's refusal instead
    of the `InputPreparationError` this module owes, raised before any request with the wording
    `@pipelex/sdk` uses.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        return cast("dict[str, FileEntry]", value) or None
    kind = "a list" if isinstance(value, list) else type(value).__name__
    msg = f"Cannot prepare inputs: `files` must be the method's tree as a map from tree path to file entry, got {kind}."
    raise InputPreparationError(msg)


def _kind_of(value: object) -> str:
    """How a value that should have been a map, or a map's value, is named in a refusal."""
    return "a list" if isinstance(value, list) else type(value).__name__


def _caller_map(value: object, *, argument: str, holds: str, value_ok: Callable[[object], bool]) -> dict[str, Any] | None:
    """The caller's `contents` or `dependencies` — `None` when absent or empty, refused when not a map of what it holds.

    Refused before any request, as `_caller_files` refuses a `files` that is not a map: read as
    absent, a list would leave the method unselected without a word, and a value of the wrong type
    would fail later as pydantic's refusal instead of the `InputPreparationError` this module owes,
    with the wording `@pipelex/sdk` uses.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        msg = f"Cannot prepare inputs: `{argument}` must be {holds}, got {_kind_of(value)}."
        raise InputPreparationError(msg)
    mapping = cast("dict[str, Any]", value)
    for key, entry in mapping.items():
        if not value_ok(entry):
            msg = f'Cannot prepare inputs: `{argument}` must be {holds}, and "{key}" holds {"None" if entry is None else _kind_of(entry)}.'
            raise InputPreparationError(msg)
    return mapping or None


def _caller_tree(value: object) -> MethodTree | None:
    """The caller's `tree` — `None` when absent, refused when it is not a listed tree or holds no file."""
    if value is None:
        return None
    if not isinstance(value, MethodTree):
        msg = (
            "Cannot prepare inputs: `tree` must be a listed method tree, a `MethodTree` such as the client's "
            f"`list_method_tree` returns, got {_kind_of(value)}."
        )
        raise InputPreparationError(msg)
    if not value.files:
        msg = "Cannot prepare inputs: `tree` holds no file, and a method tree holds at least one."
        raise InputPreparationError(msg)
    return value


def _is_file_content(node: Any) -> bool:
    """A canonical Image/Document content is a dict carrying a `url` key.

    A value-shape helper only, consulted at a position the DESCRIPTOR already declared a
    file. It is no longer a classifier: reading it as one is the defect this module removed.
    """
    return isinstance(node, dict) and "url" in node


def _is_explicit_envelope(value: Any) -> bool:
    """The explicit `{concept, content}` input envelope — keys EXACTLY `concept` and `content`.

    Matches the runtime's `_is_explicit` (`input_shaper.py`), so an agent that filled an
    explicit template can hand it straight back. Anything else is a compact value.
    """
    if not isinstance(value, dict):
        return False
    return set(cast("dict[str, Any]", value)) == {"concept", "content"}


@dataclass(frozen=True)
class _InputPosition:
    """Where a value sits in the caller's inputs: the input it belongs to, and its path inside that
    input, `.field` for an object's declared field and `[index]` for a list's element. An explicit
    envelope adds nothing to the path, since its `content` is the input's value.
    """

    name: str
    path: str

    def field(self, field_name: str) -> _InputPosition:
        return _InputPosition(name=self.name, path=f"{self.path}.{field_name}")

    def element(self, index: int) -> _InputPosition:
        return _InputPosition(name=self.name, path=f"{self.path}[{index}]")


def _decode_data_url(data_url: str, at: _InputPosition) -> tuple[bytes, str]:
    """Decode a `data:` URL into bytes plus its MIME type.

    `at` is where the URL sits, for the error's wording only: the message never quotes the URL, which
    is the caller's data. A base64 payload is decoded with `validate=True` so junk characters are rejected rather
    than silently discarded (which would upload corrupted bytes), and a decode failure (bad
    padding or non-alphabet input) surfaces as a typed `InvalidInputValueError` — never a raw
    `binascii.Error` escaping the preparation contract. A non-base64 payload decodes straight
    to bytes via `unquote_to_bytes`, so percent-encoded binary keeps its exact bytes (decoding
    it as UTF-8 text first would corrupt any byte ≥ 0x80).
    """
    comma = data_url.find(",")
    if comma < 0:
        msg = f'Input "{at.path}" holds a malformed data URL (no comma separator).'
        raise InvalidInputValueError(msg, input_name=at.name, input_path=at.path)
    header = data_url[5:comma]  # strip "data:"
    payload = data_url[comma + 1 :]
    content_type = header.split(";")[0] or "application/octet-stream"
    if ";base64" in header.lower():
        try:
            decoded = base64.b64decode(payload, validate=True)
        except binascii.Error as exc:
            msg = f'Input "{at.path}" holds a malformed data URL (invalid base64).'
            raise InvalidInputValueError(msg, input_name=at.name, input_path=at.path) from exc
        return decoded, content_type
    return unquote_to_bytes(payload), content_type


class _NoUpload(StrEnum):
    """A kind of source that needs no upload: a reference passes through as it is, and a value no file input
    takes is refused as an `InvalidInputValueError` whether uploads are allowed or not, before it reaches
    `_resolve_source`.
    """

    REFERENCE = "reference"
    UNSUPPORTED = "unsupported"


def _classify_source(source: Any) -> UploadNotAllowedKind | _NoUpload:
    """What a source at a file position is, read once from its type and prefix, never from the file a path
    names.

    `_resolve_file_position` reads this one answer: it refuses `_NoUpload.UNSUPPORTED` itself, and under
    `allow_uploads=False` every kind that is not a `_NoUpload`, so a source the resolver would upload is a
    source that guard refuses: a new kind of source is declared as needing no upload, or it is refused.
    """
    if isinstance(source, str):
        if source.startswith(PIPELEX_STORAGE_SCHEME) or _HTTP_URL_RE.match(source):
            return _NoUpload.REFERENCE
        if source.startswith("data:"):
            return UploadNotAllowedKind.DATA_URL
        # Anything else is a local filesystem path.
        return UploadNotAllowedKind.LOCAL_PATH
    if isinstance(source, Path):
        return UploadNotAllowedKind.LOCAL_PATH
    if isinstance(source, bytes):
        return UploadNotAllowedKind.BYTES
    return _NoUpload.UNSUPPORTED


# A kind of source the resolver takes: every kind but `_NoUpload.UNSUPPORTED`, which never reaches it.
_ResolvableKind = UploadNotAllowedKind | Literal[_NoUpload.REFERENCE]


async def _do_resolve_source(ctx: _PrepareContext, source: Any, kind: _ResolvableKind, at: _InputPosition) -> str:
    """Resolve one classified source to the URL/URI to write. `at` words a malformed `data:` URL's error."""
    match kind:
        case _NoUpload.REFERENCE:
            return cast("str", source)  # already prepared, or a reachable URL — pass through
        case UploadNotAllowedKind.DATA_URL:
            data, content_type = _decode_data_url(source, at)
            record = await upload_file(ctx.client, data, content_type=content_type)
        case UploadNotAllowedKind.LOCAL_PATH | UploadNotAllowedKind.BYTES:
            record = await upload_file(ctx.client, source)
        case _:
            assert_never(kind)
    ctx.uploads.append(record)
    return record.uri


async def _resolve_source(ctx: _PrepareContext, source: Any, kind: _ResolvableKind, at: _InputPosition) -> str:
    """Resolve a classified source, deduped by identity (same source uploads once)."""
    hashable = isinstance(source, (str, bytes, Path))
    if hashable and source in ctx.dedup:
        return ctx.dedup[source]
    resolved = await _do_resolve_source(ctx, source, kind, at)
    if hashable:
        ctx.dedup[source] = resolved
    return resolved


def _describe_unsupported(value: Any) -> str:
    """What a value no file input takes is, in words naming its kind and never its content, for the message
    that refuses it: `a number`, `None`, `a dict with no "url" key`.
    """
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, list):
        return "a list"
    if isinstance(value, dict):
        return "{url} content" if "url" in value else 'a dict with no "url" key'
    type_name = type(value).__name__
    return f"{'an' if type_name[:1].lower() in 'aeiou' else 'a'} {type_name}"


# The forms a file input takes, in the words of the refusal of a value it does not.
_FILE_FORMS_WITH_UPLOADS = (
    ": pass a local path (a str or a Path), bytes, a data: URL, an http(s) URL or a pipelex-storage:// reference, "
    "bare or as the url of {url} content."
)
# The same under `allow_uploads=False`, word for word `UploadNotAllowedError`'s tail.
_FILE_FORMS_WITHOUT_UPLOADS = ", and this preparation uploads nothing: pass an http(s) URL or a pipelex-storage:// reference instead."


async def _resolve_file_position(ctx: _PrepareContext, caller_value: Any, at: _InputPosition) -> Any:
    """Resolve a value known to sit at a file position into canonical content with a rewritten `url`.

    A value no file input takes is refused here, where its position and the mode are known, and under
    `allow_uploads=False` so is a source that would need an upload, before `_resolve_source` could read,
    decode or upload it.
    """
    content = cast("dict[str, Any]", caller_value) if _is_file_content(caller_value) else None
    source = content["url"] if content is not None else caller_value
    kind = _classify_source(source)
    match kind:
        case _NoUpload.UNSUPPORTED:
            described = _describe_unsupported(source)
            held = f"{{url}} content whose url is {described}" if content is not None else described
            forms = _FILE_FORMS_WITH_UPLOADS if ctx.allow_uploads else _FILE_FORMS_WITHOUT_UPLOADS
            msg = f'Input "{at.path}" holds {held}, which no file input takes{forms}'
            raise InvalidInputValueError(msg, input_name=at.name, input_path=at.path)
        case _NoUpload.REFERENCE:
            pass
        case UploadNotAllowedKind.LOCAL_PATH | UploadNotAllowedKind.DATA_URL | UploadNotAllowedKind.BYTES:
            if not ctx.allow_uploads:
                raise UploadNotAllowedError(input_name=at.name, input_path=at.path, value_kind=kind)
    resolved = await _resolve_source(ctx, source, kind, at)
    if content is not None:
        return {**content, "url": resolved}
    return {"url": resolved}


async def _resolve_node(ctx: _PrepareContext, node: InputFormItem, caller_value: Any, at: _InputPosition) -> Any:
    """Descriptor-guided walk, discriminated on the node's declared kind.

    - `document` / `image` — a file position, whatever the value's shape;
    - `object` — walk the declared `fields` by name; keys the descriptor does not name are
      copied through untouched. An OPTIONAL field is walked when present, which is what
      makes an optional nested file reachable at all;
    - `list` — walk `item` against each element;
    - every other kind — pass through at any depth. `unknown` is the standard's escape hatch
      for a `Dynamic` / `Composite` input and is deliberately NOT entered: the signature
      declares no file there, and uploading on the strength of a `url` key is the value-shape
      guess this walk removes. Such a caller uploads with `upload_file` first and passes the
      storage URI.

    A caller value whose shape disagrees with the node (a scalar at an `object`, a non-list at
    a `list`) passes through for the run to reject — preparation never second-guesses the
    signature. The match is over the item classes rather than over `kind`, because each
    per-kind `*Field` derives from its `*Item`: one set of patterns covers both the named
    layer (top level, `object.fields`) and the nameless one (`list.item`), and it narrows the
    node for the type checker where matching on `node.kind` would not.
    """
    match node:
        case DocumentItem() | ImageItem():
            return await _resolve_file_position(ctx, caller_value, at)
        case ObjectItem():
            if not isinstance(caller_value, dict):
                return caller_value
            caller_dict = cast("dict[str, Any]", caller_value)
            result: dict[str, Any] = dict(caller_dict)
            for field in node.fields:
                if field.name in caller_dict:
                    result[field.name] = await _resolve_node(ctx, field, caller_dict[field.name], at.field(field.name))
            return result
        case ListItem():
            if not isinstance(caller_value, list):
                return caller_value
            elements = cast("list[Any]", caller_value)
            return [await _resolve_node(ctx, node.item, element, at.element(index)) for index, element in enumerate(elements)]
        case TextItem() | ProseItem() | DateItem() | NumberItem() | BooleanItem() | EnumItem() | UnknownItem():
            return caller_value


class _MethodSelection(NamedTuple):
    """The method selector `prepare_inputs` sends, normalized: exactly one of the tree, `method_ref` and `method_id`."""

    files: dict[str, FileEntry] | None
    tree: MethodTree | None
    contents: dict[str, bytes | str] | None
    dependencies: dict[str, dict[str, FileEntry]] | None
    method_ref: str | None
    method_id: str | None


def _resolve_selector(
    *,
    files: dict[str, FileEntry] | None,
    tree: MethodTree | None,
    contents: dict[str, bytes | str] | None,
    dependencies: dict[str, dict[str, FileEntry]] | None,
    method_ref: str | None,
    method_id: str | None,
) -> _MethodSelection:
    """Normalize the three selectors and check that exactly one remains.

    Empty is absent — `files={}`, `contents={}`, `method_ref=""`, `method_id="  "` — mirroring the
    run options' rule and the `CrateRequestBase` normalizers, so an empty selector may sit beside
    a real one without tripping the XOR. The tree counts as one selector, given in exactly one of
    `files`, `tree` and `contents`, and the `dependencies` it calls accompany it alone. A `files`
    that is not a map is refused rather than read as absent, and so are a `contents` that is not a
    map of bytes or text, a `dependencies` that is not a map of file maps, and a `tree` that is not
    a `MethodTree` or holds no file. A
    non-string `method_ref` / `method_id` is NOT absent but refused, so a mistyped selector cannot
    slip past the XOR as a silent `None`. The check lives here, rather than in `PipeIORequest`'s
    own validator, so that it raises the `InputPreparationError` this module owes, and it runs
    BEFORE any request.
    """
    selected_files = _caller_files(files)
    selected_tree = _caller_tree(tree)
    selected_contents = cast(
        "dict[str, bytes | str] | None",
        _caller_map(
            contents,
            argument="contents",
            holds="the method's files as a map from tree path to bytes or text",
            value_ok=lambda entry: isinstance(entry, bytes | str),
        ),
    )
    selected_dependencies = cast(
        "dict[str, dict[str, FileEntry]] | None",
        _caller_map(
            dependencies,
            argument="dependencies",
            holds="the method packages as a map from package address to its map of file entries",
            value_ok=lambda entry: isinstance(entry, dict),
        ),
    )
    selected_method_ref = _caller_selector(method_ref, argument="method_ref")
    selected_method_id = _caller_selector(method_id, argument="method_id")

    tree_forms: list[str] = []
    if selected_files is not None:
        tree_forms.append("`files`")
    if selected_tree is not None:
        tree_forms.append("`tree`")
    if selected_contents is not None:
        tree_forms.append("`contents`")
    if len(tree_forms) > 1:
        msg = (
            f"Cannot prepare inputs: the method's tree was given as {' and '.join(tree_forms)}. Give it in one form — `files`, `tree` or `contents`."
        )
        raise InputPreparationError(msg)

    given: list[str] = list(tree_forms)
    if selected_method_ref is not None:
        given.append("`method_ref`")
    if selected_method_id is not None:
        given.append("`method_id`")

    if not given:
        msg = (
            "Cannot prepare inputs: no method selector. Supply exactly one of the method's tree (`files`, "
            "`tree` or `contents`), `method_ref` (a published method's address) or `method_id` (a stored "
            "method's catalog id)."
        )
        raise InputPreparationError(msg)
    if len(given) > 1:
        msg = (
            f"Cannot prepare inputs: {' and '.join(given)} were {'both' if len(given) == 2 else 'all'} given. Supply exactly one method "
            "selector — the method's tree, `method_ref` or `method_id`."
        )
        raise InputPreparationError(msg)
    if selected_dependencies is not None and not tree_forms:
        msg = "Cannot prepare inputs: `dependencies` accompany the method's own tree; a published or stored method's packages are its own."
        raise InputPreparationError(msg)
    return _MethodSelection(
        files=selected_files,
        tree=selected_tree,
        contents=selected_contents,
        dependencies=selected_dependencies,
        method_ref=selected_method_ref,
        method_id=selected_method_id,
    )


def _checked_pipe_ref(pipe_ref: object) -> str | None:
    """The caller's `pipe_ref`, normalized — `None` when absent, refused when it names a dependency
    package's pipe, when bare, or when not a string. Both refusals are raised before any request, in
    the order `@pipelex/sdk`'s `normalizePipeRef` checks them, with the same wording.

    - An `alias->domain.pipe_code` ref is refused because the alias names a dependency package's
      pipe, and preparation covers the method's own pipes. The run route takes such a ref;
      preparation refuses it, and that asymmetry is deliberate.
    - A bare `pipe_code` is refused because a request names a pipe by its qualified ref. The route
      will refuse it too once the runner's shared selection enforces that rule; until then it would
      resolve a bare code across domains, and preparation does not lean on that fallback.
    """
    requested = _caller_selector(pipe_ref, argument="pipe_ref")
    if requested is None:
        return None
    if "->" in requested:
        msg = (
            f'Cannot prepare inputs: `pipe_ref` "{requested}" names a dependency package\'s pipe. '
            "Preparation covers the method's own pipes: name one as `domain.pipe_code`."
        )
        raise InputPreparationError(msg)
    if "." not in requested:
        msg = f'Cannot prepare inputs: `pipe_ref` must be qualified (`domain.pipe_code`), got the bare "{requested}".'
        raise InputPreparationError(msg)
    return requested


def _checked_allow_uploads(allow_uploads: object) -> bool:
    """The caller's `allow_uploads`, refused before any request when it is not a `bool`.

    A value of the wrong type is not read as either answer, since reading a stray `"false"` or `0` by
    its truthiness would decide, unseen, whether the caller's files are read and uploaded.
    """
    if isinstance(allow_uploads, bool):
        return allow_uploads
    msg = f"Cannot prepare inputs: `allow_uploads` must be a bool, got {type(allow_uploads).__name__}."
    raise InputPreparationError(msg)


def _is_pipe_selection_refusal(exc: ApiResponseError) -> bool:
    """Whether a `/v1/pipe-io` error is the route refusing the pipe selection, and nothing else."""
    return exc.status == _HTTP_UNPROCESSABLE_ENTITY and exc.error_type in _PIPE_SELECTION_ERROR_TYPES


async def _fetch_signature(client: _PrepareClient, *, request: PipeIORequest) -> PipeIOValidReport:
    """Ask `pipe_io` for the selected pipe's signature and hand back the valid report.

    The route selects the pipe — the request's `pipe_ref`, else the `main_pipe` of the
    `METHODS.toml` at the tree's root, sent or fetched, else the closure's single `main_pipe`
    declaration — so this module keeps no selection chain of its own, and a method that names
    its entry pipe in its manifest alone is selected like any other.

    The route runs no dry run. Preparation needs a pipe's DECLARED inputs, which static
    validation settles, so a pending signature elsewhere in the method does not refuse inputs
    to a pipe whose inputs are declared — whether the method runs is the run's verdict, not
    preparation's. An `is_valid: false` arm still means the closure does not load, which IS a
    preparation failure: a `MethodLoadError` carrying the answer's items and its own message.

    A refused selection — a `422` whose `error_type` is an entry-lookup error (see
    `_PIPE_SELECTION_ERROR_TYPES`) — becomes an `InputPreparationError` carrying the server's
    `detail`, which names the candidates where there are any, with the `ApiResponseError` kept as
    its `__cause__` for a caller who needs the whole problem document. Every other non-2xx
    propagates as the `ApiResponseError` it is.
    """
    try:
        response = await client.pipe_io(request)
    except ApiResponseError as exc:
        if not _is_pipe_selection_refusal(exc):
            raise
        reason = exc.server_message or exc.title or exc.response_body or exc.status_text
        msg = f"Cannot prepare inputs: the pipe could not be selected — {reason}"
        raise InputPreparationError(msg) from exc

    if isinstance(response, CrateInvalidReport):
        first = response.validation_errors[0].message if response.validation_errors else response.message
        msg = f"Cannot prepare inputs: the method signature did not resolve — {first}"
        raise MethodLoadError(msg, validation_errors=list(response.validation_errors), server_message=response.message)
    return response


async def prepare_inputs(
    client: _PrepareClient,
    *,
    files: dict[str, FileEntry] | None = None,
    tree: MethodTree | None = None,
    contents: dict[str, bytes | str] | None = None,
    dependencies: dict[str, dict[str, FileEntry]] | None = None,
    method_ref: str | None = None,
    method_id: str | None = None,
    pipe_ref: str | None = None,
    inputs: dict[str, Any],
    allow_uploads: bool = True,
) -> PreparedInputs:
    """Prepare a pipe's inputs: upload local/byte/data-URL assets at the signature's
    file-bearing positions and return copy-on-write rewritten inputs plus upload records.

    A value at a file input that cannot be a file — a value of a type no file input takes, or a
    `data:` URL that does not decode — raises `InvalidInputValueError`, naming the input and where
    inside it the value sits. With `allow_uploads=False`, nothing is read from disk or uploaded: a
    value that would need either raises `UploadNotAllowedError`, naming them too.

    Args:
        client: The client supplying `upload` and `pipe_io`.
        files: The method's tree as the protocol's map of file entries, sent as given. The tree
            is given in at most one of `files`, `tree` and `contents`, and is exactly one of the
            three selectors with `method_ref` and `method_id`.
        tree: The method's tree, listed from a directory (`PipelexAPIClient.list_method_tree`),
            sent inline when small and by hash otherwise, as `pipe_io` sends it.
        contents: The method's files, each one's bytes or text by tree path, sent as `tree` is.
        dependencies: The method packages the tree calls by address, each a map of file entries
            keyed by its address, sent as given; they accompany the tree alone.
        method_ref: A published method's address —
            `github.com/<owner>/<repo>[/<selector>][@<tag>]` — resolved by the runner.
        method_id: A stored method's hosted catalog id (`mt_…`), resolved by the platform.
            A pure pass-through: nothing is expanded client-side.
        pipe_ref: The target pipe as a QUALIFIED `domain.pipe_code`. Omit it and the route
            selects the method's entry pipe — see "Pipe selection" in
            `docs/input-preparation.md`. A bare `pipe_code` is refused before any request:
            the descriptor is keyed by qualified refs, and search is a run-route affordance
            this helper deliberately does not grow. So is an `alias->domain.pipe_code` ref,
            which names a dependency package's pipe rather than one of the method's own.
        inputs: The caller's inputs (variable name → value), compact or explicit-envelope
            per input.
        allow_uploads: Whether preparation may upload, `True` by default. With `False`, a value
            at a file input that would need an upload — a local path, a `data:` URL, bytes — is
            refused with `UploadNotAllowedError`, and nothing is read from disk, decoded or sent
            to the upload route; `http(s)` URLs and `pipelex-storage://` references pass through
            as always. It is for a server preparing inputs on a caller's behalf, which must never
            read a file of its own because the caller named it. It is not sent to the server.

    Returns:
        `PreparedInputs` — a copy of `inputs` with each file-bearing value rewritten to
        canonical content carrying `pipelex-storage://` in `url`, plus one `UploadRecord`
        per uploaded asset.

    Raises:
        InputPreparationError: No selector or several; a selector or `pipe_ref` that is not a
            string; a `files`, `contents` or `dependencies` that is not a map of what it holds, a
            `tree` that is not a `MethodTree` or holds no file, or any other selector the pipe I/O
            request refuses, each before any request; a bare `pipe_ref`, or one naming a dependency package's pipe
            (`alias->domain.pipe_code`); the closure did not resolve; the route refused the pipe
            selection with the runner's entry-lookup `error_type` (pipelex-api >= 0.33.1) — an
            unknown `pipe_ref`, or no `pipe_ref` and a method declaring no single entry pipe —
            carrying the server's `detail`, with the `ApiResponseError` as its `__cause__`. Two of
            its subclasses name who must change: `MethodLoadError` when the closure does not load
            (the method), `InvalidInputValueError` when a value at a file position is unusable, a
            `data:` URL that does not decode or a value of a type no file input takes (the inputs),
            beside `InvalidLocalSourceError` for a local path that cannot be read, and
            `UploadNotAllowedError` under `allow_uploads=False` for a value that would need an
            upload; an `allow_uploads` that is not a `bool` is refused before any request. HTTP(S) URLs and existing
            `pipelex-storage://` URIs pass through unchanged, and every failure is raised
            BEFORE any run is created.
        ApiResponseError: Any other no-verdict condition from `/v1/pipe-io` — an unknown or
            foreign-org `method_id` or no package at a `method_ref` address (`404`), a
            `method_ref` that does not parse or fetch or a stored method with no source
            (`422`), a registry-form `method_ref` (`501`), auth, a server fault, or an API that
            does not serve the route at all; and a 2xx answer the client cannot parse, an input-form
            descriptor that is malformed or names a kind the pinned `mthds` does not define
            included, with a `runtime` verdict, before anything is walked or uploaded.
    """
    selection = _resolve_selector(files=files, tree=tree, contents=contents, dependencies=dependencies, method_ref=method_ref, method_id=method_id)
    # Checked here rather than after the round-trip, so a mistyped or bare `pipe_ref` is refused
    # on the same pre-request boundary as a mistyped selector.
    requested_pipe_ref = _checked_pipe_ref(pipe_ref)
    uploads_allowed = _checked_allow_uploads(allow_uploads)
    try:
        request = PipeIORequest(
            files=selection.files,
            tree=selection.tree,
            contents=selection.contents,
            dependencies=selection.dependencies,
            method_ref=selection.method_ref,
            method_id=selection.method_id,
            pipe_ref=requested_pipe_ref,
        )
    except ValidationError as exc:
        # What the checks above do not read, such as a `files` entry that is no file entry, is the
        # request model's to refuse; it is still the caller's selector, refused before any request.
        first = exc.errors(include_url=False, include_input=False)[0]
        where = ".".join(str(part) for part in first["loc"])
        msg = f"Cannot prepare inputs: the method selector does not form a pipe I/O request: {where}: {first['msg']}."
        raise InputPreparationError(msg) from exc
    report = await _fetch_signature(client, request=request)

    selected_pipe_ref = report.pipe_ref
    descriptor = report.input_form.get(selected_pipe_ref) if selected_pipe_ref is not None else None
    if descriptor is None:
        # The route promises the selected pipe's descriptor on every single-pipe valid answer.
        # Never a silent degrade to "no uploads": without it there is no signature to prepare
        # against, and the caller's local paths would travel to the runner verbatim.
        # The API broke its own contract here, so the verdict is `runtime`, not the inputs' `input`.
        msg = f"Cannot prepare inputs: the pipe-io answer carries no input-form descriptor for the selected pipe ({selected_pipe_ref!r})."
        raise InputPreparationError(msg, verdict=ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False))
    declared = {field.name: field for field in descriptor.fields}

    ctx = _PrepareContext(client, allow_uploads=uploads_allowed)
    rewritten = dict(inputs)
    for name, caller_value in inputs.items():
        field = declared.get(name)
        if field is None:
            # Not a declared input — pass through untouched.
            continue
        if _is_explicit_envelope(caller_value):
            # Unwrap, walk the content against the same node, re-wrap: the concept annotation
            # rides through to the run, which accepts the envelope as an input.
            envelope = cast("dict[str, Any]", caller_value)
            walked = await _resolve_node(ctx, field, envelope["content"], _InputPosition(name=name, path=name))
            rewritten[name] = {**envelope, "content": walked}
        else:
            rewritten[name] = await _resolve_node(ctx, field, caller_value, _InputPosition(name=name, path=name))

    return PreparedInputs(inputs=rewritten, uploads=ctx.uploads)
