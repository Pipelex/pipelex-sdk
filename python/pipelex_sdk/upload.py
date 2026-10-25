"""`upload_file` — the single-asset upload convenience over the raw `upload()` wire
call. Accepts `str`/`pathlib.Path` filesystem paths and raw `bytes`, and returns an
`UploadRecord` assembled client-side. Python counterpart of `pipelex-sdk-js`'s
`uploadFile`. See `docs/input-preparation.md`.

The MIME type and size are known client-side at upload time, so the record is built
without extending the `/v1/upload` response.

What an upload is recorded as travels with it: its `kind` and, for a test file, the method it is for
(`UploadKindOptions`), checked here before any file is read, as the upload route checks them
(`checked_upload_kind`). See `docs/files.md`, "Uploading a test file".
"""

from __future__ import annotations

import asyncio
import base64
import errno
import json
import mimetypes
from pathlib import Path
from typing import Protocol

from mthds.protocol.problem.answers import read_problem_document
from pydantic import BaseModel, ConfigDict

from pipelex_sdk.errors import (
    ABORT_TIMEOUT_CODE,
    ApiResponseError,
    ApiUnreachableError,
    InputPreparationError,
    InvalidLocalSourceError,
    MethodErrorCode,
    RejectedAssetError,
    RejectedAssetReason,
    RequestArgumentError,
    TestFileRefusalReason,
    TestFileRefusedError,
    UnsupportedUploadCapabilityError,
    UploadAuthenticationError,
    UploadTransportError,
    UploadTransportReason,
    argument_invalid_problem,
)
from pipelex_sdk.method_selector import parse_method_selector
from pipelex_sdk.product_models import UploadedFile, UploadInput, UploadKind

DEFAULT_CONTENT_TYPE = "application/octet-stream"
DEFAULT_FILENAME = "upload.bin"

# A local asset `upload_file` accepts. A bare string in `upload_file` is a filesystem
# path; `prepare_inputs` classifies strings (url vs path) before they reach here.
UploadSource = str | Path | bytes


class UploadRecord(BaseModel):
    """The record `upload_file` returns for a prepared asset. Beyond the source identity it
    guarantees the resulting `uri`, the MIME `content_type`, the `size` in bytes, and the
    `filename`. A content checksum is deliberately not included — best-effort at most, and
    within-preparation dedup keys on source identity.
    """

    uri: str
    filename: str
    content_type: str
    size: int


class UploadKindOptions(BaseModel):
    """What an upload is recorded as, sent with it to `POST /v1/upload`: its `kind` and, for a test file,
    the method it is for. `prepare_inputs` takes it as its `upload` argument, for every file it uploads;
    `upload_file` takes the same pair as its `kind` and `method_id` arguments.

    It holds the pair and checks only each member's type, as pydantic does when it is built: a `kind` that
    names no `UploadKind` is refused there. The rules the upload route holds the pair to are checked by
    `checked_upload_kind`, before any file is read, so `prepare_inputs` refuses a pair the route would
    refuse with the `InputPreparationError` `upload_file` raises. The twin of `@pipelex/sdk`'s
    `UploadKindOptions`.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: UploadKind | None = None
    """What the upload is recorded as; `uploaded` when `None`."""
    method_id: str | None = None
    """The bare catalog id of the method a `test` file is for, required with `kind="test"` and refused
    without it."""


def _described_argument(value: object) -> str:
    """A value an upload's kind or method was given as, described for a refusal without quoting more than an id."""
    if isinstance(value, str):
        return json.dumps(value)
    return type(value).__name__


def _checked_kind(kind: object, *, refusal: str, field: str) -> UploadKind | None:
    """The upload's `kind` as the `UploadKind` it names, `None` when absent, refused when it names none."""
    if kind is None:
        return None
    if isinstance(kind, str):
        try:
            return UploadKind(kind)
        except ValueError:
            pass
    msg = f'{refusal}: `{field}kind` is "uploaded" or "test", got {_described_argument(kind)}.'
    raise InputPreparationError(msg, problem=argument_invalid_problem(argument=f"{field}kind", reason="unknown_value"))


