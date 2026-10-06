"""`lib/inputs.py`: the inputs file `--inputs` names, read and checked before any run starts."""

import io
from pathlib import Path

import pytest

from pipelex_method_cli_python.lib.inputs import STDIN, InputsFileError, read_inputs_file


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
