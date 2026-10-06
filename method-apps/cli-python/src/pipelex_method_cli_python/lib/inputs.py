"""The run's inputs: one option per declared input, derived at run time from the committed input form.

Nothing about the method's inputs is written in this CLI's code. When the command loads, this
module reads the bound pipe's input-form descriptor and IO contract out of `contracts.json`
(`lib/contracts.py`) and builds one option per declared input, in authored order, which `cli.py`
joins to its own options through the command's assembled signature. Changing the method and running
`make codegen` changes the options; there is nothing else to edit. `docs/cli-kernel.md` is the page.

Each field kind of `mthds.protocol.input_form` gets one style of option:

- `text` and `prose` take a string; `@path` reads it from a file, `@-` from stdin, and a leading
  `@@` stands for a literal `@`;
- `date` takes an ISO 8601 date, or a date and time when the descriptor says `datetime`;
- `number` takes an integer or a number, as `integer` says, inside the descriptor's bounds;
- `boolean` is a pair of flags, `--<name>` and `--no-<name>`;
- `enum` takes one of the descriptor's `choices`, which Click checks;
- `document` and `image` take a local path or a `data:` URL, which the SDK's `prepare_inputs` uploads
  before the run, or an `https://` or `pipelex-storage://` URL, which passes through;
- a `list` of any of those is the same option, repeatable, with a fixed `item_count` enforced; a
  list of booleans, whose flag could not repeat, takes `true` or `false` per item;
- `object`, `unknown`, and a list of either or of lists take JSON, inline or `@file.json`.

`--inputs FILE` reads a JSON object of inputs in the shape `mthds run --inputs` and
`--inputs-template` use, passed as it is; an option given on the command line overrides that input
from the file. Presence is checked once both are merged, so a required input may come from either,
and a missing one is refused naming its option.

The value each option puts on the wire is the value `@pipelex/mthds-form`, the web app template's
form kernel, sends for the same field and value: `lib/wire.py` holds the port of its rules.

An input's option is `--<name>`, its underscores written as dashes. An input whose option would take
a flag of the command's own, or of an input before it, is offered as `--input-<name>` instead. Its
Python parameter is always `input_<name>`, a namespace the command's own options never use, so
only a flag can collide.
"""

import json
import re
import sys
from dataclasses import dataclass, field, replace
from enum import Enum, StrEnum
from inspect import Parameter
from pathlib import Path
from typing import Annotated, Any, cast

import typer
from mthds.protocol.input_form import (
    DateItem,
    FieldKind,
    InputFormField,
    InputFormItem,
    ListItem,
    NumberItem,
    ObjectItem,
    PipeInputFormDescriptor,
)
from mthds.protocol.inputs_template import InputsTemplateFormat, render_inputs_template
from mthds.protocol.pipe_io_contracts import PipeInputContract

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.contracts import REGENERATE_HINT, PipeContracts
from pipelex_method_cli_python.lib.wire import (
    CONTENT_KEY,
    JsonSchema,
    as_calendar_date,
    collect_defs,
    content_key,
    envelope,
    file_content,
    is_acceptable_date_time,
    is_filled,
    is_plural_input,
    prepare,
    resolve_schema_node,
    runs_schema,
    wrap_content,
)

#: The `--inputs` value, and the `@-` of an option, that read from stdin.
STDIN = "-"

#: The prefix that makes an option's value a file to read rather than the value itself.
READ_PREFIX = "@"

#: The prefix of an input's option when its own name is taken.
RENAMED_PREFIX = "--input-"

#: The prefix of an input's Python parameter, a namespace the command's own options never use.
PARAMETER_PREFIX = "input_"

#: A reference the reader takes as it is rather than as a local path, spelled as the SDK's
#: `prepare_inputs` recognises it: an `http(s)://` or `pipelex-storage://` URL passes through, and a
#: `data:` URL is uploaded by the SDK itself.
_PASSTHROUGH_URL = re.compile(r"(?i:https?://)|pipelex-storage://|data:")

