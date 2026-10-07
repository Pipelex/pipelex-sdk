"""`lib/app.py`: the command a hint names is the one that was invoked, so the line pasted back runs it."""

import shutil
import sys
from collections.abc import Callable
from pathlib import Path

import pytest

from pipelex_method_cli_python.lib import app as app_module
from pipelex_method_cli_python.lib.app import COMMAND_NAME, command_name, shell_quote
from pipelex_method_cli_python.lib.errors import resume_command


def _which(found: Path | None) -> Callable[[str], str | None]:
    """A `shutil.which` that finds this console script at `found`, or nowhere."""

    def which(name: str) -> str | None:
        return str(found) if found is not None and name == COMMAND_NAME else None

    return which


def _script(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    script = directory / COMMAND_NAME
    script.write_text("#!/bin/sh\n", encoding="utf-8")
    return script


class TestCommandName:
    def test_the_console_script_on_the_path_is_named_bare(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        script = _script(tmp_path / "bin")
        monkeypatch.setattr(shutil, "which", _which(script))
        assert command_name(str(script)) == COMMAND_NAME

    def test_one_run_by_a_path_off_the_path_is_named_by_that_path(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # `.venv/bin/<name>`, before `uv tool install .`: the bare name would be "command not found".
        script = _script(tmp_path / ".venv" / "bin")
        monkeypatch.setattr(shutil, "which", _which(None))
        assert command_name(str(script)) == str(script)

    def test_one_run_by_a_path_when_another_is_on_the_path_is_named_by_that_path(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        installed = _script(tmp_path / "installed")
        local = _script(tmp_path / "project" / ".venv" / "bin")
        monkeypatch.setattr(shutil, "which", _which(installed))
        assert command_name(str(local)) == str(local)

    def test_a_path_with_a_space_is_quoted_for_the_shell(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        script = _script(tmp_path / "my project" / ".venv" / "bin")
        monkeypatch.setattr(shutil, "which", _which(None))
        monkeypatch.setattr(app_module, "is_windows", lambda: False)
        assert command_name(str(script)) == f"'{script}'"

    def test_a_path_with_a_space_is_double_quoted_for_cmd_on_windows(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # cmd.exe keeps POSIX single quotes as part of the argument, so they would name no file there.
        script = _script(tmp_path / "my project" / ".venv" / "bin")
        monkeypatch.setattr(shutil, "which", _which(None))
        monkeypatch.setattr(app_module, "is_windows", lambda: True)
        assert command_name(str(script)) == f'"{script}"'

    def test_anything_but_this_console_script_is_named_bare(self):
        # Under a test runner, or `python -m`, argv[0] is not the command a person would type.
        assert command_name("/usr/bin/pytest") == COMMAND_NAME

    def test_the_resume_hint_names_the_command_as_invoked(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        script = _script(tmp_path / ".venv" / "bin")
        monkeypatch.setattr(shutil, "which", _which(None))
        monkeypatch.setattr(sys, "argv", [str(script), "--detach"])
        assert resume_command("run-1") == f"{script} --resume run-1"
        monkeypatch.setattr(shutil, "which", _which(script))
        assert resume_command("run-1") == f"{COMMAND_NAME} --resume run-1"


class TestShellQuote:
    def test_posix_quoting_off_windows(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(app_module, "is_windows", lambda: False)
        assert shell_quote("/home/me/my project/.venv/bin/cli") == "'/home/me/my project/.venv/bin/cli'"
        assert shell_quote("/usr/local/bin/cli") == "/usr/local/bin/cli"

    def test_cmd_quoting_on_windows(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(app_module, "is_windows", lambda: True)
        assert shell_quote("C:\\Users\\Me\\my project\\.venv\\Scripts\\cli.exe") == '"C:\\Users\\Me\\my project\\.venv\\Scripts\\cli.exe"'
        assert shell_quote("C:\\tools\\cli.exe") == "C:\\tools\\cli.exe"
