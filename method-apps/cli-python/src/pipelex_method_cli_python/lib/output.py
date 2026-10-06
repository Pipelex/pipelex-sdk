"""The result on stdout: the run's main output as JSON, and nothing else.

stdout carries the result and nothing else, always as JSON, so the command pipes into `jq` or a
script the same way wherever it runs, a terminal, a script or an agent. Progress, the run id of an
attended run, the cost report, the paths of downloaded files, errors and hints all go to stderr.

What is printed is the payload as the method produced it, `RunResults.main_stuff`, never a
re-serialization of a model, so no field is dropped, renamed or reordered. It includes the
short-lived signed `public_url` of any produced file, which expires within minutes; the file itself
is downloaded beside it (`lib/artifacts.py`).

**A plural output is read through `list_items`**, because the runtime renders a list in two shapes
depending on the execution path, not on the method: the blocking `execute` response carries the
runtime's list content as an `{"items": [...]}` envelope, and so does a durable run whose element
concept the worker can hydrate, while a durable run of a concept the method declares itself falls
back to a bare array. So a plural output is printed as the bare list of its elements in every mode,
and the same command prints the same JSON with or without `--blocking`. It normalizes values, never
names, and it is a workaround with an expiry: when the runtime settles on one shape, `list_items`
becomes a one-liner or goes away. Whether the output is plural is the binding's to say
(`OUTPUT_IS_LIST`), never guessed from the value, since a single output may well be an object with
an `items` field of its own.

**A reader that stops reading early is not a failure.** `my-cli | head -1` closes the pipe once it
has its line, and the next write to stdout raises `BrokenPipeError`. What the reader took is what
it wanted, so the command carries on to the run's files and its cost report, both on stderr, and
points stdout at the null device so that the interpreter's last flush cannot raise again.
"""

import json
import os
import sys
from typing import Any, cast

import typer
from pipelex_sdk.runs import RunResults

from pipelex_method_cli_python.lib.app import AppError

#: The key the runtime's list content dumps its elements under when it dumps as an object.
ITEMS_KEY = "items"


class OutputShapeError(AppError):
    """A run's main output in a shape neither execution path produces for what the binding declares."""


def list_items(main_stuff: object) -> list[Any]:
    """Return the elements of a plural output, whichever of its two wire shapes arrived.

    A bare list is its own element sequence; a mapping carrying `items` is the envelope and its
    `items` are the elements. Anything else is a shape neither path produces, and it is raised rather
    than coerced: silently wrapping a single object in a list would turn a real protocol surprise
    into a confusing error further on.

    Raises:
        TypeError: `main_stuff` is neither a list nor an `items`-carrying mapping.
    """
    # Read before any narrowing: after the two `isinstance` checks below the type checker holds a
    # union it cannot name, and the message only ever wanted the name of what actually arrived.
    received = type(main_stuff).__name__
    if isinstance(main_stuff, list):
        return list(cast("list[Any]", main_stuff))
    if isinstance(main_stuff, dict):
        items: object = cast("dict[str, Any]", main_stuff).get(ITEMS_KEY)
        if isinstance(items, list):
            return list(cast("list[Any]", items))
    msg = f"a plural output is a list or an {ITEMS_KEY!r} envelope; received {received}"
    raise TypeError(msg)


def result_payload(results: RunResults, *, output_is_list: bool) -> Any:
    """The JSON value the command prints for a run: its main output, a plural one as the list of its elements.

    Raises:
        OutputShapeError: The binding declares a plural output and the run's output is not one.
    """
    if not output_is_list:
        return results.main_stuff
    try:
        return list_items(results.main_stuff)
    except TypeError as exc:
        msg = f"Run {results.pipeline_run_id} produced an output that is not the list binding.py declares: {exc}."
        raise OutputShapeError(msg, hint="If the method's output changed, regenerate with `make codegen` and update binding.py.") from exc


def render_json(payload: Any) -> str:
    """The payload as the JSON text stdout carries: indented, with non-ASCII text kept as it is."""
    return json.dumps(payload, indent=2, ensure_ascii=False)


def print_result(results: RunResults, *, output_is_list: bool) -> None:
    """Print a run's result on stdout as JSON, and nothing else."""
    _echo_stdout(render_json(result_payload(results, output_is_list=output_is_list)))


def print_run_id(run_id: str) -> None:
    """Print a detached run's id alone on stdout, so `RUN_ID=$(… --detach)` captures exactly it."""
    _echo_stdout(run_id)


def _echo_stdout(text: str) -> None:
    """Write `text` and a newline to stdout, letting a reader that closed its end go."""
    try:
        typer.echo(text)
    except BrokenPipeError:
        silence_stdout()


def silence_stdout() -> None:
    """Point stdout's file descriptor at the null device, so nothing written to it later can raise.

    A stdout with no file descriptor of its own, as a test runner's capture is, is left as it is.
    """
    try:
        descriptor = sys.stdout.fileno()
    except (OSError, ValueError):
        return
    null = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(null, descriptor)
    finally:
        os.close(null)
