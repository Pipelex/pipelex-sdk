"""How the command names a method and a pipe: the three forms of `--method`, the qualified form of
`--pipe`, and the names and quoting `script` derives from them.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import TypeAlias

from pipelex_sdk.command.io import usage_error

#: The prefix of a published method's address.
ADDRESS_PREFIX = "github.com/"
#: The prefix of a stored method's catalog id.
CATALOG_ID_PREFIX = "mt_"

_NOT_A_NAME_CHARACTER = re.compile(r"[^a-z0-9]+")
#: The characters a catalog id is made of, which the API's run route accepts and no other.
_CATALOG_ID_SHAPE = re.compile(r"[A-Za-z0-9_-]+")


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

    Raises:
        CommandError: A usage error for an `mt_…` value holding a character no catalog id holds (a
            letter, a digit, `_` or `-`), such as `mt_review.mthds`, which is a path written without
            its `./`.
    """
    if value.startswith(CATALOG_ID_PREFIX):
        if _CATALOG_ID_SHAPE.fullmatch(value) is None:
            msg = f'--method "{value}" is not a catalog id: a catalog id holds only letters, digits, _ and -.'
            raise usage_error(msg, [f"To name a local file or directory whose name starts with mt_, write it as ./{value}."])
        return CatalogSelector(method_id=value)
    if value.startswith(ADDRESS_PREFIX):
        return AddressSelector(method_ref=value)
    return PathSelector(path=value)


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
    if has_control_character(name):
        return "holds a control character"
    return None


def shell_quote(value: str) -> str:
    r"""A value as one single-quoted shell word, an inner `'` spelled `'\''`."""
    escaped = value.replace("'", "'\\''")
    return f"'{escaped}'"
