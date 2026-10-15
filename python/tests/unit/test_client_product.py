"""Tests for the Pipelex product surface — verb + path + body per route, model round-trips, `.code` branching.

Ports `pipelex-sdk-js/tests/product.test.ts`. `_send` is mocked; bodies use complete valid
shapes (Pydantic validates on the way back, unlike the TS interfaces).
"""

import asyncio
import json
from typing import cast

import httpx
import pytest
from pytest_mock import MockerFixture, MockType

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, RequestArgumentError
from pipelex_sdk.product_models import (
    MethodDeletionState,
    MethodDraftInput,
    MethodFile,
    MethodSummary,
    MethodWriteInput,
    OnboardingCurrentTool,
    OnboardingHeardFrom,
    OnboardingInputType,
    OnboardingRole,
    OnboardingSubmission,
    OrgRole,
    RunHistoryItem,
    UpdateRunInput,
    UploadInput,
)
from pipelex_sdk.runs import RunStatus

_BASE_URL = "http://localhost:8081"

# The platform's `MethodPublic` shape: `org_id` and `created_by_user_id` are required, and
# `python` crosses the wire as one string holding a JSON `[{name, content}]` array.
_METHOD_BODY: dict[str, object] = {
    "method_id": "m1",
    "name": "M",
    "mthds": "src",
    "org_id": "org_1",
    "created_by_user_id": "u1",
    "python": "",
    "created_at": "t",
    "updated_at": "t",
    "draft_digest": "5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47",
}


def _response(status_code: int, *, json_body: object | None = None, content: bytes | None = None) -> httpx.Response:
    request = httpx.Request("GET", f"{_BASE_URL}/x")
    if json_body is not None:
        return httpx.Response(status_code, json=json_body, request=request)
    if content is not None:
        return httpx.Response(status_code, content=content, request=request)
    return httpx.Response(status_code, request=request)


def _sent_body(send: MockType) -> dict[str, object]:
    """The decoded JSON request body of the single recorded `_send` call."""
    content = send.call_args.kwargs["content"]
    return cast("dict[str, object]", json.loads(content))


class _Sent:
    """The single `_send` call recorded by the spy, decoded for assertions."""

    def __init__(self, method: str, url: str, body: object | None) -> None:
        self.method = method
        self.url = url
        self.body = body


