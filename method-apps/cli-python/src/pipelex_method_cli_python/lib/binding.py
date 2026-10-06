"""The binding: the one seam between this generic CLI and the one method it runs.

The template ships no method. `make create` turns a copy of it into the CLI for one method by
writing these inside the package, and the CLI finds them there at run time:

- `method/`, the method's source (`lib/method_source.py`);
- `generated/`, the package the codegen writes: the method's typed models and the codegen lock;
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

The package holds no method when it has neither `binding.py` nor `generated/`, which is the template
as shipped: the command then says to run `make create`. Their presence is read with
`importlib.util.find_spec`, which looks without importing, so an `ImportError` raised inside a
binding that exists is never mistaken for a binding that does not. One without the other is a broken
project, refused by name.

The CLI imports `binding.py` dynamically, never with an `import` statement, so the type checker
passes on the template as shipped; the names it reads are checked here, when the CLI loads, rather
than failing later as an `AttributeError` in the middle of a run.
"""

import importlib
import re
from dataclasses import dataclass
from importlib.util import find_spec
from types import ModuleType

from pydantic import BaseModel

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.method_source import PACKAGE, MethodSource, read_method_source

#: The module `make create` writes, which names the pipe and the output model.
BINDING_MODULE = f"{PACKAGE}.binding"

#: The package the codegen writes the method's typed models into.
GENERATED_PACKAGE = f"{PACKAGE}.generated"

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


def has_binding() -> bool:
    """Whether the package holds `binding.py`, looked for without importing it."""
    return find_spec(BINDING_MODULE) is not None


def has_generated_tree() -> bool:
    """Whether the package holds the generated tree, looked for without importing it."""
    return find_spec(GENERATED_PACKAGE) is not None


def load_binding() -> MethodBinding | None:
    """The method this CLI runs, or `None` for the template as shipped, which holds none.

    Raises:
        BindingError: One half of the method is there without the other, or `binding.py` does not
            declare what the CLI reads.
        MethodSourceError: `method/` does not name exactly one method.
        ManifestError: Its `method.json` does not name exactly one method.
    """
    binding_found = has_binding()
    generated_found = has_generated_tree()
    if not binding_found and not generated_found:
        return None
    if not binding_found:
        msg = f"{GENERATED_PACKAGE} exists but {BINDING_MODULE} does not, so the CLI does not know which pipe to run."
        raise BindingError(msg, hint="Restore binding.py from version control: it names the pipe and the output model.")
    if not generated_found:
        msg = f"{BINDING_MODULE} exists but {GENERATED_PACKAGE} does not, so the method's typed models are missing."
        raise BindingError(msg, hint="Regenerate the tree with `make codegen`, which needs PIPELEX_API_KEY.")
    return binding_from_module(importlib.import_module(BINDING_MODULE), source=read_method_source())


def binding_from_module(module: ModuleType, *, source: MethodSource) -> MethodBinding:
    """Read and check what a binding module declares.

    Raises:
        BindingError: `PIPE_REF`, `OUTPUT_MODEL` or `OUTPUT_IS_LIST` is missing or of the wrong kind.
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
    return MethodBinding(pipe_ref=pipe_ref, output_model=output_model, output_is_list=output_is_list, source=source)