def _checked_method_id(method_id: object, *, refusal: str, field: str) -> str | None:
    """The upload's `method_id`, `None` when absent, refused unless it is a bare catalog id."""
    if method_id is None:
        return None
    argument = f"{field}method_id"
    if not isinstance(method_id, str):
        msg = f"{refusal}: `{argument}` names a method by its bare catalog id, got {_described_argument(method_id)}."
        raise InputPreparationError(msg, problem=argument_invalid_problem(argument=argument, reason="not_a_string"))
    try:
        parsed = parse_method_selector(method_id)
    except RequestArgumentError as exc:
        msg = f"{refusal}: `{argument}` {json.dumps(method_id)} is not a catalog id, which is mt_ followed by letters, digits, _ or -."
        raise InputPreparationError(msg, problem=argument_invalid_problem(argument=argument, reason="not_a_catalog_id")) from exc
    if parsed.version is not None:
        msg = (
            f"{refusal}: `{argument}` names the method a test file is for by its bare catalog id, with no version suffix, "
            f"got {json.dumps(method_id)}."
        )
        raise InputPreparationError(msg, problem=argument_invalid_problem(argument=argument, reason="version_suffix"))
    return method_id


def checked_upload_kind(*, kind: object, method_id: object, refusal: str, field: str = "") -> UploadKindOptions:
    """The `kind` and `method_id` an upload is sent with, checked as the upload route checks them.

    A request the route would refuse with a `422` is refused here, before any file is read: a `kind` is
    `uploaded` or `test` (a `str` naming one is read as the `UploadKind` it names), a `method_id` is a
    bare catalog id, `kind="test"` needs one and only a test file names one. `None` reads as absent, and
    an absent member is not sent. The twin of `@pipelex/sdk`'s `uploadKindFields`.

    Args:
        kind: The upload's kind, as the caller gave it.
        method_id: The method a test file is for, as the caller gave it.
        refusal: What the refusal's message opens with, such as `Cannot upload`.
        field: What each member's name is prefixed with in a refusal, such as `upload.` for
            `prepare_inputs`, which names `upload.kind` and `upload.method_id`.

    Returns:
        The checked pair, each member `None` when it is not to be sent.

    Raises:
        InputPreparationError: A member the upload route would refuse, its `problem`
            `client.argument_invalid` naming the member as `field` prefixes it.
    """
    checked_kind = _checked_kind(kind, refusal=refusal, field=field)
    checked_method_id = _checked_method_id(method_id, refusal=refusal, field=field)
    is_test_file: bool
    match checked_kind:
        case UploadKind.TEST:
            is_test_file = True
        case UploadKind.UPLOADED | None:
            is_test_file = False
    if is_test_file and checked_method_id is None:
        msg = f'{refusal}: a test file names the method it is for; give `{field}method_id` with `{field}kind="test"`.'
        raise InputPreparationError(msg, problem=argument_invalid_problem(argument=f"{field}method_id", reason="missing"))
    if not is_test_file and checked_method_id is not None:
        msg = f'{refusal}: only a test file names a method; give `{field}method_id` with `{field}kind="test"` alone.'
        raise InputPreparationError(msg, problem=argument_invalid_problem(argument=f"{field}method_id", reason="without_test_kind"))
    return UploadKindOptions(kind=checked_kind, method_id=checked_method_id)


class _UploadClient(Protocol):
    """The client surface `upload_file` needs — the raw base64 `upload` wire call."""

    async def upload(self, upload_input: UploadInput) -> UploadedFile: ...


def _guess_content_type(filename: str) -> str:
    """MIME guess from a filename extension; `application/octet-stream` when unknown."""
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or DEFAULT_CONTENT_TYPE


def _read_path(path: Path) -> bytes:
    """Read a filesystem path into bytes, mapping read failures to `InvalidLocalSourceError`.

    The message names the system's error code (`ENOENT`, `EACCES`, …), the one `@pipelex/sdk`'s
    `uploadFile` names, so the refusal reads the same from either SDK.
    """
    try:
        return path.read_bytes()
    except OSError as exc:
        code = errno.errorcode.get(exc.errno, "read error") if exc.errno is not None else "read error"
        msg = f'Local file cannot be read: "{path}" ({code}).'
        raise InvalidLocalSourceError(msg, source=str(path)) from exc


