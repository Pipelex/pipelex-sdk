"""The problems this SDK reads and builds, pinned by the case file both SDKs share, `fixtures/sdk-problems.json`:
the reading of an answer that is not the route's result, the readings of a storage status and of each transfer
failure's reason, and the problem each error class carries when its raise site states none. `@pipelex/sdk` runs the
same file (`js/tests/sdk-problems.test.ts`).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
import pytest

from pipelex_sdk.answer_reading import read_hosted_answer
from pipelex_sdk.artifact_models import ArtifactScope
from pipelex_sdk.errors import (
    ABORT_TIMEOUT_CODE,
    ApiUnreachableError,
    ArtifactFetchError,
    ArtifactOperationError,
    InputPreparationError,
    InvalidInputValueError,
    InvalidLocalSourceError,
    MethodFileTransferReason,
    MethodLoadError,
    MissingMainStuffError,
    PagingNotTerminatingError,
    PipelineExecuteTimeoutError,
    RequestArgumentError,
    RunLifecycleUnavailableError,
    RunStillRunningError,
    RunTimeoutError,
    ScopeUnavailableError,
    UnsupportedUploadCapabilityError,
    UploadAuthenticationError,
    UploadNotAllowedError,
    UploadNotAllowedKind,
    UploadTransportReason,
    artifact_fetch_problem,
    method_file_transfer_problem,
    nested_run_error,
    storage_status_problem,
    upload_transport_problem,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from mthds.protocol.exceptions import PipelineRequestError
    from mthds.protocol.problem.models import Problem

_CASES: dict[str, Any] = json.loads((Path(__file__).parent.parent / "fixtures" / "sdk-problems.json").read_text(encoding="utf-8"))

_API_URL = "https://api.example.com"

#: Each class of the case file, built from the arguments it takes.
_BUILDERS: dict[str, Callable[[], PipelineRequestError]] = {
    "RequestArgumentError": lambda: RequestArgumentError("refused"),
    "InputPreparationError": lambda: InputPreparationError("refused"),
    "InvalidLocalSourceError": lambda: InvalidLocalSourceError("unreadable", source="receipt.pdf"),
    "InvalidInputValueError": lambda: InvalidInputValueError("not a file", input_name="receipt", input_path="receipt"),
    "UploadNotAllowedError": lambda: UploadNotAllowedError(input_name="receipt", input_path="receipt", value_kind=UploadNotAllowedKind.LOCAL_PATH),
    "MethodLoadError": lambda: MethodLoadError("does not load", errors=[]),
    "UnsupportedUploadCapabilityError": lambda: UnsupportedUploadCapabilityError("no upload"),
    "UploadAuthenticationError": lambda: UploadAuthenticationError("refused", status=401),
    "PipelineExecuteTimeoutError": lambda: PipelineExecuteTimeoutError("cut off", elapsed_seconds=31.0),
    "MissingMainStuffError": lambda: MissingMainStuffError("no main stuff", run_id="run-1"),
    "RunTimeoutError": lambda: RunTimeoutError("timed out", run_id="run-1", timeout_seconds=1.0),
    "RunStillRunningError": lambda: RunStillRunningError("still running", run_id="run-1"),
    "RunLifecycleUnavailableError": lambda: RunLifecycleUnavailableError("no lifecycle", api_url=_API_URL),
    "PagingNotTerminatingError": lambda: PagingNotTerminatingError("never ends", page_limit=1000),
    "ArtifactOperationError": lambda: ArtifactOperationError("failed"),
    "ScopeUnavailableError": lambda: ScopeUnavailableError(ArtifactScope.MAIN_STUFF, run_id="run-1"),
    # A connection reset once the request had left.
    "ApiUnreachableError/unreachable": lambda: ApiUnreachableError(
        "no answer", api_url=_API_URL, network_code="ReadError", failure=httpx.ReadError("reset")
    ),
    "ApiUnreachableError/timeout": lambda: ApiUnreachableError(
        "timed out", api_url=_API_URL, network_code=ABORT_TIMEOUT_CODE, failure=httpx.ReadTimeout("timed out"), timeout_seconds=20.0
    ),
    "ApiUnreachableError/start-may-have-left": lambda: ApiUnreachableError(
        "no answer", api_url=_API_URL, network_code="ReadError", may_start_run=True, failure=httpx.ReadError("reset")
    ),
    # A refused connection proves nothing was sent.
    "ApiUnreachableError/start-nothing-sent": lambda: ApiUnreachableError(
        "refused", api_url=_API_URL, network_code="ConnectError", may_start_run=True, failure=httpx.ConnectError("refused")
    ),
}


def _body_text(answer: dict[str, Any]) -> str:
    """The case's answer body, as the text it came as."""
    text: str | None = answer.get("text")
    return text if text is not None else json.dumps(answer.get("body"))


