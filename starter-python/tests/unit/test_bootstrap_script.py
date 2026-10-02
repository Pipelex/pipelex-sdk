from __future__ import annotations

import importlib.util
import sys
from importlib.machinery import SourceFileLoader
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP_SCRIPT = ROOT / ".claude" / "skills" / "bootstrap" / "scripts" / "bootstrap.py"
WORKFLOWS_DIR = Path(".github") / "workflows"


def load_bootstrap() -> Any:
    spec = importlib.util.spec_from_file_location("bootstrap_script_under_test", BOOTSTRAP_SCRIPT)
    assert spec is not None
    loader = spec.loader
    assert isinstance(loader, SourceFileLoader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    loader.exec_module(module)
    return module


def write_template(root: Path, *, extra_pyproject: str = "") -> None:
    (root / "widget").mkdir()
    (root / "widget" / "blocking").mkdir()
    (root / "tests").mkdir()
    (root / "tests" / "unit").mkdir()
    (root / "pyproject.toml").write_text(
        f"""[project]
name = "widget"
description = "Replace this with your project description"
# authors = [{{ name = "Your Name", email = "your.email@example.com" }}]
license = "MIT"

[project.scripts]
widget = "widget.cli:app"

[tool.setuptools]
# widget/methods/*, this packages/package-data block, and the Makefile codegen targets.
packages = [
  "widget",
  "widget.blocking",
  "widget.generated",
  "widget.generated.extract_entities",
]

[tool.setuptools.package-data]
widget = ["py.typed", "methods/*/*.mthds"]
"widget.generated.extract_entities" = ["codegen.lock"]

[tool.ruff]
extend-exclude = [
  "widget/generated",
]

[project.urls]
Repository = "https://github.com/yourusername/widget" # Replace with your repository URL

[tool.mypy]
packages = ["widget"]

[tool.pyright]
include = ["widget", "tests"]
{extra_pyproject}""",
        encoding="utf-8",
    )
    (root / "README.md").write_text("# Widget\n\nRun `widget extract-entities`.\n", encoding="utf-8")
    (root / "Makefile").write_text(
        "codegen:\n"
        "\t@$(PIPELEX_RUN) codegen types --target python-pydantic --output widget/generated/extract_entities widget/methods/extract-entities\n"
        "\n"
        "codegen-check:\n"
        "\t@$(PIPELEX_RUN) codegen check widget/generated/extract_entities\n",
        encoding="utf-8",
    )
    (root / "docs").mkdir()
    (root / "docs" / "codegen.md").write_text("Generated models live in `widget/generated/<method>/models.py`.\n", encoding="utf-8")
    (root / "CLAUDE.md").write_text("The `widget` CLI lives in `widget/cli.py`.\n", encoding="utf-8")
    (root / "LICENSE").write_text("MIT License\n\nCopyright (c) 2025 Example\n", encoding="utf-8")
    (root / "widget" / "cli.py").write_text('"""The widget CLI."""\n', encoding="utf-8")
    # A mode sub-package: nested dir, and an import of a sibling module to rewrite.
    (root / "widget" / "blocking" / "cli.py").write_text("from widget.inputs import read_text_input\n", encoding="utf-8")
    (root / "tests" / "test_cli.py").write_text("from widget.cli import app\n", encoding="utf-8")
    # A bare `import <package>`: the token stands alone, with none of the `.`, `_` or `/`
    # the package rule keys on, which is what makes it the one import position that can
    # come back in the dist form.
    (root / "tests" / "test_fundamentals.py").write_text(
        'import widget\n\nMETHODS_DIR = Path(widget.__file__).parent / "methods"\n',
        encoding="utf-8",
    )
    # This file's own stand-in. Its fixtures spell the placeholder deliberately, so
    # the sweep has to leave it alone; Step 6 of SKILL.md deletes it with the skill.
    (root / "tests" / "unit" / "test_bootstrap_script.py").write_text(
        'bootstrap.validate_package("widget_tools")\n',
        encoding="utf-8",
    )
    # The codegen script holds the method/generated paths that used to live in the Makefile.
    (root / "scripts").mkdir()
    (root / "scripts" / "codegen.py").write_text(
        'METHODS_DIR = REPO_ROOT / "widget/methods"\nGENERATED_ROOT = REPO_ROOT / "widget/generated"\n',
        encoding="utf-8",
    )


def test_validate_package_rejects_placeholder_colliding_names() -> None:
    # A package like `widget_tools` re-matches the placeholder regex after its own
    # insertion (widget_tools -> widget_tools_tools in pyproject), so it is refused
    # up front instead of producing a corrupted, non-building project.
    bootstrap = load_bootstrap()

    with pytest.raises(SystemExit) as exc_info:
        bootstrap.validate_package("widget_tools")

    assert "widget" in str(exc_info.value)


def test_validate_package_allows_names_embedding_widget() -> None:
    # No word boundary before "widget" here, so it never collides with the placeholder.
    bootstrap = load_bootstrap()

    bootstrap.validate_package("superwidget_tools")


def test_survivor_check_allows_requested_values_containing_widget(tmp_path: Path) -> None:
    bootstrap = load_bootstrap()
    write_template(tmp_path)

    names = bootstrap.Names(dist="superwidget-tools", package="superwidget_tools", title="Superwidget Tools")
    opts = bootstrap.Options(
        description="Build Widget workflows",
        author_name="Widget Team",
        author_email=None,
        repo_url="https://github.com/acme/widget-tools",
        lic=bootstrap.License(kind="mit", spdx="MIT", holder="Widget Team", year=2026),
        clean=False,
        dry_run=True,
        use_git=False,
    )

    bootstrap.run(tmp_path, names, opts)


def test_run_rewrites_makefile_and_docs_paths(tmp_path: Path) -> None:
    # The Makefile codegen targets and the docs reference widget/... paths; a
    # bootstrap that skips them leaves `make codegen` pointing at a directory
    # that no longer exists on the renamed project.
    bootstrap = load_bootstrap()
    write_template(tmp_path)

    names = bootstrap.Names(dist="invoice-extractor", package="invoice_extractor", title="Invoice Extractor")
    opts = bootstrap.Options(
        description="Extract invoice fields",
        author_name=None,
        author_email=None,
        repo_url=None,
        lic=bootstrap.License(kind="mit", spdx="MIT", holder=None, year=2026),
        clean=False,
        dry_run=False,
        use_git=False,
    )

    bootstrap.run(tmp_path, names, opts)

    makefile = (tmp_path / "Makefile").read_text(encoding="utf-8")
    assert "--output invoice_extractor/generated/extract_entities invoice_extractor/methods/extract-entities" in makefile
    assert "codegen check invoice_extractor/generated/extract_entities" in makefile
    assert "widget" not in makefile

    docs = (tmp_path / "docs" / "codegen.md").read_text(encoding="utf-8")
    assert "invoice_extractor/generated/<method>/models.py" in docs
    assert "widget" not in docs


def test_run_rewrites_a_bare_import_to_the_package_form(tmp_path: Path) -> None:
    # `import <package>` is the one import position the character-after heuristic cannot
    # read: nothing follows the token, so the dist rule would claim it and emit
    # `import invoice-extractor`, which is not a legal identifier. The bootstrap then
    # reports success — the no-token-survives assertion only looks for a token that was
    # *not* substituted — over a project whose own tests no longer import.
    bootstrap = load_bootstrap()
    write_template(tmp_path)

    names = bootstrap.Names(dist="invoice-extractor", package="invoice_extractor", title="Invoice Extractor")
    opts = bootstrap.Options(
        description="Extract invoice fields",
        author_name=None,
        author_email=None,
        repo_url=None,
        lic=bootstrap.License(kind="mit", spdx="MIT", holder=None, year=2026),
        clean=False,
        dry_run=False,
        use_git=False,
    )

    bootstrap.run(tmp_path, names, opts)

    fundamentals = (tmp_path / "tests" / "test_fundamentals.py").read_text(encoding="utf-8")
    assert "import invoice_extractor\n" in fundamentals
    assert "Path(invoice_extractor.__file__)" in fundamentals
    assert "invoice-extractor" not in fundamentals


def test_run_rewrites_the_codegen_script_paths(tmp_path: Path) -> None:
    # `scripts/codegen.py` discovers the methods from `<package>/methods`, so a bootstrap that
    # skips `scripts/` leaves `make codegen` reading a directory the rename removed — and because
    # the no-token-survives assertion reads the same file list, it would report success anyway.
    # The paths must take the underscore package form: the dash dist form is not a directory here.
    bootstrap = load_bootstrap()
    write_template(tmp_path)

    names = bootstrap.Names(dist="invoice-extractor", package="invoice_extractor", title="Invoice Extractor")
    opts = bootstrap.Options(
        description="Extract invoice fields",
        author_name=None,
        author_email=None,
        repo_url=None,
        lic=bootstrap.License(kind="mit", spdx="MIT", holder=None, year=2026),
        clean=False,
        dry_run=False,
        use_git=False,
    )

    bootstrap.run(tmp_path, names, opts)

    script = (tmp_path / "scripts" / "codegen.py").read_text(encoding="utf-8")
    assert 'REPO_ROOT / "invoice_extractor/methods"' in script
    assert 'REPO_ROOT / "invoice_extractor/generated"' in script
    assert "invoice-extractor" not in script
    assert "widget" not in script


def test_run_keeps_user_values_that_contain_the_placeholder_word(tmp_path: Path) -> None:
    # The placeholder is an ordinary English word, so a description or a repository
    # URL may carry it legitimately. Both are injected into pyproject.toml; when that
    # happened before the name passes ran, the passes rewrote the user's own value
    # and "A widget/gadget toolkit" came back as "A invoice_extractor/gadget toolkit".
    # The survivor check cannot catch this — it probes the *original* text with
    # neutral names, so no user value ever reaches it.
    bootstrap = load_bootstrap()
    write_template(tmp_path)

    names = bootstrap.Names(dist="invoice-extractor", package="invoice_extractor", title="Invoice Extractor")
    opts = bootstrap.Options(
        description="A widget/gadget toolkit",
        author_name=None,
        author_email=None,
        repo_url="https://widget.example.com/acme",
        lic=bootstrap.License(kind="mit", spdx="MIT", holder=None, year=2026),
        clean=False,
        dry_run=False,
        use_git=False,
    )

    bootstrap.run(tmp_path, names, opts)

    pyproject = (tmp_path / "pyproject.toml").read_text(encoding="utf-8")
    assert 'description = "A widget/gadget toolkit"' in pyproject
    assert 'Repository = "https://widget.example.com/acme"' in pyproject
    # The template's own tokens still resolved, in the same file.
    assert 'name = "invoice-extractor"' in pyproject
    assert 'packages = ["invoice_extractor"]' in pyproject


def test_run_keeps_an_explicit_title_that_contains_the_placeholder_word(tmp_path: Path) -> None:
    # `--title "Acme widget"` is a plausible ask now that the placeholder is an
    # ordinary word. Substituting in sequential passes meant the title pass inserted
    # the title and the dist pass immediately rewrote the lowercase token inside what
    # had just been written, so the README H1 read "# Acme invoice-extractor".
    bootstrap = load_bootstrap()
    write_template(tmp_path)

    names = bootstrap.Names(dist="invoice-extractor", package="invoice_extractor", title="Acme widget")
    opts = bootstrap.Options(
        description="Extract invoice fields",
        author_name=None,
        author_email=None,
        repo_url=None,
        lic=bootstrap.License(kind="mit", spdx="MIT", holder=None, year=2026),
        clean=False,
        dry_run=False,
        use_git=False,
    )

    bootstrap.run(tmp_path, names, opts)

    readme = (tmp_path / "README.md").read_text(encoding="utf-8")
    assert readme.startswith("# Acme widget\n")
    # The command position on the next line is still the dist form.
    assert "`invoice-extractor extract-entities`" in readme


def test_run_leaves_the_bootstraps_own_test_file_alone(tmp_path: Path) -> None:
    # This file's fixtures *are* the placeholder: `validate_package("widget_tools")`
    # has to raise, so substituting the token turns a passing test into DID NOT RAISE.
    # Step 5 of SKILL.md runs `make agent-test` before Step 6 removes the skill, so
    # sweeping this file left every bootstrap ending on a red gate the user neither
    # caused nor could fix. It is deleted with the script it loads instead.
    bootstrap = load_bootstrap()
    write_template(tmp_path)

    names = bootstrap.Names(dist="invoice-extractor", package="invoice_extractor", title="Invoice Extractor")
    opts = bootstrap.Options(
        description="Extract invoice fields",
        author_name=None,
        author_email=None,
        repo_url=None,
        lic=bootstrap.License(kind="mit", spdx="MIT", holder=None, year=2026),
        clean=False,
        dry_run=False,
        use_git=False,
    )

    bootstrap.run(tmp_path, names, opts)

    own_test = (tmp_path / "tests" / "unit" / "test_bootstrap_script.py").read_text(encoding="utf-8")
    assert own_test == 'bootstrap.validate_package("widget_tools")\n'
    # A sibling under tests/ is still swept — the exclusion is this one file.
    assert "from invoice_extractor.cli import app" in (tmp_path / "tests" / "test_cli.py").read_text(encoding="utf-8")


def test_survivor_check_still_rejects_unhandled_template_tokens(tmp_path: Path) -> None:
    bootstrap = load_bootstrap()
    # A bare `widget` word inside prose (not quoted-exact, not in package position)
    # is a shape the pyproject transform refuses to guess at — it must survive
    # the substitution pass and abort the bootstrap.
    write_template(tmp_path, extra_pyproject='custom = "run widget somewhere"\n')

    names = bootstrap.Names(dist="invoice-extractor", package="invoice_extractor", title="Invoice Extractor")
    opts = bootstrap.Options(
        description="Extract invoice fields",
        author_name=None,
        author_email=None,
        repo_url=None,
        lic=bootstrap.License(kind="mit", spdx="MIT", holder=None, year=2026),
        clean=False,
        dry_run=True,
        use_git=False,
    )

    with pytest.raises(SystemExit) as exc_info:
        bootstrap.run(tmp_path, names, opts)

    assert 'custom = "run widget somewhere"' in str(exc_info.value)


def test_the_template_carries_no_maintenance_of_its_own() -> None:
    # Every file of this directory reaches every project made from the template, so Pipelex's own
    # maintenance — its contributor agreement, its branch-flow guard, its release checks and its
    # release skill — lives at the root of the repository the template is developed in, never here.
    # A workflow guarded to one repository is the shape that maintenance took when it lived here,
    # and the CLA assistant reached projects made from the template that way.
    for workflow in sorted((ROOT / WORKFLOWS_DIR).glob("*.y*ml")):
        text = workflow.read_text(encoding="utf-8")
        assert "github.repository ==" not in text, (
            f"{workflow.name} is guarded to one repository, so it is maintenance and belongs at the repository root"
        )
    assert not (ROOT / ".claude" / "skills" / "release").exists(), "the template's release is the repository root's, not a project's"
