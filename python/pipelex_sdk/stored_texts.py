"""Which values of a run are stored texts, told by concept — the pure half of loading them.

Since the runtime's large-text storage, a `native.Text`, `native.Markdown`, `native.Html` or `native.JSON` value
past the runtime's inline threshold is stored under the run's scope and travels as its reference,
`{url, size, mime_type, preview}`, in place of its value field (`text`, `inner_html` or `json_obj`). Its `url` is a
`pipelex-storage://` address, exactly as an image's or a document's is, so a reader must tell a stored text from a
file, and the MTHDS standard rules how: by the concept at the value's path, never by its URL or its MIME type (a
`Document` may well be `text/plain`).

The concept at each path comes from the run's own artifacts:

```
main stuff's concept ── working_memory.aliases["main_stuff"] → working_memory.root[name].concept
  └── its structure ─── the first output_form / input_form node naming that concept,
                        which states each nested field's concept and refinement chain
        └── no node ─── the native's own shape: Page → TextAndImages → Text, Image
plural ─────────────── a `{"items": [...]}` content, unless the concept has a field `items`
```

A concept is a stored text when it, or a concept its `refines` chain names, is one of `STORED_TEXT_CONCEPT_REFS`.
Nothing here performs I/O: the walk is shared by the loader (`pipelex_sdk.artifacts.load_stored_texts`) and by the
file walkers (`locate_artifacts`, `collect_artifacts`), which skip a stored text rather than count it as a file.
Python counterpart of `pipelex-sdk-js`'s `src/stored-texts.ts`. See `docs/run-results.md`, "Stored texts".
"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Any, Final, cast

from mthds.protocol.input_form import InputFormItem, ListItem, ObjectItem
from pydantic import BaseModel, TypeAdapter

if TYPE_CHECKING:
    from collections.abc import Sequence

    from mthds.protocol.input_form import InputForm
    from mthds.protocol.output_form import OutputForm
    from mthds.runners.api.models import DictWorkingMemoryAbstract

    from pipelex_sdk.runs import RunResults

# ── Constants ────────────────────────────────────────────────────────

#: The concepts whose value the runtime stores past its inline threshold and carries as a reference.
STORED_TEXT_CONCEPT_REFS: Final[tuple[str, ...]] = ("native.Text", "native.Markdown", "native.Html", "native.JSON")

#: The fields of the referenced form, which the loaded form drops.
STORED_TEXT_REFERENCE_FIELDS: Final[tuple[str, ...]] = ("url", "size", "mime_type", "preview")


class StoredTextKind(StrEnum):
    """What a stored text holds once loaded: a text, an HTML fragment, or a JSON object."""

    TEXT = "text"
    HTML = "html"
    JSON = "json"

    @property
    def value_field(self) -> str:
        """The field a loaded value of this kind is carried in: the inline form's value field."""
        match self:
            case StoredTextKind.TEXT:
                return "text"
            case StoredTextKind.HTML:
                return "inner_html"
            case StoredTextKind.JSON:
                return "json_obj"


#: Every inline value field, which a reference lacks.
STORED_TEXT_VALUE_FIELDS: Final[tuple[str, ...]] = tuple(kind.value_field for kind in StoredTextKind)

_KIND_BY_CONCEPT: Final[dict[str, StoredTextKind]] = {
    "native.Text": StoredTextKind.TEXT,
    "native.Markdown": StoredTextKind.TEXT,
    "native.Html": StoredTextKind.HTML,
    "native.JSON": StoredTextKind.JSON,
}

_MAIN_STUFF_ALIAS: Final[str] = "main_stuff"

#: The domain of the natives: a concept whose chain reaches one is never text by the language's rule alone.
_NATIVE_PREFIX: Final[str] = "native."

#: The node kinds a text is described by: flowing text, and a short text under a `label` intent.
_TEXT_NODE_KINDS: Final[frozenset[str]] = frozenset({"prose", "text"})
_LIST_ITEMS_FIELD: Final[str] = "items"

#: The members of the native composites whose shape the walk knows without a descriptor, so a page's text is found
#: even when the run's forms are missing; a one-element tuple is a list of that concept.
_NATIVE_MEMBERS: Final[dict[str, dict[str, str | tuple[str]]]] = {
    "native.Page": {"text_and_images": "native.TextAndImages", "page_view": "native.Image"},
    "native.TextAndImages": {"text": "native.Text", "images": ("native.Image",)},
}

