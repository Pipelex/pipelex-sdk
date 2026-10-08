"""Wire models for the model reference check — `GET /v1/models/check`.

The check answers whether one model reference resolves on the runner, as what kind of reference
and to which model. It is a Pipelex API extension (NOT an MTHDS Protocol route), served by any
`pipelex-api` runner from pipelex 0.78.0 and relayed byte-identically by the hosted platform. It
answers from pipelex's own reference parser and deck lookups, the ones a validation runs, so a
reference found `resolved` in a category is one a pipe of that category may name, and one found
`not_found` is one a validation refuses.

A verdict is a `200` whatever the resolution. Only a request that cannot produce one is a `422`
problem, raised as `ApiResponseError`: `InvalidModelReference` for a reference that is blank, a
sigil or a namespace alone, or too long; `InvalidModelCategory` for an unknown `type`;
`ValidationError` for a missing or repeated parameter. This SDK checks none of it, so the runner's
rule is the only one.

**The verdict is parsed on its own `kind`.** A `matches` entry carries no kind of its own, and two of
the four shapes are nearly alike: a `PresetMatch` is an `AliasMatch` plus `description`. Parsing each
entry against a union of the four would have to guess between them, and an extension-open model would
let a preset entry pass as an alias. The wire says which shape every entry has, through the verdict's
`kind`, which all the matches of one verdict share. So the verdict is a union of one arm per kind,
discriminated on `kind`, and each arm types its `matches` as that kind's entry: the parse never
guesses, and a consumer narrows the verdict, and its matches with it, with `match verdict: case
PresetReferenceVerdict(): …` or an `isinstance` check. No field is added to the wire to make it so.
`@pipelex/sdk` types the verdict with the same arms under the same names.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class ModelCheckCategory(StrEnum):
    """The categories the check covers, in the order every list it returns follows.

    These are the MTHDS Protocol's model categories, in the protocol's order, then `doc_gen`, the
    family of `PipeDocGen`. The protocol defines no category for `doc_gen`, so `GET /v1/models`
    leaves it out, but a method names a `doc_gen` model in its `model` field like any other, so the
    check covers it.
    """

    LLM = "llm"
    EXTRACT = "extract"
    IMG_GEN = "img_gen"
    SEARCH = "search"
    JUDGMENT = "judgment"
    DOC_GEN = "doc_gen"


class ModelReferenceKind(StrEnum):
    """What a reference names, from its parsing.

    A sigil (`$` preset, `@` alias, `~` waterfall), else a spelled-out namespace (`preset:`,
    `alias:`, `waterfall:`, `handle:`), else a bare model handle.
    """

    PRESET = "preset"
    ALIAS = "alias"
    WATERFALL = "waterfall"
    HANDLE = "handle"


class ModelReferenceResolution(StrEnum):
    """Whether a reference resolves in a category in scope. Both values are definitive."""

    RESOLVED = "resolved"
    NOT_FOUND = "not_found"


class ModelReferenceMatchBase(BaseModel):
    """The fields every `matches` entry carries, whatever the reference's kind."""

    model_config = ConfigDict(extra="allow")

    #: The category this entry is about.
    category: ModelCheckCategory
    #: The model handle a run through the reference would call now in this category, or `None` when
    #: it would find none: a target on a backend the runner has not enabled, a waterfall none of whose
    #: usable steps the runner serves, an alias cycle. The reference still resolves, as a validation
    #: accepts it, but a run through it fails, so show it as a warning rather than as an unknown name.
    resolves_to: str | None


class PresetMatch(ModelReferenceMatchBase):
    """What a preset reference is in one category."""

    #: The model the deck binds the preset to, as the deck writes it, which may itself be a reference
    #: (`@default-premium`).
    target: str
    #: The preset's description, or `None` when the deck gives it none.
    description: str | None


class AliasMatch(ModelReferenceMatchBase):
    """What an alias reference is in one category."""

    #: The model the deck binds the alias to, as the deck writes it, which may itself be a reference.
    target: str


