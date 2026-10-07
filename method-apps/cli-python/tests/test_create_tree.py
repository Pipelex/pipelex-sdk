"""The proof that `make create` leaves a working project: one created from a copy of the template per kind of method.

The template ships no method, so nothing in it exercises what the gesture writes on every `make all`.
In its place this test copies the template to a temporary directory once per source kind, a bundle,
a catalog id and a published address, and runs the real gesture in each copy against the API's
recorded answers (`tests/support_create.py`), with the real bootstrap. Only the two steps that would
reach the network or recurse are skipped: `uv sync`, whose part is played by the template's own
environment, linked into each copy, and `make all`, whose checks this test then runs itself over each
created project: ruff, pyright in strict mode, the project's own tests, the offline codegen check, and
the created command's `--help`, which must list the method's inputs.

A change to the template that breaks what the gesture writes, or what the bootstrap leaves, fails
here rather than in the next person's project. The live proof, which runs the same gesture against
the API by hand before a release, is the repository's, in its root `docs/live-create-proofs.md`.
"""

import asyncio
import contextlib
import io
import os
import subprocess
import sys
import tomllib
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import pytest
from dotenv import dotenv_values

from pipelex_method_cli_python.lib import client as client_module
from scripts.create import BOOTSTRAP_DIR, CreateDeps, ShellEnv, run_create
from tests.support_create import RECEIPT_REVIEW_BUNDLE, STORED_METHOD_ID, TEXT_STATS_REF, RecordedClient, copy_template

#: How long one tool may take over one copy before the test gives up on it.
TOOL_TIMEOUT = 300


@dataclass(frozen=True)
class Case:
    """One kind of method, the arguments that create a project from it, and what the project must turn out to be."""

    kind: str
    argv: tuple[str, ...]
    name: str
    flag: str


CASES = (
    Case(kind="bundle", argv=(str(RECEIPT_REVIEW_BUNDLE),), name="receipt-review", flag="--receipts"),
    Case(kind="catalog-id", argv=(STORED_METHOD_ID,), name="stored-text-stats", flag="--text"),
    Case(kind="address", argv=(TEXT_STATS_REF, "--name", "fixture-text-stats"), name="fixture-text-stats", flag="--text"),
)


@dataclass(frozen=True)
class Created:
    """A project created from a copy of the template."""

    case: Case
    root: Path
    #: A directory standing in for the installed distribution, which `uv sync` would install.
    site: Path

    @property
    def package(self) -> str:
        return self.case.name.replace("-", "_")

    def run(self, *args: str, pythonpath: Sequence[Path] = ()) -> subprocess.CompletedProcess[str]:
        """Run one of the template's tools in the project, keeping its output for the assertion that reads it."""
        env = {key: value for key, value in os.environ.items() if not key.startswith(("PIPELEX_", "PYTEST_", "MAKE"))}
        if pythonpath:
            env["PYTHONPATH"] = os.pathsep.join(str(path) for path in pythonpath)
        return subprocess.run(list(args), cwd=self.root, env=env, capture_output=True, text=True, timeout=TOOL_TIMEOUT, check=False)


def fail_with(result: subprocess.CompletedProcess[str]) -> str:
    return f"exit {result.returncode}\n{result.stdout}\n{result.stderr}"


