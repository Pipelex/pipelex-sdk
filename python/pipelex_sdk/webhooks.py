"""Caller webhooks: the `run.finished` event a Pipelex runtime sends each URL a run registered in `callback_urls`
once the run has ended, the receiver's verification of a call, and the shapes of the hosted delivery log and of an
organization's signing secret.

The contract is the spec `conformance/specs/pipelex-caller-webhooks.md`, in the `conformance` repository: a call is
a Standard Webhooks v1 `POST`, its `webhook-id`, `webhook-timestamp` and `webhook-signature` headers signing
`{webhook-id}.{webhook-timestamp}.{body}` with HMAC-SHA256 under a `whsec_` secret, and its body a `run.finished`
event. `verify_webhook` follows the spec's verification procedure step by step and is held to its known-answer
vectors, a byte-identical copy of which this package's tests run (`tests/fixtures/caller-webhooks/`), as
`@pipelex/sdk`'s `verifyWebhook` is. See `docs/webhooks.md`.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import re
from collections.abc import Iterable, Mapping, Sequence
from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Final, Literal, Protocol, TypeAlias, cast

from mthds.protocol.problem.client_problems import make_client_problem
from mthds.protocol.problem.registry import CoreCode
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictInt, StrictStr, ValidationError, model_validator

from pipelex_sdk.answer_reading import LenientProblem
from pipelex_sdk.errors import (
    RequestArgumentError,
    WebhookEventUnreadableError,
    WebhookRefusal,
    WebhookVerificationError,
    argument_invalid_problem,
)

# ── The event ─────────────────────────────────────────────────────────

RUN_FINISHED_EVENT_TYPE: Final = "run.finished"
"""The `type` of the event a run's end sends: one type for every ending, the outcome in `data.status`."""

WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: Final = 300
"""How far a call's `webhook-timestamp` may be from the receiver's clock, either way, in seconds: five minutes, as the
contract sets it. A call further away is refused, which bounds how long a captured call can be replayed."""

# The largest integer JavaScript holds exactly, `Number.MAX_SAFE_INTEGER`: an event's `attempt` and a call's
# `webhook-timestamp` past it are refused, so this package and `@pipelex/sdk` read and refuse the same calls.
_MAX_SAFE_INTEGER: Final = 2**53 - 1


def _whole_number_of(value: object) -> object:
    """A number written with a zero fraction, such as `2.0`, as the integer it is: JSON does not tell `2` from `2.0`,
    and `@pipelex/sdk`, which reads both as `2`, accepts either. Anything else is left for the field to judge.
    """
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


class RunFinishedEventData(BaseModel):
    """A `run.finished` event's `data`: the run as its caller's status read served it when the delivery was created,
    the same on every attempt and replay of the delivery.

    Two shapes reach a receiver today, and this model reads both. A self-hosted runner sends the MTHDS protocol's
    status read (`pipeline_run_id`, a lowercase `status`, `completed` or `failed`, and for a failed run its problem as
    `error`, a member with no value left out). The hosted plane sends the body of its own `GET /v1/runs/{id}/status`
    (this SDK's `RunRead`) without `callback_urls`: an uppercase `status`, `COMPLETED`, `FAILED`, `CANCELLED`,
    `TERMINATED` or `TIMED_OUT`, a member with no value written as `null`, and the platform's own members, such as
    `finished_at`, `method_id` and `request_id`, which ride `model_extra`. That shape does not validate against the
    contract's JSON Schema, which describes the protocol's read; the hosted event follows its status read onto the
    protocol's shape when that read moves, with no change of its own. To tell a success from a failure under both
    spellings, compare `status.lower()` with `"completed"`.
    """

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: StrictStr
    """The run that ended."""
    status: StrictStr
    """How it ended, in either spelling; read open, so a status this SDK does not name arrives as its raw string."""
    error: LenientProblem = None
    """A failed run's problem, in its caller's view: never its `diagnostics`. Kept when it is a problem document, and
    read as `None` otherwise, or when absent, as on a completed run."""


