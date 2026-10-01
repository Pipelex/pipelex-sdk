"""The `method.json` manifest — how a method that lives elsewhere is named.

A directory under `widget/methods/` holds either a bundle (`.mthds` files) or this one-line
manifest naming a hosted catalog id (`method_id`) or a published address (`method_ref`). It lives
in the package rather than in `scripts/` because it is read at both ends of a method's life:
`make codegen` reads it to regenerate the typed models, and a command written by `make add-method`
reads it every time it runs. One reader for both is what keeps them from disagreeing — editing
the tag and running `make codegen` moves the models and the run to the new version together.
"""

import json
from pathlib import Path
from typing import Any, NamedTuple, cast

#: The manifest that names a method living elsewhere — the second source kind. It sits inside the
#: method's directory under `widget/methods/`, so the two kinds are discovered by one walk.
MANIFEST_FILENAME = "method.json"

#: The two keys a `method.json` may name, exactly one of which it must.
SELECTOR_METHOD_ID = "method_id"
SELECTOR_METHOD_REF = "method_ref"
SELECTOR_KEYS = (SELECTOR_METHOD_ID, SELECTOR_METHOD_REF)


class ManifestError(ValueError):
    """A `method.json` that does not name exactly one method — reported, never guessed at."""


class MethodSelector(NamedTuple):
    """How a method that lives elsewhere is named: a hosted catalog id, or a published address.

    Exactly one is set. The pair mirrors the SDK's own three-way XOR (`files` / `method_id` /
    `method_ref`) minus the inline arm, which a manifest never carries.
    """

    method_id: str | None = None
    method_ref: str | None = None


def read_manifest(path: Path) -> MethodSelector:
    """Read a `method.json` into the selector it names.

    Raises:
        ManifestError: The file is not a JSON object, or it names neither or both of
            `method_id` / `method_ref`, or the value it names is not a non-empty string.
    """
    try:
        payload: Any = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        msg = f"{path}: not valid JSON — {exc}"
        raise ManifestError(msg) from exc
    if not isinstance(payload, dict):
        msg = f'{path}: must be a JSON object, e.g. {{"method_ref": "github.com/owner/repo/package@v1.0.0"}}'
        raise ManifestError(msg)
    document = cast("dict[str, Any]", payload)
    named = {key: value for key, value in document.items() if key in SELECTOR_KEYS}
    if len(named) != 1:
        msg = f"{path}: names exactly one of {' or '.join(SELECTOR_KEYS)}; found {sorted(document) or 'nothing'}"
        raise ManifestError(msg)
    key, value = next(iter(named.items()))
    if not isinstance(value, str) or not value.strip():
        msg = f"{path}: `{key}` must be a non-empty string"
        raise ManifestError(msg)
    if key == SELECTOR_METHOD_ID:
        return MethodSelector(method_id=value.strip())
    return MethodSelector(method_ref=value.strip())


def write_manifest(path: Path, selector: MethodSelector) -> None:
    """Write a `method.json` holding exactly the selector and nothing else."""
    named = {key: value for key, value in ((SELECTOR_METHOD_ID, selector.method_id), (SELECTOR_METHOD_REF, selector.method_ref)) if value is not None}
    path.write_text(json.dumps(named, indent=2) + "\n", encoding="utf-8")
