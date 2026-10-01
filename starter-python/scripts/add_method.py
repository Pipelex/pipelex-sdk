#!/usr/bin/env python3
"""Scaffold a method that lives elsewhere into this CLI — what `make add-method` runs.

This is the second way a method reaches `widget`. The first is the one the three demos tell:
the bundle lives at `widget/methods/<name>/main.mthds`, `make codegen` projects it, and a
person writes the command that uses the projection. This script is the same story for a
method that lives **on the platform** (a catalog id) or **in a published package** (an
address): the method stays where it is, a one-line `method.json` names it, and the whole
Python fan-out is written from the method's own contract.

It writes exactly three things — the manifest, the generated tree, and one Typer command in
the execution mode you chose:

    widget/methods/<slug>/method.json          the selector, and nothing else
    widget/generated/<package>/models.py       stamped, plus codegen.lock and __init__.py
    widget/<mode>/cli.py                       its imports and one command, at the anchors

**Nothing is written until everything has been fetched and derived.** The run has a read-only
half — parse the selector, validate the method, choose the pipe, derive every name, map every
input, check every collision and locate the anchors — and a write half that runs only once all
of that has passed. Every refusal happens in the first half with nothing on disk changed, and
`--dry-run` stops at the boundary and prints the plan. The write half writes all three or none:
a failure inside it takes back what it had written, so a failed run never leaves a half-added
method for the next run to refuse and for `make codegen` to pick up.

The command it writes reads the selector from `method.json` every time it runs, rather than
carrying a copy of it, so editing the manifest's tag and running `make codegen` moves the models
and the run to the new version together.

It is one-shot, like its JS twin: it never overwrites, and `make codegen` is the refresh. The
command it writes is yours from the moment it lands — edit it, rename it, split it; nothing
here ever reads it again.

Its JS twin is `pipelex-starter-js/scripts/lib/add-method.mts`, and the differences between
the two are deliberate and documented in `docs/add-method.md`.
"""

from __future__ import annotations

import argparse
import ast
import asyncio
import builtins
import keyword
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, NamedTuple, cast

from dotenv import load_dotenv
from mthds.protocol.input_form import BooleanField, DocumentField, EnumField, FieldKind, InputFormField, NumberField
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.codegen_writer import write_codegen_tree
from pipelex_sdk.crate_models import CodegenValidReport
from pipelex_sdk.errors import CodegenError
from pipelex_sdk.validation_models import VALIDATION_VIEW_INPUT_FORM, PipelexValidationReport

from scripts.codegen import METHODS_DIR, REPO_ROOT, MethodSource, explain, generated_package_dir, insecure_base_url_reason
from widget.manifest import MANIFEST_FILENAME, SELECTOR_METHOD_ID, SELECTOR_METHOD_REF, MethodSelector, write_manifest

EXIT_OK = 0
EXIT_REFUSED = 1
#: Ctrl-C, the way the mode CLIs report it. A usage error is argparse's own exit 2.
EXIT_INTERRUPTED = 130

#: The execution modes a scaffolded command can land in, and the lifecycle helper each one owns.
#: `attended` is the default: it is the only mode that both survives the hosted ~30s cap and
#: still hands you the result in the same command, which is what a method you did not write is
#: most likely to need on its first run.
MODES = ("blocking", "attended", "detached")
DEFAULT_MODE = "attended"
MODE_HELPERS = {"blocking": "execute_pipe", "attended": "start_and_wait", "detached": "start_pipe"}

#: The names an emitted command binds inside its own body. An input parameter spelled like one of
#: them would be overwritten before it is read, or would overwrite what the body relies on.
COMMAND_LOCALS = frozenset({"selector", "run_inputs", "results", "items", "item", "run_id"})

#: The module-level names an emitted command reads, beside the generated model's alias: the
#: lifecycle helpers, the run wrapper, the consoles, the mode file's `METHODS_DIR` and what the
#: emitted import lines bring in. An input parameter spelled like one of them shadows it inside the
#: command — an input named `start_and_wait` turns the call into `'str' object is not callable` —
#: and a command named like one of them replaces it for the whole mode file. The set is kept honest
#: by `tests/unit/test_add_method.py`, which parses every shape of emitted command and fails when
#: its body reads a name that is neither a parameter nor listed here.
COMMAND_GLOBALS = frozenset(
    {
        "METHODS_DIR",
        "MANIFEST_FILENAME",
        "read_manifest",
        "_run",
        "_print_run_id",
        "upload_document_input",
        "list_items",
        "output_console",
        "progress_console",
        "print_cost_report",
        "print_downloads",
        "download_produced_files",
        "DEFAULT_DOWNLOAD_DIR",
        *MODE_HELPERS.values(),
    }
)

#: Python's builtin names. A command named after one replaces it for the whole mode file — a
#: detached command named `print` turns `_print_run_id` into a second run of itself — and an input
#: named after one is a parameter ruff refuses (A002) and cannot fix. Both are refused.
BUILTIN_NAMES = frozenset(dir(builtins))

