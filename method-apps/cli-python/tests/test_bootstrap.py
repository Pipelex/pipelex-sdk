"""The bootstrap, `.claude/skills/bootstrap/scripts/bootstrap.py`: what a project keeps of the template, and what it never does.

The script runs over a copy of the template, as `make create` and the skill run it, and the copy is
then read back. The test that matters most is the leak test: no file a project keeps may name the
template, the create gesture or the wire-table recorder outside a passage the bootstrap removes, and
no marker may survive, since each would be a sentence about something the project does not have.
`uv.lock` is the one exception: it names the project until `uv sync` re-syncs it, which `make create`
runs next.

The script lives under `.claude/`, which pyright does not check, so it is run as a process and read
as a module loaded from its path; ruff checks it with the rest of the template.
"""

import importlib.util
import re
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tests.support_create import TEMPLATE_ROOT, copy_template

#: The bootstrap's script, relative to a project's root.
SCRIPT = Path(".claude") / "skills" / "bootstrap" / "scripts" / "bootstrap.py"

#: What must never survive in a file a project keeps.
LEAKS = re.compile(
    r"pipelex-method-cli-python|pipelex_method_cli_python|make create|scripts/create|scripts\.create|create_plan|template-only|record-wire-table"
)

#: What a project's files are read from: everything but environments, caches and the lock file.
NOT_READ = frozenset({".venv", "__pycache__", ".ruff_cache", ".pytest_cache"})

#: The license-holder warning, word for word: the scaffold skill greps for it.
LICENSE_HOLDER_WARNING = "warning: LICENSE copyright line left untouched — pass --license-holder to claim it."


