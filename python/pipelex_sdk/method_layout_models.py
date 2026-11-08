"""A method's stored layouts: the layout a producer designed for one pipe of a published version.

The hosted platform stores a layout beside the method (`PipelexAPIClient.store_method_layout`,
`POST /v1/methods/{id}/versions/{n}/layouts`) and hands it back on the validate of the method by id that names
`layouts` among its `views` (`PipelexValidationReport.layouts`). The twin of `@pipelex/sdk`'s `method-layouts.ts`.

A layout is a data file: a tree of elements written in the vocabulary of a catalog of components, every value bound to
a path in the host's form state, carrying no field descriptions and no data of its own. A host renders it over the
input-form descriptor the same validate projects, and renders the plain form instead whenever it cannot. The platform
stores and carries it and never judges it. The shapes are stated brand-neutrally, as the input-form descriptor they are
rendered over is: snake_case fields with no `pipelex_` prefix. The storage and the `layouts` token are the hosted
plane's.

Two models per shape, one for each direction. The write (`MethodLayoutInput`, `LayoutProvenanceInput`) is closed at
both levels, as the route's body is, so a field the platform does not take is refused when the input is built. The
reading (`MethodLayout`, `LayoutProvenance`) is extension-open and lenient where the platform has a default, and a
report's `layouts` is read entry by entry (`read_method_layouts`), as `pipelex_sdk.problem_items` reads a verdict's
items: a validate never loses its verdict, nor its other layouts, to one layout it cannot read.
"""

from __future__ import annotations

from typing import Annotated, Any, TypeAlias, cast

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictInt, StrictStr, ValidationError, WrapValidator

from pipelex_sdk._pydantic_utils import none_when_it_does_not_fit, zero_when_it_does_not_fit


class LayoutProvenance(BaseModel):
    """How a stored layout was made, as its producer stated it when it wrote the layout.

    Read as `@pipelex/sdk` reads it: `producer` and `model` must be strings, and each optional field reads as the
    platform's own default when it is missing or of another type, `seed` and `style` as `None` and `repair_rounds`,
    a non-negative integer, as `0`. Extension-open: a field a later platform adds rides `model_extra`.
    """

    model_config = ConfigDict(extra="allow")

    producer: StrictStr
    """Who produced the layout, a short kebab-case slug such as `pipelex-method`."""

    model: StrictStr
    """The id of the model the producer ran, such as `claude-4.8-opus`."""

    seed: Annotated[StrictStr | None, WrapValidator(none_when_it_does_not_fit)] = None
    """The creative seed handed to the model with the brief, verbatim; `None` when none was."""

    style: Annotated[StrictStr | None, WrapValidator(none_when_it_does_not_fit)] = None
    """The id of the app style the layout was designed under, such as `editorial`; `None` when it was designed under
    none. The platform holds it to the shape `^[a-z0-9-]{1,32}$` and never to a list of styles, so a host reads an id
    it does not know as no style."""

    repair_rounds: Annotated[StrictInt, Field(ge=0), WrapValidator(zero_when_it_does_not_fit)] = 0
    """How many repair rounds the producer ran before the layout validated against its catalog."""


class MethodLayout(BaseModel):
    """One stored layout — what `store_method_layout` returns, and an entry of `PipelexValidationReport.layouts`.

    Its identity is `tree_digest`, `pipe_ref`, `catalog` and `prompt_hash` within one method: it belongs to the content
    it was designed for, never to a version number, so it is served for whatever selector of that method resolves the
    same tree, and a write of the same identity replaces it. It names no method and no version. Every field is the
    producer's but `stored_at`, the platform's. Extension-open: a field a later platform adds rides `model_extra`.
    """

    model_config = ConfigDict(extra="allow")

    tree_digest: StrictStr
    """The digest of the method tree the layout was produced against, `sha256:` and 64 lowercase hexadecimal
    characters: the MTHDS standard's digest of the tree's listing, as a published version's `tree_digest` states it."""

    pipe_ref: StrictStr
    """The namespaced pipe reference it lays out, `domain_path.pipe_code`, as the input-form descriptor keys its forms."""

    catalog: StrictStr
    """The id of the catalog whose vocabulary it is written in, a slug such as `composer`."""

    prompt_hash: StrictStr
    """The hash of the prompt the producer's model read, 12 to 64 lowercase hexadecimal digits."""

    jsonl: StrictStr
    """The layout itself, as the producer's model emitted it: JSON patch lines, one per line, carried as one string
    exactly as written. The platform never parses it."""

    provenance: LayoutProvenance
    """How it was made."""

    stored_at: StrictStr
    """The moment the write that stored it landed, ISO 8601 in UTC."""


