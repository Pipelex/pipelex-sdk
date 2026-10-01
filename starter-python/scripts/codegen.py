#!/usr/bin/env python3
"""Regenerate the committed typed clients for every method in `widget/methods/`.

This is what `make codegen` runs, and it needs nothing but `PIPELEX_API_KEY`: the
projection is done by the hosted API (`POST /v1/codegen`, reached through
`pipelex-sdk`, the starter's own dependency), not by a local `pipelex` runtime.
The `pipelex` CLI is deliberately not installed here, so asking a Python user to
find one before `make codegen` works was asking them to install the whole engine
to read three models. Its JS twin is `pipelex-starter-js/scripts/codegen.mts`.

One generated tree per method, mirroring `widget/methods/` one-to-one: each method
is its own closure, so each gets its own crate, artifact set and lock. The tree is
written **verbatim** — every `artifacts[]` entry at its `path`, the `lock` as
`codegen.lock` — because that byte-for-byte fidelity is what makes it identical to
a local `pipelex codegen types` run, and therefore what lets the offline drift
check (`make codegen-check`) pass on it. Reformatting an artifact or
re-serializing the lock breaks that trust chain, which is why the writing is
`pipelex-sdk`'s `write_codegen_tree` and not a loop of our own: it validates every
path first, refuses to overwrite a file codegen does not own, writes only what
changed, and prunes stamped artifacts that dropped out of the set.

A method directory names its closure in one of exactly two ways, and never both:

- **`.mthds` files** — the bundle lives here, and the whole directory is sent as inline
  `files`. This is what the three demos do.
- **`method.json`** — a one-line manifest holding a hosted catalog id (`method_id`) or a
  published address (`method_ref`), for a method that lives elsewhere. `make add-method`
  writes one; regenerating it is this same script, with the selector in place of the files.

Keeping the manifest under `widget/methods/` rather than beside the generated tree is what
makes the second kind almost free: `widget/methods/` stays the source of truth,
`widget/generated/` stays purely derived, and a selector-sourced tree is regenerated beside a
bundle-sourced one instead of through a second path.

Nothing here is method-specific: methods are discovered from the filesystem, so
adding one to `widget/methods/` is all it takes for the next run to generate it.
"""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.codegen_writer import write_codegen_tree
from pipelex_sdk.crate_models import CodegenRequest, CodegenTarget, CodegenValidReport, MthdsFileItem
from pipelex_sdk.errors import ApiResponseError, CodegenError

from widget.manifest import MANIFEST_FILENAME, ManifestError, read_manifest

REPO_ROOT = Path(__file__).resolve().parent.parent
# One string per path, the package name followed by a slash: the `/bootstrap` skill rewrites
# `widget/` to the project's package name, and only a slash-followed occurrence is read as the
# package form. Split into `"widget" / "methods"` it would be read as the distribution name.
METHODS_DIR = REPO_ROOT / "widget/methods"
GENERATED_ROOT = REPO_ROOT / "widget/generated"

#: Python consumers want self-contained pydantic models — the other targets
#: (`python-structures`, `ts-zod`) are for a Pipelex host and for TypeScript.
TARGET: CodegenTarget = "python-pydantic"

EXIT_OK = 0
EXIT_FAILED = 1

#: Hosts plaintext http may carry the API key to. `make codegen` sends the key as a bearer token
#: and writes server-supplied Python into the repo, so everything else must be https. Mirrors
#: `pipelex-starter-js`'s `assertSecureBaseUrl`, so the two starters' keyed scripts agree.
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def generated_package_dir(method_name: str) -> Path:
    """The generated package a method projects into — dashes turned into underscores.

    `summarize-pdf` → `widget/generated/summarize_pdf`, which is the mapping the mode CLIs'
    imports already use.
    """
    return GENERATED_ROOT / method_name.replace("-", "_")


@dataclass(frozen=True)
class MethodSource:
    """One method's closure — inline files or a selector — and the package its tree is written into."""

    name: str
    out_dir: Path
    files: list[MthdsFileItem] | None = None
    method_id: str | None = None
    method_ref: str | None = None

    @property
    def origin(self) -> str:
        """Where this method's closure comes from, for the one-line run report."""
        if self.method_id is not None:
            return f"catalog {self.method_id}"
        if self.method_ref is not None:
            return self.method_ref
        return "bundle"

    def codegen_request(self) -> CodegenRequest:
        """The `/v1/codegen` request for this method — one selector, the two projection axes.

        No `pipe_ref`: the `types` kind is concept-set-wide and rejects it with a 422.
        """
        return CodegenRequest(files=self.files, method_id=self.method_id, method_ref=self.method_ref, kind="types", target=TARGET)


