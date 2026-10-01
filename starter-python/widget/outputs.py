"""Read a run's main output — shared by every execution mode.

Reading the output is orthogonal to *how* a run is executed, so this lives beside
`widget/inputs.py`, `widget/errors.py` and `widget/usage.py` rather than in one of the mode
packages, which never share lifecycle code with each other.

There is exactly one function here, and it exists for one reason: a **plural** output
(a pipe whose output multiplicity is not `single`) arrives in two different shapes
depending on the execution path, not on the method. The blocking `execute` response
carries the pydantic dump of the runtime's list content — a `{"items": [...]}` envelope —
and so does a durable run whose element concept the worker can hydrate; a durable run of
a concept the method declares itself falls back to the transport dump, which is a bare
array. A command that declared either shape would work in one mode and fail in another
with a validation error naming the wrong thing.

`list_items` accepts both and hands back the elements, so the generated model owns the
verdict on every element and no output shape is written by hand anywhere in this starter.
It is the Python twin of `pipelex-starter-js`'s `wireListOutput`, and like it, it is a
workaround with an expiry: when the runtime settles on one shape for a plural output, this
function becomes a one-liner or goes away. A **single** output needs nothing from here —
`Model.model_validate(main_stuff)` is the whole story, which is what the demos do.
"""

from typing import Any, cast

#: The key the runtime's list content dumps its elements under when it dumps as an object.
ITEMS_KEY = "items"


def list_items(main_stuff: object) -> list[Any]:
    """Return the elements of a plural output, whichever of its two wire shapes arrived.

    A bare list is its own element sequence; a mapping carrying `items` is the envelope
    and its `items` are the elements. Anything else is a shape neither path produces, and
    it is raised rather than coerced: the caller is about to validate each element against
    a generated model, and silently wrapping a single object in a list would turn a real
    protocol surprise into a confusing per-field validation error one frame later.

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
