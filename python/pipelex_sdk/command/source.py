"""The method as each route names it, and the one pipe I/O call that checks it.

A bundle read from disk travels to the pipe I/O route and the input preparation as the method's tree,
each file's text under its name in the bundle, which is its tree path from the directory `--method`
names: the client sends it as the `files` map, inline when it is small and by hash otherwise. It
travels to the run as the Pipelex API's `mthds_contents`, in the bundle's order, riding the client's
`extra`. An address travels as `method_ref` and a catalog id as `method_id`, both resolved by the server.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, TypeAlias

from pydantic import ValidationError

from pipelex_sdk.command.io import EXIT_FAILED, CommandError
from pipelex_sdk.command.loop import before_request
from pipelex_sdk.command.present import METHOD_DOES_NOT_LOAD_SENTENCE, load_failure_lines
from pipelex_sdk.crate_models import CrateInvalidReport, PipeIORequest, PipeIOValidReport
from pipelex_sdk.errors import ApiResponseError

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
    """The method as the crate routes and the input preparation name it: exactly one is set.

    A bundle is its tree's `contents`, each file's text by tree path, which the client prepares as it
    prepares a save's.
    """

    contents: dict[str, bytes | str] | None = None
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
            contents: dict[str, bytes | str] = {file.name: file.content for file in source.files}
            return CrateSelector(contents=contents)
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
            selected, describes it with a malformed input form, or says neither that the method
            loads nor why it does not. A refusal of the request itself, and an answer that is not
            JSON, propagate as the SDK's `ApiResponseError`.
    """
    selector = crate_selector(source)
    request = PipeIORequest(contents=selector.contents, method_ref=selector.method_ref, method_id=selector.method_id, pipe_ref=pipe)
    await before_request()
    try:
        answer = await client.pipe_io(request)
    except ApiResponseError as exc:
        # JSON the client cannot parse is raised as an answer it cannot read, pydantic's refusal as its
        # cause: it is worded here as what is wrong with the answer, in the sentences `@pipelex/sdk`'s
        # command prints for the same answer. A `pipe_ref` that is missing or not a string, or an
        # `input_form` that is missing or not a mapping, does not describe the pipe; an entry in it
        # that does not parse is a malformed input form.
        cause = exc.__cause__
        if not isinstance(cause, ValidationError):
            raise
        locs = [error["loc"] for error in cause.errors()]
        input_form_locs = [loc for loc in locs if loc[1:2] == ("input_form",)]
        if any(len(loc) > 2 for loc in input_form_locs):
            msg = "the API's pipe I/O answer describes the pipe it selected with a malformed input form."
        elif input_form_locs or any(loc[1:] == ("pipe_ref",) for loc in locs):
            msg = "the API's pipe I/O answer does not describe the pipe it selected."
        else:
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
