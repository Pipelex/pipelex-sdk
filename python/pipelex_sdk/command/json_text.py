r"""A run's output as JSON text, byte for byte what `@pipelex/sdk`'s command prints for the same answer.

The JavaScript command prints `JSON.stringify(value, null, 2)`. `json.dumps(value, indent=2,
ensure_ascii=False)` agrees with it on the layout and on the escapes of quotes, backslashes and
control characters, and parts from it in three places this module follows JavaScript on:

- **Numbers that are not integers in Python.** A JSON number written with a fraction or an exponent
  reads as a float, which Python prints as `1.0` and `1e+16` where JavaScript prints `1` and
  `10000000000000000`. The shortest digits that read back as the same double are the same in both
  languages; only their layout differs, and `_number` lays them out as ECMAScript's
  `Number.prototype.toString` does. `-0` prints `0`, and a value that is not finite prints `null`.
- **Lone surrogates.** A string read from JSON can hold an unpaired `\ud800` escape; JavaScript writes
  it back as that escape, where Python would write the code point raw, which no UTF-8 stream can carry.
- **Nothing else is guessed.** An integer keeps every digit, where JavaScript has already rounded one
  beyond 2^53 when it read the answer, and an object keeps its keys in the order the answer gave them,
  where JavaScript prints integer-like keys first. Both differences come from how JavaScript reads
  JSON rather than how it prints it, and printing the answer as it came is the better of the two.
"""

from __future__ import annotations

import math
import re
from typing import Any, cast

_INDENT = "  "
# The positions at which ECMAScript's `Number.prototype.toString` stops writing a number out in full.
_LARGEST_PLAIN_EXPONENT = 21
_SMALLEST_PLAIN_EXPONENT = -6

_ESCAPED = re.compile(r'["\\\x00-\x1f\ud800-\udfff]')
_SHORT_ESCAPES: dict[str, str] = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def to_json_text(value: Any) -> str:
    """`value`, a document read from JSON, as two-space-indented JSON text, as JavaScript prints it.

    Raises:
        TypeError: `value` holds something JSON cannot hold.
    """
    return _value(value, "")


def _value(value: Any, indent: str) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    inner = f"{indent}{_INDENT}"
    if isinstance(value, list):
        elements = cast("list[Any]", value)
        if not elements:
            return "[]"
        lines = ",\n".join(f"{inner}{_value(element, inner)}" for element in elements)
        return f"[\n{lines}\n{indent}]"
    if isinstance(value, dict):
        members = cast("dict[str, Any]", value)
        if not members:
            return "{}"
        lines = ",\n".join(f"{inner}{_string(str(key))}: {_value(member, inner)}" for key, member in members.items())
        return f"{{\n{lines}\n{indent}}}"
    msg = f"A {type(value).__name__} is not a JSON value."
    raise TypeError(msg)


def _string(text: str) -> str:
    return f'"{_ESCAPED.sub(_escape, text)}"'


def _escape(match: re.Match[str]) -> str:
    character = match.group()
    return _SHORT_ESCAPES.get(character) or f"\\u{ord(character):04x}"


def _number(value: float) -> str:
    """A float laid out as ECMAScript's `Number.prototype.toString` lays it out."""
    if not math.isfinite(value):
        return "null"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # `repr` gives the shortest digits that read back as the same double, as ECMAScript requires.
    mantissa, _, exponent_text = repr(abs(value)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = f"{whole}{fraction}"
    # The value is 0.<digits> x 10^point, once the leading and trailing zeros are dropped.
    point = len(whole) + (int(exponent_text) if exponent_text else 0)
    significant = digits.lstrip("0")
    point -= len(digits) - len(significant)
    significant = significant.rstrip("0")
    count = len(significant)
    if count <= point <= _LARGEST_PLAIN_EXPONENT:
        return f"{sign}{significant}{'0' * (point - count)}"
    if 0 < point <= _LARGEST_PLAIN_EXPONENT:
        return f"{sign}{significant[:point]}.{significant[point:]}"
    if _SMALLEST_PLAIN_EXPONENT < point <= 0:
        return f"{sign}0.{'0' * -point}{significant}"
    exponent = point - 1
    exponent_part = f"e+{exponent}" if exponent >= 0 else f"e-{-exponent}"
    if count == 1:
        return f"{sign}{significant}{exponent_part}"
    return f"{sign}{significant[0]}.{significant[1:]}{exponent_part}"
