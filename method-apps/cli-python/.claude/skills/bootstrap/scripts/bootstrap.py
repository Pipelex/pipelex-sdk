#!/usr/bin/env python3
"""Turn the pipelex-method-cli-python template into a real project.

This is the deterministic engine behind the `/bootstrap` skill, and the step of `make create` that
names the project. It does the mechanical, error-prone part, so that the skill, the gesture and the
person can concentrate on good inputs and on checking the result:

- the project's three names, from one: the distribution and the console script take the name as
  given (`receipt-review`), and the import package takes it with its dashes as underscores
  (`receipt_review`). The package directory under `src/` is renamed with a plain filesystem move,
  never `git mv`, so it works before `git init`, and the template's identifier is rewritten in every
  file a project keeps, `.gitattributes` and the Makefile included;
- the description, in `pyproject.toml` and on `CLAUDE.md`'s description line;
- the version, reset to 0.1.0, with `CHANGELOG.md` restarted to match;
- the license, the author and the repository URL;
- the README, which is rendered whole rather than renamed: the template's README is about the
  template, and a token pass over it would rewrite prose and links that are not about the project.

A project does not inherit what only the template needs. The files of that kind are removed whole
(`REMOVALS`: the `make create` gesture with its planning code, its tests, their fixtures and its
doc), and the passages of the files a project keeps that describe them sit between
`template-only:begin` and `template-only:end` marker lines, which are removed with everything
between them, in every file that carries a pair.

Everything is planned in memory first, and nothing is written until every transform has run and a
survivor check has passed: no file the project keeps may still name the template, the gesture or a
marker, which would be a transform rule that missed a context. Every Python file it writes then goes
through the project's own ruff, so that `make check` is green straight after a run.

The script only transforms files. It does not touch git, re-sync `uv.lock`, run the checks or remove
the bootstrap skill: the skill's `SKILL.md` sequences those, or `make create` does. Re-running it on
a project that is not the un-bootstrapped template requires `--force`. It needs nothing beyond the
standard library, ruff when it is installed, and `packaging` to check an SPDX identifier when that is
installed too.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime
import io
import keyword
import os
import re
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import NoReturn

# The template's identity, in its two spellings.
TEMPLATE_NAME = "pipelex-method-cli-python"  # the distribution and the console script
TEMPLATE_PACKAGE = "pipelex_method_cli_python"  # the import package, under src/
# The template's home: its directory in the pipelex-sdk repository.
TEMPLATE_URL = "https://github.com/Pipelex/pipelex-sdk/tree/main/method-apps/cli-python"

# A fresh project restarts here: pyproject.toml and CHANGELOG.md must agree.
RESET_VERSION = "0.1.0"

# CLAUDE.md's one-line description, which the project's own description replaces.
CLAUDE_DESCRIPTION = (
    "A command-line tool that runs one MTHDS method through the [Pipelex](https://pipelex.com) API with "
    "[`pipelex-sdk`](https://pypi.org/project/pipelex-sdk/), printing the method's result as JSON on stdout."
)

# CLAUDE.md's charter paragraph, stripped by --clean.
CHARTER_MARKER = "This directory is a **template**."

# What the template carries for itself and a project does not: `make create` turns the template into
# a project, once, which is this run, so the gesture goes with everything only it uses. The bootstrap
# skill itself is not listed: it is removed last, by `make create` or by the skill's own last step,
# once the checks are green.
REMOVALS = [
    "scripts/create.py",
    "scripts/create_plan.py",
    "docs/create.md",
    "tests/test_create.py",
    "tests/test_create_plan.py",
    "tests/test_create_tree.py",
    "tests/test_bootstrap.py",
    "tests/support_create.py",
    "tests/fixtures/bundles",
    "tests/fixtures/recorded",
]

# The bootstrap skill's own directory, which no transform reads and the survivor check skips.
BOOTSTRAP_DIR = ".claude/skills/bootstrap"

# The markers around a template-only passage of a file a project keeps. A line holding either one is a
# marker line, whatever comment syntax surrounds it.
TEMPLATE_ONLY_BEGIN = "template-only:begin"
TEMPLATE_ONLY_END = "template-only:end"

# What must not survive in a file a project keeps: the template's names, the gesture, and a marker.
SURVIVORS = re.compile(r"pipelex-method-cli-python|pipelex_method_cli_python|make create|scripts/create|scripts\.create|create_plan|template-only:")

# The name a project takes: lowercase, starting with a letter, words joined by single dashes or
# underscores. It is the distribution and the console script as given, and the import package with
# its dashes as underscores, which must be an identifier.
NAME_RE = re.compile(r"[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*")
NAME_MAX_LENGTH = 64

# Import names a project's package must not take: the project's own top-level packages, and those of
# its dependencies, which a package of the same name under src/ would shadow.
RESERVED_PACKAGES = frozenset(
    {
        "scripts",
        "tests",
        "src",
        "dotenv",
        "httpx",
        "mthds",
        "pipelex",
        "pipelex_sdk",
        "pydantic",
        "pydantic_core",
        "pyright",
        "pytest",
        "pytest_asyncio",
        "rich",
        "ruff",
        "typer",
        "click",
        "hatchling",
    }
)

# Directories the sweep never enters, wherever they are: version control, environments, caches and
# build output, and the local files a run or a person leaves.
SKIPPED_DIRS = frozenset(
    {".git", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", "node_modules", "dist", "build", "outputs"} | {".pipelex", "wip"}
)

# Files the sweep never reads: the lock file, which `uv sync` re-syncs after the rename, and a
# person's local settings and secrets.
SKIPPED_FILES = frozenset({"uv.lock", ".claude/settings.local.json"})


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Names
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Names:
    """The project's names, all derived from the one given."""

    name: str  # the distribution and the console script, e.g. "receipt-review"
    package: str  # the import package, e.g. "receipt_review"
    title: str  # the human-facing title, e.g. "Receipt Review"