#: An integer as a person types it.
_INTEGER = re.compile(r"[+-]?\d+")

#: The field kinds a single value on the command line can carry, each in its own style.
_SCALAR_KINDS = frozenset(
    {FieldKind.TEXT, FieldKind.PROSE, FieldKind.DATE, FieldKind.NUMBER, FieldKind.BOOLEAN, FieldKind.ENUM, FieldKind.DOCUMENT, FieldKind.IMAGE}
)

#: The field kinds whose value the form kernel wraps in its content model's one property.
_WRAPPED_KINDS = frozenset({FieldKind.TEXT, FieldKind.PROSE, FieldKind.NUMBER, FieldKind.BOOLEAN})


class InputsFileError(AppError):
    """An inputs file that cannot be read, or that is not a JSON object."""


class InputUsageError(AppError):
    """A command line whose inputs the CLI cannot run: a value it cannot read, or a required input missing.

    The command refuses it as a usage error, with exit code 2, as Click refuses an unknown option.
    """


class InputOptionsError(AppError):
    """A committed input form the CLI cannot offer options for, found when the command loads."""


class OptionStyle(StrEnum):
    """How an input's option reads its value off the command line."""

    #: A string, read as it is or from a file with `@path`.
    TEXT = "text"
    #: An ISO 8601 date, or a date and time.
    DATE = "date"
    #: An integer or a number, inside the descriptor's bounds.
    NUMBER = "number"
    #: A pair of flags, `--<name>` and `--no-<name>`.
    FLAG = "flag"
    #: `true` or `false`, the item of a repeatable list of booleans, where a flag cannot repeat.
    YES_NO = "yes-no"
    #: One of the descriptor's choices.
    CHOICE = "choice"
    #: A local path or a URL.
    FILE = "file"
    #: JSON, inline or from a file.
    JSON = "json"


#: The style of a single value of each scalar kind.
_STYLE_BY_KIND: dict[FieldKind, OptionStyle] = {
    FieldKind.TEXT: OptionStyle.TEXT,
    FieldKind.PROSE: OptionStyle.TEXT,
    FieldKind.DATE: OptionStyle.DATE,
    FieldKind.NUMBER: OptionStyle.NUMBER,
    FieldKind.BOOLEAN: OptionStyle.FLAG,
    FieldKind.ENUM: OptionStyle.CHOICE,
    FieldKind.DOCUMENT: OptionStyle.FILE,
    FieldKind.IMAGE: OptionStyle.FILE,
}

#: What `--help` shows for the value of an option of each style; Click names a choice's values itself.
_METAVAR: dict[OptionStyle, str] = {
    OptionStyle.TEXT: "TEXT",
    OptionStyle.DATE: "DATE",
    OptionStyle.NUMBER: "N",
    OptionStyle.YES_NO: "true|false",
    OptionStyle.FILE: "PATH|URL",
    OptionStyle.JSON: "JSON",
}


