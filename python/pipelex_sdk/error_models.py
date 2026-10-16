"""Error-report wire models — a failed run's stored report, and the typed members of a problem document.

**The runner owns these shapes; this SDK follows them.** A run that fails reports why as the runner's
`ErrorReport` (`pipelex.base_exceptions`), which the hosted platform stores whole on the run row as
`error` and serves through the runner's STRICT disclosure: on the status read (`RunRead.error`), on
the run records (`PipelineRun.error`, `RunHistoryItem.error`), and inside the problem document of
the results read's `409`, where the
client lifts it onto `RunResultFailed.error` and `RunFailedError.error`. The same classification
fields (`error_domain`, `user_action`, …) ride a runner-rendered problem document as extension
members, which a refused request's `ApiResponseError` reads through `HostedProblemMembers`, so its
`user_action` is `ProblemUserAction` — kept only whole, `kind` and `detail` both required — while a
stored report's is the lenient `UserAction` declared here, both fields optional, because a report
written by another runner version must never fail the read carrying it. The two share their field
names, so code that shows the next step reads `user_action.detail` on either, checking it for `None`
on a report.

**The hosted plane's problem document predates the standard's.** The MTHDS core names a problem by a
registered `code` and carries its faults as problem items in `errors[]`; the platform sends its own
closed `code` (`conflict`, `not_found`, …) and its field-level `errors[]` (`FieldError`), and the
runner its `error_type`, `error_domain`, `retryable`, `user_action` and `validation_errors[]`.
`HostedProblemMembers` reads those members as the hosted plane sends them today, so that a hosted
answer reads exactly as it did, while the error carries the standard's own reading of the same
answer beside them, as `problem` (see `pipelex_sdk.errors.ApiResponseError`).

Every field is optional and every model is extension-open (`extra="allow"`), for the reason
`TokensUsageRecord` gives: the runner adds fields without asking this SDK, and a field this version
does not name must ride `model_extra` rather than fail the parse of a body whose whole point is to
say what went wrong. The enum-ish fields (`error_domain`, `error_category`, `user_action.kind`) are
open sets on the wire and stay plain `str`, never frozen enums, so a value the runner adds is not an
SDK break; their known values are listed where they are declared.

**A report never fails the read that carries it.** The platform stores the report as the runner
that wrote it sent it and never migrates it, so a row can outlive the runner version it was written
by. Every field of these models is therefore read leniently: a known field whose value does not fit
its type — a validation item with a category this SDK does not know, a `status_code` that is not a
number, a `user_action` that is not an object — reads as `None`, and the rest of the report stands.
`LenientRunErrorReport` extends that to the report as a whole: an `error` that is not an object at
all reads as `None`, so a status read, a run list page or a results read still answers.

**The platform serves the STRICT projection; this SDK strips nothing further.** The run row keeps
the runner's VERBOSE report as the operators' record, and every read that hands it to a caller
serves the rule the hosted runner applies to an error on `execute`: `error_type`, `title`,
`type_uri`, `error_domain`, `error_category`, `retryable` and `validation_errors` pass through;
`message` and `user_action` pass through only when `caller_facing_message` is `True`, which the
served report then keeps, and otherwise `message` is the placeholder `An internal error occurred.`
while `user_action` and the flag are absent; `provider_metadata` keeps only `status_code` and
`retry_after_seconds`; `model`, `provider` and `migration` are absent. The reports the platform
writes itself are caller-facing copy, so they keep their message and their next step. A platform run
locally with `ERROR_DISCLOSURE=verbose` serves the report whole, which is why the models still name
every member the runner writes. Deciding what a person should see is each consumer's presentation;
the report arrives here as served.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any, Self, TypeAlias, TypeVar, cast

from mthds.protocol.problem.answers import decode_json
from mthds.runners.api.problem import REQUEST_ID_HEADER
from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError, ValidatorFunctionWrapHandler, WrapValidator, field_validator

from pipelex_sdk._pydantic_utils import none_when_it_does_not_fit
from pipelex_sdk.validation_models import ValidationErrorItem

if TYPE_CHECKING:
    import httpx


class _LenientReportPart(BaseModel):
    """Base of every model here: extension-open, and a known field that does not fit its type reads as `None`."""

    model_config = ConfigDict(extra="allow")

    @field_validator("*", mode="wrap")
    @classmethod
    def _read_a_field_that_does_not_fit_as_none(cls, value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
        return none_when_it_does_not_fit(value, handler)


class UserAction(_LenientReportPart):
    """The next step a report advises — the runner's `UserAction`.

    `kind` names the category of advice, so a consumer can render consistent guidance; `detail` is
    the free-form, error-specific text (a billing URL, a retry hint, the model to change).
    """

    #: Known values: `wait_and_retry`, `check_billing`, `check_credentials`, `change_input`,
    #: `change_model`, `contact_support`, `unknown`.
    kind: str | None = None
    detail: str | None = None


class ProviderErrorMetadata(_LenientReportPart):
    """What the inference provider's SDK said about a failed call — the runner's `ProviderErrorMetadata`.

    Present on a report whose failure came back from a model provider. `message` is the provider
    SDK's own text, relayed raw. The provider's response body never crosses the wire: the runner
    excludes it from every serialization. A hosted run read keeps only `status_code` and
    `retry_after_seconds`, the client hints; the other members reach a caller only from a server that
    discloses errors VERBOSE, such as a platform run locally with `ERROR_DISCLOSURE=verbose`.
    """

    provider: str | None = None
    sdk_exception_type: str | None = None
    message: str | None = None
    #: The provider's HTTP status, when it answered one.
    status_code: int | None = None
    #: The provider's own request id — what its support desk asks for.
    request_id: str | None = None
    retry_after_seconds: float | None = None
    provider_error_code: str | None = None


class MigrationErrorBlock(_LenientReportPart):
    """A pending configuration migration that explains the failure — the runner's `MigrationErrorBlock`.

    Present only on a configuration failure whose raiser scanned the host's configuration
    directories; a consumer branches on its presence. `plans` is carried opaquely: it is the shape
    `pipelex-agent migrate --dry-run --format json` emits, which no published package declares.
    """

    #: The command that applies whatever can be applied without a decision.
    remedy: str | None = None
    #: Whether running `remedy` would rewrite any file.
    would_write: bool | None = None
    #: Whether something here is a person's to resolve rather than the tool's.
    needs_attention: bool | None = None
    plans: list[dict[str, Any]] | None = None


class RunErrorReport(_LenientReportPart):
    """Why a run failed — the runner's `ErrorReport`, typed with every field it carries.

    The one type for a failed run's report wherever the SDK hands it back: `RunPublic.error` (and so
    `RunRead.error` on the status read), `PipelineRun.error` on the run records, `RunResultFailed.error`
    on the results read's `409`, and `RunFailedError.error` when `wait_for_result`, `start_and_wait`
    or an artifact download raises for a run that ended without a result.

    **Branch on `error_domain`, `type_uri` and `retryable`**, never on the wording of `message`.
    `error_type` is the runner's open-ended exception class name: finer than `error_domain`, useful in
    a support line, but not a closed set to match against.

    The runner writes the report of a run that fails while it runs. A run the platform ends or settles
    itself carries one the platform wrote in the same shape, as caller-facing copy:
    `WorkflowTaskKeptFailingError` for a workflow task that kept failing (the run ends `FAILED`, not
    `TERMINATED`), `RunTimedOutError` for a timeout and `RunWorkflowNotFoundError` for a workflow that
    vanished. A `CANCELLED`, `TERMINATED` or `TIMED_OUT` run holds a report when a completion callback
    carried one, and a `TIMED_OUT` run otherwise holds the platform's timeout report. A report is
    `None` on a completed run and where a run has none — one whose start failed, a blocking `execute`
    run, whose answer carried its reason, one cancelled, terminated or given its status by hand with no
    completion callback carrying a report, one that ended before the platform wrote reports of its own
    — so the absence of a report says nothing about why.

    What the platform serves of a report is the runner's STRICT projection (see the module docstring),
    so the members the projection drops are `None` on a hosted read.
    """

    #: The runner's exception class name (`LLMCompletionError`, `SandboxProvisioningError`, …) — an
    #: open set, for display and support, not for branching.
    error_type: str | None = None
    #: What went wrong. The platform serves the author's copy only when `caller_facing_message` is
    #: `True`, and the placeholder `An internal error occurred.` otherwise.
    message: str | None = None
    #: A stable human label for the error class (`LLM completion`).
    title: str | None = None
    #: The stable URI naming the error class — a branch field, and where its documentation lives.
    type_uri: str | None = None
    #: Where the error comes from, the coarse branch field. Known values: `input` (the caller can fix
    #: it), `config` (a configuration change is needed), `runtime` (a failure during execution).
    error_domain: str | None = None
    #: A finer classification of an inference failure, when the runner has one. Known values:
    #: `transient`, `configuration`, `content`, `capacity`, `ambiguous`, `unknown`.
    error_category: str | None = None
    #: Whether retrying the same run can succeed. `None` means unknown, never "no".
    retryable: bool | None = None
    #: The next step the runner advises. The platform serves it only beside caller-facing copy.
    user_action: UserAction | None = None
    #: The model the failing call used, when the failure is an inference failure. `None` on a hosted
    #: read, whose STRICT projection drops it.
    model: str | None = None
    #: The provider the failing call reached, when the failure is an inference failure. `None` on a
    #: hosted read, whose STRICT projection drops it.
    provider: str | None = None
    #: What the provider's SDK said, when the failure came back from a provider. A hosted read keeps
    #: only its `status_code` and `retry_after_seconds`.
    provider_metadata: ProviderErrorMetadata | None = None
    #: True when `message` was written as caller-facing copy. The runner emits it only when true, and
    #: the platform keeps it on a caller-facing report and leaves it out otherwise, so it is how a
    #: consumer tells the author's copy from the placeholder.
    caller_facing_message: bool | None = None
    #: The structured diagnostics of a bundle that failed validation — the same items the validate
    #: report and a `422`'s `ApiResponseError.validation_errors` carry.
    validation_errors: list[ValidationErrorItem] | None = None
    #: A pending configuration migration that explains the failure. `None` on a hosted read, whose
    #: STRICT projection drops it.
    migration: MigrationErrorBlock | None = None


class FieldError(_LenientReportPart):
    """One field-level failure of a request, an item of the platform problem document's `errors[]`.

    `field` is the dotted path to the offending attribute, `code` a stable sub-code
    (`invalid_format`, `out_of_range`, …), `detail` optional human text.
    """

    field: str | None = None
    code: str | None = None
    detail: str | None = None


#: The type of every `error` field that holds a run's report: `RunPublic.error`, `PipelineRun.error`
#: and `RunResultFailed.error`. A report is read field by field as `RunErrorReport` says, and a value
#: that is not a report at all reads as `None`, so the read carrying it always answers.
LenientRunErrorReport: TypeAlias = Annotated[RunErrorReport | None, WrapValidator(none_when_it_does_not_fit)]


class ProblemUserAction(BaseModel):
    """What a refused request's problem document says the caller should do next — its `user_action` member.

    `kind` is the runner's coarse category of advice. The reference runner emits `wait_and_retry`,
    `check_billing`, `check_credentials`, `change_input`, `change_model`, `contact_support` and
    `unknown`; the vocabulary is the runner's, so it stays an open string. `detail` is the advice
    itself, in words, and is never empty: a `user_action` without it is no next step and reads as
    absent. Members a runner adds beyond these two ride `model_extra`.

    It is the hosted plane's own member, which predates the standard's problem document: there the
    next step is the problem's `next_step`, whose `kind` is a closed list of its own.
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    kind: str
    detail: str