#: The run-lifecycle commands `widget detached` owns. `tests/unit/test_mode_symmetry.py` keeps them
#: out of every other mode, so a command by one of these names is refused in every mode rather than
#: written into one and failing that suite afterwards.
LIFECYCLE_COMMANDS = frozenset({"wait", "status", "result"})

#: The two anchor tokens each `widget/<mode>/cli.py` carries. The match is on the token alone, so
#: the prose after it is free to be reworded — but the tokens themselves must not move or be
#: deleted. `tests/unit/test_add_method.py` reads the real mode files, so losing one fails the suite.
IMPORT_ANCHOR = "# add-method:imports"
COMMAND_ANCHOR = "# add-method:commands"

#: A catalog id, and the address form of a published method — with or without an `https://` prefix,
#: with or without a package segment, with or without a tag. Anything else is refused naming both.
CATALOG_ID_PATTERN = re.compile(r"^mt_[A-Za-z0-9_-]+$")
ADDRESS_PATTERN = re.compile(r"^(?:https?://)?(?P<address>github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)?(?:@[A-Za-z0-9._-]+)?)$")

#: A slug has to be a directory name, a command name and the stem of a Python package at once.
SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

#: The input kinds a Typer command can take as a parameter, and what each becomes.
#: `object` and `list` are refused rather than guessed at: a nested value has no honest spelling
#: as a command-line flag, and inventing a JSON encoding for it would be a hand-written input
#: shape — the one thing this starter never does. `image` is refused for a narrower reason: the
#: starter uploads documents (`upload_document_input`) and has no image-input envelope to copy.
SCALAR_TYPES = {
    FieldKind.TEXT: "str",
    FieldKind.PROSE: "str",
    FieldKind.DATE: "str",
    FieldKind.ENUM: "str",
    FieldKind.BOOLEAN: "bool",
}
REFUSED_KINDS = {
    FieldKind.OBJECT: "a structured input has no honest spelling as a command-line flag",
    FieldKind.LIST: "a list input has no honest spelling as a command-line flag",
    FieldKind.IMAGE: "this starter uploads documents only — there is no image-input envelope to copy",
    FieldKind.UNKNOWN: "the method reports this input's kind as unknown, so there is nothing to derive a parameter from",
}


#: What `GET /v1/version`'s `extensions` array calls the capability behind each selector.
SELECTOR_EXTENSIONS = {SELECTOR_METHOD_ID: SELECTOR_METHOD_ID, SELECTOR_METHOD_REF: SELECTOR_METHOD_REF}


class Refusal(Exception):
    """Something the run will not guess at. Printed as the one line it carries, nothing written."""


class Names(NamedTuple):
    """Every name a scaffolded slice uses, all derived from one kebab-case slug."""

    slug: str
    package: str
    command: str
    model_alias: str


class Parameter(NamedTuple):
    """One Typer parameter of the emitted command, and how its value reaches the run inputs."""

    name: str
    annotation: str
    declaration: str
    assignment: list[str]
    required: bool


class Plan(NamedTuple):
    """Everything the read-only half derived. The write half needs nothing else."""

    names: Names
    selector: MethodSelector
    mode: str
    pipe_ref: str
    parameters: list[Parameter]
    model_name: str
    is_plural: bool
    method_dir: Path
    generated_dir: Path
    mode_file: Path


# ── The read-only half ──────────────────────────────────────────────────────────────────


async def read_advertised_capabilities(client: PipelexAPIClient) -> list[str]:
    """What `GET /v1/version` says this deployment can do, or nothing when it will not say.

    The handshake is one request and it is never a reason to stop: a version call that fails, or a
    response advertising nothing, both come back empty and the run proceeds to the real call,
    whose own error is the better message in both cases.
    """
    try:
        info = await client.version()
    # Broad on purpose: this is a courtesy handshake, and no failure of it is a verdict about the
    # method. Anything that goes wrong here is answered by proceeding, not by reporting.
    except Exception:
        return []
    extra: dict[str, Any] = info.model_extra or {}
    advertised: object = extra.get("extensions")
    if not isinstance(advertised, list):
        return []
    return [str(item) for item in cast("list[Any]", advertised)]


def unsupported_selector_reason(*, base_url: str, advertised: list[str], selector: MethodSelector) -> str | None:
    """Why this deployment cannot resolve this selector, or `None` when it can — or cannot say.

    A selector is resolved **server-side**, so the API has to support it, and asking once turns an
    opaque 403 or 422 from the real call into a line naming the base URL and the missing
    capability. Measured on 2026-09-13, `api.pipelex.com` advertises `runs` and `method_id` and
    not `method_ref`, so an address scaffolded against it fails — and used to fail unreadably.

    An empty `advertised` is "no verdict", never "supports nothing".
    """
    if not advertised:
        return None
    kind = SELECTOR_EXTENSIONS[SELECTOR_METHOD_ID if selector.method_id is not None else SELECTOR_METHOD_REF]
    if kind in advertised:
        return None
    return (
        f"this base URL does not advertise `{kind}`, so it cannot resolve the method.\n"
        f"    Base URL: {base_url}\n"
        f"    It advertises: {', '.join(advertised)}.\n"
        f"    Point PIPELEX_BASE_URL at a deployment that serves `{kind}`, or use a selector this one does."
    )


