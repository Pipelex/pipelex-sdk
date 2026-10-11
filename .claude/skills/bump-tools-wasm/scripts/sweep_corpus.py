"""Sweep the built `.mthds` hook bundle over the MTHDS Test Corpus of one vscode-pipelex ref.

The hook lints with the MTHDS schema frozen into `@pipelex/tools-wasm`, and nothing in `js/`'s own
tests runs that engine, so this sweep is what shows a bump changed what the hook accepts and refuses
the way the engine's release says. The corpus comes from the vscode-pipelex ref that published the
engine (`pipelex-tools-wasm/v<version>`), the copy the engine's own tests were held to, read with
`git archive` so no checkout moves.

The rule is the corpus contract's, the one pipelex-plugins' `tests/unit/test_hook_corpus.py` applies
to the vendored bundle: an entry blocks with a schema diagnostic exactly when one of its `error.*`
tags has `fails_at = "schema"` in the corpus's `vocabulary.toml`, and every other entry passes with
nothing on stdout or stderr. Each entry runs from a temporary copy, because the format stage writes
back in place, and with the Pipelex credentials removed, so the validate stage never runs.

Run it with `python3 -I`. It prints a Markdown report and exits 0 when every entry meets the rule,
1 when one does not, and 2 when it could not answer.

With `--probe FILE...` instead of a corpus, it runs the bundle on each given `.mthds` file the same
way and reports what the hook did, block or pass, with the diagnostics, for a form the corpus does not
cover. A probe has no expected verdict, so it exits 0 whenever it could run.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, NamedTuple

SCRIPT = Path(__file__).resolve()
REPO_ROOT = SCRIPT.parents[4]
WORKSPACE_ROOT = REPO_ROOT.parent
DEFAULT_BUNDLE = REPO_ROOT / "js" / "dist-hooks" / "check.mjs"
DEFAULT_VSCODE_PIPELEX = WORKSPACE_ROOT / "vscode-pipelex"
CORPUS_PATH = "test-data/mthds-corpus"
MANIFEST_NAME = "entry.toml"
CREDENTIAL_PREFIXES = ("PIPELEX_", "CLAUDE_PLUGIN_OPTION_")
SCHEMA_DIAGNOSTIC = "[schema/"
HOOK_TIMEOUT_SECONDS = 60


class CannotAnswerError(Exception):
    pass


class HookVerdict(NamedTuple):
    method: str
    blocked: bool
    reason: str
    stdout: str
    stderr: str


class EntryResult(NamedTuple):
    name: str
    expects_block: bool
    ok: bool
    detail: str


def extract_corpus(vscode_pipelex: Path, ref: str, into: Path) -> Path:
    if not (vscode_pipelex / ".git").exists():
        raise CannotAnswerError(f"no vscode-pipelex checkout at {vscode_pipelex}; pass --vscode-pipelex")
    verify = subprocess.run(["git", "-C", str(vscode_pipelex), "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], capture_output=True, text=True, check=False)
    if verify.returncode != 0:
        raise CannotAnswerError(f"`{ref}` is not a ref of {vscode_pipelex}; fetch its tags first (`git -C {vscode_pipelex} fetch --tags`)")
    archive = subprocess.run(["git", "-C", str(vscode_pipelex), "archive", "--format=tar", ref, CORPUS_PATH], capture_output=True, check=False)
    if archive.returncode != 0:
        raise CannotAnswerError(f"`{ref}` carries no `{CORPUS_PATH}`: {archive.stderr.decode().strip()}")
    with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tar:
        tar.extractall(into, filter="data")
    return into / CORPUS_PATH


def schema_fault_tags(corpus: Path) -> frozenset[str]:
    vocabulary: dict[str, Any] = tomllib.loads((corpus / "vocabulary.toml").read_text(encoding="utf-8"))
    errors: dict[str, dict[str, Any]] = vocabulary.get("error", {})
    return frozenset(f"error.{name}" for name, spec in errors.items() if spec.get("fails_at") == "schema")


def run_hook(bundle: Path, method: Path, environment: dict[str, str]) -> HookVerdict:
    """One PostToolUse `Write` of `method`, as Claude Code hands it to the hook."""
    payload = json.dumps({"hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": {"file_path": str(method)}})
    result = subprocess.run(
        ["node", str(bundle), "--platform=claude"],
        input=payload,
        capture_output=True,
        text=True,
        env=environment,
        timeout=HOOK_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        return HookVerdict(method.name, False, f"the hook exited {result.returncode}", result.stdout, result.stderr or f"exit {result.returncode}")
    blocked = False
    reason = ""
    if result.stdout.strip():
        try:
            decision: dict[str, Any] = json.loads(result.stdout)
        except json.JSONDecodeError:
            return HookVerdict(method.name, False, "stdout is not JSON", result.stdout, result.stderr)
        blocked = decision.get("decision") == "block"
        reason = str(decision.get("reason", ""))
    return HookVerdict(method.name, blocked, reason, result.stdout, result.stderr)


def sweep_entry(bundle: Path, entry: Path, schema_tags: frozenset[str], environment: dict[str, str], scratch: Path) -> EntryResult:
    manifest: dict[str, Any] = tomllib.loads((entry / MANIFEST_NAME).read_text(encoding="utf-8"))
    caught = sorted(schema_tags & frozenset(manifest.get("covers", [])))
    expects_block = bool(caught)
    copy = scratch / entry.name
    shutil.copytree(entry, copy)
    methods = sorted(copy.rglob("*.mthds"))
    if not methods:
        return EntryResult(entry.name, expects_block, False, "the entry holds no `.mthds` file")
    verdicts = [run_hook(bundle, method, environment) for method in methods]
    if expects_block:
        if any(verdict.blocked and SCHEMA_DIAGNOSTIC in verdict.reason for verdict in verdicts):
            return EntryResult(entry.name, True, True, "")
        seen = "; ".join(f"{verdict.method}: {first_line(verdict.reason or verdict.stderr) or 'pass'}" for verdict in verdicts)
        return EntryResult(entry.name, True, False, f"covers {', '.join(caught)}, which the schema catches, but no schema block: {seen}")
    noisy = [verdict for verdict in verdicts if verdict.stdout.strip() or verdict.stderr.strip()]
    if not noisy:
        return EntryResult(entry.name, False, True, "")
    seen = "; ".join(f"{verdict.method}: {first_line(verdict.reason or verdict.stdout or verdict.stderr)}" for verdict in noisy)
    return EntryResult(entry.name, False, False, f"a form the schema allows, not passed silently: {seen}")


def first_line(text: str) -> str:
    """The first diagnostic line of a hook reason, which opens with a `[kind/…]` tag, else its first line."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    diagnostics = [line for line in lines if "[" in line and "/" in line.split("]")[0]]
    return (diagnostics or lines or [""])[0][:240]


