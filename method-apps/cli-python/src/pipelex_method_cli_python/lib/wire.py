"""The wire format of a run's inputs: what `@pipelex/mthds-form` sends for a value, ported so the CLI sends the same.

The web app template fills a run's inputs through the TypeScript form kernel, `@pipelex/mthds-form`,
and this CLI fills them from its command line. Both must put the same value on the wire for the
same field, or a method would behave differently depending on which template ran it. So the
kernel's rules about the payload are ported here, function by function, and named after the
originals, and `tests/test_wire_table.py` replays a table recorded from the TypeScript kernel
through the CLI to hold the two together (`docs/cli-kernel.md`).

What is ported is the payload half of the kernel, never its rendering:

- `content_key`, from `derive.ts`'s `scalarWrapperKey`: the single property a native scalar's value
  sits inside (`{"text": …}`, `{"number": …}`, `{"yes_no": …}`), read off the input's JSON Schema
  rather than off a list of concepts;
- `wrap_content`, from `values.ts`'s `toRjsf`: a scalar put inside that property, a file as
  `{"url", "filename"}`;
- `heal_string_wrappers` and `prune_empty_optionals`, from `wire-format.ts`: a lone `{"text": …}`
  where the schema wants a string is unwrapped, a midnight timestamp where it wants a calendar date
  is cut to the day, and an optional property left empty is dropped;
- `is_filled`, from `readiness.ts`: whether a value holds anything, the one test that decides
  whether an input is present;
- `envelope`, from `gate.ts`'s `apiInputsFromSchemaData`: an unfilled optional input omitted, an
  unfilled plural one sent as a bare empty list, and anything else as `{"concept", "content"}`.

The kernel's JSON Schema validation (ajv) is not ported: the API validates the same contract
before any inference runs, and the person running the command holds the key it spends, so there is
no trust boundary for a second gate to guard (design box C).
"""

import re
from datetime import date
from typing import Any, cast

from mthds.protocol.pipe_io_contracts import PipeInputContract

#: A JSON Schema node, as the contract carries it.
JsonSchema = dict[str, Any]

#: The envelope a run's input travels in: the concept it is, and its content.
CONCEPT_KEY = "concept"
CONTENT_KEY = "content"

#: Where a JSON Schema reference points when it names one of the schema's own definitions.
_DEFS_PREFIX = "#/$defs/"

#: How many layers of `$ref` and nullable `anyOf` a resolution unwraps before it stops, as the
#: TypeScript kernel's `MAX_INDIRECTION_HOPS`: pydantic stacks a handful, so a longer chain is a cycle.
_MAX_INDIRECTION_HOPS = 16

#: How deep `is_filled` walks before it answers `False`, as the TypeScript kernel's `MAX_FILLED_DEPTH`.
_MAX_FILLED_DEPTH = 64

#: The primitive types a simple `anyOf` branch can carry, which flatten to a `type` list.
_PRIMITIVE_TYPES = frozenset({"string", "number", "integer", "boolean", "null"})

#: The keys a simple primitive branch may carry besides its `type`.
_SIMPLE_BRANCH_KEYS = frozenset({"type", "default", "description", "title"})

#: `YYYY-MM-DD`, with no time. Every date pattern here is ASCII: Python's `\d` would otherwise take
#: any script's digits, an Arabic-Indic or a fullwidth date, which the kernel's `\d` refuses.
_FULL_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})", re.ASCII)

#: A timestamp whose clock reads exactly zero, which denotes nothing but its day.
_ZERO_TIME_DATE_TIME = re.compile(r"(\d{4}-\d{2}-\d{2})[T ]00:00(?::00(?:\.0+)?)?(?:Z|z|[+-]\d{2}:?\d{2})?", re.ASCII)

#: A timestamp the runtime reads as a point in time.
_DATE_TIME = re.compile(r"(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|z|[+-]\d{2}:?\d{2})?", re.ASCII)


def collect_defs(schema: JsonSchema, *, traverse_arrays: bool) -> dict[str, JsonSchema]:
    """Every `$defs` entry anywhere in `schema`, in one flat map, the first definition of a name winning.

    `traverse_arrays` says whether the walk enters JSON arrays (`anyOf` branches, tuple `items`): the
    field mapper does, the wire-format repair does not, and each caller states which, as in the
    TypeScript kernel's `collectSchemaDefs`.
    """
    found: dict[str, JsonSchema] = {}
    _collect_defs_into(schema, found, traverse_arrays=traverse_arrays)
    return found


