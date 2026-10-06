"""What the tests share: a fake client in place of the one `lib/client.py` builds, results as the SDK hands them back, and a binding.

The fake replaces `lib.client.make_client`, the one place a `PipelexAPIClient` is constructed, so
every code path under test runs as it does for real down to the client's methods. The `pipelex_sdk`
package itself is never mocked: the results, the errors and the verdicts the fake hands back are the
SDK's own types, built the way the SDK builds them.
"""

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from pipelex_sdk.artifact_models import ArtifactScope, DownloadArtifactsResult, DownloadedArtifact
from pipelex_sdk.crate_models import PipeIORequest, PipeIOValidReport
from pipelex_sdk.execute_result import PipelexExecuteResult
from pipelex_sdk.prepare_inputs import PreparedInputs
from pipelex_sdk.prepare_inputs import prepare_inputs as sdk_prepare_inputs
from pipelex_sdk.product_models import UploadedFile, UploadInput
from pipelex_sdk.runs import PipelexRunResultStart, PollInfo, RunResults, WaitForResultOptions
from pydantic import BaseModel, ConfigDict
from typer.testing import CliRunner, Result

from pipelex_method_cli_python.cli import create_app
from pipelex_method_cli_python.lib.app import COMMAND_NAME
from pipelex_method_cli_python.lib.binding import MethodBinding
from pipelex_method_cli_python.lib.contracts import ContractsDocument, PipeContracts, contracts_for_pipe, parse_contracts
from pipelex_method_cli_python.lib.method_source import MethodSource

#: The test fixtures' directory.
FIXTURES = Path(__file__).parent / "fixtures"

#: The contracts recorded from `webapp-js`'s fixtures by the family's wire-table recorder, one file per fixture.
WIRE_CONTRACTS = FIXTURES / "wire" / "contracts"

#: The pipe the default binding runs.
GREET = "greetings.greet"

#: A native `Text` content model's schema, as the engine states it.
TEXT_SCHEMA: dict[str, Any] = {
    "description": "A text",
    "properties": {"text": {"description": "The text", "title": "Text", "type": "string"}},
    "required": ["text"],
    "title": "native.Text",
    "type": "object",
}

#: The run id the fake's `start` answers with unless a test says otherwise.
RUN_ID = "run-1"

#: A text result, the shape a native `Text` output arrives in.
TEXT_OUTPUT: dict[str, Any] = {"text": "Bonjour, Marie — ça va ?"}

#: The shape the hosted runtime really returns for an image: the durable storage reference, beside the
#: short-lived signed link. Only the first is what the artifact stack walks.
IMAGE_OUTPUT: dict[str, Any] = {"url": f"pipelex-storage://{RUN_ID}/cat.png", "public_url": "https://cdn.example.com/signed/cat.png"}

#: An output referencing two stored files, so a download can be partly done.
TWO_FILES_OUTPUT: dict[str, Any] = {
    "first": {"url": f"pipelex-storage://{RUN_ID}/first.png"},
    "second": {"url": f"pipelex-storage://{RUN_ID}/second.png"},
}


#: The runtime's absence document, which a successful durable run delivers for an optional output it left absent.
ABSENCE_OUTPUT: dict[str, Any] = {
    "absent": True,
    "variable_name": "greeting",
    "kind": "skipped",
    "reason": "The condition chose no branch.",
    "producing_pipe": None,
    "upstream": None,
}


class Greeting(BaseModel):
    """A model standing in for one the codegen writes."""

    text: str


class AnyOutput(BaseModel):
    """A model that accepts any object, for the tests about something other than the output's validation."""

    model_config = ConfigDict(extra="allow")


def wire_contracts(fixture: str) -> ContractsDocument:
    """The contracts of one of `webapp-js`'s fixtures, as the wire-table recorder wrote them."""
    path = WIRE_CONTRACTS / f"{fixture}.json"
    return parse_contracts(path.read_text(encoding="utf-8"), origin=str(path))