@dataclass(frozen=True)
class InputOption:
    """One declared input of the bound pipe, as the command's option for it."""

    #: The input's name, as the method declares it and the wire keys it.
    name: str
    #: The option's flag, `--<name>` or `--input-<name>`.
    flag: str
    #: How the option reads its value.
    style: OptionStyle
    #: Whether the option repeats, one value per item of a list.
    repeatable: bool
    #: The input's top-level descriptor node.
    node: InputFormField
    #: The node one value of the option fills: the field itself, or a repeatable list's item.
    leaf: InputFormItem
    #: The input's slot in the IO contract.
    contract: PipeInputContract
    #: The property the form kernel wraps one value in, or `None` when it travels bare.
    leaf_key: str | None = None
    #: The fewest items a list takes, from a fixed `item_count` or the schema's `minItems`.
    min_items: int | None = None
    #: The most items a list takes, from the schema's `maxItems` or a fixed `item_count`.
    max_items: int | None = None
    #: The choices of an `enum` option, as the enumeration Click checks a value against.
    choices: type[Enum] | None = field(default=None, compare=False)

    @property
    def parameter_name(self) -> str:
        """The command's keyword parameter for this option: `input_<name>`."""
        return f"{PARAMETER_PREFIX}{self.name}"

    @property
    def flags(self) -> frozenset[str]:
        """Every flag the option takes, both halves of a boolean pair included."""
        return _flags_for(self.flag, self.style)

    @property
    def gating(self) -> bool:
        """Whether the run cannot start without a value for this input, as the descriptor states."""
        return bool(self.node.gating)

    def parameter(self) -> Parameter:
        """The keyword-only parameter `cli.py` adds to the command's signature for this option."""
        info = typer.Option(*self._declarations(), help=option_help(self), show_default=False, metavar=self._metavar())
        annotation: Any = Annotated[self._value_type(), info]  # pyright: ignore[reportInvalidTypeForm]
        return Parameter(self.parameter_name, Parameter.KEYWORD_ONLY, default=None, annotation=annotation)

    def _declarations(self) -> tuple[str, ...]:
        if self.style is OptionStyle.FLAG:
            return (f"{self.flag}/{_negative(self.flag)}",)
        return (self.flag,)

    def _metavar(self) -> str | None:
        if self.style is OptionStyle.NUMBER and isinstance(self.leaf, NumberItem) and self.leaf.integer:
            return "INTEGER"
        if self.style is OptionStyle.DATE and isinstance(self.leaf, DateItem) and self.leaf.datetime:
            return "DATETIME"
        return _METAVAR.get(self.style)

    def _value_type(self) -> Any:
        if self.style is OptionStyle.FLAG:
            return bool | None
        single: Any = self.choices if self.choices is not None else str
        if self.repeatable:
            return list[single] | None  # pyright: ignore[reportInvalidTypeForm]
        return single | None


def _negative(flag: str) -> str:
    """The `--no-` half of a boolean option's pair."""
    return f"--no-{flag.removeprefix('--')}"


def _flags_for(flag: str, style: OptionStyle) -> frozenset[str]:
    return frozenset({flag, _negative(flag)}) if style is OptionStyle.FLAG else frozenset({flag})


def derive_options(contracts: PipeContracts, *, reserved: frozenset[str]) -> tuple[InputOption, ...]:
    """One option per declared input of the bound pipe, in authored order.

    `reserved` holds the flags the command takes for itself, which no input's option may take.

    Raises:
        InputOptionsError: The input form declares an input the contract does not, or an input's
            option cannot be given a flag of its own.
    """
    taken = set(reserved)
    options: list[InputOption] = []
    for node in contracts.input_form.fields:
        contract = contracts.io.inputs.get(node.name)
        if contract is None:
            msg = f"The committed input form of {contracts.pipe_ref} declares the input {node.name}, which its IO contract does not."
            raise InputOptionsError(msg, hint=REGENERATE_HINT)
        option = _option_for(node, contract)
        if option.flags & taken:
            renamed = replace(option, flag=f"{RENAMED_PREFIX}{option.name.replace('_', '-')}")
            if renamed.flags & taken:
                msg = f"The input {node.name} of {contracts.pipe_ref} can be offered neither as {option.flag} nor as {renamed.flag}: both are taken."
                raise InputOptionsError(msg, hint="Rename the input in the method, then run `make codegen`.")
            option = renamed
        taken.update(option.flags)
        options.append(option)
    return tuple(options)


