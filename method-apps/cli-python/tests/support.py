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
from pipelex_sdk.execute_result import PipelexExecuteResult
from pipelex_sdk.runs import PipelexRunResultStart, PollInfo, RunResults, WaitForResultOptions
from pydantic import BaseModel
from typer.testing import CliRunner, Result

from pipelex_method_cli_python.cli import create_app
from pipelex_method_cli_python.lib.app import COMMAND_NAME
from pipelex_method_cli_python.lib.binding import MethodBinding
from pipelex_method_cli_python.lib.method_source import MethodSource

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


class Greeting(BaseModel):
    """A model standing in for one the codegen writes."""

    text: str


def make_binding(*, output_is_list: bool = False, source: MethodSource | None = None) -> MethodBinding:
    """A binding as `make create` would leave one, without a generated tree on disk."""
    return MethodBinding(
        pipe_ref="greetings.greet",
        output_model=Greeting,
        output_is_list=output_is_list,
        source=source or MethodSource(mthds_contents=("domain = 'greetings'\n",)),
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

    async def download_artifacts(self, *, results: RunResults, dir_path: Path) -> DownloadArtifactsResult:
        del results
        self.downloaded_to.append(dir_path)
        answer = self.download_answer
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, DownloadArtifactsResult):
            return answer
        return await answer()


def invoke(binding: MethodBinding | None, args: list[str], *, stdin: str | None = None) -> Result:
    """Run the command as a person would, with stdout and stderr kept apart."""
    return CliRunner().invoke(create_app(binding), args, input=stdin, prog_name=COMMAND_NAME, catch_exceptions=False)
