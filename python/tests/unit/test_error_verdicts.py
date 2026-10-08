"""The verdict every error carries — `retryable` and `error_domain` — driven through the case file
`tests/fixtures/error-verdicts.json`.

The file's source is `js/tests/fixtures/error-verdicts.json`, which `@pipelex/sdk`'s suite drives too;
this copy is written by `make shared-files` at the repository root and never edited here, and
`make check-shared-files` fails when the two differ, so both SDKs are held to the same verdict for every
case. Here:

- every `fallback` case drives `fallback_verdict` directly, and an `ApiResponseError` built with nothing
  but that status, code and naming;
- every `server_sent` case is answered to a real client call, so the body goes through the client's own
  parsing;
- every class in `classes` is built from each variant's `given` by a builder below; a class the file
  lists for this SDK with no builder fails the suite, and so does a field the suite does not know, so a
  case added to the file reaches this language;
- the completeness test walks `pipelex_sdk.errors`, failing on an error class it defines that the file
  does not list, or whose instance `error_verdict_of` cannot read;
- and the rest pins where the verdicts are decided: `error_verdict_of` on what is not an SDK error, the
  arguments the client refuses before sending, the upload's mapping, the protocol's 202 degrade, and a
  verdict surviving the rebuild pickling performs.
"""

from __future__ import annotations

import asyncio
import copy
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, TypeAlias, cast

import httpx
import pytest
from mthds.protocol.exceptions import PipelineRequestError
from mthds.runners.api.exceptions import ApiResponseError as MthdsApiResponseError
from mthds.runners.api.exceptions import RunStillRunningError as MthdsRunStillRunningError
from pydantic import BaseModel, ConfigDict, Field

from pipelex_sdk import errors as errors_module
from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.error_models import RunErrorReport
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of, fallback_verdict
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    ArtifactAuthenticationError,
    ArtifactFetchError,
    ArtifactOperationError,
    CodegenError,
    CodegenLockError,
    FieldNotIncludedError,
    InputPreparationError,
    InvalidInputValueError,
    InvalidLocalSourceError,
    MethodLoadError,
    MissingMainStuffError,
    PagingNotTerminatingError,
    PipelexRequestError,
    PipelineExecuteTimeoutError,
    RejectedAssetCode,
    RejectedAssetError,
    RequestArgumentError,
    RunFailedError,
    RunLifecycleUnavailableError,
    RunStillRunningError,
    RunTimeoutError,
    ScopeUnavailableError,
    UnsupportedUploadCapabilityError,
    UploadAuthenticationError,
    UploadTransportCode,
    UploadTransportError,
)
from pipelex_sdk.runs import RunStatus

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from tests.unit.conftest import SendPatcher, UnreachableClientBuilder

# ── The case file ─────────────────────────────────────────────────────

#: A body as the case file spells it: an object sent as JSON, a string sent as raw text, `None` sent empty.
_Body: TypeAlias = dict[str, Any] | str | None


class _CaseModel(BaseModel):
    """A part of the case file. A field this suite does not know fails the load, so a case written for
    the other language with a new field reaches this one instead of being skipped.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)


class _Language(StrEnum):
    JS = "js"
    PYTHON = "python"


class _FallbackCase(_CaseModel):
    case: str
    status: int
    code: str | None
    named: bool
    expected: ErrorVerdict


class _ServerSentCase(_CaseModel):
    case: str
    status: int
    body: _Body
    expected: ErrorVerdict


class _Cause(_CaseModel):
    """A wrapped error: an SDK class built from its own members, or `Error`, the language's own base
    error, which carries no verdict.
    """

    class_name: Literal["ApiResponseError", "ApiUnreachableError", "Error"] = Field(alias="class")
    status: int | None = None
    body: _Body = None
    code: str | None = None


class _Given(_CaseModel):
    code: str | None = None
    status: int | None = None
    body: _Body = None
    report: dict[str, Any] | None = None
    cause: _Cause | None = None
    verdict: ErrorVerdict | None = None


class _Variant(_CaseModel):
    variant: str
    only_in: _Language | None = None
    given: _Given
    expected: ErrorVerdict


class _ClassEntry(_CaseModel):
    class_name: str = Field(alias="class")
    only_in: _Language | None = None
    abstract: bool = False
    variants: list[_Variant]


class _CaseFile(_CaseModel):
    about: str
    fallback: list[_FallbackCase]
    server_sent: list[_ServerSentCase]
    classes: list[_ClassEntry]


_CASE_FILE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "error-verdicts.json"
_CASES = _CaseFile.model_validate_json(_CASE_FILE_PATH.read_bytes())


def _is_ours(only_in: _Language | None) -> bool:
    """Whether an entry of the file is this SDK's to drive."""
    match only_in:
        case None | _Language.PYTHON:
            return True
        case _Language.JS:
            return False