def _collect_defs_into(schema: JsonSchema, into: dict[str, JsonSchema], *, traverse_arrays: bool) -> None:
    for key, value in schema.items():
        if key == "$defs" and isinstance(value, dict):
            for name, definition in cast("dict[str, Any]", value).items():
                if name not in into and isinstance(definition, dict):
                    into[name] = cast("JsonSchema", definition)
                    _collect_defs_into(cast("JsonSchema", definition), into, traverse_arrays=traverse_arrays)
        elif isinstance(value, dict):
            _collect_defs_into(cast("JsonSchema", value), into, traverse_arrays=traverse_arrays)
        elif traverse_arrays and isinstance(value, list):
            for item in cast("list[Any]", value):
                if isinstance(item, dict):
                    _collect_defs_into(cast("JsonSchema", item), into, traverse_arrays=traverse_arrays)


def _definition(schema: JsonSchema, defs: dict[str, JsonSchema]) -> JsonSchema | None:
    """The definition a `#/$defs/…` reference names, or `None` when `schema` is not one or it is unknown."""
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith(_DEFS_PREFIX):
        return defs.get(ref.removeprefix(_DEFS_PREFIX))
    return None


def _non_null_branches(schema: JsonSchema) -> list[JsonSchema] | None:
    """The branches of an `anyOf` other than `{"type": "null"}`, or `None` when there is no `anyOf`."""
    branches = schema.get("anyOf")
    if not isinstance(branches, list):
        return None
    schemas = [cast("JsonSchema", branch) for branch in cast("list[Any]", branches) if isinstance(branch, dict)]
    return [branch for branch in schemas if branch.get("type") != "null"]


def resolve_schema_node(schema: JsonSchema, defs: dict[str, JsonSchema]) -> JsonSchema:
    """Resolve `$ref` and nullable-`anyOf` layers to their fixpoint, as `schema-utils.ts`'s `resolveSchemaNode`.

    A reference is replaced by its definition with the referencing node's sibling keys merged over
    it, and an `anyOf` with exactly one non-null branch by that branch merged over the node.
    """
    current = schema
    for _ in range(_MAX_INDIRECTION_HOPS):
        resolved = _definition(current, defs)
        if resolved is not None:
            current = {**resolved, **{key: value for key, value in current.items() if key != "$ref"}}
            continue
        branches = _non_null_branches(current)
        if branches is not None and len(branches) == 1:
            current = {**{key: value for key, value in current.items() if key != "anyOf"}, **branches[0]}
            continue
        return current
    return current


def resolve_schema_indirection(schema: JsonSchema, defs: dict[str, JsonSchema]) -> JsonSchema:
    """Resolve `$ref` and nullable-`anyOf` layers by replacement, as `schema-utils.ts`'s `resolveSchemaIndirection`.

    The wire-format repair resolves this way: a reference becomes its definition and a nullable
    `anyOf` its one non-null branch, with nothing of the outer node kept.
    """
    current = schema
    for _ in range(_MAX_INDIRECTION_HOPS):
        resolved = _definition(current, defs)
        if resolved is not None:
            current = resolved
            continue
        branches = _non_null_branches(current)
        if branches is not None and len(branches) == 1:
            current = branches[0]
            continue
        return current
    return current


def schema_type(schema: JsonSchema) -> str | None:
    """The node's non-null type: its `type`, the first non-null entry of a `type` list, or a simple `anyOf`'s.

    The TypeScript kernel flattens an `anyOf` of unconstrained primitives into a `type` list before
    it reads the type (`flattenAnyOf`), so such a union is read here as that list would be.
    """
    declared = schema.get("type")
    if isinstance(declared, str):
        return declared
    if isinstance(declared, list):
        return next((entry for entry in cast("list[Any]", declared) if isinstance(entry, str) and entry != "null"), None)
    branches = schema.get("anyOf")
    if isinstance(branches, list) and all(_is_simple_primitive(branch) for branch in cast("list[Any]", branches)):
        types = [cast("JsonSchema", branch)["type"] for branch in cast("list[Any]", branches)]
        return next((entry for entry in types if entry != "null"), None)
    return None


def _is_simple_primitive(branch: object) -> bool:
    if not isinstance(branch, dict):
        return False
    node = cast("JsonSchema", branch)
    return node.get("type") in _PRIMITIVE_TYPES and all(key in _SIMPLE_BRANCH_KEYS for key in node)


