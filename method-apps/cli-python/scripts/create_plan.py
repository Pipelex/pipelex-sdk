"""Planning the method `make create` binds: everything about it decided before anything is written.

The gesture takes one `METHOD`, in any of its forms, and every form ends in the same parts inside
the package (`lib/binding.py`): `method/`, `generated/` and `binding.py`.

- **A bundle**, a `.mthds` file or a directory of them, is read here and copied into `method/`.
- **A catalog id** (`mt_…`) or **a published address** (`github.com/…`) stays where it is, and
  `method/method.json` names it.

`plan_method` is the read-only half. It parses the argument, reads the bundle or checks that the
base URL serves the selector, fetches a stored method's catalog entry, and runs the codegen kit's
`fetch_generated`, so both API calls and every guard `make codegen` holds run here
(`scripts/codegen.py`), over the very request `make codegen` sends for the tree written from it: a
bundle's files are labelled as the package will hold them, `method/<path>`. It then chooses the pipe,
binds the output to a model the generated tree defines and can import, which executes the generated
`models.py` in memory, a dry run included, checks that the pipe's inputs can be offered as options,
derives the name the project takes when none is given, and renders `binding.py`, formatted by ruff,
in memory. Every refusal happens there, with nothing on disk changed.

`write_method` is the write half. It writes the three parts, the tree through the kit's own
`write_generated`, so that it is the tree `make codegen` would write. Each part is claimed
exclusively before anything is written into it, and a write that fails removes what this run
created and nothing else, so that the template is left as it was.

This module leaves the project with the gesture. The ported module is `webapp-js`'s
`scripts/lib/add-method.mts`, for one method where the web app takes several.
"""

import errno
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tomllib
import unicodedata
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Protocol, cast

import httpx
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.pipe_io_contracts import PipeIOContract, PipeIOContracts
from pipelex_sdk.crate_models import CodegenValidReport, MthdsFileItem, PipeIOValidReport
from pipelex_sdk.product_models import MethodData
from pydantic import BaseModel

from pipelex_method_cli_python.cli import RESERVED_FLAGS
from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.binding import BINDING_FILENAME
from pipelex_method_cli_python.lib.contracts import GENERATED_DIRNAME, ContractsDocument, contracts_for_pipe
from pipelex_method_cli_python.lib.inputs import InputOption, derive_options, expand_home
from pipelex_method_cli_python.lib.manifest import MANIFEST_FILENAME, MethodSelector, render_manifest
from pipelex_method_cli_python.lib.method_source import BUNDLE_SUFFIX, METHOD_DIRNAME, PACKAGE
from scripts.codegen import CodegenClient, Fetched, GenerateFailure, fetch_generated, write_generated
from scripts.codegen_api import explain, selector_support_refusal
from scripts.codegen_shared import (
    BYTECODE_CACHE,
    CodegenSetupError,
    CodegenSource,
    Layout,
    NonUtf8FileError,
    SymlinkRefusedError,
    bundle_paths,
    hash_source,
    read_bundle,
    read_text_file,
    refuse_symlink_root,
    walk,
)


class PlanError(Exception):
    """A refusal: something asked for cannot be done, and the message says what to do instead. Nothing was written."""


class CreateClient(CodegenClient, Protocol):
    """What the gesture needs of a client: the codegen kit's routes, and the catalog's `GET /v1/methods/{id}`."""

    async def get_method(self, method_id: str) -> MethodData: ...


# ── The argument ────────────────────────────────────────────────────────────

#: A catalog id, as the platform mints them.
METHOD_ID_PATTERN = re.compile(r"mt_[A-Za-z0-9][A-Za-z0-9._-]*")

#: One segment of an address: the host, the owner, the repository, or a package's subpath segment.
ADDRESS_SEGMENT = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*")

#: An `@tag` suffix: a git tag or branch name, as the address grammar allows.
ADDRESS_TAG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*")

#: The forms `METHOD` takes, as every refusal about it names them.
METHOD_ARG_FORMS = (
    'a path to a .mthds file or to a directory of them, a catalog id ("mt_…"), '
    'or a published address ("github.com/<owner>/<repo>[/<package>][@<tag>]")'
)


@dataclass(frozen=True)
class BundlePath:
    """A `METHOD` that names a place on disk, as given: resolving it needs the directory the gesture runs from."""

    path: str


def looks_like_path(value: str) -> bool:
    """Whether the argument names a place on disk rather than an address.

    An address starts with its host, and a host has a dot in it (`github.com`), so a first segment
    without one is a path. The explicit path forms are recognised before that test, since `./cv` and
    `../cv` start with a dot of their own, and so is anything ending in `.mthds`, which no address does.
    """
    if value.endswith(BUNDLE_SUFFIX):
        return True
    if re.match(r"(/|~(/|$)|\.{1,2}(/|$))", value):
        return True
    if re.match(r"[A-Za-z]:[\\/]", value) or "\\" in value:
        return True
    return "." not in value.split("/")[0]