def package_of(name: str) -> str:
    return name.replace("-", "_")


def title_from_name(name: str) -> str:
    """`receipt-review` is `Receipt Review`."""
    return " ".join(part[:1].upper() + part[1:] for part in re.split(r"[-._]+", name) if part)


def name_refusal(name: str) -> str | None:
    """Why a name cannot be the project's, or `None` when it can."""
    if NAME_RE.fullmatch(name) is None or len(name) > NAME_MAX_LENGTH:
        return (
            f"invalid project name {name!r}: use lowercase letters and digits, starting with a letter, with words joined by "
            f"single dashes or underscores, at most {NAME_MAX_LENGTH} characters (e.g. 'invoice-extractor')."
        )
    package = package_of(name)
    if TEMPLATE_PACKAGE in package:
        return f"invalid project name {name!r}: it is, or contains, the template's own name."
    if keyword.iskeyword(package) or keyword.issoftkeyword(package):
        return f"invalid project name {name!r}: its package, {package}, is a Python keyword."
    if package in sys.stdlib_module_names:
        return f"invalid project name {name!r}: its package, {package}, would shadow the standard library's module of that name."
    if package in RESERVED_PACKAGES:
        return f"invalid project name {name!r}: its package, {package}, would shadow the project's own {package} or a dependency's."
    return None


# ---------------------------------------------------------------------------
# License
# ---------------------------------------------------------------------------

PROPRIETARY_LICENSE = """Copyright (c) {year} {holder}

All rights reserved.

This software and its associated documentation (the "Software") are the
proprietary and confidential property of {holder}. Unauthorized copying,
distribution, modification, public display, or use of the Software, in whole or
in part, via any medium, is strictly prohibited without the express prior
written permission of {holder}.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
"""

OTHER_LICENSE = """Copyright (c) {year} {holder}

This project is licensed under the {spdx} license.

Replace this file with the full text of the {spdx} license — you can obtain it
from https://spdx.org/licenses/{spdx}.html
"""

