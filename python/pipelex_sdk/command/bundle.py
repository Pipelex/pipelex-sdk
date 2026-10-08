"""The bundle reader: a `--method` path read from disk into the files `run` sends inline.

The rules are the command's contract, recorded as cases in `tests/fixtures/cli-cases.json` so that
both SDKs' commands read a bundle the same way (`docs/cli.md`, "Reading a bundle"):

- **A `.mthds` file** is a one-file bundle, sent under its own file name. A file of any other name
  is refused.
- **A directory** is every `.mthds` file under it, at any depth, each sent under its path relative to
  the directory, with `/` between segments.
- **The order** is the order of those names compared code point by code point, which is the order of
  their UTF-8 bytes: `Zeta.mthds` before `main.mthds`, and `steps/score.mthds` before
  `steps2.mthds`. A run sends the contents in this order.
- **A hidden entry**, a file or a directory whose name starts with `.`, is skipped, so a `.venv/` or
  a `.git/` inside a bundle is never read.
- **Any file not named `.mthds`** is ignored, Python files included: the command sends only the MTHDS
  sources.
- **A symbolic link** is judged by its own name: one named `.mthds` that leads to a file is read
  through, under the link's name; one that leads to a directory is not descended into, which keeps a
  link cycle from looping; and one that leads nowhere is refused. The `--method` path itself may be a
  link, and is followed.
- **A directory with no `.mthds` file** under it is refused, as is a file that is not UTF-8 text and a
  directory that cannot be listed. A byte-order mark is kept as the file's first character, as it is
  on disk.

Every refusal is a usage error, raised before any request. Paths are resolved against the current
directory without following links (`os.path.abspath`), so a file is sent under the name it was given.
"""

from __future__ import annotations

import errno
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from pipelex_sdk.command.io import usage_error

#: The extension of a bundle's files.
BUNDLE_SUFFIX = ".mthds"


@dataclass(frozen=True)
class BundleFile:
    """One file of a bundle: the name it is sent under, and its text."""

    name: str
    content: str


@dataclass(frozen=True)
class _Entry:
    name: str
    path: str


def system_reason(exc: OSError) -> str:
    """The system's reason for a failed file operation: its error code (`ENOENT`), else its message."""
    if exc.errno is not None and exc.errno in errno.errorcode:
        return errno.errorcode[exc.errno]
    return exc.strerror or str(exc)


def read_bundle(given: str) -> list[BundleFile]:
    """Read the bundle a `--method` path names, in the order the rules above give.

    Raises:
        CommandError: A usage error for a path that names no bundle.
    """
    absolute = os.path.abspath(given)
    try:
        found = Path(absolute).stat()
    except OSError as exc:
        msg = f'--method "{given}" is not a catalog id (mt_...), not an address (github.com/...), and no file or directory of that name exists.'
        raise usage_error(msg, [f"Reason: {system_reason(exc)}"]) from exc
    if stat.S_ISDIR(found.st_mode):
        shown = given.rstrip("/") or "/"
        entries: list[_Entry] = []
        _collect(absolute, "", shown, entries)
        if not entries:
            msg = f'--method "{given}" is a directory with no .mthds file under it.'
            raise usage_error(msg)
        entries.sort(key=lambda entry: entry.name)
        return [BundleFile(name=entry.name, content=_read_text(entry.path, _under(shown, entry.name))) for entry in entries]
    if not stat.S_ISREG(found.st_mode):
        msg = f'--method "{given}" is neither a file nor a directory.'
        raise usage_error(msg)
    name = os.path.basename(absolute)
    if not name.endswith(BUNDLE_SUFFIX):
        msg = f'--method "{given}" is not a .mthds file.'
        raise usage_error(msg, ["Name a .mthds file, a directory of them, an address (github.com/...) or a catalog id (mt_...)."])
    return [BundleFile(name=name, content=_read_text(absolute, given))]


def _collect(directory: str, prefix: str, shown_root: str, into: list[_Entry]) -> None:
    """Gather the `.mthds` files under `directory`, each with its name relative to the bundle's root."""
    try:
        with os.scandir(directory) as listing:
            dir_entries = list(listing)
    except OSError as exc:
        shown = shown_root if not prefix else _under(shown_root, prefix[:-1])
        msg = f'cannot list "{shown}".'
        raise usage_error(msg, [f"Reason: {system_reason(exc)}"]) from exc
    for dir_entry in dir_entries:
        if dir_entry.name.startswith("."):
            continue
        name = f"{prefix}{dir_entry.name}"
        path = os.path.join(directory, dir_entry.name)
        if dir_entry.is_dir(follow_symlinks=False):
            _collect(path, f"{name}/", shown_root, into)
        elif dir_entry.is_symlink():
            if not dir_entry.name.endswith(BUNDLE_SUFFIX):
                continue
            try:
                target = Path(path).stat()
            except OSError as exc:
                msg = f'"{_under(shown_root, name)}" is a symbolic link that leads to no file.'
                raise usage_error(msg, [f"Reason: {system_reason(exc)}"]) from exc
            if stat.S_ISREG(target.st_mode):
                into.append(_Entry(name=name, path=path))
        elif dir_entry.is_file(follow_symlinks=False) and dir_entry.name.endswith(BUNDLE_SUFFIX):
            into.append(_Entry(name=name, path=path))


def _under(root: str, name: str) -> str:
    """A path inside the bundle as the person would type it: the `--method` path as given, without its
    trailing `/`, then `/`, then the file's name in the bundle.
    """
    return f"{'' if root == '/' else root}/{name}"


def _read_text(path: str, shown: str) -> str:
    """A bundle file's text, which must be UTF-8; a byte-order mark stays its first character."""
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        msg = f'cannot read "{shown}".'
        raise usage_error(msg, [f"Reason: {system_reason(exc)}"]) from exc
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        msg = f'"{shown}" is not UTF-8 text.'
        raise usage_error(msg) from exc
