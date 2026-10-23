from __future__ import annotations

import json
import re

from mthds.protocol.problem.answers import DecodedBody, decode_json

#: A UTF-16 surrogate code point, which a Python string holds alone and no UTF-8 encoder accepts.
_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


def dumps_as_javascript(value: object) -> str:
    r"""A JSON-able value as `JSON.stringify` writes it, so a text reads the same from either SDK.

    `json.dumps` with `ensure_ascii` off and no spaces escapes exactly what `JSON.stringify` does — the
    quote, the backslash and the control characters, the latter as lowercase `\u00XX` — and keeps every
    other character as typed, except a surrogate standing alone: `JSON.stringify` escapes it as `\udXXX`,
    and left raw it would make the text a string no UTF-8 encoder accepts. Its two writers are a file path
    built from an output's keys (`pipelex_sdk.artifacts`) and a request body holding such a surrogate
    (`pipelex_sdk.client`), which pydantic's `to_json` refuses to write.

    Args:
        value: The value, made of what `json.dumps` writes: strings, numbers, booleans, `None`, lists and
            string-keyed dicts.

    Returns:
        The JSON text, every lone surrogate escaped.
    """
    dumped = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", dumped)


def decode_json_as_written(text: str) -> DecodedBody:
    """Decode a body by the rules the protocol reads a problem body by, its numbers kept as written.

    The base's guarded decoder (`mthds.protocol.problem.answers.decode_json`) decides whether the body
    is JSON the protocol reads: one nested deeper than `MAX_BODY_NESTING`, or holding `NaN`, `Infinity`
    or a number past the range of a double, is not, where `json.loads` would accept the constants and
    raise `RecursionError` on the nesting. That decoder reads an integral number such as `2.0` as the
    integer `2`, as a JavaScript reader sees it, so a body it accepts is read again by `json.loads`,
    which keeps every number as written: a pipe output's `10.0` stays a float. The guards keep the
    reading in step with `@pipelex/sdk`, which holds every body to `parseJsonBody`. The reader of a 2xx
    answer uses it (`pipelex_sdk.client`).

    Args:
        text: The body, as text.

    Returns:
        The decoded body; `is_json` is false, and `value` `None`, for a body the protocol does not read.
    """
    if not decode_json(text).is_json:
        return DecodedBody(is_json=False, value=None)
    return DecodedBody(is_json=True, value=json.loads(text))
