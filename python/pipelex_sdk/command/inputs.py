"""The inputs `--inputs` names: a JSON object, one entry per input, read from a file or, for `-`, from
stdin. It is the shape `mthds run --inputs` and `cli-python`'s `--inputs` take, and the shape
`--inputs-template` prints.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any, NoReturn, cast

from pipelex_sdk.command.bundle import system_reason
from pipelex_sdk.command.io import usage_error

if TYPE_CHECKING:
    from pipelex_sdk.command.io import CommandIO


_BYTE_ORDER_MARK = "\ufeff"


def _refuse_constant(constant: str) -> NoReturn:
    """Refuse `NaN`, `Infinity` and `-Infinity`, which Python's reader accepts and JSON does not, so an
    inputs file reads here exactly as `JSON.parse` reads it in the JavaScript command.
    """
    msg = f"{constant} is not a JSON value"
    raise ValueError(msg)


def read_inputs(source: str, io: CommandIO) -> dict[str, Any]:
    """Read and parse the inputs. A relative path resolves against the current directory.

    Raises:
        CommandError: A usage error for an unreadable file, text that is not UTF-8 or not JSON, and
            JSON that is not an object.
    """
    label = "stdin" if source == "-" else f'the inputs file "{source}"'
    data: bytes
    if source == "-":
        data = io.read_stdin()
    else:
        try:
            data = Path(os.path.abspath(source)).read_bytes()
        except OSError as exc:
            msg = f"cannot read {label}."
            raise usage_error(msg, [f"Reason: {system_reason(exc)}"]) from exc
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        msg = f"{label} is not UTF-8 text."
        raise usage_error(msg) from exc
    # A leading byte-order mark is dropped, as RFC 8259 lets a JSON reader do: Windows PowerShell 5.1
    # writes one with `Out-File -Encoding utf8`. A bundle's mark is kept, since it is sent as written.
    text = text.removeprefix(_BYTE_ORDER_MARK)
    try:
        parsed: Any = json.loads(text, parse_constant=_refuse_constant)
    except ValueError as exc:
        msg = f"{label} is not valid JSON."
        raise usage_error(msg, [f"Reason: {exc}"]) from exc
    if not isinstance(parsed, dict):
        msg = f"{label} must hold a JSON object, one entry per input, and holds {_json_kind(parsed)}."
        raise usage_error(msg, ["Run with --inputs-template to see the object this method takes."])
    return cast("dict[str, Any]", parsed)


def _json_kind(value: object) -> str:
    """What a JSON value is, said the way the refusal says it."""
    match value:
        case None:
            return "null"
        case list():
            return "an array"
        case str():
            return "a string"
        case bool():
            return "a boolean"
        case int() | float():
            return "a number"
        case _:
            return "not an object"