def parse_selector(raw: str) -> MethodSelector:
    """Read the one required argument as a catalog id or a published address.

    There is deliberately no local `.mthds` path: that story already exists — put the bundle in
    `widget/methods/<name>/` and run `make codegen`.

    Raises:
        Refusal: The value is neither form.
    """
    candidate = raw.strip()
    if CATALOG_ID_PATTERN.match(candidate):
        return MethodSelector(method_id=candidate)
    address_match = ADDRESS_PATTERN.match(candidate)
    if address_match is not None:
        return MethodSelector(method_ref=address_match.group("address"))
    msg = (
        f"{raw!r} is neither a catalog id nor a published address.\n"
        "    A catalog id looks like `mt_abc123` (a method saved on app.pipelex.com).\n"
        "    An address looks like `github.com/owner/repo/package@v1.0.0`.\n"
        "    A bundle you have on disk is not scaffolded: put it in widget/methods/<name>/ and run `make codegen`."
    )
    raise Refusal(msg)


def slug_from_selector(selector: MethodSelector) -> str:
    """Derive the slug from an address, the one selector that carries a name.

    The last path segment of the address — the package, falling back to the repository for an
    address naming none — is what a person would call the method. A catalog id carries no name
    this starter can read: resolving one is a product-route call (`GET /v1/methods/{id}`) and
    `widget` deliberately speaks only the protocol routes, so a catalog id asks for `NAME=`.

    Raises:
        Refusal: The selector is a catalog id.
    """
    if selector.method_ref is None:
        msg = (
            "a catalog id carries no name this starter can read — pass one with NAME=<dir-name>.\n"
            "    e.g. make add-method METHOD=mt_abc123 NAME=invoice-triage"
        )
        raise Refusal(msg)
    address = selector.method_ref.split("@", 1)[0]
    return kebab_case(address.rstrip("/").rsplit("/", 1)[-1])


def kebab_case(raw: str) -> str:
    """Turn a package, repository or human name into the kebab-case slug every name derives from."""
    spaced = re.sub(r"[_\s]+", "-", raw.strip())
    hyphenated = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", spaced)
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-zA-Z0-9-]", "", hyphenated)).strip("-").lower()


def derive_names(slug: str) -> Names:
    """Every derived name, from the slug alone.

    Raises:
        Refusal: The slug cannot be a directory name, a command name and a package stem at once.
    """
    if not SLUG_PATTERN.match(slug):
        msg = f"{slug!r} cannot be a method name: use lowercase words separated by single dashes, e.g. `invoice-triage`."
        raise Refusal(msg)
    package = slug.replace("-", "_")
    if keyword.iskeyword(package) or not package.isidentifier():
        msg = f"{slug!r} derives the Python package {package!r}, which is not a usable identifier."
        raise Refusal(msg)
    pascal = "".join(word.capitalize() for word in slug.split("-"))
    return Names(slug=slug, package=package, command=package, model_alias=f"{pascal}Output")


def choose_pipe(*, report: PipelexValidationReport, requested: str | None) -> str:
    """Pick which pipe of the method the command runs, ending in a refusal rather than a guess.

    In order: the requested pipe (bare or qualified), the method's own `default_pipe_ref`, the only
    pipe it declares, and otherwise a refusal listing what it does declare.

    Raises:
        Refusal: The requested pipe is unknown or ambiguous, or the method declares several pipes
            and names no default.
    """
    declared = sorted(report.pipe_io_contracts)
    if not declared:
        msg = "the method declares no pipes, so there is nothing to run."
        raise Refusal(msg)
    if requested is not None:
        if requested in report.pipe_io_contracts:
            return requested
        matches = [pipe_ref for pipe_ref in declared if pipe_ref.rsplit(".", 1)[-1] == requested]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            msg = f"`{requested}` is ambiguous — it matches {', '.join(matches)}. Qualify it with its domain."
            raise Refusal(msg)
        msg = f"the method declares no pipe `{requested}`. It declares: {', '.join(declared)}."
        raise Refusal(msg)
    if report.default_pipe_ref is not None and report.default_pipe_ref in report.pipe_io_contracts:
        return report.default_pipe_ref
    if len(declared) == 1:
        return declared[0]
    msg = f"the method declares several pipes and names no default — pass PIPE=<pipe_code>. It declares: {', '.join(declared)}."
    raise Refusal(msg)


def literal(text: str) -> str:
    """A Python string literal for a help line, collapsed to one line and bounded."""
    collapsed = " ".join(text.split())
    return repr(collapsed[:117] + "…" if len(collapsed) > 118 else collapsed)