def _option_for(node: InputFormField, contract: PipeInputContract) -> InputOption:
    """The option for one input, before its flag is checked against the others."""
    schema = contract.json_schema
    defs = collect_defs(schema, traverse_arrays=True)
    resolved = resolve_schema_node(schema, defs)
    flag = f"--{node.name.replace('_', '-')}"
    if isinstance(node, ListItem) and node.item.kind in _SCALAR_KINDS:
        items = resolved.get("items")
        item_schema = resolve_schema_node(cast("JsonSchema", items), defs) if isinstance(items, dict) else None
        item = node.item
        min_items, max_items = _list_bounds(node, resolved)
        return InputOption(
            name=node.name,
            flag=flag,
            style=OptionStyle.YES_NO if item.kind is FieldKind.BOOLEAN else _STYLE_BY_KIND[item.kind],
            repeatable=True,
            node=node,
            leaf=item,
            contract=contract,
            leaf_key=content_key(item_schema) if item.kind in _WRAPPED_KINDS else None,
            min_items=min_items,
            max_items=max_items,
            choices=_choices(node.name, item),
        )
    if node.kind in _SCALAR_KINDS:
        return InputOption(
            name=node.name,
            flag=flag,
            style=_STYLE_BY_KIND[node.kind],
            repeatable=False,
            node=node,
            leaf=node,
            contract=contract,
            leaf_key=content_key(resolved) if node.kind in _WRAPPED_KINDS else None,
            choices=_choices(node.name, node),
        )
    min_items, max_items = _list_bounds(node, resolved) if isinstance(node, ListItem) else (None, None)
    return InputOption(
        name=node.name,
        flag=flag,
        style=OptionStyle.JSON,
        repeatable=False,
        node=node,
        leaf=node,
        contract=contract,
        min_items=min_items,
        max_items=max_items,
    )


def _list_bounds(node: ListItem, schema: JsonSchema) -> tuple[int | None, int | None]:
    """How many items a list takes, as `derive.ts` reads it: the fixed count, else the schema's own bounds."""
    minimum = schema.get("minItems")
    maximum = schema.get("maxItems")
    min_items = node.item_count if node.item_count is not None else (minimum if isinstance(minimum, int) else None)
    max_items = maximum if isinstance(maximum, int) else node.item_count
    return min_items, max_items


def _choices(name: str, node: InputFormItem) -> type[Enum] | None:
    """An enumeration of an `enum` node's choices, which Typer turns into a choice Click checks."""
    if node.kind is not FieldKind.ENUM:
        return None
    choices = cast("list[str]", getattr(node, "choices"))
    members = [(f"choice_{index}", str(choice)) for index, choice in enumerate(choices)]
    return cast("type[Enum]", Enum(f"{name}_choices", members))


def option_help(option: InputOption) -> str:
    """The option's help text, from what the descriptor states about the input."""
    node = option.node
    parts: list[str] = []
    lead = (node.description or node.title or "").strip()
    if lead:
        parts.append(lead if lead.endswith((".", "!", "?")) else f"{lead}.")
    parts.append(_style_help(option))
    if option.repeatable:
        parts.append(f"Repeat the option for each item{_count_help(option)}.")
    elif option.style is OptionStyle.JSON and isinstance(node, ListItem):
        parts.append(f"A JSON array{_count_help(option)}.")
    if option.gating:
        parts.append("Required.")
    elif option.contract.presence.is_optional:
        parts.append("Optional.")
    else:
        parts.append("An empty list when not given.")
    if node.examples:
        shown = ", ".join(example if isinstance(example, str) else json.dumps(example) for example in node.examples)
        parts.append(f"Example: {shown}.")
    return " ".join(part for part in parts if part)


def _style_help(option: InputOption) -> str:
    leaf = option.leaf
    match option.style:
        case OptionStyle.TEXT:
            return "Text, or @FILE to read it from a file and @- from stdin."
        case OptionStyle.DATE:
            if isinstance(leaf, DateItem) and leaf.datetime:
                return "A date and time in ISO 8601, such as 2026-07-06T15:40:00Z."
            return "A calendar date in ISO 8601, such as 2026-07-06."
        case OptionStyle.NUMBER:
            return _number_help(leaf)
        case OptionStyle.YES_NO:
            return "true or false."
        case OptionStyle.FILE:
            return "A local file, uploaded before the run, or an https:// or pipelex-storage:// URL."
        case OptionStyle.JSON:
            return "JSON, inline or @FILE to read it from a file."
        case OptionStyle.FLAG | OptionStyle.CHOICE:
            return ""