class WaterfallMatch(ModelReferenceMatchBase):
    """What a waterfall reference is in one category."""

    #: The waterfall's steps, in order.
    fallbacks: list[str]


class HandleMatch(ModelReferenceMatchBase):
    """What a bare handle reference is in one category."""

    #: The presets, aliases and waterfalls of this category whose binding names the handle directly,
    #: each written as a reference.
    via: list[str]


ModelReferenceMatch: TypeAlias = PresetMatch | AliasMatch | WaterfallMatch | HandleMatch
"""One `matches` entry, for typing a consumer's own code; the parse never validates against it (see
the module docstring)."""


class ModelReferenceVerdictBase(BaseModel):
    """The fields every verdict carries, whatever the reference's kind."""

    model_config = ConfigDict(extra="allow")

    #: The caller's reference, trimmed.
    reference: str
    #: The reference without its sigil or namespace.
    name: str
    #: The `type` asked, or `None` when none was.
    category: ModelCheckCategory | None
    #: Whether the reference resolves in a category in scope. Open on purpose, under the spec's reader
    #: rule: "a client that reads a value it does not know treats the reference as unresolved". A value
    #: this SDK knows reads as its `ModelReferenceResolution` member, and one it does not keeps its raw
    #: string rather than failing the verdict, so a consumer handles the `str` case. Validated left to
    #: right on purpose: pydantic's default smart mode would keep every string, known or not, as `str`.
    resolution: Annotated[ModelReferenceResolution | str, Field(union_mode="left_to_right")]
    #: On `not_found`, the nearest names the caller may have meant, written as a method writes them;
    #: empty when it is `resolved`.
    suggestions: list[str]
    #: On `not_found`, the same name under another kind, in the categories in scope (`@best-claude` for
    #: `$best-claude`); empty when it is `resolved`. Show it first: it is the likeliest fault.
    other_kinds: list[str]
    #: On `not_found` with a `type`, the categories outside it where the same reference resolves; empty
    #: otherwise.
    other_categories: list[ModelCheckCategory]


class PresetReferenceVerdict(ModelReferenceVerdictBase):
    """A verdict on a preset reference (`$name` or `preset:name`)."""

    kind: Literal[ModelReferenceKind.PRESET]
    #: One entry per category in scope where the reference resolves, in the order of the categories
    #: the check covers; empty on `not_found`.
    matches: list[PresetMatch]


class AliasReferenceVerdict(ModelReferenceVerdictBase):
    """A verdict on an alias reference (`@name` or `alias:name`)."""

    kind: Literal[ModelReferenceKind.ALIAS]
    #: One entry per category in scope where the reference resolves, in the order of the categories
    #: the check covers; empty on `not_found`.
    matches: list[AliasMatch]


class WaterfallReferenceVerdict(ModelReferenceVerdictBase):
    """A verdict on a waterfall reference (`~name` or `waterfall:name`)."""

    kind: Literal[ModelReferenceKind.WATERFALL]
    #: One entry per category in scope where the reference resolves, in the order of the categories
    #: the check covers; empty on `not_found`.
    matches: list[WaterfallMatch]


class HandleReferenceVerdict(ModelReferenceVerdictBase):
    """A verdict on a bare model handle (`name` or `handle:name`)."""

    kind: Literal[ModelReferenceKind.HANDLE]
    #: One entry per category in scope where the reference resolves, in the order of the categories
    #: the check covers; empty on `not_found`.
    matches: list[HandleMatch]


ModelReferenceVerdict: TypeAlias = Annotated[
    PresetReferenceVerdict | AliasReferenceVerdict | WaterfallReferenceVerdict | HandleReferenceVerdict,
    Field(discriminator="kind"),
]

# The single parse path for a 200 `/models/check` body — discriminated on the verdict's `kind`, built
# once at import (TypeAdapter construction is expensive), mirroring `ResolveResponseAdapter`.
ModelReferenceVerdictAdapter: TypeAdapter[ModelReferenceVerdict] = TypeAdapter(ModelReferenceVerdict)  # pylint: disable=invalid-name
