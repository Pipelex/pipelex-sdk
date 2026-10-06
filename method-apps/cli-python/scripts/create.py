"""`make create`: turn this template into the CLI for one method, in one gesture.

A fresh copy of the template is a command with no method, under the template's own name. This
gesture takes the method the person has, a bundle path, a catalog id or a published address, and
leaves the command for it: the method written into the package, the project named after the method
by the bootstrap, `.env` written from the shell, and `make all` green. Everything is decided here and
nothing asks a question: a value that cannot be derived is a refusal naming the flag that supplies it.

The order is the safety story:

1. **Read-only.** Check that this is the un-bootstrapped template, read the key and the base URL
   from the shell and then from `.env`, plan the method (`create_plan.py`, which fetches it once:
   everything below reads that one fetch), derive the project's name, title and description from
   it, plan the env file, and run the bootstrap with `--dry-run`, which validates every value it
   will be given. `--dry-run` stops here, having written nothing.
2. **Write.** The method first, `method/`, `generated/` and `binding.py`, which are removed again if
   writing them fails, so that the template is as it was and the gesture can run again. Then the
   bootstrap with `--clean`, the env file, `uv sync` to re-sync `uv.lock` and the environment with
   the renamed project, `make all`, and last the bootstrap skill's own removal, once the checks are
   green. A failure after the method is written names the ordinary commands left to run.

The gesture is one-shot, and the template's alone: the bootstrap removes it, with everything only it
uses, from the project it creates. The arguments are the method-app family's `make create`
contract, which the Makefile forwards. The ported module is `webapp-js`'s `scripts/lib/create.mts`.
"""

import argparse
import asyncio
import contextlib
import os
import re
import shlex
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from dotenv import dotenv_values, load_dotenv
from mthds.protocol.exceptions import PipelineRequestError
from pipelex_sdk.errors import CodegenError

from pipelex_method_cli_python.lib import client as api
from pipelex_method_cli_python.lib.app import DISTRIBUTION_NAME, AppError
from pipelex_method_cli_python.lib.method_source import PACKAGE
from scripts.codegen_shared import CLI_ROOT, CodegenSetupError, Layout, insecure_base_url_reason
from scripts.create_plan import (
    MethodArgs,
    MethodPlan,
    PlanError,
    method_vocabulary,
    plan_method,
    respell_acronyms,
    title_from_name,
    write_method,
)

#: The project was created, or the dry run printed its plan.
EXIT_OK = 0

#: The gesture refused, or a step failed: the reason is on stderr.
EXIT_FAILED = 1

#: The exit code after Ctrl-C, the shell's convention for a process ended by SIGINT.
EXIT_INTERRUPTED = 130

#: The template's distribution name: the gesture runs only while `pyproject.toml` still says it.
TEMPLATE_NAME = DISTRIBUTION_NAME

#: The bootstrap's directory, removed once `make all` is green, and its script, both relative to the root.
BOOTSTRAP_DIR = ".claude/skills/bootstrap"
BOOTSTRAP_SCRIPT = f"{BOOTSTRAP_DIR}/scripts/bootstrap.py"

#: The env file the CLI reads, the example it is written from, and the two values it holds.
ENV_FILE = ".env"
ENV_EXAMPLE = ".env.example"
BASE_URL_KEY = "PIPELEX_BASE_URL"
API_KEY_KEY = "PIPELEX_API_KEY"

#: What `.env` starts from when `.env.example` is missing.
MINIMAL_ENV = f"{BASE_URL_KEY}=\n{API_KEY_KEY}=\n"

#: The variables a child `make` would read the gesture's own command line from.
MAKE_VARIABLES = ("MAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES")

#: The variables that would make `uv sync` refuse the lock file the rename leaves stale, rather than re-sync it.
UV_LOCK_GATES = ("UV_LOCKED", "UV_FROZEN")

