"""The verdict every Pipelex SDK error carries, and the table a refused request falls back to.

Every error `pipelex-sdk` raises says two things a program needs before anything else: whether asking
again can plausibly succeed (`retryable`), and who can fix the failure (`error_domain`). Both are always
decided. This module holds that vocabulary — `ErrorDomain` and `ErrorVerdict` — the structural reader
`error_verdict_of`, and `fallback_verdict`, the table an `ApiResponseError` reads a member from when the
server sent no usable one. The members the server sent are read first: the runner sends them on the
problems it renders, and the platform on those it renders itself once its deployment classifies them.
A route that sends neither, as the platform's Lambda-backed routes do not yet, a gateway's HTML page or
a bare runner's `{"detail": "Not Found"}` gets the table's.

The table is a contract with `@pipelex/sdk`, whose `fallbackVerdict` applies the same rows, and with the
platform, whose own verdicts are decided against it, so that a refusal keeps its verdict whether the
platform sent it or the table supplied it. The case file `tests/fixtures/error-verdicts.json`, a byte for byte copy of the
JavaScript package's, holds every row, and this package's suite drives its own code through it.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class ErrorDomain(StrEnum):
    """Who can fix a failure.

    - `input` — the caller, by changing the request: the inputs, the method, a reference, an argument.
    - `config` — someone changing the environment: the base URL, the credential, the plan, the deployment.
    - `runtime` — nobody beforehand: a fault during execution or in the service.

    The set is closed: the hosted envelope spec names these three, so a fourth would be a contract change
    and would reach the SDK as one.
    """

    INPUT = "input"
    CONFIG = "config"
    RUNTIME = "runtime"


class ErrorVerdict(BaseModel):
    """The verdict an error carries: who can fix the failure, and whether asking again can succeed.

    "Retryable" says a retry can succeed, never that it is safe: it says nothing about whether the first
    attempt had an effect. A start answered with a `500` may already have created a run, so a caller that
    must not start a run twice decides that for itself.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    #: Who can fix the failure: `input`, `config` or `runtime`.
    error_domain: ErrorDomain
    #: Whether asking again can plausibly succeed.
    retryable: bool


# The four verdicts the fallback table answers.
_INPUT = ErrorVerdict(error_domain=ErrorDomain.INPUT, retryable=False)
_CONFIG = ErrorVerdict(error_domain=ErrorDomain.CONFIG, retryable=False)
_TRANSIENT = ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=True)
_FAULT = ErrorVerdict(error_domain=ErrorDomain.RUNTIME, retryable=False)

# The platform code a `409` carries when the organization holds as many API keys as it may.
_API_KEY_LIMIT_CODE = "pipelex_api_key_limit_reached"


def error_domain_of(value: object) -> ErrorDomain | None:
    """The domain `value` names when it is one of the three, else `None`: any other string, an empty
    one, or a value that is not a string.
    """
    if not isinstance(value, str):
        return None
    try:
        return ErrorDomain(value)
    except ValueError:
        return None


def fallback_verdict(*, status: int, code: str | None, named: bool) -> ErrorVerdict:
    """The verdict of a refused request whose problem document carried no usable member.

    Every `4xx` the table does not list is the caller's request refused (`input`, not retryable), every
    `5xx` it does not list is a fault in the service that may pass (`runtime`, retryable), and any other
    status is one no refusal carries, such as the `2xx` of an answer the client could not read, so nothing
    says a retry helps (`runtime`, not retryable).

    Args:
        status: The HTTP status of the answer.
        code: The platform's native code, when the body carried one.
        named: Whether the body names what it refused: a platform `code` or a runner `error_type`. It
            decides a `404`: a named one is a resource the caller asked for that does not exist
            (`input`), a bare one is a route the deployment does not serve (`config`).

    Returns:
        The verdict of the table's row for the status.
    """
    match status:
        case 401 | 402 | 403:
            # The credential, the plan or the access must change.
            return _CONFIG
        case 404:
            return _INPUT if named else _CONFIG
        case 405:
            # The deployment does not serve this method on the route.
            return _CONFIG
        case 408 | 429:
            # Refused for its timing, not its content.
            return _TRANSIENT
        case 409:
            # A conflict with the stored state is the caller's, except the key limit, which someone lifts
            # by removing a key.
            return _CONFIG if code == _API_KEY_LIMIT_CODE else _INPUT
        case 501:
            # The deployment does not implement it, and asking again will not change that.
            return _CONFIG
        case _ if 400 <= status < 500:
            return _INPUT
        case _ if 500 <= status < 600:
            return _TRANSIENT
        case _:
            return _FAULT


def error_verdict_of(error: object) -> ErrorVerdict | None:
    """The verdict of anything an `except` holds: the pair from an exception carrying a boolean
    `retryable` and a known `error_domain`, and `None` otherwise.

    The check is structural rather than `isinstance`, so it reads every error of this SDK, an error of a
    consumer's own subclass, and an `mthds` `ApiResponseError` whose runner sent both members. `None`
    means the error carries no verdict: the `ValueError` the SDK raises for a malformed argument before any
    request is sent, a bug in the calling code, or anything else a `try` block raised. An argument the
    client refuses for what it asks is a `RequestArgumentError`, which carries one.

    Args:
        error: Anything, typically the exception an `except` clause caught.

    Returns:
        The error's verdict, or `None` when it carries none.
    """
    if not isinstance(error, BaseException):
        return None
    retryable = getattr(error, "retryable", None)
    error_domain = error_domain_of(getattr(error, "error_domain", None))
    if not isinstance(retryable, bool) or error_domain is None:
        return None
    return ErrorVerdict(error_domain=error_domain, retryable=retryable)
