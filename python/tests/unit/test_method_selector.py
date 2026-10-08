"""Tests for `parse_method_selector` — a catalog id with its optional version suffix, split locally.

The twin of `pipelex-sdk-js/tests/method-selector.test.ts`: the same selectors split the same way, and the
same malformed suffixes are refused before anything is sent, as the platform refuses them with a `422`.
"""

import pytest
from mthds.protocol.exceptions import PipelineRequestError
from pydantic import ValidationError

from pipelex_sdk.method_selector import ParsedMethodSelector, parse_method_selector


class TestMethodSelector:
    @pytest.mark.parametrize(
        ("selector", "method_id", "version"),
        [
            ("mt_abc", "mt_abc", None),
            ("mt_abc@3", "mt_abc", 3),
            ("mt_abc@10", "mt_abc", 10),
            ("mt_abc@draft", "mt_abc", "draft"),
            ("mt_0b9f5e1c-2d3a-4f6b-8c7d-9e0a1b2c3d4e@12", "mt_0b9f5e1c-2d3a-4f6b-8c7d-9e0a1b2c3d4e", 12),
            ("mt_a_b-c@9007199254740993", "mt_a_b-c", 9007199254740993),
        ],
    )
    def test_splits_a_selector_into_its_bare_id_and_version(self, selector: str, method_id: str, version: int | str | None) -> None:
        assert parse_method_selector(selector) == ParsedMethodSelector(method_id=method_id, version=version)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]

    @pytest.mark.parametrize(
        "selector",
        [
            pytest.param("mt_abc@", id="empty-suffix"),
            pytest.param("mt_abc@0", id="version-zero"),
            pytest.param("mt_abc@03", id="leading-zero"),
            pytest.param("mt_abc@+3", id="sign"),
            pytest.param("mt_abc@-3", id="negative"),
            pytest.param("mt_abc@1.5", id="decimal"),
            pytest.param("mt_abc@latest", id="other-word"),
            pytest.param("mt_abc@Draft", id="draft-in-another-case"),
            pytest.param("mt_abc@3@4", id="two-suffixes"),
            pytest.param("mt_abc@ 3", id="space"),
            pytest.param("mt_abc@٣", id="non-ascii-digit"),
        ],
    )
    def test_refuses_a_malformed_suffix_saying_what_a_suffix_may_be(self, selector: str) -> None:
        with pytest.raises(PipelineRequestError, match=r"names no version: the suffix of a catalog id is @<version>"):
            parse_method_selector(selector)

    @pytest.mark.parametrize(
        "selector",
        [
            pytest.param("abc@3", id="no-catalog-prefix"),
            pytest.param("mt_@3", id="empty-id"),
            pytest.param("mt_", id="bare-prefix"),
            pytest.param("mt_a.b", id="dot"),
            pytest.param("mt_a/b", id="path"),
            pytest.param("mt_été", id="non-ascii-letter"),
            pytest.param("", id="empty"),
        ],
    )
    def test_refuses_a_value_that_is_no_catalog_id(self, selector: str) -> None:
        with pytest.raises(PipelineRequestError, match=r"a catalog id is mt_ followed by"):
            parse_method_selector(selector)

    def test_quotes_the_refused_selector(self) -> None:
        with pytest.raises(PipelineRequestError) as exc_info:
            parse_method_selector("mt_abc@v3")

        assert str(exc_info.value) == (
            '"mt_abc@v3" names no version: the suffix of a catalog id is @<version>, a positive number without a leading zero, or @draft.'
        )

    def test_refuses_a_version_past_the_integer_conversion_limit(self) -> None:
        with pytest.raises(PipelineRequestError, match="too long to read"):
            parse_method_selector("mt_abc@" + "9" * 5000)

    def test_the_parsed_selector_is_frozen(self) -> None:
        parsed = parse_method_selector("mt_abc@3")

        with pytest.raises(ValidationError):
            parsed.version = 4  # type: ignore[misc]  # pyright: ignore[reportAttributeAccessIssue]
