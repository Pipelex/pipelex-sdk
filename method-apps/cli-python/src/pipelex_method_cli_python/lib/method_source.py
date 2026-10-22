"""The method's source: what a run sends to name the one method this CLI runs.

`method/` inside the package holds the method in one of two forms, never both:

- **a bundle**, the method's own `.mthds` files, sent as the method's tree, the run's `files`: each
  file's text keyed by its tree path, its path under the directory, which is the tree's root, in
  the order of that path;
- **a manifest**, `method.json`, naming a method that lives elsewhere: a catalog id (`method_id`) or
  a published address (`method_ref`), read by `lib/manifest.py`.

The directory is read through `importlib.resources`, never from a path beside the source code: an
installed CLI (`uv tool install .`, or a wheel) has no repository around it, and the wheel carries
`method/` as package data.
"""

from dataclasses import dataclass
from importlib.resources import files
from importlib.resources.abc import Traversable
from typing import TypedDict

from mthds.method_tree.file_entry import FileEntry

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.manifest import MANIFEST_FILENAME, parse_manifest

#: The import package, read from this module's own name so that renaming the package needs no edit
#: here.
PACKAGE = __name__.split(".", maxsplit=1)[0]

#: The directory, inside the package, that holds the method.
METHOD_DIRNAME = "method"

#: The extension of a bundle's files.
BUNDLE_SUFFIX = ".mthds"


class MethodSourceError(AppError):
    """A `method/` directory that does not name exactly one method."""


class SourceKwargs(TypedDict):
    """The keyword arguments the SDK's `start`, `execute` and `prepare_inputs` all take to name the method."""

    files: dict[str, FileEntry] | None
    method_id: str | None
    method_ref: str | None


@dataclass(frozen=True)
class MethodSource:
    """The one way a run names its method; exactly one field is set.

    The fields are the SDK's own method sources: a bundle as the method's tree, a catalog id, or a
    published address. `kwargs` hands them to `start`, `execute` and `prepare_inputs` as the keyword
    arguments of the same names, so a run and its inputs' preparation name the method the same way.
    """

    #: A bundle as the method's tree: each `.mthds` file's text, keyed by its path in `method/`, in the
    #: order of that path. The server names a file by that path in a diagnostic about it.
    files: dict[str, str] | None = None
    method_id: str | None = None
    method_ref: str | None = None

    def kwargs(self) -> SourceKwargs:
        """The source as the keyword arguments of the SDK's `start`, `execute` and `prepare_inputs`."""
        tree: dict[str, FileEntry] | None = dict(self.files) if self.files is not None else None
        return SourceKwargs(files=tree, method_id=self.method_id, method_ref=self.method_ref)


def method_dir() -> Traversable:
    """The package's `method/` directory, wherever the package is installed."""
    return files(PACKAGE).joinpath(METHOD_DIRNAME)


def read_method_source(directory: Traversable | None = None) -> MethodSource:
    """Read the method's source out of `directory`, the package's `method/` by default.

    Raises:
        MethodSourceError: The directory is missing, holds neither `.mthds` files nor a `method.json`,
            holds both, or holds a file that is not UTF-8.
        ManifestError: The `method.json` does not name exactly one method.
    """
    root = directory if directory is not None else method_dir()
    where = f"{PACKAGE}/{METHOD_DIRNAME}/"
    if not root.is_dir():
        msg = f"{where} is missing, so this CLI has no method to run."
        raise MethodSourceError(msg, hint="Restore it from version control: it holds the method's .mthds files or its method.json.")
    bundles = sorted(_bundle_files(root, prefix=""), key=lambda found: found[0])
    manifest = root.joinpath(MANIFEST_FILENAME)
    if bundles and manifest.is_file():
        msg = f"{where} holds both .mthds files and a {MANIFEST_FILENAME}, so it names two methods."
        raise MethodSourceError(msg, hint=f"Keep the bundle or the {MANIFEST_FILENAME}, not both.")
    if manifest.is_file():
        selector = parse_manifest(_read_utf8(manifest, where=f"{where}{MANIFEST_FILENAME}"), origin=f"{where}{MANIFEST_FILENAME}")
        return MethodSource(method_id=selector.method_id, method_ref=selector.method_ref)
    if not bundles:
        msg = f"{where} holds neither .mthds files nor a {MANIFEST_FILENAME}."
        raise MethodSourceError(msg, hint="Restore it from version control: it holds the method's .mthds files or its method.json.")
    return MethodSource(files={relative: _read_utf8(entry, where=f"{where}{relative}") for relative, entry in bundles})


def _read_utf8(entry: Traversable, *, where: str) -> str:
    """A method file's text, which must be UTF-8.

    Raises:
        MethodSourceError: The file is not UTF-8, which neither the API nor the codegen would read.
    """
    try:
        return entry.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        msg = f"{where} is not UTF-8 text: {exc.reason} at byte {exc.start}."
        raise MethodSourceError(msg, hint="Save the file as UTF-8.") from exc


def _bundle_files(directory: Traversable, *, prefix: str) -> list[tuple[str, Traversable]]:
    """Every `.mthds` file under `directory`, each with its path relative to the walk's root."""
    found: list[tuple[str, Traversable]] = []
    for entry in directory.iterdir():
        relative = f"{prefix}{entry.name}"
        if entry.is_dir():
            found.extend(_bundle_files(entry, prefix=f"{relative}/"))
        elif entry.name.endswith(BUNDLE_SUFFIX):
            found.append((relative, entry))
    return found
