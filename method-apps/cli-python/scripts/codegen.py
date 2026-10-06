"""`make codegen`: regenerate the package's `generated/` tree from its method, through the hosted API.

It needs `PIPELEX_API_KEY` and nothing else: the projection is the API's (`POST /v1/codegen`,
reached through `pipelex-sdk`), and so are the contracts (`POST /v1/pipe-io`). Every request goes
through `lib/client.py`'s `make_client`, the seam a test replaces.

In order, and nothing is written until every answer is in and checked:

1. The base URL is refused when it would carry the key over plaintext `http:` to another machine,
   and a missing key is refused before any request.
2. A method named by `method.json` is checked against `GET /v1/version`: a base URL that does not
   serve its selector is refused before a crate route is called (`codegen_api.py`).
3. `POST /v1/codegen` answers the typed models and their lock. The answer is held to the policies
   (`codegen_shared.py`): its lock is `codegen.lock`, every path it names stays inside the tree and
   lands on no file this script writes itself, and the tree it describes passes the offline check
   when written into a scratch directory, the self-check that catches an upstream bug before it
   reaches the package.
4. `POST /v1/pipe-io` answers the contracts of every pipe the method loads. A method the route
   reports `is_runnable: false` is refused, naming the pipes still declared as signatures.
5. `POST /v1/codegen`, asked again, confirms that the method did not change between the two answers:
   each request resolves the method on its own, and only the codegen answer names the revision it
   resolved (`crate_fingerprint`), so a fingerprint that moved in between is refused rather than
   committing the models of one revision beside the contracts of another. Coming after every
   codegen guard, a failure of either call leaves the tree as it was.
6. The tree is written: the codegen tree verbatim through the SDK's `write_codegen_tree`, then
   `contracts.json` and `__init__.py`, then the sidecar, each only when its bytes changed. A stamped
   file the new lock does not track is removed, which is the orphan the offline check would report:
   the check decides what an orphan is, and this script only acts on its verdict.

The ported module is `webapp-js`'s `scripts/lib/generate.mts`, over one method instead of a directory
of them.
"""

import asyncio
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import httpx
from dotenv import find_dotenv, load_dotenv
from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.codegen_check import DriftCategory, run_codegen_check
from pipelex_sdk.codegen_writer import write_codegen_tree
from pipelex_sdk.crate_models import CodegenRequest, CodegenResponse, CodegenValidReport, PipeIORequest, PipeIOResponse, PipeIOValidReport
from pipelex_sdk.errors import CodegenError

from pipelex_method_cli_python.lib import client as api
from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.contracts import LOCK_FILENAME, SOURCES_SIDECAR
from scripts.codegen_api import VersionClient, about_the_method, explain, selector_support_refusal
from scripts.codegen_shared import (
    PACKAGE_LAYOUT,
    WRITER_OWNED,
    CodegenSetupError,
    CodegenSource,
    Layout,
    derived_artifacts,
    discover_source,
    insecure_base_url_reason,
    invalid_lines,
    is_contained_path,
    normalized_artifact_path,
    not_runnable_reason,
    refuse_symlink_root,
    render_sidecar,
    walk,
)

#: The tree was written, or was already current.
EXIT_OK = 0

#: Nothing was written, or the writing failed: the reason is on stderr.
EXIT_FAILED = 1


class CodegenClient(VersionClient, Protocol):
    """What the gesture needs of a client: the base URL it talks to, and the three routes."""

    base_url: str

    async def codegen(self, request: CodegenRequest) -> CodegenResponse: ...

    async def pipe_io(self, request: PipeIORequest) -> PipeIOResponse: ...


class GenerateFailure(Exception):
    """A refusal, with the lines that explain it; nothing was written."""


@dataclass(frozen=True)
class Fetched:
    """Both answers a regeneration writes, each already checked."""

    report: CodegenValidReport
    pipe_io: PipeIOValidReport


async def request_codegen(client: CodegenClient, source: CodegenSource) -> CodegenValidReport:
    """Ask `POST /v1/codegen` for the typed models of the method, as it resolves now.

    Raises:
        GenerateFailure: The request failed, or the method does not resolve.
    """
    try:
        response = await client.codegen(source.codegen_request())
    except (PipelineRequestError, httpx.HTTPError, ValueError) as exc:
        # A refusal or an unreachable API, a transport error the SDK leaves unmapped, or a body that is not the answer.
        raise GenerateFailure(explain(exc, client.base_url, "POST /v1/codegen", source)) from exc
    if not isinstance(response, CodegenValidReport):
        raise GenerateFailure("\n".join(invalid_lines(response)))
    return response


async def fetch_codegen(client: CodegenClient, source: CodegenSource, layout: Layout) -> CodegenValidReport:
    """Ask `POST /v1/codegen` for the typed models, and hold the answer to the policies.

    Raises:
        GenerateFailure: The request failed, the method does not resolve, or the answer breaks a policy.
    """
    report = await request_codegen(client, source)
    guard_report(report, layout)
    return report


