"""`make codegen-check`: say, offline, whether the package's `generated/` tree is current with its method.

No key, no network and no engine: it is part of `make check`, so it runs on every clone and in CI.
A tree is current when three things hold:

- the SDK's `run_codegen_check` finds every artifact `codegen.lock` signs at its signed hash, and no
  stamped file the lock does not track (an orphan);
- `sources.json` records the hash of every source in `method/` as it is on disk now, so an edited
  bundle or manifest is a stale source even though the tree still matches its lock;
- `sources.json` records the hash of each file the codegen writes itself (`contracts.json`,
  `__init__.py`) as it is now, so a hand edit to one is caught though no lock signs it.

The exit code is the verdict: `0` current, `1` drift or a stale source, `2` no verdict at all (a lock
missing or unreadable, a symbolic link, a manifest that names no method). The codes of everything
checked are folded by precedence, no verdict over drift over current, and a summary line counts them.

**The template as shipped holds no method and no tree, and that is current**: there is nothing to be
out of step with, as `webapp-js`'s check answers for an empty `methods/`, so `make check` is green on
it. A method with no tree is drift (run `make codegen`); a tree with no method behind it is drift too,
since regeneration never removes a whole tree.

The ported module is `webapp-js`'s `scripts/lib/check.mts`.
"""

import sys
from dataclasses import dataclass

from pipelex_sdk.codegen_check import run_codegen_check
from pipelex_sdk.errors import CodegenLockError

from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.contracts import LOCK_FILENAME, SOURCES_SIDECAR
from scripts.codegen_shared import (
    DERIVED_ARTIFACTS,
    PACKAGE_LAYOUT,
    REGENERATE,
    CodegenSetupError,
    CodegenSource,
    Layout,
    NonUtf8FileError,
    SymlinkRefusedError,
    compare_sidecar,
    discover_source,
    read_text_file,
    walk,
)

#: The tree is current with its method.
EXIT_CURRENT = 0

#: The tree drifted from its lock, or a source or a derived file changed since it was generated.
EXIT_DRIFT = 1

#: There is no verdict: a lock missing or unreadable, a link, or a method that cannot be read.
EXIT_NO_VERDICT = 2


@dataclass(frozen=True)
class VerdictSummary:
    """How many verdicts of each kind a run reached, and the exit code they fold into."""

    current: int
    drift: int
    no_verdict: int
    exit: int


def summarize_verdicts(codes: list[int]) -> VerdictSummary:
    """Count the verdicts and fold them by precedence: no verdict outranks drift, which outranks current."""
    current = sum(1 for code in codes if code == EXIT_CURRENT)
    drift = sum(1 for code in codes if code == EXIT_DRIFT)
    no_verdict = len(codes) - current - drift
    exit_code = EXIT_NO_VERDICT if no_verdict else EXIT_DRIFT if drift else EXIT_CURRENT
    return VerdictSummary(current=current, drift=drift, no_verdict=no_verdict, exit=exit_code)


def _fail(lines: list[str]) -> None:
    for line in lines:
        print(line, file=sys.stderr)


def tree_files(layout: Layout) -> list[str] | None:
    """The files of the generated tree, dotfiles aside, or `None` when there is no tree at all.

    Raises:
        SymlinkRefusedError: The tree or something under it is a link or a special file.
    """
    if not layout.generated_dir.exists() and not layout.generated_dir.is_symlink():
        return None
    files = [path for path in walk(layout.generated_dir, layout) if not path.rsplit("/", 1)[-1].startswith(".")]
    return files or None


def check_tree(source: CodegenSource, layout: Layout) -> int:
    """Check the tree against its lock and its sidecar, print the verdict, and return its exit code."""
    out_dir = layout.generated_dir
    where = layout.describe(out_dir)
    try:
        files = tree_files(layout)
    except SymlinkRefusedError as exc:
        _fail([f"\n✗ {exc}"])
        return EXIT_NO_VERDICT
    if files is None:
        _fail([f"\n✗ no generated tree at {where}/", f"    {REGENERATE}"])
        return EXIT_DRIFT
    if LOCK_FILENAME not in files:
        _fail([f"\n✗ no {LOCK_FILENAME} in {where}/, so there is no verdict.", f"    Found: {', '.join(files)}", f"    {REGENERATE}"])
        return EXIT_NO_VERDICT
    for name in (*DERIVED_ARTIFACTS, SOURCES_SIDECAR):
        if name in files:
            try:
                read_text_file(out_dir / name, layout)
            except NonUtf8FileError as exc:
                _fail([f"\n✗ {exc}", f"    {REGENERATE}"])
                return EXIT_DRIFT
    try:
        report = run_codegen_check(root=out_dir)
    except CodegenLockError as exc:
        _fail([f"\n✗ {where}/: {exc}"])
        return EXIT_NO_VERDICT
    stale = compare_sidecar(out_dir, source.source_hashes, layout)
    if not report.drifts and not stale:
        fingerprint = (report.crate_fingerprint or "?")[:12]
        print(f"\n✓ {where}/ current with {source.describe()}  (crate {fingerprint}, engine {report.engine_version})", flush=True)
        return EXIT_CURRENT
    lines = [f"\n✗ {where}/"]
    lines.extend(f"    {drift.category}: {drift.path} — {drift.detail}" for drift in report.drifts)
    lines.extend(f"    {line}" for line in stale)
    lines.append(f"    {REGENERATE}")
    _fail(lines)
    return EXIT_DRIFT


def run_check(layout: Layout = PACKAGE_LAYOUT) -> int:
    """The whole `make codegen-check` behaviour, exit code included."""
    try:
        source = discover_source(layout)
        files = tree_files(layout)
    except (CodegenSetupError, AppError) as exc:
        print(f"codegen-check: {exc}", file=sys.stderr)
        return EXIT_NO_VERDICT
    method_where = layout.describe(layout.method_dir)
    tree_where = layout.describe(layout.generated_dir)
    if source is None and files is None:
        print(f"codegen-check: no method in {method_where}/ and no generated tree: nothing to check.", flush=True)
        return EXIT_CURRENT
    print(f"codegen-check: {method_where}/ against {tree_where}/, offline", flush=True)
    if source is None:
        _fail(
            [
                f"\n✗ {tree_where}/ is a generated tree with no method in {method_where}/ behind it.",
                f"    Regeneration never removes a whole tree: delete {tree_where}/ or restore the method.",
            ]
        )
        codes = [EXIT_DRIFT]
    else:
        codes = [check_tree(source, layout)]
    summary = summarize_verdicts(codes)
    print(f"\ncodegen-check: {summary.current} current · {summary.drift} drift · {summary.no_verdict} no verdict", flush=True)
    return summary.exit


def main() -> int:
    """The console entry: any failure the check did not foresee is no verdict, never a pass."""
    try:
        return run_check()
    except Exception as exc:
        print(f"codegen-check: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_NO_VERDICT


if __name__ == "__main__":
    sys.exit(main())