PROPRIETARY_ALIASES = frozenset({"proprietary", "all-rights-reserved", "all rights reserved", "unlicensed", "licenseref-proprietary"})


@dataclass(frozen=True)
class License:
    """The license choice, in the forms the call sites need.

    `kind` decides the LICENSE body; `spdx` is `pyproject.toml`'s `license`, an SPDX expression that
    uv validates, so a proprietary project takes a `LicenseRef-` one; `holder` and `year` fill the
    copyright notice.
    """

    kind: str  # "mit" | "proprietary" | "other"
    spdx: str
    holder: str | None
    year: int


def canonical_spdx(value: str) -> str:
    """An SPDX expression in its canonical spelling, checked when `packaging` is installed, as it is in a project's environment."""
    try:
        from packaging.licenses import InvalidLicenseExpression, canonicalize_license_expression
    except ImportError:
        return value
    try:
        return str(canonicalize_license_expression(value))
    except InvalidLicenseExpression:
        fail(f"invalid --license {value!r}: not an SPDX license expression (e.g. 'Apache-2.0'), nor mit or proprietary.")


def resolve_license(value: str | None, holder: str | None, year: int) -> License:
    norm = (value or "mit").strip().lower()
    if norm in ("", "mit"):
        return License(kind="mit", spdx="MIT", holder=holder, year=year)
    if norm in PROPRIETARY_ALIASES:
        return License(kind="proprietary", spdx="LicenseRef-Proprietary", holder=holder, year=year)
    # Anything else is an SPDX expression (e.g. Apache-2.0): the field is set and a stub written,
    # since no license text can be authored here.
    return License(kind="other", spdx=canonical_spdx((value or "").strip()), holder=holder, year=year)


# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Options:
    description: str
    author_name: str | None
    author_email: str | None
    repo_url: str | None
    lic: License
    clean: bool
    dry_run: bool
    force: bool
    date: str


# The neutral values the survivor check transforms with, so that a user's own title or description
# naming the template or the gesture can never be mistaken for a rule that missed a context.
PROBE_NAMES = Names(name="probe-project", package="probe_project", title="Probe Project")


def probe_options(opts: Options) -> Options:
    return replace(opts, description="A probe description.", author_name=None, author_email=None, repo_url=None)


# ---------------------------------------------------------------------------
# File transforms
# ---------------------------------------------------------------------------

_TOKENS = re.compile(rf"{TEMPLATE_PACKAGE}|{TEMPLATE_NAME}")


def apply_name_tokens(text: str, names: Names) -> str:
    """Rewrite the template's two names in one scan, so that nothing a replacement writes is read again."""
    return _TOKENS.sub(lambda match: names.package if match.group(0) == TEMPLATE_PACKAGE else names.name, text)


def strip_template_only(text: str, rel: str, *, required: bool) -> str:
    """Remove every template-only passage: each marker line and everything between a begin and its end.

    A blank line left doubled by a removal is collapsed, so a file no formatter touches stays tidy.
    `required` warns when the file carries no passage, which for a file known to carry one means it
    was stripped already.
    """
    lines = text.splitlines(keepends=True)
    kept: list[str] = []
    inside = False
    blocks = 0
    collapse = False
    for line in lines:
        if inside:
            if TEMPLATE_ONLY_END in line:
                inside = False
                collapse = True
            continue
        if TEMPLATE_ONLY_BEGIN in line:
            inside = True
            blocks += 1
            continue
        if collapse and not line.strip() and (not kept or not kept[-1].strip()):
            collapse = False
            continue
        collapse = False
        kept.append(line)
    if inside:
        warn(f"{rel}: a template-only passage is never closed; left as-is.")
        return text
    if blocks == 0 and required:
        warn(f"{rel}: no template-only passage found (already stripped?); skipped.")
    return "".join(kept)