def guard_report(report: CodegenValidReport, layout: Layout) -> None:
    """Refuse an answer whose lock is not `codegen.lock`, whose paths leave the tree or land on the script's own files, or that fails its own check.

    The self-check writes the answer into a scratch directory with the SDK's writer and runs the
    offline check over it: a tree the server describes must be current by construction, and one that
    is not is an upstream bug that must not reach the package.

    Raises:
        GenerateFailure: The answer breaks one of the policies.
    """
    out_dir = layout.generated_dir
    if report.lock_filename != LOCK_FILENAME:
        msg = (
            f"the server returned lock_filename '{report.lock_filename}', not '{LOCK_FILENAME}'. "
            "Nothing was written; upgrade pipelex-sdk or report it upstream."
        )
        raise GenerateFailure(msg)
    escaping = [artifact.path for artifact in report.artifacts if not is_contained_path(out_dir, artifact.path)]
    if escaping:
        msg = (
            f"the server returned artifact paths that escape {layout.describe(out_dir)}/: {', '.join(escaping)}. "
            "Nothing was written; report it upstream."
        )
        raise GenerateFailure(msg)
    colliding = [artifact.path for artifact in report.artifacts if normalized_artifact_path(artifact.path) in WRITER_OWNED]
    if colliding:
        msg = (
            f"the server returned artifact paths that land on a file this script writes itself ({', '.join(sorted(WRITER_OWNED))}): "
            f"{', '.join(colliding)}. Nothing was written; report it upstream."
        )
        raise GenerateFailure(msg)
    with tempfile.TemporaryDirectory(prefix="codegen-self-check-") as scratch:
        try:
            write_codegen_tree(report, output_dir=Path(scratch))
            check = run_codegen_check(root=Path(scratch))
        except CodegenError as exc:
            msg = f"the server's own tree cannot be written as it is: {exc}. Nothing was written; report it upstream."
            raise GenerateFailure(msg) from exc
    if not check.is_current:
        lines = [
            "the server's own artifacts fail the offline check:",
            *(f"  {drift.category}: {drift.path} — {drift.detail}" for drift in check.drifts),
            "  Nothing was written. This is an upstream bug: report it.",
        ]
        raise GenerateFailure("\n".join(lines))


async def fetch_pipe_io(client: CodegenClient, source: CodegenSource, *, include_files: bool = False) -> PipeIOValidReport:
    """Ask `POST /v1/pipe-io` for every pipe's contracts, and refuse a method that does not run.

    `include_files` asks for a named method's `.mthds` files beside its contracts (`CodegenSource.pipe_io_request`).

    Raises:
        GenerateFailure: The request failed, the method does not resolve, or it is not runnable.
    """
    try:
        response = await client.pipe_io(source.pipe_io_request(include_files=include_files))
    except (PipelineRequestError, httpx.HTTPError, ValueError) as exc:
        # A refusal or an unreachable API, a transport error the SDK leaves unmapped, or a body that is not the answer.
        raise GenerateFailure(explain(exc, client.base_url, "POST /v1/pipe-io", source if about_the_method(exc) else None)) from exc
    if not isinstance(response, PipeIOValidReport):
        raise GenerateFailure("\n".join(invalid_lines(response)))
    reason = not_runnable_reason(response)
    if reason is not None:
        raise GenerateFailure(reason)
    return response


async def confirm_revision(client: CodegenClient, source: CodegenSource, report: CodegenValidReport) -> None:
    """Ask `POST /v1/codegen` again, and refuse when the method no longer resolves to the crate `report` describes.

    `/v1/codegen` and `/v1/pipe-io` each resolve the method on their own, and only the codegen
    answer names the revision it resolved. A method edited or republished between the two answers
    would otherwise commit the models of one revision beside the contracts of another, a tree the
    offline check would then call current, since it compares the tree only with itself and its sources.

    Raises:
        GenerateFailure: The request failed, the method does not resolve, or it resolves to another crate.
    """
    again = await request_codegen(client, source)
    if again.crate_fingerprint != report.crate_fingerprint:
        msg = "\n".join(
            (
                "the method changed while it was being generated: /v1/codegen resolved it to another crate after /v1/pipe-io answered.",
                f"    first:  {report.crate_fingerprint}",
                f"    then:   {again.crate_fingerprint}",
                "    Nothing was written. Run `make codegen` again.",
            )
        )
        raise GenerateFailure(msg)


async def fetch_generated(client: CodegenClient, source: CodegenSource, layout: Layout, *, include_files: bool = False) -> Fetched:
    """Both answers, the codegen first and the contracts after it, then the codegen's revision confirmed, so a failure anywhere writes nothing.

    `include_files` asks the contracts' answer to carry a named method's `.mthds` files too, for a
    caller that reads the method's own prose.

    Raises:
        GenerateFailure: A request failed, its answer was refused, or the method changed between the answers.
    """
    report = await fetch_codegen(client, source, layout)
    pipe_io = await fetch_pipe_io(client, source, include_files=include_files)
    await confirm_revision(client, source, report)
    return Fetched(report=report, pipe_io=pipe_io)