def greet_contracts(
    *,
    output_is_list: bool = False,
    output_optional: bool = False,
    inputs: dict[str, Any] | None = None,
    fields: list[dict[str, Any]] | None = None,
) -> PipeContracts:
    """The contracts of the default pipe: no input unless a test gives some, and a text output, a list of them when plural.

    `output_optional` declares the output optional, which a successful run may leave absent.
    """
    text_node = {"kind": "prose", "concept_ref": "native.Text", "required": True}
    output_field = {**text_node, "kind": "list", "item": text_node} if output_is_list else text_node
    document = ContractsDocument.model_validate(
        {
            "comment": "Hand-built for the tests.",
            "pipe_io_contracts": {
                GREET: {
                    "inputs": inputs or {},
                    "output": {
                        "concept_ref": "native.Text",
                        "multiplicity": "variable" if output_is_list else "single",
                        "item_count": None,
                        "optional": output_optional,
                        "json_schema": {"type": "array", "items": TEXT_SCHEMA} if output_is_list else TEXT_SCHEMA,
                    },
                }
            },
            "input_form": {GREET: {"fields": fields or []}},
            "output_form": {GREET: {"field": {**output_field, "name": "output"}}},
        }
    )
    return contracts_for_pipe(document, GREET)


def text_inputs(*names: str, optional: tuple[str, ...] = ()) -> dict[str, Any]:
    """`greet_contracts`' keyword arguments for a pipe taking each name as a `native.Text` input, required unless listed as optional."""
    inputs: dict[str, Any] = {}
    fields: list[dict[str, Any]] = []
    for name in names:
        is_optional = name in optional
        presence = "optional" if is_optional else "plain"
        inputs[name] = {"concept_ref": "native.Text", "presence": presence, "multiplicity": "single", "item_count": None, "json_schema": TEXT_SCHEMA}
        fields.append(
            {"kind": "prose", "name": name, "concept_ref": "native.Text", "description": f"The {name}", "presence": presence}
            | {"required": not is_optional, "gating": not is_optional}
        )
    return {"inputs": inputs, "fields": fields}


def make_binding(
    *,
    output_is_list: bool = False,
    source: MethodSource | None = None,
    contracts: PipeContracts | None = None,
    output_model: type[BaseModel] = AnyOutput,
) -> MethodBinding:
    """A binding as `make create` would leave one, without a generated tree on disk.

    The default pipe takes no input, and its output model accepts any object, so a test about
    something else is not held to either.
    """
    pipe = contracts or greet_contracts(output_is_list=output_is_list)
    return MethodBinding(
        pipe_ref=pipe.pipe_ref,
        output_model=output_model,
        output_is_list=output_is_list,
        source=source or MethodSource(mthds_contents=("domain = 'greetings'\n",)),
        contracts=pipe,
    )


def pipe_io_report(document: ContractsDocument) -> PipeIOValidReport:
    """The answer `POST /v1/pipe-io` gives for a method whose contracts are `document`."""
    payloads = document.model_dump(mode="json", exclude={"comment"})
    return PipeIOValidReport.model_validate(
        {"is_valid": True, "pipe_ref": None, "default_pipe_ref": None, "pending_signatures": [], "is_runnable": True, **payloads}
    )


def run_results(main_stuff: object, *, run_id: str = RUN_ID, **fields: Any) -> RunResults:
    """A completed run's results, validated from the wire as a real one is.

    The hosted body relays the usage pair as keys of their own, `null` when usage was off, so they
    are carried unless a test passes them.
    """
    body: dict[str, Any] = {"pipeline_run_id": run_id, "main_stuff": main_stuff, "tokens_usages": None, "usage_assembly_error": None}
    return RunResults.model_validate({**body, **fields})


def execute_result(content: object, *, run_id: str = RUN_ID) -> PipelexExecuteResult:
    """A blocking run's response, whose `main_stuff_name` names the working-memory root holding `content`."""
    return PipelexExecuteResult.model_validate(
        {
            "pipeline_run_id": run_id,
            "main_stuff_name": "result",
            "pipe_output": {
                "working_memory": {"root": {"result": {"concept": "native.Text", "content": content}}, "aliases": {"main_stuff": "result"}},
                "pipeline_run_id": run_id,
            },
        }
    )


def download_verdict(*artifacts: DownloadedArtifact) -> DownloadArtifactsResult:
    """A download verdict over the given outcomes, as `download_artifacts` answers one."""
    saved = [artifact.path for artifact in artifacts if artifact.path is not None]
    return DownloadArtifactsResult(
        scope=ArtifactScope.MAIN_STUFF, artifacts=list(artifacts), saved_paths=saved, all_saved=len(saved) == len(artifacts)
    )


#: What the fake's `wait_for_result` answers: results, an error to raise, or a coroutine to run instead.
WaitAnswer = RunResults | BaseException | Callable[[WaitForResultOptions | None], Awaitable[RunResults]]