def parse_method_arg(arg: str, on_disk: Callable[[str], bool]) -> BundlePath | MethodSelector:
    """Parse the one `METHOD` argument: an existing path first, then a catalog id, then an address.

    A name that exists on disk is a path whatever it looks like: `bundles.v2/cv` has a dot in its
    first segment and `mt_drafts` the catalog's prefix, and both are ordinary directory names. Only
    a name that exists nowhere falls through to the selector grammar, `github.com/<owner>/<repo>
    [/<subpath>…][@<tag>]` with an optional `https://` that is normalized away.

    Raises:
        PlanError: The argument is empty, or is neither a path nor a well-formed selector.
    """
    trimmed = arg.strip()
    if not trimmed:
        msg = f"METHOD is empty: pass {METHOD_ARG_FORMS}."
        raise PlanError(msg)
    if on_disk(trimmed):
        return BundlePath(trimmed)
    if trimmed.startswith("mt_"):
        if METHOD_ID_PATTERN.fullmatch(trimmed) is None:
            msg = f'"{trimmed}" is not a well-formed catalog id (mt_…).'
            raise PlanError(msg)
        return MethodSelector(method_id=trimmed)
    has_scheme = re.match(r"https?://", trimmed) is not None
    if not has_scheme and looks_like_path(trimmed):
        return BundlePath(trimmed)
    bare = re.sub(r"^https?://", "", trimmed).rstrip("/")
    address, *tags = bare.split("@")
    if len(tags) > 1:
        msg = f'"{trimmed}" has more than one @tag: an address names one.'
        raise PlanError(msg)
    tag = tags[0] if tags else None
    if tag is not None and ADDRESS_TAG.fullmatch(tag) is None:
        msg = f'"{trimmed}" has an @tag that is not a tag name.'
        raise PlanError(msg)
    segments = address.split("/")
    if len(segments) < 3 or not all(ADDRESS_SEGMENT.fullmatch(segment) for segment in segments):
        msg = f'"{trimmed}" is not {METHOD_ARG_FORMS}.\n  An address names at least a host, an owner and a repository.'
        raise PlanError(msg)
    method_ref = "/".join(segments) if tag is None else f"{'/'.join(segments)}@{tag}"
    return MethodSelector(method_ref=method_ref)


def address_segments(method_ref: str) -> list[str]:
    """The address's path segments with its tag stripped: `github.com/o/r/pkg@v1` is `github.com`, `o`, `r`, `pkg`."""
    return method_ref.split("@", maxsplit=1)[0].split("/")


def resolve_given(given: str, cwd: Path) -> Path:
    """Where a path given on the command line points, relative to `cwd`, its `..` folded and no link followed.

    A leading `~` or `~user` is expanded by the command's own rule (`lib/inputs.py`'s `expand_home`),
    so that `METHOD=~alice/x` and the command's `@~alice/x` name the same file.
    """
    return Path(os.path.normpath(cwd / expand_home(given)))


# ── The bundle ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class BundleFile:
    """One `.mthds` file of a bundle, as read."""

    #: Where it lands inside `method/`, in POSIX form: `main.mthds`, which is also how the API is sent it, as `method/main.mthds`.
    relative: str
    content: str


@dataclass(frozen=True)
class Bundle:
    """The bundle `METHOD` names, read."""

    files: tuple[BundleFile, ...]
    #: How messages name the bundle as a whole: a directory's path ends with `/`, a single file's does not.
    display: str


def not_regular_refusal(where: str, kind: str) -> str:
    """The refusal of a bundle path that is not a regular file or directory, worded for a path anywhere."""
    return (
        f"refusing {kind} at {where}: the path given, and everything under a bundle directory, must be a regular file "
        "or a directory. Point at the files themselves."
    )


def _is_inside(root: Path, candidate: Path) -> bool:
    return candidate != root and candidate.is_relative_to(root)


def unreadable_refusal(exc: OSError, fallback: str) -> str:
    """The refusal of a bundle path the gesture cannot read, naming the file or directory the system named."""
    filename: object = exc.filename
    where = filename if isinstance(filename, str) else fallback
    return f"{where} cannot be read: {exc.strerror or exc}. A bundle is read whole, so every file and directory in it must be readable."


#: The directories a bundle directory's walk never enters, besides every hidden one (`.git`, `.venv`).
NOT_BUNDLE_DIRS = frozenset({"node_modules", BYTECODE_CACHE})

#: The file that makes a directory a Python virtual environment, whatever the directory is called.
VENV_MARKER = "pyvenv.cfg"


def walk_bundle(directory: Path, layout: Layout) -> list[str]:
    """Every regular file under a bundle directory, as sorted POSIX paths relative to it, what is not the bundle's aside.

    A bundle directory is often a methods repository, which holds more than its bundle: version
    control, a virtual environment whose interpreter is a symbolic link, installed packages that may
    carry `.mthds` files of their own. So the walk never enters a hidden directory, `node_modules`,
    Python's bytecode cache, or a virtual environment by any name (a directory holding `pyvenv.cfg`),
    and skips every hidden entry, whatever it is: nothing in them is read, refused or copied.
    Everywhere else the codegen kit's policy holds (`codegen_shared.walk`): a symbolic link or a special
    file is refused, since a bundle that silently loses a file is a method that silently changes.

    Raises:
        SymlinkRefusedError: Something the walk enters holds a symbolic link or a special file.
        OSError: A directory cannot be read.
    """
    refuse_symlink_root(directory, layout)
    found: list[str] = []
    _walk_bundle_into(directory, "", found, layout)
    return sorted(found)