class RunFinishedEvent(BaseModel):
    """The body of the call a run's end makes to each URL it registered: a `run.finished` event.

    The event never carries the run's results; fetch them with `get_run_result` and the `pipeline_run_id` of `data`.
    A receiver deduplicates on the `webhook-id` header, never on the body or `attempt`. A member a later contract adds
    rides `model_extra`, and a receiver ignores it.
    """

    model_config = ConfigDict(extra="allow")

    type: Literal["run.finished"]
    timestamp: StrictStr
    """When the run ended, its `finished_at`, as an RFC 3339 date-time in UTC. Not the call's send time."""
    attempt: Annotated[StrictInt, BeforeValidator(_whole_number_of), Field(ge=1, le=_MAX_SAFE_INTEGER)]
    """Which attempt of the delivery this call is, from 1. Informational: it increases with each retry and a replay
    continues it, but a runtime that runs its delivery step again may skip numbers or start again at 1 under the same
    `webhook-id`, so never rely on it being unique or gapless."""
    data: RunFinishedEventData
    """The run as its caller's status read served it; see `RunFinishedEventData`."""


class UnknownWebhookEvent(BaseModel):
    """An event whose `type` this SDK does not read, every member riding `model_extra`.

    A receiver acknowledges it with a `2xx` rather than failing it, so the sender does not retry an event the
    receiver has no use for.
    """

    model_config = ConfigDict(extra="allow")

    type: StrictStr

    @model_validator(mode="after")
    def _not_a_known_type(self) -> UnknownWebhookEvent:
        if self.type == RUN_FINISHED_EVENT_TYPE:
            msg = "A run.finished event is read as a RunFinishedEvent."
            raise ValueError(msg)
        return self


WebhookEvent: TypeAlias = RunFinishedEvent | UnknownWebhookEvent
"""What `verify_webhook` returns: a `run.finished` event, or one of a type this SDK does not read."""

# ── Verification ──────────────────────────────────────────────────────


class _ListsHeaderItems(Protocol):
    """Headers that list their `(name, value)` pairs through `items()`, as every mapping does, and as Werkzeug's
    `Headers`, Flask's `request.headers`, does without being a mapping.
    """

    def items(self) -> Iterable[tuple[str, object]]: ...


WebhookHeaders: TypeAlias = Mapping[str, str | bytes | Sequence[str | bytes] | None] | _ListsHeaderItems
"""The headers of a call, as a receiver's framework hands them over: a plain `dict`, Starlette's, httpx's or Werkzeug's
`Headers` (FastAPI's and Flask's `request.headers`), or any object listing its `(name, value)` pairs through
`items()`. Names are matched whatever their case. A value may be text or bytes, which are read as Latin-1, as HTTP
reads a field's octets. A header listed more than once, or given as a list of values, is read as its values joined by
a space, which for `webhook-signature` lists every signature they carry."""

_SECRET_PREFIX: Final = "whsec_"
_SIGNATURE_VERSION: Final = "v1"
_ID_HEADER: Final = "webhook-id"
_TIMESTAMP_HEADER: Final = "webhook-timestamp"
_SIGNATURE_HEADER: Final = "webhook-signature"
_WEBHOOK_HEADERS: Final = frozenset({_ID_HEADER, _TIMESTAMP_HEADER, _SIGNATURE_HEADER})
_UNIX_SECONDS: Final = re.compile(r"[0-9]+")
# The digits of `_MAX_SAFE_INTEGER`: a `webhook-timestamp` with more, once its leading zeros are dropped, is past it,
# which is read without converting a number of any length.
_MAX_SAFE_INTEGER_DIGITS: Final = len(str(_MAX_SAFE_INTEGER))
# What separates the entries of a `webhook-signature`: the spaces HTTP allows in a field, a space and a tab.
_SIGNATURE_ENTRY_SEPARATOR: Final = re.compile(r"[ \t]+")


