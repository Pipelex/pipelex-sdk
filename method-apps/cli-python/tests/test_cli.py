"""The command, end to end over a fake client: what each mode calls, and what lands on stdout and on stderr.

stdout is the contract a script or an agent reads, so these tests assert it exactly: the result's
JSON and nothing else, or a detached run's id alone. Everything a person reads goes to stderr.
"""

import asyncio
import json
import os
import signal
from pathlib import Path

import pytest
from pipelex_sdk.artifact_models import ArtifactItemError, DownloadedArtifact
from pipelex_sdk.errors import ApiResponseError, ArtifactOperationError, PipelineExecuteTimeoutError, RunFailedError, RunLifecycleUnavailableError
from pipelex_sdk.runs import RunResults, RunStatus, WaitForResultOptions

from pipelex_method_cli_python.cli import EMPTY_STATE, OWN_FLAGS, OWN_NAMES, OWN_OPTIONS, load_environment
from pipelex_method_cli_python.lib.app import COMMAND_NAME
from pipelex_method_cli_python.lib.method_source import MethodSource
from pipelex_method_cli_python.lib.output import render_json
from tests.support import IMAGE_OUTPUT, RUN_ID, TEXT_OUTPUT, FakeClient, download_verdict, execute_result, invoke, make_binding, run_results


class TestEmptyState:
    def test_help_says_to_run_make_create(self):
        result = invoke(None, ["--help"])
        assert result.exit_code == 0
        assert "make create METHOD=" in result.stdout
        # The empty state takes no option: there is nothing to run yet.
        assert "--blocking" not in result.stdout

    def test_a_bare_run_refuses_on_stderr(self):
        result = invoke(None, [])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert result.stderr.strip() == EMPTY_STATE


class TestTheCommand:
    def test_help_lists_the_lifecycle_flags_and_no_subcommand(self):
        result = invoke(make_binding(), ["--help"])
        assert result.exit_code == 0
        assert f"Usage: {COMMAND_NAME} [OPTIONS]" in result.stdout
        assert "COMMAND" not in result.stdout
        for flag in OWN_FLAGS:
            assert flag in result.stdout
        assert "greetings.greet" in result.stdout

    def test_the_own_flags_and_names_are_read_off_the_own_options(self):
        # Pinned by hand on purpose: a derivation that reads nothing would leave the collision guard empty.
        assert {"--inputs", "--blocking", "--detach", "--resume", "--out", "--no-download"} == OWN_FLAGS
        assert {parameter.name for parameter in OWN_OPTIONS} == OWN_NAMES