def toml_str(value: str) -> str:
    """A TOML basic string, quotes included, so that a value holding a quote or a backslash stays valid TOML."""
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f'"{escaped}"'


def _replace_key(text: str, key: str, value: str, rel: str) -> str:
    """Set the first `key = "…"` line of `[project]` to `value`, a TOML string already rendered."""
    pattern = re.compile(rf"^{key} = .*$", re.MULTILINE)
    if pattern.search(text) is None:
        warn(f"{rel}: no `{key} = …` line found; left as-is.")
        return text
    return pattern.sub(lambda _match: f"{key} = {value}", text, count=1)


def transform_pyproject(text: str, names: Names, opts: Options) -> str:
    """`pyproject.toml`, edited key by key: the names first, then every value the person gave.

    The names go first, since a user's own description may name the template legitimately; written
    after, it is never read again by the token pass.
    """
    text = strip_template_only(apply_name_tokens(text, names), "pyproject.toml", required=False)
    text = _replace_key(text, "version", toml_str(RESET_VERSION), "pyproject.toml")
    text = _replace_key(text, "description", toml_str(opts.description), "pyproject.toml")
    text = _replace_key(text, "license", toml_str(opts.lic.spdx), "pyproject.toml")
    author = None
    if opts.author_name and opts.author_email:
        author = f"{{ name = {toml_str(opts.author_name)}, email = {toml_str(opts.author_email)} }}"
    elif opts.author_name:
        author = f"{{ name = {toml_str(opts.author_name)} }}"
    if author is not None:
        text = re.sub(r"^(license = .*)$", lambda match: f"{match.group(1)}\nauthors = [{author}]", text, count=1, flags=re.MULTILINE)
    if opts.repo_url:
        urls = f"[project.urls]\nRepository = {toml_str(opts.repo_url)}\n\n"
        if "\n[project.scripts]" in text:
            text = text.replace("\n[project.scripts]", f"\n{urls}[project.scripts]", 1)
        else:
            warn("pyproject.toml: no [project.scripts] table to place [project.urls] before; the repository URL is not set.")
    return text


def license_line(lic: License) -> str:
    if lic.kind == "proprietary":
        return "This project is proprietary — all rights reserved. See the [LICENSE](LICENSE) file."
    label = "MIT" if lic.kind == "mit" else lic.spdx
    return f"This project is licensed under the [{label} license](LICENSE)."


def render_readme(_text: str, names: Names, opts: Options) -> str:
    """The project's own README, written whole: nothing of the template's is kept but the line saying where it came from."""
    command = names.name
    package = names.package
    paragraphs = [
        f"# {names.title}",
        opts.description,
        (
            "A command-line tool that runs one [MTHDS](https://mthds.ai) method through the [Pipelex](https://pipelex.com) API, "
            "printing the method's result as JSON on stdout and everything else on stderr. "
            f"It was created from the [`cli-python`]({TEMPLATE_URL}) template of the Pipelex method apps."
        ),
        "## Run it",
        (
            "```bash\n"
            "make install                        # once: the project and its tools into .venv\n"
            f"{f'.venv/bin/{command} --help':<35} # every input of the method, as an option\n"
            "```"
        ),
        (
            f"`uv tool install .` puts `{command}` on your `PATH`. The command reads `PIPELEX_API_KEY` and `PIPELEX_BASE_URL` "
            "from the shell, or from a `.env` file in the directory it runs from or above it, the shell winning; "
            "`.env.example` lists both."
        ),
        (
            "A run is followed here by default: its id is printed on stderr at once, and Ctrl-C leaves it going on the server "
            "and prints the `--resume` command that picks it up again. `--blocking` runs it in one request instead, "
            "`--detach` prints its id alone and returns, `--inputs FILE` takes the inputs as one JSON object "
            "(`--inputs-template` prints it to fill in), and the files the method produces are saved under `outputs/<run-id>/`. "
            "[`docs/cli-kernel.md`](docs/cli-kernel.md) and [`docs/run-lifecycle.md`](docs/run-lifecycle.md) describe each."
        ),
        "## Work on it",
        "\n".join(
            (
                f"- **The method** is in `src/{package}/method/`: its `.mthds` files, or a `method.json` naming it by catalog id "
                f"or published address. After editing it, or bumping its tag, run `make codegen` and commit the regenerated "
                f"`src/{package}/generated/` tree with the edit; `make check` fails until you do.",
                f"- **`src/{package}/binding.py`** names the pipe the command runs and the model its output is checked against; it is yours to edit.",
                "- **Before committing**, run `make all`: ruff, pyright in strict mode, the offline codegen check, the tests and the build.",
            )
        ),
        "## Documentation",
        "\n".join(
            (
                "- [`docs/cli-kernel.md`](docs/cli-kernel.md): the options derived from the method's inputs, and what each value puts on the wire.",
                "- [`docs/run-lifecycle.md`](docs/run-lifecycle.md): the run modes, Ctrl-C, the downloads and the exit codes.",
                "- [`docs/codegen.md`](docs/codegen.md): the generated tree and the checks that keep it current.",
                "- [`docs/ci.md`](docs/ci.md): what the workflows check.",
                "- [`CLAUDE.md`](CLAUDE.md): the project guide for coding agents.",
            )
        ),
        "## License",
        f"{license_line(opts.lic)} Runtime dependencies are distributed under their own licenses via PyPI.",
    ]
    return "\n\n".join(paragraphs) + "\n"