def _number_help(leaf: InputFormItem) -> str:
    if not isinstance(leaf, NumberItem):
        return "A number."
    bounds = [
        f"at least {leaf.minimum}" if leaf.minimum is not None else "",
        f"more than {leaf.exclusive_minimum}" if leaf.exclusive_minimum is not None else "",
        f"at most {leaf.maximum}" if leaf.maximum is not None else "",
        f"less than {leaf.exclusive_maximum}" if leaf.exclusive_maximum is not None else "",
    ]
    stated = [bound for bound in bounds if bound]
    noun = "An integer" if leaf.integer else "A number"
    return f"{noun}, {' and '.join(stated)}." if stated else f"{noun}."


def _count_help(option: InputOption) -> str:
    """The number of items a list takes, as a clause after a comma, or nothing when it is free."""
    if option.min_items is not None and option.min_items == option.max_items:
        return f", exactly {option.min_items} items"
    if option.min_items is not None and option.max_items is not None:
        return f", between {option.min_items} and {option.max_items} items"
    if option.min_items is not None:
        return f", at least {option.min_items} items"
    if option.max_items is not None:
        return f", at most {option.max_items} items"
    return ""


@dataclass
class ValueReader:
    """Reads the values that name a file, `@path`, or stdin, `@-`, which one invocation reads at most once.

    `stdin_owner` is the option that already reads stdin, `--inputs` given `-`, so that no input's
    option reads it a second time and finds it empty.
    """

    stdin_owner: str | None = None

    def text(self, raw: str, *, flag: str) -> str:
        """The value an option stands for: itself, a file's text for `@path`, stdin's for `@-`, `@…` for `@@…`.

        Raises:
            InputUsageError: The file cannot be read or is not UTF-8, or stdin is read already.
        """
        if raw.startswith(READ_PREFIX * 2):
            return raw[1:]
        if not raw.startswith(READ_PREFIX):
            return raw
        source = raw[1:]
        if source == STDIN:
            if self.stdin_owner is not None:
                msg = f"{flag} reads stdin, which {self.stdin_owner} reads already: only one option can read it."
                raise InputUsageError(msg)
            self.stdin_owner = flag
            return sys.stdin.read()
        try:
            return Path(source).read_text(encoding="utf-8")
        except OSError as exc:
            msg = f"{flag} reads {source}, which cannot be read: {exc.strerror or exc}."
            raise InputUsageError(msg) from exc
        except UnicodeDecodeError as exc:
            msg = f"{flag} reads {source}, which is not UTF-8 text."
            raise InputUsageError(msg) from exc


def read_option(option: InputOption, raw: object, reader: ValueReader) -> object:
    """The value an option gives its input, in the shape the form kernel holds before the payload is built.

    Raises:
        InputUsageError: The value cannot be read as the input's kind, or a list has the wrong number of items.
    """
    if option.repeatable:
        values = [_read_one(option, item, reader) for item in cast("list[Any]", raw)]
        _check_count(option, len(values))
        return values
    return _read_one(option, raw, reader)


def _read_one(option: InputOption, raw: object, reader: ValueReader) -> object:
    flag = option.flag
    leaf = option.leaf
    match option.style:
        case OptionStyle.TEXT:
            return wrap_content(option.leaf_key, reader.text(cast("str", raw), flag=flag))
        case OptionStyle.DATE:
            return _read_date(cast("str", raw), leaf, flag=flag)
        case OptionStyle.NUMBER:
            return wrap_content(option.leaf_key, _read_number(cast("str", raw), leaf, flag=flag))
        case OptionStyle.FLAG:
            return wrap_content(option.leaf_key, bool(raw))
        case OptionStyle.YES_NO:
            return wrap_content(option.leaf_key, _read_yes_no(cast("str", raw), flag=flag))
        case OptionStyle.CHOICE:
            return cast("Enum", raw).value
        case OptionStyle.FILE:
            return _read_file(cast("str", raw), flag=flag)
        case OptionStyle.JSON:
            return _read_json(option, reader.text(cast("str", raw), flag=flag))