def verify_webhook(
    body: bytes | bytearray | memoryview | str,
    headers: WebhookHeaders,
    secret: str | Sequence[str],
    *,
    now: datetime | None = None,
) -> WebhookEvent:
    """Verify a call to a caller webhook and read its event.

    It follows the contract's procedure: it refuses a call missing one of the three headers, then one whose
    `webhook-timestamp` is more than five minutes from `now`, then one whose `webhook-signature` lists no `v1`
    signature matching its own, computed from the raw body under each secret given and compared in constant time.
    Only then does it parse the body.

    Give `body` exactly as received, the raw bytes or their text, never a value parsed and written again: the same
    JSON written with other bytes signs differently. In FastAPI or Starlette, read `await request.body()`; in Flask,
    `request.get_data()`.

    Args:
        body: The call's raw body.
        headers: The call's headers: a `dict`, a framework's `Headers` (Starlette's, httpx's or Werkzeug's), or any
            object listing its `(name, value)` pairs through `items()`; see `WebhookHeaders`.
        secret: The `whsec_` secret the runtime signs with: the organization's, which its admins read with
            `get_webhook_secret`, or the one a self-hosted runner's operator configured. During a rotation give both,
            the call then verifying under either: the hosted plane signs every call with the new secret and the
            previous one for 24 hours.
        now: The receiver's clock, as a timezone-aware `datetime`, which the call's `webhook-timestamp` must be
            within five minutes of; the current time when `None`. Given for a test, or to verify a call received
            earlier. A naive `datetime` is refused, since which instant it names depends on the machine's time zone.

    Returns:
        The event: a `RunFinishedEvent`, or an `UnknownWebhookEvent` for a `type` this SDK does not read, to
        acknowledge and ignore. Deduplicate on the `webhook-id` header, since a delivery can arrive more than once.

    Raises:
        WebhookVerificationError: The call is refused; its `refusal` says why. Answer it with a status outside `2xx`.
        WebhookEventUnreadableError: The call is verified but holds no event this SDK reads.
        RequestArgumentError: `secret` is not a `whsec_` secret written in standard base64 with its padding,
            `body` is neither text nor bytes, `now` is no timezone-aware `datetime`, or `headers` lists no
            `(name, value)` pairs or gives one of the three headers a value that is neither text nor bytes, before
            the call is judged.
    """
    keys = _signing_keys(secret)
    body_bytes = _bytes_of(body)
    clock = _clock_of(now)

    header_values = _header_values(headers)
    webhook_id = header_values.get(_ID_HEADER)
    webhook_timestamp = header_values.get(_TIMESTAMP_HEADER)
    webhook_signature = header_values.get(_SIGNATURE_HEADER)
    if webhook_id is None or webhook_timestamp is None or webhook_signature is None:
        missing: str
        if webhook_id is None:
            missing = _ID_HEADER
        elif webhook_timestamp is None:
            missing = _TIMESTAMP_HEADER
        else:
            missing = _SIGNATURE_HEADER
        msg = f"The call carries no {missing} header, so it cannot be verified."
        raise WebhookVerificationError(msg, refusal=WebhookRefusal.MISSING_HEADER)

    sent_at = _unix_seconds_of(webhook_timestamp)
    if sent_at is None:
        msg = "The call's webhook-timestamp is not a whole number of Unix seconds this SDK reads."
        raise WebhookVerificationError(msg, refusal=WebhookRefusal.TIMESTAMP)
    distance = abs(math.floor(clock.timestamp()) - sent_at)
    if distance > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS:
        msg = (
            f"The call's webhook-timestamp is {distance} seconds from this clock, more than the "
            f"{WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} the contract accepts."
        )
        raise WebhookVerificationError(msg, refusal=WebhookRefusal.TIMESTAMP)

    signed = f"{webhook_id}.{webhook_timestamp}.".encode() + body_bytes
    given = _given_signatures(webhook_signature)
    verified = False
    for key in keys:
        expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest())
        # Every given signature is compared, whatever an earlier comparison found.
        for candidate in given:
            if hmac.compare_digest(expected, candidate.encode("utf-8")):
                verified = True
    if not verified:
        msg = "No v1 signature of the call matches its body under the secret given."
        raise WebhookVerificationError(msg, refusal=WebhookRefusal.SIGNATURE)

    return _read_webhook_event(body_bytes)


def _clock_of(now: datetime | None) -> datetime:
    """The receiver's clock: `now` when given, the current time otherwise.

    Raises:
        RequestArgumentError: `now` is no `datetime` (`not_a_date`), or a naive one (`not_timezone_aware`).
    """
    # Checked as an `object`: the annotation is a promise to the type checker, not to an untyped caller.
    given_clock = cast("object", now)
    if given_clock is None:
        return datetime.now(tz=UTC)
    if not isinstance(given_clock, datetime):
        msg = "verify_webhook() takes now as a datetime."
        raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="now", reason="not_a_date"))
    if given_clock.utcoffset() is None:
        msg = (
            "verify_webhook() takes now as a timezone-aware datetime, such as datetime.now(tz=UTC): a naive one names "
            "a different instant on each machine's time zone."
        )
        raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="now", reason="not_timezone_aware"))
    return given_clock


