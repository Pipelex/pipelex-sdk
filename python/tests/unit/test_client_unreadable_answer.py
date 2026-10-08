"""Tests for the answers the client cannot read: a 2xx whose body is not JSON, not UTF-8, empty where JSON was
expected, or JSON that is not what the route returns. Each is raised as the `ApiResponseError` whose verdict
the fallback reads from the 2xx, `runtime` and not retryable, the parse failure as its `__cause__`, as
`@pipelex/sdk` throws it.

Every request goes through an `httpx.MockTransport`, below `_send`, so the protocol routes the client
inherits from `mthds`, which parse their answer themselves, meet it as they would on the wire.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, TypeAlias

import httpx
import pytest
from mthds.protocol.models import ModelCategory
from pydantic import ValidationError

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.crate_models import MthdsFileItem, PipeIORequest
from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import ApiResponseError, UploadTransportCode, UploadTransportError
from pipelex_sdk.product_models import UpdateRunInput, UploadedFile, UploadInput
from tests.unit.conftest import BASE_URL

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

_Call: TypeAlias = "Callable[[PipelexAPIClient], Coroutine[Any, Any, object]]"

_UNREADABLE_VERDICT = ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)
_REQUEST_ID = "req-7"

# Every route shape the client reads a 2xx answer on: the protocol routes inherited from `mthds`, the
# liveness probe at the origin, the run reads, a validation by inline content and by selector, and the
# product routes, an object, a page, a list, a discriminated union and a verdict among them.
_ROUTES: list[tuple[str, _Call, str]] = [
    ("health", lambda client: client.health(), "GET /health"),
    ("version", lambda client: client.version(), "GET /v1/version"),
    ("models", lambda client: client.models(), "GET /v1/models"),
    ("models-by-category", lambda client: client.models(ModelCategory.LLM), "GET /v1/models?type=llm"),
    ("execute", lambda client: client.execute(pipe_code="p", mthds_contents=["x"]), "POST /v1/execute"),
    ("start", lambda client: client.start(pipe_code="p", mthds_contents=["x"]), "POST /v1/start"),
    ("validate-inline", lambda client: client.validate(["x"]), "POST /v1/validate"),
    ("validate-selector", lambda client: client.validate(method_id="mt_x"), "POST /v1/validate"),
    ("get_run_status", lambda client: client.get_run_status("run-1"), "GET /v1/runs/run-1/status"),
    ("get_run_result", lambda client: client.get_run_result("run-1"), "GET /v1/runs/run-1/results"),
    ("get_me", lambda client: client.get_me(), "GET /v1/me"),
    ("list_methods", lambda client: client.list_methods(), "GET /v1/methods"),
    ("get_method", lambda client: client.get_method("m1"), "GET /v1/methods/m1"),
    ("publish_method", lambda client: client.publish_method("m1", expected_draft_updated_at="t0"), "POST /v1/methods/m1/publish"),
    ("get_subscription", lambda client: client.get_subscription(), "GET /v1/billing/subscription"),
    ("list_plans", lambda client: client.list_plans(), "GET /v1/billing/plans"),
    ("list_invoices", lambda client: client.list_invoices(), "GET /v1/billing/invoices"),
    ("pipe_io", lambda client: client.pipe_io(PipeIORequest(files=[MthdsFileItem(content="x")])), "POST /v1/pipe-io"),
    (
        "check_model_reference",
        lambda client: client.check_model_reference("$writing-factual"),
        "GET /v1/models/check?reference=%24writing-factual",
    ),
    (
        "upload",
        lambda client: client.upload(UploadInput(filename="a.txt", data="eA==", content_type="text/plain")),
        "POST /v1/upload",
    ),
    (
        "resolve_storage_urls_bulk",
        lambda client: client.resolve_storage_urls_bulk(["pipelex-storage://a"]),
        "POST /v1/resolve-storage-url/bulk",
    ),
    ("list_runs", lambda client: client.list_runs("m1"), "GET /v1/runs?method_id=m1"),
    ("get_run_detail", lambda client: client.get_run_detail("run-1"), "GET /v1/runs/run-1"),
]
_ROUTE_PARAMS = [pytest.param(call, route, id=name) for name, call, route in _ROUTES]

# Routes whose answer is JSON, answered with no body at all.
_EMPTY_BODY_ROUTES: list[tuple[str, _Call, str]] = [
    ("health", lambda client: client.health(), "GET /health"),
    ("get_me", lambda client: client.get_me(), "GET /v1/me"),
    ("get_run_detail", lambda client: client.get_run_detail("run-1"), "GET /v1/runs/run-1"),
    ("list_plans", lambda client: client.list_plans(), "GET /v1/billing/plans"),
]

# Routes answered with a body that is not UTF-8, under the 2xx status each takes: an inherited protocol
# route, a run read and a product route.
_NOT_UTF8_ROUTES: list[tuple[str, _Call, str, int]] = [
    ("start", lambda client: client.start(pipe_code="p", mthds_contents=["x"]), "POST /v1/start", 202),
    ("get_run_status", lambda client: client.get_run_status("run-1"), "GET /v1/runs/run-1/status", 200),
    ("get_subscription", lambda client: client.get_subscription(), "GET /v1/billing/subscription", 200),
]

# Routes that answer no content.
_NO_CONTENT_ROUTES: list[tuple[str, _Call, str]] = [
    ("revoke_pipelex_api_key", lambda client: client.revoke_pipelex_api_key("key-1"), "DELETE /v1/pipelex-api-keys/key-1"),
    ("update_run", lambda client: client.update_run("run-1", UpdateRunInput(status="COMPLETED")), "PUT /v1/runs/run-1"),
]

# A completed blocking execute whose `pipe_io_artifacts` carry a member the pinned `mthds` does not define:
# the extension-open `pipe_output` takes it, and the lift onto `RunResults` refuses it.
_DRIFTED_EXECUTE_BODY: dict[str, object] = {
    "pipeline_run_id": "run-x",
    "main_stuff_name": "result",
    "pipe_output": {
        "working_memory": {
            "root": {"result": {"concept": "native.Text", "content": {"text": "hello"}}},
            "aliases": {"main_stuff": "result"},
        },
        "pipeline_run_id": "run-x",
        "pipe_io_artifacts": {
            "pipe_io_contracts": {"x.greet": {"inputs": {}, "output": None, "made_up": 1}},
            "input_form": {},
            "output_form": {},
        },
    },
}
_BARE_VERSION = {"protocol_version": "0.6.0", "implementation": "pipelex-api", "runner_version": "1.2.3"}


def _client_answering(answer: Callable[[httpx.Request], httpx.Response]) -> PipelexAPIClient:
    """A client every request of which `answer` answers, below the client's own `_send`."""
    client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)
    client.client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    return client