def _to_asset_bytes(source: UploadSource, filename: str | None, content_type: str | None) -> tuple[bytes, str, str]:
    """Normalize any accepted asset form into bytes plus a filename and MIME."""
    if isinstance(source, bytes):
        resolved_name = filename or DEFAULT_FILENAME
        return source, resolved_name, content_type or _guess_content_type(resolved_name)
    path = Path(source)
    data = _read_path(path)
    resolved_name = filename or path.name or DEFAULT_FILENAME
    return data, resolved_name, content_type or _guess_content_type(resolved_name)


def _test_file_refusal_of(error: ApiResponseError, method_id: str | None) -> TestFileRefusalReason | None:
    """Which refusal of a test file an upload's error is, or `None` for any other.

    Each is read off the problem's code, never the status alone, and only for an upload that named a method,
    as a test file does: a `403` that is not `auth.forbidden` is a refused credential, and a `404` is an
    unknown method only when the answer is the platform's `pipelex.catalog.not_found`, not the `404` of a
    deployment without the route. `@pipelex/sdk`'s `testFileRefusalOf` reads the same codes.
    """
    if method_id is None:
        return None
    match error.problem.code:
        case "auth.forbidden":
            return TestFileRefusalReason.ROLE_NOT_PERMITTED
        case MethodErrorCode.BEING_DELETED:
            return TestFileRefusalReason.METHOD_BEING_DELETED
        case MethodErrorCode.NOT_FOUND:
            return TestFileRefusalReason.METHOD_NOT_FOUND
        case _:
            return None


def _test_file_refusal_message(reason: TestFileRefusalReason, error: ApiResponseError, filename: str, method_id: str | None) -> str:
    """The message of a test file's refusal, naming the file, the method and what to do."""
    refused = f'Upload of "{filename}" as a test file was refused ({error.status})'
    method = "the method it names" if method_id is None else f'the method "{method_id}"'
    match reason:
        case TestFileRefusalReason.ROLE_NOT_PERMITTED:
            detail = _without_final_period(error.problem.detail)
            return f'{refused}: {detail}. Upload it as "uploaded", or with the credential of a member who may change methods.'
        case TestFileRefusalReason.METHOD_NOT_FOUND:
            return f"{refused}: {method} is not one of the organization's methods."
        case TestFileRefusalReason.METHOD_BEING_DELETED:
            return f"{refused}: {method} is being deleted."


def _answered_detail(error: ApiResponseError) -> str | None:
    """The problem's `detail`, without its final period, when the API answered a problem document; else `None`."""
    if not error.problem.detail or read_problem_document(error.response_body, status=error.status, headers={}) is None:
        return None
    return _without_final_period(error.problem.detail)


def _without_final_period(text: str) -> str:
    """`text` without the period that ends it, for a sentence quoted inside another."""
    return text.removesuffix(".")