class TestAttended:
    def test_starts_waits_and_prints_the_result_alone_on_stdout(self, fake_client: FakeClient):
        result = invoke(make_binding(), [])
        assert result.exit_code == 0, result.stderr
        assert result.stdout == render_json(TEXT_OUTPUT) + "\n"
        assert json.loads(result.stdout) == TEXT_OUTPUT
        assert f"Run started: {RUN_ID}" in result.stderr
        assert fake_client.waited == [RUN_ID]
        assert fake_client.executed == []
        assert fake_client.entered == fake_client.closed == 1

    def test_the_run_names_the_pipe_and_sends_the_bundle(self, fake_client: FakeClient):
        invoke(make_binding(), [])
        assert fake_client.started == [
            {"pipe_code": "greetings.greet", "inputs": {}, "mthds_contents": ["domain = 'greetings'\n"], "method_id": None, "method_ref": None}
        ]

    def test_a_manifest_names_the_method_instead_of_sending_it(self, fake_client: FakeClient):
        address = "github.com/Pipelex/methods/text_stats@v0.1.1"
        invoke(make_binding(source=MethodSource(method_ref=address)), [])
        assert fake_client.started[0]["method_ref"] == address
        assert fake_client.started[0]["mthds_contents"] is None

    def test_the_inputs_file_is_sent_as_it_is(self, fake_client: FakeClient, tmp_path: Path):
        inputs = {"text": "Hello", "audience": {"concept": "greetings.Audience", "content": {"name": "Marie"}}}
        path = tmp_path / "inputs.json"
        path.write_text(json.dumps(inputs), encoding="utf-8")
        result = invoke(make_binding(), ["--inputs", str(path)])
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"] == inputs

    def test_a_dash_reads_the_inputs_from_stdin(self, fake_client: FakeClient):
        result = invoke(make_binding(), ["--inputs", "-"], stdin='{"text": "from a pipe"}')
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"] == {"text": "from a pipe"}

    @pytest.mark.parametrize(
        ("content", "expected"),
        [
            pytest.param("not json", "not valid JSON", id="not json"),
            pytest.param('["text"]', "holds a JSON list, not an object", id="not an object"),
        ],
    )
    def test_an_inputs_file_that_is_not_a_json_object_is_refused_before_any_run(
        self, fake_client: FakeClient, tmp_path: Path, content: str, expected: str
    ):
        path = tmp_path / "inputs.json"
        path.write_text(content, encoding="utf-8")
        result = invoke(make_binding(), ["--inputs", str(path)])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert expected in result.stderr
        assert fake_client.started == []

    def test_a_missing_inputs_file_is_refused(self, fake_client: FakeClient, tmp_path: Path):
        result = invoke(make_binding(), ["--inputs", str(tmp_path / "nope.json")])
        assert result.exit_code == 1
        assert "Cannot read the inputs file" in result.stderr
        assert fake_client.started == []

    def test_the_status_line_and_the_cost_report_stay_off_stdout(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results(
            TEXT_OUTPUT,
            tokens_usages=[
                {"pipe_code": "greet", "inference_model_name": "gpt-4o", "cost": 0.01, "nb_tokens_by_category": {"input": 10, "output": 5}}
            ],
            usage_assembly_error=None,
        )
        result = invoke(make_binding(), [])
        assert "Total: $0.0100" in result.stderr
        assert "Total" not in result.stdout

    def test_ctrl_c_leaves_the_run_going_and_prints_how_to_resume_it(self, fake_client: FakeClient):
        async def interrupted(options: WaitForResultOptions | None) -> RunResults:
            del options
            # Ctrl-C, as the terminal sends it: `asyncio.run` cancels the wait, and then raises KeyboardInterrupt.
            signal.raise_signal(signal.SIGINT)
            await asyncio.sleep(10)
            msg = "the wait was not cancelled"
            raise AssertionError(msg)

        fake_client.wait_answer = interrupted
        result = invoke(make_binding(), [])
        assert result.exit_code == 130
        assert result.stdout == ""
        assert f"{COMMAND_NAME} --resume {RUN_ID}" in result.stderr

    def test_a_failed_run_reads_out_its_stored_reason(self, fake_client: FakeClient):
        fake_client.wait_answer = RunFailedError("Run finished with status FAILED; no result available", run_id=RUN_ID, status=RunStatus.FAILED)
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert f"Run {RUN_ID} failed" in result.stderr

    def test_a_refused_start_reads_out_the_problem(self, fake_client: FakeClient, refused_start: ApiResponseError):
        fake_client.start_answer = refused_start
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert "Pipe: draft_pitch" in result.stderr
        assert fake_client.waited == []


class TestNoSilentDowngrade:
    def test_a_server_with_no_run_store_is_an_error_naming_blocking(self, fake_client: FakeClient):
        fake_client.start_answer = RunLifecycleUnavailableError("no run store", api_url="http://127.0.0.1:8081")
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert "--blocking" in result.stderr
        # The run is never quietly retried as a blocking one.
        assert fake_client.executed == []

    def test_a_synchronous_only_orchestration_is_an_error_naming_blocking(self, fake_client: FakeClient):
        fake_client.start_answer = ApiResponseError(
            "API POST /v1/start failed (400)",
            api_url="http://127.0.0.1:8081",
            status=400,
            status_text="Bad Request",
            response_body="",
            server_message="Orchestration mode 'direct' cannot honor fire-and-forget delivery. Use /execute instead.",
            error_type="StartRequiresAsyncOrchestration",
        )
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert "--blocking" in result.stderr
        assert fake_client.executed == []


class TestBlocking:
    def test_runs_in_one_request_and_prints_the_same_json(self, fake_client: FakeClient):
        fake_client.execute_answer = execute_result(TEXT_OUTPUT)
        result = invoke(make_binding(), ["--blocking"])
        assert result.exit_code == 0, result.stderr
        assert result.stdout == render_json(TEXT_OUTPUT) + "\n"
        assert fake_client.started == []
        assert fake_client.executed[0]["pipe_code"] == "greetings.greet"

    def test_a_gateway_cut_off_says_to_drop_the_flag(self, fake_client: FakeClient):
        fake_client.execute_answer = PipelineExecuteTimeoutError("timed out", elapsed_seconds=31.0)
        result = invoke(make_binding(), ["--blocking"])
        assert result.exit_code == 1
        assert "without --blocking" in result.stderr

    def test_a_502_on_the_blocking_path_gets_the_same_hint(self, fake_client: FakeClient):
        fake_client.execute_answer = ApiResponseError(
            "API POST /v1/execute failed (502)", api_url="https://api.pipelex.com", status=502, status_text="Bad Gateway", response_body=""
        )
        result = invoke(make_binding(), ["--blocking"])
        assert result.exit_code == 1
        assert "without --blocking" in result.stderr


class TestDetach:
    def test_prints_the_run_id_alone_on_stdout(self, fake_client: FakeClient):
        result = invoke(make_binding(), ["--detach"])
        assert result.exit_code == 0, result.stderr
        assert result.stdout == f"{RUN_ID}\n"
        assert f"{COMMAND_NAME} --resume {RUN_ID}" in result.stderr
        assert fake_client.waited == []


class TestResume:
    def test_waits_for_the_run_and_prints_it_as_an_attended_run(self, fake_client: FakeClient):
        result = invoke(make_binding(), ["--resume", "run-9"])
        assert result.exit_code == 0, result.stderr
        assert result.stdout == render_json(TEXT_OUTPUT) + "\n"
        assert fake_client.waited == ["run-9"]
        assert fake_client.started == []

    def test_a_server_with_no_run_store_says_there_is_nothing_to_resume(self, fake_client: FakeClient):
        fake_client.wait_answer = RunLifecycleUnavailableError("no run store", api_url="http://127.0.0.1:8081")
        result = invoke(make_binding(), ["--resume", "run-9"])
        assert result.exit_code == 1
        assert "--blocking" in result.stderr
        assert "resumed" in result.stderr


class TestFlagCombinations:
    @pytest.mark.parametrize(
        "args",
        [
            pytest.param(["--detach", "--blocking"], id="detach and blocking"),
            pytest.param(["--resume", "run-9", "--blocking"], id="resume and blocking"),
            pytest.param(["--resume", "run-9", "--detach"], id="resume and detach"),
            pytest.param(["--resume", "run-9", "--inputs", "inputs.json"], id="resume and inputs"),
            pytest.param(["--resume", " "], id="blank resume"),
            pytest.param(["--detach", "--out", "files"], id="detach and out"),
            pytest.param(["--detach", "--no-download"], id="detach and no download"),
            pytest.param(["--out", "files", "--no-download"], id="out and no download"),
        ],
    )
    def test_incompatible_flags_are_refused_before_anything_runs(self, fake_client: FakeClient, args: list[str]):
        result = invoke(make_binding(), args)
        assert result.exit_code == 2
        assert result.stdout == ""
        assert "Usage error:" in result.stderr
        assert fake_client.entered == 0


class TestMissingKey:
    def test_a_missing_key_is_refused_before_anything_is_sent(self):
        # No fake: the real `make_client` reads the environment, which the autouse fixture emptied.
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert "PIPELEX_API_KEY is not set" in result.stderr


class TestDownloads:
    def test_a_text_result_downloads_nothing(self, fake_client: FakeClient):
        invoke(make_binding(), [])
        assert fake_client.downloaded_to == []

    def test_produced_files_go_under_outputs_by_run_id(self, fake_client: FakeClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.chdir(tmp_path)
        saved = DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], path=f"outputs/{RUN_ID}/main_stuff.png", size=3)
        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        fake_client.download_answer = download_verdict(saved)
        result = invoke(make_binding(), [])
        assert result.exit_code == 0, result.stderr
        assert fake_client.downloaded_to == [Path("outputs") / RUN_ID]
        assert f"Saved outputs/{RUN_ID}/main_stuff.png" in result.stderr
        # The signed link stays in the result as the method produced it.
        assert json.loads(result.stdout) == IMAGE_OUTPUT

    def test_out_names_the_directory(self, fake_client: FakeClient, tmp_path: Path):
        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        invoke(make_binding(), ["--out", str(tmp_path / "files")])
        assert fake_client.downloaded_to == [tmp_path / "files"]

    def test_no_download_skips_them(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        result = invoke(make_binding(), ["--no-download"])
        assert result.exit_code == 0
        assert fake_client.downloaded_to == []

    def test_a_file_that_did_not_come_down_fails_the_command_after_the_result(self, fake_client: FakeClient, tmp_path: Path):
        failed = DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], error=ArtifactItemError(code="forbidden", detail="Not your run."))
        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        fake_client.download_answer = download_verdict(failed)
        result = invoke(make_binding(), ["--out", str(tmp_path)])
        assert result.exit_code == 1
        assert json.loads(result.stdout) == IMAGE_OUTPUT
        assert "Not your run." in result.stderr
        # Into an empty directory: the SDK never overwrites, so the saved files would come down twice.
        assert f"{COMMAND_NAME} --resume {RUN_ID} --out DIR" in result.stderr

    def test_a_blocking_run_never_offers_to_resume(self, fake_client: FakeClient, tmp_path: Path):
        failed = DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], error=ArtifactItemError(code="forbidden", detail="Not your run."))
        fake_client.execute_answer = execute_result(IMAGE_OUTPUT)
        fake_client.download_answer = download_verdict(failed)
        result = invoke(make_binding(), ["--blocking", "--out", str(tmp_path)])
        assert result.exit_code == 1
        assert f"{COMMAND_NAME} --resume" not in result.stderr
        assert "cannot be resumed" in result.stderr

    def test_a_download_that_raises_still_reports_the_cost(self, fake_client: FakeClient, tmp_path: Path):
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        fake_client.download_answer = ArtifactOperationError("outputs/ is a file")
        result = invoke(make_binding(), ["--out", str(tmp_path)])
        assert result.exit_code == 1
        assert json.loads(result.stdout) == IMAGE_OUTPUT
        assert "No inference calls" in result.stderr
        assert "outputs/ is a file" in result.stderr

    def test_a_second_resume_leaves_the_earlier_download_alone(self, fake_client: FakeClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "outputs" / RUN_ID).mkdir(parents=True)
        (tmp_path / "outputs" / RUN_ID / "main_stuff.png").write_bytes(b"png")
        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        result = invoke(make_binding(), ["--resume", RUN_ID])
        assert result.exit_code == 0, result.stderr
        assert json.loads(result.stdout) == IMAGE_OUTPUT
        assert fake_client.downloaded_to == []
        assert "none were fetched" in result.stderr

    def test_a_text_result_never_names_the_default_directory(self, fake_client: FakeClient):
        # A run id that cannot name a directory matters only once there is a file to save.
        fake_client.wait_answer = run_results(TEXT_OUTPUT, run_id="run.1")
        result = invoke(make_binding(), [])
        assert result.exit_code == 0, result.stderr
        assert fake_client.downloaded_to == []

    def test_a_run_id_that_cannot_name_a_directory_asks_for_out(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, run_id="../escape")
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert "--out DIR" in result.stderr
        assert fake_client.downloaded_to == []


