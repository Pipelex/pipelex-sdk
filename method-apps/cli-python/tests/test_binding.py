"""`lib/binding.py`: the seam between the generic CLI and the one method `make create` binds it to."""

import sys
from pathlib import Path
from types import ModuleType

import pytest

from pipelex_method_cli_python.lib import binding as binding_module
from pipelex_method_cli_python.lib.binding import (
    BINDING_FILENAME,
    BINDING_MODULE,
    BindingError,
    MethodBinding,
    binding_from_module,
    has_binding,
    load_binding,
)
from pipelex_method_cli_python.lib.contracts import ContractsDocument, ContractsError, TreeState
from pipelex_method_cli_python.lib.method_source import MethodSource
from tests.support import GREET, Greeting, greet_contracts

SOURCE = MethodSource(method_id="mt_abc")


def _contracts(*, output_is_list: bool = False, pipe_ref: str = GREET) -> ContractsDocument:
    pipe = greet_contracts(output_is_list=output_is_list)
    return ContractsDocument(
        comment="test",
        pipe_io_contracts={pipe_ref: pipe.io},
        input_form={pipe_ref: pipe.input_form},
        output_form={pipe_ref: pipe.output_form},
    )


def _module(**names: object) -> ModuleType:
    module = ModuleType(BINDING_MODULE)
    for name, value in names.items():
        setattr(module, name, value)
    return module


def _halves(monkeypatch: pytest.MonkeyPatch, *, binding: bool, tree: TreeState, missing: tuple[str, ...] = ()) -> None:
    monkeypatch.setattr(binding_module, "has_binding", lambda: binding)
    monkeypatch.setattr(binding_module, "tree_state", lambda: (tree, missing))


class TestLoadBinding:
    def test_the_template_as_shipped_holds_no_method(self):
        assert load_binding() is None

    def test_a_generated_tree_without_a_binding_is_refused(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=False, tree=TreeState.COMPLETE)
        with pytest.raises(BindingError, match="does not know which pipe"):
            load_binding()

    def test_a_binding_without_a_generated_tree_is_refused(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=True, tree=TreeState.ABSENT)
        with pytest.raises(BindingError, match="typed models are missing"):
            load_binding()

    def test_a_tree_missing_a_file_the_codegen_writes_is_refused_naming_it(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=True, tree=TreeState.INCOMPLETE, missing=("contracts.json",))
        with pytest.raises(BindingError, match=r"missing contracts\.json") as caught:
            load_binding()
        assert caught.value.hint is not None and "make codegen" in caught.value.hint

    def test_a_binding_naming_a_pipe_the_contracts_do_not_describe_is_refused(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=True, tree=TreeState.COMPLETE)
        monkeypatch.setitem(sys.modules, BINDING_MODULE, _module(PIPE_REF="greetings.other", OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=False))
        monkeypatch.setattr(binding_module, "read_method_source", lambda: SOURCE)
        monkeypatch.setattr(binding_module, "load_contracts", lambda: _contracts())
        with pytest.raises(ContractsError, match="greetings.other") as caught:
            load_binding()
        assert caught.value.hint is not None and "make codegen" in caught.value.hint

    def test_a_binding_that_cannot_be_imported_is_refused_naming_the_error(self, monkeypatch: pytest.MonkeyPatch):
        # The project's own code: a stale import after the models were regenerated, a syntax error.
        _halves(monkeypatch, binding=True, tree=TreeState.COMPLETE)

        def broken(name: str) -> ModuleType:
            raise SyntaxError(f"invalid syntax in {name}")

        monkeypatch.setattr(binding_module.importlib, "import_module", broken)
        with pytest.raises(BindingError, match="could not be imported: SyntaxError"):
            load_binding()

    def test_both_halves_load_the_binding_with_its_method_and_its_contracts(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=True, tree=TreeState.COMPLETE)
        monkeypatch.setitem(sys.modules, BINDING_MODULE, _module(PIPE_REF=GREET, OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=False))
        monkeypatch.setattr(binding_module, "read_method_source", lambda: SOURCE)
        monkeypatch.setattr(binding_module, "load_contracts", lambda: _contracts())
        assert load_binding() == MethodBinding(
            pipe_ref=GREET, output_model=Greeting, output_is_list=False, source=SOURCE, contracts=greet_contracts()
        )