def strip_charter(text: str) -> str:
    """Remove CLAUDE.md's charter paragraph.

    A created project is no longer a template, and the paragraph would steer every agent session
    toward maintaining one.
    """
    start = text.find(CHARTER_MARKER)
    if start == -1:
        warn("CLAUDE.md: template charter paragraph not found (already stripped?); skipped.")
        return text
    end = re.search(r"\r?\n\r?\n", text[start:])
    if end is None:
        warn("CLAUDE.md: template charter paragraph has no end boundary; left as-is.")
        return text
    return text[:start] + text[start + end.end() :]


def transform_claude_md(text: str, names: Names, opts: Options) -> str:
    text = strip_template_only(text, "CLAUDE.md", required=True)
    if CLAUDE_DESCRIPTION in text:
        text = text.replace(CLAUDE_DESCRIPTION, opts.description, 1)
    else:
        warn("CLAUDE.md: template description line not found; left as-is.")
    if opts.clean:
        text = strip_charter(text)
    return apply_name_tokens(text, names)


def transform_license(text: str, opts: Options) -> str:
    lic = opts.lic
    if lic.kind == "mit":
        if "Permission is hereby granted" not in text:
            warn("LICENSE does not look like the MIT text (license changed on a previous run?) — pyproject.toml will say MIT; fix LICENSE manually.")
        # The MIT text stays; the copyright line is refreshed only for a holder to put there.
        if lic.holder:
            line = re.compile(r"Copyright \(c\) \d{4} .*")
            if line.search(text):
                text = line.sub(lambda _match: f"Copyright (c) {lic.year} {lic.holder}", text, count=1)
            else:
                warn("LICENSE: copyright line not found; left as-is.")
        else:
            warn("LICENSE copyright line left untouched — pass --license-holder to claim it.")
        return text
    holder = lic.holder or "<COPYRIGHT HOLDER>"
    if not lic.holder:
        warn("no --license-holder given; LICENSE gets a placeholder holder.")
    if lic.kind == "proprietary":
        return PROPRIETARY_LICENSE.replace("{year}", str(lic.year)).replace("{holder}", holder)
    warn(f"LICENSE becomes a stub for '{lic.spdx}' (SPDX identifiers are case-sensitive, e.g. Apache-2.0). Replace it with the full license text.")
    return OTHER_LICENSE.replace("{year}", str(lic.year)).replace("{holder}", holder).replace("{spdx}", lic.spdx)


