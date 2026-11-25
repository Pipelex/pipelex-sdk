"""The origin of an http(s) URL: the default port of each scheme, and the form two origins are compared in.

The client reads the port table when it shows a refused base URL, and the artifact stack compares a resolved link's
origin with the client's own before it fetches the link over plain http. Both live here so that neither keeps a copy.
"""

from __future__ import annotations

from typing import TypeAlias

import httpx

#: The default port of each scheme a base URL or a fetched link may carry, which a URL leaves out, as the WHATWG URL
#: parser `@pipelex/sdk` reads URLs with does.
DEFAULT_PORTS: dict[str, int] = {"http": 80, "https": 443}

#: An origin in the form two are compared in: the scheme lowercased, the host as httpx encodes it on the wire, and the
#: port with its default filled in.
ComparableOrigin: TypeAlias = tuple[str, str, int]


def comparable_origin(url: str) -> ComparableOrigin | None:
    """The origin of an http(s) URL in the form two are compared in, or `None` for anything else, which matches nothing.

    The host is httpx's `raw_host`: lowercased, and an internationalized name encoded as IDNA (`bücher.example` is
    `xn--bcher-kva.example`), as the WHATWG URL parser encodes it. The port is filled in from `DEFAULT_PORTS` when the
    URL leaves it out, so `http://localhost`, `http://LOCALHOST:80` and `http://localhost/` are one origin. Unlike the
    WHATWG parser, httpx does not rewrite an IP address: an IPv4 shorthand such as `127.1` and another spelling of an
    IPv6 address stay their own hosts, so such a link is refused where `@pipelex/sdk` would accept it.
    """
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL:
        return None
    scheme = parsed.scheme.lower()
    default_port = DEFAULT_PORTS.get(scheme)
    host = parsed.raw_host.decode("ascii")
    if default_port is None or not host:
        return None
    return scheme, host, parsed.port if parsed.port is not None else default_port
