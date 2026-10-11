from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

from pydantic import ValidationError

if TYPE_CHECKING:
    from collections.abc import Callable

    from pydantic import ValidatorFunctionWrapHandler

T = TypeVar("T")


def none_when_it_does_not_fit(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
    """Validate `value`, or read it as `None` when it does not fit its declared type.

    The wrap validator of every leniently read wire field: a run's stored error report
    (`pipelex_sdk.error_models`) and a status read's degradation (`pipelex_sdk.runs`).
    """
    try:
        return handler(value)
    except ValidationError:
        return None


def empty_list_factory_of(_: type[T]) -> Callable[[], list[T]]:
    def _factory() -> list[T]:
        return []

    return _factory
