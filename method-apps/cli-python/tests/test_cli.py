"""The command, end to end over a fake client: what each mode calls, and what lands on stdout and on stderr.

stdout is the contract a script or an agent reads, so these tests assert it exactly: the result's
JSON and nothing else, or a detached run's id alone. Everything a person reads goes to stderr.
"""

import asyncio
import json
import os
import signal
from pathlib import Path
from typing import Any

import httpx
import pytest
import typer
from pipelex_sdk.artifact_models import ArtifactItemError, DownloadArtifactsResult, DownloadedArtifact
from pipelex_sdk.errors import (
    ApiResponseError,
    ApiUnreachableError,
    ArtifactOperationError,
    PipelineExecuteTimeoutError,
    RunFailedError,
    RunLifecycleUnavailableError,
)
from pipelex_sdk.runs import RunResults, RunStatus, WaitForResultOptions
from pydantic import ValidationError

from pipelex_method_cli_python.cli import (
    EMPTY_STATE,
    OWN_FLAGS,
    OWN_OPTIONS,
    RESERVED_FLAGS,
    LifecycleFlags,
    load_environment,
    read_flags,
)
from pipelex_method_cli_python.lib import output
from pipelex_method_cli_python.lib.app import COMMAND_NAME, RunMode
from pipelex_method_cli_python.lib.contracts import contracts_for_pipe
from pipelex_method_cli_python.lib.inputs import PARAMETER_PREFIX, InputOptionsError
from pipelex_method_cli_python.lib.method_source import MethodSource
from pipelex_method_cli_python.lib.output import render_json
from tests.support import (
    ABSENCE_OUTPUT,
    IMAGE_OUTPUT,
    RUN_ID,
    TEXT_OUTPUT,
    TWO_FILES_OUTPUT,
    FakeClient,
    Greeting,
    download_verdict,
    execute_result,
    greet_contracts,
    invoke,
    make_binding,
    pipe_io_report,
    run_results,
    text_inputs,
    wire_contracts,
)


class TestEmptyState:
    def test_help_says_there_is_no_method(self):
        result = invoke(None, ["--help"])
        assert result.exit_code == 0
        assert "holds no method" in result.stdout
        # template-only:begin
        assert "make create METHOD=" in result.stdout
        # template-only:end
        # The empty state takes no option: there is nothing to run.
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

    def test_the_own_flags_are_read_off_the_own_options(self):
        # Pinned by hand on purpose: a derivation that reads nothing would leave the collision guard empty.
        assert {"--inputs", "--inputs-template", "--blocking", "--detach", "--resume", "--out", "--no-download"} == OWN_FLAGS
        assert RESERVED_FLAGS == OWN_FLAGS | {"--help"}

    def test_no_own_option_takes_a_name_in_the_inputs_namespace(self):
        # An input's parameter is `input_<name>`, and only flags are checked for collisions: an own
        # option named in that namespace would let an input's value overwrite it.
        assert OWN_OPTIONS
        assert [parameter.name for parameter in OWN_OPTIONS if parameter.name.startswith(PARAMETER_PREFIX)] == []


class TestLifecycleFlags:
    """The own options are declared once, as the fields of `LifecycleFlags`, and everything else is read off them."""

    def test_each_own_option_is_a_field_with_its_default(self):
        defaults = LifecycleFlags()
        assert [parameter.name for parameter in OWN_OPTIONS] == [name for name in vars(defaults)]
        for parameter in OWN_OPTIONS:
            assert parameter.default == getattr(defaults, parameter.name)

    def test_an_invocation_with_no_flag_reads_as_the_defaults(self):
        assert read_flags({}) == LifecycleFlags()
        assert read_flags({}).mode is RunMode.ATTENDED

    def test_each_value_typer_passes_lands_on_its_field(self):
        values = {"inputs_file": Path("in.json"), "blocking": True, "out": Path("files"), "input_text": "ignored"}
        flags = read_flags(values)
        assert (flags.inputs_file, flags.blocking, flags.out, flags.detach) == (Path("in.json"), True, Path("files"), False)
        assert flags.mode is RunMode.BLOCKING