def content_key(schema: JsonSchema | None) -> str | None:
    """The single property a scalar content model holds its value in, as `derive.ts`'s `scalarWrapperKey`.

    A wrapper is a schema declaring exactly one property, `TextContent {text}` or `NumberContent
    {number}`. A content model with several, `DateContent {date, time}`, is no wrapper, and a plain
    string, the type of a structure's own text field, has no property to wrap into.
    """
    if schema is None:
        return None
    properties = schema.get("properties")
    if isinstance(properties, dict) and len(cast("dict[str, Any]", properties)) == 1:
        return next(iter(cast("dict[str, Any]", properties)))
    return None


def wrap_content(key: str | None, value: object) -> object:
    """Put a scalar inside the content model its concept declares: `"hi"` becomes `{"text": "hi"}` under `text`."""
    return value if key is None else {key: value}


def file_content(url: str, filename: str | None = None) -> dict[str, str]:
    """A file input's content as the form kernel builds it: its `url`, and its `filename` when there is one."""
    return {"url": url, "filename": filename} if filename else {"url": url}


def is_filled(value: object) -> bool:
    """Whether a value holds anything, as `readiness.ts`'s `isFilled`.

    Whitespace is no value, an empty list or object holds nothing, a file is filled when its `url`
    is, and a container is filled when any of its members is. `False` and `0` are values.
    """
    return _walk_filled(value, 0)


def _walk_filled(value: object, depth: int) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if not isinstance(value, (list, dict)):
        return True
    if depth >= _MAX_FILLED_DEPTH:
        return False
    if isinstance(value, list):
        return any(_walk_filled(item, depth + 1) for item in cast("list[Any]", value))
    members = cast("dict[str, Any]", value)
    if "url" in members:
        return _walk_filled(members["url"], depth + 1)
    return any(_walk_filled(child, depth + 1) for child in members.values())


def as_calendar_date(value: str) -> str | None:
    """The calendar day a value denotes, or `None`, as `date-format.ts`'s `asCalendarDate`.

    A bare `YYYY-MM-DD` is its own day, and so is a timestamp whose clock reads zero, taken
    literally rather than shifted through its offset; a timestamp carrying a real time denotes no day.
    """
    if _is_real_calendar_date(value):
        return value
    zero_time = _ZERO_TIME_DATE_TIME.fullmatch(value)
    if zero_time is not None and _is_real_calendar_date(zero_time.group(1)):
        return zero_time.group(1)
    return None


def is_acceptable_date_time(value: str) -> bool:
    """Whether a value is a point in time the runtime reads, as `date-format.ts`'s `isAcceptableDateTime`."""
    if _is_real_calendar_date(value):
        return True
    match = _DATE_TIME.fullmatch(value)
    if match is None or not _is_real_calendar_date(match.group(1)):
        return False
    hours, minutes, seconds = int(match.group(2)), int(match.group(3)), int(match.group(4) or 0)
    return hours <= 23 and minutes <= 59 and seconds <= 59


def _is_real_calendar_date(value: str) -> bool:
    match = _FULL_DATE.fullmatch(value)
    if match is None:
        return False
    try:
        date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return False
    return True


def _members(value: object) -> dict[str, Any] | None:
    """A JSON object's members, or `None` for any other value: the caller's JSON, read without narrowing it."""
    return cast("dict[str, Any]", value) if isinstance(value, dict) else None


def _elements(value: object) -> list[Any] | None:
    """A JSON array's elements, or `None` for any other value."""
    return cast("list[Any]", value) if isinstance(value, list) else None


def heal_string_wrappers(value: object, raw_schema: JsonSchema | None, defs: dict[str, JsonSchema]) -> object:
    """Repair a value against its schema, as `wire-format.ts`'s `healStringWrappers`.

    Where the schema wants a string and the value is a lone `{"text": …}`, the text is taken; where
    it wants a calendar date (`format: date`) and the value is a midnight timestamp, the day is.
    """
    if raw_schema is None or value is None:
        return value
    schema = resolve_schema_indirection(raw_schema, defs)
    kind = schema_type(schema)
    members = _members(value)
    elements = _elements(value)
    if kind == "string" and schema.get("format") == "date" and isinstance(value, str):
        return as_calendar_date(value) or value
    if kind == "string":
        if members is not None and len(members) == 1 and isinstance(members.get("text"), str):
            return members["text"]
        return value
    if kind == "object" and members is not None:
        properties = schema.get("properties")
        if not isinstance(properties, dict):
            return members
        healed = dict(members)
        for key, child_schema in cast("dict[str, Any]", properties).items():
            if key in healed and isinstance(child_schema, dict):
                healed[key] = heal_string_wrappers(healed[key], cast("JsonSchema", child_schema), defs)
        return healed
    if kind == "array" and elements is not None:
        items = schema.get("items")
        item_schema = cast("JsonSchema", items) if isinstance(items, dict) else None
        return [heal_string_wrappers(item, item_schema, defs) for item in elements]
    return value