def reset_changelog(_text: str, opts: Options) -> str:
    """The project's history starts at the reset version: the template's changelog is the template's."""
    return f"""# Changelog

## [v{RESET_VERSION}] - {opts.date}

### Added

- Initial project, created from the [`cli-python`]({TEMPLATE_URL}) template of the Pipelex method apps
"""


def transform_generic(text: str, rel: str, names: Names) -> str:
    """Any other file a project keeps: its template-only passages stripped, and the template's names rewritten."""
    if TEMPLATE_ONLY_BEGIN in text or TEMPLATE_ONLY_END in text:
        text = strip_template_only(text, rel, required=False)
    return apply_name_tokens(text, names)


Transform = Callable[[str, Names, Options], str]

TARGETS: dict[str, Transform] = {
    "pyproject.toml": transform_pyproject,
    "README.md": render_readme,
    "CLAUDE.md": transform_claude_md,
    "AGENTS.md": lambda text, names, _opts: apply_name_tokens(strip_template_only(text, "AGENTS.md", required=True), names),
    "Makefile": lambda text, names, _opts: apply_name_tokens(strip_template_only(text, "Makefile", required=True), names),
    "LICENSE": lambda text, _names, opts: transform_license(text, opts),
    "CHANGELOG.md": lambda text, _names, opts: reset_changelog(text, opts),
}


def transform_for(rel: str, text: str, names: Names, opts: Options) -> str:
    target = TARGETS.get(rel)
    if target is not None:
        return target(text, names, opts)
    return transform_generic(text, rel, names)


# ---------------------------------------------------------------------------
# The tree
# ---------------------------------------------------------------------------


def is_removed(rel: str) -> bool:
    return any(rel == removal or rel.startswith(f"{removal}/") for removal in REMOVALS)


def is_skipped(rel: str) -> bool:
    """Whether the sweep leaves a file alone: the method and its generated tree, the bootstrap itself, and local files."""
    parts = rel.split("/")
    if any(part in SKIPPED_DIRS or part.endswith(".egg-info") for part in parts[:-1]):
        return True
    if rel in SKIPPED_FILES or rel == BOOTSTRAP_DIR or rel.startswith(f"{BOOTSTRAP_DIR}/"):
        return True
    if parts[-1].startswith(".env") and parts[-1] != ".env.example":
        return True
    # The method's sources are the person's, and the generated tree is stamped: neither is rewritten.
    return len(parts) > 3 and parts[0] == "src" and parts[2] in ("method", "generated")


def kept_text_files(root: Path) -> list[tuple[str, str]]:
    """Every UTF-8 file of the tree a project keeps, as its POSIX path relative to the root and its text."""
    found: list[tuple[str, str]] = []
    for directory, subdirs, files in os.walk(root):
        relative_dir = Path(directory).relative_to(root).as_posix()
        prefix = "" if relative_dir == "." else f"{relative_dir}/"
        subdirs[:] = sorted(d for d in subdirs if d not in SKIPPED_DIRS and not os.path.islink(os.path.join(directory, d)))
        for file in sorted(files):
            rel = f"{prefix}{file}"
            path = Path(directory) / file
            if is_skipped(rel) or is_removed(rel) or path.is_symlink():
                continue
            try:
                with path.open(encoding="utf-8", newline="") as handle:
                    found.append((rel, handle.read()))
            except (UnicodeDecodeError, OSError):
                continue
    return found


def moved(rel: str, names: Names) -> str:
    """Where a file lands once the package directory is renamed."""
    prefix = f"src/{TEMPLATE_PACKAGE}/"
    return f"src/{names.package}/{rel[len(prefix) :]}" if rel.startswith(prefix) else rel