class TestPluralOutput:
    @pytest.mark.parametrize(
        "main_stuff",
        [
            pytest.param({"items": [{"text": "a"}, {"text": "b"}]}, id="the envelope"),
            pytest.param([{"text": "a"}, {"text": "b"}], id="the bare list"),
        ],
    )
    def test_both_wire_shapes_print_as_the_same_list(self, fake_client: FakeClient, main_stuff: object):
        fake_client.wait_answer = run_results(main_stuff)
        result = invoke(make_binding(output_is_list=True), [])
        assert result.exit_code == 0, result.stderr
        assert json.loads(result.stdout) == [{"text": "a"}, {"text": "b"}]

    def test_a_single_output_with_an_items_field_is_printed_as_it_came(self, fake_client: FakeClient):
        output = {"items": ["eggs", "milk"]}
        fake_client.wait_answer = run_results(output)
        result = invoke(make_binding(output_is_list=False), [])
        assert json.loads(result.stdout) == output

    def test_a_plural_output_in_neither_shape_is_refused(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results({"text": "one"})
        result = invoke(make_binding(output_is_list=True), [])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert "not the list binding.py declares" in result.stderr

    def test_a_refused_shape_still_brings_the_files_down_and_reports_the_cost(self, fake_client: FakeClient, tmp_path: Path):
        # The run is paid for and its links expire: only the printing is refused.
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        result = invoke(make_binding(output_is_list=True), ["--out", str(tmp_path)])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert fake_client.downloaded_to == [tmp_path]
        assert "No inference calls" in result.stderr
        assert "not the list binding.py declares" in result.stderr


class TestEnvironment:
    def test_dotenv_is_found_upward_and_never_overrides_the_shell(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        (tmp_path / ".env").write_text('PIPELEX_API_KEY="from-dotenv"\nPIPELEX_BASE_URL="https://dotenv.example.com"\n', encoding="utf-8")
        nested = tmp_path / "a" / "b"
        nested.mkdir(parents=True)
        monkeypatch.chdir(nested)
        # Registered with monkeypatch first, so the value the .env file writes is undone after the test.
        monkeypatch.setenv("PIPELEX_API_KEY", "placeholder")
        monkeypatch.delenv("PIPELEX_API_KEY")
        monkeypatch.setenv("PIPELEX_BASE_URL", "https://shell.example.com")
        load_environment()
        assert os.environ["PIPELEX_API_KEY"] == "from-dotenv"
        assert os.environ["PIPELEX_BASE_URL"] == "https://shell.example.com"