class LayoutProvenanceInput(BaseModel):
    """The provenance a write states — `MethodLayoutInput.provenance`. Closed: a field the platform does not take is refused.

    A `None` optional field is not sent, and the platform stores its default: no seed, no style, no repair round. The
    bounds below are the platform's, which refuses a field breaking one with a `422` `request.invalid` naming it as
    `provenance.<field>`.
    """

    model_config = ConfigDict(extra="forbid")

    producer: str
    """Who produced the layout, a slug: 1 to 64 lowercase letters, digits and hyphens, not starting with a hyphen."""

    model: str
    """The id of the model the producer ran: 1 to 128 characters, none of them a control character."""

    seed: str | None = None
    """The creative seed handed to the model with the brief, verbatim, at most 4,000 characters."""

    style: str | None = None
    """The id of the app style the layout was designed under, of the shape `^[a-z0-9-]{1,32}$`."""

    repair_rounds: StrictInt | None = None
    """How many repair rounds the producer ran before the layout validated, from 0 to 100. Strict, so a `bool`, a
    `float` or a numeric string is refused when the input is built rather than sent as an altered count."""


class MethodLayoutInput(BaseModel):
    """The write of `store_method_layout` — `POST /v1/methods/{id}/versions/{n}/layouts`: the stored layout without `stored_at`.

    Closed at both levels, as the route's body is, so a field the platform does not take, `stored_at` included, is
    refused when the input is built. A layout read back is written again with `MethodLayoutInput.from_layout(layout)`,
    which keeps only the fields the write takes. The bounds below are the platform's, which refuses a field breaking one
    with a `422` `request.invalid` naming it.
    """

    model_config = ConfigDict(extra="forbid")

    tree_digest: str
    """The digest of the tree the layout was produced against, which must be the `tree_digest` of the version the call
    names (`MethodVersionSummary.tree_digest`): `sha256:` and 64 lowercase hexadecimal characters."""

    pipe_ref: str
    """The pipe it lays out, `domain_path.pipe_code`: two or more dot-separated identifiers, at most 256 characters."""

    catalog: str
    """The catalog's id, a slug of the same shape as `provenance.producer`."""

    prompt_hash: str
    """The hash of the prompt the producer's model read, 12 to 64 lowercase hexadecimal digits."""

    jsonl: str
    """The layout as the producer's model emitted it, not empty, at most 128 KiB of UTF-8, holding no raw control
    character but the tab, the line feed and the carriage return."""

    provenance: LayoutProvenanceInput
    """How it was made."""

    @classmethod
    def from_layout(cls, layout: MethodLayout) -> MethodLayoutInput:
        """The write that stores `layout` again, as `@pipelex/sdk` sends a layout read back.

        Only the fields the write takes are copied, at both levels: `stored_at`, which the platform stamps, and every
        field a later platform adds to a stored layout or its provenance, which `MethodLayout` keeps in `model_extra`,
        are left out, so a layout read from a newer platform is written back rather than refused as an extra field.

        Args:
            layout: A layout as `store_method_layout` returned it or a validate report carried it.

        Returns:
            The input `store_method_layout` takes, holding the layout's own values.
        """
        provenance_fields: set[str] = set(LayoutProvenanceInput.model_fields)
        include: dict[str, bool | set[str]] = dict.fromkeys(cls.model_fields, True)
        include["provenance"] = provenance_fields
        return cls.model_validate(layout.model_dump(include=include))


def read_method_layouts(entries: object) -> list[MethodLayout] | None:
    """A valid report's `layouts` read entry by entry, as `@pipelex/sdk` reads them.

    Args:
        entries: The list as the answer gave it.

    Returns:
        Each entry that reads as a `MethodLayout`, in the answer's order, newest first as the platform sends them, and
        `None` when none does: when the value is no list, an empty one included, or holds no entry that reads as a
        layout. So `layouts` is either `None` or holds at least one layout, as the platform sends it. An entry that
        already is a `MethodLayout`, as when a caller constructs a report in code, is kept as it is.
    """
    if not isinstance(entries, list):
        return None
    layouts: list[MethodLayout] = []
    for entry in cast("list[Any]", entries):
        if isinstance(entry, MethodLayout):
            layouts.append(entry)
            continue
        try:
            layouts.append(MethodLayout.model_validate(entry))
        except ValidationError:
            continue
    return layouts or None


MethodLayouts: TypeAlias = Annotated[list[MethodLayout] | None, BeforeValidator(read_method_layouts)]
"""A report's `layouts` as a model field: the list as it arrived, read by `read_method_layouts`, so a malformed entry
never fails the verdict that carries it, and a list left with none reads as `None`."""
