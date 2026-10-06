"""The binding: the one seam between this generic CLI and the one method it runs.

The template ships no method. `make create` turns a copy of it into the CLI for one method by
writing these inside the package, and the CLI finds them there at run time:

- `method/`, the method's source (`lib/method_source.py`);
- `generated/`, the package `make codegen` writes: the method's typed models, the codegen lock, and
  `contracts.json`, the contracts the command derives its options from (`lib/contracts.py`);
- `binding.py`, written once and the project's own to edit afterwards, which declares:

  ```python
  from pipelex_method_cli_python.generated.models import ReceiptReview

  #: The pipe the CLI runs, by its namespaced reference: `<domain>.<pipe_code>`.
  PIPE_REF = "receipt_review.review_receipt"
  #: The model the pipe's output is validated against, imported from the generated tree.
  OUTPUT_MODEL = ReceiptReview
  #: Whether the pipe's output is plural, a list of `OUTPUT_MODEL`.
  OUTPUT_IS_LIST = False
  ```

The package holds no method when it has neither `binding.py` nor a generated tree, which is the
template as shipped: the command then says to run `make create`. Their presence is read off the
package's files through `importlib.resources`, without importing anything, so an `ImportError`
raised inside a binding that exists is never mistaken for a binding that does not. A tree is present
only when it holds what `make codegen` writes (`lib/contracts.py`'s `GENERATED_FILES`): a leftover
`generated/` holding nothing but Python's bytecode cache is no tree, and one missing a written file
is refused by name. One half without the other is a broken project, refused by name too.

The CLI imports `binding.py` dynamically, never with an `import` statement, so the type checker
passes on the template as shipped; the names it reads are checked here, when the CLI loads, rather
than failing later as an `AttributeError` in the middle of a run. So is the pipe it names: it must
be described by the committed `contracts.json`, whose payloads for it the binding carries, and
`OUTPUT_IS_LIST` must say what the contract says about the output's plurality.
"""

import importlib
import re
from dataclasses import dataclass
from importlib.resources import files
from importlib.resources.abc import Traversable
from types import ModuleType

from pydantic import BaseModel

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.contracts import (
    GENERATED_DIRNAME,
    REGENERATE_HINT,
    ContractsDocument,
    PipeContracts,
    TreeState,
    contracts_for_pipe,
    load_contracts,
    tree_state,
)
from pipelex_method_cli_python.lib.method_source import PACKAGE, MethodSource, read_method_source

#: The module `make create` writes, which names the pipe and the output model.
BINDING_MODULE = f"{PACKAGE}.binding"

#: The file that module is, inside the package.
BINDING_FILENAME = "binding.py"

#: The package the codegen writes the method's typed models into.
GENERATED_PACKAGE = f"{PACKAGE}.{GENERATED_DIRNAME}"