_OUR_CLASSES = [entry for entry in _CASES.classes if _is_ours(entry.only_in)]


def _variant_params() -> list[Any]:
    """Every variant this SDK drives, as `(class name, variant)`."""
    params: list[Any] = []
    for entry in _OUR_CLASSES:
        for variant in entry.variants:
            if _is_ours(variant.only_in):
                params.append(pytest.param(entry.class_name, variant, id=f"{entry.class_name}: {variant.variant}"))
    return params


def _module_error_classes() -> list[str]:
    """The name of every public error class `pipelex_sdk.errors` defines, leaving out what it imports."""
    names: list[str] = []
    for name, value in vars(errors_module).items():
        if name.startswith("_") or not isinstance(value, type):
            continue
        if issubclass(value, BaseException) and value.__module__ == errors_module.__name__:
            names.append(name)
    return sorted(names)


# ── Building each class from a variant's `given` ──────────────────────

_BASE_URL = "http://localhost:8081"
_RUN_ID = "run-1"
_INPUT = ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)
_CONFIG = ErrorVerdict(error_domain=ErrorDomain.CONFIG, retryable=False)


def _answer(status: int, body: _Body) -> httpx.Response:
    """The API's answer carrying `body` as the case file says it is sent."""
    request = httpx.Request("GET", f"{_BASE_URL}/v1/x")
    if body is None:
        return httpx.Response(status, request=request)
    if isinstance(body, str):
        return httpx.Response(status, text=body, request=request)
    return httpx.Response(status, json=body, headers={"content-type": "application/problem+json"}, request=request)


def _refused_with(status: int, body: _Body) -> ApiResponseError:
    """The `ApiResponseError` the client builds for an answer of `status` carrying `body`."""
    client = PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)
    return client._api_response_error(method="GET", path="/v1/x", request_url=f"{_BASE_URL}/v1/x", response=_answer(status, body))


def _status_of(given: _Given) -> int:
    if given.status is None:
        msg = "this variant names no status, and its class needs one"
        raise AssertionError(msg)
    return given.status


def _code_of(given: _Given) -> str:
    if given.code is None:
        msg = "this variant names no code, and its class needs one"
        raise AssertionError(msg)
    return given.code


def _cause_from(spec: _Cause | None) -> BaseException | None:
    if spec is None:
        return None
    match spec.class_name:
        case "ApiResponseError":
            if spec.status is None:
                msg = "a wrapped ApiResponseError needs a status"
                raise AssertionError(msg)
            return _refused_with(spec.status, spec.body)
        case "ApiUnreachableError":
            return ApiUnreachableError("Could not reach the API.", _BASE_URL, code=spec.code)
        case "Error":
            return Exception("A failure carrying no verdict.")


def _run_failed(given: _Given) -> RunFailedError:
    report = None if given.report is None else RunErrorReport.model_validate(given.report)
    return RunFailedError("Run finished with status FAILED.", _RUN_ID, RunStatus.FAILED, report)


def _rejected_asset(given: _Given) -> RejectedAssetError:
    code = None if given.code is None else RejectedAssetCode(given.code)
    return RejectedAssetError("Refused.", "a.pdf", 413 if given.status is None else given.status, code=code)


def _upload_transport(given: _Given) -> UploadTransportError:
    code = None if given.code is None else UploadTransportCode(given.code)
    return UploadTransportError("The upload failed.", status=given.status, code=code, cause=_cause_from(given.cause))


def _artifact_authentication(given: _Given) -> ArtifactAuthenticationError:
    result = DownloadArtifactsResult(scope=ArtifactScope.MAIN_STUFF, all_saved=True)
    return ArtifactAuthenticationError("Credential refused.", 401 if given.status is None else given.status, result)


