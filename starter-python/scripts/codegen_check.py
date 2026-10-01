#!/usr/bin/env python3
"""Verify every committed generated tree still matches its own `codegen.lock` — offline.

This is what `make codegen-check` runs, and like `make codegen` it needs nothing this starter does
not already depend on: the check is `pipelex_sdk.codegen_check.run_codegen_check`, the SDK's mirror
of what `pipelex codegen check` does, over the same bytes and the same lock format. No engine boot,
no network, no API key and no `pipelex` install — which is the premise of this template, and the
reason this script exists instead of a shell-out to a CLI nobody here has.

It compares each artifact's whole body against the hash its lock records, so a regenerated model
whose field types, defaults or docstrings moved fails here even when every name it exports stayed
the same. What it cannot see is a bundle edited and never regenerated: answering that needs the
engine, and `make codegen` is the guard for it.

The methods are discovered from `widget/methods/` through `scripts/codegen.py`'s own
`discover_method_dirs`, so the gate and the regeneration can never disagree about which methods
exist, and a method added there is checked by the next run. `tests/unit/test_generated_clients.py`
runs the same check over the same trees, so a clone that never runs this target is still gated in CI.
"""

from __future__ import annotations

import sys

from pipelex_sdk.codegen_check import run_codegen_check
from pipelex_sdk.codegen_lock import CODEGEN_LOCK_FILENAME
from pipelex_sdk.errors import CodegenLockError

from scripts.codegen import METHODS_DIR, REPO_ROOT, discover_method_dirs, generated_package_dir

#: The tree matches its lock.
EXIT_OK = 0
#: At least one tree drifted from its lock — stale, hand-edited, or carrying an orphan.
EXIT_DRIFT = 1
#: At least one tree has no lock to check against, or a lock that could not be read. A run that
#: hits both this and a drift exits with this code: the absence of a verdict outranks a verdict.
EXIT_NO_LOCK = 2


def check_method(method_name: str) -> int:
    """Check one method's generated tree, print its verdict, and return that verdict's exit code."""
    generated_dir = generated_package_dir(method_name)
    tree = generated_dir.relative_to(REPO_ROOT)
    try:
        report = run_codegen_check(root=generated_dir)
    except CodegenLockError as exc:
        print(f"✗ {method_name} → {tree}/  the lock could not be read: {exc}", file=sys.stderr)
        return EXIT_NO_LOCK

    if not report.lock_found:
        print(f"✗ {method_name} → {tree}/  no {CODEGEN_LOCK_FILENAME} — run `make codegen`", file=sys.stderr)
        return EXIT_NO_LOCK
    if not report.is_current:
        print(f"✗ {method_name} → {tree}/  drifted from its lock — run `make codegen`", file=sys.stderr)
        for drift in report.drifts:
            print(f"    {drift.path}: {drift.category} — {drift.detail}", file=sys.stderr)
        return EXIT_DRIFT

    print(f"✓ {method_name} → {tree}/  current (crate {(report.crate_fingerprint or '?')[:12]}, engine {report.engine_version})", flush=True)
    return EXIT_OK


def run_check() -> int:
    """The whole `make codegen-check` behaviour, exit code included."""
    if not METHODS_DIR.is_dir():
        print(f"codegen-check: {METHODS_DIR.relative_to(REPO_ROOT)}/ does not exist.", file=sys.stderr)
        return EXIT_NO_LOCK

    method_dirs = discover_method_dirs()
    if not method_dirs:
        print(f"codegen-check: no methods found under {METHODS_DIR.relative_to(REPO_ROOT)}/.", file=sys.stderr)
        return EXIT_NO_LOCK

    print(f"codegen-check: {', '.join(method_dir.name for method_dir in method_dirs)} — offline, against each codegen.lock", flush=True)
    # The worst verdict of the run, and every method is checked before it is reported: a drift in
    # the first tree must not hide a missing lock in the third.
    return max(check_method(method_dir.name) for method_dir in method_dirs)


if __name__ == "__main__":
    sys.exit(run_check())