def source_label(path: Path) -> str:
    """The provenance label a server diagnostic names for one file — repo-relative where it can be.

    A path outside the repository keeps its own spelling rather than raising: the label is there
    so a diagnostic names a file you can open, and a `relative_to` that refuses is not a reason to
    fail a run.
    """
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def read_method_source(method_dir: Path) -> MethodSource | None:
    """Read one method directory as a closure, or `None` when it holds no method at all.

    A bundle directory holds its whole closure, so every `.mthds` file under it is sent, nested
    ones included — one for a single-file bundle, several for a multi-file one. Each file carries
    its repo-relative path as `source`, so a diagnostic the server raises names a file you can
    open. A manifest directory holds `method.json` and names a method that lives elsewhere.

    Raises:
        ManifestError: The directory holds both kinds (they would disagree about where the tree
            came from), or its manifest does not name exactly one method.
    """
    bundle_files = sorted(method_dir.rglob("*.mthds"))
    manifest_path = method_dir / MANIFEST_FILENAME
    if bundle_files and manifest_path.is_file():
        msg = f"{method_dir}: holds both .mthds files and {MANIFEST_FILENAME} — a method has one source, not two"
        raise ManifestError(msg)
    out_dir = generated_package_dir(method_dir.name)
    if bundle_files:
        files = [MthdsFileItem(content=path.read_text(encoding="utf-8"), source=source_label(path)) for path in bundle_files]
        return MethodSource(name=method_dir.name, out_dir=out_dir, files=files)
    if manifest_path.is_file():
        selector = read_manifest(manifest_path)
        return MethodSource(name=method_dir.name, out_dir=out_dir, method_id=selector.method_id, method_ref=selector.method_ref)
    return None


def is_method_dir(method_dir: Path) -> bool:
    """Whether a directory under `widget/methods/` names a method, by either source kind."""
    return any(method_dir.rglob("*.mthds")) or (method_dir / MANIFEST_FILENAME).is_file()


def discover_method_dirs() -> list[Path]:
    """Every method directory under `widget/methods/`, in directory order.

    Read off the filesystem rather than listed, so a method added there is picked up by the next
    run without anybody remembering a second list. `scripts/codegen_check.py` discovers the trees
    to check through this same function, so regeneration and the offline gate can never disagree
    about which methods exist.
    """
    return [path for path in sorted(METHODS_DIR.iterdir()) if path.is_dir() and is_method_dir(path)]


def discover_methods() -> list[MethodSource]:
    """Read every method under `widget/methods/` as a closure, in directory order."""
    methods: list[MethodSource] = []
    for method_dir in discover_method_dirs():
        source = read_method_source(method_dir)
        if source is not None:
            methods.append(source)
    return methods


def insecure_base_url_reason(base_url: str) -> str | None:
    """Why this base URL must not be sent the API key, or `None` when it may be."""
    parsed = urlparse(base_url)
    if parsed.scheme == "https":
        return None
    if parsed.scheme != "http":
        return f"PIPELEX_BASE_URL must be an http(s) URL: {base_url}"
    host = (parsed.hostname or "").lower()
    if host in LOCAL_HOSTS or host.endswith(".localhost"):
        return None
    return (
        f"PIPELEX_BASE_URL uses plaintext http for a non-local host ({base_url}).\n"
        "    codegen sends the API key as a bearer token, so anything beyond localhost,\n"
        "    127.0.0.1 or [::1] must be https."
    )


def explain(exc: Exception, base_url: str, route: str = "POST /v1/codegen") -> str:
    """Turn a failure into an actionable line, naming the route it came from and the fix where we know it.

    `route` is a parameter because `scripts/add_method.py` reuses this on `POST /v1/validate`, and a
    validate failure reported against the codegen route would send the reader to the wrong place.
    Every route of the SDK, `validate` among the protocol ones, raises `ApiResponseError` on a
    non-2xx answer, so that one class carries the status, the server's reason and its next step.
    """
    if not isinstance(exc, ApiResponseError):
        return str(exc)
    status = exc.status
    # A route this server lacks answers a bare 404, with neither the platform's `code` nor the
    # runner's `error_type`. A 404 carrying either is an answer from the route itself — a
    # `method_ref` whose package does not exist, say — and the base URL is not what to change.
    if status == 404 and exc.code is None and exc.error_type is None:
        return (
            f"this base URL does not serve {route} (HTTP 404).\n"
            f"    Base URL: {base_url}\n"
            "    The hosted Pipelex API serves this route — check PIPELEX_BASE_URL in .env,\n"
            "    or drop it to use the default."
        )
    if status == 403:
        # Not a base-URL problem: a 403 on a product route is the platform's surface-access
        # gate, so sending the user to edit PIPELEX_BASE_URL would be the wrong advice.
        discriminant = f" {exc.code}" if exc.code else ""
        return (
            f"PIPELEX_API_KEY may not use {route} (HTTP 403{discriminant}).\n"
            f"    Base URL: {base_url}\n"
            "    The key was recognised; this surface is not enabled for it."
        )
    reason = exc.server_message or exc.title or exc.error_type or exc.code or exc.response_body.strip() or exc.status_text
    next_step = f"\n    Next step: {exc.user_action.detail}" if exc.user_action else ""
    return f"HTTP {status} from {route} — {reason}{next_step}"


