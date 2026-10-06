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

from dataclasses import dataclass, field
from importlib.resources import files
from importlib.resources.abc import Traversable
from typing import TypedDict

from pipelex_sdk.crate_models import MthdsFileItem

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


class CrateSourceKwargs(TypedDict):
    """The keyword arguments the SDK's `prepare_inputs` takes to name the method, as the crate routes do."""

    files: list[MthdsFileItem] | None
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
    #: Where each of a bundle's files comes from, `method/<path>`, beside its contents: the label the
    #: server names in a diagnostic about the file. Not part of what the source is.
    labels: tuple[str, ...] | None = field(default=None, compare=False)

    def run_kwargs(self) -> RunSourceKwargs:
        """The source as the keyword arguments of the SDK's `start` and `execute`."""
        return RunSourceKwargs(
            mthds_contents=list(self.mthds_contents) if self.mthds_contents is not None else None,
            method_id=self.method_id,
            method_ref=self.method_ref,
        )

    def crate_kwargs(self) -> CrateSourceKwargs:
        """The source as the keyword arguments of the SDK's `prepare_inputs`: a bundle as files, each with its label."""
        bundle: list[MthdsFileItem] | None = None
        if self.mthds_contents is not None:
            labels = self.labels if self.labels is not None and len(self.labels) == len(self.mthds_contents) else (None,) * len(self.mthds_contents)
            bundle = [MthdsFileItem(content=content, source=label) for content, label in zip(self.mthds_contents, labels, strict=True)]
        return CrateSourceKwargs(files=bundle, method_id=self.method_id, method_ref=self.method_ref)


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
    return MethodSource(
        mthds_contents=tuple(_read_utf8(entry, where=f"{where}{relative}") for relative, entry in bundles),
        labels=tuple(f"{METHOD_DIRNAME}/{relative}" for relative, _ in bundles),
    )


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