def probe(bundle: Path, methods: list[Path], environment: dict[str, str], scratch: Path) -> int:
    missing = [str(method) for method in methods if not method.is_file()]
    if missing:
        print(f"## Probe: could not answer\n\nNo such file: {', '.join(missing)}")
        return 2
    print(f"## Probe\n\n- Bundle: `{bundle}`, provenance `{provenance(bundle)}`\n")
    for index, method in enumerate(methods):
        copy = scratch / str(index) / method.name
        copy.parent.mkdir(parents=True)
        shutil.copyfile(method, copy)
        verdict = run_hook(bundle, copy, environment)
        if verdict.blocked:
            lines = [line.strip() for line in verdict.reason.splitlines() if line.strip().startswith("- [")]
            print(f"- `{method}`: **blocks**")
            for line in lines or [first_line(verdict.reason)]:
                print(f"  {line[:300]}")
        elif verdict.stdout.strip() or verdict.stderr.strip():
            print(f"- `{method}`: passes with output: {first_line(verdict.stdout or verdict.stderr)}")
        else:
            print(f"- `{method}`: passes silently")
    return 0


def provenance(bundle: Path) -> str:
    with bundle.open(encoding="utf-8") as handle:
        for _ in range(3):
            line = handle.readline()
            if line.startswith("// Provenance:"):
                return line.removeprefix("// Provenance:").strip()
    return "no provenance line"