#: What the fake's `start` answers: a run id, an error to raise, or a coroutine to run instead.
StartAnswer = str | BaseException | Callable[[], Awaitable[str]]

#: What the fake's `download_artifacts` answers: a verdict, an error to raise, or a coroutine to run instead.
DownloadAnswer = DownloadArtifactsResult | BaseException | Callable[[], Awaitable[DownloadArtifactsResult]]


class FakeClient:
    """Stands in for `PipelexAPIClient`: records every call and answers what the test set."""

    def __init__(self) -> None:
        self.start_answer: StartAnswer = RUN_ID
        self.execute_answer: PipelexExecuteResult | BaseException = execute_result({"text": "hi"})
        self.wait_answer: WaitAnswer = run_results(TEXT_OUTPUT)
        self.download_answer: DownloadAnswer = download_verdict()
        self.started: list[dict[str, Any]] = []
        self.executed: list[dict[str, Any]] = []
        self.waited: list[str] = []
        self.downloaded_to: list[Path] = []
        self.entered = 0
        self.closed = 0
        #: What `pipe_io` answers, which the SDK's `prepare_inputs` reads the pipe's signature from.
        self.pipe_io_answer: PipeIOValidReport | None = None
        #: The reference each uploaded file's name is answered with.
        self.upload_uris: dict[str, str] = {}
        self.uploaded: list[str] = []
        self.pipe_io_asked: list[PipeIORequest] = []
        self.prepared: list[dict[str, Any]] = []

    async def __aenter__(self) -> "FakeClient":
        self.entered += 1
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        self.closed += 1

    async def start(self, **kwargs: Any) -> PipelexRunResultStart:
        self.started.append(kwargs)
        answer = self.start_answer
        if isinstance(answer, BaseException):
            raise answer
        run_id = answer if isinstance(answer, str) else await answer()
        return PipelexRunResultStart(pipeline_run_id=run_id)

    async def execute(self, **kwargs: Any) -> PipelexExecuteResult:
        self.executed.append(kwargs)
        if isinstance(self.execute_answer, BaseException):
            raise self.execute_answer
        return self.execute_answer

    async def wait_for_result(self, run_id: str, options: WaitForResultOptions | None = None) -> RunResults:
        self.waited.append(run_id)
        answer = self.wait_answer
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, RunResults):
            if options is not None and options.on_poll is not None:
                options.on_poll(PollInfo(attempt=1, elapsed_seconds=2.0))
            return answer
        return await answer(options)

    async def pipe_io(self, request: PipeIORequest) -> PipeIOValidReport:
        """The test's answer, narrowed to the pipe the request selects, as the route narrows it."""
        self.pipe_io_asked.append(request)
        if self.pipe_io_answer is None:
            msg = "the test set no pipe_io answer"
            raise AssertionError(msg)
        return self.pipe_io_answer.model_copy(update={"pipe_ref": request.pipe_ref})

    async def upload(self, upload_input: UploadInput) -> UploadedFile:
        self.uploaded.append(upload_input.filename)
        uri = self.upload_uris.get(upload_input.filename, f"pipelex-storage://uploads/{upload_input.filename}")
        return UploadedFile(uri=uri, filename=upload_input.filename)

    async def prepare_inputs(self, **kwargs: Any) -> PreparedInputs:
        """The SDK's own preparation, over this fake's `pipe_io` and `upload`."""
        self.prepared.append(kwargs)
        return await sdk_prepare_inputs(self, **kwargs)

    async def download_artifacts(self, *, results: RunResults, dir_path: Path) -> DownloadArtifactsResult:
        del results
        self.downloaded_to.append(dir_path)
        answer = self.download_answer
        if isinstance(answer, BaseException):
            raise answer
        verdict = answer if isinstance(answer, DownloadArtifactsResult) else await answer()
        # As the SDK does, each file the verdict says was saved is on disk, at its size.
        for artifact in verdict.artifacts:
            if artifact.path is not None:
                saved = Path(artifact.path)
                saved.parent.mkdir(parents=True, exist_ok=True)
                saved.write_bytes(b"x" * (artifact.size or 0))
        return verdict


def invoke(binding: MethodBinding | None, args: list[str], *, stdin: str | None = None) -> Result:
    """Run the command as a person would, with stdout and stderr kept apart."""
    return CliRunner().invoke(create_app(binding), args, input=stdin, prog_name=COMMAND_NAME, catch_exceptions=False)
