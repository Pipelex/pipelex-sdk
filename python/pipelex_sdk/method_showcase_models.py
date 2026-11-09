"""A method's showcases: a completed run of a method, frozen, so that people can see what it really produces without spending credit.

A builder freezes a run (`PipelexAPIClient.freeze_method_showcase`, `POST /v1/methods/{id}/showcases`) and withdraws it
(`withdraw_method_showcase`); every reader of a published version reads the showcases of the tree that version holds
(`list_method_version_showcases`, `get_method_version_showcase`), and the method's own organization reads every showcase
across every tree (`list_method_showcases`, `get_method_showcase`). The twin of `@pipelex/sdk`'s `method-showcases.ts`.

A showcase holds real output, unlike a layout's written sample, which is invented, and unlike an example, which is the
builder's private test bench whose output is whatever its latest run left. It is keyed by the digest of the method tree
of its run, so a run's own content stands behind what is shown. The frozen document names its stored files by
`pipelex-storage://` address and holds no signed link; the one place a link appears is a detail read's `files`, signed
for that one read over that showcase's own files.

A list of showcases is read entry by entry (`read_method_showcases`), as `pipelex_sdk.method_layout_models` reads a list
of layouts, so one showcase the SDK cannot read never costs a page the others. A detail and a freeze's verdict are held
whole, since the caller acts on what they name.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal, TypeAlias, cast

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictInt, StrictStr, TypeAdapter, ValidationError


class MethodShowcaseSummary(BaseModel):
    """One showcase of a list: what names it and what it was frozen from. The same for every reader, whoever holds the method.

    Extension-open: a field a later platform adds rides `model_extra`.
    """

    model_config = ConfigDict(extra="allow")

    showcase_id: StrictStr
    """The showcase's id, `sc_` and a time-ordered uuid, so a list reads oldest first."""

    name: StrictStr
    """The showcase's name, for a person reading a list."""

    pipe_ref: StrictStr
    """The namespaced pipe the run ran, `domain_path.pipe_code`."""

    tree_digest: StrictStr
    """The digest of the method tree of the run the showcase was frozen from: `sha256:` and 64 lowercase hexadecimal
    characters, as a published version's `tree_digest` states it."""

    frozen_at: StrictStr
    """The moment of the freeze, ISO 8601 in UTC."""


class MethodShowcaseFile(BaseModel):
    """One stored file of a showcase on a detail read, with a link signed for that read."""

    model_config = ConfigDict(extra="allow")

    address: StrictStr
    """The file's `pipelex-storage://` address, as the document names it."""

    file_name: StrictStr
    """The file's name inside the showcase, which is its content's hash and its extension."""

    media_type: StrictStr
    """The file's media type, one `type/subtype`."""

    size_bytes: StrictInt = Field(ge=0)
    """The file's size in bytes."""

    url: StrictStr = Field(repr=False)
    """A short-lived presigned `GET` of the file's bytes. It is a bearer credential: it needs no API key, and anyone
    holding it can read the file until it expires, so it is never logged and left out of this model's `repr`."""


class MethodShowcaseDocument(BaseModel):
    """What a showcase shows, frozen from its run and relayed as it was stored, its addresses rewritten to the showcase's own files.

    A renderer of an HTML output replaces each address with the `url` of the matching entry of
    `MethodShowcaseDetail.files`.
    """

    model_config = ConfigDict(extra="allow")

    inputs: dict[str, Any] = Field(strict=True)
    """The inputs the run was started with, returned exactly as they were frozen: an integer stays an `int` and `3.0` a
    `float`."""

    main_stuff: Any = None
    """The run's main output."""

    input_form: Any = None
    """The input-form descriptors of the library the run executed against, keyed by `pipe_ref`."""

    output_form: Any = None
    """The output-form descriptors of that library, keyed by `pipe_ref`."""

    pipe_io_contracts: Any = None
    """The per-pipe input and output contracts of that library, keyed by `pipe_ref`."""


class MethodShowcaseDetail(MethodShowcaseSummary):
    """One showcase in full: its summary, the frozen document and its files, each with a link signed for this read.

    Unlike a list of showcases, whose entries stand apart, a detail is held whole: a renderer resolves each address the
    document names through `files`, so a file it cannot read would leave a result drawn with a hole in it.
    """

    document: MethodShowcaseDocument
    """The frozen inputs and output, and what describes them."""

    files: list[MethodShowcaseFile]
    """Every stored file the document names, each with a link signed for this read."""


