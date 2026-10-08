"""How the command names a method and a pipe: the forms of `--method`, the qualified form of
`--pipe`, and the names and quoting `script` derives from them.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import TypeAlias

from pipelex_sdk.command.io import usage_error
from pipelex_sdk.errors import RequestArgumentError
from pipelex_sdk.method_selector import parse_method_selector

#: The prefix of a published method's address.
ADDRESS_PREFIX = "github.com/"
#: The prefix of a stored method's catalog id.
CATALOG_ID_PREFIX = "mt_"

_NOT_A_NAME_CHARACTER = re.compile(r"[^a-z0-9]+")
#: A catalog id without its version suffix: `mt_` and the characters the API's run route accepts.
_CATALOG_ID_SHAPE = re.compile(r"mt_[A-Za-z0-9_-]+")
#: The largest version number the JavaScript twin reads exactly, `Number.MAX_SAFE_INTEGER`. Python
#: reads any, but both commands answer the same `--method` with the same line, so this one refuses
#: what that one cannot address, and by the length of its digits first, so that a suffix too long
#: for `int()` gets the same refusal rather than another.
_LARGEST_EXACT_VERSION = 2**53 - 1
_VERSION_DIGITS = re.compile(r"[1-9][0-9]*")


@dataclass(frozen=True)
class AddressSelector:
    method_ref: str


@dataclass(frozen=True)
class CatalogSelector:
    method_id: str


@dataclass(frozen=True)
class PathSelector:
    path: str


#: A `--method` value, told apart by its shape alone.
MethodSelector: TypeAlias = AddressSelector | CatalogSelector | PathSelector


def classify_method(value: str) -> MethodSelector:
    """Tell a `--method` value's form by its shape: `mt_…` is a catalog id, `github.com/…` an address,
    and anything else a path to a `.mthds` file or a bundle directory. A file or directory that happens
    to be named `mt_…` is reached as `./mt_…`, so that what a value names never depends on what the
    current directory holds.

    A catalog id may carry a version suffix, `mt_…@<n>` for a fixed published version or
    `mt_…@draft` for the draft; it is kept whole, since the API resolves it.

    Raises:
        CommandError: A usage error for an `mt_…` value whose id holds a character no catalog id
            holds (a letter, a digit, `_` or `-`), such as `mt_review.mthds`, which is a path written
            without its `./`; and for a version suffix the selector grammar refuses, with the
            grammar's own reason — a suffix that is neither a positive number without a leading zero
            nor `draft`, or a number too large to address exactly. Both name the `./` form too, since
            an `mt_…` value such as `mt_review@v2.mthds` may be a path written without it.
    """
    if value.startswith(CATALOG_ID_PREFIX):
        bare_id, _, suffix = value.partition("@")
        path_hint = f"To name a local file or directory whose name starts with mt_, write it as ./{value}."
        if _CATALOG_ID_SHAPE.fullmatch(bare_id) is None:
            msg = f'--method "{value}" is not a catalog id: a catalog id holds only letters, digits, _ and -.'
            raise usage_error(msg, [path_hint])
        # The id is well formed, so the selector grammar refuses the suffix alone, and the message
        # says which way: a suffix of no known form, or a number too large to address exactly.
        problem = _version_problem(value, suffix)
        if problem is not None:
            msg = f"--method {problem}"
            raise usage_error(msg, [f"Pass {bare_id} for its latest published version, or {bare_id}@draft for its draft.", path_hint])
        return CatalogSelector(method_id=value)
    if value.startswith(ADDRESS_PREFIX):
        return AddressSelector(method_ref=value)
    return PathSelector(path=value)


def _version_problem(value: str, suffix: str) -> str | None:
    """Why a well-formed catalog id's version suffix names no version, in the selector grammar's own
    words, or `None` when it names one or there is none.
    """
    if _VERSION_DIGITS.fullmatch(suffix) is not None and (len(suffix) > len(str(_LARGEST_EXACT_VERSION)) or int(suffix) > _LARGEST_EXACT_VERSION):
        return f'"{value}" names a version number too large to address exactly.'
    try:
        parse_method_selector(value)
    except RequestArgumentError as exc:
        return str(exc)
    return None


def check_pipe_ref(value: str) -> None:
    """Hold `--pipe` to the qualified ref, `domain.pipe_code`, which the input preparation and the
    pipe I/O route require. A bare code is refused, and so is an `alias->domain.pipe_code` ref, which
    names a dependency package's pipe rather than one of the method's own.

    Raises:
        CommandError: A usage error naming the form `--pipe` takes.
    """
    if "->" in value:
        msg = f"--pipe \"{value}\" names a dependency package's pipe; name one of the method's own pipes as domain.pipe_code."
        raise usage_error(msg)
    if "." not in value:
        msg = f'--pipe takes a pipe\'s qualified ref, domain.pipe_code, and "{value}" has no domain.'
        raise usage_error(msg, [f"Write it as <domain>.{value}, the domain being the one its .mthds file declares."])


def has_control_character(value: str) -> bool:
    """Whether a value holds a control character, which no line of a written script may carry."""
    return any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)


def address_tag(method_ref: str) -> str | None:
    """An address's tag, the text after its last `@`, or `None` for an address with none. An empty tag
    counts as none.
    """
    at_index = method_ref.rfind("@")
    if at_index < 0:
        return None
    return method_ref[at_index + 1 :] or None


def address_name(method_ref: str) -> str:
    """An address's last path segment, without its tag: the default name of the script it gets."""
    at_index = method_ref.rfind("@")
    base = method_ref if at_index < 0 else method_ref[:at_index]
    segments = [segment for segment in base.split("/") if segment]
    return segments[-1] if segments else ""


def kebab_case(text: str) -> str:
    """A catalog method's name as a script's file name: decomposed (NFKD), stripped of its combining
    marks, lowercased, every run of characters outside `a-z` and `0-9` turned into one `-`, and
    trimmed of `-` at both ends. `Résumé Review (v2)` becomes `resume-review-v2`; a name of no letter
    or digit becomes the empty string.
    """
    decomposed = unicodedata.normalize("NFKD", text)
    unmarked = "".join(character for character in decomposed if not unicodedata.category(character).startswith("M"))
    return _NOT_A_NAME_CHARACTER.sub("-", unmarked.lower()).strip("-")


def script_name_problem(name: str) -> str | None:
    """Why a script's file name cannot be used, or `None` when it can."""
    if not name:
        return "is empty"
    if name in {".", ".."}:
        return f'"{name}" names a directory'
    if "/" in name:
        return f'"{name}" holds a /, and --dir is where the script goes'
    # On every platform, so both commands refuse the same names: Windows reads a \ as a /, and
    # `..\outside` would leave --dir there.
    if "\\" in name:
        return f'"{name}" holds a \\, which Windows reads as a /, and --dir is where the script goes'
    if has_control_character(name):
        return "holds a control character"
    return None


def shell_quote(value: str) -> str:
    r"""A value as one single-quoted shell word, an inner `'` spelled `'\''`."""
    escaped = value.replace("'", "'\\''")
    return f"'{escaped}'"
