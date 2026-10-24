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

from mthds.protocol.exceptions import PipelineRequestError
from mthds.protocol.models import VersionInfo
from mthds.protocol.problem.answers import read_problem_document
from mthds.protocol.problem.registry import CoreCode
from pipelex_sdk.errors import ApiResponseError, MethodErrorCode

from scripts.codegen_shared import CodegenSource, fault_lines


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
    except (PipelineRequestError, ValueError):
        # The handshake is advice: a server that cannot answer it, with a refusal, with no answer at all or
        # with a body that is not a version, is judged by the crate route instead.
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


def is_bare_forbidden(exc: ApiResponseError) -> bool:
    """Whether a refusal is a bare `403`, one that carried no problem document.

    A gateway answers a path it does not route with exactly that, as it answers a key it refuses, so the
    answer cannot say which it was: the SDK reads the status as `auth.invalid_credential`, but a base URL
    that does not serve the route is just as likely, and the line names both.
    """
    return exc.status == 403 and read_problem_document(exc.response_body, status=exc.status, headers={}) is None


def explain_selector_failure(exc: BaseException, source: CodegenSource) -> str | None:
    """A named method the API could not resolve, said as such, with the problem's own reason.

    The problem's code decides it: no method at the address or under the id, an address matching several
    methods, or a catalog method never published. Any other refusal is left to `explain`.
    """
    if not isinstance(exc, ApiResponseError) or source.selector is None:
        return None
    match exc.problem.code:
        case CoreCode.METHOD_NOT_FOUND | CoreCode.METHOD_AMBIGUOUS | MethodErrorCode.NOT_FOUND | MethodErrorCode.NOT_PUBLISHED:
            detail = exc.problem.detail.strip() or str(exc)
            return f"the API could not resolve {source.describe()}.\n  {detail}"
        case _:
            return None


def explain(exc: BaseException, base_url: str, route: str, source: CodegenSource | None = None) -> str:
    """A failed request as the line that says what to do about it, naming the route it came from, read from its problem."""
    if source is not None:
        selector_failure = explain_selector_failure(exc, source)
        if selector_failure is not None:
            return selector_failure
    if not isinstance(exc, ApiResponseError):
        return str(exc)
    if is_bare_forbidden(exc):
        return "\n".join(
            (
                f"HTTP 403 from {route}, with no problem document: either PIPELEX_API_KEY was refused, "
                f"or this base URL does not serve {route}, which a gateway answers alike.",
                f"  Base URL: {base_url}",
                "  Check the key in .env (get one at https://app.pipelex.com), and that PIPELEX_BASE_URL",
                "  points at a Pipelex API that serves this route, or drop it to use the default.",
                *((f"  Request id: {exc.request_id}",) if exc.request_id else ()),
            )
        )
    problem = exc.problem
    match problem.code:
        case CoreCode.REQUEST_NOT_FOUND:
            # A route this server lacks. A refusal the route answers itself carries its own code.
            return "\n".join(
                (
                    f"this base URL does not serve {route} (HTTP {exc.status}).",
                    f"  Base URL: {base_url}",
                    "  The hosted Pipelex API serves this route: check PIPELEX_BASE_URL in .env,",
                    "  or drop it to use the default.",
                )
            )
        case CoreCode.AUTH_MISSING_CREDENTIAL | CoreCode.AUTH_INVALID_CREDENTIAL | CoreCode.AUTH_CREDENTIAL_EXPIRED:
            return "\n".join(
                (
                    f"PIPELEX_API_KEY was refused on {route} (HTTP {exc.status}, {problem.code}).",
                    f"  Base URL: {base_url}",
                    "  Check the key in .env; get one at https://app.pipelex.com.",
                )
            )
        case CoreCode.CLIENT_RESPONSE_UNREADABLE:
            # No problem document came back, so the body as it came is the only reason there is.
            return f"HTTP {exc.status} from {route} — {exc.response_body.strip() or problem.detail.strip()}"
        case _:
            reason = problem.detail.strip() or problem.title.strip() or problem.code
            faults = "".join(f"\n{line}" for line in fault_lines(problem.errors))
            next_step = f"\n  Next step: {problem.next_step.detail}" if problem.next_step.detail.strip() else ""
            request_id = f" · request {exc.request_id}" if exc.request_id else ""
            return f"HTTP {exc.status} from {route} — {reason}{faults}{next_step}\n  For support: {problem.code}{request_id}"
