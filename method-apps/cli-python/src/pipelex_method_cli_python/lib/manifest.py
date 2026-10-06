"""The `method.json` manifest: how a method that lives elsewhere is named.

The method's directory, `method/` inside the package, holds either a bundle (`.mthds` files) or this
one-line manifest naming a hosted catalog id (`method_id`) or a published address (`method_ref`). It
is read at both ends of the method's life: the codegen reads it to regenerate the typed models, and
every run reads it to name the method it runs. One reader for both is what keeps them from
disagreeing, so editing the tag and regenerating moves the models and the run to the new version
together.

The reader takes the manifest's text rather than a path, because the run reads it through
`importlib.resources`, which is what lets an installed wheel find it with no repository around it.
"""

import json
from typing import Any, NamedTuple, cast

from pipelex_method_cli_python.lib.app import AppError

#: The manifest that names a method living elsewhere, the second kind of method source.
MANIFEST_FILENAME = "method.json"

#: The two keys a `method.json` may name, exactly one of which it must.
SELECTOR_METHOD_ID = "method_id"
SELECTOR_METHOD_REF = "method_ref"
SELECTOR_KEYS = (SELECTOR_METHOD_ID, SELECTOR_METHOD_REF)


class ManifestError(AppError):
    """A `method.json` that does not name exactly one method: reported, never guessed at."""


class MethodSelector(NamedTuple):
    """How a method that lives elsewhere is named: a hosted catalog id, or a published address.

    Exactly one is set. The pair mirrors the SDK's own exclusive choice (`mthds_contents`,
    `method_id`, `method_ref`) without the inline arm, which a manifest never carries.
    """

    method_id: str | None = None
    method_ref: str | None = None


def parse_manifest(text: str, *, origin: str) -> MethodSelector:
    """Read a `method.json`'s text into the selector it names.

    Args:
        text: The manifest's content.
        origin: Where it was read from, named in every refusal.

    Raises:
        ManifestError: The text is not a JSON object, or it names neither or both of `method_id` and
            `method_ref`, or the value it names is not a non-empty string.
    """
    try:
        payload: Any = json.loads(text)
    except json.JSONDecodeError as exc:
        msg = f"{origin}: not valid JSON ({exc})"
        raise ManifestError(msg) from exc
    if not isinstance(payload, dict):
        msg = f'{origin}: must be a JSON object, such as {{"method_ref": "github.com/owner/repo/package@v1.0.0"}}'
        raise ManifestError(msg)
    document = cast("dict[str, Any]", payload)
    named = {key: value for key, value in document.items() if key in SELECTOR_KEYS}
    if len(named) != 1:
        msg = f"{origin}: names exactly one of {' or '.join(SELECTOR_KEYS)}; found {sorted(document) or 'nothing'}"
        raise ManifestError(msg)
    key, value = next(iter(named.items()))
    if not isinstance(value, str) or not value.strip():
        msg = f"{origin}: `{key}` must be a non-empty string"
        raise ManifestError(msg)
    if key == SELECTOR_METHOD_ID:
        return MethodSelector(method_id=value.strip())
    return MethodSelector(method_ref=value.strip())


def render_manifest(selector: MethodSelector) -> str:
    """A `method.json`'s text holding exactly the selector and nothing else."""
    named = {key: value for key, value in ((SELECTOR_METHOD_ID, selector.method_id), (SELECTOR_METHOD_REF, selector.method_ref)) if value is not None}
    return json.dumps(named, indent=2) + "\n"