class TestInputOptions:
    """One option per declared input, derived from the committed input form when the command loads."""

    def test_help_lists_each_input_before_the_own_options(self):
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name", "mood", optional=("mood",)))), ["--help"])
        assert result.exit_code == 0
        options = result.stdout[result.stdout.index("Options:") :]
        assert options.index("--name") < options.index("--mood") < options.index("--inputs ")
        # Click wraps the help to the terminal's width.
        flowing = " ".join(result.stdout.split())
        assert "The name. Text, or @FILE to read it from a file and @- from stdin. Required." in flowing
        assert "The mood. Text, or @FILE to read it from a file and @- from stdin. Optional." in flowing

    def test_every_kind_gets_its_style_of_option(self):
        contracts = contracts_for_pipe(wire_contracts("every-kind"), "every_kind.take_everything")
        result = invoke(make_binding(contracts=contracts), ["--help"])
        assert result.exit_code == 0
        for shown in ("--agreed / --no-agreed", "--count INTEGER", "--amount N", "--picture PATH|URL", "--lines JSON", "--checks true|false"):
            assert shown in result.stdout

    def test_an_option_sends_its_input_as_the_form_would(self, fake_client: FakeClient):
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--name", "Marie"])
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"] == {"name": {"concept": "native.Text", "content": {"text": "Marie"}}}

    def test_an_at_path_reads_the_value_from_a_file(self, fake_client: FakeClient, tmp_path: Path):
        (tmp_path / "name.txt").write_text("Marie\n", encoding="utf-8")
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--name", f"@{tmp_path / 'name.txt'}"])
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"]["name"]["content"] == {"text": "Marie\n"}

    def test_a_double_at_stands_for_a_literal_at(self, fake_client: FakeClient):
        invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--name", "@@marie"])
        assert fake_client.started[0]["inputs"]["name"]["content"] == {"text": "@marie"}

    def test_stdin_is_read_by_one_option_only(self, fake_client: FakeClient):
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--inputs", "-", "--name", "@-"], stdin="{}")
        assert result.exit_code == 2
        assert "--name reads stdin, which --inputs reads already" in result.stderr
        assert fake_client.entered == 0

    def test_a_missing_required_input_is_a_usage_error_naming_its_option(self, fake_client: FakeClient):
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name", "mood", optional=("mood",)))), [])
        assert result.exit_code == 2
        assert result.stdout == ""
        assert "The run needs name (--name)" in result.stderr
        assert "mood" not in result.stderr.split("Run `")[0]
        assert fake_client.entered == 0

    def test_an_integer_too_long_to_read_is_a_usage_error_naming_its_option(self, fake_client: FakeClient):
        # Past the interpreter's limit on an integer string's digits, `int()` raises a bare ValueError.
        contracts = contracts_for_pipe(wire_contracts("every-kind"), "every_kind.take_everything")
        result = invoke(make_binding(contracts=contracts), ["--count", "9" * 5000])
        assert result.exit_code == 2
        assert result.stdout == ""
        assert "Usage error: --count takes a number of at most" in result.stderr
        assert fake_client.entered == 0

    def test_the_inputs_file_can_give_a_required_input(self, fake_client: FakeClient, tmp_path: Path):
        path = tmp_path / "inputs.json"
        path.write_text(json.dumps({"name": "Marie"}), encoding="utf-8")
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--inputs", str(path)])
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"] == {"name": "Marie"}

    def test_an_option_overrides_the_same_input_in_the_file(self, fake_client: FakeClient, tmp_path: Path):
        path = tmp_path / "inputs.json"
        path.write_text(json.dumps({"name": "Marie", "mood": "calm"}), encoding="utf-8")
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name", "mood"))), ["--inputs", str(path), "--mood", "bright"])
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"] == {"name": "Marie", "mood": {"concept": "native.Text", "content": {"text": "bright"}}}

    def test_an_input_option_with_resume_is_refused(self, fake_client: FakeClient):
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--resume", RUN_ID, "--name", "Marie"])
        assert result.exit_code == 2
        assert "--resume waits for a run that already has its inputs, and --name would start a new one" in result.stderr
        assert fake_client.entered == 0

    def test_an_input_named_like_an_own_option_is_offered_under_input(self, fake_client: FakeClient):
        binding = make_binding(contracts=greet_contracts(**text_inputs("out", "resume")))
        help_text = invoke(binding, ["--help"]).stdout
        assert "--input-out" in help_text
        assert "--input-resume" in help_text
        result = invoke(binding, ["--input-out", "left", "--input-resume", "right"])
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"]["out"]["content"] == {"text": "left"}

    def test_an_input_that_can_take_no_flag_is_refused_when_the_command_loads(self):
        # `input_out` would take `--input-out`, which the renamed `out` needs.
        contracts = greet_contracts(**text_inputs("input_out", "out"))
        with pytest.raises(InputOptionsError, match="neither as --out nor as --input-out"):
            invoke(make_binding(contracts=contracts), ["--help"])

    def test_a_local_file_is_uploaded_before_the_run(self, fake_client: FakeClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        document = wire_contracts("summarize-pdf")
        contracts = contracts_for_pipe(document, "summarize_pdf.summarize_pdf")
        monkeypatch.chdir(tmp_path)
        (tmp_path / "report.pdf").write_bytes(b"%PDF-1.7")
        fake_client.pipe_io_answer = pipe_io_report(document)
        result = invoke(make_binding(contracts=contracts), ["--document", "report.pdf"])
        assert result.exit_code == 0, result.stderr
        assert fake_client.uploaded == ["report.pdf"]
        assert fake_client.prepared[0]["pipe_ref"] == "summarize_pdf.summarize_pdf"
        assert fake_client.started[0]["inputs"]["document"]["content"] == {"url": "pipelex-storage://uploads/report.pdf", "filename": "report.pdf"}
        assert "Uploaded report.pdf as pipelex-storage://uploads/report.pdf" in result.stderr

    def test_a_missing_local_file_is_refused_before_anything_is_sent(self, fake_client: FakeClient, tmp_path: Path):
        contracts = contracts_for_pipe(wire_contracts("summarize-pdf"), "summarize_pdf.summarize_pdf")
        result = invoke(make_binding(contracts=contracts), ["--document", str(tmp_path / "absent.pdf")])
        assert result.exit_code == 2
        assert "which is not a file" in result.stderr
        assert fake_client.entered == 0

    def test_a_method_with_no_file_input_never_asks_for_its_signature(self, fake_client: FakeClient):
        invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--name", "Marie"])
        assert fake_client.prepared == []
        assert fake_client.pipe_io_asked == []


class TestInputsTemplate:
    def test_prints_the_template_alone_and_runs_nothing(self, fake_client: FakeClient):
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--inputs-template"])
        assert result.exit_code == 0, result.stderr
        assert set(json.loads(result.stdout)) == {"name"}
        assert fake_client.entered == 0

    @pytest.mark.parametrize("other", [["--blocking"], ["--name", "Marie"], ["--out", "files"]])
    def test_is_refused_with_anything_else(self, fake_client: FakeClient, other: list[str]):
        result = invoke(make_binding(contracts=greet_contracts(**text_inputs("name"))), ["--inputs-template", *other])
        assert result.exit_code == 2
        assert "--inputs-template prints the inputs template and runs nothing: give it alone." in result.stderr
        assert fake_client.entered == 0


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

    def test_ctrl_c_during_the_start_says_a_run_may_have_started(self, fake_client: FakeClient):
        async def interrupted() -> str:
            signal.raise_signal(signal.SIGINT)
            await asyncio.sleep(10)
            msg = "the start was not cancelled"
            raise AssertionError(msg)

        fake_client.start_answer = interrupted
        result = invoke(make_binding(), [])
        assert result.exit_code == 130
        # The request may have reached the server: a run may be going, with no id to resume it by.
        assert "may or may not have started" in result.stderr
        assert f"{COMMAND_NAME} --resume" not in result.stderr

    def test_losing_the_api_mid_wait_says_how_to_resume(self, fake_client: FakeClient):
        fake_client.wait_answer = ApiUnreachableError("connection refused", api_url="https://api.pipelex.com")
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert f"{COMMAND_NAME} --resume {RUN_ID}" in result.stderr
        assert "Could not reach the Pipelex API" in result.stderr

    @pytest.mark.parametrize(("status", "status_text"), [(502, "Bad Gateway"), (429, "Too Many Requests")])
    def test_a_transient_refusal_mid_wait_says_how_to_resume(self, fake_client: FakeClient, status: int, status_text: str):
        fake_client.wait_answer = ApiResponseError(
            f"API GET /v1/runs/{RUN_ID} failed ({status})",
            api_url="https://api.pipelex.com",
            status=status,
            status_text=status_text,
            response_body="",
        )
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert f"{COMMAND_NAME} --resume {RUN_ID}" in result.stderr

    def test_an_unknown_run_is_never_offered_a_resume(self, fake_client: FakeClient):
        fake_client.wait_answer = ApiResponseError(
            f"API GET /v1/runs/{RUN_ID} failed (404)", api_url="https://api.pipelex.com", status=404, status_text="Not Found", response_body=""
        )
        result = invoke(make_binding(), ["--resume", RUN_ID])
        assert result.exit_code == 1
        assert f"{COMMAND_NAME} --resume" not in result.stderr

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
        assert "its result is complete above" in result.stderr
        # Into an empty directory: the SDK never overwrites, so the saved files would come down twice.
        assert f"{COMMAND_NAME} --resume {RUN_ID} --out DIR" in result.stderr

    def test_a_refused_result_with_a_file_that_did_not_come_down_is_never_called_complete(self, fake_client: FakeClient, tmp_path: Path):
        failed = DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], error=ArtifactItemError(code="forbidden", detail="Not your run."))
        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        fake_client.download_answer = download_verdict(failed)
        result = invoke(make_binding(output_model=Greeting), ["--out", str(tmp_path)])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert "complete above" not in result.stderr
        assert "its result was not printed" in result.stderr
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

    def test_a_download_that_raises_never_hides_a_refused_result(self, fake_client: FakeClient, tmp_path: Path):
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        fake_client.download_answer = ArtifactOperationError("The download directory cannot be created or used.")
        result = invoke(make_binding(output_model=Greeting), ["--out", str(tmp_path)])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert "The download directory cannot be created or used." in result.stderr
        assert "No inference calls" in result.stderr
        refusal = f"Run {RUN_ID} returned a result that Greeting refuses, first at text, so it is not printed."
        assert refusal in result.stderr
        # The download's failure as it happened, then the refusal last, as the error the command exits with.
        assert result.stderr.index("cannot be created or used") < result.stderr.index(refusal)

    @pytest.mark.parametrize(
        ("failure", "says"),
        [
            # An unwritable `--out` can surface as a bare `OSError`.
            (PermissionError(13, "Permission denied", "out"), "Permission denied"),
            # Python 3.11 and 3.12 raise this where `--out` is a symbolic link loop, which the SDK resolves first.
            (RuntimeError("Symlink loop from 'out'"), "Symlink loop"),
            # A body httpx cannot decode, which the SDK's transport mapping leaves as httpx's own error.
            (httpx.DecodingError("Error -3 while decompressing data"), "decompressing"),
            # A malformed answer from the route that resolves the files' links.
            (json.JSONDecodeError("Expecting value", "<html>", 0), "Expecting value"),
            (ValidationError.from_exception_data("BulkResolvedStorageUrls", []), "BulkResolvedStorageUrls"),
        ],
    )
    def test_a_download_that_fails_unforeseen_never_hides_a_refused_result(
        self, failure: Exception, says: str, fake_client: FakeClient, tmp_path: Path
    ):
        # Neither a `PipelineRequestError` nor an `AppError`, but what the download path can raise all the same.
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        fake_client.download_answer = failure
        result = invoke(make_binding(output_model=Greeting), ["--out", str(tmp_path)])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert says in result.stderr
        assert "No inference calls" in result.stderr
        refusal = f"Run {RUN_ID} returned a result that Greeting refuses, first at text, so it is not printed."
        assert refusal in result.stderr
        assert result.stderr.index(says) < result.stderr.index(refusal)
        assert "Traceback" not in result.stderr

    @pytest.mark.parametrize(
        ("failure", "says"),
        [
            (PermissionError(13, "Permission denied", "out"), "PermissionError: [Errno 13] Permission denied: 'out'"),
            (httpx.DecodingError("Error -3 while decompressing data"), "DecodingError: Error -3 while decompressing data"),
        ],
    )
    def test_a_download_that_fails_unforeseen_after_a_printed_result_is_an_error_never_a_traceback(
        self, failure: Exception, says: str, fake_client: FakeClient, tmp_path: Path
    ):
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        fake_client.download_answer = failure
        result = invoke(make_binding(), ["--out", str(tmp_path)])
        assert result.exit_code == 1
        assert json.loads(result.stdout) == IMAGE_OUTPUT
        assert f"Error: Saving the run's files failed: {says}" in result.stderr
        assert "The run succeeded and its result is complete above." in result.stderr
        assert f"{COMMAND_NAME} --resume {RUN_ID} --out DIR" in result.stderr
        assert "[bold]" not in result.stderr
        assert "No inference calls" in result.stderr
        assert "Traceback" not in result.stderr

    def test_a_bug_in_the_download_is_never_worded_as_a_failed_save(self, fake_client: FakeClient, tmp_path: Path):
        # A failure the download path cannot raise is a bug, and crashes loudly rather than reading like an ordinary one.
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        fake_client.download_answer = TypeError("'NoneType' object is not subscriptable")
        with pytest.raises(TypeError, match="not subscriptable"):
            invoke(make_binding(output_model=Greeting), ["--out", str(tmp_path)])

    def test_a_default_directory_refused_never_hides_a_refused_result(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, run_id="../escape")
        result = invoke(make_binding(output_model=Greeting), [])
        assert result.exit_code == 1
        assert "cannot name a directory" in result.stderr
        assert "returned a result that Greeting refuses" in result.stderr
        assert fake_client.downloaded_to == []

    def test_a_second_resume_leaves_the_earlier_download_alone(self, fake_client: FakeClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.chdir(tmp_path)
        saved = DownloadedArtifact(uri=IMAGE_OUTPUT["url"], found_at=["$.url"], path=f"outputs/{RUN_ID}/main_stuff.png", size=3)
        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        fake_client.download_answer = download_verdict(saved)
        first = invoke(make_binding(), ["--resume", RUN_ID])
        assert first.exit_code == 0, first.stderr
        result = invoke(make_binding(), ["--resume", RUN_ID])
        assert result.exit_code == 0, result.stderr
        assert json.loads(result.stdout) == IMAGE_OUTPUT
        assert fake_client.downloaded_to == [Path("outputs") / RUN_ID]
        assert "none were fetched" in result.stderr

    def test_a_resume_after_a_download_left_short_fails_and_says_how_to_fetch_again(
        self, fake_client: FakeClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        # A download killed before it finished leaves files and no manifest, however many files it left.
        monkeypatch.chdir(tmp_path)
        (tmp_path / "outputs" / RUN_ID).mkdir(parents=True)
        (tmp_path / "outputs" / RUN_ID / "first.png").write_bytes(b"png")
        (tmp_path / "outputs" / RUN_ID / "second.png").write_bytes(b"pn")
        fake_client.wait_answer = run_results(TWO_FILES_OUTPUT)
        result = invoke(make_binding(), ["--resume", RUN_ID])
        assert result.exit_code == 1
        assert json.loads(result.stdout) == TWO_FILES_OUTPUT
        assert fake_client.downloaded_to == []
        assert "not whole, since it has no record of a download that finished" in result.stderr
        assert f"{COMMAND_NAME} --resume {RUN_ID} --out DIR" in result.stderr

    def test_ctrl_c_while_the_files_come_down_says_how_to_fetch_them_again(self, fake_client: FakeClient, tmp_path: Path):
        async def interrupted() -> DownloadArtifactsResult:
            signal.raise_signal(signal.SIGINT)
            await asyncio.sleep(10)
            msg = "the download was not cancelled"
            raise AssertionError(msg)

        fake_client.wait_answer = run_results(IMAGE_OUTPUT)
        fake_client.download_answer = interrupted
        result = invoke(make_binding(), ["--out", str(tmp_path)])
        assert result.exit_code == 130
        assert json.loads(result.stdout) == IMAGE_OUTPUT
        assert f"{COMMAND_NAME} --resume {RUN_ID} --out DIR" in result.stderr

    def test_a_reader_that_stops_early_still_gets_the_files_down(self, fake_client: FakeClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        # `my-cli | head -1`: the reader closes the pipe, and the next write to stdout raises.
        original_echo = typer.echo
        silenced: list[bool] = []

        def closed_stdout(message: object = None, *, err: bool = False, **kwargs: Any) -> None:
            if not err:
                raise BrokenPipeError
            original_echo(message, err=err, **kwargs)

        monkeypatch.setattr(output.typer, "echo", closed_stdout)
        monkeypatch.setattr(output, "silence_stdout", lambda: silenced.append(True))
        fake_client.wait_answer = run_results(IMAGE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        result = invoke(make_binding(), ["--out", str(tmp_path)])
        assert result.exit_code == 0, result.stderr
        assert fake_client.downloaded_to == [tmp_path]
        assert "No inference calls" in result.stderr
        assert silenced == [True]

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


class TestOutputValidation:
    """A result is checked against the generated output model before it is printed, and never filtered by it."""

    def test_a_result_the_model_accepts_is_printed_as_it_came(self, fake_client: FakeClient):
        output = {"text": "Bonjour", "extra": "kept"}
        fake_client.wait_answer = run_results(output)
        result = invoke(make_binding(output_model=Greeting), [])
        assert result.exit_code == 0, result.stderr
        assert json.loads(result.stdout) == output

    def test_a_result_the_model_refuses_is_not_printed_and_says_how_to_fetch_it_again(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results({"title": "Bonjour"}, tokens_usages=[], usage_assembly_error=None)
        result = invoke(make_binding(output_model=Greeting), [])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert f"Run {RUN_ID} returned a result that Greeting refuses, first at text, so it is not printed." in result.stderr
        assert "text: Field required" in result.stderr
        assert f"run `make codegen` and update binding.py, then fetch the result again with `{COMMAND_NAME} --resume {RUN_ID}`" in result.stderr
        # The cost is reported all the same: the run is paid for.
        assert "No inference calls" in result.stderr

    def test_a_plural_result_names_the_item_that_failed(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results([{"text": "a"}, {"title": "b"}])
        result = invoke(make_binding(output_is_list=True, output_model=Greeting), [])
        assert result.exit_code == 1
        assert "a list of Greeting refuses, first at [1].text" in result.stderr

    def test_a_blocking_run_is_not_offered_a_resume(self, fake_client: FakeClient):
        fake_client.execute_answer = execute_result({"title": "Bonjour"})
        result = invoke(make_binding(output_model=Greeting), ["--blocking"])
        assert result.exit_code == 1
        assert "update binding.py." in result.stderr
        assert f"{COMMAND_NAME} --resume" not in result.stderr


class TestAbsentOutput:
    """A successful run may leave an optional output absent, which is the method working as declared."""

    def test_an_optional_output_left_absent_prints_null_and_says_why(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results(ABSENCE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        result = invoke(make_binding(contracts=greet_contracts(output_optional=True), output_model=Greeting), [])
        assert result.exit_code == 0, result.stderr
        assert result.stdout == "null\n"
        assert "The method produced no output this time (The condition chose no branch.)." in result.stderr
        assert "Its output is optional, so the result is null." in result.stderr
        assert "No inference calls" in result.stderr

    def test_the_absence_of_an_output_that_is_not_optional_is_refused(self, fake_client: FakeClient):
        fake_client.wait_answer = run_results(ABSENCE_OUTPUT, tokens_usages=[], usage_assembly_error=None)
        # The default binding's output model is opaque, which would take the absence document as data.
        result = invoke(make_binding(), [])
        assert result.exit_code == 1
        assert result.stdout == ""
        assert f"Run {RUN_ID} delivered no output, although the pipe's contract requires one, so nothing is printed." in result.stderr
        assert "kind: skipped" in result.stderr
        assert "reason: The condition chose no branch." in result.stderr
        assert "make codegen" not in result.stderr
        assert "produced no output" not in result.stderr
        # The cost is reported all the same: the run is paid for.
        assert "No inference calls" in result.stderr


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