class BootstrapOnly:
    """Runs the bootstrap for real and keeps its output; skips `uv sync` and `make all`, which this test stands in for."""

    def __init__(self) -> None:
        self.output: list[str] = []

    def __call__(self, command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
        if list(command[:2]) in (["uv", "sync"], ["make", "all"]):
            return 0
        result = subprocess.run(list(command), cwd=cwd, env=None if env is None else dict(env), capture_output=True, text=True, check=False)
        self.output.extend((result.stdout, result.stderr))
        return result.returncode


def create(case: Case, destination: Path) -> Created:
    """Copy the template and create a project in the copy from the recorded answers."""
    root = copy_template(destination / "project")
    runner = BootstrapOnly()
    printed = io.StringIO()
    with pytest.MonkeyPatch.context() as patch, contextlib.redirect_stdout(printed), contextlib.redirect_stderr(printed):
        patch.setattr(client_module, "make_client", RecordedClient)
        patch.setenv("PIPELEX_API_KEY", "pk_recorded")
        deps = CreateDeps(root=root, cwd=root, shell=ShellEnv(key="pk_recorded"), env_file=None, run=runner)
        code = asyncio.run(run_create(case.argv, deps))
    if code != 0:
        pytest.fail(f"make create failed for the {case.kind}:\n{printed.getvalue()}\n{''.join(runner.output)}")
    site = destination / "site"
    dist_info = site / f"{case.name.replace('-', '_')}-0.1.0.dist-info"
    dist_info.mkdir(parents=True)
    (dist_info / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {case.name}\nVersion: 0.1.0\n", encoding="utf-8")
    return Created(case=case, root=root, site=site)


@pytest.fixture(scope="module")
def projects(tmp_path_factory: pytest.TempPathFactory) -> Iterator[dict[str, Created]]:
    yield {case.kind: create(case, tmp_path_factory.mktemp(f"create-{case.kind}")) for case in CASES}


@pytest.fixture(params=[case.kind for case in CASES])
def project(request: pytest.FixtureRequest, projects: dict[str, Created]) -> Created:
    kind: str = request.param
    return projects[kind]


def test_is_named_after_the_method_and_keeps_nothing_of_the_gesture(project: Created):
    root = project.root
    manifest = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert manifest["name"] == project.case.name
    assert manifest["version"] == "0.1.0"
    assert manifest["scripts"] == {project.case.name: f"{project.package}.cli:main"}
    assert sorted(path.name for path in (root / "src").iterdir()) == [project.package]
    for gone in (BOOTSTRAP_DIR, "scripts/create.py", "scripts/create_plan.py", "docs/create.md", "tests/test_create_tree.py"):
        assert not (root / gone).exists(), gone
    # Removing the bootstrap leaves the skill a project runs to move its SDK.
    assert (root / ".claude" / "skills" / "bump-sdk" / "SKILL.md").is_file()
    env = root / ".env"
    assert [line for line in env.read_text(encoding="utf-8").splitlines() if line.startswith("PIPELEX_BASE_URL")] == [
        "PIPELEX_BASE_URL='https://api.example.com'"
    ]
    assert dotenv_values(env)["PIPELEX_API_KEY"] == "pk_recorded"


def test_lints_and_formats_clean(project: Created):
    python = str(project.root / ".venv" / "bin" / "python")
    for check in (("check", "."), ("format", "--check", ".")):
        result = project.run(python, "-m", "ruff", *check)
        assert result.returncode == 0, fail_with(result)


def test_type_checks_in_strict_mode(project: Created):
    result = project.run(str(project.root / ".venv" / "bin" / "pyright"))
    assert result.returncode == 0, fail_with(result)


def test_leaves_the_generated_tree_current_by_the_offline_check(project: Created):
    result = project.run(sys.executable, "-m", "scripts.codegen_check", pythonpath=(project.root, project.root / "src"))
    assert result.returncode == 0, fail_with(result)
    assert "1 current · 0 drift · 0 no verdict" in result.stdout


def test_passes_its_own_tests(project: Created):
    result = project.run(sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", pythonpath=(project.site, project.root / "src"))
    assert result.returncode == 0, fail_with(result)


def test_its_command_lists_the_method_s_inputs(project: Created):
    name, package = project.case.name, project.package
    program = f"import sys; sys.argv[0] = {name!r}; from {package}.cli import main; main()"
    result = project.run(sys.executable, "-c", program, "--help", pythonpath=(project.site, project.root / "src"))
    assert result.returncode == 0, fail_with(result)
    assert f"Usage: {name} [OPTIONS]" in result.stdout
    assert project.case.flag in result.stdout