def _walk_bundle_into(directory: Path, prefix: str, found: list[str], layout: Layout) -> None:
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name.startswith(".") or entry.name in NOT_BUNDLE_DIRS:
                continue
            relative = f"{prefix}{entry.name}"
            mode = entry.stat(follow_symlinks=False).st_mode
            if stat.S_ISDIR(mode):
                # `os.path.isfile` answers False for a directory it cannot read, which the walk then refuses by name.
                if not os.path.isfile(os.path.join(entry.path, VENV_MARKER)):
                    _walk_bundle_into(Path(entry.path), f"{relative}/", found, layout)
            elif stat.S_ISREG(mode):
                found.append(relative)
            else:
                raise SymlinkRefusedError(layout.describe(Path(entry.path)), "a symlink" if stat.S_ISLNK(mode) else "a special file")


def read_bundle_arg(given: str, *, cwd: Path, root: Path, layout: Layout) -> Bundle:
    """Read the bundle a path names: a `.mthds` file alone, or every `.mthds` file under a directory.

    The policies are the codegen kit's: a symbolic link or a special file is refused, at the path
    given and anywhere under a directory, and so is a file that is not UTF-8. Both are refusals
    rather than skips, since a bundle that silently loses a file is a method that silently changes.
    A directory is walked by `walk_bundle`, which does not enter what a methods repository holds
    beside its bundle: hidden directories, `node_modules` and virtual environments.

    Raises:
        PlanError: The path is missing, a link, not a `.mthds` file, holds no `.mthds` file, contains
            the project, holds something the policies refuse, or cannot be read.
    """
    resolved = resolve_given(given, cwd)
    # `lstat`, not `stat`: the path itself is held to the rule its entries are, so a link is refused rather than followed.
    try:
        mode = resolved.lstat().st_mode
    except (FileNotFoundError, NotADirectoryError) as exc:
        msg = f'"{given}" is not a file or a directory (looked for {resolved}).\n  METHOD is {METHOD_ARG_FORMS}.'
        raise PlanError(msg) from exc
    except OSError as exc:
        raise PlanError(unreadable_refusal(exc, str(resolved))) from exc
    if stat.S_ISLNK(mode):
        raise PlanError(not_regular_refusal(f'"{given}"', "a symlink"))
    shown = resolved.relative_to(cwd).as_posix() if _is_inside(cwd, resolved) else str(resolved)
    if stat.S_ISREG(mode):
        if not resolved.name.endswith(BUNDLE_SUFFIX):
            msg = f'"{given}" is not a .mthds file.\n  METHOD is {METHOD_ARG_FORMS}.'
            raise PlanError(msg)
        content = _read_utf8(resolved, layout)
        return Bundle(files=(BundleFile(relative=resolved.name, content=content),), display=shown)
    if not stat.S_ISDIR(mode):
        msg = f'"{given}" is neither a file nor a directory.'
        raise PlanError(msg)
    if resolved == root or _is_inside(resolved, root):
        msg = f'"{given}" contains this project. Point at the directory that holds the bundle\'s .mthds files.'
        raise PlanError(msg)
    display = f"{shown}/"
    try:
        relatives = bundle_paths(walk_bundle(resolved, layout))
        contents = read_bundle(resolved, relatives, layout)
    except SymlinkRefusedError as exc:
        raise PlanError(not_regular_refusal(exc.where, exc.kind)) from exc
    except NonUtf8FileError as exc:
        raise PlanError(str(exc)) from exc
    except OSError as exc:
        raise PlanError(unreadable_refusal(exc, display)) from exc
    if not contents:
        msg = f"{display} holds no .mthds file: there is no bundle to create the project from."
        raise PlanError(msg)
    files = tuple(BundleFile(relative=relative, content=content) for relative, content in contents)
    return Bundle(files=files, display=display)


def _read_utf8(path: Path, layout: Layout) -> str:
    try:
        return read_text_file(path, layout)
    except NonUtf8FileError as exc:
        raise PlanError(str(exc)) from exc
    except OSError as exc:
        raise PlanError(unreadable_refusal(exc, str(path))) from exc


# ── Names ───────────────────────────────────────────────────────────────────

#: A derived name: kebab-case starting with a letter, since it becomes the distribution, the console
#: script and, with its dashes as underscores, the import package, which cannot start with a digit.
SLUG_PATTERN = re.compile(r"[a-z][a-z0-9]*(-[a-z0-9]+)*")


