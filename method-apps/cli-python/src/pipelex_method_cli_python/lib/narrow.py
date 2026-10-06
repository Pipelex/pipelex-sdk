"""Check a run's result against the method's generated model before it is printed.

`binding.py` names the model the pipe's output is validated against, `OUTPUT_MODEL`, imported from
the tree `make codegen` writes. A method that changed on the server without the tree being
regenerated returns a result the model no longer describes, and this is where that is caught: the
result is validated against the model, a plural one element by element after `list_items` has read
it out of whichever of its two wire shapes arrived (`lib/output.py`).

**The validation is strict, and reads the result as the JSON it arrived as.** A lax validation
would coerce a value into the type a field declares, so `"12"` would pass an `int` field and `"yes"`
a `bool`, and the payload printed would not be the one the model describes. Strict validation in
JSON mode refuses those, and still takes what JSON carries for the types it cannot spell: an ISO 8601
string for a date, a date and time or a time, an enumeration's value, and an integer for a float.

The model is a check, never a filter. What is printed is the payload as the method produced it, so
a field the model does not declare is kept and nothing is reordered, and a result the model refuses
is not printed at all: the error names every field that failed, and the hint says how to
regenerate and fetch the result again.

**An optional output may be absent.** A pipe whose output contract says `optional` may succeed
without producing it, and the run then delivers the runtime's absence document, `{"absent": true,
"variable_name": …, "kind": …, "reason": …, "producing_pipe": …, "upstream": …}`, or nothing at
all, in place of the output. That is the method working as declared, so it is not refused: the
result is `null`, and the caller says why on stderr. The same document from a pipe whose output is
not optional is refused as any other result the model does not describe.

The document is recognised by its whole shape, exactly those keys each holding the type the
runtime writes, and never by its `absent` key alone: a model of the method's own may declare an
`absent` field, and a payload of it is data. Validating against the model first would not tell the
two apart either, since a generated model ignores the keys it does not declare and an opaque one
allows them, so the absence document would pass as data.
"""

import json
from typing import Any, NamedTuple, cast

from pipelex_sdk.runs import RunResults
from pydantic import BaseModel, TypeAdapter, ValidationError

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.output import result_payload

#: How many of the model's refusals the error lists before it says how many more there are.
MAX_LISTED_ERRORS = 20

#: The key the runtime's absence document carries, `true`, beside the record of the absence.
ABSENT_KEY = "absent"

#: The key of the absence document that says why the output is absent.
REASON_KEY = "reason"

#: Every key of the runtime's absence document and no other: `absent`, then the fields of the
#: runtime's `AbsenceRecord`, which forbids extra ones and writes each of them, `null` included.
ABSENCE_KEYS = frozenset({ABSENT_KEY, "variable_name", "kind", REASON_KEY, "producing_pipe", "upstream"})

#: The values the absence document's `kind` takes, the runtime's `AbsenceKind`.
ABSENCE_KINDS = frozenset({"declared_absent", "skipped", "not_provided"})


class OutputValidationError(AppError):
    """A run's result that the output model `binding.py` names refuses."""


class NarrowedOutput(NamedTuple):
    """What the command prints for a run, once its output has been checked."""

    #: The JSON value stdout carries: the payload as the method produced it, or `None` for an absent optional output.
    payload: Any
    #: Whether the method left its optional output absent, which stdout says as `null`.
    absent: bool = False
    #: Why the output is absent, when the runtime's absence document says.
    absence_reason: str | None = None


def is_absence(main_stuff: object) -> bool:
    """Whether a run's main output is the absence of one: nothing, or the runtime's absence document.

    The document is matched by its whole shape, exactly `ABSENCE_KEYS` with the types the runtime
    writes, so that a payload which merely carries `"absent": true` is never taken for one.
    """
    if main_stuff is None:
        return True
    if not isinstance(main_stuff, dict):
        return False
    document = cast("dict[str, Any]", main_stuff)
    if document.keys() != ABSENCE_KEYS:
        return False
    kind: object = document["kind"]
    producing_pipe: object = document["producing_pipe"]
    upstream: object = document["upstream"]
    return (
        document[ABSENT_KEY] is True
        and isinstance(document["variable_name"], str)
        and isinstance(kind, str)
        and kind in ABSENCE_KINDS
        and isinstance(document[REASON_KEY], str)
        and (producing_pipe is None or isinstance(producing_pipe, str))
        and (upstream is None or isinstance(upstream, dict))
    )


def narrow_output(
    results: RunResults, *, output_model: type[BaseModel], output_is_list: bool, output_optional: bool, resume_hint: str | None = None
) -> NarrowedOutput:
    """What to print for a run, once the output model has accepted it or the absence of an optional output was found.

    `output_optional` is the pipe's output contract's `optional`, under which an absent output is a
    success. `resume_hint` is the command that fetches the result again, for a run that can be
    resumed, which the hint names after the regeneration.

    Raises:
        OutputShapeError: The binding declares a plural output and the run's output is not one.
        OutputValidationError: The model refuses the result, naming every field that failed.
    """
    if output_optional and is_absence(results.main_stuff):
        return NarrowedOutput(payload=None, absent=True, absence_reason=_absence_reason(results.main_stuff))
    payload = result_payload(results, output_is_list=output_is_list)
    validator: TypeAdapter[Any] = TypeAdapter(list[output_model]) if output_is_list else TypeAdapter(output_model)
    try:
        validator.validate_json(json.dumps(payload), strict=True)
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
    return NarrowedOutput(payload=payload)


def _absence_reason(main_stuff: object) -> str | None:
    """The reason an absence document gives, when it gives one as text."""
    if not isinstance(main_stuff, dict):
        return None
    reason: object = cast("dict[str, Any]", main_stuff).get(REASON_KEY)
    if not isinstance(reason, str):
        return None
    return reason.strip() or None


def _location(loc: tuple[int | str, ...]) -> str:
    """A field's location as a person reads it: `items[2].title`, or `the result` for the whole of it."""
    rendered = ""
    for part in loc:
        rendered += f"[{part}]" if isinstance(part, int) else (f".{part}" if rendered else part)
    return rendered or "the result"