class TestHasBinding:
    def test_a_binding_file_is_a_binding(self, tmp_path: Path):
        (tmp_path / BINDING_FILENAME).write_text("PIPE_REF = 'a.b'\n", encoding="utf-8")
        assert has_binding(tmp_path)

    def test_a_leftover_binding_directory_is_none(self, tmp_path: Path):
        # The import system would find it as a namespace package.
        (tmp_path / "binding" / "__pycache__").mkdir(parents=True)
        assert not has_binding(tmp_path)

    def test_the_template_as_shipped_has_none(self):
        assert not has_binding()


class TestBindingFromModule:
    def test_reads_the_three_names(self):
        module = _module(PIPE_REF="receipt_review.review", OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=True)
        binding = binding_from_module(module, source=SOURCE, contracts=_contracts(output_is_list=True, pipe_ref="receipt_review.review"))
        assert binding.pipe_ref == "receipt_review.review"
        assert binding.output_model is Greeting
        assert binding.output_is_list is True

    def test_a_dotted_domain_is_a_namespaced_reference(self):
        module = _module(PIPE_REF="acme.receipts.review", OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=False)
        assert binding_from_module(module, source=SOURCE, contracts=_contracts(pipe_ref="acme.receipts.review")).pipe_ref == "acme.receipts.review"

    @pytest.mark.parametrize(
        ("names", "says"),
        [
            pytest.param({"OUTPUT_MODEL": Greeting, "OUTPUT_IS_LIST": False}, "PIPE_REF", id="no pipe"),
            pytest.param({"PIPE_REF": "review", "OUTPUT_MODEL": Greeting, "OUTPUT_IS_LIST": False}, "PIPE_REF", id="bare pipe code"),
            pytest.param({"PIPE_REF": "Receipt.Review", "OUTPUT_MODEL": Greeting, "OUTPUT_IS_LIST": False}, "PIPE_REF", id="not snake case"),
            pytest.param({"PIPE_REF": "a.b", "OUTPUT_IS_LIST": False}, "OUTPUT_MODEL", id="no model"),
            pytest.param({"PIPE_REF": "a.b", "OUTPUT_MODEL": dict, "OUTPUT_IS_LIST": False}, "OUTPUT_MODEL", id="not a model"),
            pytest.param({"PIPE_REF": "a.b", "OUTPUT_MODEL": Greeting}, "OUTPUT_IS_LIST", id="no plurality"),
            pytest.param({"PIPE_REF": "a.b", "OUTPUT_MODEL": Greeting, "OUTPUT_IS_LIST": 1}, "OUTPUT_IS_LIST", id="not a bool"),
        ],
    )
    def test_refuses_a_binding_that_does_not_declare_what_the_cli_reads(self, names: dict[str, object], says: str):
        with pytest.raises(BindingError, match=says):
            binding_from_module(_module(**names), source=SOURCE, contracts=_contracts(pipe_ref="a.b"))

    @pytest.mark.parametrize("output_is_list", [True, False])
    def test_a_plurality_the_contract_contradicts_is_refused(self, output_is_list: bool):
        module = _module(PIPE_REF=GREET, OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=output_is_list)
        with pytest.raises(BindingError, match="OUTPUT_IS_LIST") as caught:
            binding_from_module(module, source=SOURCE, contracts=_contracts(output_is_list=not output_is_list))
        assert caught.value.hint == f"Set OUTPUT_IS_LIST = {not output_is_list} in binding.py, with the output model the pipe now returns."
