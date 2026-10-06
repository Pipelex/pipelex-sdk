"""`lib/inputs.py`: the options derived from the input form, the values they read, and the inputs file.

The values each option puts on the wire are held to the TypeScript form kernel by
`test_wire_table.py`; these pin how options are derived and how a value is read, refused or merged.
"""

import io
import json
from enum import Enum
from pathlib import Path
from typing import Any

import pytest

from pipelex_method_cli_python.lib.contracts import PipeContracts, contracts_for_pipe
from pipelex_method_cli_python.lib.inputs import (
    STDIN,
    InputOption,
    InputOptionsError,
    InputsFileError,
    InputUsageError,
    OptionStyle,
    ValueReader,
    collect_inputs,
    declares_files,
    derive_options,
    inputs_template,
    option_help,
    read_inputs_file,
    read_option,
)
from tests.support import wire_contracts


class TestReadInputsFile:
    def test_reads_a_json_object(self, tmp_path: Path):
        path = tmp_path / "inputs.json"
        path.write_text('{"text": {"concept": "native.Text", "content": "Hello"}}', encoding="utf-8")
        assert read_inputs_file(path) == {"text": {"concept": "native.Text", "content": "Hello"}}

    def test_a_dash_reads_stdin(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr("sys.stdin", io.StringIO('{"text": "Hello"}'))
        assert read_inputs_file(Path(STDIN)) == {"text": "Hello"}

    def test_a_missing_file_is_refused(self, tmp_path: Path):
        with pytest.raises(InputsFileError, match="Cannot read"):
            read_inputs_file(tmp_path / "absent.json")

    def test_a_file_that_is_not_text_is_refused(self, tmp_path: Path):
        path = tmp_path / "inputs.json"
        path.write_bytes(b"\xff\xfe\x00")
        with pytest.raises(InputsFileError, match="not UTF-8"):
            read_inputs_file(path)

    @pytest.mark.parametrize(("text", "says"), [("{nope", "not valid JSON"), ("[1, 2]", "JSON list, not an object"), ('"hi"', "JSON str")])
    def test_anything_but_a_json_object_is_refused(self, tmp_path: Path, text: str, says: str):
        path = tmp_path / "inputs.json"
        path.write_text(text, encoding="utf-8")
        with pytest.raises(InputsFileError, match=says) as caught:
            read_inputs_file(path)
        assert caught.value.hint is not None

    def test_an_integer_too_long_to_read_is_refused(self, tmp_path: Path):
        # Valid JSON, which `json` reads with `int()`, which refuses an integer past the interpreter's limit on digits.
        path = tmp_path / "inputs.json"
        path.write_text(f'{{"count": {"9" * 5000}}}', encoding="utf-8")
        with pytest.raises(InputsFileError, match="holds an integer of more than") as caught:
            read_inputs_file(path)
        assert caught.value.hint is not None


EVERYTHING = contracts_for_pipe(wire_contracts("every-kind"), "every_kind.take_everything")
BARE = contracts_for_pipe(wire_contracts("every-kind"), "every_kind.take_bare")
TEXT_STATS = contracts_for_pipe(wire_contracts("text-stats"), "text_stats.analyze_text")


def _options(contracts: PipeContracts = EVERYTHING, *, reserved: frozenset[str] | None = None) -> dict[str, InputOption]:
    return {option.name: option for option in derive_options(contracts, reserved=reserved or frozenset({"--help"}))}


def _collect(contracts: PipeContracts, values: dict[str, Any], *, file_inputs: dict[str, Any] | None = None) -> dict[str, Any]:
    options = derive_options(contracts, reserved=frozenset({"--help"}))
    raw = {f"input_{name}": value for name, value in values.items()}
    return collect_inputs(contracts, options, raw, file_inputs=file_inputs, reader=ValueReader())


class TestDeriveOptions:
    def test_one_option_per_input_in_authored_order(self):
        assert list(_options()) == [field.name for field in EVERYTHING.input_form.fields]

    @pytest.mark.parametrize(
        ("name", "style", "repeatable"),
        [
            ("headline", OptionStyle.TEXT, False),
            ("clock", OptionStyle.TEXT, False),
            ("amount", OptionStyle.NUMBER, False),
            ("agreed", OptionStyle.FLAG, False),
            ("due", OptionStyle.JSON, False),
            ("picture", OptionStyle.FILE, False),
            ("many", OptionStyle.TEXT, True),
            ("checks", OptionStyle.YES_NO, True),
            ("gallery", OptionStyle.FILE, True),
            ("lines", OptionStyle.JSON, False),
        ],
    )
    def test_each_kind_gets_its_style(self, name: str, style: OptionStyle, repeatable: bool):
        option = _options()[name]
        assert (option.style, option.repeatable) == (style, repeatable)

    def test_enum_choices_are_checked_by_click(self):
        level = _options(BARE)["level"]
        assert level.style is OptionStyle.CHOICE
        assert level.choices is not None and [member.value for member in level.choices] == ["low", "normal", "high"]

    def test_a_flag_is_kebab_case_and_the_parameter_is_namespaced(self):
        option = _options()["may_be_absent"]
        assert (option.flag, option.parameter_name) == ("--may-be-absent", "input_may_be_absent")

    def test_a_boolean_takes_both_halves_of_its_pair(self):
        assert _options()["agreed"].flags == {"--agreed", "--no-agreed"}

    def test_a_fixed_count_bounds_the_list(self):
        option = _options()["exactly_three"]
        assert (option.min_items, option.max_items) == (3, 3)
        assert "exactly 3 items" in option_help(option)

    def test_a_number_states_its_bounds(self):
        assert "An integer, at least 1 and at most 10." in option_help(_options()["count"])

    def test_an_input_whose_flag_is_reserved_is_renamed(self):
        options = _options(reserved=frozenset({"--headline", "--help"}))
        assert options["headline"].flag == "--input-headline"

    def test_an_input_the_contract_does_not_declare_is_refused(self):
        broken = PipeContracts(
            pipe_ref=EVERYTHING.pipe_ref,
            io=EVERYTHING.io.model_copy(update={"inputs": {}}),
            input_form=EVERYTHING.input_form,
            output_form=EVERYTHING.output_form,
        )
        with pytest.raises(InputOptionsError, match="declares the input headline, which its IO contract does not"):
            derive_options(broken, reserved=frozenset())


class TestReadOption:
    @pytest.mark.parametrize(("raw", "sent"), [("2026-07-06", "2026-07-06"), ("2026-07-06T00:00:00Z", "2026-07-06")])
    def test_a_calendar_date_is_cut_to_its_day(self, raw: str, sent: str):
        assert read_option(_options(BARE)["day"], raw, ValueReader()) == sent

    def test_a_calendar_date_never_drops_a_time_silently(self):
        with pytest.raises(InputUsageError, match="a time of day is never dropped silently"):
            read_option(_options(BARE)["day"], "2026-07-06T15:40:00Z", ValueReader())

    def test_a_date_and_time_is_sent_as_given(self):
        assert read_option(_options(BARE)["moment"], "2026-07-06T15:40:00+02:00", ValueReader()) == "2026-07-06T15:40:00+02:00"

    @pytest.mark.parametrize(("raw", "says"), [("2.5", "takes an integer"), ("0", "at least 1"), ("11", "at most 10"), ("x", "takes an integer")])
    def test_a_number_outside_what_the_descriptor_says_is_refused(self, raw: str, says: str):
        with pytest.raises(InputUsageError, match=says):
            read_option(_options()["count"], raw, ValueReader())

    @pytest.mark.parametrize("raw", ["nan", "inf", "-inf", "Infinity", "1e999"])
    def test_a_number_must_be_finite(self, raw: str):
        with pytest.raises(InputUsageError, match="finite"):
            read_option(_options()["amount"], raw, ValueReader())

    def test_a_number_is_wrapped_in_its_content_model(self):
        assert read_option(_options()["amount"], "2.5", ValueReader()) == {"number": 2.5}

    @pytest.mark.parametrize(
        ("raw", "read"),
        [
            ("12", 12),
            ("-3", -3),
            ("+7", 7),
            (" 42 ", 42),
            ("2.5", 2.5),
            ("-0.25", -0.25),
            (".5", 0.5),
            ("3.", 3.0),
            ("1e3", 1000.0),
            ("2.5E-2", 0.025),
        ],
    )
    def test_ascii_integers_decimals_and_exponents_are_read(self, raw: str, read: float):
        assert read_option(_options()["amount"], raw, ValueReader()) == {"number": read}

    @pytest.mark.parametrize("raw", ["1_000", "1_0.5", "\u0661\u0662\u0663", "0x10", "1e", "--1", ""])
    def test_what_the_form_kernel_reads_as_nan_is_refused(self, raw: str):
        with pytest.raises(InputUsageError, match="takes a number"):
            read_option(_options()["amount"], raw, ValueReader())

    @pytest.mark.parametrize("raw", ["1_000", "\u0661\u0662\u0663"])
    def test_an_integer_takes_ascii_digits_only(self, raw: str):
        with pytest.raises(InputUsageError, match="takes an integer"):
            read_option(_options()["count"], raw, ValueReader())

    @pytest.mark.parametrize("name", ["count", "amount"])
    def test_an_integer_too_long_to_read_is_refused(self, name: str):
        with pytest.raises(InputUsageError, match="takes a number of at most .* digits; this one has 5000"):
            read_option(_options()[name], "-" + "9" * 5000, ValueReader())

    def test_a_list_of_booleans_takes_true_or_false(self):
        assert read_option(_options()["checks"], ["true", "FALSE"], ValueReader()) == [{"yes_no": True}, {"yes_no": False}]
        with pytest.raises(InputUsageError, match="takes true or false"):
            read_option(_options()["checks"], ["yes", "no"], ValueReader())

    def test_a_fixed_count_list_given_the_wrong_count_is_refused(self):
        with pytest.raises(InputUsageError, match="takes exactly 3 items; it was given 2"):
            read_option(_options()["exactly_three"], ["a", "b"], ValueReader())

    @pytest.mark.parametrize("url", ["https://example.com/a.png", "pipelex-storage://run/a.png", "data:image/png;base64,AA=="])
    def test_a_url_passes_through(self, url: str):
        assert read_option(_options()["picture"], url, ValueReader()) == {"url": url}

    def test_a_scheme_in_capitals_passes_through(self):
        assert read_option(_options()["picture"], "HTTPS://example.com/a.png", ValueReader()) == {"url": "HTTPS://example.com/a.png"}

    def test_a_scheme_is_folded_in_ascii_only(self):
        # Unicode case folding reads the long s as an s; the form kernel does not, so this is a path, and no file.
        with pytest.raises(InputUsageError, match="which is not a file"):
            read_option(_options()["picture"], "http\u017f://example.com/a.png", ValueReader())

    def test_a_local_file_carries_its_name(self, tmp_path: Path):
        (tmp_path / "cat.png").write_bytes(b"png")
        assert read_option(_options()["picture"], str(tmp_path / "cat.png"), ValueReader()) == {
            "url": str(tmp_path / "cat.png"),
            "filename": "cat.png",
        }

    @pytest.mark.parametrize(("raw", "says"), [("{nope", "takes JSON"), ("[1]", "takes a JSON object; this is a JSON array")])
    def test_json_must_be_the_kind_the_input_takes(self, raw: str, says: str):
        with pytest.raises(InputUsageError, match=says):
            read_option(_options()["priority"], raw, ValueReader())

    def test_json_holding_an_integer_too_long_to_read_is_refused(self):
        with pytest.raises(InputUsageError, match="--priority takes JSON whose integers have at most"):
            read_option(_options()["priority"], f'{{"level": {"9" * 5000}}}', ValueReader())

    def test_json_can_come_from_a_file(self, tmp_path: Path):
        (tmp_path / "priority.json").write_text('{"level": "urgent"}', encoding="utf-8")
        assert read_option(_options()["priority"], f"@{tmp_path / 'priority.json'}", ValueReader()) == {"level": "urgent"}

    def test_a_tilde_names_the_home_directory(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # No shell expands a `~` after an `@`, so the reader does, for a text and a JSON value alike.
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        (tmp_path / "note.txt").write_text("from home", encoding="utf-8")
        (tmp_path / "priority.json").write_text('{"level": "urgent"}', encoding="utf-8")
        assert read_option(_options()["headline"], "@~/note.txt", ValueReader()) == {"text": "from home"}
        assert read_option(_options()["priority"], "@~/priority.json", ValueReader()) == {"level": "urgent"}

    def test_an_unreadable_file_is_a_usage_error(self, tmp_path: Path):
        with pytest.raises(InputUsageError, match="cannot be read"):
            read_option(_options()["headline"], f"@{tmp_path / 'absent.txt'}", ValueReader())

    @pytest.mark.parametrize("raw", ["~$report.docx", "~nobody-pipelex-cli-test/x"])
    def test_a_tilde_naming_no_user_is_a_usage_error_not_a_crash(self, raw: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # `Path.expanduser` raises on a `~` naming no user, where a shell leaves the word as written.
        monkeypatch.chdir(tmp_path)
        with pytest.raises(InputUsageError, match="cannot be read"):
            read_option(_options()["headline"], f"@{raw}", ValueReader())
        with pytest.raises(InputUsageError, match="which is not a file"):
            read_option(_options()["picture"], raw, ValueReader())

    def test_a_file_named_with_a_tilde_naming_no_user_is_read_as_written(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # Word's lock file, `~$report.docx`, is an ordinary file name, which a shell passes through as it is.
        monkeypatch.chdir(tmp_path)
        (tmp_path / "~$report.docx").write_text("locked", encoding="utf-8")
        assert read_option(_options()["picture"], "~$report.docx", ValueReader()) == {"url": "~$report.docx", "filename": "~$report.docx"}
        assert read_option(_options()["headline"], "@~$report.docx", ValueReader()) == {"text": "locked"}

    def test_a_file_under_a_directory_that_cannot_be_searched_is_a_usage_error(self, monkeypatch: pytest.MonkeyPatch):
        # Python 3.11 and 3.12 raise `PermissionError` from `is_file()` under such a directory, where 3.13 answers False.
        def refuse(self: Path) -> bool:
            raise PermissionError(13, "Permission denied", str(self))

        monkeypatch.setattr(Path, "is_file", refuse)
        with pytest.raises(InputUsageError, match="cannot be read: Permission denied"):
            read_option(_options()["picture"], "/locked/cat.png", ValueReader())

    def test_stdin_is_read_once(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr("sys.stdin", io.StringIO("from stdin"))
        reader = ValueReader()
        assert read_option(_options()["headline"], "@-", reader) == {"text": "from stdin"}
        with pytest.raises(InputUsageError, match="--may-be-absent reads stdin, which --headline reads already"):
            read_option(_options()["may_be_absent"], "@-", reader)


class TestCollectInputs:
    def test_a_plural_input_given_nowhere_is_the_empty_list_and_an_optional_one_is_left_out(self):
        sent = _collect(BARE, {"level": _level_choice("high"), "day": "2026-07-06"})
        assert sent == {
            "level": {"concept": "every_kind.Level", "content": "high"},
            "levels": [],
            "day": {"concept": "every_kind.Day", "content": "2026-07-06"},
        }

    def test_every_missing_input_is_named_with_its_option(self):
        with pytest.raises(InputUsageError, match=r"The run needs level \(--level\), day \(--day\)"):
            _collect(BARE, {})

    def test_an_input_the_file_gives_passes_as_it_is_and_an_option_overrides_it(self):
        sent = _collect(BARE, {"day": "2026-07-07"}, file_inputs={"level": "low", "day": "2026-07-06"})
        assert sent["level"] == "low"
        assert sent["day"] == {"concept": "every_kind.Day", "content": "2026-07-07"}

    def test_an_input_the_file_leaves_empty_is_missing(self):
        with pytest.raises(InputUsageError, match=r"level \(--level\)"):
            _collect(BARE, {"day": "2026-07-06"}, file_inputs={"level": "  "})

    def test_a_blank_text_given_to_a_required_option_is_missing(self):
        with pytest.raises(InputUsageError, match=r"text \(--text\)"):
            _collect(TEXT_STATS, {"text": "   "})

    def test_a_blank_text_the_file_envelopes_is_missing_as_it_is_from_an_option(self):
        blank = {"concept": "native.Text", "content": {"text": "  "}}
        with pytest.raises(InputUsageError, match=r"The run needs text \(--text\)"):
            _collect(TEXT_STATS, {}, file_inputs={"text": blank})

    def test_a_text_the_file_envelopes_is_sent_as_it_is(self):
        filled = {"concept": "native.Text", "content": {"text": "Hello"}}
        assert _collect(TEXT_STATS, {}, file_inputs={"text": filled}) == {"text": filled}

    def test_a_bare_structured_value_with_a_content_field_is_judged_as_itself(self):
        # No `concept` beside it, so `content` is one of its fields, not an envelope's payload.
        bare = {"content": "  ", "title": "A title"}
        assert _collect(TEXT_STATS, {}, file_inputs={"text": bare}) == {"text": bare}

    def test_a_structured_value_with_concept_and_content_fields_among_others_is_judged_as_itself(self):
        # An envelope's keys are exactly `concept` and `content`, as the SDK's `prepare_inputs` reads one.
        structured = {"concept": "proposal", "content": None, "title": "Ready"}
        assert _collect(TEXT_STATS, {}, file_inputs={"text": structured}) == {"text": structured}

    def test_an_exact_envelope_with_blank_content_is_missing(self):
        with pytest.raises(InputUsageError, match=r"The run needs text \(--text\)"):
            _collect(TEXT_STATS, {}, file_inputs={"text": {"concept": "native.Text", "content": None}})


def _level_choice(value: str) -> Enum:
    """The member of the `level` option's choices that Click hands the command for `value`."""
    choices = _options(BARE)["level"].choices
    assert choices is not None
    return choices(value)


class TestTemplateAndFiles:
    def test_the_template_names_every_input(self):
        template = json.loads(inputs_template(BARE))
        assert set(template) == {"level", "levels", "day", "moment"}

    def test_a_form_declaring_a_file_at_any_depth_is_prepared(self):
        assert declares_files(EVERYTHING.input_form)
        assert not declares_files(BARE.input_form)
