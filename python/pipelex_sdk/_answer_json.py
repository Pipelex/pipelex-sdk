from __future__ import annotations

import json

from mthds.protocol.problem.answers import DecodedBody, decode_json


def decode_json_as_written(text: str) -> DecodedBody:
    """Decode a body by the rules the protocol reads a problem body by, its numbers kept as written.

    The base's guarded decoder (`mthds.protocol.problem.answers.decode_json`) decides whether the body
    is JSON the protocol reads: one nested deeper than `MAX_BODY_NESTING`, or holding `NaN`, `Infinity`
    or a number past the range of a double, is not, where `json.loads` would accept the constants and
    raise `RecursionError` on the nesting. That decoder reads an integral number such as `2.0` as the
    integer `2`, as a JavaScript reader sees it, so a body it accepts is read again by `json.loads`,
    which keeps every number as written: a pipe output's `10.0` stays a float. The guards keep the
    reading in step with `@pipelex/sdk`, which holds every body to `parseJsonBody`. Both readers of a
    body use it: a 2xx answer's (`pipelex_sdk.client`) and a refusal's members (`pipelex_sdk.error_models`).

    Args:
        text: The body, as text.

    Returns:
        The decoded body; `is_json` is false, and `value` `None`, for a body the protocol does not read.
    """
    if not decode_json(text).is_json:
        return DecodedBody(is_json=False, value=None)
    return DecodedBody(is_json=True, value=json.loads(text))
