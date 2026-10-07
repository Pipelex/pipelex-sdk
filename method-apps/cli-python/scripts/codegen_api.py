"""The keyed gestures' conversation with the API: the client they use, the handshake, and their failures in words.

`make codegen` and `make codegen-verify` reach the API through `lib/client.py`'s `make_client`, the
seam the CLI's own runs go through, called through its module so that a test replaces it in one place
and never touches the network. A method named by a `method.json` is resolved by the API, which must
therefore serve the selector it names: `selector_support_refusal` asks `GET /v1/version` first and
refuses a base URL whose `extensions` list lacks that one, before any crate route is called. A
version request that fails, or an answer with no `extensions` list of strings, proceeds: the crate
route then answers for itself. The ported module is `webapp-js`'s `scripts/lib/api.mts`.
"""

from typing import Any, Protocol, cast

import httpx
from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.models import VersionInfo
from pipelex_sdk.errors import ApiResponseError

from scripts.codegen_shared import CodegenSource


class VersionClient(Protocol):
    """What the handshake needs of a client: `GET /v1/version`."""

    async def version(self) -> VersionInfo: ...


def selector_kind(source: CodegenSource) -> str | None:
    """The selector a named method needs the API to serve, `method_ref` or `method_id`; `None` for a bundle."""
    if source.selector is None:
        return None
    return "method_ref" if source.selector.method_ref is not None else "method_id"


async def selector_support_refusal(client: VersionClient, base_url: str, source: CodegenSource) -> str | None:
    """Why this base URL cannot resolve the method's selector, or `None` when it can or cannot tell."""
    kind = selector_kind(source)
    if kind is None:
        return None
    try:
        info = await client.version()
    except (PipelineRequestError, httpx.HTTPError, ValueError):
        # The handshake is advice: a server that cannot answer it, on a raw transport whose errors the SDK
        # leaves unmapped or with a body that is not a version, is judged by the crate route instead.
        return None
    advertised: object = (info.model_extra or {}).get("extensions")
    if not isinstance(advertised, list) or not all(isinstance(item, str) for item in cast("list[Any]", advertised)):
        return None
    extensions = cast("list[str]", advertised)
    if kind in extensions:
        return None
    return "\n".join(
        (
            f"this base URL does not serve method selectors ({kind}).",
            f"  Base URL: {base_url}",
            f"  It advertises: {', '.join(extensions) or '(nothing)'}",
            "  A method named by method.json is resolved by the API, so the API has to serve",
            "  the selector. The hosted Pipelex API does: check PIPELEX_BASE_URL in .env, or",
            "  drop it to use the default.",
        )
    )


def explain_selector_failure(exc: BaseException, source: CodegenSource) -> str | None:
    """A `404` on a named method, said as the API not resolving it, with the server's own reason."""
    if not isinstance(exc, ApiResponseError) or exc.status != 404 or source.selector is None:
        return None
    detail = exc.server_message or str(exc)
    return f"the API could not resolve {source.describe()}.\n  {detail}"


def explain(exc: BaseException, base_url: str, route: str, source: CodegenSource | None = None) -> str:
    """A failed request as the line that says what to do about it, naming the route it came from."""
    if source is not None:
        selector_failure = explain_selector_failure(exc, source)
        if selector_failure is not None:
            return selector_failure
    if not isinstance(exc, ApiResponseError):
        return str(exc)
    if exc.status in (403, 404) and exc.code is None and exc.error_type is None:
        return "\n".join(
            (
                f"this base URL does not serve {route} (HTTP {exc.status}).",
                f"  Base URL: {base_url}",
                "  The hosted Pipelex API serves this route: check PIPELEX_BASE_URL in .env,",
                "  or drop it to use the default.",
            )
        )
    reason = exc.server_message or exc.title or exc.error_type or exc.code or exc.response_body.strip() or exc.status_text
    next_step = f"\n  Next step: {exc.user_action.detail}" if exc.user_action is not None and exc.user_action.detail else ""
    return f"HTTP {exc.status} from {route} — {reason}{next_step}"


def about_the_method(exc: BaseException) -> bool:
    """Whether a refusal is about the method rather than the route: the runner named an error type."""
    return isinstance(exc, ApiResponseError) and exc.error_type is not None