_NATIVE_FILE_KINDS: Final[dict[str, str]] = {"native.Image": "image", "native.Document": "document"}

#: The standard's node union, owned by `mthds`: a node built here is validated into it, as a parsed one would be.
_NODE_ADAPTER: Final[TypeAdapter[InputFormItem]] = TypeAdapter(InputFormItem)


# ── Concept tests ────────────────────────────────────────────────────


def stored_text_kind_of(concept_ref: str | None, refines: Sequence[str] | None = None) -> StoredTextKind | None:
    """The kind of stored text a concept holds, read off the concept itself and then its refinement chain (immediate
    parent first), or `None` for any other concept. `my.Memo refines native.Text` is `TEXT`; a `native.Document`,
    whatever its MIME type, is `None`.
    """
    for candidate in (concept_ref, *(refines or ())):
        if candidate is None:
            continue
        kind = _KIND_BY_CONCEPT.get(candidate)
        if kind is not None:
            return kind
    return None


def is_stored_text_concept(concept_ref: str | None, refines: Sequence[str] | None = None) -> bool:
    """Whether a concept, or one its refinement chain names, is a stored text — see `stored_text_kind_of`."""
    return stored_text_kind_of(concept_ref, refines) is not None


def stored_text_kind_of_node(node: InputFormItem | None) -> StoredTextKind | None:
    """The stored-text kind a descriptor node describes, or `None`: a list is never one, its items may be.

    A node is a stored text when its concept, or one its refinement chain names, is one of `STORED_TEXT_CONCEPT_REFS`,
    and also when its concept reaches no native at all and the node is text (`prose`, or `text` under a `label`
    intent): a description-only concept, or one refining such a concept, is text by the language's rule, and the
    runtime stores it as it stores a `native.Text`. A field typed by a bare field type carries no concept and is always
    inline.
    """
    if node is None or isinstance(node, ListItem):
        return None
    kind = stored_text_kind_of(node.concept_ref, node.refines)
    if kind is not None:
        return kind
    if node.concept_ref is None:
        return None
    chain = (node.concept_ref, *(node.refines or ()))
    if any(concept.startswith(_NATIVE_PREFIX) for concept in chain):
        return None
    return StoredTextKind.TEXT if node.kind in _TEXT_NODE_KINDS else None


# ── The node at each path ────────────────────────────────────────────


def main_stuff_node(results: RunResults) -> InputFormItem | None:
    """The descriptor node of a run's main output, the output-form node the standard states for it.

    It is found from the run's own artifacts: the main stuff's concept, which the working memory names, and that
    concept's structure, which the first `output_form` or `input_form` node naming it states (a concept's node is the
    same wherever it stands). A concept no form describes keeps the shape the walk knows of a native, and is
    otherwise opaque. A `{"items": [...]}` content is the plural envelope, unless the concept has a field called
    `items`.

    Returns:
        The node, or `None` when the results carry no working memory, or one naming no main stuff: nothing then says
        what the output is, so a walk guided by it treats every value alike.
    """
    memory = results.working_memory
    if memory is None:
        return None
    name = memory.aliases.get(_MAIN_STUFF_ALIAS, _MAIN_STUFF_ALIAS)
    stuff = memory.root.get(name)
    if stuff is None:
        return None
    return _content_node(stuff.concept, results.main_stuff, output_form=results.output_form, input_form=results.input_form)


def working_memory_node(results: RunResults) -> InputFormItem | None:
    """A descriptor node for a whole working memory (`{"root": ..., "aliases": ...}`): each stuff's `content`
    described by the concept that stuff names, as `main_stuff_node` describes the main one. Nothing else in the
    memory is concept-typed.
    """
    memory: DictWorkingMemoryAbstract | None = results.working_memory
    if memory is None:
        return None
    stuff_fields: list[dict[str, Any]] = []
    for stuff_name, stuff in memory.root.items():
        content = _content_node(stuff.concept, stuff.content, output_form=results.output_form, input_form=results.input_form)
        content_field = {**_dump(content), "name": "content"}
        stuff_fields.append({"kind": "object", "name": stuff_name, "required": True, "fields": [content_field]})
    root_field = {"kind": "object", "name": "root", "required": True, "fields": stuff_fields}
    return _NODE_ADAPTER.validate_python({"kind": "object", "required": True, "fields": [root_field]})


