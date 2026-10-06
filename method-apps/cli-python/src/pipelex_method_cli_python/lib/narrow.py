"""Check a run's result against the method's generated model before it is printed.

`binding.py` names the model the pipe's output is validated against, `OUTPUT_MODEL`, imported from
the tree `make codegen` writes. A method that changed on the server without the tree being
regenerated returns a result the model no longer describes, and this is where that is caught: the
result is validated with `OUTPUT_MODEL.model_validate`, a plural one element by element after
`list_items` has read it out of whichever of its two wire shapes arrived (`lib/output.py`).

The model is a check, never a filter. What is printed is the payload as the method produced it, so
a field the model does not declare is kept and nothing is reordered, and a result the model refuses
is not printed at all: the error names every field that failed, and the hint says how to
regenerate and fetch the result again.
"""

from typing import Any

from pipelex_sdk.runs import RunResults
from pydantic import BaseModel, TypeAdapter, ValidationError

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.output import result_payload

#: How many of the model's refusals the error lists before it says how many more there are.
MAX_LISTED_ERRORS = 20


class OutputValidationError(AppError):
    """A run's result that the output model `binding.py` names refuses."""


def narrow_output(results: RunResults, *, output_model: type[BaseModel], output_is_list: bool, resume_hint: str | None = None) -> Any:
    """The payload to print for a run, once the output model has accepted it.

    `resume_hint` is the command that fetches the result again, for a run that can be resumed, which
    the hint names after the regeneration.

    Raises:
        OutputShapeError: The binding declares a plural output and the run's output is not one.
        OutputValidationError: The model refuses the result, naming every field that failed.
    """
    payload = result_payload(results, output_is_list=output_is_list)
    validator: TypeAdapter[Any] = TypeAdapter(list[output_model]) if output_is_list else TypeAdapter(output_model)
    try:
        validator.validate_python(payload)
    except ValidationError as exc:
        errors = exc.errors()
        lines = tuple(f"{_location(error['loc'])}: {error['msg']}" for error in errors[:MAX_LISTED_ERRORS])
        if len(errors) > MAX_LISTED_ERRORS:
            lines = (*lines, f"…and {len(errors) - MAX_LISTED_ERRORS} more.")
        shape = f"a list of {output_model.__name__}" if output_is_list else output_model.__name__
        first = _location(errors[0]["loc"])
        msg = f"Run {results.pipeline_run_id} returned a result that {shape} refuses, first at {first}, so it is not printed."
        then = f", then fetch the result again with `{resume_hint}`" if resume_hint else ""
        hint = f"The method changed since the tree was generated: run `make codegen` and update binding.py{then}."
        raise OutputValidationError(msg, hint=hint, details=lines) from exc
    return payload


def _location(loc: tuple[int | str, ...]) -> str:
    """A field's location as a person reads it: `items[2].title`, or `the result` for the whole of it."""
    rendered = ""
    for part in loc:
        rendered += f"[{part}]" if isinstance(part, int) else (f".{part}" if rendered else part)
    return rendered or "the result"
