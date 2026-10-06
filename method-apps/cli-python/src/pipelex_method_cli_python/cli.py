"""The command: one Typer command, which is the app itself, with the run's lifecycle as flags.

The CLI holds one method, for good, and it has exactly one command with no subcommands: the run's
mode is a flag on it (`--blocking`, `--detach`, `--resume <run-id>`), and stdout carries the result
as JSON and nothing else. `lib/run.py` is the lifecycle; this module reads the command line, loads
`.env`, and is the one error boundary, where every SDK error and every failure the CLI detects
itself is presented on stderr.

**The options are built from data rather than written as a function's parameters.** Typer reads a
command's parameters from `inspect.signature`, which honours an assigned `__signature__`, so the
command is a function taking `**values` whose signature is assembled from a list of
`inspect.Parameter`s: the command's own options, `OWN_OPTIONS`, and, once the method's committed
input form is read, one option per declared input. A derived option joins the list; nothing here is
rewritten for it. An input whose flag would collide with one of `OWN_FLAGS` is offered under another
name, and the Python names of the own options are reserved the same way.

**With no method yet**, the template as shipped, the command takes no option: its help says to run
`make create`, and a bare run refuses with that message on stderr and exit code 1.
"""

import asyncio
import inspect
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, NoReturn

import typer
from dotenv import find_dotenv, load_dotenv
from mthds.protocol.exceptions import PipelineRequestError
from rich.console import Console

from pipelex_method_cli_python.lib.app import COMMAND_NAME, AppError, RunMode
from pipelex_method_cli_python.lib.binding import MethodBinding, load_binding
from pipelex_method_cli_python.lib.errors import present_error, print_error
from pipelex_method_cli_python.lib.inputs import read_inputs_file
from pipelex_method_cli_python.lib.run import RunPlan, execute_plan

#: What `make create` takes, as the empty state names it.
CREATE_COMMAND = "make create METHOD=<path/to/bundle | mt_… | github.com/owner/repo[/pkg][@tag]>"

#: The empty state, one sentence per line: the template as shipped holds no method.
EMPTY_STATE_LINES = (
    "This CLI holds no method yet. Turn it into the command for your method by running, in the project's directory:",
    f"  {CREATE_COMMAND}",
    "METHOD is a .mthds file or a directory of them, a method id from your organization's catalog (mt_…), or a published method's address.",
)

#: What a bare run prints on stderr in the empty state.
EMPTY_STATE = "\n".join(EMPTY_STATE_LINES)

#: The empty state's help, one paragraph per line. Click rewraps a paragraph unless a line holding
#: only `\b` opens it, which keeps the `make create` command whole on its line.
EMPTY_STATE_HELP = "\n\n".join((EMPTY_STATE_LINES[0], f"\b\n{EMPTY_STATE_LINES[1]}", EMPTY_STATE_LINES[2]))

#: The exit code of a command line the CLI refuses, as Typer exits for an unknown option.
USAGE_EXIT_CODE = 2

#: The exit code after Ctrl-C, the shell's convention for a process ended by SIGINT.
INTERRUPTED_EXIT_CODE = 130


def _option(name: str, annotation: Any, default: Any) -> inspect.Parameter:
    return inspect.Parameter(name, inspect.Parameter.KEYWORD_ONLY, default=default, annotation=annotation)


#: The command's own options, in the order `--help` lists them. Each is a keyword-only parameter of
#: the command, named for Python by its first argument and for the command line by its flag.
OWN_OPTIONS: tuple[inspect.Parameter, ...] = (
    _option(
        "inputs_file",
        Annotated[
            Path | None,
            typer.Option(
                "--inputs",
                metavar="FILE",
                help=(
                    "A JSON file of the run's inputs, an object mapping each input name to its value, "
                    'as `mthds run --inputs` takes it; "-" reads it from stdin.'
                ),
            ),
        ],
        None,
    ),
    _option(
        "blocking",
        Annotated[
            bool,
            typer.Option(
                "--blocking",
                help="Run in one request instead of a durable run. The hosted gateway cuts a blocking run off at about 30 seconds.",
            ),
        ],
        False,
    ),
    _option(
        "detach",
        Annotated[bool, typer.Option("--detach", help="Start a durable run, print its id alone on stdout, and exit without waiting.")],
        False,
    ),
    _option(
        "resume",
        Annotated[
            str | None,
            typer.Option("--resume", metavar="RUN_ID", help="Wait for a run started earlier and print its result, as an attended run would."),
        ],
        None,
    ),
    _option(
        "out",
        Annotated[Path | None, typer.Option("--out", metavar="DIR", help="Save the files the run produces in DIR instead of outputs/<run-id>/.")],
        None,
    ),
    _option(
        "no_download",
        Annotated[bool, typer.Option("--no-download", help="Do not download the files the run produces.")],
        False,
    ),
)

#: The command line's names of the own options, which a derived input option must not take.
OWN_FLAGS = frozenset({"--inputs", "--blocking", "--detach", "--resume", "--out", "--no-download"})

#: The Python names of the own options, which a derived input option's parameter must not take.
OWN_NAMES = frozenset(parameter.name for parameter in OWN_OPTIONS)


@dataclass(frozen=True)
class LifecycleFlags:
    """The own options as one invocation gave them."""

    inputs_file: Path | None = None
    blocking: bool = False
    detach: bool = False
    resume: str | None = None
    out: Path | None = None
    no_download: bool = False

    @property
    def mode(self) -> RunMode:
        """The run mode the flags choose, attended unless one says otherwise."""
        if self.resume is not None:
            return RunMode.RESUME
        if self.detach:
            return RunMode.DETACH
        if self.blocking:
            return RunMode.BLOCKING
        return RunMode.ATTENDED


