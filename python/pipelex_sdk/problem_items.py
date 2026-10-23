"""How the SDK reads the problem items a verdict lists: the `errors` of an invalid validate verdict
(`PipelexInvalidReport`), of an invalid crate verdict (`CrateInvalidReport`) and of a pipe I/O answer that does not
load, and the `warnings` of a valid validate verdict. `@pipelex/sdk` reads them the same way in its
`problem-items.ts`.

The items are read tolerantly, member by member, so that one malformed member never costs the caller the fault it
belongs to: an entry that is no object, or whose `code` or `detail` is not a string, names no fault and is
skipped, and each optional member the standard declares (`params`, `location`, `suggestions`, `suggested_fix`) is
kept only when the standard's own model accepts it (`mthds.protocol.problem.models.ProblemItem`), and left out of
its item otherwise. A member the standard does not declare is kept as received, and so is a `code` that breaks the
standard's code pattern. An entry that already is a `ProblemItem`, as when a caller constructs a verdict in code, was
checked when it was made and is kept as it is.
"""

from __future__ import annotations

from typing import Annotated, Any, TypeAlias, cast

from mthds.protocol.problem.models import ProblemItem
from pydantic import BeforeValidator, ValidationError

#: The members of an item the standard declares and checks, beyond `code` and `detail`.
_CHECKED_MEMBERS: frozenset[str] = frozenset({"params", "location", "suggestions", "suggested_fix"})

#: A code the standard accepts, standing in for an item's own while its members are checked, so that an item whose
#: code breaks the code pattern still keeps its well-formed members.
_PROBE_CODE = "client.argument_invalid"


def _member_fits(*, name: str, value: object) -> bool:
    """Whether `value` is well-formed as the item member `name`, by the standard's own model."""
    try:
        ProblemItem.model_validate({"code": _PROBE_CODE, "detail": "", name: value})
    except ValidationError:
        return False
    return True


def read_problem_item(entry: object) -> ProblemItem | None:
    """One entry of a verdict's `errors` or `warnings` read as a problem item.

    Args:
        entry: The entry as the answer gave it.

    Returns:
        The item, or `None` when the entry names no fault: it is no object, or its `code` or `detail` is no string. An
        entry that already is a `ProblemItem` is returned as it is.
    """
    if isinstance(entry, ProblemItem):
        return entry
    if not isinstance(entry, dict):
        return None
    members = cast("dict[str, Any]", entry)
    code: object = members.get("code")
    detail: object = members.get("detail")
    if not isinstance(code, str) or not isinstance(detail, str):
        return None
    kept: dict[str, Any] = {name: value for name, value in members.items() if name not in _CHECKED_MEMBERS or _member_fits(name=name, value=value)}
    # Every member is well-formed now but the code, which is checked under the probe and given back after.
    return ProblemItem.model_validate({**kept, "code": _PROBE_CODE}).model_copy(update={"code": code})


def read_problem_items(entries: object) -> list[ProblemItem]:
    """A verdict's `errors` or `warnings` read as problem items; anything but a list reads as none.

    Args:
        entries: The list as the answer gave it.

    Returns:
        Each entry that names a fault, read as a problem item, in the answer's order.
    """
    if not isinstance(entries, list):
        return []
    items: list[ProblemItem] = []
    for entry in cast("list[object]", entries):
        item = read_problem_item(entry)
        if item is not None:
            items.append(item)
    return items


ProblemItems: TypeAlias = Annotated[list[ProblemItem], BeforeValidator(read_problem_items)]
"""A verdict's `errors` or `warnings` as a model member: the list as it arrived, read by `read_problem_items`, so a
malformed entry or member never fails the verdict that carries it."""
