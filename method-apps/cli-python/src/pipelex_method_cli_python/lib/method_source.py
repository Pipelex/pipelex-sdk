"""The method's source: what a run sends to name the one method this CLI runs.

`method/` inside the package holds the method in one of two forms, never both:

- **a bundle**, the method's own `.mthds` files, sent as the run's `mthds_contents`, every file under
  the directory in the order of its path;
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

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.manifest import MANIFEST_FILENAME, parse_manifest

#: The import package, read from this module's own name so that the rename `make create` makes
#: needs no second edit here.
PACKAGE = __name__.split(".", maxsplit=1)[0]

#: The directory, inside the package, that holds the method.
METHOD_DIRNAME = "method"

#: The extension of a bundle's files.
BUNDLE_SUFFIX = ".mthds"


class MethodSourceError(AppError):
    """A `method/` directory that does not name exactly one method."""


class RunSourceKwargs(TypedDict):
    """The keyword arguments the SDK's `start` and `execute` take to name a run's method."""

    mthds_contents: list[str] | None
    method_id: str | None
    method_ref: str | None


@dataclass(frozen=True)
class MethodSource:
    """The one way a run names its method; exactly one field is set.

    The fields are the SDK's own run sources: inline bundle contents, a catalog id, or a published
    address. `run_kwargs` hands them to `start` and `execute` as the keyword arguments of the same
    names, so both kinds of run name the method the same way.
    """

    mthds_contents: tuple[str, ...] | None = None
    method_id: str | None = None
    method_ref: str | None = None

    def run_kwargs(self) -> RunSourceKwargs:
        """The source as the keyword arguments of the SDK's `start` and `execute`."""
        return RunSourceKwargs(
            mthds_contents=list(self.mthds_contents) if self.mthds_contents is not None else None,
            method_id=self.method_id,
            method_ref=self.method_ref,
        )


def method_dir() -> Traversable:
    """The package's `method/` directory, wherever the package is installed."""
    return files(PACKAGE).joinpath(METHOD_DIRNAME)


def read_method_source(directory: Traversable | None = None) -> MethodSource:
    """Read the method's source out of `directory`, the package's `method/` by default.

    Raises:
        MethodSourceError: The directory is missing, holds neither `.mthds` files nor a `method.json`,
            or holds both.
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
        selector = parse_manifest(manifest.read_text(encoding="utf-8"), origin=f"{where}{MANIFEST_FILENAME}")
        return MethodSource(method_id=selector.method_id, method_ref=selector.method_ref)
    if not bundles:
        msg = f"{where} holds neither .mthds files nor a {MANIFEST_FILENAME}."
        raise MethodSourceError(msg, hint="Restore it from version control: it holds the method's .mthds files or its method.json.")
    return MethodSource(mthds_contents=tuple(entry.read_text(encoding="utf-8") for _, entry in bundles))


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