def format_python(root: Path, files: list[str]) -> None:
    """Sort the imports and format the Python files written, with the project's own ruff and settings."""
    if not files:
        return
    for command in (["check", "--select", "I", "--fix", "--quiet", "--exit-zero"], ["format", "--quiet"]):
        try:
            result = subprocess.run([sys.executable, "-m", "ruff", *command, *files], cwd=root, capture_output=True, text=True, check=False)
        except OSError:
            result = None
        if result is None or result.returncode != 0:
            detail = "" if result is None else (result.stderr.strip() or result.stdout.strip())
            warn(f"ruff could not format the Python files written{f' ({detail})' if detail else ''}; run `make format`.")
            return


def run(root: Path, names: Names, opts: Options) -> None:
    # Guard: confirm this is the un-bootstrapped template before anything is rewritten. In a wrong
    # directory or an already-bootstrapped project, proceeding would clobber that project's version,
    # changelog and identity. --force is the explicit opt-in for a confirmed re-run.
    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        fail(f"no pyproject.toml found in {root} — run this from the project root.")
    try:
        current = tomllib.loads(pyproject.read_text(encoding="utf-8")).get("project", {}).get("name")
    except tomllib.TOMLDecodeError as exc:
        fail(f"pyproject.toml is not valid TOML: {exc}")
    if current != TEMPLATE_NAME:
        if not opts.force:
            fail(
                f'pyproject.toml\'s name is not "{TEMPLATE_NAME}" — this does not look like the un-bootstrapped template. Pass --force '
                "only if you really mean to re-bootstrap this project (the changelog and the README will be rewritten again)."
            )
        warn(f'pyproject.toml\'s name is not "{TEMPLATE_NAME}"; proceeding (--force).')

    old_package = root / "src" / TEMPLATE_PACKAGE
    new_package = root / "src" / names.package
    rename = old_package.is_dir() and old_package != new_package
    if rename and (new_package.exists() or new_package.is_symlink()):
        fail(f"src/{names.package} already exists, so src/{TEMPLATE_PACKAGE} cannot be renamed to it.")

    print(f"Bootstrapping template -> {names.title!r}")
    print(f"  name={names.name}  package={names.package}  title={names.title}  license={opts.lic.spdx}")
    if opts.dry_run:
        print("  (dry run — no files will be modified)")
    print()

    # Transform everything in memory first and write second: a transform that throws, or a survivor
    # the check below finds, must not leave a half-applied tree.
    edits: list[tuple[str, str]] = []
    survivors: list[str] = []
    for rel, original in kept_text_files(root):
        updated = transform_for(rel, original, names, opts)
        target = moved(rel, names) if rename else rel
        if updated != original:
            edits.append((target, updated))
        # The probe's warnings would repeat the real transform's, so they are not printed.
        with contextlib.redirect_stderr(io.StringIO()):
            probe = transform_for(rel, original, PROBE_NAMES, probe_options(opts))
        survivors.extend(
            f"{rel}:{number}: {line.strip()}" for number, line in enumerate(probe.splitlines(), start=1) if SURVIVORS.search(line) is not None
        )
    if survivors:
        joined = "\n  ".join(survivors)
        fail(f"the template's name, the create gesture or a marker would survive the bootstrap in these lines:\n  {joined}")
    removals = [rel for rel in REMOVALS if (root / rel).exists()]

    print("Edits:")
    if rename:
        print(f"  {'move  ' if opts.dry_run else 'moved '}  src/{TEMPLATE_PACKAGE}/ -> src/{names.package}/")
        if not opts.dry_run:
            os.rename(old_package, new_package)
    for rel, updated in edits:
        if opts.dry_run:
            print(f"  edit    {rel}")
        else:
            with (root / rel).open("w", encoding="utf-8", newline="") as handle:
                handle.write(updated)
            print(f"  edited  {rel}")
    for rel in removals:
        path = root / rel
        shown = f"{rel}/" if path.is_dir() else rel
        if opts.dry_run:
            print(f"  remove  {shown}")
        else:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
            print(f"  removed {shown}")
    if not edits and not removals and not rename:
        print("  (no content changes)")
    if not opts.dry_run:
        format_python(root, [rel for rel, _ in edits if rel.endswith(".py") and (root / rel).is_file()])
    print()
    would = "would be " if opts.dry_run else ""
    print(f"Done. {len(edits)} file(s) {would}edited, {len(removals)} template-only path(s) {would}removed.")
    if not opts.dry_run:
        print("\nNext: re-sync uv.lock and the environment, which name the project, and run the gates:")
        print("  uv sync && make all")
        print("Then review with `git status` and `git diff` before committing.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        fail(message)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = _Parser(prog="bootstrap.py", description="Turn the template into a project named after its method.", allow_abbrev=False)
    parser.add_argument("--name", required=True, help="The project's name, e.g. invoice-extractor: the distribution and the console script")
    parser.add_argument("--title", help="The project's title (default: the name, title-cased)")
    parser.add_argument("--description", required=True, help="A one-line description of the project")
    parser.add_argument("--author-name", help="The author named in pyproject.toml")
    parser.add_argument("--author-email", help="The author's email, with --author-name")
    parser.add_argument("--repo-url", help="The project's repository URL")
    parser.add_argument("--license", help="mit (the default), proprietary, or an SPDX identifier such as Apache-2.0")
    parser.add_argument("--license-holder", help="The copyright holder named in LICENSE")
    parser.add_argument("--license-year", help="The copyright year (default: the current year)")
    parser.add_argument("--root", default=".", help="The project's root (default: the current directory)")
    parser.add_argument("--clean", action="store_true", help="Strip CLAUDE.md's template charter paragraph")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan and change nothing")
    parser.add_argument("--force", action="store_true", help="Run on a project that is not the un-bootstrapped template")
    # A value that looks like the next flag almost certainly means the real one was dropped, and the
    # flag would be swallowed: `--description --dry-run` turning a rehearsal into a real run.
    for index, arg in enumerate(argv[:-1]):
        if arg.startswith("--") and arg not in ("--clean", "--dry-run", "--force") and argv[index + 1].startswith("--"):
            fail(f"missing value for {arg}")
    return parser.parse_args(argv)


def one_line(value: str, flag: str) -> str:
    text = value.strip()
    if not text:
        fail(f"{flag} is empty")
    if "\n" in text or "\r" in text:
        fail(f"{flag} must be one line")
    return text


def main(argv: list[str]) -> None:
    args = parse_args(argv)
    name = args.name.strip()
    refusal = name_refusal(name)
    if refusal is not None:
        fail(refusal)
    title = one_line(args.title if args.title is not None else title_from_name(name), "--title")
    description = one_line(args.description, "--description")

    raw_year = (args.license_year or "").strip()
    if args.license_year is not None and re.fullmatch(r"\d{4}", raw_year) is None:
        fail(f"invalid --license-year {args.license_year!r} (expected e.g. 2026)")
    year = int(raw_year) if raw_year else datetime.date.today().year
    holder = (args.license_holder or "").strip() or None
    if holder is not None:
        holder = one_line(holder, "--license-holder")
    lic = resolve_license(args.license, holder, year)

    author_name = (args.author_name or "").strip() or None
    author_email = (args.author_email or "").strip() or None
    if author_email and not author_name:
        fail("--author-email given without --author-name — provide the author's name too.")
    repo_url = (args.repo_url or "").strip().rstrip("/") or None
    for value, flag in ((author_name, "--author-name"), (author_email, "--author-email"), (repo_url, "--repo-url")):
        if value is not None:
            one_line(value, flag)

    opts = Options(
        description=description,
        author_name=author_name,
        author_email=author_email,
        repo_url=repo_url,
        lic=lic,
        clean=args.clean,
        dry_run=args.dry_run,
        force=args.force,
        date=datetime.date.today().isoformat(),
    )
    run(Path(args.root).resolve(), Names(name=name, package=package_of(name), title=title), opts)


if __name__ == "__main__":
    main(sys.argv[1:])