def _read_date(raw: str, leaf: InputFormItem, *, flag: str) -> str:
    """A date as the form sends it: a date and time as given, a calendar date cut to its day."""
    if isinstance(leaf, DateItem) and leaf.datetime:
        if is_acceptable_date_time(raw):
            return raw
        msg = f"{flag} takes a date and time in ISO 8601, such as 2026-07-06T15:40:00Z; {raw!r} is not one."
        raise InputUsageError(msg)
    day = as_calendar_date(raw)
    if day is None:
        msg = f"{flag} takes a calendar date in ISO 8601, such as 2026-07-06; {raw!r} is not one, and a time of day is never dropped silently."
        raise InputUsageError(msg)
    return day


def _read_number(raw: str, leaf: InputFormItem, *, flag: str) -> int | float:
    text = raw.strip()
    integer = isinstance(leaf, NumberItem) and leaf.integer
    if _INTEGER.fullmatch(text):
        value: int | float = int(text)
    elif integer:
        msg = f"{flag} takes an integer; {raw!r} is not one."
        raise InputUsageError(msg)
    else:
        try:
            value = float(text)
        except ValueError as exc:
            msg = f"{flag} takes a number; {raw!r} is not one."
            raise InputUsageError(msg) from exc
        if value != value or value in (float("inf"), float("-inf")):
            msg = f"{flag} takes a finite number; {raw!r} is not one."
            raise InputUsageError(msg)
    if isinstance(leaf, NumberItem):
        _check_bounds(value, leaf, flag=flag)
    return value


def _check_bounds(value: int | float, leaf: NumberItem, *, flag: str) -> None:
    refusals = [
        f"at least {leaf.minimum}" if leaf.minimum is not None and value < leaf.minimum else "",
        f"more than {leaf.exclusive_minimum}" if leaf.exclusive_minimum is not None and value <= leaf.exclusive_minimum else "",
        f"at most {leaf.maximum}" if leaf.maximum is not None and value > leaf.maximum else "",
        f"less than {leaf.exclusive_maximum}" if leaf.exclusive_maximum is not None and value >= leaf.exclusive_maximum else "",
    ]
    broken = next((refusal for refusal in refusals if refusal), None)
    if broken is not None:
        msg = f"{flag} takes a number {broken}; {value} is not."
        raise InputUsageError(msg)


def _read_yes_no(raw: str, *, flag: str) -> bool:
    match raw.strip().lower():
        case "true":
            return True
        case "false":
            return False
        case _:
            msg = f"{flag} takes true or false for each item; {raw!r} is neither."
            raise InputUsageError(msg)


def _read_file(raw: str, *, flag: str) -> dict[str, str]:
    """A file input's content: a URL as it is, or a local file with its name, which `prepare_inputs` uploads."""
    if _PASSTHROUGH_URL.match(raw):
        return file_content(raw)
    path = Path(raw).expanduser()
    if not path.is_file():
        msg = f"{flag} names {raw}, which is not a file: give a local file, or an https:// or pipelex-storage:// URL."
        raise InputUsageError(msg)
    return file_content(str(path), path.name)


def _read_json(option: InputOption, text: str) -> object:
    flag = option.flag
    try:
        value: object = json.loads(text)
    except json.JSONDecodeError as exc:
        msg = f"{flag} takes JSON, which this is not: {exc}."
        raise InputUsageError(msg) from exc
    kind = _json_type(value)
    if isinstance(option.node, ObjectItem) and kind != "object":
        msg = f"{flag} takes a JSON object; this is a JSON {kind}."
        raise InputUsageError(msg)
    if isinstance(option.node, ListItem):
        if kind != "array":
            msg = f"{flag} takes a JSON array; this is a JSON {kind}."
            raise InputUsageError(msg)
        _check_count(option, len(cast("list[Any]", value)))
    return value