#: A namespaced pipe reference: a domain and a pipe code, each a snake_case identifier, joined by a dot.
#: A domain may itself be dotted, so only the last segment is the pipe code.
_PIPE_REF = re.compile(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+")


class BindingError(AppError):
    """A binding that is missing a half, or that does not declare what the CLI reads from it."""


@dataclass(frozen=True)
class MethodBinding:
    """What the CLI knows about its method once `make create` has written it."""

    #: The pipe the CLI runs, by its namespaced reference (`<domain>.<pipe_code>`), which the API
    #: resolves exactly, where a bare code would be searched for across the method's domains.
    pipe_ref: str
    #: The generated model the pipe's output is validated against.
    output_model: type[BaseModel]
    #: Whether the output is plural, a list of `output_model`, which the runtime renders in two
    #: shapes (`lib/output.py`).
    output_is_list: bool
    #: How a run names the method.
    source: MethodSource
    #: The committed contracts for the pipe: its IO contract and both form descriptors.
    contracts: PipeContracts


def has_binding(package: Traversable | None = None) -> bool:
    """Whether the package holds `binding.py` as a file, looked for without importing it.

    A file, not a module: a leftover `binding/` directory would be found by the import system as a
    namespace package.
    """
    root = package if package is not None else files(PACKAGE)
    return root.joinpath(BINDING_FILENAME).is_file()


def generated_tree() -> tuple[TreeState, tuple[str, ...]]:
    """What the package's generated tree holds, and which of the files `make codegen` writes it misses."""
    return tree_state()


def load_binding() -> MethodBinding | None:
    """The method this CLI runs, or `None` for the template as shipped, which holds none.

    Raises:
        BindingError: One half of the method is there without the other, the tree misses a file
            `make codegen` writes, `binding.py` cannot be imported, or it does not declare what the
            CLI reads.
        ContractsError: `contracts.json` cannot be read, or does not describe the pipe `binding.py` names.
        MethodSourceError: `method/` does not name exactly one method.
        ManifestError: Its `method.json` does not name exactly one method.
    """
    binding_found = has_binding()
    state, missing = generated_tree()
    if not binding_found and state is TreeState.ABSENT:
        return None
    if not binding_found:
        msg = f"{GENERATED_PACKAGE} exists but {BINDING_MODULE} does not, so the CLI does not know which pipe to run."
        raise BindingError(msg, hint="Restore binding.py from version control: it names the pipe and the output model.")
    if state is TreeState.ABSENT:
        msg = f"{BINDING_MODULE} exists but {GENERATED_PACKAGE} does not, so the method's typed models are missing."
        raise BindingError(msg, hint=REGENERATE_HINT)
    if state is TreeState.INCOMPLETE:
        msg = f"{GENERATED_PACKAGE} is missing {', '.join(missing)}, which `make codegen` writes into every tree."
        raise BindingError(msg, hint=REGENERATE_HINT)
    try:
        module = importlib.import_module(BINDING_MODULE)
    except Exception as exc:
        # `binding.py` is the project's own code, so anything can fail in it: a stale import after the
        # models were regenerated, a syntax error, a model the generated tree no longer defines.
        msg = f"{BINDING_MODULE} could not be imported: {type(exc).__name__}: {exc}"
        raise BindingError(msg, hint="Fix binding.py so that it imports what the generated tree defines, after `make codegen` above all.") from exc
    return binding_from_module(module, source=read_method_source(), contracts=load_contracts())


def binding_from_module(module: ModuleType, *, source: MethodSource, contracts: ContractsDocument) -> MethodBinding:
    """Read and check what a binding module declares, against the committed contracts.

    Raises:
        BindingError: `PIPE_REF`, `OUTPUT_MODEL` or `OUTPUT_IS_LIST` is missing or of the wrong kind,
            or `OUTPUT_IS_LIST` disagrees with the pipe's contract.
        ContractsError: The contracts do not describe the pipe `PIPE_REF` names.
    """
    where = module.__name__
    pipe_ref: object = getattr(module, "PIPE_REF", None)
    if not isinstance(pipe_ref, str) or _PIPE_REF.fullmatch(pipe_ref) is None:
        msg = f"{where}.PIPE_REF must be a namespaced pipe reference such as 'receipt_review.review_receipt'; found {pipe_ref!r}."
        raise BindingError(msg)
    output_model: object = getattr(module, "OUTPUT_MODEL", None)
    if not isinstance(output_model, type) or not issubclass(output_model, BaseModel):
        msg = f"{where}.OUTPUT_MODEL must be a model class from the generated tree; found {output_model!r}."
        raise BindingError(msg)
    output_is_list: object = getattr(module, "OUTPUT_IS_LIST", None)
    if not isinstance(output_is_list, bool):
        msg = f"{where}.OUTPUT_IS_LIST must be True or False; found {output_is_list!r}."
        raise BindingError(msg)
    pipe = contracts_for_pipe(contracts, pipe_ref)
    plural = pipe.io.output.multiplicity.is_plural
    if output_is_list is not plural:
        said = "a list" if plural else "a single value"
        msg = f"{where}.OUTPUT_IS_LIST is {output_is_list}, but the pipe {pipe_ref} returns {said} according to its committed contract."
        raise BindingError(msg, hint=f"Set OUTPUT_IS_LIST = {plural} in binding.py, with the output model the pipe now returns.")
    return MethodBinding(pipe_ref=pipe_ref, output_model=output_model, output_is_list=output_is_list, source=source, contracts=pipe)