def build_parameter(field: InputFormField) -> Parameter:
    """Map one top-level input field onto a Typer parameter and its inputs assignment.

    Raises:
        Refusal: The field's kind has no honest command-line spelling, or its name cannot be a
            Python parameter.
    """
    kind = FieldKind(field.kind)
    if kind in REFUSED_KINDS:
        msg = (
            f"input `{field.name}` is a `{kind}` — {REFUSED_KINDS[kind]}.\n"
            "    Write this command by hand from the generated model instead; `docs/add-method.md` says how."
        )
        raise Refusal(msg)
    name = field.name
    if not name.isidentifier() or keyword.iskeyword(name):
        msg = f"input `{name}` cannot be a Python parameter of the emitted command — rename it in the method, or write the command by hand."
        raise Refusal(msg)
    if name in COMMAND_LOCALS or name in COMMAND_GLOBALS:
        msg = f"input `{name}` would shadow `{name}`, which the emitted command itself uses — rename it in the method, or write the command by hand."
        raise Refusal(msg)
    if name in BUILTIN_NAMES:
        msg = (
            f"input `{name}` is spelled like a Python builtin, a parameter `make agent-check` refuses (ruff A002) — "
            "rename it in the method, or write the command by hand."
        )
        raise Refusal(msg)
    help_text = literal(field.description or field.title or name)
    flag = "--" + name.replace("_", "-")

    if isinstance(field, DocumentField):
        if field.required:
            declaration = f"    {name}: Annotated[Path, typer.Argument(exists=True, dir_okay=False, help={help_text})],"
            assignment = [f'    run_inputs["{name}"] = _run(upload_document_input({name}))']
        else:
            declaration = f'    {name}: Annotated[Path | None, typer.Option("{flag}", exists=True, dir_okay=False, help={help_text})] = None,'
            assignment = [f"    if {name} is not None:", f'        run_inputs["{name}"] = _run(upload_document_input({name}))']
        return Parameter(name=name, annotation="Path", declaration=declaration, assignment=assignment, required=field.required)

    if isinstance(field, NumberField):
        annotation = "int" if field.integer else "float"
    elif isinstance(field, EnumField):
        annotation = SCALAR_TYPES[kind]
        help_text = literal(f"{field.description or field.title or name} One of: {', '.join(field.choices)}.")
    else:
        annotation = SCALAR_TYPES[kind]

    if isinstance(field, BooleanField):
        # A boolean is never a positional: `widget … true` reads as nothing at all. Required or not,
        # it is a flag pair — required means Typer demands it, it does not mean it is positional.
        pair = f'"{flag}/--no-{name.replace("_", "-")}"'
        if field.required:
            declaration = f"    {name}: Annotated[bool, typer.Option({pair}, help={help_text})],"
        else:
            declaration = f"    {name}: Annotated[bool | None, typer.Option({pair}, help={help_text})] = None,"
    elif field.required:
        declaration = f"    {name}: Annotated[{annotation}, typer.Argument(help={help_text})],"
    else:
        declaration = f'    {name}: Annotated[{annotation} | None, typer.Option("{flag}", help={help_text})] = None,'

    if field.required:
        assignment = [f'    run_inputs["{name}"] = {name}']
    else:
        assignment = [f"    if {name} is not None:", f'        run_inputs["{name}"] = {name}']
    return Parameter(name=name, annotation=annotation, declaration=declaration, assignment=assignment, required=field.required)


def build_parameters(*, report: PipelexValidationReport, pipe_ref: str) -> list[Parameter]:
    """Every Typer parameter of the emitted command, required ones first.

    The order is forced by Python, not by taste: a parameter with no default cannot follow one
    that has a default. Within each group the method's own authored input order is kept, which is
    what the input-form descriptor exists to carry.

    Raises:
        Refusal: The method reported no input form, or one of the pipe's inputs cannot be mapped.
    """
    if report.input_form is None or pipe_ref not in report.input_form:
        msg = (
            f"this deployment returned no input form for `{pipe_ref}`, so the command's parameters cannot be derived.\n"
            "    The `input_form` view of POST /v1/validate is what carries them; check PIPELEX_BASE_URL."
        )
        raise Refusal(msg)
    parameters = [build_parameter(field) for field in report.input_form[pipe_ref].fields]
    return [parameter for parameter in parameters if parameter.required] + [parameter for parameter in parameters if not parameter.required]


def output_model_name(*, report: PipelexValidationReport, pipe_ref: str) -> tuple[str, bool]:
    """The generated model the command narrows into, and whether the output is plural."""
    output = report.pipe_io_contracts[pipe_ref].output
    return output.concept_ref.rsplit(".", 1)[-1], output.multiplicity.is_plural