USAGE = (
    "usage: make create METHOD=<path/to/bundle | mt_… | github.com/owner/repo[/pkg][@tag]> [NAME=<package>] [TITLE=<title>] "
    "[DESCRIPTION=<text>] [PIPE=<pipe_code>] [AUTHOR_NAME=…] [AUTHOR_EMAIL=…] [REPO_URL=…] [LICENSE=mit|proprietary|<spdx>] "
    "[LICENSE_HOLDER=…] [LICENSE_YEAR=…] [DRY_RUN=1]"
)


class CreateError(Exception):
    """A refusal or a failed step, printed as one message with exit code 1."""


# ── The command line ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CreateArgs:
    """The gesture's arguments, the family's contract; a value left blank is not given."""

    method: str
    name: str | None = None
    title: str | None = None
    description: str | None = None
    pipe: str | None = None
    author_name: str | None = None
    author_email: str | None = None
    repo_url: str | None = None
    license: str | None = None
    license_holder: str | None = None
    license_year: str | None = None
    dry_run: bool = False


#: The arguments the gesture reads itself, by field and flag.
OWN_VALUES = (("name", "--name"), ("title", "--title"), ("description", "--description"), ("pipe", "--pipe"))

#: The arguments handed to the bootstrap unchanged, by field and flag.
BOOTSTRAP_PASSTHROUGH = (
    ("author_name", "--author-name"),
    ("author_email", "--author-email"),
    ("repo_url", "--repo-url"),
    ("license", "--license"),
    ("license_holder", "--license-holder"),
    ("license_year", "--license-year"),
)


def parse_create_args(argv: Sequence[str]) -> CreateArgs:
    """Read the gesture's arguments. A blank value counts as not given, and a value that looks like the next flag is refused.

    Raises:
        CreateError: An unknown argument, a missing value, a second method, or no method.
    """
    # `exit_on_error=False` makes a refusal an exception, worded and exited the gesture's own way, rather than argparse's exit 2.
    parser = argparse.ArgumentParser(prog="make create", allow_abbrev=False, add_help=False, exit_on_error=False)
    parser.add_argument("method", nargs="?", metavar="METHOD")
    for _, flag in (*OWN_VALUES, *BOOTSTRAP_PASSTHROUGH):
        parser.add_argument(flag)
    parser.add_argument("--dry-run", action="store_true")
    try:
        parsed, extra = parser.parse_known_args(list(argv))
    except argparse.ArgumentError as exc:
        msg = f"{exc}.\n  {USAGE}"
        raise CreateError(msg) from exc
    if extra:
        first = extra[0]
        if first.startswith("-"):
            msg = f"unknown argument {first!r}.\n  {USAGE}"
        else:
            msg = f"unexpected second method {first!r}: a CLI is created for one method.\n  {USAGE}"
        raise CreateError(msg)
    method: object = parsed.method
    if not isinstance(method, str) or not method.strip():
        msg = f"no method given: pass a .mthds file or a directory of them, a catalog id (mt_…), or a published address.\n  {USAGE}"
        raise CreateError(msg)
    values: dict[str, Any] = {}
    for field, _ in (*OWN_VALUES, *BOOTSTRAP_PASSTHROUGH):
        raw: object = getattr(parsed, field)
        values[field] = (raw.strip() or None) if isinstance(raw, str) else None
    return CreateArgs(method=method, dry_run=bool(parsed.dry_run), **values)


# ── The identity ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Identity:
    """What the bootstrap is told the project is."""

    name: str
    title: str
    description: str

    @property
    def package(self) -> str:
        """The import package the bootstrap renames the template's to."""
        return self.name.replace("-", "_")


def one_line(text: str | None) -> str | None:
    """A value on one line, or `None` when it is blank: the platform stores an empty name as readily as a missing one."""
    line = re.sub(r"\s+", " ", text or "").strip()
    return line or None