def _unix_seconds_of(text: str) -> int | None:
    """A `webhook-timestamp` as its number of Unix seconds, or `None` when it is not digits alone or is past
    `_MAX_SAFE_INTEGER`, which `@pipelex/sdk` cannot hold exactly and refuses too. The bound is checked on the digits
    before any conversion, so a timestamp of any length is refused rather than converted.
    """
    if _UNIX_SECONDS.fullmatch(text) is None:
        return None
    digits = text.lstrip("0") or "0"
    if len(digits) > _MAX_SAFE_INTEGER_DIGITS:
        return None
    seconds = int(digits)
    return seconds if seconds <= _MAX_SAFE_INTEGER else None


def _signing_keys(secret: object) -> list[bytes]:
    """Each secret's key, the bytes after its `whsec_` prefix decoded from standard base64."""
    secrets: list[object]
    if isinstance(secret, str) or not isinstance(secret, Sequence):
        secrets = [secret]
    else:
        secrets = list(cast("Sequence[object]", secret))
    if not secrets:
        msg = "verify_webhook() needs at least one secret to verify a call with."
        raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="secret", reason="empty"))
    keys: list[bytes] = []
    for value in secrets:
        if not isinstance(value, str):
            msg = f"verify_webhook() takes each secret as a string; got {type(value).__name__}."
            raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="secret", reason="not_a_string"))
        key = _decode_standard_base64(value.removeprefix(_SECRET_PREFIX)) if value.startswith(_SECRET_PREFIX) else None
        if key is None:
            # The secret itself is never quoted: it is the receiver's credential.
            msg = (
                "verify_webhook() takes a secret written `whsec_` and its key in standard base64 with its padding, "
                "as the runtime gives it; give the whole value."
            )
            raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="secret", reason="malformed"))
        keys.append(key)
    return keys


def _decode_standard_base64(text: str) -> bytes | None:
    """`text` decoded from standard base64 with its padding, or `None` for anything else."""
    if not text or not text.isascii():
        return None
    try:
        key = base64.b64decode(text, validate=True)
    except binascii.Error:
        return None
    # A last quantum whose unused bits are not zero decodes, but is not how the key is written.
    return key if base64.b64encode(key).decode("ascii") == text else None


def _bytes_of(body: object) -> bytes:
    """A call's body as the bytes it was signed over: text in UTF-8, bytes as given."""
    if isinstance(body, str):
        return body.encode("utf-8")
    if isinstance(body, bytes):
        return body
    if isinstance(body, bytearray):
        return bytes(body)
    if isinstance(body, memoryview):
        return cast("memoryview[int]", body).tobytes()
    msg = "verify_webhook() takes the call's raw body as bytes or str."
    raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="body", reason="not_text_or_bytes"))


def _header_values(headers: object) -> dict[str, str]:
    """The values of the call's three Standard Webhooks headers, by their lowercase names, whatever the case the call
    writes them in; a header absent or empty is left out.

    The headers are read through `items()`, which lists `(name, value)` pairs for a `dict`, for Starlette's, httpx's
    and Werkzeug's `Headers` alike, rather than by iterating them, which yields names from a mapping but pairs from
    Werkzeug. A header listed more than once, or given as a list, is read as its values joined by a space. A value in
    bytes is decoded as Latin-1, as HTTP reads a field's octets.

    Raises:
        RequestArgumentError: `headers` has no `items()` (`not_a_mapping`), or one of the three headers holds a value
            that is neither text nor bytes (`not_text_or_bytes`).
    """
    items = getattr(headers, "items", None)
    if not callable(items):
        msg = "verify_webhook() takes the call's headers as a mapping of their names to their values, such as a dict or a framework's Headers."
        raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="headers", reason="not_a_mapping"))
    found: dict[str, list[str]] = {}
    for given_name, value in cast("Iterable[tuple[object, object]]", items()):
        name = _latin1_text(given_name)
        if name is None or name.lower() not in _WEBHOOK_HEADERS:
            continue
        found.setdefault(name.lower(), []).extend(_header_texts(value, name=name.lower()))
    joined = {name: " ".join(text for text in texts if text) for name, texts in found.items()}
    return {name: text for name, text in joined.items() if text}