def _raised(call: _Call, client: PipelexAPIClient) -> ApiResponseError:
    """The `ApiResponseError` the call raises."""
    with pytest.raises(ApiResponseError) as exc_info:
        asyncio.run(call(client))
    return exc_info.value


class TestClientUnreadableAnswer:
    @pytest.mark.parametrize(("call", "route"), _ROUTE_PARAMS)
    def test_a_2xx_whose_body_is_not_json(self, call: _Call, route: str) -> None:
        client = _client_answering(lambda _: httpx.Response(200, content=b"<html>Maintenance</html>", headers={"X-Request-ID": _REQUEST_ID}))

        unreadable = _raised(call, client)

        assert str(unreadable) == f"API {route} answered 200 with a body that is not JSON"
        assert unreadable.status == 200
        assert unreadable.response_body == "<html>Maintenance</html>"
        assert unreadable.request_id == _REQUEST_ID
        assert unreadable.problem is None
        assert unreadable.server_message is None
        assert isinstance(unreadable.__cause__, json.JSONDecodeError)
        # A 2xx is no refusal the fallback names: runtime, and nothing says a retry helps.
        assert error_verdict_of(unreadable) == _UNREADABLE_VERDICT

    @pytest.mark.parametrize(("call", "route"), _ROUTE_PARAMS)
    def test_a_2xx_whose_json_is_not_the_answer_of_the_route(self, call: _Call, route: str) -> None:
        client = _client_answering(lambda _: httpx.Response(200, content=b"null", headers={"X-Request-ID": _REQUEST_ID}))

        unreadable = _raised(call, client)

        assert str(unreadable) == f"API {route} answered 200 with a body that is not the answer the route returns"
        assert unreadable.status == 200
        assert unreadable.response_body == "null"
        assert unreadable.request_id == _REQUEST_ID
        assert unreadable.problem is None
        assert isinstance(unreadable.__cause__, ValidationError)
        assert error_verdict_of(unreadable) == _UNREADABLE_VERDICT

    @pytest.mark.parametrize(("call", "route"), [pytest.param(call, route, id=name) for name, call, route in _EMPTY_BODY_ROUTES])
    def test_an_empty_2xx_where_the_route_answers_json(self, call: _Call, route: str) -> None:
        client = _client_answering(lambda _: httpx.Response(200))

        unreadable = _raised(call, client)

        assert str(unreadable) == f"API {route} answered 200 with an empty body where JSON was expected"
        assert unreadable.response_body == ""
        assert isinstance(unreadable.__cause__, json.JSONDecodeError)
        assert error_verdict_of(unreadable) == _UNREADABLE_VERDICT

    @pytest.mark.parametrize(
        ("call", "route", "status"), [pytest.param(call, route, status, id=name) for name, call, route, status in _NOT_UTF8_ROUTES]
    )
    def test_a_2xx_whose_body_is_not_utf8(self, call: _Call, route: str, status: int) -> None:
        # `{"pipeline_run_id": "r1\xff"}`: JSON, but with a byte UTF-8 has no place for.
        client = _client_answering(lambda _: httpx.Response(status, content=b'{"pipeline_run_id": "r1\xff"}'))

        unreadable = _raised(call, client)

        assert str(unreadable) == f"API {route} answered {status} with a body that is not UTF-8"
        assert unreadable.status == status
        assert isinstance(unreadable.__cause__, UnicodeDecodeError)
        assert error_verdict_of(unreadable) == _UNREADABLE_VERDICT

    @pytest.mark.parametrize(("call", "route"), [pytest.param(call, route, id=name) for name, call, route in _NO_CONTENT_ROUTES])
    def test_a_route_that_answers_no_content(self, call: _Call, route: str) -> None:
        """An empty 2xx is the answer; a body it does send must still be JSON."""
        assert asyncio.run(call(_client_answering(lambda _: httpx.Response(204)))) is None
        assert asyncio.run(call(_client_answering(lambda _: httpx.Response(200, json={"ok": True})))) is None

        unreadable = _raised(call, _client_answering(lambda _: httpx.Response(200, content=b"<html>Gateway</html>")))

        assert str(unreadable) == f"API {route} answered 200 with a body that is not JSON"
        assert error_verdict_of(unreadable) == _UNREADABLE_VERDICT

    def test_a_completed_run_whose_results_are_not_an_object(self) -> None:
        client = _client_answering(lambda _: httpx.Response(200, json=["not", "results"]))

        unreadable = _raised(lambda client: client.get_run_result("run-1"), client)

        assert str(unreadable) == "API GET /v1/runs/run-1/results answered 200 with a body that is not the answer the route returns"

    def test_the_blocking_path_reports_an_execute_answer_it_cannot_lift(self) -> None:
        """`start_and_wait` on a bare runner lifts `execute`'s answer onto `RunResults`, whose strict parse
        of the run's artifacts refuses a member the pinned `mthds` does not define: an answer the SDK
        cannot read, like one `execute` itself cannot.
        """

        def _answer(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v1/version":
                return httpx.Response(200, json=_BARE_VERSION)
            return httpx.Response(200, json=_DRIFTED_EXECUTE_BODY)

        unreadable = _raised(lambda client: client.start_and_wait(pipe_code="p", mthds_contents=["x"]), _client_answering(_answer))

        assert str(unreadable) == "API POST /v1/execute answered 200 with a body that is not the answer the route returns"
        assert isinstance(unreadable.__cause__, ValidationError)
        assert error_verdict_of(unreadable) == _UNREADABLE_VERDICT

    def test_a_refusal_met_before_any_answer_is_the_callers(self) -> None:
        """A parse failure inside an inherited route before `_send` received anything is not an answer."""
        client = PipelexAPIClient(api_key="test-token", base_url=BASE_URL)

        with pytest.raises(ValidationError), client._reading_inherited_answer(method="POST", endpoint="execute"):
            UploadedFile.model_validate({})

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param(b"<html>Gateway</html>", id="not-json"),
            pytest.param(b"{}", id="no-uri"),
            pytest.param(b'{"uri": null, "filename": "a.txt"}', id="null-uri"),
            pytest.param(b'{"uri": "", "filename": "a.txt"}', id="empty-uri"),
        ],
    )
    def test_upload_file_wraps_an_upload_answer_it_cannot_read(self, body: bytes) -> None:
        client = _client_answering(lambda _: httpx.Response(200, content=body, headers={"X-Request-ID": "req-9"}))

        with pytest.raises(UploadTransportError) as exc_info:
            asyncio.run(client.upload_file(b"\x01", filename="a.txt"))

        transport = exc_info.value
        assert transport.code == UploadTransportCode.UNEXPECTED
        assert transport.status == 200
        assert (
            str(transport)
            == 'Upload of "a.txt" was answered (200) with a body the SDK could not read, so whether and where the file was stored is unknown.'
        )
        unreadable = transport.__cause__
        assert isinstance(unreadable, ApiResponseError)
        assert unreadable.request_id == "req-9"
        # Storage may hold the file, but under no reference: nothing says a retry helps.
        assert error_verdict_of(transport) == _UNREADABLE_VERDICT
