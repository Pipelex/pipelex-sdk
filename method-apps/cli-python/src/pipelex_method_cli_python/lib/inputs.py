"""The run's inputs, as the command receives them.

The command takes `--inputs FILE`: a JSON object mapping each of the pipe's input names to its
value, in the shape `mthds run --inputs` and the inputs template use, a bare value or a
`{"concept": …, "content": …}` envelope per input. `-` reads it from stdin. The file is handed to
the API as it is: the API validates the inputs against the method's contract before any inference
runs, and its refusal names the input it could not take.

A later version of this module derives one option per declared input from the method's committed
input form, merged over the file, a flag given on the command line overriding that input from the
file. The command's own options are listed in `cli.py`, which is where the derived ones join them.
"""

import json
import sys
from pathlib import Path
from typing import Any, cast

from pipelex_method_cli_python.lib.app import AppError

#: The `--inputs` value that reads the inputs from stdin.
STDIN = "-"


class InputsFileError(AppError):
    """An inputs file that cannot be read, or that is not a JSON object."""


def read_inputs_file(path: Path) -> dict[str, Any]:
    """Read an inputs file, or stdin for `-`, into the inputs a run sends.

    Raises:
        InputsFileError: The file cannot be read, is not valid JSON, or is not a JSON object.
    """
    origin = "stdin" if str(path) == STDIN else str(path)
    try:
        text = sys.stdin.read() if str(path) == STDIN else path.read_text(encoding="utf-8")
    except OSError as exc:
        msg = f"Cannot read the inputs file {origin}: {exc.strerror or exc}."
        raise InputsFileError(msg, hint="Check that --inputs names a readable JSON file.") from exc
    except UnicodeDecodeError as exc:
        msg = f"The inputs file {origin} is not UTF-8 text."
        raise InputsFileError(msg, hint="--inputs takes a JSON file.") from exc
    try:
        payload: Any = json.loads(text)
    except json.JSONDecodeError as exc:
        msg = f"The inputs file {origin} is not valid JSON: {exc}."
        raise InputsFileError(msg, hint='--inputs takes a JSON object mapping each input name to its value, such as {"text": "Hello"}.') from exc
    if not isinstance(payload, dict):
        msg = f"The inputs file {origin} holds a JSON {type(payload).__name__}, not an object."
        raise InputsFileError(msg, hint='--inputs takes a JSON object mapping each input name to its value, such as {"text": "Hello"}.')
    return cast("dict[str, Any]", payload)
