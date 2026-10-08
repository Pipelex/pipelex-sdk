"""The method as each route names it, and the one pipe I/O call that checks it.

A bundle read from disk travels to the pipe I/O route and the input preparation as `files`, each file
under its name in the bundle, and to the run as `mthds_contents`, in the same order. An address
travels as `method_ref` and a catalog id as `method_id`, both resolved by the server.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, TypeAlias

from pydantic import ValidationError

from pipelex_sdk.command.io import EXIT_FAILED, CommandError
from pipelex_sdk.command.present import METHOD_DOES_NOT_LOAD_SENTENCE, load_failure_lines
from pipelex_sdk.crate_models import CrateInvalidReport, MthdsFileItem, PipeIORequest, PipeIOValidReport

if TYPE_CHECKING:
    from mthds.protocol.input_form import PipeInputFormDescriptor

    from pipelex_sdk.client import PipelexAPIClient
    from pipelex_sdk.command.bundle import BundleFile


@dataclass(frozen=True)
class BundleSource:
    """A bundle read from disk."""

    files: tuple[BundleFile, ...]


@dataclass(frozen=True)
class AddressSource:
    """A published method's address."""

    method_ref: str


@dataclass(frozen=True)
class CatalogSource:
    """A stored method's catalog id."""

    method_id: str


#: A method the command can send.
MethodSource: TypeAlias = BundleSource | AddressSource | CatalogSource


@dataclass(frozen=True)
class CrateSelector:
    """The method as the crate routes and the input preparation name it: exactly one is set."""

    files: list[MthdsFileItem] | None = None
    method_ref: str | None = None
    method_id: str | None = None


@dataclass(frozen=True)
class RunSelector:
    """The method as the run routes name it: exactly one is set."""

    mthds_contents: list[str] | None = None
    method_ref: str | None = None
    method_id: str | None = None


def crate_selector(source: MethodSource) -> CrateSelector:
    match source:
        case BundleSource():
            return CrateSelector(files=[MthdsFileItem(content=file.content, source=file.name) for file in source.files])
        case AddressSource():
            return CrateSelector(method_ref=source.method_ref)
        case CatalogSource():
            return CrateSelector(method_id=source.method_id)


def run_selector(source: MethodSource) -> RunSelector:
    match source:
        case BundleSource():
            return RunSelector(mthds_contents=[file.content for file in source.files])
        case AddressSource():
            return RunSelector(method_ref=source.method_ref)
        case CatalogSource():
            return RunSelector(method_id=source.method_id)


@dataclass(frozen=True)
class DescribedPipe:
    """A pipe I/O answer's valid arm: the pipe it selected and that pipe's input form."""

    pipe_ref: str
    descriptor: PipeInputFormDescriptor


async def describe_pipe(client: PipelexAPIClient, source: MethodSource, pipe: str | None) -> DescribedPipe:
    """Ask `POST /v1/pipe-io` for the pipe the method and `--pipe` select, which spends no inference:
    the same selection the run's input preparation makes.

    Raises:
        CommandError: When the method does not load, or the answer does not describe the pipe it
            selected. A refusal of the request itself propagates as the SDK's `ApiResponseError`.
    """
    selector = crate_selector(source)
    request = PipeIORequest(files=selector.files, method_ref=selector.method_ref, method_id=selector.method_id, pipe_ref=pipe)
    try:
        answer = await client.pipe_io(request)
    except ValidationError as exc:
        msg = "the API's pipe I/O answer says neither that the method loads nor why it does not."
        raise CommandError(msg, exit_code=EXIT_FAILED) from exc
    match answer:
        case CrateInvalidReport():
            details = load_failure_lines(answer.validation_errors, answer.message)
            raise CommandError(METHOD_DOES_NOT_LOAD_SENTENCE, exit_code=EXIT_FAILED, details=details)
        case PipeIOValidReport():
            pipe_ref = answer.pipe_ref
            descriptor = answer.input_form.get(pipe_ref) if pipe_ref is not None else None
            if pipe_ref is None or descriptor is None:
                msg = "the API's pipe I/O answer does not describe the pipe it selected."
                raise CommandError(msg, exit_code=EXIT_FAILED)
            return DescribedPipe(pipe_ref=pipe_ref, descriptor=descriptor)