def kebab_case(text: str) -> str:
    """`text_stats` is `text-stats` and `CV screening` is `cv-screening`; a text that yields no usable name is refused.

    A letter with an accent keeps its letter, `Résumé screening` giving `resume-screening` rather
    than `r-sum-screening`: the text is case-folded, which spells `ß` as `ss`, then decomposed, and
    the accents, which decomposition leaves as marks of their own, are dropped.

    Raises:
        PlanError: The text yields no kebab-case name starting with a letter, such as `3D model`.
    """
    folded = unicodedata.normalize("NFKD", text.strip().casefold())
    unaccented = "".join(character for character in folded if not unicodedata.combining(character))
    slug = re.sub(r"[^a-z0-9]+", "-", unaccented).strip("-")
    if SLUG_PATTERN.fullmatch(slug) is None:
        msg = (
            f'"{text}" does not yield a usable project name (got "{slug}"). Pass --name with a kebab-case name of your own that starts with a letter.'
        )
        raise PlanError(msg)
    return slug


def slug_source(selector: MethodSelector, catalog_name: str | None) -> str:
    """Where a named method's project name comes from: a stored method's catalog name, an address's last segment.

    A person chose a catalog name. An address names its package last, or only its repository when
    it names no package. A bundle's name is the domain of the pipe it runs, chosen by the caller.

    Raises:
        PlanError: A stored method has no name to derive one from.
    """
    if selector.method_ref is None:
        if catalog_name is None or not catalog_name.strip():
            msg = "the catalog method has no name to derive the project's name from: pass --name."
            raise PlanError(msg)
        return catalog_name
    segments = address_segments(selector.method_ref)
    return segments[-1] if len(segments) > 3 else segments[2]


def title_from_name(name: str) -> str:
    """`receipt-review` is `Receipt Review`, the bootstrap's own default for a title."""
    return " ".join(part[:1].upper() + part[1:] for part in re.split(r"[-._]+", name) if part)


_WORD = re.compile(r"[A-Za-z][A-Za-z0-9]*")


def spelled_words(prose: str) -> dict[str, str]:
    """The words a method spells with a capital after their first letter, `CVs`, `PDF`, `PostgreSQL`, keyed in lower case.

    That interior capital is what tells an acronym or a brand from an ordinary word opening a
    sentence. A word written in the plural spells its singular too, and the reverse, since a derived
    word is singular or plural by the name's grammar, not by the prose's.
    """
    spellings: dict[str, str] = {}
    plurals: dict[str, str] = {}
    for word in _WORD.findall(prose):
        if not re.search(r"[A-Z]", word[1:]):
            continue
        lower = word.lower()
        spellings.setdefault(lower, word)
        if word.endswith("s"):
            singular = word[:-1]
            plurals.setdefault(singular.lower(), singular)
        else:
            plurals.setdefault(f"{lower}s", f"{word}s")
    for lower, word in plurals.items():
        spellings.setdefault(lower, word)
    return spellings


def respell_acronyms(text: str, prose: str) -> str:
    """`text` with every word the method spells its own way respelled: `Cv Screening` is `CV Screening`."""
    spellings = spelled_words(prose)
    if not spellings:
        return text
    return _WORD.sub(lambda match: spellings.get(match.group(0).lower(), match.group(0)), text)


# ── The method's prose ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class MethodProse:
    """What the method says about itself, read from its own `.mthds` files: the domain's description and each pipe's."""

    description: str | None
    #: Each pipe's description, keyed by its namespaced reference, `domain.pipe_code`.
    pipe_descriptions: dict[str, str]


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _table(value: object) -> dict[str, Any]:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


def method_prose_of(files: Sequence[MthdsFileItem]) -> MethodProse:
    """Read the method's prose out of its `.mthds` files.

    The domain's description is the one in the method's primary file, the first that declares a
    `main_pipe`, else the first. Every file's pipes contribute their descriptions, the primary
    file's first, since `method_vocabulary` keeps the first spelling it meets. A file that does not
    parse contributes nothing: the API has just loaded it, and the prose is optional, since every
    reader of it has a fallback.
    """
    blueprints: list[dict[str, Any]] = []
    for file in files:
        try:
            blueprints.append(tomllib.loads(file.content))
        except tomllib.TOMLDecodeError:
            continue
    if not blueprints:
        return MethodProse(description=None, pipe_descriptions={})
    primary = next((blueprint for blueprint in blueprints if _text(blueprint.get("main_pipe")) is not None), blueprints[0])
    descriptions: dict[str, str] = {}
    for blueprint in [primary, *(other for other in blueprints if other is not primary)]:
        domain = _text(blueprint.get("domain"))
        if domain is None:
            continue
        for code, pipe in _table(blueprint.get("pipe")).items():
            description = _text(_table(pipe).get("description"))
            if description is not None:
                descriptions.setdefault(f"{domain}.{code}", description)
    return MethodProse(description=_text(primary.get("description")), pipe_descriptions=descriptions)


def method_vocabulary(prose: MethodProse) -> str:
    """Everything the method says about itself as one text to read spellings from, the domain's description first."""
    return " ".join([prose.description or "", *prose.pipe_descriptions.values()])


# ── The pipe and the output ─────────────────────────────────────────────────


@dataclass(frozen=True)
class ChosenPipe:
    """The pipe the CLI runs, by its namespaced reference and its two halves."""

    ref: str
    domain: str
    code: str


def _split_pipe_ref(ref: str) -> ChosenPipe:
    domain, dot, code = ref.rpartition(".")
    if not dot or not domain or not code:
        msg = f'the method declares a pipe reference that cannot be split into a domain and a code: "{ref}". Report it upstream.'
        raise PlanError(msg)
    return ChosenPipe(ref=ref, domain=domain, code=code)


