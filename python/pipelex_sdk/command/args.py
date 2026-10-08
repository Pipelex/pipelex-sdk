"""The flags of one subcommand, held to the rules `@pipelex/sdk`'s command applies, so both commands
refuse the same command lines with the same sentence.

The JavaScript command reads its flags with Node's `util.parseArgs` in its lenient mode and applies
its rules to the tokens that returns. `argparse` cannot be held to those rules: it lets the last of
a repeated flag win, reports an unknown option only after every other problem, refuses an empty
string's absence in its own words and exits by itself. So this module splits the command line into
the tokens `parseArgs` would make, case for case, and applies the same rules to them, in command-line
order, the first problem being the one reported:

- `--help` or `-h` anywhere before `--` asks for the subcommand's help, whatever else is there,
  even where a flag's value would be expected: an argument that is exactly one of the two is never
  taken as a value, so `run --method --help` prints the help. Since the tokens below take it as the
  value, as `parseArgs` and `argparse` both would, the command line is scanned for it first.
- An option the subcommand does not take is refused, and so is any positional argument.
- A flag given twice is refused, rather than the last one winning: a script written by `script`
  passes its own arguments through, and a second `--method` must not quietly run another method.
- A string flag needs a non-empty value, given as the next argument or after `=`. A next argument
  that starts with `-` is not taken as the value, except `-` alone, which `--inputs` reads as stdin;
  `--name=-x` is how a value starting with `-` is given.
- A boolean flag takes no value.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, TypeAlias

from pipelex_sdk.command.io import CommandError, usage_error

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

_HELP = "help"
# The two arguments that ask for a subcommand's help, and the one that ends the options.
_HELP_ARGUMENTS = frozenset({"--help", "-h"})
_TERMINATOR = "--"
# The one short option, `-h`, and the long option it stands for.
_SHORT_OPTIONS: dict[str, str] = {"h": _HELP}


class FlagKind(StrEnum):
    """Whether a flag takes a value."""

    STRING = "string"
    BOOLEAN = "boolean"

    @property
    def is_string(self) -> bool:
        """Whether the flag takes a value."""
        match self:
            case FlagKind.STRING:
                return True
            case FlagKind.BOOLEAN:
                return False


@dataclass(frozen=True)
class ParsedFlags:
    """What a subcommand's command line asked for."""

    #: Whether `--help` was asked for, in which case nothing else was read.
    help: bool
    strings: dict[str, str] = field(default_factory=dict[str, str])
    booleans: set[str] = field(default_factory=set[str])


@dataclass(frozen=True)
class _OptionToken:
    """An option, by its long name, as the command line spelled it, and the value it was given."""

    name: str
    raw_name: str
    value: str | None
    #: Whether the value came after `=` (or glued to a short option) rather than as the next argument.
    inline_value: bool


@dataclass(frozen=True)
class _PositionalToken:
    value: str


@dataclass(frozen=True)
class _TerminatorToken:
    """The `--` that ends the options."""


_Token: TypeAlias = _OptionToken | _PositionalToken | _TerminatorToken


def _long_name(short: str) -> str:
    """The long name a short option stands for, or the letter itself for a short option not declared."""
    return _SHORT_OPTIONS.get(short, short)