def _map_upload_error(error: ApiResponseError | ApiUnreachableError, filename: str, *, method_id: str | None) -> InputPreparationError:
    """Translate a raw `upload()` transport error into the matching preparation error, as `@pipelex/sdk`'s
    `mapUploadError` does.

    The wrapped error is passed as the new error's `cause`, whose problem it carries: the refusal as the API or
    its edge answered it, and a bare `401` or `403` reads by its status. `method_id` is the method a test file
    named, which a refusal must name to be read as one of a test file.
    """
    if isinstance(error, ApiUnreachableError):
        msg = f'Upload of "{filename}" could not reach the Pipelex API ({error.network_code or "unreachable"}).'
        # The client's own request timeout surfaces as an unreachable host with this code.
        reason = UploadTransportReason.TIMEOUT if error.network_code == ABORT_TIMEOUT_CODE else UploadTransportReason.UNREACHABLE
        return UploadTransportError(msg, filename=filename, reason=reason, cause=error)
    if 200 <= error.status < 300:
        # A 2xx the client could not read: storage may hold the file, but under no reference the SDK
        # can return.
        msg = (
            f'Upload of "{filename}" was answered ({error.status}) with a body the SDK could not read, '
            "so whether and where the file was stored is unknown."
        )
        return UploadTransportError(msg, status=error.status, filename=filename, reason=UploadTransportReason.UNEXPECTED, cause=error)
    # A test file refused for what it claims, its role or its method, before the status alone is read as a
    # refused credential or a deployment without upload.
    refusal = _test_file_refusal_of(error, method_id)
    if refusal is not None:
        return TestFileRefusedError(
            _test_file_refusal_message(refusal, error, filename, method_id),
            status=error.status,
            reason=refusal,
            filename=filename,
            method_id=method_id,
            cause=error,
        )
    match error.status:
        case 413:
            detail = _answered_detail(error) or "asset exceeds the service size limit"
            return RejectedAssetError(
                f'The server rejected "{filename}": {detail}.',
                filename=filename,
                status=error.status,
                reason=RejectedAssetReason.TOO_LARGE,
                problem=error.problem,
            )
        case 401 | 403:
            return UploadAuthenticationError(
                f'Upload of "{filename}" was not authorized ({error.status}). Check the configured Pipelex API key.',
                status=error.status,
                filename=filename,
                cause=error,
            )
        case 404:
            return UnsupportedUploadCapabilityError(
                "The configured Pipelex deployment does not support file upload (no /v1/upload route). Upload is a hosted Pipelex capability.",
                filename=filename,
            )
        case _:
            detail = _answered_detail(error) or error.status_text
            reason = UploadTransportReason.SERVER_ERROR if error.status >= 500 else UploadTransportReason.UNEXPECTED
            return UploadTransportError(
                f'Upload of "{filename}" failed ({error.status}): {detail}.', status=error.status, filename=filename, reason=reason, cause=error
            )


async def upload_file(
    client: _UploadClient,
    source: UploadSource,
    *,
    filename: str | None = None,
    content_type: str | None = None,
    kind: UploadKind | None = None,
    method_id: str | None = None,
) -> UploadRecord:
    """Upload one local asset and return its `UploadRecord`.

    `source` is a filesystem path (`str`/`Path`) or raw `bytes`. `kind` and `method_id` say what the
    upload is recorded as, `uploaded` when no kind is given, and a `test` file names the method it is
    for by its bare catalog id; they are checked before the asset is read (`checked_upload_kind`) and
    sent only when given. Maps the raw `upload()` transport errors onto the semantic input-preparation
    errors: a `413` is a rejected asset, a test file refused for its role or its method a
    `TestFileRefusedError`, any other `401`/`403` an auth failure, any other `404` an unsupported upload
    capability, an unreachable host a transport failure, and a `2xx` answer the client could not read an
    `unexpected` transport failure, since whether and where the file was stored is unknown.
    The auth failure's problem is `auth.missing_credential` when the client holds no API key, so
    sent none, and `auth.invalid_credential` when it sent one.

    Raises:
        InputPreparationError: A `kind` or `method_id` the upload route would refuse, before the asset
            is read; or one of the subclasses above.
    """
    claimed = checked_upload_kind(kind=kind, method_id=method_id, refusal="Cannot upload")
    # Offload the (possibly large) synchronous file read off the event loop — `read_bytes`
    # releases the GIL during the underlying os.read, so other coroutines run during disk I/O.
    # base64 stays inline on purpose: CPython's binascii holds the GIL, so threading it would
    # not free the loop (and this matches the JS SDK, which also reads off-loop but encodes inline).
    data, resolved_name, resolved_type = await asyncio.to_thread(_to_asset_bytes, source, filename, content_type)
    encoded = base64.b64encode(data).decode("ascii")
    # A cancellation that landed once the bytes were read, while they were encoded, stops here, before
    # the upload request, rather than at the request's own first wait: nothing is uploaded once the
    # caller has stopped.
    await asyncio.sleep(0)
    try:
        uploaded = await client.upload(
            UploadInput(filename=resolved_name, data=encoded, content_type=resolved_type, kind=claimed.kind, method_id=claimed.method_id)
        )
    except (ApiResponseError, ApiUnreachableError) as exc:
        raise _map_upload_error(exc, resolved_name, method_id=claimed.method_id) from exc
    return UploadRecord(uri=uploaded.uri, filename=uploaded.filename, content_type=resolved_type, size=len(data))