def _params(problem: Problem) -> dict[str, Any]:
    """A problem's parameters as the wire carries them."""
    return problem.params.as_wire() if problem.params is not None else {}


class TestSdkProblems:
    @pytest.mark.parametrize("answer", _CASES["answers"], ids=[answer["name"] for answer in _CASES["answers"]])
    def test_reads_each_answer_as_its_problem(self, answer: dict[str, Any]) -> None:
        reading = read_hosted_answer(status=answer["status"], headers=answer["headers"], body=_body_text(answer), creates_run=answer["creates_run"])
        problem = reading.problem
        expect: dict[str, Any] = answer["expect"]

        assert problem.code == expect["code"]
        assert reading.from_body is expect["from_body"]
        assert problem.retry == expect["retry"]
        if "status" in expect:
            assert problem.status == expect["status"]
        assert problem.retry_after == expect.get("retry_after")
        assert problem.pipeline_run_id == expect.get("pipeline_run_id")
        if "request_id" in expect:
            assert (problem.model_extra or {}).get("request_id") == expect["request_id"]
        if "run_error_code" in expect:
            nested = nested_run_error(problem)
            assert nested is not None
            assert nested.code == expect["run_error_code"]

    @pytest.mark.parametrize(("status", "code"), [(entry["status"], entry["code"]) for entry in _CASES["storage_statuses"]])
    def test_reads_a_storage_status_as_its_problem(self, status: int, code: str) -> None:
        assert storage_status_problem(status).code == code

    @pytest.mark.parametrize(
        ("reason", "status", "code"), [(entry["reason"], entry["status"], entry["code"]) for entry in _CASES["upload_transport"]]
    )
    def test_gives_an_upload_transport_failure_its_problem(self, reason: str | None, status: int | None, code: str) -> None:
        assert upload_transport_problem(reason=UploadTransportReason(reason) if reason is not None else None, status=status).code == code

    @pytest.mark.parametrize(("reason", "status", "code"), [(entry["reason"], entry["status"], entry["code"]) for entry in _CASES["artifact_fetch"]])
    def test_gives_an_artifact_fetch_failure_its_problem(self, reason: str, status: int | None, code: str) -> None:
        uri = "pipelex-storage://org/file.pdf"
        assert artifact_fetch_problem(reason=reason, uri=uri, status=status).code == code
        assert ArtifactFetchError("failed", uri=uri, reason=reason, status=status).problem.code == code

    @pytest.mark.parametrize(
        ("reason", "status", "code"), [(entry["reason"], entry["status"], entry["code"]) for entry in _CASES["method_file_transfer"]]
    )
    def test_gives_a_method_file_transfer_failure_its_problem(self, reason: str, status: int | None, code: str) -> None:
        assert method_file_transfer_problem(reason=MethodFileTransferReason(reason), status=status).code == code

    def test_names_a_builder_for_every_class_of_the_case_file_and_a_case_for_every_builder(self) -> None:
        assert sorted(_BUILDERS) == sorted(entry["class"] for entry in _CASES["classes"])

    @pytest.mark.parametrize("entry", _CASES["classes"], ids=[entry["class"] for entry in _CASES["classes"]])
    def test_gives_each_class_its_problem(self, entry: dict[str, Any]) -> None:
        error = _BUILDERS[entry["class"]]()

        assert error.problem.code == entry["code"]
        if "retry" in entry:
            assert error.problem.retry == entry["retry"]
        if "params" in entry:
            assert _params(error.problem) == entry["params"]
        if "pipeline_run_id" in entry:
            assert error.problem.pipeline_run_id == entry["pipeline_run_id"]