def _tokens(args: Sequence[str], specs: Mapping[str, FlagKind]) -> list[_Token]:
    """Split a command line into the tokens Node's `util.parseArgs` makes of it.

    A string option takes the next argument as its value whatever it looks like, as `parseArgs`
    does; the rules below decide whether such a value is acceptable.
    """

    def takes_value(name: str) -> bool:
        kind = specs.get(name)
        return kind is not None and kind.is_string

    remaining = list(args)
    tokens: list[_Token] = []
    while remaining:
        arg = remaining.pop(0)
        if arg == _TERMINATOR:
            tokens.append(_TerminatorToken())
            tokens.extend(_PositionalToken(value=rest) for rest in remaining)
            break
        if len(arg) == 2 and arg[0] == "-" and arg[1] != "-":
            # A lone short option: `-h`.
            name = _long_name(arg[1])
            if takes_value(name) and remaining:
                tokens.append(_OptionToken(name=name, raw_name=arg, value=remaining.pop(0), inline_value=False))
            else:
                tokens.append(_OptionToken(name=name, raw_name=arg, value=None, inline_value=False))
            continue
        if len(arg) > 2 and arg[0] == "-" and arg[1] != "-":
            if not takes_value(_long_name(arg[1])):
                # A group of short options, `-hx`, read as `-h -x`; a string option inside the
                # group takes the rest of it as its value.
                expanded: list[str] = []
                for index_char in range(1, len(arg)):
                    short = arg[index_char]
                    if not takes_value(_long_name(short)) or index_char == len(arg) - 1:
                        expanded.append(f"-{short}")
                    else:
                        expanded.append(f"-{arg[index_char:]}")
                        break
                remaining[0:0] = expanded
                continue
            # A short string option with its value glued on: `-fFILE`.
            tokens.append(_OptionToken(name=_long_name(arg[1]), raw_name=f"-{arg[1]}", value=arg[2:], inline_value=True))
            continue
        if len(arg) > 2 and arg.startswith("--"):
            if arg.find("=", 3) < 0:
                # A lone long option: `--method`, its value the next argument for a string option.
                name = arg[2:]
                if takes_value(name) and remaining:
                    tokens.append(_OptionToken(name=name, raw_name=arg, value=remaining.pop(0), inline_value=False))
                else:
                    tokens.append(_OptionToken(name=name, raw_name=arg, value=None, inline_value=False))
            else:
                # A long option and its value: `--method=mt_1`.
                equals_at = arg.find("=")
                name = arg[2:equals_at]
                tokens.append(_OptionToken(name=name, raw_name=f"--{name}", value=arg[equals_at + 1 :], inline_value=True))
            continue
        tokens.append(_PositionalToken(value=arg))
    return tokens


def parse_flags(command: str, args: Sequence[str], specs: Mapping[str, FlagKind]) -> ParsedFlags:
    """Read a subcommand's command line against its flags.

    Args:
        command: The subcommand's name, for the line saying where its flags are described.
        args: The arguments after the subcommand's name.
        specs: The flags the subcommand takes, by long name without the `--`.

    Raises:
        CommandError: A usage error naming the first problem, in command-line order.
    """
    before_terminator = args[: args.index(_TERMINATOR)] if _TERMINATOR in args else args
    if any(arg in _HELP_ARGUMENTS for arg in before_terminator):
        return ParsedFlags(help=True)
    tokens = _tokens(args, specs)
    # `-h` inside a group of short options, such as `-xh`, asks for the help too.
    if any(isinstance(token, _OptionToken) and token.name == _HELP and token.value is None for token in tokens):
        return ParsedFlags(help=True)

    strings: dict[str, str] = {}
    booleans: set[str] = set()
    seen: set[str] = set()
    for token in tokens:
        match token:
            case _TerminatorToken():
                continue
            case _PositionalToken():
                raise _misuse(command, f'unexpected argument "{token.value}"')
            case _OptionToken():
                if token.name == _HELP:
                    raise _misuse(command, "--help takes no value")
                kind = specs.get(token.name)
                if kind is None:
                    raise _misuse(command, f"unknown option {token.raw_name}")
                flag = f"--{token.name}"
                if token.name in seen:
                    raise _misuse(command, f"{flag} was given more than once")
                seen.add(token.name)
                match kind:
                    case FlagKind.BOOLEAN:
                        if token.value is not None:
                            raise _misuse(command, f"{flag} takes no value")
                        booleans.add(token.name)
                    case FlagKind.STRING:
                        value = token.value
                        if not value or (not token.inline_value and value.startswith("-") and value != "-"):
                            raise _misuse(command, f"{flag} needs a value")
                        strings[token.name] = value
    return ParsedFlags(help=False, strings=strings, booleans=booleans)


def _misuse(command: str, message: str) -> CommandError:
    return usage_error(f"{message}.", [f"Run 'pipelex-sdk {command} --help' to see its flags."])