def child_node(node: InputFormItem | None, parent: Any, key: str | int) -> InputFormItem | None:
    """The node describing the child at `key` of a value described by `node`, or `None` when nothing describes it.

    A field of an object node, an item of a list node, and the `items` of the plural envelope a list content is
    serialized to, which the list node itself goes on describing.
    """
    if node is None:
        return None
    if isinstance(node, ListItem):
        if isinstance(parent, (list, tuple)):
            return node.item
        return node if key == _LIST_ITEMS_FIELD else None
    if isinstance(node, ObjectItem) and isinstance(key, str) and isinstance(parent, dict):
        for field in node.fields:
            if field.name == key:
                return field
    return None


def _content_node(
    concept_ref: str,
    content: Any,
    *,
    output_form: OutputForm | None,
    input_form: InputForm | None,
) -> InputFormItem:
    """The node a content of `concept_ref` is walked with: the concept's node, wrapped when the content is plural."""
    element = _node_for_concept(concept_ref, output_form=output_form, input_form=input_form)
    if not _is_plural_envelope(content, element):
        return element
    wrapped: dict[str, Any] = {"kind": "list", "concept_ref": concept_ref, "required": True, "item": _dump(element)}
    if element.refines is not None:
        wrapped["refines"] = element.refines
    return _NODE_ADAPTER.validate_python(wrapped)


def _is_plural_envelope(content: Any, element: InputFormItem) -> bool:
    if isinstance(content, BaseModel):
        content = content.model_dump()
    if not isinstance(content, dict):
        return False
    fields = cast("dict[str, Any]", content)
    if list(fields) != [_LIST_ITEMS_FIELD] or not isinstance(fields[_LIST_ITEMS_FIELD], list):
        return False
    return not (isinstance(element, ObjectItem) and any(field.name == _LIST_ITEMS_FIELD for field in element.fields))


def _node_for_concept(concept_ref: str, *, output_form: OutputForm | None, input_form: InputForm | None) -> InputFormItem:
    """The node the forms state for a concept, else the native's own shape, else an opaque node."""
    roots: list[InputFormItem] = []
    for output_descriptor in (output_form or {}).values():
        roots.append(output_descriptor.field)
    for input_descriptor in (input_form or {}).values():
        roots.extend(input_descriptor.fields)
    for root in roots:
        found = _find_concept_node(root, concept_ref)
        if found is not None:
            return found
    return _native_node(concept_ref)


def _find_concept_node(node: InputFormItem, concept_ref: str) -> InputFormItem | None:
    """Depth first, the first node that is not a list and names `concept_ref`."""
    if isinstance(node, ListItem):
        return _find_concept_node(node.item, concept_ref)
    if node.concept_ref == concept_ref:
        return node
    if isinstance(node, ObjectItem):
        for field in node.fields:
            found = _find_concept_node(field, concept_ref)
            if found is not None:
                return found
    return None


def _native_node(concept_ref: str) -> InputFormItem:
    """A concept no form describes: the shape of a native the walk knows, else an opaque node naming it."""
    return _NODE_ADAPTER.validate_python(_native_node_data(concept_ref))


def _native_node_data(concept_ref: str) -> dict[str, Any]:
    members = _NATIVE_MEMBERS.get(concept_ref)
    if members is not None:
        fields: list[dict[str, Any]] = []
        for member_name, member in members.items():
            if isinstance(member, str):
                fields.append({**_native_node_data(member), "name": member_name})
            else:
                item = _native_node_data(member[0])
                fields.append({"kind": "list", "name": member_name, "concept_ref": member[0], "required": True, "item": item})
        return {"kind": "object", "concept_ref": concept_ref, "required": True, "fields": fields}
    file_kind = _NATIVE_FILE_KINDS.get(concept_ref)
    return {"kind": file_kind or "unknown", "concept_ref": concept_ref, "required": True}


def _dump(node: InputFormItem) -> dict[str, Any]:
    """A node as its unnamed wire mapping, ready to be placed anywhere in a node being built."""
    data = node.model_dump()
    data.pop("name", None)
    return data