def choose_pipe(contracts: PipeIOContracts, default_pipe_ref: str | None, requested: str | None) -> ChosenPipe:
    """Which pipe the CLI runs, by a rule that ends in a refusal rather than a guess.

    In order: `--pipe`, by its namespaced reference or its bare code; else the method's own entry
    pipe, `/v1/pipe-io`'s `default_pipe_ref`; else the only pipe, when there is one; else a refusal
    listing the pipes. `default_pipe_ref` is `None` for a method whose domains each declare a
    `main_pipe`, which the route does not choose between, and neither does this rule.

    Raises:
        PlanError: The method declares no pipe, `--pipe` names none or several, or nothing decides.
    """
    refs = list(contracts)
    if not refs:
        msg = "the method declares no pipes: there is nothing to run."
        raise PlanError(msg)
    listed = ", ".join(refs)
    if requested is not None:
        if requested in contracts:
            return _split_pipe_ref(requested)
        matches = [ref for ref in refs if ref.rpartition(".")[2] == requested]
        if len(matches) == 1:
            return _split_pipe_ref(matches[0])
        if matches:
            msg = f'--pipe "{requested}" is ambiguous: it matches {", ".join(matches)}. Pass the namespaced <domain>.<pipe_code>.'
            raise PlanError(msg)
        msg = f'--pipe "{requested}" is not a pipe this method declares. It declares: {listed}.'
        raise PlanError(msg)
    if default_pipe_ref is not None and default_pipe_ref.strip():
        if default_pipe_ref not in contracts:
            msg = (
                f'the method\'s default pipe "{default_pipe_ref}" is not among the pipes it declares ({listed}). '
                "Pass --pipe, and report the inconsistency upstream."
            )
            raise PlanError(msg)
        return _split_pipe_ref(default_pipe_ref)
    if len(refs) == 1:
        return _split_pipe_ref(refs[0])
    msg = f"the method declares several pipes and names no default: pass --pipe.\n  Pipes: {listed}"
    raise PlanError(msg)


#: The file of the generated tree that defines the typed models.
MODELS_FILENAME = "models.py"

#: A concept's code that names a Python class.
_CLASS_NAME = re.compile(r"[A-Z][A-Za-z0-9_]*")


@dataclass(frozen=True)
class OutputBinding:
    """What `binding.py` binds the output to: the generated model, and whether the output is a list of it."""

    #: The concept's code, `Text` for `native.Text`, which is the model's class name in `models.py`.
    model: str
    plural: bool


def bind_output(contract: PipeIOContract, report: CodegenValidReport) -> OutputBinding:
    """Bind the chosen pipe's output to the model the codegen generated for its concept.

    The generated `models.py` must import, and must then expose the model, which is what
    `binding.py`'s `from … import` needs: it is executed here, in memory, so that a tree the CLI could
    not load is refused before anything is written rather than found by the checks afterwards. A
    method whose concepts use a native date or time is the known case today.

    The model is looked up by the concept's code alone, which names one concept only when no other
    domain of the method has a concept of that code. When two do, the codegen names every concept of
    that code after its domain (`cv__Result`, `legal·contracts__Result`), and no class carries the
    bare code: that is refused as ambiguous rather than bound by a guess. The class must also be one
    `models.py` defines, never a name it imports, such as pydantic's own `BaseModel`, which a bare
    code could otherwise reach.

    Raises:
        PlanError: The concept's code is no class name, `models.py` is missing, cannot be imported,
            exposes no pydantic model it defines under that name, or names that code's models after
            their domains.
    """
    concept_ref = contract.output.concept_ref
    model = concept_ref.rpartition(".")[2]
    if _CLASS_NAME.fullmatch(model) is None:
        msg = f'the pipe\'s output concept "{concept_ref}" does not end in a name that can be a Python class.'
        raise PlanError(msg)
    content = next((artifact.content for artifact in report.artifacts if artifact.path == MODELS_FILENAME), None)
    if content is None:
        msg = f"the codegen response carries no {MODELS_FILENAME} to bind the output to. Nothing was written; report it upstream."
        raise PlanError(msg)
    module = import_models(content)
    found: object = getattr(module, model, None)
    if _defined_model(found, module):
        return OutputBinding(model=model, plural=contract.output.multiplicity.is_plural)
    qualified = sorted(name for name, value in vars(module).items() if name.endswith(f"__{model}") and _defined_model(value, module))
    if qualified:
        msg = (
            f'the pipe\'s output concept "{concept_ref}" shares its code with a concept of another domain, so the generated '
            f"{MODELS_FILENAME} names each after its domain ({', '.join(qualified)}), and the gesture binds an output only to "
            "a code that is one concept's alone. Nothing was written: rename one of the concepts in the method, or pass --pipe "
            "to run a pipe whose output is another concept."
        )
    elif found is None:
        msg = (
            f'the generated {MODELS_FILENAME} defines no {model} for the pipe\'s output concept "{concept_ref}". '
            "Nothing was written; report it upstream."
        )
    elif isinstance(found, type) and issubclass(found, BaseModel):
        msg = (
            f"the generated {MODELS_FILENAME}'s {model} is {found.__module__}.{found.__qualname__}, a name it imports rather "
            "than a model it defines. Nothing was written; report it upstream."
        )
    else:
        msg = f"the generated {MODELS_FILENAME}'s {model} is not a pydantic model. Nothing was written; report it upstream."
    raise PlanError(msg)