def read_method_showcases(entries: object) -> list[MethodShowcaseSummary]:
    """A list of showcases read entry by entry, as `@pipelex/sdk` reads them: `items` of the holder's list or a version's.

    Args:
        entries: The list as the answer gave it.

    Returns:
        Each entry that reads as a `MethodShowcaseSummary`, in the answer's order, oldest first as the platform sends
        them, and anything else left out. A value that is not a list reads as no showcase.
    """
    if not isinstance(entries, list):
        return []
    summaries: list[MethodShowcaseSummary] = []
    for entry in cast("list[Any]", entries):
        try:
            summaries.append(MethodShowcaseSummary.model_validate(entry))
        except ValidationError:
            continue
    return summaries


def _readable_showcase_items(entries: object) -> object:
    """A list's `items` read entry by entry (`read_method_showcases`), so one it cannot read never costs the others.

    A value that is no list is handed on as it came, for the field's own type to refuse: an answer whose `items` is not
    a list is one the SDK cannot read.
    """
    if not isinstance(entries, list):
        return entries
    return read_method_showcases(cast("list[Any]", entries))


class MethodShowcaseList(BaseModel):
    """A list of showcases, oldest first, empty when none is frozen — what `list_method_showcases` and `list_method_version_showcases` return.

    Extension-open: a field a later platform adds rides `model_extra`.
    """

    model_config = ConfigDict(extra="allow")

    items: Annotated[list[MethodShowcaseSummary], BeforeValidator(_readable_showcase_items)]
    """The showcases, oldest first. An entry that does not read as a summary is left out."""


class MethodShowcaseFreezeOutcome(StrEnum):
    """What a freeze did — the discriminant of `MethodShowcaseFreezeResult`."""

    FROZEN = "frozen"
    UNCHANGED = "unchanged"
    REFUSED = "refused"


class MethodShowcaseRefusalReason(StrEnum):
    """Why a freeze was refused, the `reason` of `MethodShowcaseRefused`."""

    RUN_NOT_USABLE = "run_not_usable"
    """The run is not this method's in this organization, did not complete, kept no results (a blocking execute stores
    none), stored no output or forms, does not say which pipe it ran, or kept no record of inputs its pipe declares."""

    TREE_NOT_CURRENT = "tree_not_current"
    """The run's tree is neither the draft's nor the latest published version's, or the run records none."""

    FILE_NOT_READABLE = "file_not_readable"
    """The document names a file that is gone or outside the organization, or holds a signed link the freeze could not
    rewrite."""

    TOO_LARGE = "too_large"
    """A stored artifact of the run, the document, the number of files or their total size is past what one showcase
    holds."""

    TOO_MANY = "too_many"
    """The tree already holds as many showcases as one tree keeps."""


class MethodShowcaseFrozen(BaseModel):
    """The run was frozen: `showcase` names the new showcase."""

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodShowcaseFreezeOutcome.FROZEN]
    showcase: MethodShowcaseSummary


class MethodShowcaseUnchanged(BaseModel):
    """This run is already a showcase, whatever has happened to its tree since: `showcase` names the one that stands.

    Nothing was written and the name in the request was ignored.
    """

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodShowcaseFreezeOutcome.UNCHANGED]
    showcase: MethodShowcaseSummary


class MethodShowcaseRefused(BaseModel):
    """The run cannot be frozen, and nothing was written."""

    model_config = ConfigDict(extra="allow")

    outcome: Literal[MethodShowcaseFreezeOutcome.REFUSED]

    reason: Annotated[MethodShowcaseRefusalReason | str, Field(union_mode="left_to_right")]
    """Why: the `MethodShowcaseRefusalReason` member when this SDK knows the reason, its raw string for one a later
    platform adds. A refusal is a verdict whatever its reason, so show its `message` when the reason is one you do not
    handle."""

    message: StrictStr
    """What was refused and what to do, for a person."""


MethodShowcaseFreezeResult: TypeAlias = Annotated[
    MethodShowcaseFrozen | MethodShowcaseUnchanged | MethodShowcaseRefused,
    Field(discriminator="outcome"),
]
"""The answer of `freeze_method_showcase`, a `200` discriminated on `outcome`, because a run that cannot be frozen is a
verdict about the run and not a failure of the request. Branch on `outcome` (`match result:` over its classes), never on
the status."""

MethodShowcaseFreezeResultAdapter: TypeAdapter[MethodShowcaseFreezeResult] = TypeAdapter(MethodShowcaseFreezeResult)  # pylint: disable=invalid-name
"""The single parse path for a freeze's answer — built once at import (TypeAdapter construction is expensive)."""
