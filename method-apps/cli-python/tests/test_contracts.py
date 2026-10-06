"""`lib/contracts.py`: the committed `contracts.json`, and what the `generated/` tree holds."""

from pathlib import Path

import pytest

from pipelex_method_cli_python.lib.contracts import (
    CONTRACTS_FILENAME,
    GENERATED_FILES,
    REGENERATE_HINT,
    ContractsError,
    TreeState,
    contracts_for_pipe,
    load_contracts,
    parse_contracts,
    tree_state,
)
from tests.support import WIRE_CONTRACTS, wire_contracts


def _complete_tree(directory: Path) -> Path:
    directory.mkdir()
    for name in GENERATED_FILES:
        (directory / name).write_text("", encoding="utf-8")
    return directory


class TestTreeState:
    def test_a_missing_directory_is_no_tree(self, tmp_path: Path):
        assert tree_state(tmp_path / "generated") == (TreeState.ABSENT, ())

    def test_a_directory_holding_only_bytecode_and_dotfiles_is_no_tree(self, tmp_path: Path):
        # What Python leaves behind after the tree is deleted, which used to pass for a method.
        generated = tmp_path / "generated"
        (generated / "__pycache__").mkdir(parents=True)
        (generated / "__pycache__" / "models.cpython-313.pyc").write_bytes(b"")
        (generated / ".DS_Store").write_bytes(b"")
        assert tree_state(generated) == (TreeState.ABSENT, ())

    def test_a_tree_with_every_written_file_is_complete(self, tmp_path: Path):
        assert tree_state(_complete_tree(tmp_path / "generated")) == (TreeState.COMPLETE, ())

    def test_a_tree_missing_a_written_file_is_incomplete_and_names_it(self, tmp_path: Path):
        generated = _complete_tree(tmp_path / "generated")
        (generated / CONTRACTS_FILENAME).unlink()
        assert tree_state(generated) == (TreeState.INCOMPLETE, (CONTRACTS_FILENAME,))


class TestParseContracts:
    def test_reads_the_three_payloads(self):
        document = wire_contracts("text-stats")
        assert set(document.pipe_io_contracts) == set(document.input_form) == set(document.output_form)

    @pytest.mark.parametrize(
        ("text", "says"),
        [
            pytest.param("{nope", "is not valid JSON", id="not json"),
            pytest.param('{"comment": "x"}', "is not the contracts `make codegen` writes: pipe_io_contracts", id="a payload missing"),
            pytest.param(
                '{"comment": "x", "pipe_io_contracts": {}, "input_form": {}, "output_form": {}, "extra": 1}',
                "extra: Extra inputs",
                id="a key too many",
            ),
        ],
    )
    def test_anything_else_is_refused_with_the_regeneration_hint(self, text: str, says: str):
        with pytest.raises(ContractsError, match=says) as caught:
            parse_contracts(text, origin="contracts.json")
        assert caught.value.hint == REGENERATE_HINT


class TestLoadContracts:
    def test_reads_the_file_out_of_the_directory(self, tmp_path: Path):
        (tmp_path / CONTRACTS_FILENAME).write_text((WIRE_CONTRACTS / "text-stats.json").read_text(encoding="utf-8"), encoding="utf-8")
        assert load_contracts(tmp_path) == wire_contracts("text-stats")

    def test_a_missing_file_says_what_the_cli_does_not_know(self, tmp_path: Path):
        with pytest.raises(ContractsError, match="is missing, so the CLI does not know what the method takes"):
            load_contracts(tmp_path)

    def test_a_file_that_is_not_text_is_refused(self, tmp_path: Path):
        (tmp_path / CONTRACTS_FILENAME).write_bytes(b"\xff\xfe")
        with pytest.raises(ContractsError, match="is not UTF-8 text"):
            load_contracts(tmp_path)


class TestContractsForPipe:
    def test_gathers_the_pipes_three_payloads(self):
        contracts = contracts_for_pipe(wire_contracts("text-stats"), "text_stats.analyze_text")
        assert contracts.pipe_ref == "text_stats.analyze_text"
        assert [field.name for field in contracts.input_form.fields] == list(contracts.io.inputs)

    def test_a_pipe_the_document_does_not_describe_is_refused_naming_those_it_does(self):
        with pytest.raises(ContractsError, match="runs the pipe text_stats.gone, which .* does not describe; it describes text_stats.analyze_text"):
            contracts_for_pipe(wire_contracts("text-stats"), "text_stats.gone")
