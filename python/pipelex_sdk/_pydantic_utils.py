from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

from pydantic import ValidationError

if TYPE_CHECKING:
    from collections.abc import Callable

    from pydantic import ValidatorFunctionWrapHandler

T = TypeVar("T")


def none_when_it_does_not_fit(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
    """Validate `value`, or read it as `None` when it does not fit its declared type.

    The wrap validator of every leniently read wire field that reads as `None` when unset: a run's stored
    problem (`pipelex_sdk.answer_reading.LenientProblem`), a status read's degradation (`pipelex_sdk.runs`), a
    file use's creator and method version (`pipelex_sdk.product_models.FileUse`), a branding's style and
    typeface (`pipelex_sdk.product_models.OrganizationBranding`), and a stored layout's seed and style
    (`pipelex_sdk.method_layout_models.LayoutProvenance`).
    """
    try:
        return handler(value)
    except ValidationError:
        return None


def false_when_it_does_not_fit(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
    """Validate `value`, or read it as `False` when it does not fit its declared type.

    The wrap validator of a leniently read wire flag whose unset reading is `False`: a branding's white-label
    entitlement (`pipelex_sdk.product_models.OrganizationBranding`), where `None` or a value of another type
    reads as the entitlement not held.
    """
    try:
        return handler(value)
    except ValidationError:
        return False


def zero_when_it_does_not_fit(value: Any, handler: ValidatorFunctionWrapHandler) -> Any:
    """Validate `value`, or read it as `0` when it does not fit its declared type and bounds.

    The wrap validator of a leniently read wire count whose unset reading is `0`: a stored layout's repair rounds
    (`pipelex_sdk.method_layout_models.LayoutProvenance`), where a missing value, a negative one or one of another
    type reads as the platform's default.
    """
    try:
        return handler(value)
    except ValidationError:
        return 0


def empty_list_factory_of(_: type[T]) -> Callable[[], list[T]]:
    def _factory() -> list[T]:
        return []

    return _factory