def _defined_model(value: object, module: ModuleType) -> bool:
    """Whether a value is a pydantic model the module itself defines, rather than one it imports."""
    return isinstance(value, type) and issubclass(value, BaseModel) and value.__module__ == module.__name__


def import_models(content: str) -> ModuleType:
    """Execute a generated `models.py` in a module of its own, registered only while it runs, as an import would.

    This runs the code the API generated, in this process, during a dry run too. It is the code the
    CLI imports on every run, from the API the key is configured for, which is the trust the codegen
    places in it anyway; the dry run writes nothing, but it does execute it.

    Raises:
        PlanError: The code raises as it is imported.
    """
    module = ModuleType("_make_create_models")
    sys.modules[module.__name__] = module
    try:
        exec(compile(content, f"{GENERATED_DIRNAME}/{MODELS_FILENAME}", "exec"), module.__dict__)
    except Exception as exc:
        # Unbounded code: the generated module is code the server wrote, and whatever its import raises, the CLI could not load it either.
        msg = (
            f"the generated {MODELS_FILENAME} cannot be imported: {type(exc).__name__}: {exc}. Nothing was written. "
            "A native date or time among the method's concepts is a known cause; report it upstream."
        )
        raise PlanError(msg) from exc
    finally:
        sys.modules.pop(module.__name__, None)
    return module


# ── binding.py ──────────────────────────────────────────────────────────────

#: `binding.py`'s text before ruff formats it; the values are filled in by `render_binding`.
BINDING_TEMPLATE = '''"""The binding: the pipe this command runs, and the model its output is checked against.

This file is the project's own. `lib/binding.py` reads the names below when the command loads, and
refuses a pipe the committed contracts do not describe, or an `OUTPUT_IS_LIST` they disagree
with: after `make codegen`, keep the import and the names in step with the regenerated tree.
"""

from {package}.{generated}.models import {model}

#: The pipe the CLI runs, by its namespaced reference: `<domain>.<pipe_code>`.
PIPE_REF = {pipe_ref}

#: The model the pipe's output is validated against, imported from the generated tree.
OUTPUT_MODEL = {model}

#: Whether the pipe's output is plural, a list of `OUTPUT_MODEL`.
OUTPUT_IS_LIST = {plural}
'''


def render_binding(pipe: ChosenPipe, output: OutputBinding, *, package: str = PACKAGE) -> str:
    """`binding.py`'s text for the chosen pipe and its output, before formatting."""
    return BINDING_TEMPLATE.format(
        package=package, generated=GENERATED_DIRNAME, model=output.model, pipe_ref=json.dumps(pipe.ref), plural=output.plural
    )


def format_python(source: str, *, path: Path, root: Path) -> str:
    """Python source as the project's ruff sorts its imports and formats it, as `make format` would, without touching the disk.

    Raises:
        PlanError: Ruff is not installed, or refuses the source.
    """
    relative = path.relative_to(root).as_posix() if path.is_relative_to(root) else str(path)
    text = source
    for command in (["check", "--select", "I", "--fix-only", "--exit-zero"], ["format"]):
        try:
            result = subprocess.run(
                [sys.executable, "-m", "ruff", *command, "--stdin-filename", relative, "-"],
                input=text,
                capture_output=True,
                text=True,
                encoding="utf-8",
                cwd=root,
                check=False,
            )
        except OSError as exc:
            msg = f"ruff could not be run to format {relative}: {exc}. Run `make install`, then try again."
            raise PlanError(msg) from exc
        if result.returncode != 0:
            msg = f"ruff refused {relative} as rendered: {result.stderr.strip() or result.stdout.strip()}. Run `make install`, then try again."
            raise PlanError(msg)
        text = result.stdout
    return text


# ── The plan ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MethodArgs:
    """What the gesture's command line says about the method."""

    method: str
    pipe: str | None = None
    #: Whether a name was given, in which case none is derived from the method and none can be refused.
    named: bool = False


@dataclass(frozen=True)
class CatalogEntry:
    """What the catalog says about a stored method."""

    name: str
    description: str | None


@dataclass(frozen=True)
class MethodPlan:
    """Everything the write half needs, and everything the gesture reads to name the project after the method."""

    #: The method as the sidecar records it: each source at its final path, `method/<path>`, with its hash.
    source: CodegenSource
    fetched: Fetched
    #: The files written under `method/`, as their path inside it and their text: the bundle's, or `method.json`.
    method_files: tuple[tuple[str, str], ...]
    pipe: ChosenPipe
    output: OutputBinding
    #: The options the method's inputs become, in authored order.
    options: tuple[InputOption, ...]
    #: `binding.py`'s text, formatted.
    binding: str
    #: The name derived from the method, or `None` when `--name` was given.
    slug: str | None
    catalog: CatalogEntry | None
    prose: MethodProse
    #: One phrase naming the method: its selector, or the bundle and its size.
    describe: str
    #: Where the method comes from, in fewer words: its selector, or the bundle's path.
    origin: str
    warnings: tuple[str, ...]