#: One builder per class the file lists for this SDK, keyed by the class's name. A class the file lists
#: with no builder here fails the suite.
_BUILDERS: dict[str, Callable[[_Given], BaseException]] = {
    "ApiResponseError": lambda given: _refused_with(_status_of(given), given.body),
    "ApiUnreachableError": lambda given: ApiUnreachableError("Could not reach the API.", _BASE_URL, code=given.code),
    "PipelineExecuteTimeoutError": lambda _: PipelineExecuteTimeoutError("Cut off by the gateway.", 31.0),
    "RunFailedError": _run_failed,
    "RunTimeoutError": lambda _: RunTimeoutError("Stopped waiting.", _RUN_ID, 1.0),
    "RunStillRunningError": lambda _: RunStillRunningError("Still running.", _RUN_ID),
    "RunLifecycleUnavailableError": lambda _: RunLifecycleUnavailableError("No run lifecycle here.", _BASE_URL),
    "MissingMainStuffError": lambda _: MissingMainStuffError("No main stuff.", _RUN_ID),
    "PagingNotTerminatingError": lambda _: PagingNotTerminatingError("Paging forever.", 10_000),
    "RequestArgumentError": lambda given: RequestArgumentError("Refused before sending.", verdict=given.verdict),
    "InputPreparationError": lambda given: InputPreparationError("Cannot prepare inputs.", verdict=given.verdict),
    "InvalidLocalSourceError": lambda _: InvalidLocalSourceError("No such file.", "/nope.pdf"),
    "InvalidInputValueError": lambda _: InvalidInputValueError("Malformed data URL."),
    "MethodLoadError": lambda _: MethodLoadError("The method does not load.", validation_errors=[]),
    "RejectedAssetError": _rejected_asset,
    "UnsupportedUploadCapabilityError": lambda _: UnsupportedUploadCapabilityError("No upload here."),
    "UploadAuthenticationError": lambda given: UploadAuthenticationError("Not authorized.", 401 if given.status is None else given.status),
    "UploadTransportError": _upload_transport,
    "ArtifactOperationError": lambda given: ArtifactOperationError("The artifact operation failed.", verdict=given.verdict),
    "ScopeUnavailableError": lambda _: ScopeUnavailableError(ArtifactScope.MAIN_STUFF, _RUN_ID),
    "ArtifactAuthenticationError": _artifact_authentication,
    "ArtifactFetchError": lambda given: ArtifactFetchError(
        "The fetch failed.", "pipelex-storage://org/runs/r/outputs/a.png", _code_of(given), given.status
    ),
    "CodegenError": lambda _: CodegenError("Refused codegen tree."),
    "CodegenLockError": lambda _: CodegenLockError("Malformed codegen lock."),
    "FieldNotIncludedError": lambda given: FieldNotIncludedError("working_memory", verdict=given.verdict),
}


def _build(class_name: str, given: _Given) -> BaseException:
    builder = _BUILDERS.get(class_name)
    if builder is None:
        pytest.fail(f"no builder for {class_name}: add one to _BUILDERS")
    return builder(given)


def _exported_class(name: str) -> type[BaseException]:
    """The error class a file entry names, looked up on `pipelex_sdk.errors`."""
    value = vars(errors_module).get(name)
    assert isinstance(value, type), f"pipelex_sdk.errors exports {name}"
    assert issubclass(value, BaseException), f"{name} is an exception class"
    return value


# ── The call sites ────────────────────────────────────────────────────

_RefusedCall: TypeAlias = "Callable[[PipelexAPIClient], Coroutine[Any, Any, object]]"

#: Every argument the client refuses before sending a request, as a call that makes the refusal.
_REFUSALS: list[tuple[str, _RefusedCall]] = [
    ("execute with nothing to run", lambda client: client.execute()),
    ("execute with a protocol arg in extra", lambda client: client.execute(pipe_code="summarize", extra={"inputs": {}})),
    ("execute with a reserved arg in extra", lambda client: client.execute(pipe_code="summarize", extra={"method_id": "mt_1"})),
    (
        "execute with method_ref beside inline contents",
        lambda client: client.execute(mthds_contents=["domain = 'demo'"], method_ref="github.com/Pipelex/methods@v0.1.0"),
    ),
    (
        "execute with method_ref beside method_id",
        lambda client: client.execute(method_ref="github.com/Pipelex/methods@v0.1.0", method_id="mt_1"),
    ),
    ("execute with a selector that is not a string", lambda client: client.execute(pipe_code="summarize", method_id=cast("str", 123))),
    ("start with nothing to run", lambda client: client.start()),
    ("start with a protocol arg in extra", lambda client: client.start(pipe_code="summarize", extra={"pipe_code": "other"})),
    ("validate with no selector", lambda client: client.validate()),
    ("validate with two selectors", lambda client: client.validate(mthds_contents=["domain = 'demo'"], method_id="mt_1")),
    ("validate_files with no file", lambda client: client.validate_files([])),
    ("get_run_result with an empty selection", lambda client: client.get_run_result(_RUN_ID, artifacts=[])),
    ("wait_for_result with an empty selection", lambda client: client.wait_for_result(_RUN_ID, artifacts=[])),
]


