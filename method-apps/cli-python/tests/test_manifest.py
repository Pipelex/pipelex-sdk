"""`lib/manifest.py`: the one reader of `method.json`, for the codegen and for every run."""

import pytest

from pipelex_method_cli_python.lib.manifest import ManifestError, MethodSelector, parse_manifest, render_manifest

ORIGIN = "pkg/method/method.json"


class TestParseManifest:
    def test_reads_a_catalog_id(self):
        assert parse_manifest('{"method_id": "mt_abc"}', origin=ORIGIN) == MethodSelector(method_id="mt_abc")

    def test_reads_a_published_address_trimmed(self):
        selector = parse_manifest('{"method_ref": " github.com/owner/repo/pkg@v1.0.0 "}', origin=ORIGIN)
        assert selector == MethodSelector(method_ref="github.com/owner/repo/pkg@v1.0.0")

    def test_ignores_keys_it_does_not_read(self):
        assert parse_manifest('{"method_id": "mt_abc", "note": "x"}', origin=ORIGIN) == MethodSelector(method_id="mt_abc")

    @pytest.mark.parametrize(
        ("text", "says"),
        [
            pytest.param("{not json", "not valid JSON", id="not json"),
            pytest.param('["mt_abc"]', "must be a JSON object", id="not an object"),
            pytest.param("{}", "exactly one", id="neither"),
            pytest.param('{"method_id": "mt_abc", "method_ref": "github.com/o/r"}', "exactly one", id="both"),
            pytest.param('{"method_id": ""}', "non-empty string", id="blank"),
            pytest.param('{"method_ref": 3}', "non-empty string", id="not a string"),
        ],
    )
    def test_refuses_a_manifest_that_does_not_name_exactly_one_method(self, text: str, says: str):
        with pytest.raises(ManifestError, match=says) as caught:
            parse_manifest(text, origin=ORIGIN)
        assert caught.value.message.startswith(ORIGIN)


class TestRenderManifest:
    @pytest.mark.parametrize("selector", [MethodSelector(method_id="mt_abc"), MethodSelector(method_ref="github.com/o/r@v1")])
    def test_round_trips_through_the_reader(self, selector: MethodSelector):
        assert parse_manifest(render_manifest(selector), origin=ORIGIN) == selector

    def test_holds_the_selector_and_nothing_else(self):
        assert render_manifest(MethodSelector(method_id="mt_abc")) == '{\n  "method_id": "mt_abc"\n}\n'
