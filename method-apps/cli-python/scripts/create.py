"""`make create`: turn this template into the CLI for one method.

The gesture is not written yet, and this script says so rather than pretending: it parses the whole
argument contract, so that the method-app family's contract test holds this template to the
variables every template's `make create` takes, and then refuses. The gesture that fetches and plans
the method, writes `method/`, `generated/` and `binding.py`, renames the project after the method
and runs `make all` is the next step of this template's construction; it replaces the refusal below
without changing the arguments.

The arguments are the family's: the method (a bundle path, a catalog id `mt_…`, or a published
address), then the values a person may set instead of letting the method decide them. The Makefile
forwards each one only when it was given on its command line and not blank.
"""

import argparse
import sys

#: What the refusal says, until the gesture is written.
NOT_YET = (
    "make create is not available in this version of the template: the gesture that turns it into the CLI "
    "for one method is not written yet, so nothing was changed."
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Read the gesture's arguments, which are the method-app family's `make create` contract."""
    parser = argparse.ArgumentParser(prog="make create", description="Turn this template into the CLI for one method.")
    parser.add_argument("method", metavar="METHOD", help="A .mthds file or a directory of them, a catalog id (mt_…), or a published address.")
    parser.add_argument("--name", help="The project's name, derived from the method when not given.")
    parser.add_argument("--title", help="The CLI's title, derived from the method when not given.")
    parser.add_argument("--description", help="The CLI's description, derived from the method when not given.")
    parser.add_argument("--pipe", help="The pipe to run, by its code, when the method's own entry pipe is not the one.")
    parser.add_argument("--author-name", help="The author named in pyproject.toml.")
    parser.add_argument("--author-email", help="The author's email named in pyproject.toml.")
    parser.add_argument("--repo-url", help="The project's repository URL.")
    parser.add_argument("--license", help="mit, proprietary, or an SPDX identifier.")
    parser.add_argument("--license-holder", help="Who holds the license.")
    parser.add_argument("--license-year", help="The license's year.")
    parser.add_argument("--dry-run", action="store_true", help="Print the plan and write nothing.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    """Parse the arguments, then refuse: the gesture is not written yet."""
    parse_args(argv)
    print(f"refused: not-yet-available\n{NOT_YET}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