def refuse_a_method_in_place(layout: Layout) -> None:
    """Refuse a package that holds any part of a method already: the gesture writes into a template that holds none.

    A `generated/` holding nothing but Python's bytecode cache is no tree, and is written into.

    Raises:
        PlanError: `method/`, `binding.py` or a generated tree is there, or is a link, or the package
            cannot be read.
    """
    try:
        taken = _parts_in_place(layout)
    except CodegenSetupError as exc:
        raise PlanError(str(exc)) from exc
    except OSError as exc:
        filename: object = exc.filename
        where = filename if isinstance(filename, str) else layout.describe(layout.package_dir)
        msg = f"{where} cannot be read, so the gesture cannot tell whether the package holds a method already: {exc.strerror or exc}."
        raise PlanError(msg) from exc
    if taken:
        where = ", ".join(layout.describe(path) for path in taken)
        msg = (
            f"{where} already exists, so this copy of the template holds a method already. The gesture writes the method "
            "into a template that holds none, and never overwrites: remove what is there, or start again from a fresh copy."
        )
        raise PlanError(msg)


def _parts_in_place(layout: Layout) -> list[Path]:
    """The parts of a method the package already holds, a generated tree holding nothing but bytecode aside.

    Raises:
        CodegenSetupError: Something under `generated/` is a link or a special file.
        OSError: The package or its tree cannot be read.
    """
    binding = layout.package_dir / BINDING_FILENAME
    taken = [path for path in (layout.method_dir, binding) if path.exists() or path.is_symlink()]
    generated = layout.generated_dir
    if generated.is_symlink():
        taken.append(generated)
    elif generated.is_dir():
        if walk(generated, layout):
            taken.append(generated)
    elif generated.exists():
        taken.append(generated)
    return taken


async def plan_method(args: MethodArgs, client: CreateClient, *, layout: Layout, root: Path, cwd: Path) -> MethodPlan:
    """The read-only half: every fetch, every derivation and every refusal, and `binding.py` rendered in memory.

    Raises:
        PlanError: Something asked for cannot be done; nothing was written.
    """
    refuse_a_method_in_place(layout)
    arg = parse_method_arg(args.method, lambda value: os.path.lexists(resolve_given(value, cwd)))
    warnings: list[str] = []
    catalog: CatalogEntry | None = None
    if isinstance(arg, MethodSelector):
        manifest = render_manifest(arg)
        label = f"{METHOD_DIRNAME}/{MANIFEST_FILENAME}"
        source = CodegenSource(selector=arg, source_hashes={label: hash_source(manifest)})
        labels_note: str | None = None
        method_files: tuple[tuple[str, str], ...] = ((MANIFEST_FILENAME, manifest),)
        refusal = await selector_support_refusal(client, client.base_url, source)
        if refusal is not None:
            raise PlanError(refusal)
        if arg.method_id is not None:
            catalog = await _catalog_entry(client, source, arg.method_id)
            warnings.append(
                "a method_id is scoped to your key's organization, so `make codegen` and every run of this CLI need a key of "
                "that same organization. A published address (method_ref) is the portable form."
            )
        describe = source.describe()
        origin = describe
    else:
        bundle = read_bundle_arg(arg.path, cwd=cwd, root=root, layout=layout)
        # Each file is labelled as the package will hold it, `method/<path>`, which is what `make codegen`
        # and `make codegen-verify` send for the tree written from it, so the request is theirs exactly.
        placed = [(f"{METHOD_DIRNAME}/{file.relative}", file.content) for file in bundle.files]
        source = CodegenSource(
            files=tuple(MthdsFileItem(content=content, source=label) for label, content in placed),
            source_hashes={label: hash_source(content) for label, content in placed},
        )
        method_files = tuple((file.relative, file.content) for file in bundle.files)
        count = f"{len(bundle.files)} .mthds file{'' if len(bundle.files) == 1 else 's'}"
        describe = f"the bundle {bundle.display} ({count}, copied to {layout.describe(layout.method_dir)}/)"
        origin = f"the bundle {bundle.display}"
        # A diagnostic names a file by its label, so a refusal says where the person's file is.
        placed_as = f"{METHOD_DIRNAME}/" if bundle.display.endswith("/") else f"{METHOD_DIRNAME}/{bundle.files[0].relative}"
        labels_note = f"The bundle's files are named as the package will hold them: {placed_as} is {bundle.display}"
    try:
        fetched = await fetch_generated(client, source, layout, include_files=True)
    except GenerateFailure as exc:
        msg = str(exc) if labels_note is None else f"{exc}\n  {labels_note}"
        raise PlanError(msg) from exc
    report = fetched.pipe_io
    prose = method_prose_of(source.files if source.files is not None else report.files or [])
    pipe = choose_pipe(report.pipe_io_contracts, report.default_pipe_ref, args.pipe)
    output = bind_output(report.pipe_io_contracts[pipe.ref], fetched.report)
    options = _options_for(report, pipe)
    slug: str | None = None
    if not args.named:
        if isinstance(arg, MethodSelector):
            slug = kebab_case(slug_source(arg, catalog.name if catalog is not None else None))
        else:
            slug = kebab_case(pipe.domain)
    binding_path = layout.package_dir / BINDING_FILENAME
    binding = format_python(render_binding(pipe, output), path=binding_path, root=root)
    return MethodPlan(
        source=source,
        fetched=fetched,
        method_files=method_files,
        pipe=pipe,
        output=output,
        options=options,
        binding=binding,
        slug=slug,
        catalog=catalog,
        prose=prose,
        describe=describe,
        origin=origin,
        warnings=tuple(warnings),
    )