def load_bootstrap() -> ModuleType:
    """The script as a module, loaded from the template's own copy of it."""
    spec = importlib.util.spec_from_file_location("bootstrap_under_test", TEMPLATE_ROOT / SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered while it loads, as an import would: its dataclasses look their module up by name.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


BOOTSTRAP: Any = load_bootstrap()


def bootstrap(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run the copy's own script over the copy, as `make create` runs it."""
    return subprocess.run([sys.executable, str(root / SCRIPT), "--root", str(root), *args], capture_output=True, text=True, check=False)


def kept_files(root: Path) -> dict[str, str]:
    """Every text file a project keeps, by its path relative to the root: the bootstrap's own leave once the checks are green."""
    found: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if path.is_symlink() or not path.is_file() or NOT_READ.intersection(relative.parts) or relative.as_posix() == "uv.lock":
            continue
        if relative.is_relative_to(SCRIPT.parent.parent):
            continue
        try:
            found[relative.as_posix()] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
    return found


def tree(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file() and not path.is_symlink()}


@pytest.fixture
def copy(tmp_path: Path) -> Path:
    return copy_template(tmp_path / "project")


@pytest.fixture(scope="module")
def created(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A copy bootstrapped as `make create` bootstraps one, with every value given."""
    root = copy_template(tmp_path_factory.mktemp("bootstrap") / "project")
    result = bootstrap(
        root,
        *("--name", "invoice-extractor", "--title", 'Invoice "Pro" Extractor', "--description", 'Reads invoices, "fast" — and \\ well.'),
        *("--author-name", "Ada Lovelace", "--author-email", "ada@example.com", "--repo-url", "https://github.com/acme/invoice-extractor/"),
        *("--license-holder", "Acme SAS", "--license-year", "2031", "--clean"),
    )
    assert result.returncode == 0, result.stderr
    return root


class TestWhatAProjectKeeps:
    def test_nothing_names_the_template_the_gesture_or_the_recorder_outside_a_removed_passage(self, created: Path):
        leaks = [
            f"{relative}:{number}: {line.strip()}"
            for relative, text in kept_files(created).items()
            for number, line in enumerate(text.splitlines(), start=1)
            if LEAKS.search(line)
        ]
        assert leaks == []

    def test_the_gesture_and_everything_only_it_uses_are_gone(self, created: Path):
        for removal in BOOTSTRAP.REMOVALS:
            assert not (created / removal).exists(), removal

    def test_the_package_is_renamed_and_every_path_follows(self, created: Path):
        assert sorted(path.name for path in (created / "src").iterdir()) == ["invoice_extractor"]
        attributes = (created / ".gitattributes").read_text(encoding="utf-8")
        assert "src/invoice_extractor/generated/** -text" in attributes
        assert "src/invoice_extractor/method/** text eol=lf" in attributes
        assert 'COMMAND_NAME = "invoice-extractor"' in (created / "src" / "invoice_extractor" / "lib" / "app.py").read_text(encoding="utf-8")

    def test_pyproject_carries_the_project_s_values(self, created: Path):
        text = (created / "pyproject.toml").read_text(encoding="utf-8")
        assert 'name = "invoice-extractor"\nversion = "0.1.0"\n' in text
        assert 'description = "Reads invoices, \\"fast\\" — and \\\\ well."\n' in text
        assert 'license = "MIT"\nauthors = [{ name = "Ada Lovelace", email = "ada@example.com" }]\n' in text
        urls = '[project.urls]\nRepository = "https://github.com/acme/invoice-extractor"\n\n'
        assert f'{urls}[project.scripts]\ninvoice-extractor = "invoice_extractor.cli:main"' in text
        assert 'packages = ["src/invoice_extractor"]' in text
        assert 'extend-exclude = ["src/invoice_extractor/generated"]' in text

    def test_the_guides_are_the_project_s(self, created: Path):
        claude = (created / "CLAUDE.md").read_text(encoding="utf-8")
        assert claude.startswith('# invoice-extractor\n\nReads invoices, "fast" — and \\ well.\n\n## Tech Stack\n')
        assert BOOTSTRAP.CHARTER_MARKER not in claude
        assert (created / "AGENTS.md").read_text(encoding="utf-8").startswith("# Agent instructions — invoice-extractor\n")
        readme = (created / "README.md").read_text(encoding="utf-8")
        assert readme.startswith('# Invoice "Pro" Extractor\n\nReads invoices, "fast" — and \\ well.\n')
        assert ".venv/bin/invoice-extractor --help" in readme
        assert "This project is licensed under the [MIT license](LICENSE)." in readme

    def test_the_version_history_and_license_restart(self, created: Path):
        changelog = (created / "CHANGELOG.md").read_text(encoding="utf-8")
        assert re.match(r"# Changelog\n\n## \[v0\.1\.0\] - \d{4}-\d{2}-\d{2}\n", changelog)
        license_text = (created / "LICENSE").read_text(encoding="utf-8")
        assert "Copyright (c) 2031 Acme SAS" in license_text and "Permission is hereby granted" in license_text

    def test_the_project_lints_and_formats_clean(self, created: Path):
        for check in (("check", "."), ("format", "--check", ".")):
            result = subprocess.run([sys.executable, "-m", "ruff", *check], cwd=created, capture_output=True, text=True, check=False)
            assert result.returncode == 0, result.stdout + result.stderr


class TestTheTemplateItRewrites:
    def test_claude_md_holds_what_the_bootstrap_matches_exactly(self):
        claude = (TEMPLATE_ROOT / "CLAUDE.md").read_text(encoding="utf-8")
        assert claude.splitlines()[2] == BOOTSTRAP.CLAUDE_DESCRIPTION
        charter = claude.index(BOOTSTRAP.CHARTER_MARKER)
        assert claude.rfind("template-only:begin", 0, charter) == -1, "the charter paragraph sits outside the template-only passages"
        # The distribution's name appears only in the heading; the package's, in paths, is rewritten like any other.
        assert [line for line in claude.splitlines() if BOOTSTRAP.TEMPLATE_NAME in line] == [f"# {BOOTSTRAP.TEMPLATE_NAME}"]

    def test_every_marker_is_on_a_line_of_its_own_and_every_passage_closes(self, copy: Path):
        for relative, text in kept_files(copy).items():
            if BOOTSTRAP.is_removed(relative):
                continue
            begins = [line for line in text.splitlines() if "template-only:begin" in line]
            ends = [line for line in text.splitlines() if "template-only:end" in line]
            assert len(begins) == len(ends), relative


class TestRuns:
    def test_a_dry_run_changes_nothing(self, copy: Path):
        before = tree(copy)
        result = bootstrap(copy, "--name", "invoice-extractor", "--description", "Reads invoices.", "--clean", "--dry-run")
        assert result.returncode == 0, result.stderr
        assert tree(copy) == before
        assert "move    src/pipelex_method_cli_python/ -> src/invoice_extractor/" in result.stdout
        assert "remove  scripts/create.py" in result.stdout

    def test_without_clean_the_charter_stays_and_nothing_leaks(self, copy: Path):
        result = bootstrap(copy, "--name", "invoice-extractor", "--description", "Reads invoices.")
        assert result.returncode == 0, result.stderr
        assert BOOTSTRAP.CHARTER_MARKER in (copy / "CLAUDE.md").read_text(encoding="utf-8")
        assert not any(LEAKS.search(text) for text in kept_files(copy).values())

    def test_warns_of_a_license_holder_left_untouched_word_for_word(self, copy: Path):
        result = bootstrap(copy, "--name", "invoice-extractor", "--description", "Reads invoices.", "--dry-run")
        assert LICENSE_HOLDER_WARNING in result.stderr.splitlines()

    def test_a_second_run_needs_force(self, copy: Path):
        assert bootstrap(copy, "--name", "invoice-extractor", "--description", "Reads invoices.").returncode == 0
        again = bootstrap(copy, "--name", "invoice-extractor", "--description", "Again.")
        assert again.returncode == 1
        assert "does not look like the un-bootstrapped template" in again.stderr
        forced = bootstrap(copy, "--name", "invoice-extractor", "--description", "Again.", "--force")
        assert forced.returncode == 0, forced.stderr
        assert "proceeding (--force)" in forced.stderr

    def test_a_survivor_is_refused_before_anything_is_written(self, copy: Path):
        (copy / "docs" / "notes.md").write_text("Run make create again.\n", encoding="utf-8")
        before = tree(copy)
        result = bootstrap(copy, "--name", "invoice-extractor", "--description", "Reads invoices.")
        assert result.returncode == 1
        assert "docs/notes.md:1: Run make create again." in result.stderr
        assert tree(copy) == before

    @pytest.mark.parametrize(
        ("name", "says"),
        [
            ("Invoice", "invalid project name"),
            ("3d-model", "invalid project name"),
            ("bad--name", "invalid project name"),
            ("class", "is a Python keyword"),
            ("json", "would shadow the standard library"),
            ("scripts", "would shadow the project's own"),
            ("typer", "would shadow the project's own typer or a dependency's"),
            ("pipelex_method_cli_python", "the template's own name"),
        ],
    )
    def test_refuses_a_name_that_cannot_be_the_project_s(self, name: str, says: str, copy: Path):
        before = tree(copy)
        result = bootstrap(copy, "--name", name, "--description", "Reads invoices.")
        assert result.returncode == 1
        assert says in result.stderr
        assert tree(copy) == before

    @pytest.mark.parametrize(
        ("args", "says"),
        [
            (("--description", "--dry-run"), "missing value for --description"),
            (("--description", "Two\nlines"), "--description must be one line"),
            (("--description", "x", "--author-email", "ada@example.com"), "--author-email given without --author-name"),
            (("--description", "x", "--license-year", "31"), "invalid --license-year"),
            (("--description", "x", "--license", "not a licence"), "not an SPDX license expression"),
        ],
    )
    def test_refuses_a_value_it_cannot_write(self, args: tuple[str, ...], says: str, copy: Path):
        result = bootstrap(copy, "--name", "invoice-extractor", *args)
        assert result.returncode == 1
        assert says in result.stderr

    def test_a_proprietary_license_without_a_holder_gets_a_placeholder(self, copy: Path):
        result = bootstrap(copy, "--name", "invoice-extractor", "--description", "x", "--license", "proprietary")
        assert result.returncode == 0, result.stderr
        assert "warning: no --license-holder given; LICENSE gets a placeholder holder." in result.stderr
        assert (copy / "LICENSE").read_text(encoding="utf-8").startswith("Copyright (c) ")
        assert 'license = "LicenseRef-Proprietary"' in (copy / "pyproject.toml").read_text(encoding="utf-8")

    def test_an_spdx_license_is_canonicalized_and_stubbed(self, copy: Path):
        result = bootstrap(copy, "--name", "invoice-extractor", "--description", "x", "--license", "apache-2.0", "--license-holder", "Acme")
        assert result.returncode == 0, result.stderr
        assert "LICENSE becomes a stub for 'Apache-2.0'" in result.stderr
        assert 'license = "Apache-2.0"' in (copy / "pyproject.toml").read_text(encoding="utf-8")


class TestStripTemplateOnly:
    def test_removes_each_passage_with_its_markers_and_collapses_the_blank_line_left(self):
        text = "keep\n\n<!-- template-only:begin -->\ngone\n<!-- template-only:end -->\n\nalso kept\n"
        assert BOOTSTRAP.strip_template_only(text, "x.md", required=True) == "keep\n\nalso kept\n"

    def test_leaves_a_file_whose_passage_never_closes(self, capsys: pytest.CaptureFixture[str]):
        text = "keep\n# template-only:begin\nopen\n"
        assert BOOTSTRAP.strip_template_only(text, "x.py", required=False) == text
        assert "never closed" in capsys.readouterr().err

    def test_rewrites_both_names_in_one_scan(self):
        names = BOOTSTRAP.Names(name="pipelex-method-cli-python-two", package="pipelex_method_cli_python_two", title="T")
        # A replacement is never read again, even when it holds the name it replaced.
        assert BOOTSTRAP.apply_name_tokens("pipelex_method_cli_python pipelex-method-cli-python", names) == (
            "pipelex_method_cli_python_two pipelex-method-cli-python-two"
        )
