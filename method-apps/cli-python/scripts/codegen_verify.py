"""`make codegen-verify`: ask the API whether the committed tree is still what the method resolves to, and write nothing.

It needs `PIPELEX_API_KEY`, and it answers what the offline check cannot: whether the method, as the
API resolves it today, is the one the tree was generated from. A bundle that did not change can still
resolve to another crate when a published dependency moved, and a method named by `method.json` lives
elsewhere entirely. Two comparisons, both against a fresh answer:

- the crate fingerprint `POST /v1/codegen` returns, against the one `codegen.lock` records;
- `contracts.json` re-rendered from `POST /v1/pipe-io`'s answer, against the committed bytes.

A difference in either exits 1 and says to run `make codegen`. An engine that moved while the crate
did not is a note, not a failure: regenerating would restamp the tree with no change of meaning. The
policies of `make codegen` hold here too: the plaintext `http:` refusal, the handshake before a
named method's selector is sent, and symbolic links refused. The ported module is `webapp-js`'s
`scripts/lib/verify.mts`.
"""

import asyncio
import sys

import httpx
from dotenv import find_dotenv, load_dotenv
from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.codegen_check import run_codegen_check
from pipelex_sdk.crate_models import CodegenValidReport, PipeIOValidReport
from pipelex_sdk.errors import CodegenLockError

from pipelex_method_cli_python.lib import client as api
from pipelex_method_cli_python.lib.app import AppError
from pipelex_method_cli_python.lib.contracts import CONTRACTS_FILENAME, LOCK_FILENAME
from scripts.codegen import CodegenClient
from scripts.codegen_api import about_the_method, explain, selector_support_refusal
from scripts.codegen_shared import (
    PACKAGE_LAYOUT,
    CodegenSetupError,
    CodegenSource,
    Layout,
    discover_source,
    insecure_base_url_reason,
    invalid_lines,
    not_runnable_reason,
    read_text_file,
    render_contracts,
    walk,
)

#: The committed tree is what the method resolves to.
EXIT_OK = 0

#: It is not, or the question could not be answered: the reason is on stderr.
EXIT_FAILED = 1


def _fail(*lines: str) -> int:
    for line in lines:
        print(line, file=sys.stderr)
    return EXIT_FAILED


async def verify(client: CodegenClient, source: CodegenSource, layout: Layout) -> int:
    """Compare the committed tree with fresh answers over an open client, and return the exit code."""
    out_dir = layout.generated_dir
    where = layout.describe(out_dir)
    try:
        files = walk(out_dir, layout) if out_dir.exists() else []
    except CodegenSetupError as exc:
        return _fail(f"codegen-verify: {exc}")
    if LOCK_FILENAME not in files:
        return _fail(f"\n✗ no {LOCK_FILENAME} at {where}/. Run `make codegen` first.")
    try:
        committed = run_codegen_check(root=out_dir)
    except CodegenLockError as exc:
        return _fail(f"\n✗ {where}/: {exc}")
    refusal = await selector_support_refusal(client, client.base_url, source)
    if refusal is not None:
        return _fail(f"codegen-verify: {refusal}")
    print(f"codegen-verify: {source.describe()}, against {client.base_url}", flush=True)
    try:
        live = await client.codegen(source.codegen_request())
    except (PipelineRequestError, httpx.HTTPError, ValueError) as exc:
        # A refusal or an unreachable API, a transport error the SDK leaves unmapped, or a body that is not the answer.
        return _fail(f"\n✗ {explain(exc, client.base_url, 'POST /v1/codegen', source)}")
    if not isinstance(live, CodegenValidReport):
        return _fail("\n✗", *invalid_lines(live))
    if live.crate_fingerprint != committed.crate_fingerprint:
        return _fail(
            "\n✗ the committed crate is not what the method resolves to.",
            f"    committed: {committed.crate_fingerprint}",
            f"    live:      {live.crate_fingerprint}",
            "    Run `make codegen` and commit the result.",
        )
    try:
        answer = await client.pipe_io(source.pipe_io_request())
    except (PipelineRequestError, httpx.HTTPError, ValueError) as exc:
        # A refusal or an unreachable API, a transport error the SDK leaves unmapped, or a body that is not the answer.
        return _fail(f"\n✗ {explain(exc, client.base_url, 'POST /v1/pipe-io', source if about_the_method(exc) else None)}")
    if not isinstance(answer, PipeIOValidReport):
        return _fail("\n✗", *invalid_lines(answer, lead="the method no longer resolves"))
    reason = not_runnable_reason(answer)
    if reason is not None:
        return _fail(f"\n✗ {reason}")
    rendered = render_contracts(answer.pipe_io_contracts, answer.input_form, answer.output_form)
    try:
        on_disk = read_text_file(out_dir / CONTRACTS_FILENAME, layout)
    except (OSError, CodegenSetupError):
        on_disk = None
    if rendered != on_disk:
        return _fail(f"\n✗ the committed {CONTRACTS_FILENAME} is not what /v1/pipe-io returns.", "    Run `make codegen` and commit the result.")
    print(f"\n✓ crate {(committed.crate_fingerprint or '?')[:12]} matches the engine, {CONTRACTS_FILENAME} matches /v1/pipe-io", flush=True)
    if live.engine_version != committed.engine_version:
        moved = f"the engine moved {committed.engine_version} → {live.engine_version}"
        print(f"    note: {moved}; regenerating would restamp the tree with no change of meaning", flush=True)
    if committed.drifts:
        print(f"    note: the tree drifted from its lock; run `make codegen-check` for the {len(committed.drifts)} drift(s)", flush=True)
    return EXIT_OK


async def run_verify(layout: Layout = PACKAGE_LAYOUT) -> int:
    """The whole `make codegen-verify` behaviour, exit code included; `.env` is loaded by `main`."""
    try:
        source = discover_source(layout)
    except (CodegenSetupError, AppError) as exc:
        return _fail(f"codegen-verify: {exc}")
    if source is None:
        return _fail(f"codegen-verify: {layout.describe(layout.method_dir)}/ holds no method, so there is nothing to verify.")
    try:
        client = api.make_client()
    except AppError as exc:
        return _fail(f"codegen-verify: {exc.message} {exc.hint or ''}".rstrip())
    except PipelineRequestError as exc:
        return _fail(f"codegen-verify: {exc}\n  Check PIPELEX_BASE_URL in .env, or drop it to use the default.")
    async with client:
        insecure = insecure_base_url_reason(client.base_url)
        if insecure is not None:
            return _fail(f"codegen-verify: {insecure}")
        return await verify(client, source, layout)


def main() -> int:
    """The console entry: load `.env` without overriding the shell, then verify."""
    load_dotenv(find_dotenv(usecwd=True), override=False)
    return asyncio.run(run_verify())


if __name__ == "__main__":
    sys.exit(main())