def derive_identity(plan: MethodPlan, args: CreateArgs) -> Identity:
    """The project's name, title and description, each derived from the method unless given.

    - **name**: the method's name (`create_plan.py`: a bundle's domain, a catalog method's name, an
      address's package), kebab-cased.
    - **title**: a catalog method's name, which a person chose; otherwise the name title-cased, with
      every word the method's own prose spells its own way respelled, so that `cv-screening` becomes
      `CV Screening` where the method writes "CVs".
    - **description**: the catalog's description, else the domain's own, else the chosen pipe's,
      else a sentence naming the method.

    Raises:
        CreateError: No name was given and none was derived.
    """
    name = args.name or plan.slug
    if name is None:
        msg = "no project name could be derived from the method: pass --name."
        raise CreateError(msg)
    catalog = plan.catalog
    title = (
        one_line(args.title)
        or one_line(catalog.name if catalog is not None else None)
        or respell_acronyms(title_from_name(name), method_vocabulary(plan.prose))
    )
    description = (
        one_line(args.description)
        or one_line(catalog.description if catalog is not None else None)
        or one_line(plan.prose.description)
        or one_line(plan.prose.pipe_descriptions.get(plan.pipe.ref))
        or f"Runs the {title} method through the Pipelex API."
    )
    return Identity(name=name, title=title, description=description)


# ── The env file ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ShellEnv:
    """What the shell itself set, read before any env file was loaded: the gesture copies a key only from the shell."""

    base_url: str | None = None
    key: str | None = None


@dataclass(frozen=True)
class EnvPlan:
    """What the gesture does about `.env`: write it, keep the one that exists, or leave the project without one."""

    action: Literal["write", "keep", "skip"]
    content: str | None
    notes: tuple[str, ...]


def find_env_file(root: Path) -> Path | None:
    """The `.env` the CLI reads when run from `root`: the nearest one, there or in a directory above, as python-dotenv finds it."""
    for directory in (root, *root.parents):
        candidate = directory / ENV_FILE
        if candidate.is_file():
            return candidate
    return None


def quote_env_value(key: str, value: str) -> str:
    """A value as python-dotenv reads it back exactly: in single quotes, so that a `#`, a `$` or a space survives.

    Raises:
        CreateError: The value holds a line break, which an env file cannot hold, or `${`, which
            python-dotenv expands as a variable even inside quotes.
    """
    if "\n" in value or "\r" in value:
        msg = f"{key} contains a line break, which an env file cannot hold."
        raise CreateError(msg)
    if "${" in value:
        msg = f"{key} contains `${{`, which python-dotenv would expand as a variable. Write {ENV_FILE} yourself, then run make create again."
        raise CreateError(msg)
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def set_env_line(text: str, key: str, value: str) -> str:
    """Set `key` in dotenv text to a value already quoted: the first assignment replaced, the later ones dropped, one appended when there is none."""
    assigns = re.compile(rf"\s*(export\s+)?{re.escape(key)}\s*=")
    kept: list[str] = []
    seen = False
    for line in text.replace("\r\n", "\n").removesuffix("\n").split("\n"):
        if assigns.match(line) is None:
            kept.append(line)
        elif not seen:
            kept.append(f"{key}={value}")
            seen = True
    if not seen:
        kept.append(f"{key}={value}")
    return "\n".join(kept) + "\n"


def plan_env_file(root: Path, shell: ShellEnv, env_file: Path | None, base_url: str) -> EnvPlan:
    """Decide what happens to `.env`. An existing one is the person's and is never touched.

    python-dotenv reads one env file, the nearest, so a `.env` written here hides any above it. When
    the key came from one above rather than from the shell, the gesture leaves the project without a
    `.env`, so that the file above keeps supplying it: the gesture copies a key only from the shell.

    Raises:
        CreateError: A value cannot be written so that python-dotenv reads it back as it is.
    """
    target = root / ENV_FILE
    if target.exists() or target.is_symlink():
        notes = [f"{ENV_FILE} exists and is left as it is."]
        written = dotenv_values(target).get(BASE_URL_KEY) if target.is_file() else None
        if shell.base_url is not None and written and written != shell.base_url:
            notes.append(
                f"your shell sets {BASE_URL_KEY}={shell.base_url}, but {ENV_FILE} says {written}: the CLI reads the file whenever "
                "the shell does not set it."
            )
        return EnvPlan(action="keep", content=None, notes=tuple(notes))
    if shell.key is None and env_file is not None:
        note = (
            f"{ENV_FILE} is not written: {API_KEY_KEY} comes from {env_file}, which the CLI reads only while this project has "
            f"no {ENV_FILE} of its own, and the gesture copies a key only from your shell."
        )
        return EnvPlan(action="skip", content=None, notes=(note,))
    example = root / ENV_EXAMPLE
    text = example.read_text(encoding="utf-8") if example.is_file() else MINIMAL_ENV
    text = set_env_line(text, BASE_URL_KEY, quote_env_value(BASE_URL_KEY, base_url))
    if shell.key is not None:
        text = set_env_line(text, API_KEY_KEY, quote_env_value(API_KEY_KEY, shell.key))
    origin = "from your shell" if shell.base_url is not None else f"from {env_file}" if env_file is not None else "the default"
    key_note = f"and {API_KEY_KEY} from your shell" if shell.key is not None else f"and an empty {API_KEY_KEY}: set one before running the CLI"
    notes = [f"{ENV_FILE} is written with {BASE_URL_KEY}={base_url} ({origin}), {key_note}, readable by you alone."]
    if env_file is not None:
        notes.append(f"it hides {env_file} from the CLI, which reads the nearest {ENV_FILE} only.")
    return EnvPlan(action="write", content=text, notes=tuple(notes))