def _header_texts(value: object, *, name: str) -> list[str]:
    """The texts of one header's value: none for `None`, one for text or bytes, one per item for a list of them.

    Raises:
        RequestArgumentError: The value, or an item of it, is neither text nor bytes.
    """
    if value is None:
        return []
    parts: list[object] = list(cast("Sequence[object]", value)) if _is_list_of_values(value) else [value]
    texts: list[str] = []
    for part in parts:
        text = _latin1_text(part)
        if text is None:
            msg = f"verify_webhook() takes each header's value as text or bytes; the {name} header holds {type(part).__name__}."
            raise RequestArgumentError(msg, problem=argument_invalid_problem(argument="headers", reason="not_text_or_bytes"))
        texts.append(text)
    return texts


def _is_list_of_values(value: object) -> bool:
    """Whether a header's value lists several values, as a sequence that is neither text nor bytes."""
    return isinstance(value, Sequence) and not isinstance(value, str | bytes | bytearray)


def _latin1_text(value: object) -> str | None:
    """Text as given, bytes decoded as Latin-1, which maps each octet to one character, or `None` for anything else."""
    if isinstance(value, str):
        return value
    if isinstance(value, bytes | bytearray):
        return bytes(value).decode("latin-1")
    return None


def _given_signatures(header: str) -> list[str]:
    """The `v1` signatures a `webhook-signature` lists, an entry of any other version ignored.

    Entries are separated by spaces. A comma ending an entry is dropped: a header sent more than once reaches a receiver
    joined by a comma and a space, as fetch's `Headers`, Node and httpx join a repeated field, and a signature, written
    in base64, never ends with one.
    """
    signatures: list[str] = []
    for entry in _SIGNATURE_ENTRY_SEPARATOR.split(header):
        version, comma, signature = entry.removesuffix(",").partition(",")
        if comma and version == _SIGNATURE_VERSION:
            signatures.append(signature)
    return signatures


def _refuse_json_constant(constant: str) -> object:
    # `NaN` and `Infinity` are no JSON, which `JSON.parse` refuses too.
    msg = f"{constant} is not JSON"
    raise ValueError(msg)


def _read_webhook_event(body_bytes: bytes) -> WebhookEvent:
    """The event a verified body holds; see `WebhookEventUnreadableError` for what it refuses."""
    try:
        text = body_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        msg = "The verified call's body is not UTF-8 text."
        raise WebhookEventUnreadableError(msg, problem=make_client_problem(CoreCode.REQUEST_MALFORMED, params={"reason": "not_utf8"})) from exc
    try:
        parsed: object = json.loads(text, parse_constant=_refuse_json_constant)
    except ValueError as exc:
        msg = "The verified call's body is not JSON."
        raise WebhookEventUnreadableError(msg, problem=make_client_problem(CoreCode.REQUEST_MALFORMED, params={"reason": "not_json"})) from exc
    # A body that is no object reads as an empty one, so its fault is its `type`.
    event: dict[str, Any] = cast("dict[str, Any]", parsed) if isinstance(parsed, dict) else {}
    event_type = event.get("type")
    if isinstance(event_type, str) and event_type != RUN_FINISHED_EVENT_TYPE:
        return UnknownWebhookEvent.model_validate(event)
    try:
        return RunFinishedEvent.model_validate(event)
    except ValidationError as exc:
        fault = _faulty_member(exc)
        msg = f"The verified call's body is not a webhook event this SDK reads: its member `{fault}` is missing or of the wrong type."
        raise WebhookEventUnreadableError(msg, problem=make_client_problem(CoreCode.REQUEST_INVALID, params={"field": fault})) from exc


def _faulty_member(error: ValidationError) -> str:
    """The member, as a dotted path such as `data.status`, that the first of `error`'s faults is about.

    The model checks its members in the order it declares them, `type`, `timestamp`, `attempt`, then `data`, and
    `data`'s own in theirs, so the first fault names the first member that keeps the body from being a `run.finished`
    event, as `@pipelex/sdk` names it.
    """
    return ".".join(str(part) for part in error.errors()[0]["loc"])


# ── The hosted delivery log ───────────────────────────────────────────


class WebhookDeliveryState(StrEnum):
    """Where a delivery stands: `pending` while on its retry schedule, `delivered` once a receiver answered `2xx`,
    `failed` past its last attempt, which a replay can still deliver.
    """

    PENDING = "pending"
    DELIVERED = "delivered"
    FAILED = "failed"


class WebhookAttemptFailure(StrEnum):
    """Why an attempt got no HTTP answer: `timeout` (none within fifteen seconds), `connection` (none could be made,
    or it was cut), `tls` (the handshake failed, the receiver's certificate included), `refused_address` (the host
    resolved to a private, loopback, link-local or metadata address, or to none).
    """

    TIMEOUT = "timeout"
    CONNECTION = "connection"
    TLS = "tls"
    REFUSED_ADDRESS = "refused_address"