class _ForeignVerdictError(Exception):
    """An exception of no SDK class that carries the two members as it is given them."""

    def __init__(self, *, retryable: object, error_domain: object) -> None:
        super().__init__("A foreign error.")
        self.retryable = retryable
        self.error_domain = error_domain


class _Shaped:
    """Something that is not an exception, shaped like a verdict."""

    retryable = True
    error_domain = "runtime"


class _QueueFullError(PipelexRequestError):
    """A consumer's own subclass, declaring its verdict."""

    def __init__(self) -> None:
        super().__init__("The local queue is full.", verdict=ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True))


class TestErrorVerdicts:
    # ── The file itself ──

    def test_the_case_file_says_what_it_is_and_that_its_copy_stays_identical(self) -> None:
        assert "byte for byte identical" in _CASES.about
        assert _CASES.fallback
        assert _CASES.server_sent
        assert _CASES.classes

    def test_has_a_builder_for_exactly_the_classes_it_lists_for_this_sdk(self) -> None:
        listed = sorted(entry.class_name for entry in _OUR_CLASSES if not entry.abstract)
        assert sorted(_BUILDERS) == listed

    # ── The fallback table ──

    @pytest.mark.parametrize("case", [pytest.param(case, id=case.case) for case in _CASES.fallback])
    def test_the_fallback_table(self, case: _FallbackCase) -> None:
        assert fallback_verdict(status=case.status, code=case.code, named=case.named) == case.expected

        # An ApiResponseError carrying no server member takes the same pair. A named case with no
        # platform code is named by a runner's `error_type`.
        error_type = "PipeNotFoundError" if case.named and case.code is None else None
        err = ApiResponseError(
            f"HTTP {case.status}",
            api_url=_BASE_URL,
            status=case.status,
            status_text="",
            response_body="",
            error_type=error_type,
            code=case.code,
        )
        assert error_verdict_of(err) == case.expected

    # ── A verdict the server sent ──

    @pytest.mark.parametrize("case", [pytest.param(case, id=case.case) for case in _CASES.server_sent])
    def test_a_verdict_the_server_sent(self, case: _ServerSentCase, api_client: PipelexAPIClient, patch_send: SendPatcher) -> None:
        spy = patch_send(api_client, _answer(case.status, case.body))

        with pytest.raises(ApiResponseError) as caught:
            asyncio.run(api_client.get_subscription())

        assert spy.await_count == 1
        assert error_verdict_of(caught.value) == case.expected
        assert (caught.value.error_domain, caught.value.retryable) == (case.expected.error_domain, case.expected.retryable)
        # What the server sent stays readable, whatever the verdict became.
        if isinstance(case.body, dict):
            assert caught.value.problem == case.body

    # ── Each exported class's verdict ──

    def test_the_abstract_base_is_the_base_of_every_request_error(self) -> None:
        assert [entry.class_name for entry in _OUR_CLASSES if entry.abstract] == ["PipelexRequestError"]
        assert _exported_class("PipelexRequestError") is PipelexRequestError
        assert issubclass(PipelexRequestError, PipelineRequestError)
        for entry in _OUR_CLASSES:
            if entry.abstract:
                continue
            exported = _exported_class(entry.class_name)
            if issubclass(exported, CodegenError):
                # A codegen tree error is raised over bytes and a directory, never over a request.
                assert not issubclass(exported, PipelineRequestError), entry.class_name
                continue
            assert issubclass(exported, PipelexRequestError), entry.class_name

    @pytest.mark.parametrize(("class_name", "variant"), _variant_params())
    def test_each_exported_class_verdict(self, class_name: str, variant: _Variant) -> None:
        err = _build(class_name, variant.given)

        assert isinstance(err, _exported_class(class_name))
        assert type(err).__name__ == class_name
        assert error_verdict_of(err) == variant.expected
        # The verdict is the instance's own pair, the domain one of the enum's members.
        own = vars(err)
        assert (own["error_domain"], own["retryable"]) == (variant.expected.error_domain, variant.expected.retryable)
        assert isinstance(own["error_domain"], ErrorDomain)

    @pytest.mark.parametrize(("class_name", "variant"), _variant_params())
    def test_a_verdict_survives_the_rebuild_pickling_performs(self, class_name: str, variant: _Variant) -> None:
        # A copy rebuilds the error through its `__reduce__`, as pickling does across a process boundary.
        err = _build(class_name, variant.given)

        rebuilt = copy.deepcopy(err)

        assert type(rebuilt) is type(err)
        assert str(rebuilt) == str(err)
        assert error_verdict_of(rebuilt) == variant.expected

    # ── Completeness ──

    def test_finds_the_sdk_error_classes_in_the_errors_module(self) -> None:
        names = _module_error_classes()
        assert "ApiResponseError" in names
        assert "CodegenLockError" in names
        # The standard's own classes are imported, not defined, here.
        assert "PipelineRequestError" not in names

    @pytest.mark.parametrize("class_name", _module_error_classes())
    def test_every_error_class_is_in_the_case_file(self, class_name: str) -> None:
        entry = next((entry for entry in _OUR_CLASSES if entry.class_name == class_name), None)
        assert entry is not None, f"{class_name} is defined in pipelex_sdk.errors but missing from the case file"
        if entry.abstract:
            return
        variant = next((variant for variant in entry.variants if _is_ours(variant.only_in)), None)
        assert variant is not None, f"{class_name} has no variant for this SDK in the case file"
        assert error_verdict_of(_build(class_name, variant.given)) is not None, f"error_verdict_of cannot read a {class_name}"

    # ── error_verdict_of ──

    def test_error_verdict_of_returns_none_for_what_carries_no_verdict(self) -> None:
        assert error_verdict_of(ValueError("timeout_seconds must be positive")) is None
        assert error_verdict_of(Exception("plain")) is None
        assert error_verdict_of(None) is None
        assert error_verdict_of("boom") is None
        # Not an exception, however it is shaped.
        assert error_verdict_of(_Shaped()) is None

    @pytest.mark.parametrize(
        ("retryable", "error_domain"),
        [
            pytest.param(True, None, id="no domain"),
            pytest.param(None, "runtime", id="no retryable"),
            pytest.param("yes", "runtime", id="a retryable that is not a boolean"),
            pytest.param(1, "runtime", id="a retryable that is a number"),
            pytest.param(True, "network", id="an unknown domain"),
            pytest.param(True, "", id="an empty domain"),
            pytest.param(True, 3, id="a domain that is not a string"),
        ],
    )
    def test_error_verdict_of_returns_none_for_missing_mistyped_or_unknown_members(self, retryable: object, error_domain: object) -> None:
        assert error_verdict_of(_ForeignVerdictError(retryable=retryable, error_domain=error_domain)) is None

    def test_error_verdict_of_reads_an_error_of_no_sdk_class_carrying_both_members(self) -> None:
        verdict = error_verdict_of(_ForeignVerdictError(retryable=True, error_domain="config"))
        assert verdict == ErrorVerdict(error_domain=ErrorDomain.CONFIG, retryable=True)

    def test_error_verdict_of_reads_a_consumer_subclass_declaring_its_verdict(self) -> None:
        assert error_verdict_of(_QueueFullError()) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)

    def test_error_verdict_of_reads_an_mthds_api_response_error_only_when_both_members_were_sent(self) -> None:
        both = MthdsApiResponseError(
            "refused", api_url=_BASE_URL, status=500, status_text="", response_body="", error_domain="config", retryable=False
        )
        domain_only = MthdsApiResponseError("refused", api_url=_BASE_URL, status=500, status_text="", response_body="", error_domain="config")

        assert error_verdict_of(both) == _CONFIG
        assert error_verdict_of(domain_only) is None

    # ── Arguments refused before sending ──

    @pytest.mark.parametrize(("label", "call"), _REFUSALS, ids=[label for label, _ in _REFUSALS])
    def test_an_argument_the_client_refuses_is_input_and_sends_nothing(
        self, label: str, call: _RefusedCall, api_client: PipelexAPIClient, patch_send: SendPatcher
    ) -> None:
        spy = patch_send(api_client)

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(call(api_client))

        assert error_verdict_of(caught.value) == _INPUT, label
        # Still the standard's base, so a handler written against the standard's client catches it.
        assert isinstance(caught.value, PipelineRequestError)
        spy.assert_not_awaited()

    def test_a_refusal_the_standard_client_raises_keeps_it_as_the_cause(self, api_client: PipelexAPIClient, patch_send: SendPatcher) -> None:
        spy = patch_send(api_client)

        with pytest.raises(RequestArgumentError) as caught:
            asyncio.run(api_client.start())

        cause = caught.value.__cause__
        assert isinstance(cause, PipelineRequestError)
        assert not isinstance(cause, PipelexRequestError)
        assert str(caught.value) == str(cause)
        spy.assert_not_awaited()

    def test_a_base_url_that_is_not_host_only_is_config(self) -> None:
        with pytest.raises(RequestArgumentError) as caught:
            PipelexAPIClient(api_key="test-token", base_url=f"{_BASE_URL}/v1")

        assert error_verdict_of(caught.value) == _CONFIG

    # ── The protocol's 202 degrade ──

    def test_an_execute_degraded_to_a_start_raises_this_sdk_s_run_still_running_error(
        self, api_client: PipelexAPIClient, patch_send: SendPatcher
    ) -> None:
        location = f"{_BASE_URL}/v1/runs/run-202"
        answer = httpx.Response(
            202,
            json={"pipeline_run_id": "run-202"},
            headers={"location": location, "retry-after": "5"},
            request=httpx.Request("POST", f"{_BASE_URL}/v1/execute"),
        )
        patch_send(api_client, answer)

        with pytest.raises(RunStillRunningError) as caught:
            asyncio.run(api_client.execute(pipe_code="summarize"))

        err = caught.value
        assert isinstance(err, MthdsRunStillRunningError)
        assert (err.run_id, err.retry_after_seconds, err.location) == ("run-202", 5, location)
        assert error_verdict_of(err) == ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)
        # The standard's own error, which carries no verdict, is kept as the cause.
        assert isinstance(err.__cause__, MthdsRunStillRunningError)
        assert not isinstance(err.__cause__, RunStillRunningError)

    # ── The upload's mapping ──

    @pytest.mark.parametrize(
        ("status", "body", "error_class", "code", "expected"),
        [
            pytest.param(
                402,
                {"detail": "Insufficient credits."},
                UploadTransportError,
                UploadTransportCode.UNEXPECTED,
                _CONFIG,
                id="a plan refusal takes the wrapped refusal's verdict",
            ),
            pytest.param(
                503,
                None,
                UploadTransportError,
                UploadTransportCode.SERVER_ERROR,
                ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True),
                id="a service fault",
            ),
            pytest.param(413, {"detail": "Too large."}, RejectedAssetError, RejectedAssetCode.TOO_LARGE, _INPUT, id="an asset past the size cap"),
            pytest.param(401, {"detail": "Invalid API key."}, UploadAuthenticationError, None, _CONFIG, id="a refused credential"),
            pytest.param(404, {"detail": "Not Found"}, UnsupportedUploadCapabilityError, None, _CONFIG, id="a deployment without upload"),
        ],
    )
    def test_upload_file_maps_a_refusal_to_an_error_carrying_its_verdict(
        self,
        status: int,
        body: _Body,
        error_class: type[InputPreparationError],
        code: StrEnum | None,
        expected: ErrorVerdict,
        api_client: PipelexAPIClient,
        patch_send: SendPatcher,
    ) -> None:
        patch_send(api_client, _answer(status, body))

        with pytest.raises(InputPreparationError) as caught:
            asyncio.run(api_client.upload_file(b"\x01\x02", filename="a.pdf"))

        assert type(caught.value) is error_class
        assert getattr(caught.value, "code", None) == code
        assert error_verdict_of(caught.value) == expected
        assert isinstance(caught.value.__cause__, ApiResponseError)

    @pytest.mark.parametrize(
        ("failure", "code", "expected"),
        [
            pytest.param(
                httpx.ConnectError,
                UploadTransportCode.UNREACHABLE,
                ErrorVerdict(error_domain=ErrorDomain.CONFIG, retryable=True),
                id="no response reached the SDK",
            ),
            pytest.param(
                httpx.ReadTimeout,
                UploadTransportCode.TIMEOUT,
                ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True),
                id="the SDK's own time limit ran out",
            ),
        ],
    )
    def test_upload_file_maps_an_unreachable_api_to_a_coded_transport_error(
        self,
        failure: type[httpx.TransportError],
        code: UploadTransportCode,
        expected: ErrorVerdict,
        unreachable_client: UnreachableClientBuilder,
    ) -> None:
        client = unreachable_client(failure)

        with pytest.raises(UploadTransportError) as caught:
            asyncio.run(client.upload_file(b"\x01\x02", filename="a.pdf"))

        assert caught.value.code == code
        assert error_verdict_of(caught.value) == expected
        assert isinstance(caught.value.__cause__, ApiUnreachableError)