def write_env_file(path: Path, content: str) -> bool:
    """Create `.env` readable by its owner alone, never over an existing one; whether it was written."""
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    return True


# ── The orchestration ───────────────────────────────────────────────────────

#: Runs a command with its output shown, from a directory and with an environment (`None`: this
#: process's own), and returns its exit status.
RunCommand = Callable[[Sequence[str], Path, Mapping[str, str] | None], int]


def run_inherited(command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
    """Run a command inheriting this process's output, and read its exit status."""
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        return subprocess.run(list(command), cwd=cwd, env=None if env is None else dict(env), check=False).returncode
    except OSError as exc:
        print(f"create: could not run {command[0]}: {exc}", file=sys.stderr)
        return EXIT_FAILED


def environment_without(names: Sequence[str]) -> dict[str, str]:
    """This process's environment less the variables named."""
    return {key: value for key, value in os.environ.items() if key not in names}


@dataclass(frozen=True)
class CreateDeps:
    """What a run needs from its surroundings, which a test replaces."""

    root: Path
    #: Where a relative bundle path is resolved from: the directory make runs in.
    cwd: Path
    shell: ShellEnv
    #: The env file the values the shell did not set were read from.
    env_file: Path | None
    run: RunCommand = run_inherited


def resolve_deps(root: Path) -> CreateDeps:
    """The surroundings of a real run. The shell's own values are read first, since the env file loaded next would be indistinguishable from them."""
    shell = ShellEnv(base_url=os.environ.get(BASE_URL_KEY, "").strip() or None, key=os.environ.get(API_KEY_KEY, "").strip() or None)
    env_file = find_env_file(root)
    if env_file is not None:
        load_dotenv(env_file, override=False)
    return CreateDeps(root=root, cwd=Path.cwd(), shell=shell, env_file=env_file)


def assert_template(root: Path) -> None:
    """Refuse anything but the un-bootstrapped template, before anything is fetched.

    Raises:
        CreateError: `pyproject.toml` is unreadable or names another project, or the bootstrap is missing.
    """
    try:
        document = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        msg = f"no readable pyproject.toml in {root}: run this from the project's root."
        raise CreateError(msg) from exc
    project: object = document.get("project")
    name: object = cast("dict[str, Any]", project).get("name") if isinstance(project, dict) else None
    if name != TEMPLATE_NAME:
        msg = (
            f'this is not the un-bootstrapped template: pyproject.toml names "{name}", not "{TEMPLATE_NAME}". make create is '
            "one-shot and has already run, or the project was bootstrapped by hand: a project's method is changed by editing "
            "its method/ directory and running make codegen."
        )
        raise CreateError(msg)
    if not (root / BOOTSTRAP_SCRIPT).is_file():
        msg = f"{BOOTSTRAP_SCRIPT} is missing, and make create runs it to name the project. Restore it from the template."
        raise CreateError(msg)


def bootstrap_flags(identity: Identity, args: CreateArgs) -> list[str]:
    """The bootstrap's flags for this identity, without `--root` and `--dry-run`."""
    # A created project is not a template, and the template's charter paragraph would steer every
    # later agent session toward maintaining one: hence `--clean`.
    flags = ["--name", identity.name, "--title", identity.title, "--description", identity.description, "--clean"]
    for field, flag in BOOTSTRAP_PASSTHROUGH:
        value: object = getattr(args, field)
        if isinstance(value, str):
            flags.extend((flag, value))
    return flags


def print_plan(plan: MethodPlan, identity: Identity, base_url: str, layout: Layout) -> None:
    """Print what the gesture will do: the same lines whether or not it is a rehearsal."""
    output = plan.fetched.pipe_io.pipe_io_contracts[plan.pipe.ref].output
    package = layout.describe(layout.package_dir)
    print(f"create: {identity.title}")
    print(f"  name:        {identity.name} (the distribution and the command; the package becomes {identity.package})")
    print(f"  description: {identity.description}")
    print(f"create: {plan.describe}, via {base_url}")
    print(f"  pipe:   {plan.pipe.ref}")
    print(f"  output: {output.concept_ref}{' (plural: a list of the concept)' if plan.output.plural else ''}")
    print(f"  inputs: {', '.join(option.flag for option in plan.options) or '(none)'}")
    print(f"  writes: {package}/method/, {package}/generated/ and {package}/binding.py")


async def run_create(argv: Sequence[str], deps: CreateDeps | None = None) -> int:
    """The whole `make create` behaviour, exit code included. Never raises: a refusal is a printed message and exit 1."""
    try:
        return await _run_create(argv, deps)
    except (CreateError, PlanError) as exc:
        print(f"create: {exc}", file=sys.stderr)
        return EXIT_FAILED


async def _run_create(argv: Sequence[str], given: CreateDeps | None) -> int:
    args = parse_create_args(argv)
    root = given.root if given is not None else CLI_ROOT
    assert_template(root)
    deps = given if given is not None else resolve_deps(root)
    layout = Layout(root / "src" / PACKAGE)
    if not os.environ.get(API_KEY_KEY, "").strip():
        msg = f"{API_KEY_KEY} is not set. Export it in your shell, and make create copies it into {ENV_FILE}, or put it in {ENV_FILE} yourself."
        raise CreateError(msg)
    try:
        client = api.make_client()
    except AppError as exc:
        raise CreateError(f"{exc.message} {exc.hint or ''}".rstrip()) from exc
    except PipelineRequestError as exc:
        msg = f"{exc}\n  Check {BASE_URL_KEY} in your shell or {ENV_FILE}, or drop it to use the default."
        raise CreateError(msg) from exc

    # ── The read-only half ──
    async with client:
        base_url = client.base_url
        insecure = insecure_base_url_reason(base_url)
        if insecure is not None:
            raise CreateError(insecure)
        method_args = MethodArgs(method=args.method, pipe=args.pipe, named=args.name is not None)
        plan = await plan_method(method_args, client, layout=layout, root=root, cwd=deps.cwd)
    identity = derive_identity(plan, args)
    env_plan = plan_env_file(root, deps.shell, deps.env_file, base_url)
    flags = bootstrap_flags(identity, args)
    bootstrap = [sys.executable, str(root / BOOTSTRAP_SCRIPT), "--root", str(root), *flags]

    print_plan(plan, identity, base_url, layout)
    for warning in plan.warnings:
        print(f"\n! {warning}")
    for note in env_plan.notes:
        print(f"  env:    {note}")
    print("\ncreate: checking the project values with the bootstrap (--dry-run)\n")
    if deps.run([*bootstrap, "--dry-run"], root, None) != 0:
        msg = (
            "the bootstrap refused these values (see above). Nothing was written; pass the flag that fixes it: --name, --title, "
            "--description, or one of the --author-*, --repo-url and --license* flags."
        )
        raise CreateError(msg)

    package = layout.describe(layout.package_dir)
    env_step = {"write": f"write {ENV_FILE}", "keep": f"leave {ENV_FILE} as it is", "skip": f"leave the project without a {ENV_FILE}"}
    steps = [
        f"write the method ({package}/method/, {package}/generated/ and {package}/binding.py)",
        "run the bootstrap with the values above",
        env_step[env_plan.action],
        "re-sync uv.lock and the environment with the renamed project (uv sync)",
        "run make all",
        f"remove {BOOTSTRAP_DIR}/ once make all is green",
    ]
    if args.dry_run:
        print("\nWould then:")
        for number, step in enumerate(steps, start=1):
            print(f"  {number}. {step}")
        print("\nNothing was written (--dry-run).")
        return EXIT_OK

    # ── The write half ──
    def announce(number: int) -> None:
        print(f"\ncreate: {number}/{len(steps)} {steps[number - 1]}\n")

    announce(1)
    try:
        for line in write_method(plan, layout):
            print(f"    {line}")
    except (CodegenSetupError, CodegenError, OSError, RuntimeError) as exc:
        msg = f"writing the method failed: {exc}. What it wrote was removed, so the template is as it was: fix the cause and run make create again."
        raise CreateError(msg) from exc

    announce(2)
    if deps.run(bootstrap, root, None) != 0:
        env_line = [f"cp {ENV_EXAMPLE} {ENV_FILE}   # then set {API_KEY_KEY} in it"] if env_plan.action == "write" else []
        lines = [shlex.join([".venv/bin/python", BOOTSTRAP_SCRIPT, *flags]), *env_line, *REMAINING]
        msg = (
            "the bootstrap failed after the method was written (see above). The method is in place; fix the cause, then finish by "
            "hand, from this directory:\n" + "\n".join(f"  {line}" for line in lines)
        )
        raise CreateError(msg)

    announce(3)
    if env_plan.action == "write" and env_plan.content is not None:
        if write_env_file(root / ENV_FILE, env_plan.content):
            print(f"    wrote {ENV_FILE}")
        else:
            print(f"! {ENV_FILE} appeared while the gesture ran, and is left as it is.")

    announce(4)
    if deps.run(["uv", "sync"], root, environment_without(UV_LOCK_GATES)) != 0:
        msg = f"re-syncing uv.lock failed (see above). The project is created; finish with:\n{remaining(0)}"
        raise CreateError(msg)

    announce(5)
    if deps.run(["make", "all"], root, environment_without(MAKE_VARIABLES)) != 0:
        msg = (
            f"make all is red (see above). The project is created and nothing is committed; fix the cause, never by editing "
            f"src/{identity.package}/generated/, then finish with:\n{remaining(1)}"
        )
        raise CreateError(msg)

    announce(6)
    shutil.rmtree(root / BOOTSTRAP_DIR, ignore_errors=True)
    # The directories that held only the bootstrap go with it.
    for parent in (root / BOOTSTRAP_DIR).parents:
        if parent == root:
            break
        with contextlib.suppress(OSError):
            parent.rmdir()

    command = f".venv/bin/{identity.name}"
    print(
        "\n".join(
            (
                "",
                f"create: done. {identity.title} ({identity.name}) runs the pipe {plan.pipe.ref} of {plan.origin}.",
                "",
                "Nothing is committed: review with `git status` and `git diff`, then commit.",
                "",
                "Next:",
                f"  {command + ' --help':<34}# the method's inputs, one option each",
                f"  {'uv tool install .':<34}# the command on your PATH",
                f"  {'make codegen':<34}# after editing the method, or bumping its tag",
            )
        )
    )
    return EXIT_OK


#: The ordinary commands that finish a project once the bootstrap has run.
REMAINING = ("uv sync", "make all", f"rm -rf {BOOTSTRAP_DIR}   # once make all is green")


def remaining(start: int) -> str:
    """The commands left to run, from the `start`th, one per indented line."""
    return "\n".join(f"  {line}" for line in REMAINING[start:])


def main(argv: Sequence[str]) -> int:
    """The console entry: run the gesture over the real surroundings."""
    try:
        return asyncio.run(run_create(argv))
    except KeyboardInterrupt:
        print("\ncreate: interrupted.", file=sys.stderr)
        return EXIT_INTERRUPTED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
