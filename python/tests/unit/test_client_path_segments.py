"""Tests for the ids a route puts in its path — a method's, an example's, a run's, an organization's, an API key's.

The twin of `pipelex-sdk-js/tests/path-segments.test.ts`. Every such id goes through one guard. An id the URL
would resolve rather than address, `.`, `..` or an empty one, is refused before anything is sent: `..` given as an
example id would otherwise reach the method itself, and a delete of it would erase the method. Every other id stays
in its own segment once the URL is resolved. The requests are recorded below `_send`, by an `httpx.MockTransport`,
so what these tests read is the URL httpx would send, dot segments resolved, not a raw string the client built.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, TypeAlias, cast
from urllib.parse import quote

import httpx
import pytest

from pipelex_sdk.error_verdicts import ErrorDomain, ErrorVerdict, error_verdict_of
from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.product_models import MethodDraftInput, UpdateRunInput
from tests.unit.conftest import BASE_URL
from tests.unit.test_data import MethodExampleBodies

if TYPE_CHECKING:
    from collections.abc import Callable, Coroutine

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import RecordingClientBuilder


#: A call of one route on a client, given the id it puts in its path, as a coroutine `asyncio.run` drives.
IdRouteCall: TypeAlias = "Callable[[PipelexAPIClient, str], Coroutine[Any, Any, object]]"

#: The URL a route addresses, given its id already encoded as one segment.
IdRouteUrl: TypeAlias = "Callable[[str], str]"

_METHOD_ID = MethodExampleBodies.METHOD_ID
_EXAMPLE_ID = MethodExampleBodies.EXAMPLE_ID
_METHODS_URL = f"{BASE_URL}/v1/methods"
_EXAMPLES_URL = f"{_METHODS_URL}/{_METHOD_ID}/examples"

#: A refusal every route raises as an `ApiResponseError`, so a call ends once its one request is recorded.
_REFUSAL: dict[str, object] = {"status": 400, "code": "malformed_request", "detail": "Refused by the test."}

_A_METHOD_ID = "a method id"
_AN_EXAMPLE_ID = "an example id"
_A_RUN_ID = "a run id"

#: Each route that puts an id in its path: what the id is, the route's name as a refusal names it, the call given
#: that id, and the URL it addresses.
_ROUTES: list[tuple[str, str, IdRouteCall, IdRouteUrl]] = [
    (_A_METHOD_ID, "get_method", lambda client, id_: client.get_method(id_), lambda seg: f"{_METHODS_URL}/{seg}"),
    (
        _A_METHOD_ID,
        "write_draft",
        lambda client, id_: client.write_draft(id_, MethodDraftInput(mthds="")),
        lambda seg: f"{_METHODS_URL}/{seg}/draft",
    ),
    (_A_METHOD_ID, "rename_method", lambda client, id_: client.rename_method(id_, "n"), lambda seg: f"{_METHODS_URL}/{seg}"),
    (
        _A_METHOD_ID,
        "publish_method",
        lambda client, id_: client.publish_method(id_, expected_draft_updated_at="t"),
        lambda seg: f"{_METHODS_URL}/{seg}/publish",
    ),
    (
        _A_METHOD_ID,
        "list_method_versions",
        lambda client, id_: client.list_method_versions(id_),
        lambda seg: f"{_METHODS_URL}/{seg}/versions",
    ),
    (
        _A_METHOD_ID,
        "get_method_version",
        lambda client, id_: client.get_method_version(id_, 2),
        lambda seg: f"{_METHODS_URL}/{seg}/versions/2",
    ),
    (_A_METHOD_ID, "delete_method", lambda client, id_: client.delete_method(id_), lambda seg: f"{_METHODS_URL}/{seg}"),
    (
        _A_METHOD_ID,
        "create_method_example",
        lambda client, id_: client.create_method_example(id_, name="n", inputs={}),
        lambda seg: f"{_METHODS_URL}/{seg}/examples",
    ),
    (
        _A_METHOD_ID,
        "list_method_examples",
        lambda client, id_: client.list_method_examples(id_),
        lambda seg: f"{_METHODS_URL}/{seg}/examples",
    ),
    (
        _A_METHOD_ID,
        "get_method_example",
        lambda client, id_: client.get_method_example(id_, _EXAMPLE_ID),
        lambda seg: f"{_METHODS_URL}/{seg}/examples/{_EXAMPLE_ID}",
    ),
    (
        _A_METHOD_ID,
        "delete_method_example",
        lambda client, id_: client.delete_method_example(id_, _EXAMPLE_ID),
        lambda seg: f"{_METHODS_URL}/{seg}/examples/{_EXAMPLE_ID}",
    ),
    (_AN_EXAMPLE_ID, "get_method_example", lambda client, id_: client.get_method_example(_METHOD_ID, id_), lambda seg: f"{_EXAMPLES_URL}/{seg}"),
    (
        _AN_EXAMPLE_ID,
        "update_method_example",
        lambda client, id_: client.update_method_example(_METHOD_ID, id_, name="n"),
        lambda seg: f"{_EXAMPLES_URL}/{seg}",
    ),
    (
        _AN_EXAMPLE_ID,
        "record_method_example_latest_run",
        lambda client, id_: client.record_method_example_latest_run(_METHOD_ID, id_, run_id="run_1", input_revision=1),
        lambda seg: f"{_EXAMPLES_URL}/{seg}/latest-run",
    ),
    (
        _AN_EXAMPLE_ID,
        "delete_method_example",
        lambda client, id_: client.delete_method_example(_METHOD_ID, id_),
        lambda seg: f"{_EXAMPLES_URL}/{seg}",
    ),
    (_A_RUN_ID, "get_run_status", lambda client, id_: client.get_run_status(id_), lambda seg: f"{BASE_URL}/v1/runs/{seg}/status"),
    (_A_RUN_ID, "get_run_result", lambda client, id_: client.get_run_result(id_), lambda seg: f"{BASE_URL}/v1/runs/{seg}/results"),
    (_A_RUN_ID, "get_run_detail", lambda client, id_: client.get_run_detail(id_), lambda seg: f"{BASE_URL}/v1/runs/{seg}"),
    (
        _A_RUN_ID,
        "update_run",
        lambda client, id_: client.update_run(id_, UpdateRunInput(status="FAILED")),
        lambda seg: f"{BASE_URL}/v1/runs/{seg}",
    ),
    (
        "an organization id",
        "rename_organization",
        lambda client, id_: client.rename_organization(id_, "n"),
        lambda seg: f"{BASE_URL}/v1/organizations/{seg}",
    ),
    (
        "an API key id",
        "revoke_pipelex_api_key",
        lambda client, id_: client.revoke_pipelex_api_key(id_),
        lambda seg: f"{BASE_URL}/v1/pipelex-api-keys/{seg}",
    ),
    (
        "an API key id",
        "rotate_pipelex_api_key",
        lambda client, id_: client.rotate_pipelex_api_key(id_),
        lambda seg: f"{BASE_URL}/v1/pipelex-api-keys/{seg}/rotate",
    ),
]

_ROUTE_PARAMS = [pytest.param(what, name, call, url, id=f"{name}-{what.split(' ', 1)[1].replace(' ', '-')}") for what, name, call, url in _ROUTES]

_DOT_SEGMENT = "a dot segment, which the URL would resolve into another route's path"

_LONE_SURROGATE = "a string holding a lone surrogate, which a URL cannot carry"

#: Ids that look like a dot segment or a path but are none once encoded: each must reach its route as one segment.
_KEPT_IDS = ["...", ".x", "x.", "%2e%2e", ".%2E", "a/..", "a\\b", "?q", "#f"]


class TestClientPathSegments:
    def test_a_dot_segment_left_in_a_path_is_resolved_onto_another_route(self) -> None:
        """The premise of the guard: httpx resolves the dot segments of the URL it is given before the request leaves."""
        assert httpx.Request("DELETE", f"{_EXAMPLES_URL}/..").url == httpx.URL(f"{_METHODS_URL}/{_METHOD_ID}")
        assert httpx.Request("GET", f"{_EXAMPLES_URL}/.").url == httpx.URL(_EXAMPLES_URL)

    @pytest.mark.parametrize(
        ("refused_id", "got"),
        [
            pytest.param("", "an empty string", id="empty"),
            pytest.param(".", f'".", {_DOT_SEGMENT}', id="dot"),
            pytest.param("..", f'"..", {_DOT_SEGMENT}', id="dot-dot"),
            pytest.param(None, "None", id="none"),
            pytest.param(7, "int", id="not-a-string"),
            # A lone surrogate has no UTF-8 spelling, so `quote` raises a `UnicodeEncodeError` for it.
            pytest.param("ex_\ud800", _LONE_SURROGATE, id="lone-high-surrogate"),
            pytest.param("\udc00ex", _LONE_SURROGATE, id="lone-low-surrogate"),
        ],
    )
    @pytest.mark.parametrize(("what", "name", "call", "url"), _ROUTE_PARAMS)
    def test_a_route_refuses_an_id_it_cannot_address_before_any_request(
        self,
        recording_client: RecordingClientBuilder,
        what: str,
        name: str,
        call: IdRouteCall,
        url: IdRouteUrl,
        refused_id: object,
        got: str,
    ) -> None:
        del url
        sent: list[httpx.Request] = []
        client = recording_client(sent, 400, json_body=_REFUSAL)

        with pytest.raises(RequestArgumentError) as exc_info:
            asyncio.run(call(client, cast("str", refused_id)))

        message = str(exc_info.value)
        assert message.startswith(f"{name}() takes {what}, ")
        assert message.endswith(f"; got {got}.")
        assert error_verdict_of(exc_info.value) == ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)
        assert sent == []

    @pytest.mark.parametrize("kept_id", _KEPT_IDS)
    @pytest.mark.parametrize(("what", "name", "call", "url"), _ROUTE_PARAMS)
    def test_a_route_keeps_any_other_id_in_its_own_segment_once_the_url_is_resolved(
        self,
        recording_client: RecordingClientBuilder,
        what: str,
        name: str,
        call: IdRouteCall,
        url: IdRouteUrl,
        kept_id: str,
    ) -> None:
        del what, name
        sent: list[httpx.Request] = []
        client = recording_client(sent, 400, json_body=_REFUSAL)

        with pytest.raises(ApiResponseError):
            asyncio.run(call(client, kept_id))

        assert len(sent) == 1
        assert sent[0].url == httpx.URL(url(quote(kept_id, safe="")))