def module_bindings(*, text: str, label: str) -> set[str]:
    """Every name a mode file binds at module level: its imports, assignments, functions and classes.

    A command is a module-level `def`, so a command named like any of these replaces it for the
    whole file — `NAME=app` would replace the mode's `typer.Typer` instance and take the root CLI
    down with it. Names bound inside a compound statement at module level (an `if`, a `try`)
    count too; names bound inside a module-level function or class do not, since a `def` beside
    them does not reach them.

    Raises:
        Refusal: The mode file does not parse, so nothing can be inserted into it safely.
    """
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        msg = f"{label} does not parse (line {exc.lineno}: {exc.msg}) — fix it before scaffolding into it."
        raise Refusal(msg) from exc
    bound: set[str] = set()
    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(statement.name)
            continue
        for node in ast.walk(statement):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                bound.add(node.name)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                bound.update((alias.asname or alias.name).split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                bound.add(node.id)
    return bound


# ── Emitting the command ────────────────────────────────────────────────────────────────


def build_command_source(plan: Plan) -> str:
    """The Typer command, as the source that lands in `widget/<mode>/cli.py`.

    Every fact in it comes from the method's own contract: the parameters from the input-form
    descriptor, the narrowing from the output contract, the selector from the manifest. Nothing
    is a shape written by hand, which is the same rule the demos follow.

    The selector is **read from `method.json` when the command runs**, never copied into it: a
    copy would keep running the old version after the documented upgrade — edit the tag, run
    `make codegen` — had moved the models to the new one. The pipe is sent **qualified**, as the
    ref the pipe rule chose: a bare code is ambiguous exactly when the method declares it in two
    domains, which is the case the rule already refused to guess at, and the runtime resolves a
    `domain.pipe_code` directly.
    """
    helper = MODE_HELPERS[plan.mode]
    lines = [
        f'@app.command(name="{plan.names.slug}")',
        f"def {plan.names.command}(",
        *[parameter.declaration for parameter in plan.parameters],
        ") -> None:",
        f'    """Run `{plan.pipe_ref}`.',
        "",
        "    Scaffolded by `make add-method` and yours to edit from here — nothing regenerates it.",
        f"    The method is whatever `widget/methods/{plan.names.slug}/method.json` names when this runs, and",
        "    `make codegen` refreshes the generated models this narrows into, and nothing else.",
        '    """',
        f'    selector = read_manifest(METHODS_DIR / "{plan.names.slug}" / MANIFEST_FILENAME)',
        "    run_inputs: dict[str, Any] = {}",
        *[line for parameter in plan.parameters for line in parameter.assignment],
    ]
    call = f'{helper}(pipe_code="{plan.pipe_ref}", method_id=selector.method_id, method_ref=selector.method_ref, inputs=run_inputs)'
    # Dumped in JSON mode: a generated model turns a date, datetime or time on the wire into a Python
    # object, which `print_json` cannot encode — the run would be billed and then crash on its result.
    if plan.mode == "detached":
        lines += [f"    run_id = _run({call})", "    _print_run_id(run_id)"]
    elif plan.is_plural:
        lines += [
            f"    results = _run({call})",
            f"    items = [{plan.names.model_alias}.model_validate(item) for item in list_items(results.main_stuff)]",
            '    output_console.print_json(data=[item.model_dump(mode="json") for item in items])',
            "    print_downloads(progress_console, _run(download_produced_files(results, dir_path=DEFAULT_DOWNLOAD_DIR)))",
            "    print_cost_report(progress_console, results)",
        ]
    else:
        lines += [
            f"    results = _run({call})",
            f'    output_console.print_json(data={plan.names.model_alias}.model_validate(results.main_stuff).model_dump(mode="json"))',
            "    print_downloads(progress_console, _run(download_produced_files(results, dir_path=DEFAULT_DOWNLOAD_DIR)))",
            "    print_cost_report(progress_console, results)",
        ]
    return "\n".join(lines) + "\n"


def import_lines(plan: Plan) -> list[str]:
    """The imports the emitted command needs, in whatever order — they are sorted on insertion.

    Every mode reads the manifest. The two result-producing modes also narrow the output, bring
    down whatever files it references and print a cost report. Detached does none of that (its demos
    print the run id and collect it later by id), so it needs no generated model, no list reader and
    no download.
    """
    lines = ["from widget.manifest import MANIFEST_FILENAME, read_manifest"]
    if plan.mode == "detached":
        return lines
    lines.append("from widget.artifacts import DEFAULT_DOWNLOAD_DIR, download_produced_files, print_downloads")
    lines.append(f"from widget.generated.{plan.names.package}.models import {plan.model_name} as {plan.names.model_alias}")
    if plan.is_plural:
        lines.append("from widget.outputs import list_items")
    return lines


def insert_into_mode_file(*, text: str, imports: list[str], command_source: str) -> str:
    """Put the imports and the command into a mode file at its two anchors.

    The import goes into the `from widget.…` block in sorted position — the block ruff's isort
    would produce anyway, so `make check` stays green with no fix-up pass — and the command goes
    directly above the command anchor. An import already present is not added twice.

    Raises:
        Refusal: Either anchor is missing, or the file has no first-party import block.
    """
    for anchor in (IMPORT_ANCHOR, COMMAND_ANCHOR):
        if anchor not in text:
            msg = f"the mode file has lost its `{anchor}` anchor — restore it before scaffolding."
            raise Refusal(msg)
    lines = text.splitlines(keepends=True)
    block = [index for index, line in enumerate(lines) if line.startswith("from widget.")]
    if not block:
        msg = "the mode file has no `from widget.…` import block to insert into."
        raise Refusal(msg)

    for import_line in sorted(imports, reverse=True):
        if any(line.strip() == import_line for line in lines):
            continue
        block = [index for index, line in enumerate(lines) if line.startswith("from widget.")]
        position = next((index for index in block if lines[index] > import_line), block[-1] + 1)
        lines.insert(position, import_line + "\n")

    anchor_index = next(index for index, line in enumerate(lines) if line.lstrip().startswith(COMMAND_ANCHOR))
    lines.insert(anchor_index, command_source + "\n\n")
    return "".join(lines)


# ── The write half ──────────────────────────────────────────────────────────────────────


def format_with_ruff(path: Path) -> str | None:
    """Format one emitted file with this project's own ruff, so it lands `make check`-clean.

    Returns what went wrong when ruff could not be found, could not be started or failed, so the
    caller can say so rather than leave a file nobody warned about. None of those is a failure of
    the scaffold: the slice is already written in full and `write_slice` compiled the mode file
    before writing it, so what is missing is the formatting alone, which `make agent-check` applies.
    """
    ruff = Path(sys.executable).parent / "ruff"
    executable = str(ruff) if ruff.is_file() else shutil.which("ruff")
    if executable is None:
        return "ruff was not found — run `make agent-check` to format the file this run touched."
    try:
        subprocess.run([executable, "format", str(path)], check=True, cwd=REPO_ROOT)
    except subprocess.CalledProcessError as exc:
        return (
            f"ruff format exited {exc.returncode} on {path.relative_to(REPO_ROOT)} — "
            "the command is written and parses; run `make agent-check` to format it."
        )
    except OSError as exc:
        return f"ruff could not be started ({exc}) — run `make agent-check` to format the file this run touched."
    return None


def write_slice(*, plan: Plan, report: CodegenValidReport) -> list[str]:
    """Write the manifest, the generated tree and the command — all three, or none. Returns what changed, in order.

    The mode file's new text is built and compiled before anything touches the disk, so a command
    that would not parse writes nothing. A failure after that — the codegen writer refusing the
    tree, the filesystem refusing a write, a Ctrl-C — takes back what this run wrote: the two
    directories it created, which `build_plan` refused to go on without being new and which
    `mkdir` refuses again here if one has appeared since, and the mode file's original text. A
    half-written slice would otherwise be refused by the next run as a name that already exists,
    and read by `make codegen` as a method nobody finished adding.

    Raises:
        Refusal: The mode file would not parse with the command in it.
        CodegenError: The codegen writer refused the tree.
        OSError: The filesystem refused a write, or a directory appeared since the plan was made.
    """
    original_mode_text = plan.mode_file.read_text(encoding="utf-8")
    merged_mode_text = insert_into_mode_file(text=original_mode_text, imports=import_lines(plan), command_source=build_command_source(plan))
    try:
        compile(merged_mode_text, str(plan.mode_file), "exec")
    except SyntaxError as exc:
        msg = f"{plan.mode_file.relative_to(REPO_ROOT)} would not parse with the command in it (line {exc.lineno}: {exc.msg})."
        raise Refusal(msg) from exc

    changed: list[str] = []
    created: list[Path] = []
    mode_file_written = False
    completed = False
    try:
        for directory in (plan.method_dir, plan.generated_dir):
            directory.mkdir(parents=True)
            created.append(directory)
        manifest_path = plan.method_dir / MANIFEST_FILENAME
        write_manifest(manifest_path, plan.selector)
        changed.append(f"wrote {manifest_path.relative_to(REPO_ROOT)}")

        written = write_codegen_tree(report, output_dir=plan.generated_dir)
        changed += [f"wrote {path}" for path in written.written]
        if written.lock_written:
            changed.append("wrote codegen.lock")
        # Codegen never emits `__init__.py`: it carries no stamp, so the writer does not own it and
        # the drift check does not count it as an orphan. The package still has to be importable.
        init_path = plan.generated_dir / "__init__.py"
        if not init_path.exists():
            init_path.touch()
            changed.append(f"wrote {init_path.relative_to(REPO_ROOT)}")

        mode_file_written = True
        plan.mode_file.write_text(merged_mode_text, encoding="utf-8")
        changed.append(f"wrote the `{plan.names.slug}` command into {plan.mode_file.relative_to(REPO_ROOT)}")
        completed = True
    finally:
        if not completed:
            for directory in created:
                shutil.rmtree(directory)
            if mode_file_written:
                plan.mode_file.write_text(original_mode_text, encoding="utf-8")
    return changed


def print_plan(plan: Plan) -> None:
    """Print everything the read-only half derived, in the order the write half would write it."""
    origin = plan.selector.method_id or plan.selector.method_ref
    print(f"\nadd-method: {plan.names.slug} — {origin}")
    print(f"    pipe    {plan.pipe_ref}")
    print(f"    mode    widget {plan.mode} {plan.names.slug}")
    print(f"    output  {plan.model_name}{' (plural)' if plan.is_plural else ''}")
    inputs = ", ".join(f"{parameter.name}: {parameter.annotation}{'' if parameter.required else ' (optional)'}" for parameter in plan.parameters)
    print(f"    inputs  {inputs or 'none'}")
    for path in (plan.method_dir / MANIFEST_FILENAME, plan.generated_dir, plan.mode_file):
        print(f"    writes  {path.relative_to(REPO_ROOT)}")


# ── The run ─────────────────────────────────────────────────────────────────────────────


def build_plan(*, report: PipelexValidationReport, selector: MethodSelector, slug: str, mode: str, requested_pipe: str | None) -> Plan:
    """Derive the whole plan from the validate report, refusing every collision before anything is written.

    Raises:
        Refusal: A name is taken, an input cannot be mapped, or no pipe can be chosen.
    """
    names = derive_names(slug)
    pipe_ref = choose_pipe(report=report, requested=requested_pipe)
    model_name, is_plural = output_model_name(report=report, pipe_ref=pipe_ref)
    method_dir = METHODS_DIR / names.slug
    generated_dir = generated_package_dir(names.slug)
    # One string, the package name followed by a slash: the `/bootstrap` skill rewrites `widget/`
    # to the project's package name, but a lone `"widget"` to its distribution name, which is not
    # a directory. The same rule `scripts/codegen.py` spells `METHODS_DIR` by.
    mode_file = REPO_ROOT / f"widget/{mode}/cli.py"
    for path in (method_dir, generated_dir):
        if path.exists():
            msg = (
                f"{path.relative_to(REPO_ROOT)} already exists — this gesture never overwrites.\n"
                "    `make codegen` refreshes an existing method; NAME=<other-name> scaffolds a second slice of the same one."
            )
            raise Refusal(msg)
    mode_text = mode_file.read_text(encoding="utf-8")
    mode_label = str(mode_file.relative_to(REPO_ROOT))
    if f'@app.command(name="{names.slug}")' in mode_text:
        msg = f"`widget {mode}` already has a `{names.slug}` command — pass NAME=<other-name>."
        raise Refusal(msg)
    taken = module_bindings(text=mode_text, label=mode_label)
    for derived in (names.command, names.model_alias):
        if derived in taken or derived in COMMAND_GLOBALS:
            msg = (
                f"`{derived}` is already a name {mode_label} or the emitted command uses, "
                f"so `{names.slug}` would replace it — pass NAME=<other-name>."
            )
            raise Refusal(msg)
    if names.command in BUILTIN_NAMES:
        msg = (
            f"`{names.command}` is a Python builtin, and a command named after it would replace it "
            f"for the whole of {mode_label} — pass NAME=<other-name>."
        )
        raise Refusal(msg)
    if names.slug in LIFECYCLE_COMMANDS:
        msg = f"`{names.slug}` is a run-lifecycle command of `widget detached`, a name no other mode may carry — pass NAME=<other-name>."
        raise Refusal(msg)
    # Checked here, in the read-only half, so a mode file that lost an anchor refuses before the
    # manifest and the generated tree are on disk rather than halfway through the write.
    for anchor in (IMPORT_ANCHOR, COMMAND_ANCHOR):
        if anchor not in mode_text:
            msg = f"{mode_label} has lost its `{anchor}` anchor — restore it before scaffolding."
            raise Refusal(msg)
    parameters = build_parameters(report=report, pipe_ref=pipe_ref)
    for parameter in parameters:
        if parameter.name == names.model_alias:
            msg = f"input `{parameter.name}` would shadow the generated model the command narrows into — pass NAME=<other-name>."
            raise Refusal(msg)
    return Plan(
        names=names,
        selector=selector,
        mode=mode,
        pipe_ref=pipe_ref,
        parameters=parameters,
        model_name=model_name,
        is_plural=is_plural,
        method_dir=method_dir,
        generated_dir=generated_dir,
        mode_file=mode_file,
    )


def parse_args(argv: list[str]) -> argparse.Namespace:
    """The command line `make add-method` composes."""
    parser = argparse.ArgumentParser(prog="add-method", description="Scaffold a catalog or published method into this CLI.")
    parser.add_argument("method", help="mt_… (a catalog id) or github.com/owner/repo[/package][@tag] (a published address)")
    parser.add_argument("--pipe", default=None, help="Which pipe to wire, bare or qualified. Defaults to the method's own default pipe.")
    parser.add_argument("--name", default=None, help="The kebab-case slug every derived name is built from.")
    parser.add_argument("--mode", default=DEFAULT_MODE, choices=MODES, help=f"Which execution mode the command lands in (default: {DEFAULT_MODE}).")
    parser.add_argument("--dry-run", action="store_true", help="Fetch, derive and print the plan; write nothing.")
    return parser.parse_args(argv)


async def run_add_method(argv: list[str]) -> int:
    """The whole `make add-method` behaviour, exit code included."""
    load_dotenv()
    # Parsed before the key is looked for, so `--help` answers without one.
    args = parse_args(argv)

    if not os.environ.get("PIPELEX_API_KEY"):
        print("add-method: PIPELEX_API_KEY is not set — add it to .env (see .env.example).", file=sys.stderr)
        return EXIT_REFUSED

    try:
        selector = parse_selector(args.method)
        slug = kebab_case(args.name) if args.name else slug_from_selector(selector)
    except Refusal as exc:
        print(f"add-method: {exc}", file=sys.stderr)
        return EXIT_REFUSED

    # The client owns the base-URL chain and refuses a malformed one at construction, so it is
    # built before anything is reported and `client.base_url` is what every message names.
    # Broad on purpose: a `.env` carrying a base URL the SDK rejects is a configuration problem to
    # report, not a traceback to hand a starter user.
    try:
        client = PipelexAPIClient()
    except Exception as exc:
        print(f"add-method: {exc}\n  Check PIPELEX_BASE_URL in .env, or drop it to use the default.", file=sys.stderr)
        return EXIT_REFUSED

    insecure = insecure_base_url_reason(client.base_url)
    if insecure is not None:
        print(f"add-method: {insecure}", file=sys.stderr)
        return EXIT_REFUSED

    async with client:
        unsupported = unsupported_selector_reason(
            base_url=client.base_url,
            advertised=await read_advertised_capabilities(client),
            selector=selector,
        )
        if unsupported is not None:
            print(f"add-method: {unsupported}", file=sys.stderr)
            return EXIT_REFUSED

        # Broad on purpose, twice over: every transport and request-shape failure of these two
        # calls is one thing to report — the method could not be read — and neither is a
        # traceback to hand a starter user.
        try:
            verdict = await client.validate(
                method_id=selector.method_id,
                method_ref=selector.method_ref,
                views=[VALIDATION_VIEW_INPUT_FORM],
            )
        except Exception as exc:
            print(f"add-method: {explain(exc, client.base_url, route='POST /v1/validate')}", file=sys.stderr)
            return EXIT_REFUSED
        if not isinstance(verdict, PipelexValidationReport):
            print(f"add-method: the method does not validate: {verdict.message}", file=sys.stderr)
            for item in verdict.validation_errors:
                print(f"    {item.source or '?'}: {item.message}", file=sys.stderr)
            return EXIT_REFUSED
        if not verdict.is_runnable or verdict.pending_signatures:
            print("add-method: the method validates but cannot run — it still has unimplemented pipe signatures.", file=sys.stderr)
            return EXIT_REFUSED

        try:
            plan = build_plan(report=verdict, selector=selector, slug=slug, mode=args.mode, requested_pipe=args.pipe)
        except Refusal as exc:
            print(f"add-method: {exc}", file=sys.stderr)
            return EXIT_REFUSED

        source = MethodSource(name=plan.names.slug, out_dir=plan.generated_dir, method_id=selector.method_id, method_ref=selector.method_ref)
        try:
            codegen_response = await client.codegen(source.codegen_request())
        except Exception as exc:
            print(f"add-method: {explain(exc, client.base_url)}", file=sys.stderr)
            return EXIT_REFUSED

    if not isinstance(codegen_response, CodegenValidReport):
        print(f"add-method: the closure does not resolve: {codegen_response.message}", file=sys.stderr)
        return EXIT_REFUSED

    # The last read-only check: the emitted command imports this model by name, so an emitter that
    # named the concept differently is a refusal here rather than an ImportError in a file you did
    # not write. Only the artifacts just fetched are consulted — nothing is on disk yet.
    if not any(f"class {plan.model_name}(" in artifact.content for artifact in codegen_response.artifacts):
        print(f"add-method: the generated models declare no `{plan.model_name}` — the command could not import its output type.", file=sys.stderr)
        return EXIT_REFUSED

    print_plan(plan)
    if args.dry_run:
        print("\nadd-method: --dry-run — nothing written.")
        return EXIT_OK

    try:
        changed = write_slice(plan=plan, report=codegen_response)
    except (CodegenError, OSError, Refusal) as exc:
        print(f"\nadd-method: writing the slice failed: {exc}", file=sys.stderr)
        return EXIT_REFUSED

    print("")
    for line in changed:
        print(f"    {line}")
    warning = format_with_ruff(plan.mode_file)
    if warning is not None:
        print(f"    note: {warning}")
    print(f"\nadd-method: run it with `widget {plan.mode} {plan.names.slug}`, then `make agent-check` and `make agent-test`.")
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(run_add_method(sys.argv[1:])))
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(EXIT_INTERRUPTED)
