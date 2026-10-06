"""The method's committed contracts: what its pipes take and return, read from `generated/contracts.json`.

`make codegen` writes the package's `generated/` directory, and this module is its reader at run
time. Beside the typed models and the codegen lock, the tree holds `contracts.json`: the three
payloads of one `POST /v1/pipe-io` call, for every pipe the method loads, each keyed by namespaced
pipe reference:

- `pipe_io_contracts`, what each pipe takes and returns, with the JSON Schema of every input's
  content and of the output's payload;
- `input_form`, the input-form descriptor the command derives one option per input from
  (`lib/inputs.py`);
- `output_form`, its twin on the result side, which says whether the output is plural.

It is data rather than a Python module, so that no formatter touches it, and it is read through
`importlib.resources`, since an installed CLI has no repository around it. It is parsed into the
`mthds.protocol` models when the CLI loads, so a malformed file or a pipe missing from it fails the
CLI at once, naming what is wrong and saying to run `make codegen`, rather than surfacing later as
an empty list of options.

The names of the files the codegen writes into the tree live here too, since the codegen scripts
and the CLI must agree on them: the scripts import them from this module.
"""

import json
from dataclasses import dataclass
from enum import StrEnum
from importlib.resources import files
from importlib.resources.abc import Traversable
from typing import Any

from mthds.protocol.input_form import InputForm, PipeInputFormDescriptor
from mthds.protocol.output_form import OutputForm, PipeOutputFormDescriptor
from mthds.protocol.pipe_io_contracts import PipeIOContract, PipeIOContracts
from pydantic import BaseModel, ConfigDict, ValidationError

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.method_source import PACKAGE

#: The directory, inside the package, that `make codegen` writes.
GENERATED_DIRNAME = "generated"

#: The three payloads of one `POST /v1/pipe-io` call, as JSON.
CONTRACTS_FILENAME = "contracts.json"

#: The codegen lock, written verbatim from `POST /v1/codegen`.
LOCK_FILENAME = "codegen.lock"

#: The sidecar recording the hashes of the method's sources and of the files the codegen emits itself.
SOURCES_SIDECAR = "sources.json"

#: The file that makes the tree an importable package, so that `binding.py` imports its models.
INIT_FILENAME = "__init__.py"

#: What `make codegen` writes into every tree whatever the server returns, which is what the CLI
#: requires before it calls a tree present. The typed models themselves are the server's artifacts,
#: listed by the lock; a missing one fails `binding.py`'s import, and `make codegen-check`, by name.
GENERATED_FILES = (INIT_FILENAME, LOCK_FILENAME, CONTRACTS_FILENAME, SOURCES_SIDECAR)

#: What the CLI tells a person to run when the tree is missing, incomplete or out of step.
REGENERATE_HINT = "Regenerate the tree with `make codegen`, which needs PIPELEX_API_KEY."


class ContractsError(AppError):
    """A `contracts.json` that cannot be read, or that does not describe the pipe the CLI runs."""


class ContractsDocument(BaseModel):
    """`contracts.json` as a model: a comment, then the three payloads of one `POST /v1/pipe-io` call."""

    model_config = ConfigDict(extra="forbid")

    #: What the file is and who writes it; read by no code.
    comment: str
    pipe_io_contracts: PipeIOContracts
    input_form: InputForm
    output_form: OutputForm


@dataclass(frozen=True)
class PipeContracts:
    """The three payloads for the one pipe the CLI runs."""

    #: The pipe, by its namespaced reference.
    pipe_ref: str
    #: What the pipe takes and returns, with the JSON Schemas of its inputs' content and of its payload.
    io: PipeIOContract
    #: The pipe's input-form descriptor: one field per declared input, in authored order.
    input_form: PipeInputFormDescriptor
    #: The pipe's output-form descriptor: what the result is, a `list` node when it is plural.
    output_form: PipeOutputFormDescriptor


