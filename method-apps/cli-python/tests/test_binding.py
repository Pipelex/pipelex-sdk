"""`lib/binding.py`: the seam between the generic CLI and the one method `make create` binds it to."""

import sys
from types import ModuleType

import pytest

from pipelex_method_cli_python.lib import binding as binding_module
from pipelex_method_cli_python.lib.binding import BINDING_MODULE, BindingError, MethodBinding, binding_from_module, load_binding
from pipelex_method_cli_python.lib.method_source import MethodSource
from tests.support import Greeting

SOURCE = MethodSource(method_id="mt_abc")


def _module(**names: object) -> ModuleType:
    module = ModuleType(BINDING_MODULE)
    for name, value in names.items():
        setattr(module, name, value)
    return module


def _halves(monkeypatch: pytest.MonkeyPatch, *, binding: bool, generated: bool) -> None:
    monkeypatch.setattr(binding_module, "has_binding", lambda: binding)
    monkeypatch.setattr(binding_module, "has_generated_tree", lambda: generated)


class TestLoadBinding:
    def test_the_template_as_shipped_holds_no_method(self):
        assert load_binding() is None

    def test_a_generated_tree_without_a_binding_is_refused(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=False, generated=True)
        with pytest.raises(BindingError, match="does not know which pipe"):
            load_binding()

    def test_a_binding_without_a_generated_tree_is_refused(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=True, generated=False)
        with pytest.raises(BindingError, match="typed models are missing"):
            load_binding()

    def test_a_binding_that_cannot_be_imported_is_refused_naming_the_error(self, monkeypatch: pytest.MonkeyPatch):
        # The project's own code: a stale import after the models were regenerated, a syntax error.
        _halves(monkeypatch, binding=True, generated=True)

        def broken(name: str) -> ModuleType:
            raise SyntaxError(f"invalid syntax in {name}")

        monkeypatch.setattr(binding_module.importlib, "import_module", broken)
        with pytest.raises(BindingError, match="could not be imported: SyntaxError"):
            load_binding()

    def test_both_halves_load_the_binding_with_its_method(self, monkeypatch: pytest.MonkeyPatch):
        _halves(monkeypatch, binding=True, generated=True)
        monkeypatch.setitem(sys.modules, BINDING_MODULE, _module(PIPE_REF="greetings.greet", OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=False))
        monkeypatch.setattr(binding_module, "read_method_source", lambda: SOURCE)
        assert load_binding() == MethodBinding(pipe_ref="greetings.greet", output_model=Greeting, output_is_list=False, source=SOURCE)


class TestBindingFromModule:
    def test_reads_the_three_names(self):
        module = _module(PIPE_REF="receipt_review.review", OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=True)
        binding = binding_from_module(module, source=SOURCE)
        assert binding.pipe_ref == "receipt_review.review"
        assert binding.output_model is Greeting
        assert binding.output_is_list is True

    def test_a_dotted_domain_is_a_namespaced_reference(self):
        module = _module(PIPE_REF="acme.receipts.review", OUTPUT_MODEL=Greeting, OUTPUT_IS_LIST=False)
        assert binding_from_module(module, source=SOURCE).pipe_ref == "acme.receipts.review"

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
            binding_from_module(_module(**names), source=SOURCE)
