"""Where the `pipelex-sdk` command sits in the package: declared as its console script, and never loaded
by the library.

The command is `pipelex_sdk/cli.py`, the executable, and the `pipelex_sdk/command/` package. Nothing in
the SDK imports either, so a program that uses the client pays nothing for the command. The second
test holds that by importing every other module of the package in a fresh interpreter, where nothing
this suite imported can hide a stray import, and reading what was loaded. `make test-package` checks
the built wheel's console script from outside the source tree (`docs/cli.md`).
"""

from __future__ import annotations

import json
import subprocess  # ruff: ignore[suspicious-subprocess-import]
import sys
import tomllib
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent.parent

# Import every module of the SDK but the command's, and print the names of the modules then loaded
# that belong to the command. The modules are found as files, since `pkgutil.walk_packages` imports
# every package it walks into, the command's included.
_IMPORT_THE_LIBRARY = """
import importlib, json, sys
from pathlib import Path
import pipelex_sdk

COMMAND = ("pipelex_sdk.cli", "pipelex_sdk.command")

def is_command(name):
    return any(name == part or name.startswith(part + ".") for part in COMMAND)

root = Path(pipelex_sdk.__file__).parent
imported = []
for source in sorted(root.rglob("*.py")):
    parts = ("pipelex_sdk", *source.relative_to(root).with_suffix("").parts)
    name = ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
    if not is_command(name):
        importlib.import_module(name)
        imported.append(name)
print(json.dumps({"imported": imported, "command": sorted(name for name in sys.modules if is_command(name))}))
"""


class TestCliPackaging:
    def test_the_package_declares_the_command_as_its_console_script(self) -> None:
        with (_PACKAGE_ROOT / "pyproject.toml").open("rb") as pyproject:
            scripts = tomllib.load(pyproject)["project"]["scripts"]

        assert scripts == {"pipelex-sdk": "pipelex_sdk.cli:main"}

    def test_importing_the_library_never_loads_the_command(self) -> None:
        completed = subprocess.run(  # ruff: ignore[subprocess-without-shell-equals-true]
            [sys.executable, "-c", _IMPORT_THE_LIBRARY],
            capture_output=True,
            text=True,
            check=True,
            cwd=_PACKAGE_ROOT,
        )
        report = json.loads(completed.stdout)

        # The walk reached the library's modules, so an empty list below means something.
        assert "pipelex_sdk.client" in report["imported"]
        assert "pipelex_sdk.prepare_inputs" in report["imported"]
        assert report["command"] == []