def write_if_changed(path: Path, content: str) -> bool:
    """Write `content` to `path` unless it already holds exactly that; whether it wrote.

    The text is written with LF line endings on every platform: text mode would otherwise write
    CRLF on Windows, and the tree would not hold the bytes the API emitted.
    """
    try:
        if path.read_text(encoding="utf-8") == content:
            return False
    except (OSError, UnicodeDecodeError):
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8", newline="\n")
    return True


def write_generated(layout: Layout, fetched: Fetched, source: CodegenSource) -> list[str]:
    """Write the tree and return what changed, one line per file.

    Raises:
        SymlinkRefusedError: Something under `generated/` is a link or a special file.
        CodegenError: The SDK's writer refused the tree.
        RuntimeError: The offline check called a file this script writes an orphan.
    """
    out_dir = layout.generated_dir
    if out_dir.exists() or out_dir.is_symlink():
        walk(out_dir, layout)
    written = write_codegen_tree(fetched.report, output_dir=out_dir)
    changed = [f"wrote {path}" for path in written.written] + [f"removed {path}" for path in written.removed]
    if written.lock_written:
        changed.append(f"wrote {LOCK_FILENAME}")
    derived = derived_artifacts(fetched.pipe_io)
    changed.extend(f"wrote {name}" for name, content in derived.items() if write_if_changed(out_dir / name, content))
    for drift in run_codegen_check(root=out_dir).drifts:
        if drift.category is not DriftCategory.ORPHAN:
            continue
        if drift.path in derived:
            msg = f"the offline check calls {drift.path}, which this script writes, an orphan: the derived files need a new home or a stamp."
            raise RuntimeError(msg)
        (out_dir / drift.path).unlink(missing_ok=True)
        changed.append(f"removed {drift.path} (an orphan)")
    if write_if_changed(out_dir / SOURCES_SIDECAR, render_sidecar(source.source_hashes, derived)):
        changed.append(f"wrote {SOURCES_SIDECAR}")
    return changed


async def generate(client: CodegenClient, source: CodegenSource, layout: Layout) -> int:
    """Regenerate the tree from the method over an open client, report it, and return the exit code."""
    refusal = await selector_support_refusal(client, client.base_url, source)
    if refusal is not None:
        print(f"codegen: {refusal}", file=sys.stderr)
        return EXIT_FAILED
    print(f"codegen: {source.describe()}, via {client.base_url}", flush=True)
    try:
        fetched = await fetch_generated(client, source, layout)
    except GenerateFailure as exc:
        print(f"\n✗ {exc}", file=sys.stderr)
        return EXIT_FAILED
    try:
        changed = write_generated(layout, fetched, source)
    except (CodegenSetupError, CodegenError, OSError, RuntimeError) as exc:
        print(f"\n✗ writing the tree failed: {exc}", file=sys.stderr)
        return EXIT_FAILED
    report = fetched.report
    print(f"\n✓ {layout.describe(layout.generated_dir)}/  (crate {report.crate_fingerprint[:12]}, engine {report.engine_version})", flush=True)
    for line in changed or ["no changes"]:
        print(f"    {line}", flush=True)
    return EXIT_OK


async def run_codegen(layout: Layout = PACKAGE_LAYOUT) -> int:
    """The whole `make codegen` behaviour, exit code included; `.env` is loaded by `main`.

    The client is the CLI's own (`lib/client.py`), so a missing key is refused before any request,
    and its resolved base URL is the one held to the plaintext policy before the first request.
    """
    try:
        source = discover_source(layout)
        refuse_symlink_root(layout.generated_dir, layout)
    except (CodegenSetupError, AppError) as exc:
        print(f"codegen: {exc}", file=sys.stderr)
        return EXIT_FAILED
    if source is None:
        print(f"codegen: {layout.describe(layout.method_dir)}/ holds no method, so there is nothing to generate.", file=sys.stderr)
        # template-only:begin
        print("  Run `make create` first: it writes the method and generates its tree.", file=sys.stderr)
        # template-only:end
        return EXIT_FAILED
    try:
        client = api.make_client()
    except AppError as exc:
        print(f"codegen: {exc.message} {exc.hint or ''}".rstrip(), file=sys.stderr)
        return EXIT_FAILED
    except PipelineRequestError as exc:
        print(f"codegen: {exc}\n  Check PIPELEX_BASE_URL in .env, or drop it to use the default.", file=sys.stderr)
        return EXIT_FAILED
    async with client:
        insecure = insecure_base_url_reason(client.base_url)
        if insecure is not None:
            print(f"codegen: {insecure}", file=sys.stderr)
            return EXIT_FAILED
        return await generate(client, source, layout)


def main() -> int:
    """The console entry: load `.env` without overriding the shell, then regenerate."""
    load_dotenv(find_dotenv(usecwd=True), override=False)
    return asyncio.run(run_codegen())


if __name__ == "__main__":
    sys.exit(main())