async def _catalog_entry(client: CreateClient, source: CodegenSource, method_id: str) -> CatalogEntry:
    """A stored method's name and description: a person chose both, so they name the project unless overridden.

    Raises:
        PlanError: The catalog does not answer for the method.
    """
    try:
        method = await client.get_method(method_id)
    except (PipelineRequestError, httpx.HTTPError, ValueError) as exc:
        raise PlanError(explain(exc, client.base_url, "GET /v1/methods/{id}", source)) from exc
    return CatalogEntry(name=method.name, description=method.description)


def _options_for(report: PipeIOValidReport, pipe: ChosenPipe) -> tuple[InputOption, ...]:
    """The options the pipe's inputs become, derived as the CLI derives them when it loads, so a form it cannot offer is refused now.

    Raises:
        PlanError: The contracts do not describe the pipe, or its inputs cannot be offered as options.
    """
    document = ContractsDocument(comment="", pipe_io_contracts=report.pipe_io_contracts, input_form=report.input_form, output_form=report.output_form)
    try:
        return derive_options(contracts_for_pipe(document, pipe.ref), reserved=RESERVED_FLAGS)
    except AppError as exc:
        msg = f"the pipe {pipe.ref} cannot be run by this CLI: {exc.message}{f' {exc.hint}' if exc.hint else ''}"
        raise PlanError(msg) from exc


# ── The write half ──────────────────────────────────────────────────────────


def write_method(plan: MethodPlan, layout: Layout) -> list[str]:
    """Write `method/`, the generated tree and `binding.py`, and return what was written, one line per part.

    Nothing is overwritten, and each part is claimed before anything is written into it: `method/`,
    `generated/` and `binding.py` are created exclusively. The one exception is a `generated/` that
    planning found holding nothing but Python's bytecode cache, which is written into when it still
    holds nothing else. A failure part-way removes what this call created, and nothing else, so the
    template is left as it was and the gesture can run again.

    Raises:
        OSError: A part could not be written, or appeared since planning.
        CodegenSetupError: The tree's directory holds a link or a special file.
        CodegenError: The SDK's writer refused the tree.
        RuntimeError: The offline check called a file the codegen writes an orphan.
    """
    written: list[Path] = []
    undo: list[Callable[[], None]] = []
    try:
        layout.method_dir.mkdir()
        written.append(layout.method_dir)
        undo.append(lambda: _remove(layout.method_dir))
        for relative, content in plan.method_files:
            target = layout.method_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            # The bytes as read: the sidecar's hashes fold line endings, and the files are the person's.
            with target.open("x", encoding="utf-8", newline="") as handle:
                handle.write(content)
        undo.append(_claim_generated(layout))
        written.append(layout.generated_dir)
        write_generated(layout, plan.fetched, plan.source)
        binding = layout.package_dir / BINDING_FILENAME
        with binding.open("x", encoding="utf-8", newline="\n") as handle:
            written.append(binding)
            undo.append(lambda: _remove(binding))
            handle.write(plan.binding)
    except BaseException:
        for step in reversed(undo):
            step()
        raise
    return [f"wrote {layout.describe(path)}{'/' if path.is_dir() else ''}" for path in written]


def _claim_generated(layout: Layout) -> Callable[[], None]:
    """Claim `generated/` for this run, and return what removes, on a failure, what the run then writes there.

    The directory is created exclusively, and is then this run's to remove. One that exists already is
    taken only when it still holds nothing but Python's bytecode cache, as planning found it, and only
    the entries this run adds to it are removed: a directory this run did not create is never removed.

    Raises:
        FileExistsError: The directory appeared since planning and holds a file, or is a link or a file.
        CodegenSetupError: Something under it is a link or a special file.
    """
    generated = layout.generated_dir
    try:
        generated.mkdir()
    except FileExistsError:
        if generated.is_symlink() or not generated.is_dir() or walk(generated, layout):
            msg = f"{layout.describe(generated)} appeared while the gesture ran, and is not this run's to write into"
            raise FileExistsError(errno.EEXIST, msg, str(generated)) from None
        before = set(os.listdir(generated))

        def remove_what_was_added() -> None:
            for name in set(os.listdir(generated)) - before:
                _remove(generated / name)

        return remove_what_was_added
    return lambda: _remove(generated)


def _remove(path: Path) -> None:
    """Remove a file or a directory tree, whichever it is, and nothing if it is gone."""
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink(missing_ok=True)