def read_flags(values: dict[str, Any]) -> LifecycleFlags:
    """Read the own options out of the values Typer passed the command."""
    return LifecycleFlags(
        inputs_file=values.get("inputs_file"),
        blocking=bool(values.get("blocking", False)),
        detach=bool(values.get("detach", False)),
        resume=values.get("resume"),
        out=values.get("out"),
        no_download=bool(values.get("no_download", False)),
    )


def combination_refusal(flags: LifecycleFlags) -> str | None:
    """Why the flags cannot be used together, or `None` when they can."""
    if flags.resume is not None and not flags.resume.strip():
        return "--resume takes the id of the run to wait for."
    if flags.detach and flags.blocking:
        return "--detach starts a durable run and --blocking runs without one: choose one."
    if flags.resume is not None and flags.blocking:
        return "--resume waits for a durable run, which --blocking does not start: choose one."
    if flags.resume is not None and flags.detach:
        return "--resume waits for a run and --detach does not wait: choose one."
    if flags.resume is not None and flags.inputs_file is not None:
        return "--resume waits for a run that already has its inputs, and --inputs starts a new one: choose one."
    if flags.detach and (flags.out is not None or flags.no_download):
        return "--detach does not wait for the result, so it downloads no file: --out and --no-download apply to the run that collects it."
    if flags.out is not None and flags.no_download:
        return "--out names where the run's files go and --no-download skips them: choose one."
    return None


def plan_from(flags: LifecycleFlags) -> RunPlan:
    """The plan the flags describe, with the inputs file read.

    Raises:
        InputsFileError: The inputs file cannot be read or is not a JSON object.
    """
    if flags.resume is not None:
        return RunPlan(mode=RunMode.RESUME, resume_run_id=flags.resume.strip(), download=not flags.no_download, out_dir=flags.out)
    inputs = read_inputs_file(flags.inputs_file) if flags.inputs_file is not None else {}
    return RunPlan(mode=flags.mode, inputs=inputs, download=not flags.no_download, out_dir=flags.out)


def run_command(binding: MethodBinding, values: dict[str, Any]) -> None:
    """The command's body: check the flags, run the plan in one `asyncio.run`, and present any failure.

    This is the one error boundary. An SDK error or a failure the CLI detected itself is printed on
    stderr by `lib/errors.py` and exits 1; Ctrl-C exits 130, after the lifecycle has said whether and
    how the run can be resumed; anything else is unexpected and crashes with its traceback.
    """
    flags = read_flags(values)
    refusal = combination_refusal(flags)
    if refusal is not None:
        refuse_usage(refusal)
    stderr = Console(stderr=True, soft_wrap=True)
    try:
        plan = plan_from(flags)
        exit_code = asyncio.run(execute_plan(plan, binding=binding, stderr=stderr))
    except KeyboardInterrupt as exc:
        raise typer.Exit(INTERRUPTED_EXIT_CODE) from exc
    except (PipelineRequestError, AppError) as exc:
        print_error(stderr, present_error(exc, mode=flags.mode))
        raise typer.Exit(1) from exc
    if exit_code != 0:
        raise typer.Exit(exit_code)


def refuse_usage(reason: str) -> NoReturn:
    """Refuse a command line the CLI cannot run, on stderr, with the exit code of a usage error."""
    typer.echo(f"Usage error: {reason}\nRun `{COMMAND_NAME} --help` for the options.", err=True)
    raise typer.Exit(USAGE_EXIT_CODE)


def refuse_without_method() -> None:
    """The empty state's command: there is no method to run yet."""
    typer.echo(EMPTY_STATE, err=True)
    raise typer.Exit(1)


def command_parameters(binding: MethodBinding) -> list[inspect.Parameter]:
    """Every option of the method's command: the own options, then one per declared input once those are derived."""
    del binding  # The method's inputs are offered through --inputs until their options are derived from its input form.
    return list(OWN_OPTIONS)


def command_help(binding: MethodBinding) -> str:
    """The method's command's help text."""
    return (
        f"Run the pipe {binding.pipe_ref} through the Pipelex API and print its result as JSON on stdout.\n\n"
        "The run is durable and attended by default: its id goes to stderr at once, and Ctrl-C leaves it going "
        "and prints the --resume command that waits for it again. Produced files are saved under outputs/<run-id>/, "
        "and the run's cost is printed on stderr."
    )


def create_app(binding: MethodBinding | None) -> typer.Typer:
    """The Typer app: the method's command, or the empty state when the package holds no method."""
    app = typer.Typer(add_completion=False, rich_markup_mode=None, pretty_exceptions_show_locals=False)
    if binding is None:
        app.command(help=EMPTY_STATE_HELP)(refuse_without_method)
        return app

    def command(**values: Any) -> None:
        run_command(binding, values)

    # Typer reads the parameters from the signature, which is assembled rather than written.
    setattr(command, "__signature__", inspect.Signature(command_parameters(binding)))
    app.command(help=command_help(binding))(command)
    return app


def load_environment() -> None:
    """Load `.env`, searched for from the working directory upward, without overriding the shell."""
    load_dotenv(find_dotenv(usecwd=True), override=False)


def main() -> None:
    """The console script: load `.env`, find the method, and run the command."""
    load_environment()
    try:
        binding = load_binding()
    except AppError as exc:
        print_error(Console(stderr=True, soft_wrap=True), present_error(exc))
        raise SystemExit(1) from exc
    create_app(binding)()