class WebhookDeliveryAttempt(BaseModel):
    """One attempt of a delivery: when it was sent, what came back, how long it took. No response body is kept."""

    model_config = ConfigDict(extra="allow")

    attempt: int
    """The attempt's number, from 1: the body's `attempt`."""
    attempted_at: str
    """When it was sent, ISO-8601 UTC."""
    status_code: int | None = None
    """The HTTP status the receiver answered; `None` when no answer came."""
    failure: Annotated[WebhookAttemptFailure | str | None, Field(union_mode="left_to_right")] = None
    """Why no answer came; `None` when one did. A reason this SDK does not name arrives as its raw string."""
    duration_ms: int | None = None
    """How long it took, in milliseconds."""


class WebhookDeliverySummary(BaseModel):
    """One delivery of a run's webhook, as anyone who can read the run sees it."""

    model_config = ConfigDict(extra="allow")

    delivery_id: str
    """The receiver's `webhook-id`, the same on every attempt and replay: `whd_` followed by ASCII letters, digits
    and underscores, at most 64 characters in all. Treat it as opaque, a key to deduplicate on and nothing to parse."""
    pipeline_run_id: str
    """The run whose event the delivery carries."""
    url_index: int
    """The URL's position in the run's `callback_urls`, from 0."""
    url: str
    """The URL redacted, as every view shows a registered URL: its scheme, its host and a port other than the
    scheme's default, with `/***` in place of a path or query string, which may hold the receiver's credential."""
    state: Annotated[WebhookDeliveryState | str, Field(union_mode="left_to_right")]
    """Where the delivery stands; a state this SDK does not name arrives as its raw string."""
    event_type: str
    """The event's `type`, `run.finished`."""
    created_at: str
    """When the delivery was recorded, ISO-8601 UTC."""
    attempts: list[WebhookDeliveryAttempt] = Field(default_factory=list[WebhookDeliveryAttempt])
    """Every attempt so far, oldest first, replays included."""


class WebhookDeliveryDetail(WebhookDeliverySummary):
    """One delivery with its event as sent — `GET /v1/runs/{id}/webhook-deliveries/{delivery_id}`."""

    event: dict[str, Any]
    """The body of the delivery's latest attempt, as sent: `type`, `timestamp`, `attempt` and `data`, every attempt's
    body differing only in its `attempt`. Before any attempt, the body its first attempt carries. Kept as sent rather
    than read as a `WebhookEvent`, so a receiver's log can be compared with it as parsed JSON: it equals the body the
    attempt brought its receiver as a JSON value, not as the same bytes."""


class WebhookDeliveryList(BaseModel):
    """A run's deliveries — `GET /v1/runs/{id}/webhook-deliveries`."""

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: str
    deliveries: list[WebhookDeliverySummary]
    """One delivery per URL the run registered, in their order, once the run has ended; none for a run that
    registered none or has not ended."""


class WebhookReplayAccepted(BaseModel):
    """A replay queued — the `202` of `POST /v1/runs/{id}/webhook-deliveries/{delivery_id}/replay`."""

    model_config = ConfigDict(extra="allow")

    pipeline_run_id: str
    delivery_id: str
    """The delivery replayed: the `webhook-id` the replay is sent under."""
    attempt: int
    """The attempt number the replay is sent under. A replay asked again before this one is sent is this same
    attempt."""


# ── The organization's signing secret ─────────────────────────────────


class WebhookSecret(BaseModel):
    """An organization's webhook signing secret — `GET /v1/organizations/{org_id}/webhook-secret` and its rotation.

    Only the current secret's value is served: the previous one, still signing until `previous_secret_expires_at`,
    is the one a receiver already holds. Treat the model as a credential: never log it.
    """

    model_config = ConfigDict(extra="allow")

    secret: str = Field(repr=False)
    """`whsec_` and the base64 of 32 random bytes: give the whole value to `verify_webhook`."""
    created_at: str
    """When the organization's first secret was generated, ISO-8601 UTC."""
    rotated_at: str | None = None
    """When it was last rotated; `None` when never."""
    previous_secret_expires_at: str | None = None
    """Until when the secret the last rotation replaced still signs beside this one, ISO-8601 UTC; `None` once that
    has passed, or when nothing was replaced."""
