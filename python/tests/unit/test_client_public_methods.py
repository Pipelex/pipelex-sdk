"""Tests for public methods and the template catalog — `list_method_templates` and its iterator, `list_method_categories`,
another organization's public method read in its narrower shape, a version read without its publisher, the visibility
and categories a method carries, a copy naming the version it took, and the refusals of a public method's publish.

The twin of `pipelex-sdk-js/tests/public-methods.test.ts`. `_send` is mocked; the bodies are the platform's own
serialized shapes (`PublicMethodBodies`), so Pydantic's validation on the way back is part of what runs.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, cast

import pytest
from pydantic import ValidationError

from pipelex_sdk.errors import ApiResponseError
from pipelex_sdk.product_models import (
    MethodCategory,
    MethodCategoryList,
    MethodCopied,
    MethodCopiedFrom,
    MethodDetail,
    MethodPublishRefusalReason,
    MethodPublishRefused,
    MethodTemplatePage,
    MethodThumbnail,
    MethodVersion,
    MethodVisibility,
    PublicMethodDetail,
)
from tests.unit.conftest import BASE_URL, problem_document
from tests.unit.test_data import PublicMethodBodies

if TYPE_CHECKING:
    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import ResponseBuilder, SendPatcher


def _sent_urls(send: MockType) -> list[str]:
    return [cast("str", call.args[1]) for call in send.call_args_list]


class TestClientPublicMethods:
    # ----- list_method_templates ---------------------------------------------------------------

    def test_list_method_templates_gets_the_catalog_with_no_query_and_reads_the_page_whole(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=PublicMethodBodies.PAGE))

        page = asyncio.run(api_client.list_method_templates())

        assert _sent_urls(send) == [f"{BASE_URL}/v1/method-templates"]
        assert isinstance(page, MethodTemplatePage)
        assert page.ordering == "default"
        assert page.next_cursor is None
        assert page.categories == [MethodCategory.model_validate(category) for category in PublicMethodBodies.CATEGORIES]
        assert page.categories[1].labels == {"en": "Human resources", "fr": "Ressources humaines"}
        template = page.items[0]
        assert (template.method_id, template.name, template.latest_version) == ("mt_cv01", "CV Analyzer", 1)
        assert template.categories == ["human-resources"]
        assert template.organization_name == "Dev Templates"
        thumbnail = template.thumbnails[0]
        assert (thumbnail.width, thumbnail.height, thumbnail.media_type) == (1600, 800, "image/png")
        assert PublicMethodBodies.SIGNED in thumbnail.url
        assert PublicMethodBodies.SIGNED not in repr(thumbnail)

    def test_list_method_templates_sends_the_ordering_the_category_the_limit_and_the_cursor(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body={**PublicMethodBodies.PAGE, "next_cursor": "c/2"}))

        page = asyncio.run(api_client.list_method_templates(ordering="home-test-b", category="human-resources", limit=8, cursor="c/1"))

        assert _sent_urls(send) == [f"{BASE_URL}/v1/method-templates?ordering=home-test-b&category=human-resources&limit=8&cursor=c%2F1"]
        assert page.next_cursor == "c/2"

    def test_list_method_templates_reads_a_catalog_with_no_ordering(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"items": [], "next_cursor": None, "ordering": None, "categories": []}))

        page = asyncio.run(api_client.list_method_templates())

        assert page.ordering is None
        assert page.items == []
        assert page.categories == []

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({**PublicMethodBodies.PAGE, "items": {}}, id="items-not-a-list"),
            pytest.param({key: value for key, value in PublicMethodBodies.PAGE.items() if key != "ordering"}, id="no-ordering"),
            pytest.param({**PublicMethodBodies.PAGE, "categories": None}, id="categories-not-a-list"),
            pytest.param({**PublicMethodBodies.PAGE, "items": [{**PublicMethodBodies.TEMPLATE, "latest_version": "1"}]}, id="version-not-an-integer"),
            pytest.param({**PublicMethodBodies.PAGE, "categories": [{"slug": "finance", "label": "Finance"}]}, id="category-without-labels"),
        ],
    )
    def test_list_method_templates_refuses_a_page_it_cannot_read_and_hides_every_link(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_templates())

        unreadable = exc_info.value
        assert str(unreadable) == "API GET /v1/method-templates answered 200 with a body that is not the answer the route returns"
        assert PublicMethodBodies.SIGNED not in (unreadable.response_body or "")
        assert "deadbeef" not in str(unreadable.__cause__)
        assert unreadable.problem.code == "client.response_unreadable"

    def test_list_method_templates_raises_the_platforms_refusal_of_a_limit_out_of_range(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(422, json_body=problem_document("request.invalid", 422, detail="limit must be at most 200")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_templates(limit=500))

        assert exc_info.value.problem.code == "request.invalid"

    def test_iterate_method_templates_follows_the_cursor_with_the_same_ordering_and_category(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        second = {**PublicMethodBodies.TEMPLATE, "method_id": "mt_invoice01", "name": "Invoice Extraction"}
        send = patch_send(
            api_client,
            wire_response(200, json_body={**PublicMethodBodies.PAGE, "next_cursor": "c1"}),
            wire_response(200, json_body={**PublicMethodBodies.PAGE, "items": [second]}),
        )

        async def _collect() -> list[str]:
            return [template.method_id async for template in api_client.iterate_method_templates(ordering="default", category="finance", limit=1)]

        seen = asyncio.run(_collect())

        assert seen == ["mt_cv01", "mt_invoice01"]
        assert _sent_urls(send) == [
            f"{BASE_URL}/v1/method-templates?ordering=default&category=finance&limit=1",
            f"{BASE_URL}/v1/method-templates?ordering=default&category=finance&limit=1&cursor=c1",
        ]

    # ----- list_method_categories --------------------------------------------------------------

    def test_list_method_categories_gets_the_whole_list_and_reads_it_in_its_order(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=PublicMethodBodies.CATEGORY_LIST))

        category_list = asyncio.run(api_client.list_method_categories())

        assert _sent_urls(send) == [f"{BASE_URL}/v1/method-categories"]
        assert isinstance(category_list, MethodCategoryList)
        assert [category.slug for category in category_list.categories] == ["legal", "finance", "human-resources", "product"]
        assert category_list.categories == [MethodCategory.model_validate(category) for category in PublicMethodBodies.CATEGORY_LIST["categories"]]
        legal = category_list.categories[0]
        assert (legal.label, legal.labels) == ("Legal", {"en": "Legal", "fr": "Juridique"})

    def test_list_method_categories_reads_a_category_lacking_a_language_which_a_client_shows_in_english(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=PublicMethodBodies.CATEGORY_LIST))

        category_list = asyncio.run(api_client.list_method_categories())

        product = category_list.categories[-1]
        assert product.labels == {"en": "Product"}
        assert product.labels.get("fr", product.label) == "Product"

    def test_list_method_categories_reads_an_empty_list(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={"categories": []}))

        category_list = asyncio.run(api_client.list_method_categories())

        assert category_list.categories == []

    @pytest.mark.parametrize(
        "body",
        [
            pytest.param({}, id="no-categories"),
            pytest.param({"categories": {}}, id="categories-not-a-list"),
            pytest.param({"categories": ["finance"]}, id="category-not-an-object"),
            pytest.param({"categories": [{"slug": "finance", "labels": {"en": "Finance"}}]}, id="category-without-label"),
            pytest.param({"categories": [{"slug": "finance", "label": "Finance"}]}, id="category-without-labels"),
            pytest.param({"categories": [{"slug": "finance", "label": "Finance", "labels": ["Finance"]}]}, id="labels-not-an-object"),
            pytest.param({"categories": [{"slug": "sales", "label": "Sales", "labels": {"en": "Sales", "fr": None}}]}, id="label-not-a-string"),
        ],
    )
    def test_list_method_categories_refuses_a_list_it_cannot_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, body: dict[str, Any]
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_categories())

        unreadable = exc_info.value
        assert str(unreadable) == "API GET /v1/method-categories answered 200 with a body that is not the answer the route returns"
        assert unreadable.problem.code == "client.response_unreadable"

    def test_list_method_categories_raises_the_platforms_refusal_of_a_caller_with_no_active_organization(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(403, json_body=problem_document("pipelex.org.required", 403, detail="Select an organization first")))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.list_method_categories())

        assert exc_info.value.problem.code == "pipelex.org.required"
        assert exc_info.value.status == 403

    # ----- another organization's public method ------------------------------------------------

    def test_get_method_reads_another_organizations_public_method_in_the_narrower_shape(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=PublicMethodBodies.PUBLIC_METHOD))

        method = asyncio.run(api_client.get_method("mt_stats01"))

        assert isinstance(method, PublicMethodDetail)
        assert method.org_id == "org_owner"
        assert method.latest_version == 2
        assert method.latest_published.published_by is None
        assert method.latest_published.thumbnails == [MethodThumbnail.model_validate(PublicMethodBodies.THUMBNAIL)]
        assert method.categories == ["general", "marketing"]
        assert method.visibility == MethodVisibility.PUBLIC
        assert [saved_file.path for saved_file in method.files] == ["main.mthds"]

    def test_get_method_reads_the_callers_own_method_whole_with_its_visibility_and_categories(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=PublicMethodBodies.OWN_METHOD))

        method = asyncio.run(api_client.get_method("mt_stats01"))

        assert isinstance(method, MethodDetail)
        assert method.updated_at == PublicMethodBodies.TOKEN
        assert method.visibility == MethodVisibility.PUBLIC
        assert method.categories == ["general", "marketing"]
        assert method.latest_published is not None
        assert method.latest_published.published_by == "user_owner"

    def test_a_method_read_without_visibility_reads_internal_and_keeps_a_later_value_raw(self) -> None:
        bare = {key: value for key, value in PublicMethodBodies.OWN_METHOD.items() if key not in {"visibility", "categories"}}

        absent = MethodDetail.model_validate(bare)
        later = MethodDetail.model_validate({**bare, "visibility": "private"})

        assert absent.visibility == MethodVisibility.INTERNAL
        assert absent.categories == []
        assert later.visibility == "private"
        assert not isinstance(later.visibility, MethodVisibility)

    def test_a_public_read_lacking_a_published_version_is_an_answer_the_sdk_cannot_read(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={**PublicMethodBodies.PUBLIC_METHOD, "latest_published": None}))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method("mt_stats01"))

        assert exc_info.value.problem.code == "client.response_unreadable"
        assert PublicMethodBodies.SIGNED not in (exc_info.value.response_body or "")

    def test_an_owners_read_that_lost_its_token_is_refused_rather_than_read_as_public(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        """An answer without `updated_at` that still carries an owner-only member is a damaged owner read."""
        body = {key: value for key, value in PublicMethodBodies.OWN_METHOD.items() if key != "updated_at"}
        patch_send(api_client, wire_response(200, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_method("mt_stats01"))

        unreadable = exc_info.value
        assert unreadable.problem.code == "client.response_unreadable"
        assert isinstance(unreadable.__cause__, ValidationError)
        assert [failure["loc"] for failure in unreadable.__cause__.errors()] == [("updated_at",)]
        assert PublicMethodBodies.SIGNED not in (unreadable.response_body or "")

    def test_versions_of_a_public_method_list_and_read_without_their_publisher(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        older = {**PublicMethodBodies.PUBLIC_SUMMARY, "version": 1}
        send = patch_send(
            api_client,
            wire_response(200, json_body={"items": [PublicMethodBodies.PUBLIC_SUMMARY, older], "next_cursor": None}),
            wire_response(200, json_body={**PublicMethodBodies.PUBLIC_SUMMARY, "method_id": "mt_stats01", "files": PublicMethodBodies.FILES}),
        )

        page = asyncio.run(api_client.list_method_versions("mt_stats01"))
        version = asyncio.run(api_client.get_method_version("mt_stats01", 2))

        assert [summary.version for summary in page.items] == [2, 1]
        assert all(summary.published_by is None for summary in page.items)
        assert isinstance(version, MethodVersion)
        assert version.published_by is None
        assert version.categories == ["general", "marketing"]
        assert _sent_urls(send) == [f"{BASE_URL}/v1/methods/mt_stats01/versions", f"{BASE_URL}/v1/methods/mt_stats01/versions/2"]

    def test_a_copy_of_a_public_method_names_the_version_it_took(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        copy = {
            **{key: value for key, value in PublicMethodBodies.OWN_METHOD.items() if key != "files"},
            "method_id": "mt_copy01",
            "org_id": "org_reader",
            "created_by_user_id": "user_reader",
            "input_data": None,
            "latest_version": None,
            "latest_published": None,
            "visibility": "internal",
            "copied_from": PublicMethodBodies.COPIED_FROM_VERSION,
        }
        send = patch_send(
            api_client, wire_response(200, json_body={"outcome": "copied", "method": copy, "examples_copied": 1, "stored_files_copied": 0})
        )

        result = asyncio.run(api_client.copy_method("mt_stats01", destination_org_id="org_reader"))

        assert isinstance(result, MethodCopied)
        assert result.method.copied_from == MethodCopiedFrom.model_validate(PublicMethodBodies.COPIED_FROM_VERSION)
        assert result.method.copied_from is not None
        assert result.method.copied_from.version == 2
        assert result.method.copied_from.draft_digest is None
        assert "expected_draft_updated_at" not in cast("bytes", send.call_args.kwargs["content"]).decode()

    # ----- a public method's publish refusals --------------------------------------------------

    @pytest.mark.parametrize(
        ("reason", "member"),
        [
            pytest.param("thumbnail_missing", MethodPublishRefusalReason.THUMBNAIL_MISSING, id="thumbnail-missing"),
            pytest.param("thumbnail_invalid", MethodPublishRefusalReason.THUMBNAIL_INVALID, id="thumbnail-invalid"),
            pytest.param("storage_reference", MethodPublishRefusalReason.STORAGE_REFERENCE, id="storage-reference"),
        ],
    )
    def test_publish_method_answers_a_public_methods_refusal_as_a_verdict(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        reason: str,
        member: MethodPublishRefusalReason,
    ) -> None:
        body = {
            "outcome": "refused",
            "reason": reason,
            "message": "The method is public, and its publish was refused, so it was not published.",
            "validation": PublicMethodBodies.VALID_VERDICT,
            "method": PublicMethodBodies.OWN_METHOD,
        }
        patch_send(api_client, wire_response(200, json_body=body))

        result = asyncio.run(api_client.publish_method("mt_stats01", expected_draft_updated_at=PublicMethodBodies.TOKEN))

        assert isinstance(result, MethodPublishRefused)
        assert result.reason == member
        assert isinstance(result.reason, MethodPublishRefusalReason)
        assert "public" in result.message

    def test_publish_method_keeps_a_reason_it_does_not_know_as_its_raw_string_still_a_verdict(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {
            "outcome": "refused",
            "reason": "a_later_reason",
            "message": "Refused for a reason a later platform added.",
            "validation": PublicMethodBodies.VALID_VERDICT,
            "method": PublicMethodBodies.OWN_METHOD,
        }
        patch_send(api_client, wire_response(200, json_body=body))

        result = asyncio.run(api_client.publish_method("mt_stats01", expected_draft_updated_at=PublicMethodBodies.TOKEN))

        assert isinstance(result, MethodPublishRefused)
        assert result.reason == "a_later_reason"
        assert not isinstance(result.reason, MethodPublishRefusalReason)
        assert result.message == "Refused for a reason a later platform added."
