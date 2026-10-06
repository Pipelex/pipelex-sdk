"""The Makefile's gesture arguments and sibling checkouts, pinned with `make -n`.

`make -n` prints the commands a target would run without running them, so each case reads the line
a target would execute. The rules are the method-app family's: only a value given on the command
line counts, a blank one (or a `0` switch) is not given, and a value reaches the script exactly as
typed. The family's own contract test runs `make -n create` in every template and compares them;
these pin this template's expansions on their own.
"""

import os
import re
import subprocess
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _make(args: list[str], *, env: dict[str, str] | None = None, cwd: Path = PROJECT_ROOT) -> subprocess.CompletedProcess[str]:
    """Run make with a clean make environment plus `env`.

    A parent make (`make all NAME=x`) passes its own command-line variables down through MAKEFLAGS,
    which would make them "given" here too, so they are dropped.
    """
    inherited = {key: value for key, value in os.environ.items() if key not in {"MAKEFLAGS", "MAKELEVEL", "MFLAGS"}}
    return subprocess.run(
        ["make", "--no-print-directory", *args], cwd=cwd, env={**inherited, **(env or {})}, capture_output=True, text=True, check=False
    )


def _create_line(variables: list[str], *, env: dict[str, str] | None = None) -> str:
    """The line `make create <variables>` would run, with its spacing collapsed."""
    result = _make(["-n", "create", *variables], env=env)
    assert result.returncode == 0, result.stderr
    line = next((printed for printed in result.stdout.splitlines() if "scripts/create.py" in printed), None)
    assert line is not None, result.stdout
    return " ".join(line.split())


def _checkouts(variables: list[str], *, env: dict[str, str] | None = None) -> tuple[str, str]:
    """The SDK and mthds checkouts `make use-local <variables>` would install, each as its quoted word."""
    result = _make(["-n", "use-local", *variables], env=env)
    assert result.returncode == 0, result.stderr
    line = next((printed for printed in result.stdout.splitlines() if printed.startswith("sdk=")), None)
    assert line is not None, result.stdout
    # Each directory is one `shq`-quoted word: `'…'`, with `'\''` for a quote inside.
    quoted = r"('[^']*'(?:\\''[^']*')*)"
    found = re.match(rf"sdk={quoted}; mthds={quoted};", line)
    assert found is not None, line
    return found.group(1), found.group(2)


class TestGestureArguments:
    def test_passes_the_values_given_on_the_command_line_as_flags(self):
        line = _create_line(["METHOD=bundles/cv", "NAME=cv", "PIPE=screen", "LICENSE=mit", "DRY_RUN=1"])
        assert line == ".venv/bin/python scripts/create.py 'bundles/cv' --name 'cv' --pipe 'screen' --license 'mit' --dry-run"

    def test_treats_a_blank_value_and_a_0_switch_as_not_given(self):
        assert _create_line(["METHOD=cv", "NAME=", "TITLE= ", "DRY_RUN="]) == ".venv/bin/python scripts/create.py 'cv'"
        assert _create_line(["METHOD=cv", "DRY_RUN=0"]) == ".venv/bin/python scripts/create.py 'cv'"

    def test_ignores_a_variable_the_shell_exports(self):
        line = _create_line(["METHOD=cv"], env={"NAME": "from-shell", "LICENSE": "proprietary", "DRY_RUN": "1"})
        assert line == ".venv/bin/python scripts/create.py 'cv'"

    def test_hands_a_value_over_exactly_as_typed(self):
        line = _create_line(["METHOD=$(touch pwned)", 'TITLE=Bob\'s "$5" app, really'])
        assert line == ".venv/bin/python scripts/create.py '$(touch pwned)' --title 'Bob'\\''s \"$5\" app, really'"

    @pytest.mark.parametrize("variables", [[], ["METHOD="], ["METHOD=  "]])
    def test_refuses_a_missing_or_blank_method_before_running_anything(self, variables: list[str]):
        result = _make(["create", *variables])
        assert result.returncode == 2
        assert "usage: make create METHOD=" in result.stdout
        assert "scripts/create.py" not in result.stdout


class TestSiblingCheckouts:
    def test_looks_in_the_parent_directory_by_default(self):
        assert _checkouts([]) == ("'../pipelex-sdk/python'", "'../mthds-python'")

    def test_looks_where_siblings_dir_says_quoted_exactly_as_typed(self):
        assert _checkouts(["SIBLINGS_DIR=../.."]) == ("'../../pipelex-sdk/python'", "'../../mthds-python'")
        assert _checkouts(["SIBLINGS_DIR=it's"]) == ("'it'\\''s/pipelex-sdk/python'", "'it'\\''s/mthds-python'")

    def test_sdk_dir_and_mthds_dir_name_either_checkout_directly(self):
        assert _checkouts(["SDK_DIR=/work/sdk/python", "MTHDS_DIR=$(touch pwned)"]) == ("'/work/sdk/python'", "'$(touch pwned)'")

    def test_ignores_what_the_shell_exports_and_a_blank_value(self):
        assert _checkouts([], env={"SIBLINGS_DIR": "/elsewhere", "SDK_DIR": "/elsewhere/sdk"}) == ("'../pipelex-sdk/python'", "'../mthds-python'")
        assert _checkouts(["SIBLINGS_DIR=", "SDK_DIR= "]) == ("'../pipelex-sdk/python'", "'../mthds-python'")


class TestLocalStatus:
    def test_says_every_package_is_missing_when_nothing_is_installed(self, tmp_path: Path):
        # The target reads the virtual environment of the directory make runs in, so it runs the real
        # Makefile (`-f`) inside an empty directory (`-C`).
        result = _make(["-C", str(tmp_path), "-f", str(PROJECT_ROOT / "Makefile"), "local-status"])
        assert result.returncode == 0, result.stderr
        assert result.stdout.splitlines() == ["pipelex-sdk missing", "mthds missing"]

    def test_use_published_restores_nothing_when_nothing_is_installed(self, tmp_path: Path):
        result = _make(["-C", str(tmp_path), "-f", str(PROJECT_ROOT / "Makefile"), "use-published"])
        assert result.returncode == 0, result.stderr
        assert "nothing to restore" in result.stdout
