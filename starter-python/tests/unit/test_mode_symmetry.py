"""The drift guard for the full demo matrix.

Every demo exists in every mode group, with the same arguments — that symmetry is
the pedagogy (diff two mode files and only the lifecycle helper differs), and the
duplication it implies is exactly what drifts. A demo added to one mode and
forgotten in another fails here, and so does a demo whose call site no longer
names its own bundle's pipe.
"""

import inspect
import tomllib
from pathlib import Path

import pytest
import typer
from pipelex_sdk.runs import RunResults
from pytest_mock import MockerFixture
from typer.testing import CliRunner

import widget
from widget.attended.cli import app as attended_app
from widget.blocking.cli import app as blocking_app
from widget.cli import app as root_app
from widget.detached.cli import app as detached_app

MODE_APPS = {"blocking": blocking_app, "attended": attended_app, "detached": detached_app}
DEMO_COMMANDS = {"extract-entities", "summarize-pdf", "generate-image"}
LIFECYCLE_COMMANDS = {"wait", "status", "result"}
# Each demo command runs the bundle in the method directory of the same name.
METHODS_DIR = Path(widget.__file__).parent / "methods"
# The one public lifecycle helper each mode's demos call, which is what gets patched below.
LIFECYCLE_HELPERS = {"blocking": "execute_pipe", "attended": "start_and_wait", "detached": "start_pipe"}
# Outputs each demo's generated model accepts, so blocking and attended get past their narrowing.
DEMO_OUTPUTS: dict[str, dict[str, object]] = {
    "extract-entities": {"people": [], "orgs": [], "dates": []},
    "summarize-pdf": {"title": "Invoice", "doc_type": "invoice", "key_points": []},
    "generate-image": {"url": "pipelex-storage://run-1/cat.png", "public_url": "https://cdn.example.com/signed/cat.png"},
}

runner = CliRunner()


def _command_names(mode_app: typer.Typer) -> set[str]:
    return {command.name for command in mode_app.registered_commands if command.name is not None}


def _qualified_main_pipe(demo: str) -> str:
    """The demo bundle's main pipe as the runtime keys it: the bundle's own domain, a dot, the pipe's code."""
    bundle = tomllib.loads((METHODS_DIR / demo / "main.mthds").read_text())
    return f"{bundle['domain']}.{bundle['main_pipe']}"


def _demo_signatures(mode_app: typer.Typer) -> dict[str, list[str]]:
    signatures: dict[str, list[str]] = {}
    for command in mode_app.registered_commands:
        if command.name in DEMO_COMMANDS and command.callback is not None:
            signatures[command.name] = list(inspect.signature(command.callback).parameters)
    return signatures


class TestModeSymmetry:
    def test_every_mode_exposes_every_demo(self):
        """Every demo is in every mode. A mode may hold more, and one mode alone holds the lifecycle.

        The assertion is containment rather than equality because `make add-method` writes a
        command into exactly one mode: a scaffolded command is a legitimate extra, and demanding
        the three sets be equal would turn using the scaffolder into a test failure. What the
        symmetry is actually about is unchanged — a demo present in one mode and missing from
        another still fails here.
        """
        for mode_name, mode_app in MODE_APPS.items():
            assert DEMO_COMMANDS <= _command_names(mode_app), mode_name
        # Detached owns the run-lifecycle commands — nobody else has them.
        assert LIFECYCLE_COMMANDS <= _command_names(detached_app)
        assert not LIFECYCLE_COMMANDS & _command_names(blocking_app)
        assert not LIFECYCLE_COMMANDS & _command_names(attended_app)

    def test_the_demos_take_the_same_arguments_in_every_mode(self):
        blocking_signatures = _demo_signatures(blocking_app)
        assert set(blocking_signatures) == DEMO_COMMANDS
        assert _demo_signatures(attended_app) == blocking_signatures
        assert _demo_signatures(detached_app) == blocking_signatures

    def test_the_root_app_mounts_the_modes_in_reading_order(self):
        mounted = [group.name for group in root_app.registered_groups if group.name in MODE_APPS]
        assert mounted == ["blocking", "attended", "detached"]

    @pytest.mark.usefixtures("stub_upload", "stub_download")
    @pytest.mark.parametrize("demo", sorted(DEMO_COMMANDS))
    @pytest.mark.parametrize("mode", MODE_APPS)
    def test_every_demo_names_its_pipe_by_its_bundles_qualified_ref(self, mocker: MockerFixture, mode: str, demo: str):
        """The runtime keys a pipe by `domain.pipe_code`; a bare code is searched across every domain of the bundle.

        The search fails as ambiguous once two domains declare the same code, so the demos send the exact key.
        That key couples the call site to the bundle's `domain`, which a bare code never did: renaming the
        domain without the call sites would pass every offline test and fail every live run, unless this
        test reads the name from the bundle itself.
        """
        returned: RunResults | str = "run-abc123"
        if mode != "detached":
            returned = RunResults(pipeline_run_id="run-1", main_stuff=DEMO_OUTPUTS[demo], tokens_usages=None, usage_assembly_error=None)
        helper = mocker.patch(f"widget.{mode}.cli.{LIFECYCLE_HELPERS[mode]}", return_value=returned)
        result = runner.invoke(root_app, [mode, demo])
        assert result.exit_code == 0, result.output
        assert helper.await_args is not None
        assert helper.await_args.kwargs["pipe_code"] == _qualified_main_pipe(demo)
