"""Tests for the paged-list iterators — `iterate_methods` and `iterate_runs`.

Both follow `next_cursor` until the server says stop, through one shared loop. Both lists can filter
after the index read (`q` and `published` on methods, `created_by` and `status` on runs), so a
page can be empty with a live cursor, which is not the end. These pin that rule, the filters sent
on every page, the stuck-cursor guard, and the runaway backstop.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import parse_qs, urlparse

import pytest

from pipelex_sdk.errors import PagingNotTerminatingError, RequestArgumentError
from pipelex_sdk.runs import RunStatus

if TYPE_CHECKING:
    from pytest_mock import MockerFixture, MockType

    from pipelex_sdk.client import PipelexAPIClient
    from pipelex_sdk.product_models import MethodSummary, RunHistoryItem
    from tests.unit.conftest import ResponseBuilder, SendPatcher


def _method(method_id: str) -> dict[str, Any]:
    return {"method_id": method_id, "name": f"Method {method_id}", "created_at": "t"}


def _run(run_id: str, method_id: str = "m1") -> dict[str, Any]:
    return {"pipeline_run_id": run_id, "method_id": method_id, "created_by_user_id": "u1", "pipe_code": "p", "status": "RUNNING", "created_at": "t"}


def _cursors_sent(send: MockType) -> list[str | None]:
    """The `cursor` query value of every request the spy recorded, in order."""
    cursors: list[str | None] = []
    for call in send.call_args_list:
        url = cast("str", call.args[1])
        query: dict[str, list[str]] = parse_qs(urlparse(url).query)
        values = query.get("cursor")
        cursors.append(values[0] if values else None)
    return cursors


async def _drain_methods(client: PipelexAPIClient, **kwargs: Any) -> list[MethodSummary]:
    return [summary async for summary in client.iterate_methods(**kwargs)]


async def _drain_runs(client: PipelexAPIClient, **kwargs: Any) -> list[RunHistoryItem]:
    return [pipeline_run async for pipeline_run in client.iterate_runs(**kwargs)]


def _queries_sent(send: MockType) -> list[dict[str, list[str]]]:
    """The parsed query of every request the spy recorded, in order."""
    return [parse_qs(urlparse(cast("str", call.args[1])).query) for call in send.call_args_list]


class TestClientPaging:
    def test_iterate_methods_follows_the_cursor_and_stops_on_none(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [_method("m1")], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [_method("m2")], "next_cursor": None}),
        )

        summaries = asyncio.run(_drain_methods(api_client))

        assert [summary.method_id for summary in summaries] == ["m1", "m2"]
        # The cursor sent on page N+1 is exactly the `next_cursor` received on page N.
        assert _cursors_sent(send) == [None, "c1"]

    def test_iterate_methods_continues_through_an_empty_page_with_a_live_cursor(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        """`q` filters after the index read, so an empty page means "keep going", not "done"."""
        patch_send(
            api_client,
            wire_response(200, json_body={"items": [], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [], "next_cursor": "c2"}),
            wire_response(200, json_body={"items": [_method("m9")], "next_cursor": None}),
        )

        summaries = asyncio.run(_drain_methods(api_client, q="needle"))

        assert [summary.method_id for summary in summaries] == ["m9"]

    def test_iterate_methods_stops_on_an_unchanged_cursor_without_re_yielding(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        """A server that hands back the cursor it was sent stops the loop *before* yielding."""
        patch_send(
            api_client,
            wire_response(200, json_body={"items": [_method("m1")], "next_cursor": "stuck"}),
            wire_response(200, json_body={"items": [_method("m1")], "next_cursor": "stuck"}),
        )

        summaries = asyncio.run(_drain_methods(api_client))

        assert [summary.method_id for summary in summaries] == ["m1"]

    def test_iterate_methods_raises_past_the_page_ceiling(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        mocker: MockerFixture,
    ) -> None:
        """The backstop raises rather than returning: a truncated list is the bug paging removed."""
        mocker.patch("pipelex_sdk.client._MAX_LIST_PAGES", 2)
        pages = [wire_response(200, json_body={"items": [_method(f"m{index}")], "next_cursor": f"c{index}"}) for index in range(5)]
        send = patch_send(api_client, *pages)

        with pytest.raises(PagingNotTerminatingError) as exc_info:
            asyncio.run(_drain_methods(api_client))

        assert exc_info.value.page_limit == 2
        # The raise lands ON the ceiling, not one page past it — otherwise a loosened
        # comparison would still satisfy `page_limit`, which only echoes the constant.
        assert send.call_count == 2

    def test_iterate_methods_sends_published_on_every_page(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [_method("m1")], "next_cursor": None}),
        )

        summaries = asyncio.run(_drain_methods(api_client, published=False))

        assert [summary.method_id for summary in summaries] == ["m1"]
        assert [query.get("published") for query in _queries_sent(send)] == [["false"], ["false"]]
        assert _cursors_sent(send) == [None, "c1"]

    def test_iterate_runs_continues_through_an_empty_page_with_a_live_cursor(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        """`created_by` and `status` may filter after the index read, so an empty page means "keep going"."""
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [], "next_cursor": "c2"}),
            wire_response(200, json_body={"items": [_run("r99")], "next_cursor": None}),
        )

        runs = asyncio.run(_drain_runs(api_client, created_by="me", status=[RunStatus.RUNNING]))

        assert [pipeline_run.pipeline_run_id for pipeline_run in runs] == ["r1", "r99"]
        assert _cursors_sent(send) == [None, "c1", "c2"]
        for query in _queries_sent(send):
            assert query.get("created_by") == ["me"]
            assert query.get("status") == ["RUNNING"]

    def test_iterate_runs_sends_a_one_shot_status_filter_whole_with_every_page(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        """A generator is checked and copied once at the call, so the second page filters as the first does."""
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [_run("r2")], "next_cursor": None}),
        )
        wanted = (status for status in [RunStatus.FAILED, RunStatus.RUNNING])

        runs = asyncio.run(_drain_runs(api_client, status=wanted))

        assert [pipeline_run.pipeline_run_id for pipeline_run in runs] == ["r1", "r2"]
        assert [query.get("status") for query in _queries_sent(send)] == [["RUNNING", "FAILED"], ["RUNNING", "FAILED"]]

    @pytest.mark.parametrize(
        ("status", "error_type"),
        [
            pytest.param([], RequestArgumentError, id="empty"),
            pytest.param([cast("RunStatus", "running")], RequestArgumentError, id="unknown"),
            pytest.param(cast("list[RunStatus]", RunStatus.RUNNING), TypeError, id="bare-string"),
        ],
    )
    def test_iterate_runs_refuses_a_bad_status_at_the_call(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        status: list[RunStatus],
        error_type: type[Exception],
    ) -> None:
        """The refusal comes from the call itself, before the iterator exists or anything is sent."""
        send = patch_send(api_client, wire_response(200, json_body={"items": [], "next_cursor": None}))

        with pytest.raises(error_type):
            api_client.iterate_runs(status=status)

        send.assert_not_called()

    def test_iterate_runs_raises_past_the_page_ceiling_on_empty_pages(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        mocker: MockerFixture,
    ) -> None:
        """Empty pages with a fresh cursor each time are ended by the ceiling, which raises rather than truncates."""
        mocker.patch("pipelex_sdk.client._MAX_LIST_PAGES", 3)
        pages = [wire_response(200, json_body={"items": [], "next_cursor": f"c{index}"}) for index in range(5)]
        send = patch_send(api_client, *pages)

        with pytest.raises(PagingNotTerminatingError, match="Run paging did not terminate") as exc_info:
            asyncio.run(_drain_runs(api_client, method_id="m1"))

        assert exc_info.value.page_limit == 3
        assert send.call_count == 3

    def test_iterate_runs_follows_the_cursor_and_stops_on_none(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [_run("r2")], "next_cursor": None}),
        )

        runs = asyncio.run(_drain_runs(api_client, method_id="m1"))

        assert [pipeline_run.pipeline_run_id for pipeline_run in runs] == ["r1", "r2"]
        assert _cursors_sent(send) == [None, "c1"]
        # The method rides every page, since a cursor is bound to the list that issued it.
        assert [query.get("method_id") for query in _queries_sent(send)] == [["m1"], ["m1"]]

    def test_iterate_runs_without_a_method_follows_the_organizations_list(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        """Without a method, no page names one: the organization's runs of every method."""
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [_run("r1", "m1")], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [_run("r2", "m2")], "next_cursor": None}),
        )

        runs = asyncio.run(_drain_runs(api_client))

        assert [(pipeline_run.method_id, pipeline_run.pipeline_run_id) for pipeline_run in runs] == [("m1", "r1"), ("m2", "r2")]
        assert _queries_sent(send) == [{}, {"cursor": ["c1"]}]

    def test_iterate_runs_raises_on_a_cursor_cycle_over_non_empty_pages(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        mocker: MockerFixture,
    ) -> None:
        """A cursor cycling across two values trips no check but the page ceiling.

        `c1 → c2 → c1 → …` with every page non-empty would loop forever re-yielding the same
        runs; the shared page ceiling is what bounds it.
        """
        mocker.patch("pipelex_sdk.client._MAX_LIST_PAGES", 4)
        cycle = [
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [_run("r2")], "next_cursor": "c2"}),
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "c1"}),
            wire_response(200, json_body={"items": [_run("r2")], "next_cursor": "c2"}),
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "c1"}),
        ]
        send = patch_send(api_client, *cycle)

        with pytest.raises(PagingNotTerminatingError) as exc_info:
            asyncio.run(_drain_runs(api_client, method_id="m1"))

        assert exc_info.value.page_limit == 4
        assert send.call_count == 4

    def test_iterate_runs_stops_on_an_unchanged_cursor_without_re_yielding(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
    ) -> None:
        patch_send(
            api_client,
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "stuck"}),
            wire_response(200, json_body={"items": [_run("r1")], "next_cursor": "stuck"}),
        )

        runs = asyncio.run(_drain_runs(api_client, method_id="m1"))

        assert [pipeline_run.pipeline_run_id for pipeline_run in runs] == ["r1"]
