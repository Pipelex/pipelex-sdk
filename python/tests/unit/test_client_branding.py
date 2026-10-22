"""Tests for an organization's branding — `get_branding` (`GET /v1/branding`) and `update_organization_branding`
(`PATCH /v1/organizations/{org_id}/branding`).

The twin of `pipelex-sdk-js/tests/branding.test.ts`. `_send` is mocked; the bodies are the platform's own
`BrandingResponse` and problem documents (`BrandingBodies`), so Pydantic's validation on the way back is part
of what runs.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any, cast

import pytest
from pydantic import ValidationError

from pipelex_sdk.errors import ApiResponseError, LogoRefusalCode
from pipelex_sdk.product_models import BrandingColorsUpdate, OrganizationBranding, OrganizationBrandingUpdate
from tests.unit.conftest import BASE_URL
from tests.unit.test_data import BrandingBodies

if TYPE_CHECKING:
    from pytest_mock import MockType

    from pipelex_sdk.client import PipelexAPIClient
    from tests.unit.conftest import ResponseBuilder, SendPatcher

_ORG_ID = BrandingBodies.ORG_ID
_BRANDING_URL = f"{BASE_URL}/v1/organizations/{_ORG_ID}/branding"


def _sent_method(send: MockType) -> str:
    return cast("str", send.call_args.args[0])


def _sent_url(send: MockType) -> str:
    return cast("str", send.call_args.args[1])


def _sent_body(send: MockType) -> Any:
    content = send.call_args.kwargs["content"]
    return None if content is None else json.loads(content)


def _problem(*, code: str, title: str, detail: str, errors: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """The platform's problem document for `code`, as its error handler renders one."""
    body: dict[str, Any] = {"type": f"https://pipelex.com/errors/{code}", "title": title, "code": code, "detail": detail}
    if errors is not None:
        body["errors"] = errors
    return body