async def generate_method(client: PipelexAPIClient, method: MethodSource) -> bool:
    """Generate one method end to end — request, guard, write, report. Returns whether it worked.

    Never raises: a failure is reported and returned, so one bad method neither aborts the
    run nor skips the methods after it.
    """
    try:
        response = await client.codegen(method.codegen_request())
    # Broad on purpose: every transport and request-shape failure is this method's failure
    # to report, not a reason to abort the methods after it.
    except Exception as exc:
        print(f"\n✗ {method.name} — {explain(exc, client.base_url)}", file=sys.stderr)
        return False

    # An unresolvable closure is a produced verdict on a 200, so it is branched on rather
    # than caught — and it writes nothing: types projected from a method that does not
    # resolve would describe a method that cannot run.
    if not isinstance(response, CodegenValidReport):
        print(f"\n✗ {method.name} — the closure does not resolve: {response.message}", file=sys.stderr)
        for item in response.validation_errors:
            print(f"    {item.source or '?'}: {item.message}", file=sys.stderr)
        return False

    try:
        written = write_codegen_tree(response, output_dir=method.out_dir)
    # OSError beside CodegenError: a permission or disk failure under the writer is this method's
    # failure to report like any other, not a traceback that skips the methods after it.
    except (CodegenError, OSError) as exc:
        print(f"\n✗ {method.name} — writing the tree failed: {exc}", file=sys.stderr)
        return False

    tree = method.out_dir.relative_to(REPO_ROOT)
    print(f"\n✓ {method.name} → {tree}/  (crate {response.crate_fingerprint[:12]}, engine {response.engine_version})", flush=True)
    changed = [f"wrote {path}" for path in written.written] + [f"removed {path}" for path in written.removed]
    if written.lock_written:
        changed.append("wrote codegen.lock")
    for line in changed or ["no changes"]:
        print(f"    {line}", flush=True)
    return True


async def run_codegen() -> int:
    """The whole `make codegen` behaviour, exit code included."""
    load_dotenv()

    if not os.environ.get("PIPELEX_API_KEY"):
        print("codegen: PIPELEX_API_KEY is not set — add it to .env (see .env.example).", file=sys.stderr)
        return EXIT_FAILED

    if not METHODS_DIR.is_dir():
        print(f"codegen: {METHODS_DIR.relative_to(REPO_ROOT)}/ does not exist.", file=sys.stderr)
        return EXIT_FAILED

    try:
        methods = discover_methods()
    except ManifestError as exc:
        print(f"codegen: {exc}", file=sys.stderr)
        return EXIT_FAILED
    if not methods:
        print(f"codegen: no methods found under {METHODS_DIR.relative_to(REPO_ROOT)}/.", file=sys.stderr)
        return EXIT_FAILED

    # The client owns the base-URL chain — its argument, then PIPELEX_BASE_URL, then the hosted
    # default — and refuses a malformed one at construction. So it is built before anything is
    # reported and `client.base_url` is what every message names: resolving the URL a second time
    # here could disagree with the one actually dialled. Broad on purpose: a `.env` carrying a base
    # URL the SDK rejects is a configuration problem to report, not a traceback to hand a starter user.
    try:
        client = PipelexAPIClient()
    except Exception as exc:
        print(f"codegen: {exc}\n  Check PIPELEX_BASE_URL in .env, or drop it to use the default.", file=sys.stderr)
        return EXIT_FAILED

    insecure = insecure_base_url_reason(client.base_url)
    if insecure is not None:
        print(f"codegen: {insecure}", file=sys.stderr)
        return EXIT_FAILED

    print(f"codegen: {', '.join(f'{method.name} ({method.origin})' for method in methods)} — via {client.base_url}", flush=True)
    failed = False
    async with client:
        for method in methods:
            if not await generate_method(client, method):
                failed = True
    return EXIT_FAILED if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(asyncio.run(run_codegen()))