class HostedProblemMembers(BaseModel):
    """The members of a non-2xx hosted answer's problem document, each `None` when the answer did not carry it.

    A body that is not a problem document at all (an HTML gateway page, plain text, an empty body)
    reads as a document with no members, and a member is kept only when it has the type given here,
    a text member only when it is not empty, so a malformed member reads as absent rather than as a
    wrong value.

    - `type_uri`, `title`, `instance`: the RFC 9457 members — the stable URI naming the error class,
      its short human label, and the occurrence (a request path or a request URN).
    - `server_message`: the reason for this occurrence, the problem's `detail` string. Older answers
      nest it as `{"detail": {"error_type": ..., "message": ...}}` or put a top-level `message`; both
      are read too, the top-level `message` standing in when the `detail` gives no reason.
    - `error_type`: the runner's exception class name, from the same places.
    - `request_id`: the body's `request_id`, or the `X-Request-ID` response header when the body
      carries none (a gateway error page, a body that is no problem document).
    - `error_domain`, `retryable`, `user_action`: who can fix the failure, whether a retry can
      succeed (`None` means unknown, which is not `False`), and what to do next.
    - `validation_errors`: the items of a run route's refusal to run an invalid method, kept only when
      every item is a `ValidationErrorItem`, so a list that is present is the runner's whole list.
    - `code`, `error_category`, `errors`: the platform's own closed code, the runner's finer
      classification of an inference failure, and the platform's field-level `errors[]`, kept only
      when every item is an object.
    - `members`: the decoded JSON object whole, `None` when the body was not one.

    The platform's `code` and `errors[]` share their names with the standard's registered `code` and
    its problem items; they are read here as the platform sends them and never through the standard's
    reading, so the two never collide.
    """

    model_config = ConfigDict(frozen=True)

    type_uri: str | None = None
    title: str | None = None
    instance: str | None = None
    server_message: str | None = None
    error_type: str | None = None
    request_id: str | None = None
    error_domain: str | None = None
    retryable: bool | None = None
    user_action: ProblemUserAction | None = None
    validation_errors: list[ValidationErrorItem] | None = None
    code: str | None = None
    error_category: str | None = None
    errors: list[FieldError] | None = None
    members: dict[str, Any] | None = None

    @classmethod
    def make_from_response(cls, response: httpx.Response) -> Self:
        """Read the problem members of a response, with the `X-Request-ID` header as the request id's fallback.

        Args:
            response: The API's non-2xx answer.

        Returns:
            The members the body carries, and the header's request id when the body names none.
        """
        document = cls.make_from_body(response.text)
        if document.request_id is not None:
            return document
        header_request_id = response.headers.get(REQUEST_ID_HEADER, "").strip()
        if not header_request_id:
            return document
        return document.model_copy(update={"request_id": header_request_id})

    @classmethod
    def make_from_body(cls, body: str) -> Self:
        """Read the problem members of a response body, leniently.

        Args:
            body: The response body as text.

        Returns:
            The members the body carries; a body that is not a JSON object carries none.
        """
        root = _decode_object(body)
        if root is None:
            return cls()

        error_type: str | None = None
        server_message: str | None = None
        detail = root.get("detail")
        if isinstance(detail, dict):
            detail_object = cast("dict[str, Any]", detail)
            error_type = _non_empty_string_member(detail_object, "error_type")
            server_message = _non_empty_string_member(detail_object, "message")
        elif isinstance(detail, str) and detail:
            server_message = detail
        if error_type is None:
            error_type = _non_empty_string_member(root, "error_type")
        if server_message is None:
            server_message = _non_empty_string_member(root, "message")

        raw_retryable = root.get("retryable")
        return cls(
            type_uri=_non_empty_string_member(root, "type"),
            title=_non_empty_string_member(root, "title"),
            instance=_non_empty_string_member(root, "instance"),
            server_message=server_message,
            error_type=error_type,
            request_id=_non_empty_string_member(root, "request_id"),
            error_domain=_non_empty_string_member(root, "error_domain"),
            retryable=raw_retryable if isinstance(raw_retryable, bool) else None,
            user_action=_user_action_of(root.get("user_action")),
            validation_errors=_validated_list(_VALIDATION_ERRORS_ADAPTER, root.get("validation_errors")),
            code=_non_empty_string_member(root, "code"),
            error_category=_non_empty_string_member(root, "error_category"),
            errors=_validated_list(_FIELD_ERRORS_ADAPTER, root.get("errors")),
            members=root,
        )


