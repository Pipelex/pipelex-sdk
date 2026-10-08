"""Method selectors: a stored method's catalog id with an optional version suffix.

A bare `mt_…` names the method's latest published version, `mt_…@<n>` the fixed version `n`,
and `mt_…@draft` its draft. The run routes and the tooling routes take a selector as their
`method_id`, and the platform resolves it. The method routes (`get_method`, `write_draft`,
`rename_method`, `publish_method`, the version reads) take the bare id and address the method
itself, so a caller holding a selector strips it here first. The twin of `@pipelex/sdk`'s
`parseMethodSelector`.

The grammar is the hosted platform's, case-sensitive::

    selector  = method-id [ "@" ( version / "draft" ) ]
    method-id = "mt_" 1*( ALPHA / DIGIT / "_" / "-" )
    version   = %x31-39 *DIGIT   ; a positive decimal integer without a leading zero
"""

from __future__ import annotations

import re
from typing import Literal, cast

from pydantic import BaseModel, ConfigDict

from pipelex_sdk.errors import RequestArgumentError

#: A catalog id, which never contains an `@`. Explicit ASCII classes: `\w` and `\d` would admit
#: Unicode letters and digits the platform refuses.
_METHOD_ID_PATTERN = re.compile(r"mt_[A-Za-z0-9_-]+")

#: A version number: a positive decimal integer without a leading zero.
_VERSION_PATTERN = re.compile(r"[1-9][0-9]*")

#: The suffix that names a method's draft, in lower case only.
_DRAFT_SUFFIX = "draft"


class ParsedMethodSelector(BaseModel):
    """A method selector split into the bare id and the version it names."""

    model_config = ConfigDict(frozen=True)

    method_id: str
    """The bare catalog id — what the method routes and the run history take."""

    version: int | Literal["draft"] | None
    """The version the suffix names: its number for `mt_…@<n>`, `"draft"` for `mt_…@draft`, and
    `None` for a bare id, which names the latest published version."""


def parse_method_selector(selector: str) -> ParsedMethodSelector:
    """Split a method selector into its bare catalog id and the version it names.

    `parse_method_selector("mt_abc")` is `ParsedMethodSelector(method_id="mt_abc", version=None)`,
    `"mt_abc@3"` gives `version=3` and `"mt_abc@draft"` gives `version="draft"`. Nothing is sent:
    it is the local half of what the platform does at its edge.

    Raises:
        RequestArgumentError: The value is not a selector: an id that is not `mt_` followed by
            letters, digits, `_` or `-`, or a suffix the platform refuses with a `422` — an empty
            one, `@0`, a number with a leading zero or a sign, any word but `draft`, `draft` in
            another case, or two suffixes. Also for a value that is not a `str` at all. Its
            verdict is `input`, not retryable: the selector, which may come from a model's tool
            arguments, is what must change.
    """
    # Checked as an `object`: the annotation is a promise to the type checker, not to a caller
    # forwarding an optional id or a value read from JSON.
    candidate = cast("object", selector)
    if not isinstance(candidate, str):
        msg = f"parse_method_selector() takes a method selector string (mt_…); got {type(candidate).__name__}."
        raise RequestArgumentError(msg)
    method_id, separator, suffix = selector.partition("@")
    if _METHOD_ID_PATTERN.fullmatch(method_id) is None:
        msg = f'"{selector}" is not a method selector: a catalog id is mt_ followed by letters, digits, _ or -.'
        raise RequestArgumentError(msg)
    if not separator:
        return ParsedMethodSelector(method_id=method_id, version=None)
    if suffix == _DRAFT_SUFFIX:
        return ParsedMethodSelector(method_id=method_id, version="draft")
    if _VERSION_PATTERN.fullmatch(suffix) is None:
        msg = f'"{selector}" names no version: the suffix of a catalog id is @<version>, a positive number without a leading zero, or @draft.'
        raise RequestArgumentError(msg)
    try:
        version = int(suffix)
    except ValueError as exc:
        # Only past the interpreter's integer-string conversion limit, thousands of digits long.
        msg = f'"{selector}" names a version number too long to read.'
        raise RequestArgumentError(msg) from exc
    return ParsedMethodSelector(method_id=method_id, version=version)