def _json_type(value: object) -> str:
    match value:
        case dict():
            return "object"
        case list():
            return "array"
        case str():
            return "string"
        case bool():
            return "boolean"
        case int() | float():
            return "number"
        case _:
            return "null"


def _check_count(option: InputOption, count: int) -> None:
    too_few = option.min_items is not None and count < option.min_items
    too_many = option.max_items is not None and count > option.max_items
    if too_few or too_many:
        msg = f"{option.flag} takes{_count_help(option).removeprefix(',')}; it was given {count}."
        raise InputUsageError(msg)


def given_options(options: tuple[InputOption, ...], values: dict[str, Any]) -> list[InputOption]:
    """The input options the command line gave, in authored order."""
    return [option for option in options if _was_given(values.get(option.parameter_name))]


def _was_given(raw: object) -> bool:
    if raw is None:
        return False
    return not (isinstance(raw, (list, tuple)) and not raw)


def collect_inputs(
    contracts: PipeContracts,
    options: tuple[InputOption, ...],
    values: dict[str, Any],
    *,
    file_inputs: dict[str, Any] | None,
    reader: ValueReader,
) -> dict[str, Any]:
    """The inputs a new run sends: the inputs file's, with each input an option gave overriding it.

    The options' values are built as the form kernel builds a form's, repaired against the inputs'
    schemas as its gate repairs them, and enveloped as it envelopes them (`lib/wire.py`). The file's
    values pass as they are, since the file is in the shape `mthds run --inputs` takes. A plural
    input given nowhere is sent as the empty list, as the form sends one left empty, and an optional
    one given nowhere is left out.

    Raises:
        InputUsageError: A value cannot be read, or an input the run needs is given neither by an
            option nor by the file.
    """
    given = given_options(options, values)
    built = {option.name: read_option(option, values[option.parameter_name], reader) for option in given}
    gating = frozenset(option.name for option in options if option.gating)
    prepared = prepare(built, runs_schema(contracts.io.inputs, gating))
    merged: dict[str, Any] = dict(file_inputs or {})
    for option in given:
        sent, wire = envelope(option.contract, prepared.get(option.name))
        if sent:
            merged[option.name] = wire
        else:
            merged.pop(option.name, None)
    given_names = {option.name for option in given}
    missing: list[InputOption] = []
    for option in options:
        if option.name in given_names:
            if option.gating and (option.name not in merged or not _wire_filled(merged[option.name])):
                missing.append(option)
        elif option.name in merged:
            if option.gating and not is_filled(merged[option.name]):
                missing.append(option)
        elif option.gating:
            missing.append(option)
        elif is_plural_input(option.contract):
            merged[option.name] = []
    if missing:
        named = ", ".join(f"{option.name} ({option.flag})" for option in missing)
        msg = f"The run needs {named}: give each with its option, or in the file --inputs names."
        raise InputUsageError(msg)
    return merged


def _wire_filled(wire: object) -> bool:
    """Whether an input an option gave reaches the wire holding something: its envelope's content, or its bare list."""
    if not isinstance(wire, dict):
        return is_filled(wire)
    members = cast("dict[str, Any]", wire)
    content: object = members[CONTENT_KEY] if CONTENT_KEY in members else members
    return is_filled(content)


def inputs_template(contracts: PipeContracts) -> str:
    """The bound pipe's inputs template, the JSON object `--inputs` takes, with a placeholder for every input."""
    return render_inputs_template(descriptor=contracts.input_form, explicit=False, output_format=InputsTemplateFormat.JSON)


def declares_files(descriptor: PipeInputFormDescriptor) -> bool:
    """Whether any input holds a file at any depth, so that a run's inputs go through `prepare_inputs` first."""
    return any(_holds_file(node) for node in descriptor.fields)


def _holds_file(node: InputFormItem) -> bool:
    if node.kind in (FieldKind.DOCUMENT, FieldKind.IMAGE):
        return True
    if isinstance(node, ObjectItem):
        return any(_holds_file(child) for child in node.fields)
    if isinstance(node, ListItem):
        return _holds_file(node.item)
    return False


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
