"""`pipelex-sdk script`: write the per-method command, a short shell script that runs one method
through this SDK's `run`, its version pinned.

The checks that need no request come first, in this order: the flags, `--pipe`'s form, a control
character in any value the script would carry, the method's form (a local bundle is refused),
`--name`, `--dir`, the target file when its name is already known, the key and the base URL. Then, in
the command's one event loop (`loop.py`), one pipe I/O call checks the method and the pipe, which spends no inference, and
a catalog id with no `--name` is named from its catalog entry. Last, the file is written, never over an
existing one, with the permissions of an executable.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import ValidationError

from pipelex_sdk.command.args import FlagKind, parse_flags
from pipelex_sdk.command.bundle import system_reason
from pipelex_sdk.command.environment import make_client
from pipelex_sdk.command.help import SCRIPT_HELP
from pipelex_sdk.command.io import EXIT_OK, CommandError, usage_error
from pipelex_sdk.command.loop import before_request, run_until_done
from pipelex_sdk.command.method import (
    AddressSelector,
    CatalogSelector,
    PathSelector,
    address_name,
    address_tag,
    check_pipe_ref,
    classify_method,
    has_control_character,
    kebab_case,
    script_name_problem,
    shell_quote,
)
from pipelex_sdk.command.source import AddressSource, CatalogSource, describe_pipe
from pipelex_sdk.version import __version__

if TYPE_CHECKING:
    from collections.abc import Sequence

    from pipelex_sdk.client import PipelexAPIClient
    from pipelex_sdk.command.io import CommandIO, Progress

_SCRIPT_FLAGS: dict[str, FlagKind] = {
    "method": FlagKind.STRING,
    "pipe": FlagKind.STRING,
    "name": FlagKind.STRING,
    "dir": FlagKind.STRING,
}

#: The package a written script runs, and what its runner needs.
SCRIPT_RUNNER = f"uvx pipelex-sdk@{__version__}"
SCRIPT_WRITER = "pipelex-sdk"
SCRIPT_NEEDS = "uv"

_EXECUTABLE_MODE = 0o755


def run_command_script(args: Sequence[str], io: CommandIO, progress: Progress) -> int:
    """Run `pipelex-sdk script` and return its exit code."""
    flags = parse_flags("script", args, _SCRIPT_FLAGS)
    if flags.help:
        io.write_stdout(SCRIPT_HELP)
        return EXIT_OK
    progress.interrupt_message = "Interrupted. Nothing was written."
    method = flags.strings.get("method")
    if method is None:
        msg = "--method is required."
        raise usage_error(msg, ["Run 'pipelex-sdk script --help' to see its flags."])
    pipe = flags.strings.get("pipe")
    if pipe is not None:
        check_pipe_ref(pipe)
    given_name = flags.strings.get("name")
    for flag, value in (("--method", method), ("--pipe", pipe), ("--name", given_name)):
        if value is not None and has_control_character(value):
            msg = f"{flag} holds a control character, which no line of a script may carry."
            raise usage_error(msg)

    source: AddressSource | CatalogSource
    match classify_method(method):
        case PathSelector():
            msg = (
                f'script takes a method address or a catalog id, and "{method}" is neither: '
                "a script naming a local bundle breaks as soon as the script or the bundle moves."
            )
            raise usage_error(
                msg,
                [
                    "Publish the method in a git repository and pass its address: github.com/<owner>/<repo>[/<package>]@<tag>",
                    "Or save it to your organization's catalog and pass its id: mt_...",
                    "To run a local bundle, use: pipelex-sdk run --method <path>",
                ],
            )
        case AddressSelector(method_ref=method_ref):
            source = AddressSource(method_ref=method_ref)
        case CatalogSelector(method_id=method_id):
            source = CatalogSource(method_id=method_id)

    if given_name is not None:
        problem = script_name_problem(given_name)
        if problem is not None:
            msg = f"--name {problem}."
            raise usage_error(msg)
    directory = flags.strings.get("dir")
    shown_dir = "." if directory is None else directory.rstrip("/")
    _check_directory(directory or ".")

    name = given_name
    if name is None and isinstance(source, AddressSource):
        name = _default_name(address_name(source.method_ref), method)
    if name is not None:
        _check_free(shown_dir, name)

    client = make_client(io)
    unnamed_catalog = source if name is None and isinstance(source, CatalogSource) else None
    entry_name = run_until_done(_check_method(client, source, pipe, unnamed_catalog))
    if name is None:
        # Only a catalog id is left unnamed here, since an address's script is named after it.
        name = _default_name(kebab_case(entry_name or ""), method)
        _check_free(shown_dir, name)

    if isinstance(source, AddressSource) and address_tag(source.method_ref) is None:
        io.write_stderr(
            f"Warning: {source.method_ref} has no tag, so the script runs whatever its repository's default branch holds "
            "each time it runs. Add @<tag> to pin a release.\n"
        )
    target = f"{shown_dir}/{name}"
    # Ctrl-C reaches this synchronous part as `KeyboardInterrupt` at once, so nothing is written once
    # it lands, and a write it cuts short leaves no file (`_write_script`): until the file is whole,
    # nothing was written.
    _write_script(target, script_body(name, method, pipe))
    progress.interrupt_message = "Interrupted."
    io.write_stdout(f"{target}\n")
    io.write_stderr(f"Wrote {target}. Run it with: {target} --inputs inputs.json\n")
    return EXIT_OK


async def _check_method(
    client: PipelexAPIClient,
    source: AddressSource | CatalogSource,
    pipe: str | None,
    unnamed: CatalogSource | None,
) -> str | None:
    """Check the method and the pipe with one pipe I/O call, and read the name of the catalog entry
    `unnamed` names, the method whose script `--name` did not name; return that name, or `None` when
    there is none to read.
    """
    async with client:
        await describe_pipe(client, source, pipe)
        if unnamed is None:
            return None
        await before_request()
        try:
            entry = await client.get_method(unnamed.method_id)
        except ValidationError as exc:
            # An entry whose name is missing or no string gives no name, which asks for `--name` as an
            # unusable name does; any other fault in the entry is the API's answer that cannot be read.
            if any(error["loc"][:1] != ("name",) for error in exc.errors()):
                raise
            return None
    return entry.name


def script_body(name: str, method: str, pipe: str | None) -> str:
    """The script's text: the shebang, a header saying what it runs, which SDK wrote it, what it needs
    and how to use it, and the one line that runs it, every value single-quoted.
    """
    pipe_argument = "" if pipe is None else f" --pipe {shell_quote(pipe)}"
    return "\n".join(
        [
            "#!/bin/sh",
            f"# {name}: runs {method} on the Pipelex API.",
            f"# Written by {SCRIPT_WRITER} {__version__}. Needs {SCRIPT_NEEDS}, and PIPELEX_API_KEY in the environment.",
            f"# Usage: ./{name} --inputs inputs.json, or ./{name} --inputs-template to see what to fill in.",
            f'exec {SCRIPT_RUNNER} run --method {shell_quote(method)}{pipe_argument} "$@"',
            "",
        ]
    )


def _default_name(candidate: str, method: str) -> str:
    """A default name, held to the rules of a file name, or the usage error asking for `--name`."""
    if script_name_problem(candidate) is not None:
        msg = f'no script name can be made from "{method}"; give one with --name.'
        raise usage_error(msg)
    return candidate


def _check_directory(directory: str) -> None:
    try:
        found = Path(os.path.abspath(directory)).stat()
    except OSError as exc:
        msg = f'--dir "{directory}" does not exist.'
        raise usage_error(msg, [f"Reason: {system_reason(exc)}"]) from exc
    if not stat.S_ISDIR(found.st_mode):
        msg = f'--dir "{directory}" is not a directory.'
        raise usage_error(msg)


def _check_free(shown_dir: str, name: str) -> None:
    """Refuse a target that exists, whatever it is, a link that leads nowhere included."""
    target = f"{shown_dir}/{name}"
    try:
        os.lstat(os.path.abspath(target))
    except OSError:
        return
    raise _already_there(target)


def _write_script(target: str, body: str) -> None:
    """Create the file, executable, refusing one that exists, a dangling link included (`O_EXCL`).

    A write that fails or is interrupted once the file exists removes it, so a script is either whole
    or absent.
    """
    path = os.path.abspath(target)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, _EXECUTABLE_MODE)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(body.encode("utf-8"))
        except BaseException:
            Path(path).unlink(missing_ok=True)
            raise
    except FileExistsError as exc:
        raise _already_there(target) from exc
    except OSError as exc:
        msg = f'cannot write "{target}".'
        raise usage_error(msg, [f"Reason: {system_reason(exc)}"]) from exc


def _already_there(target: str) -> CommandError:
    return usage_error(
        f'"{target}" already exists, and script never overwrites a file.',
        ["Remove it, or choose another name with --name or another directory with --dir."],
    )
