"""Whether a request that got no answer may have left this machine, the one reading of a transport failure the
SDK cannot take from a problem.

`ApiUnreachableError` reads it when the client tells it the request may create a run, a start or a blocking
execute: a failure that proves nothing was sent reads as the transport's own problem (`client.unreachable`), and
any other as `client.outcome_unknown`, whose `retry` says the run may exist. `@pipelex/sdk` reads the same
failures the same way in its `transport-reading.ts`.

The reading errs on the safe side. A false "may have left" costs the person a look at the run history; a false
"never left" costs a second paid run. So every failure counts as one that may have left unless it proves
otherwise.
"""

from __future__ import annotations

import ssl
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from collections.abc import Iterator

#: The transport failures that can only come before the request leaves: a connection whose set-up failed
#: (`ConnectError`: an unknown host, a refused connection, no route to the host or the network, the system
#: giving up connecting, a server certificate the TLS handshake refused), a connection not made within httpx's
#: connect timeout, which covers the TCP connect and the TLS handshake (`ConnectTimeout`), a request whose time
#: limit ran out while it waited for a connection from the pool (`PoolTimeout`), and a URL the client cannot
#: send to (`UnsupportedProtocol`). Each comes from the request's one attempt: the client's transport retries
#: nothing, and httpx's pool moves a request to another connection only when the first proved unavailable
#: before anything was written on it.
#:
#: A host that drops packets is a connection that never comes, and each SDK meets its transport's connect time
#: limit first, which proves nothing was sent. Here it is httpx's connect timeout, which the one `timeout` the
#: client passes bounds: 30 seconds for a start that carries neither a bundle nor a `method_ref`, well before
#: the system gives up connecting, while a start given a longer limit may meet the system's first, a
#: `ConnectError` then. In `@pipelex/sdk` it is undici's own ten seconds (`UND_ERR_CONNECT_TIMEOUT`), which run
#: out before the time limit of any request that may create a run, so the one failure its fetch cannot place
#: before or after the connection, that SDK's own time limit (`ABORT_TIMEOUT`), comes only once the request has
#: left.
_NOTHING_SENT: tuple[type[httpx.TransportError], ...] = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, httpx.UnsupportedProtocol)

#: What, under a `ConnectError`, says the TLS handshake failed for another reason than the server certificate,
#: or the connection dropped during it. Nothing was sent then either, yet `@pipelex/sdk`'s fetch reports a
#: dropped handshake as the same `ECONNRESET` a connection dropped once the request had left gives, and another
#: TLS failure as one that can come after the handshake, so both SDKs read these as they must read those: a run
#: may have started.
_HANDSHAKE_FAILURES: tuple[type[BaseException], ...] = (ssl.SSLError, ConnectionResetError, ConnectionAbortedError, BrokenPipeError)


def request_may_have_left(failure: BaseException | None) -> bool:
    """Whether a request that met a transport failure may have left this machine: every failure but one that
    proves nothing was sent.

    Args:
        failure: The httpx exception the request met, `None` when it is not known, which proves nothing.

    Returns:
        Whether the request may have left, so that a run it would create may exist.
    """
    return failure is None or not _proves_nothing_sent(failure)


def _proves_nothing_sent(failure: BaseException) -> bool:
    """Whether a transport failure proves the request never left, so that no run was created by it: it names a
    step of the connection's set-up, which no request follows, and one `@pipelex/sdk` can tell from a failure
    that came once the request had left, so that both SDKs decide the same for it.

    Anything else may have come once the request had left: a read or write timeout, a connection that closed or
    was reset once the request had left, and a body httpx could not decode. Only a `ConnectError` is searched
    for a failed handshake. A `ConnectTimeout` that ran out during the handshake carries the
    `ssl.SSLWantReadError` of the read it interrupted, and proves nothing was sent all the same, as undici's
    connect time limit, which covers the handshake too, does in `@pipelex/sdk`.
    """
    if not isinstance(failure, _NOTHING_SENT):
        return False
    if not isinstance(failure, httpx.ConnectError):
        return True
    return not any(isinstance(cause, _HANDSHAKE_FAILURES) and not isinstance(cause, ssl.SSLCertVerificationError) for cause in _causes(failure))


def _causes(failure: BaseException) -> Iterator[BaseException]:
    """The exceptions `failure` was raised from, nearest first: httpcore's, then the transport's under it."""
    seen: set[int] = set()
    cause = failure.__cause__ or failure.__context__
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        yield cause
        cause = cause.__cause__ or cause.__context__
