"""Say, for each named distribution, whether the virtual environment holds a local checkout or the registry's release.

`make local-status` runs it with the environment's own Python, so it reads that environment's
installed metadata. The version cannot tell the two apart, since a checkout carries the version it
will be published as; what does is the `direct_url.json` an installer records for a package it
installed from a path, which a release from PyPI does not carry.

Each line is `<name> <local|pypi|missing> <version>`, and a local one ends with its checkout's path.
"""

import json
import sys
from importlib.metadata import PackageNotFoundError, distribution
from typing import Any, cast
from urllib.parse import unquote, urlparse


def source_line(name: str) -> str:
    """One distribution's line: where it was installed from, its version, and the checkout's path for a local one."""
    try:
        installed = distribution(name)
    except PackageNotFoundError:
        return f"{name} missing"
    recorded = installed.read_text("direct_url.json")
    if recorded:
        payload: Any = json.loads(recorded)
        url = cast("dict[str, Any]", payload).get("url") if isinstance(payload, dict) else None
        if isinstance(url, str) and url.startswith("file:"):
            return f"{name} local {installed.version} {unquote(urlparse(url).path)}"
    return f"{name} pypi {installed.version}"


def main(names: list[str]) -> int:
    for name in names:
        print(source_line(name))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