class TestClientBranding:
    # ----- get_branding ------------------------------------------------------------------------

    def test_get_branding_reads_the_platform_shape(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=BrandingBodies.BRANDED))

        branding = asyncio.run(api_client.get_branding())

        assert _sent_method(send) == "GET"
        assert _sent_url(send) == f"{BASE_URL}/v1/branding"
        assert _sent_body(send) is None
        assert isinstance(branding, OrganizationBranding)
        assert branding.org_id == _ORG_ID
        assert branding.org_name == "Acme Corp"
        assert branding.colors.action == "#14213d"
        assert branding.colors.accent == "#fca311"
        assert branding.colors.header is None
        assert branding.dark_colors.action is None
        assert branding.dark_colors.header == "#e5e5e5"
        assert branding.square_logo is not None
        assert branding.square_logo.uri == BrandingBodies.SQUARE_LOGO_URI
        assert branding.square_logo.content_type == "image/png"
        assert branding.square_logo.width == pytest.approx(512.0)
        assert branding.wide_logo is None
        assert branding.model_dump(mode="json") == BrandingBodies.BRANDED

    def test_get_branding_reads_no_branding_as_every_value_none(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=BrandingBodies.UNBRANDED))

        branding = asyncio.run(api_client.get_branding())

        assert branding.model_dump(mode="json") == BrandingBodies.UNBRANDED

    def test_get_branding_keeps_an_svg_logo_fractional_size(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={**BrandingBodies.UNBRANDED, "wide_logo": BrandingBodies.WIDE_SVG_LOGO}))

        branding = asyncio.run(api_client.get_branding())

        assert branding.wide_logo is not None
        assert branding.wide_logo.content_type == "image/svg+xml"
        assert branding.wide_logo.width == pytest.approx(240.5)
        assert branding.wide_logo.height == pytest.approx(64.25)

    def test_get_branding_keeps_a_field_this_sdk_does_not_name(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(200, json_body={**BrandingBodies.BRANDED, "favicon": None}))

        branding = asyncio.run(api_client.get_branding())

        assert branding.model_dump(mode="json")["favicon"] is None

    @pytest.mark.parametrize(
        "answer",
        [
            pytest.param(None, id="empty"),
            pytest.param({"org_id": _ORG_ID}, id="no-colours"),
            pytest.param({**BrandingBodies.BRANDED, "colors": {"action": "#14213d"}}, id="a-colour-key-missing"),
        ],
    )
    def test_get_branding_refuses_an_answer_that_is_not_the_branding(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher, answer: dict[str, Any] | None
    ) -> None:
        patch_send(api_client, wire_response(200, json_body=answer))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.get_branding())

        assert exc_info.value.status == 200

    # ----- update_organization_branding --------------------------------------------------------

    def test_update_patches_the_branding_route_and_reads_the_branding_as_written(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=BrandingBodies.BRANDED))
        update = OrganizationBrandingUpdate(
            colors=BrandingColorsUpdate(action="#14213D", accent="#fca311"),
            square_logo=BrandingBodies.SQUARE_UPLOAD_URI,
        )

        branding = asyncio.run(api_client.update_organization_branding(_ORG_ID, update))

        assert _sent_method(send) == "PATCH"
        assert _sent_url(send) == _BRANDING_URL
        assert _sent_body(send) == {"colors": {"action": "#14213D", "accent": "#fca311"}, "square_logo": BrandingBodies.SQUARE_UPLOAD_URI}
        assert branding.model_dump(mode="json") == BrandingBodies.BRANDED
        # The answer names the platform's copy of the logo, never the upload the write sent.
        assert branding.square_logo is not None
        assert branding.square_logo.uri == BrandingBodies.SQUARE_LOGO_URI

    def test_update_sends_a_logo_answered_uri_back_unchanged_to_keep_it(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=BrandingBodies.BRANDED), wire_response(200, json_body=BrandingBodies.BRANDED))
        read = asyncio.run(api_client.get_branding())
        assert read.square_logo is not None

        asyncio.run(api_client.update_organization_branding(_ORG_ID, OrganizationBrandingUpdate(square_logo=read.square_logo.uri)))

        assert _sent_body(send) == {"square_logo": BrandingBodies.SQUARE_LOGO_URI}

    def test_update_sends_an_explicit_none_and_leaves_out_what_is_unset(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=BrandingBodies.UNBRANDED))
        update = OrganizationBrandingUpdate(colors=BrandingColorsUpdate(header=None), dark_colors=None, wide_logo=None)

        asyncio.run(api_client.update_organization_branding(_ORG_ID, update))

        assert _sent_body(send) == {"colors": {"header": None}, "dark_colors": None, "wide_logo": None}

    def test_update_reads_an_update_from_a_dict_as_it_was_written(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=BrandingBodies.UNBRANDED))
        update = OrganizationBrandingUpdate.model_validate({"dark_colors": {"accent": None}, "square_logo": None})

        asyncio.run(api_client.update_organization_branding(_ORG_ID, update))

        assert _sent_body(send) == {"dark_colors": {"accent": None}, "square_logo": None}

    def test_an_empty_update_sends_an_empty_object(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        send = patch_send(api_client, wire_response(200, json_body=BrandingBodies.BRANDED))

        branding = asyncio.run(api_client.update_organization_branding(_ORG_ID, OrganizationBrandingUpdate()))

        assert _sent_body(send) == {}
        assert branding.org_name == "Acme Corp"

    @pytest.mark.parametrize(
        "payload",
        [
            pytest.param({"logo": "x"}, id="unknown-key"),
            pytest.param({"colors": {"primary": "#000000"}}, id="unknown-colour-role"),
        ],
    )
    def test_an_update_refuses_a_key_the_route_does_not_take(self, payload: dict[str, Any]) -> None:
        with pytest.raises(ValidationError):
            OrganizationBrandingUpdate.model_validate(payload)

    def test_logo_refusals_reach_the_caller_with_the_sentence_for_each_slot(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(422, json_body=BrandingBodies.LOGOS_REFUSED))
        update = OrganizationBrandingUpdate(square_logo=BrandingBodies.SQUARE_UPLOAD_URI, wide_logo=BrandingBodies.WIDE_UPLOAD_URI)

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.update_organization_branding(_ORG_ID, update))

        error = exc_info.value
        assert error.status == 422
        assert error.code == "validation_failed"
        assert error.error_domain == "input"
        assert error.retryable is False
        assert error.errors is not None
        assert [(entry.field, entry.code, entry.detail) for entry in error.errors] == [
            ("square_logo", LogoRefusalCode.TOO_SMALL, BrandingBodies.SQUARE_TOO_SMALL),
            ("wide_logo", LogoRefusalCode.TOO_SHORT, BrandingBodies.WIDE_TOO_SHORT),
        ]
        # What the settings screen does: one slot's sentences, read by the slot's key.
        under_square = [entry.detail for entry in error.errors if entry.field == "square_logo"]
        assert under_square == [BrandingBodies.SQUARE_TOO_SMALL]

    @pytest.mark.parametrize(
        ("field", "uri", "code", "detail"),
        [
            pytest.param(
                "wide_logo", BrandingBodies.WIDE_UPLOAD_URI, LogoRefusalCode.ACTIVE_CONTENT, BrandingBodies.ACTIVE_CONTENT, id="svg-active-content"
            ),
            pytest.param(
                "wide_logo", BrandingBodies.STRAY_BRANDING_URI, LogoRefusalCode.NOT_AN_UPLOAD, BrandingBodies.NOT_AN_UPLOAD, id="stray-branding-copy"
            ),
            # A logo cannot move between slots by its URI: the square logo's copy is refused in the wide slot.
            pytest.param(
                "wide_logo", BrandingBodies.SQUARE_LOGO_URI, LogoRefusalCode.NOT_AN_UPLOAD, BrandingBodies.NOT_AN_UPLOAD, id="other-slot-logo"
            ),
            pytest.param(
                "square_logo", BrandingBodies.SQUARE_UPLOAD_URI, LogoRefusalCode.UNREADABLE, BrandingBodies.PIXEL_CAP, id="raster-past-pixel-cap"
            ),
            pytest.param(
                "square_logo", BrandingBodies.SQUARE_UPLOAD_URI, LogoRefusalCode.UNREADABLE, BrandingBodies.CUT_SHORT, id="raster-cut-short"
            ),
            # A logo is a still image: an animated raster is refused as a type a logo may not be.
            pytest.param(
                "square_logo",
                BrandingBodies.SQUARE_UPLOAD_URI,
                LogoRefusalCode.TYPE_NOT_ACCEPTED,
                BrandingBodies.ANIMATED_WEBP,
                id="animated-webp",
            ),
            pytest.param(
                "wide_logo", BrandingBodies.WIDE_UPLOAD_URI, LogoRefusalCode.TYPE_NOT_ACCEPTED, BrandingBodies.ANIMATED_PNG, id="animated-png"
            ),
            pytest.param(
                "square_logo",
                BrandingBodies.SQUARE_UPLOAD_URI,
                LogoRefusalCode.UNREADABLE,
                BrandingBodies.SVG_SIDE_OUT_OF_RANGE,
                id="svg-side-out-of-range",
            ),
            pytest.param(
                "wide_logo",
                BrandingBodies.WIDE_UPLOAD_URI,
                LogoRefusalCode.UNREADABLE,
                BrandingBodies.SVG_VIEWBOX_OUT_OF_RANGE,
                id="svg-viewbox-out-of-range",
            ),
            *(
                pytest.param(field, uri, LogoRefusalCode.ACTIVE_CONTENT, detail, id=f"svg-{kind}")
                for kind, (field, uri, detail) in BrandingBodies.STYLE_ACTIVE_CONTENT.items()
            ),
        ],
    )
    def test_a_refused_logo_is_named_under_its_slot(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        field: str,
        uri: str,
        code: LogoRefusalCode,
        detail: str,
    ) -> None:
        errors = [{"field": field, "code": code, "detail": detail}]
        patch_send(
            api_client, wire_response(422, json_body=_problem(code="validation_failed", title="Validation failed", detail=detail, errors=errors))
        )

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.update_organization_branding(_ORG_ID, OrganizationBrandingUpdate.model_validate({field: uri})))

        assert exc_info.value.code == "validation_failed"
        assert exc_info.value.errors is not None
        assert [(entry.field, entry.code, entry.detail) for entry in exc_info.value.errors] == [(field, code, detail)]

    def test_a_refused_colour_is_named_by_its_dotted_key(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        patch_send(api_client, wire_response(422, json_body=BrandingBodies.COLOR_REFUSED))
        update = OrganizationBrandingUpdate(dark_colors=BrandingColorsUpdate(header="#14213g"))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.update_organization_branding(_ORG_ID, update))

        assert exc_info.value.code == "validation_failed"
        assert exc_info.value.errors is not None
        assert [(entry.field, entry.code) for entry in exc_info.value.errors] == [("dark_colors.header", "string_pattern_mismatch")]

    @pytest.mark.parametrize(
        ("status", "code", "title", "detail"),
        [
            pytest.param(
                400,
                "invalid_storage_uri",
                "Invalid storage URI",
                "The square logo is not a valid storage URI: Storage URI must start with pipelex-storage://",
                id="invalid-storage-uri",
            ),
            pytest.param(403, "forbidden", "Forbidden", "The square logo is a file of a different organization.", id="another-organization"),
        ],
    )
    def test_a_logo_uri_refused_before_any_read_names_its_slot(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        status: int,
        code: str,
        title: str,
        detail: str,
    ) -> None:
        errors = [{"field": "square_logo", "code": code, "detail": detail}]
        patch_send(api_client, wire_response(status, json_body=_problem(code=code, title=title, detail=detail, errors=errors)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.update_organization_branding(_ORG_ID, OrganizationBrandingUpdate(square_logo="https://example.com/logo.png")))

        assert exc_info.value.status == status
        assert exc_info.value.code == code
        assert exc_info.value.errors is not None
        assert [entry.model_dump(exclude_none=True) for entry in exc_info.value.errors] == errors

    @pytest.mark.parametrize(
        ("status", "code", "title", "detail"),
        [
            pytest.param(
                403,
                "role_not_permitted",
                "Role not permitted",
                "Your role in this organization is member: changing the organization's branding needs the admin role.",
                id="not-an-admin",
            ),
            pytest.param(
                409,
                "conflict",
                "Conflict",
                "A personal workspace has no branding: logos and colours belong to a team organization.",
                id="personal-workspace",
            ),
            pytest.param(404, "not_found", "Not found", "Organization not found", id="missing-organization"),
        ],
    )
    def test_a_write_the_platform_refuses_raises_with_its_code(
        self,
        api_client: PipelexAPIClient,
        wire_response: ResponseBuilder,
        patch_send: SendPatcher,
        status: int,
        code: str,
        title: str,
        detail: str,
    ) -> None:
        patch_send(api_client, wire_response(status, json_body=_problem(code=code, title=title, detail=detail)))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.update_organization_branding(_ORG_ID, OrganizationBrandingUpdate(colors=None)))

        assert exc_info.value.status == status
        assert exc_info.value.code == code
        assert exc_info.value.server_message == detail
        assert exc_info.value.errors is None

    def test_a_storage_failure_while_handling_a_logo_is_a_retryable_500(
        self, api_client: PipelexAPIClient, wire_response: ResponseBuilder, patch_send: SendPatcher
    ) -> None:
        body = {
            **_problem(code="storage_backend_failed", title="Storage backend failure", detail="Storage backend failure while storing a logo."),
            "error_domain": "runtime",
            "retryable": True,
        }
        patch_send(api_client, wire_response(500, json_body=body))

        with pytest.raises(ApiResponseError) as exc_info:
            asyncio.run(api_client.update_organization_branding(_ORG_ID, OrganizationBrandingUpdate(square_logo=BrandingBodies.SQUARE_UPLOAD_URI)))

        assert exc_info.value.status == 500
        assert exc_info.value.code == "storage_backend_failed"
        assert exc_info.value.error_domain == "runtime"
        assert exc_info.value.retryable is True
        assert exc_info.value.errors is None