class TreeState(StrEnum):
    """What the package's `generated/` directory holds."""

    #: No tree: the directory is missing, or it holds nothing but Python's bytecode cache and dotfiles.
    ABSENT = "absent"
    #: Every file `make codegen` writes is there.
    COMPLETE = "complete"
    #: Something is there, but not every file `make codegen` writes.
    INCOMPLETE = "incomplete"


def generated_dir() -> Traversable:
    """The package's `generated/` directory, wherever the package is installed."""
    return files(PACKAGE).joinpath(GENERATED_DIRNAME)


def tree_state(directory: Traversable | None = None) -> tuple[TreeState, tuple[str, ...]]:
    """What `directory`, the package's `generated/` by default, holds, and which written files it misses.

    A directory left behind holding only `__pycache__` is no tree: it is what Python leaves after the
    tree was deleted, and finding it as a package was how a leftover passed for a method.
    """
    root = directory if directory is not None else generated_dir()
    if not root.is_dir():
        return TreeState.ABSENT, ()
    entries = [entry.name for entry in root.iterdir() if entry.name != "__pycache__" and not entry.name.startswith(".")]
    if not entries:
        return TreeState.ABSENT, ()
    missing = tuple(name for name in GENERATED_FILES if not root.joinpath(name).is_file())
    return (TreeState.INCOMPLETE, missing) if missing else (TreeState.COMPLETE, ())


def parse_contracts(text: str, *, origin: str) -> ContractsDocument:
    """Parse a `contracts.json`'s text.

    Raises:
        ContractsError: The text is not JSON, or not the three payloads `make codegen` writes.
    """
    try:
        payload: Any = json.loads(text)
    except json.JSONDecodeError as exc:
        msg = f"{origin} is not valid JSON: {exc}."
        raise ContractsError(msg, hint=REGENERATE_HINT) from exc
    try:
        return ContractsDocument.model_validate(payload)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(part) for part in first["loc"]) or "the document"
        msg = f"{origin} is not the contracts `make codegen` writes: {where}: {first['msg']}."
        raise ContractsError(msg, hint=REGENERATE_HINT) from exc


def load_contracts(directory: Traversable | None = None) -> ContractsDocument:
    """Read `contracts.json` out of `directory`, the package's `generated/` by default.

    Raises:
        ContractsError: The file is missing, not UTF-8, not JSON, or not the payloads `make codegen` writes.
    """
    root = directory if directory is not None else generated_dir()
    origin = f"{PACKAGE}/{GENERATED_DIRNAME}/{CONTRACTS_FILENAME}"
    entry = root.joinpath(CONTRACTS_FILENAME)
    if not entry.is_file():
        msg = f"{origin} is missing, so the CLI does not know what the method takes."
        raise ContractsError(msg, hint=REGENERATE_HINT)
    try:
        text = entry.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        msg = f"{origin} is not UTF-8 text."
        raise ContractsError(msg, hint=REGENERATE_HINT) from exc
    return parse_contracts(text, origin=origin)


def contracts_for_pipe(document: ContractsDocument, pipe_ref: str) -> PipeContracts:
    """The three payloads for `pipe_ref`.

    Raises:
        ContractsError: One of the three payloads does not describe the pipe, which is a `binding.py`
            naming a pipe the method no longer has, or a tree generated from another method.
    """
    where = f"{PACKAGE}/{GENERATED_DIRNAME}/{CONTRACTS_FILENAME}"
    io = document.pipe_io_contracts.get(pipe_ref)
    input_form = document.input_form.get(pipe_ref)
    output_form = document.output_form.get(pipe_ref)
    if io is None or input_form is None or output_form is None:
        described = ", ".join(sorted(document.pipe_io_contracts)) or "no pipe"
        msg = f"binding.py runs the pipe {pipe_ref}, which {where} does not describe; it describes {described}."
        raise ContractsError(msg, hint="Run `make codegen` to regenerate the tree from the method, then check PIPE_REF in binding.py.")
    return PipeContracts(pipe_ref=pipe_ref, io=io, input_form=input_form, output_form=output_form)