# Built once at import: the parse paths of a problem's `validation_errors[]` and the platform's `errors[]`.
# A `ValidationErrorItem` is a closed shape, so the list is kept whole or not at all; a `FieldError` reads
# each field leniently, so only a non-object item sets `errors` to `None`.
_VALIDATION_ERRORS_ADAPTER: TypeAdapter[list[ValidationErrorItem]] = TypeAdapter(list[ValidationErrorItem])
_FIELD_ERRORS_ADAPTER: TypeAdapter[list[FieldError]] = TypeAdapter(list[FieldError])


def _decode_object(body: str) -> dict[str, Any] | None:
    """Decode a body into its JSON object, or `None` for an empty, non-JSON or non-object body.

    The body is decoded by the base's guarded decoder (`mthds.protocol.problem.answers.decode_json`),
    which reads the same answer's `problem` too, its numbers kept as written: a body nested deeper than
    the protocol's limit, or holding `NaN`, `Infinity` or a number past the range of a double, is no JSON
    and carries no member, where `json.loads` would accept the constants and raise `RecursionError` on
    the nesting. `@pipelex/sdk` reads a refusal's body by the same rules.
    """
    decoded = decode_json(body, numbers_as_written=True)
    value: object = decoded.value
    if not decoded.is_json or not isinstance(value, dict):
        return None
    return cast("dict[str, Any]", value)


def _non_empty_string_member(members: dict[str, Any], key: str) -> str | None:
    """A non-empty string member, or `None` when it is absent, empty or not a string."""
    value = members.get(key)
    return value if isinstance(value, str) and value else None


def _user_action_of(value: Any) -> ProblemUserAction | None:
    """A `user_action` member, kept only whole: an object with a string `kind` and a non-empty string `detail`."""
    if not isinstance(value, dict):
        return None
    action = cast("dict[str, Any]", value)
    kind = action.get("kind")
    detail = action.get("detail")
    if not isinstance(kind, str) or not isinstance(detail, str) or not detail:
        return None
    return ProblemUserAction.model_validate(action)


_ItemT = TypeVar("_ItemT")


def _validated_list(adapter: TypeAdapter[list[_ItemT]], value: Any) -> list[_ItemT] | None:
    """A list member validated whole by `adapter`, or `None` when it is absent, not a list, or an item does not fit."""
    if not isinstance(value, list):
        return None
    try:
        return adapter.validate_python(value)
    except ValidationError:
        return None