def prune_empty_optionals(value: object, raw_schema: JsonSchema | None, defs: dict[str, JsonSchema]) -> object:
    """Drop the optional properties left empty, as `wire-format.ts`'s `pruneEmptyOptionals`.

    A property absent from its parent's `required` whose value is empty once pruned itself, an empty
    string, `null` or an object left with nothing, is dropped. An empty list is a value, never empty:
    a plural slot's empty form is the empty list.
    """
    if raw_schema is None or value is None:
        return value
    schema = resolve_schema_indirection(raw_schema, defs)
    kind = schema_type(schema)
    members = _members(value)
    elements = _elements(value)
    if kind == "array" and elements is not None:
        items = schema.get("items")
        item_schema = cast("JsonSchema", items) if isinstance(items, dict) else None
        return [prune_empty_optionals(item, item_schema, defs) for item in elements]
    if kind != "object" or members is None:
        return value
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return members
    declared = cast("dict[str, Any]", properties)
    required_list = schema.get("required")
    required = set(cast("list[str]", required_list)) if isinstance(required_list, list) else set[str]()
    pruned: dict[str, Any] = {}
    for key, raw in members.items():
        child_schema = declared.get(key)
        if not isinstance(child_schema, dict):
            pruned[key] = raw
            continue
        child = prune_empty_optionals(raw, cast("JsonSchema", child_schema), defs)
        if _is_empty_after_pruning(child) and key not in required:
            continue
        pruned[key] = child
    return pruned


def _is_empty_after_pruning(value: object) -> bool:
    if value is None or value == "":
        return True
    members = _members(value)
    return members is not None and not members


def runs_schema(inputs: dict[str, PipeInputContract], gating: frozenset[str]) -> JsonSchema:
    """The one object schema a run's inputs are repaired against, as `gate.ts`'s `buildRunInputsSchema`.

    Each input is a property carrying its contract's schema, and the inputs that gate the run are its
    `required`, so an input that may be left out is pruned like any optional property.
    """
    return {
        "type": "object",
        "properties": {name: contract.json_schema for name, contract in inputs.items()},
        "required": sorted(gating),
    }


def prepare(data: dict[str, Any], schema: JsonSchema) -> dict[str, Any]:
    """Heal then prune a run's inputs against their combined schema, as `gate.ts`'s `prepareRunInputs`."""
    # The kernel hoists every definition to the root of the combined schema before it repairs, arrays
    # included, so every definition is collected here whatever it sits under.
    defs = collect_defs(schema, traverse_arrays=True)
    healed = heal_string_wrappers(data, schema, defs)
    return cast("dict[str, Any]", prune_empty_optionals(healed, schema, defs))


def is_plural_input(contract: PipeInputContract) -> bool:
    """Whether an input takes a list, read off its schema as `contracts.ts`'s `isPluralInput` reads it.

    The schema is what the form shows, so the kernel asks it rather than `multiplicity`; the engine
    wraps the schema in an array exactly when it reports a plural multiplicity, so the two agree.
    """
    return contract.json_schema.get("type") == "array"


def envelope(contract: PipeInputContract, value: object) -> tuple[bool, object]:
    """The wire value of one input, as `gate.ts`'s `apiInputsFromSchemaData`: `(sent, value)`.

    An optional input that holds nothing is not sent, so the runtime records a real absence. A
    plural input that holds nothing is sent as a bare empty list, without the envelope, which is the
    form the runtime builds an empty list of the declared concept from. Anything else travels as
    `{"concept": …, "content": …}`.
    """
    plural = is_plural_input(contract)
    if contract.presence.is_optional and not is_filled(value):
        return False, None
    if plural and not is_filled(value):
        return True, list[Any]()
    content: object = value if not plural or _elements(value) is not None else list[Any]()
    return True, {CONCEPT_KEY: contract.concept_ref, CONTENT_KEY: content}
