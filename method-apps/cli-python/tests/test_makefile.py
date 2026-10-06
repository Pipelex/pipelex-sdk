"""The Makefile's arguments and sibling checkouts, pinned with `make -n`.

`make -n` prints the commands a target would run without running them, so each case reads the line
a target would execute. Only a value given on the command line counts, a blank one is not given,
and a value reaches the shell exactly as typed.
"""

import os
import re
import subprocess
from pathlib import Path

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

    def test_without_the_mthds_checkout_says_mthds_stays_as_installed_not_as_locked(self):
        # Installing the SDK alone leaves the mthds already installed, which an earlier use-local
        # may have made a checkout, so the line never claims uv.lock's version.
        result = _make(["-n", "use-local"])
        assert result.returncode == 0, result.stderr
        said = "not found, so mthds stays as it is installed, unless the SDK pins another version, and the status below says which it is"
        assert said in result.stdout
        assert "uv.lock pins it" not in result.stdout


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