def main() -> int:
    parser = argparse.ArgumentParser(description="Sweep the built .mthds hook bundle over the MTHDS Test Corpus of one vscode-pipelex ref.")
    parser.add_argument("--ref", help="the vscode-pipelex ref whose corpus to sweep, e.g. pipelex-tools-wasm/v0.5.0")
    parser.add_argument("--corpus", type=Path, help="an extracted corpus directory, instead of --ref")
    parser.add_argument("--probe", type=Path, nargs="+", help="run the bundle on these .mthds files and report its verdicts, instead of a corpus")
    parser.add_argument("--bundle", type=Path, default=DEFAULT_BUNDLE, help=f"the hook bundle (default {DEFAULT_BUNDLE})")
    parser.add_argument("--vscode-pipelex", type=Path, default=DEFAULT_VSCODE_PIPELEX, help=f"the vscode-pipelex checkout (default {DEFAULT_VSCODE_PIPELEX})")
    parser.add_argument("--jobs", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()

    if sum(bool(source) for source in (args.ref, args.corpus, args.probe)) != 1:
        parser.error("pass exactly one of --ref, --corpus and --probe")
    title = "Probe" if args.probe else "Corpus sweep"
    if shutil.which("node") is None:
        print(f"## {title}: could not answer\n\n`node` is not on the PATH.")
        return 2
    if not args.bundle.is_file():
        print(f"## {title}: could not answer\n\nNo bundle at `{args.bundle}`: run `npm run build:hook` in `js/` first.")
        return 2

    environment = {key: value for key, value in os.environ.items() if not key.startswith(CREDENTIAL_PREFIXES)}
    if args.probe:
        with tempfile.TemporaryDirectory(prefix="tools-wasm-probe-") as temporary:
            return probe(args.bundle, [method.resolve() for method in args.probe], environment, Path(temporary))
    with tempfile.TemporaryDirectory(prefix="tools-wasm-sweep-") as temporary:
        scratch = Path(temporary)
        try:
            corpus = extract_corpus(args.vscode_pipelex, args.ref, scratch / "src") if args.ref else args.corpus.resolve()
            if not (corpus / "vocabulary.toml").is_file():
                raise CannotAnswerError(f"no `vocabulary.toml` in {corpus}")
            schema_tags = schema_fault_tags(corpus)
            entries = sorted(manifest.parent for manifest in (corpus / "entries").rglob(MANIFEST_NAME))
            if not entries:
                raise CannotAnswerError(f"no entry under {corpus / 'entries'}, so the sweep would pass having run nothing")
            if not schema_tags:
                raise CannotAnswerError('the vocabulary declares no `fails_at = "schema"` tag, so no entry is expected to block')
        except CannotAnswerError as reason:
            print(f"## Corpus sweep: could not answer\n\n{reason}")
            return 2

        runs = scratch / "runs"
        runs.mkdir()
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            results = list(pool.map(lambda entry: sweep_entry(args.bundle, entry, schema_tags, environment, runs), entries))

    blocking = sum(result.expects_block for result in results)
    failures = [result for result in results if not result.ok]
    source = f"vscode-pipelex `{args.ref}`" if args.ref else f"`{args.corpus}`"
    verdict = "pass" if not failures else "FAIL"
    print(f"## Corpus sweep: {verdict}\n")
    print(f"- Bundle: `{args.bundle}`, provenance `{provenance(args.bundle)}`")
    print(f"- Corpus: {source}, {len(results)} entries, {blocking} expected to block on a schema fault and {len(results) - blocking} to pass silently")
    if blocking in {0, len(results)}:
        print("- Warning: every entry expects the same verdict, so one side of the rule went unexercised")
    if failures:
        print(f"\n### {len(failures)} entries broke the rule\n")
        for failure in failures:
            print(f"- `{failure.name}` ({'should block' if failure.expects_block else 'should pass'}): {failure.detail}")
        return 1
    print("- Every entry met the rule.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