class TestClientProduct:
    def _client(self) -> PipelexAPIClient:
        return PipelexAPIClient(api_key="test-token", base_url=_BASE_URL)

    def _mock_send(self, mocker: MockerFixture, client: PipelexAPIClient, response: httpx.Response) -> MockType:
        return mocker.patch.object(client, "_send", mocker.AsyncMock(return_value=response))

    @staticmethod
    def _sent(send: MockType) -> _Sent:
        call = send.call_args
        content = call.kwargs["content"]
        body = json.loads(content) if content is not None else None
        return _Sent(method=call.args[0], url=call.args[1], body=body)

    # ── User profile ─────────────────────────────────────────────────

    def test_get_me(self, mocker: MockerFixture) -> None:
        client = self._client()
        profile = {"email": "a@b.com", "user_id": "u1", "full_name": "A B", "onboarding_completed_at": None}
        send = self._mock_send(mocker, client, _response(200, json_body=profile))

        result = asyncio.run(client.get_me())

        sent = self._sent(send)
        assert sent.method == "GET"
        assert sent.url == f"{_BASE_URL}/v1/me"
        assert result.email == "a@b.com"
        assert result.user_id == "u1"
        assert result.onboarding_completed_at is None

    # ── Methods catalog ──────────────────────────────────────────────

    def test_list_methods_returns_the_page_envelope(self, mocker: MockerFixture) -> None:
        """The route answers `{items, next_cursor}`; the rows are index projections, not full methods."""
        client = self._client()
        page = {
            "items": [{"method_id": "m1", "name": "M", "description": "d", "created_at": "t", "deletion_state": "pending"}],
            "next_cursor": "c1",
        }
        send = self._mock_send(mocker, client, _response(200, json_body=page))

        result = asyncio.run(client.list_methods())

        assert self._sent(send).url == f"{_BASE_URL}/v1/methods"
        assert result.next_cursor == "c1"
        assert result.items[0].method_id == "m1"
        assert result.items[0].description == "d"
        # A method mid-deletion stays listed, so a UI can render "Deleting…".
        assert result.items[0].deletion_state is MethodDeletionState.PENDING

    def test_list_methods_keeps_query_params_on_presence(self, mocker: MockerFixture) -> None:
        """An explicit empty `q` is forwarded — bad input the API should reject, not something to drop."""
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(client.list_methods(q="", limit=50, cursor="c/1"))

        assert self._sent(send).url == f"{_BASE_URL}/v1/methods?q=&limit=50&cursor=c%2F1"

    def test_list_methods_omits_absent_query_params_entirely(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(client.list_methods(limit=5))

        assert self._sent(send).url == f"{_BASE_URL}/v1/methods?limit=5"

    @pytest.mark.parametrize(("published", "expected"), [(True, "published=true"), (False, "published=false")])
    def test_list_methods_sends_published_as_the_wire_spells_it(self, mocker: MockerFixture, published: bool, expected: str) -> None:
        """`False` is a filter of its own (the methods never published), never omission, and never `False`."""
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(client.list_methods(q="invoice", published=published, limit=10))

        assert self._sent(send).url == f"{_BASE_URL}/v1/methods?q=invoice&{expected}&limit=10"

    def test_list_methods_parses_each_rows_publish_state(self, mocker: MockerFixture) -> None:
        """The three states a list tells apart from the row alone, `draft_digest` null on one of them."""
        client = self._client()
        latest_published = {
            "version": 3,
            "source_digest": "a" * 64,
            "crate_fingerprint": None,
            "runner_version": "0.73.0",
            "description": "Reads invoices",
            "published_at": "2026-10-12T09:00:00Z",
            "published_by": "user_1",
        }
        never_published = {
            "method_id": "m1",
            "name": "Draft only",
            "description": None,
            "created_at": "2026-10-12T10:00:00Z",
            "deletion_state": None,
            "latest_version": None,
            "latest_published": None,
            "draft_digest": "b" * 64,
        }
        no_stored_digest = {
            **never_published,
            "method_id": "m2",
            "latest_version": 3,
            "latest_published": latest_published,
            "draft_digest": None,
        }
        draft_ahead = {**no_stored_digest, "method_id": "m3", "draft_digest": "c" * 64}
        page = {"items": [never_published, no_stored_digest, draft_ahead], "next_cursor": None}
        self._mock_send(mocker, client, _response(200, json_body=page))

        result = asyncio.run(client.list_methods(published=True))

        first, second, third = result.items
        assert first.latest_version is None
        assert first.latest_published is None
        assert first.draft_digest == "b" * 64
        assert second.latest_version == 3
        assert second.latest_published is not None
        assert second.latest_published.version == 3
        assert second.latest_published.source_digest == "a" * 64
        assert second.latest_published.crate_fingerprint is None
        assert second.draft_digest is None
        assert third.latest_published is not None
        assert third.draft_digest != third.latest_published.source_digest
        # Declared fields, so none of them lands in the extension-open overflow.
        assert second.model_extra == {}

    def test_list_methods_reads_a_row_without_the_publish_state_as_none(self, mocker: MockerFixture) -> None:
        """A platform that serves no publish state still answers a row the SDK reads."""
        client = self._client()
        page = {"items": [{"method_id": "m1", "name": "M", "created_at": "t"}], "next_cursor": None}
        self._mock_send(mocker, client, _response(200, json_body=page))

        result = asyncio.run(client.list_methods())

        row = result.items[0]
        assert isinstance(row, MethodSummary)
        assert row.latest_version is None
        assert row.latest_published is None
        assert row.draft_digest is None

    def test_method_data_parses_the_new_fields_and_the_python_wire_string(self, mocker: MockerFixture) -> None:
        """`python` is one wire string; the boundary converts it so callers never see it."""
        client = self._client()
        body = {**_METHOD_BODY, "description": "d", "python": '[{"name": "a.py", "content": "x = 1"}]'}
        self._mock_send(mocker, client, _response(200, json_body=body))

        method = asyncio.run(client.get_method("m1"))

        assert method.org_id == "org_1"
        assert method.created_by_user_id == "u1"
        assert method.description == "d"
        assert method.deletion_state is None
        assert method.python == [MethodFile(name="a.py", content="x = 1")]

    def test_method_data_reads_the_clear_sentinel_as_no_files(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(200, json_body=_METHOD_BODY))

        assert asyncio.run(client.get_method("m1")).python == []

    def test_draft_input_sends_python_three_ways(self, mocker: MockerFixture) -> None:
        """Unset omits the key (preserve), `[]` sends the clear sentinel, a list sends the JSON text."""
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_METHOD_BODY))

        asyncio.run(client.write_draft("m1", MethodDraftInput(mthds="src")))
        assert "python" not in _sent_body(send)

        send = self._mock_send(mocker, client, _response(200, json_body=_METHOD_BODY))
        asyncio.run(client.write_draft("m1", MethodDraftInput(mthds="src", python=[])))
        assert _sent_body(send)["python"] == ""

        send = self._mock_send(mocker, client, _response(200, json_body=_METHOD_BODY))
        asyncio.run(client.create_method(MethodWriteInput(name="M", mthds="src", python=[MethodFile(name="a.py", content="x = 1")])))
        assert json.loads(cast("str", _sent_body(send)["python"])) == [{"name": "a.py", "content": "x = 1"}]

    def test_get_method_encodes_id(self, mocker: MockerFixture) -> None:
        client = self._client()
        body = {**_METHOD_BODY, "method_id": "a/b"}
        send = self._mock_send(mocker, client, _response(200, json_body=body))

        asyncio.run(client.get_method("a/b"))

        assert self._sent(send).url == f"{_BASE_URL}/v1/methods/a%2Fb"

    def test_create_method_posts_write_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        body = _METHOD_BODY
        send = self._mock_send(mocker, client, _response(200, json_body=body))

        asyncio.run(client.create_method(MethodWriteInput(name="M", mthds="src", input_data={"a": 1})))

        sent = self._sent(send)
        assert sent.method == "POST"
        assert sent.url == f"{_BASE_URL}/v1/methods"
        assert sent.body == {"name": "M", "mthds": "src", "input_data": {"a": 1}}

    def test_create_method_drops_absent_input_data(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=_METHOD_BODY))

        asyncio.run(client.create_method(MethodWriteInput(name="M", mthds="src")))

        # input_data is None → dropped from the wire (matches the JS undefined-drop).
        assert self._sent(send).body == {"name": "M", "mthds": "src"}

    def test_delete_method_returns_the_202_acceptance(self, mocker: MockerFixture) -> None:
        """The erasure is asynchronous: the caller gets the CLAIM, never a "it's gone" signal.

        Completion is the row disappearing from `list_methods`, so the honest return value is the
        acceptance body — a `deletion_job_id` to log or correlate, and the state it started in.
        """
        client = self._client()
        body = {"method_id": "m1", "deletion_state": "pending", "deletion_job_id": "job-1"}
        send = self._mock_send(mocker, client, _response(202, json_body=body))

        accepted = asyncio.run(client.delete_method("m/1"))

        sent = self._sent(send)
        assert sent.method == "DELETE"
        assert sent.url == f"{_BASE_URL}/v1/methods/m%2F1"
        assert accepted.method_id == "m1"
        assert accepted.deletion_state is MethodDeletionState.PENDING
        assert accepted.deletion_job_id == "job-1"

    # ── Organizations ────────────────────────────────────────────────

    def test_list_memberships(self, mocker: MockerFixture) -> None:
        client = self._client()
        membership = {"org_id": "o1", "workos_organization_id": None, "name": "Acme", "is_personal": True, "role_in_org": "admin"}
        body = {"memberships": [membership], "active_org_feature_flags": ["flag"]}
        send = self._mock_send(mocker, client, _response(200, json_body=body))

        result = asyncio.run(client.list_memberships())

        assert self._sent(send).url == f"{_BASE_URL}/v1/organizations/memberships"
        assert result.active_org_feature_flags == ["flag"]
        assert result.memberships[0].role_in_org is OrgRole.ADMIN

    @pytest.mark.parametrize(
        ("slug", "expected"),
        [
            ("admin", OrgRole.ADMIN),
            ("member", OrgRole.MEMBER),
            ("runner", OrgRole.RUNNER),
        ],
    )
    def test_list_memberships_reads_each_known_role_as_its_member(self, mocker: MockerFixture, slug: str, expected: OrgRole) -> None:
        client = self._client()
        membership = {"org_id": "o1", "workos_organization_id": "wo1", "name": "Acme", "is_personal": False, "role_in_org": slug}
        self._mock_send(mocker, client, _response(200, json_body={"memberships": [membership], "active_org_feature_flags": []}))

        result = asyncio.run(client.list_memberships())

        assert result.memberships[0].role_in_org is expected

    def test_list_memberships_keeps_an_unknown_role_as_its_string(self, mocker: MockerFixture) -> None:
        """A role a later platform adds reads as its raw slug, and the rest of the response still reads."""
        client = self._client()
        runner = {"org_id": "o1", "workos_organization_id": "wo1", "name": "Acme", "is_personal": False, "role_in_org": "runner"}
        unknown = {"org_id": "o2", "workos_organization_id": "wo2", "name": "Beta", "is_personal": False, "role_in_org": "auditor"}
        body = {"memberships": [runner, unknown], "active_org_feature_flags": ["flag"]}
        self._mock_send(mocker, client, _response(200, json_body=body))

        result = asyncio.run(client.list_memberships())

        assert result.memberships[0].role_in_org is OrgRole.RUNNER
        unknown_role = result.memberships[1].role_in_org
        assert type(unknown_role) is str
        assert unknown_role == "auditor"
        assert result.memberships[1].name == "Beta"
        assert result.active_org_feature_flags == ["flag"]

    def test_list_memberships_refuses_a_role_that_is_not_a_string(self, mocker: MockerFixture) -> None:
        client = self._client()
        membership = {"org_id": "o1", "workos_organization_id": None, "name": "Acme", "is_personal": True, "role_in_org": None}
        self._mock_send(mocker, client, _response(200, json_body={"memberships": [membership], "active_org_feature_flags": []}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.list_memberships())

        assert exc_info.value.status == 200

    @pytest.mark.parametrize(
        ("slug", "expected"),
        [
            ("runner", OrgRole.RUNNER),
            ("auditor", "auditor"),
        ],
    )
    def test_create_and_rename_organization_read_any_role(self, mocker: MockerFixture, slug: str, expected: OrgRole | str) -> None:
        client = self._client()
        body = {"org_id": "o1", "workos_organization_id": "wo1", "name": "Acme", "is_personal": False, "role_in_org": slug}
        self._mock_send(mocker, client, _response(200, json_body=body))

        created = asyncio.run(client.create_organization("Acme"))
        renamed = asyncio.run(client.rename_organization("o1", "Acme"))

        assert created.role_in_org == expected
        assert type(created.role_in_org) is type(expected)
        assert renamed.role_in_org == expected
        assert type(renamed.role_in_org) is type(expected)

    def test_create_organization(self, mocker: MockerFixture) -> None:
        client = self._client()
        body = {"org_id": "o1", "workos_organization_id": None, "name": "Acme", "is_personal": False, "role_in_org": "admin"}
        send = self._mock_send(mocker, client, _response(200, json_body=body))

        asyncio.run(client.create_organization("Acme"))

        sent = self._sent(send)
        assert sent.method == "POST"
        assert sent.url == f"{_BASE_URL}/v1/organizations"
        assert sent.body == {"name": "Acme"}

    def test_rename_organization(self, mocker: MockerFixture) -> None:
        client = self._client()
        body = {"org_id": "o1", "workos_organization_id": None, "name": "Beta", "is_personal": False, "role_in_org": "member"}
        send = self._mock_send(mocker, client, _response(200, json_body=body))

        asyncio.run(client.rename_organization("o1", "Beta"))

        sent = self._sent(send)
        assert sent.method == "PATCH"
        assert sent.url == f"{_BASE_URL}/v1/organizations/o1"
        assert sent.body == {"name": "Beta"}

    # ── Billing ───────────────────────────────────────────────────────

    def test_get_subscription(self, mocker: MockerFixture) -> None:
        client = self._client()
        sub = {"plan": "pro", "status": "active", "can_use_service": True}
        send = self._mock_send(mocker, client, _response(200, json_body=sub))

        result = asyncio.run(client.get_subscription())

        assert self._sent(send).url == f"{_BASE_URL}/v1/billing/subscription"
        assert result.plan == "pro"
        assert result.can_use_service is True

    def test_list_plans_and_invoices_paths(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body=[]))

        asyncio.run(client.list_plans())
        assert self._sent(send).url == f"{_BASE_URL}/v1/billing/plans"

        send.reset_mock()
        asyncio.run(client.list_invoices())
        assert self._sent(send).url == f"{_BASE_URL}/v1/billing/invoices"

    def test_create_checkout(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"checkout_url": "https://stripe"}))

        result = asyncio.run(client.create_checkout("pro"))

        sent = self._sent(send)
        assert sent.method == "POST"
        assert sent.url == f"{_BASE_URL}/v1/billing/checkout"
        assert sent.body == {"plan": "pro"}
        assert result.checkout_url == "https://stripe"

    def test_change_plan_409_conflict_surfaces_code(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(409, json_body={"code": "conflict", "message": "No subscription to change."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.change_plan("pro"))

        err = exc_info.value
        assert err.status == 409
        assert err.code == "conflict"
        assert err.server_message == "No subscription to change."

    def test_billing_portal_409_conflict_surfaces_code(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(409, json_body={"code": "conflict"}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.get_billing_portal())

        assert exc_info.value.code == "conflict"

    # ── Pipelex API keys ─────────────────────────────────────────────

    def test_list_pipelex_api_keys(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"keys": []}))

        result = asyncio.run(client.list_pipelex_api_keys())

        assert self._sent(send).url == f"{_BASE_URL}/v1/pipelex-api-keys"
        assert result.keys == []

    def test_create_pipelex_api_key_returns_once_only_plaintext(self, mocker: MockerFixture) -> None:
        client = self._client()
        created = {"api_key": "plx_sk_secret", "id": "k1", "label": "L", "prefix": "plx_sk", "created_at": "t"}
        send = self._mock_send(mocker, client, _response(201, json_body=created))

        result = asyncio.run(client.create_pipelex_api_key("L"))

        sent = self._sent(send)
        assert sent.method == "POST"
        assert sent.body == {"label": "L"}
        assert result.api_key == "plx_sk_secret"

    def test_create_pipelex_api_key_409_limit_surfaces_code(self, mocker: MockerFixture) -> None:
        client = self._client()
        self._mock_send(mocker, client, _response(409, json_body={"code": "pipelex_api_key_limit_reached", "message": "Limit reached."}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(client.create_pipelex_api_key("L"))

        assert exc_info.value.code == "pipelex_api_key_limit_reached"

    def test_revoke_pipelex_api_key_encodes_id(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(204))

        asyncio.run(client.revoke_pipelex_api_key("a/b"))

        sent = self._sent(send)
        assert sent.method == "DELETE"
        assert sent.url == f"{_BASE_URL}/v1/pipelex-api-keys/a%2Fb"

    def test_rotate_pipelex_api_key_sends_no_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        created = {"api_key": "plx_sk_new", "id": "k1", "label": "L", "prefix": "plx_sk", "created_at": "t"}
        send = self._mock_send(mocker, client, _response(200, json_body=created))

        asyncio.run(client.rotate_pipelex_api_key("k1"))

        sent = self._sent(send)
        assert sent.url == f"{_BASE_URL}/v1/pipelex-api-keys/k1/rotate"
        assert sent.method == "POST"
        assert sent.body is None

    # ── Onboarding ───────────────────────────────────────────────────

    def test_submit_onboarding_drops_absent_optionals(self, mocker: MockerFixture) -> None:
        client = self._client()
        submission = OnboardingSubmission(
            role=OnboardingRole.DEVELOPER,
            use_case="automate document review for the team",
            process_to_transform="manual review",
            input_types=[OnboardingInputType.DOCUMENTS],
            material_domain="legal",
            current_tool=OnboardingCurrentTool.NONE,
            heard_from=OnboardingHeardFrom.TWITTER,
        )
        send = self._mock_send(mocker, client, _response(204))

        result = asyncio.run(client.submit_onboarding(submission))

        sent = self._sent(send)
        assert result is None
        assert sent.method == "POST"
        assert sent.url == f"{_BASE_URL}/v1/onboarding/submit"
        assert sent.body == {
            "role": "developer",
            "use_case": "automate document review for the team",
            "process_to_transform": "manual review",
            "input_types": ["documents"],
            "material_domain": "legal",
            "current_tool": "none",
            "heard_from": "twitter",
        }

    # ── Storage ──────────────────────────────────────────────────────

    def test_resolve_storage_url(self, mocker: MockerFixture) -> None:
        client = self._client()
        resolved = {"url": "https://s3", "expires_at": "t", "content_type": "application/pdf"}
        send = self._mock_send(mocker, client, _response(200, json_body=resolved))

        result = asyncio.run(client.resolve_storage_url("s3://bucket/key"))

        sent = self._sent(send)
        assert sent.url == f"{_BASE_URL}/v1/resolve-storage-url"
        assert sent.body == {"uri": "s3://bucket/key"}
        assert result.url == "https://s3"
        assert result.content_type == "application/pdf"

    def test_upload_base64_payload(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"uri": "s3://x", "filename": "f.pdf"}))

        result = asyncio.run(client.upload(UploadInput(filename="f.pdf", data="Zm9v", content_type="application/pdf")))

        sent = self._sent(send)
        assert sent.url == f"{_BASE_URL}/v1/upload"
        assert sent.body == {"filename": "f.pdf", "data": "Zm9v", "content_type": "application/pdf"}
        assert result.uri == "s3://x"

    # ── Runs list / update ───────────────────────────────────────────

    def test_list_runs_encodes_query_value(self, mocker: MockerFixture) -> None:
        client = self._client()
        page = {
            "items": [{"pipeline_run_id": "r1", "method_id": "m/1", "pipe_code": "p", "status": "RUNNING", "created_at": "t"}],
            "next_cursor": "c1",
        }
        send = self._mock_send(mocker, client, _response(200, json_body=page))

        result = asyncio.run(client.list_runs("m/1"))

        assert self._sent(send).url == f"{_BASE_URL}/v1/runs?method_id=m%2F1"
        assert result.next_cursor == "c1"
        assert result.items[0].pipeline_run_id == "r1"
        assert result.items[0].status is RunStatus.RUNNING

    def test_list_runs_keeps_date_bounds_and_paging_params_on_presence(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(client.list_runs("m1", created_from="2026-08-01T00:00:00+00:00", created_to="", limit=10, cursor="c1"))

        # Instants are percent-encoded; an explicit empty bound is forwarded, not dropped.
        assert self._sent(send).url == (
            f"{_BASE_URL}/v1/runs?method_id=m1&created_from=2026-08-01T00%3A00%3A00%2B00%3A00&created_to=&limit=10&cursor=c1"
        )

    def test_list_runs_sends_created_by_and_each_status_as_a_repeated_parameter(self, mocker: MockerFixture) -> None:
        """The method screen's read: the caller's own latest unfinished run."""
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(
            client.list_runs(
                "m1",
                created_by="me",
                status=[RunStatus.PENDING, RunStatus.STARTED, RunStatus.RUNNING],
                limit=1,
            )
        )

        assert self._sent(send).url == f"{_BASE_URL}/v1/runs?method_id=m1&created_by=me&status=PENDING&status=STARTED&status=RUNNING&limit=1"

    def test_list_runs_sends_the_statuses_deduplicated_in_the_enum_order(self, mocker: MockerFixture) -> None:
        """The same filter always builds the same query, the one `@pipelex/sdk` builds; a plain string is a status too."""
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(client.list_runs("m1", status=[RunStatus.FAILED, cast("RunStatus", "PENDING"), RunStatus.FAILED]))

        assert self._sent(send).url == f"{_BASE_URL}/v1/runs?method_id=m1&status=PENDING&status=FAILED"

    def test_list_runs_omits_the_filters_when_absent(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        asyncio.run(client.list_runs("m1"))

        assert self._sent(send).url == f"{_BASE_URL}/v1/runs?method_id=m1"

    @pytest.mark.parametrize(
        ("status", "message"),
        [
            ([], "must name one or more"),
            ((), "must name one or more"),
            ([RunStatus.RUNNING, cast("RunStatus", "running")], "Unknown run status"),
        ],
    )
    def test_list_runs_refuses_an_empty_or_unknown_status_before_any_request(
        self, mocker: MockerFixture, status: list[RunStatus] | tuple[RunStatus, ...], message: str
    ) -> None:
        """Sending no `status=` at all would list every status, and an unknown one is the platform's `422`."""
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        with pytest.raises(RequestArgumentError, match=message):
            asyncio.run(client.list_runs("m1", status=status))

        send.assert_not_called()

    def test_list_runs_refuses_a_bare_string_status(self, mocker: MockerFixture) -> None:
        """Read as a sequence, `"RUNNING"` would name its characters."""
        client = self._client()
        send = self._mock_send(mocker, client, _response(200, json_body={"items": [], "next_cursor": None}))

        with pytest.raises(TypeError, match="list or tuple"):
            asyncio.run(client.list_runs("m1", status=cast("list[RunStatus]", RunStatus.RUNNING)))

        send.assert_not_called()

    def test_run_row_parses_the_history_fields_with_a_null_pipe_code(self, mocker: MockerFixture) -> None:
        """A history row is exactly the history fields; a `main_pipe` run names no pipe."""
        client = self._client()
        row = {
            "pipeline_run_id": "r1",
            "pipe_code": None,
            "status": "FAILED",
            "created_at": "2026-10-01T10:00:00Z",
            "finished_at": "2026-10-01T10:00:05Z",
            "error": {"message": "boom", "error_type": "PipeExecutionError"},
        }
        self._mock_send(mocker, client, _response(200, json_body={"items": [row], "next_cursor": None}))

        result = asyncio.run(client.list_runs("m1"))

        pipeline_run = result.items[0]
        assert isinstance(pipeline_run, RunHistoryItem)
        assert set(RunHistoryItem.model_fields) == {
            "pipeline_run_id",
            "status",
            "created_at",
            "finished_at",
            "pipe_code",
            "error",
            "method_version",
            "source_digest",
        }
        assert pipeline_run.pipeline_run_id == "r1"
        assert pipeline_run.status == RunStatus.FAILED
        assert pipeline_run.created_at == "2026-10-01T10:00:00Z"
        assert pipeline_run.finished_at == "2026-10-01T10:00:05Z"
        assert pipeline_run.pipe_code is None
        assert pipeline_run.model_extra == {}
        assert pipeline_run.error is not None
        assert pipeline_run.error.message == "boom"
        assert pipeline_run.error.error_type == "PipeExecutionError"

    def test_get_run_detail_encodes_id_and_returns_what_ran(self, mocker: MockerFixture) -> None:
        """The detail read is the only one carrying `mthds_contents` and `inputs`."""
        client = self._client()
        body = {
            "pipeline_run_id": "r/1",
            "method_id": "m1",
            "pipe_code": "p",
            "status": "COMPLETED",
            "created_at": "t",
            "mthds_contents": ["domain = 'x'"],
            "inputs": {"topic": "quantum"},
            "request_id": "req_r1",
        }
        send = self._mock_send(mocker, client, _response(200, json_body=body))

        detail = asyncio.run(client.get_run_detail("r/1"))

        assert self._sent(send).url == f"{_BASE_URL}/v1/runs/r%2F1"
        assert detail.mthds_contents == ["domain = 'x'"]
        assert detail.inputs == {"topic": "quantum"}
        assert detail.request_id == "req_r1"
        assert detail.status is RunStatus.COMPLETED
        assert detail.model_extra == {}

    def test_update_run_drops_absent_finished_at_and_tolerates_empty_body(self, mocker: MockerFixture) -> None:
        client = self._client()
        send = self._mock_send(mocker, client, _response(204))

        result = asyncio.run(client.update_run("r1", UpdateRunInput(status="COMPLETED", result_url="https://x")))

        sent = self._sent(send)
        assert result is None
        assert sent.method == "PUT"
        assert sent.url == f"{_BASE_URL}/v1/runs/r1"
        assert sent.body == {"status": "COMPLETED", "result_url": "https://x"}
