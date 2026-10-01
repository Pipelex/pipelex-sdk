"""Offline gates for the `make add-method` scaffolder (`scripts/add_method.py`).

Everything here runs with no API key and no network: the scaffolder's read-only half is pure
derivation from a validate report, and the report is built here rather than fetched. What is
deliberately NOT stubbed is the three mode files — `insert_into_mode_file` is exercised against
the real `widget/<mode>/cli.py`, so a template edit that loses an anchor, renames a lifecycle
helper's parameters or breaks the first-party import block fails this suite rather than the next
person's scaffold run.

The emitted command is checked by compiling it. A scaffolder whose output does not parse is the
one failure a starter cannot afford, and `compile()` catches it without a key, a network or an
installed method.
"""

from __future__ import annotations

import ast
import datetime
import importlib
import importlib.util
import io
import json
import subprocess
import sys
import types
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pydantic
import pytest
from mthds.protocol.input_form import (
    BooleanField,
    DocumentField,
    EnumField,
    ImageField,
    InputFormField,
    ListField,
    NumberField,
    ObjectField,
    PipeInputFormDescriptor,
    TextField,
    TextItem,
)
from mthds.protocol.pipe_io_contracts import IOMultiplicity, PipeIOContract, PipeOutputContract, PresenceMarker
from pipelex_sdk.crate_models import CodegenValidReport
from pipelex_sdk.errors import CodegenError
from pipelex_sdk.runs import RunResults
from pipelex_sdk.validation_models import PipelexValidationReport
from pytest_mock import MockerFixture
from rich.console import Console

from widget.manifest import MethodSelector, write_manifest

ROOT = Path(__file__).resolve().parents[2]
# One string per path, the package name followed by a slash: the `/bootstrap` skill rewrites a
# lone `"widget"` to the distribution name, which is not a directory.
MODE_FILES = {mode: ROOT / f"widget/{mode}/cli.py" for mode in ("blocking", "attended", "detached")}
MANIFEST_IMPORT = "from widget.manifest import MANIFEST_FILENAME, read_manifest"

PIPE_REF = "stats.analyze_text"
ADDRESS = "github.com/Pipelex/methods/text_stats@v0.1.1"
# The slug every synthetic plan is built under, deliberately not `text-stats`, the one
# `docs/add-method.md` walks through. `build_plan` refuses a slug whose method directory, generated
# package or command already exists in the real tree, so a fixture sharing the documented slug would
# fail this suite the moment somebody followed the docs.
SLUG = "fixture-method"


def load_add_method() -> Any:
    """Import the scaffolder the way `python -m scripts.add_method` does.

    The repository root goes on the path first: the scaffolder imports `scripts.codegen`, which
    is how the two scripts share the manifest format instead of each carrying a copy of it.
    """
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    return importlib.import_module("scripts.add_method")


add_method = load_add_method()


def build_report(
    *,
    fields: Sequence[InputFormField] | None = None,
    pipes: dict[str, str] | None = None,
    default_pipe_ref: str | None = PIPE_REF,
    multiplicity: IOMultiplicity = IOMultiplicity.SINGLE,
) -> PipelexValidationReport:
    """A valid report shaped like the one `POST /v1/validate` returns for a runnable method."""
    declared = pipes or {PIPE_REF: "stats.TextStats"}
    contracts = {
        pipe_ref: PipeIOContract(
            inputs={},
            output=PipeOutputContract(concept_ref=concept_ref, multiplicity=multiplicity, item_count=None, optional=False, json_schema={}),
        )
        for pipe_ref, concept_ref in declared.items()
    }
    form = {pipe_ref: PipeInputFormDescriptor(fields=list(fields) if fields is not None else []) for pipe_ref in declared}
    return PipelexValidationReport(is_valid=True, pipe_io_contracts=contracts, default_pipe_ref=default_pipe_ref, input_form=form)


def text_field(*, name: str = "text", required: bool = True) -> TextField:
    presence = PresenceMarker.PLAIN if required else PresenceMarker.OPTIONAL
    return TextField(name=name, required=required, presence=presence, gating=required, description="The text to analyze.")


def build_plan(
    *,
    mode: str = "attended",
    multiplicity: IOMultiplicity = IOMultiplicity.SINGLE,
    fields: Sequence[InputFormField] | None = None,
    slug: str = SLUG,
) -> Any:
    report = build_report(fields=fields if fields is not None else [text_field()], multiplicity=multiplicity)
    selector = add_method.parse_selector(ADDRESS)
    return add_method.build_plan(report=report, selector=selector, slug=slug, mode=mode, requested_pipe=None)


def load_merged_mode_file(*, plan: Any, directory: Path) -> Any:
    """Insert the plan's command into its real mode file and import the result as a module.

    Imported from a file rather than executed from a string, so the emitted command runs with
    exactly the globals its mode file gives it — which is what a shadowed name breaks.
    """
    merged = add_method.insert_into_mode_file(
        text=MODE_FILES[plan.mode].read_text(),
        imports=add_method.import_lines(plan),
        command_source=add_method.build_command_source(plan),
    )
    path = directory / f"scaffolded_{plan.mode}.py"
    path.write_text(merged)
    spec = importlib.util.spec_from_file_location(f"scaffolded_{plan.mode}", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestAddMethod:
    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    def test_every_mode_file_carries_both_anchors(self, mode: str):
        text = MODE_FILES[mode].read_text()
        assert add_method.IMPORT_ANCHOR in text
        assert add_method.COMMAND_ANCHOR in text

    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    def test_every_mode_file_declares_the_helper_the_scaffolder_calls(self, mode: str):
        """The emitted command calls the mode's lifecycle helper by name, with a selector.

        A helper renamed, or one that stopped taking `method_id` / `method_ref`, would make every
        scaffolded command a `NameError` or a `TypeError` at run time — caught here instead.
        """
        text = MODE_FILES[mode].read_text()
        assert f"async def {add_method.MODE_HELPERS[mode]}(" in text
        assert "method_id: str | None = None" in text
        assert "method_ref: str | None = None" in text
        assert "METHODS_DIR = " in text

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("github.com/Pipelex/methods/text_stats@v0.1.1", "github.com/Pipelex/methods/text_stats@v0.1.1"),
            ("https://github.com/Pipelex/methods/text_stats@v0.1.1", "github.com/Pipelex/methods/text_stats@v0.1.1"),
            ("github.com/Pipelex/methods/text_stats", "github.com/Pipelex/methods/text_stats"),
            ("github.com/Pipelex/methods", "github.com/Pipelex/methods"),
        ],
    )
    def test_an_address_is_normalized_to_its_bare_form(self, raw: str, expected: str):
        selector = add_method.parse_selector(raw)
        assert selector.method_ref == expected
        assert selector.method_id is None

    def test_a_catalog_id_is_sent_as_method_id(self):
        selector = add_method.parse_selector("mt_abc123")
        assert selector.method_id == "mt_abc123"
        assert selector.method_ref is None

    @pytest.mark.parametrize("raw", ["widget/methods/text-stats", "./main.mthds", "gitlab.com/owner/repo", "mt_", ""])
    def test_anything_else_is_refused(self, raw: str):
        with pytest.raises(add_method.Refusal):
            add_method.parse_selector(raw)

    def test_an_address_names_the_slug_and_a_catalog_id_does_not(self):
        assert add_method.slug_from_selector(add_method.parse_selector(ADDRESS)) == "text-stats"
        with pytest.raises(add_method.Refusal, match="NAME"):
            add_method.slug_from_selector(add_method.parse_selector("mt_abc123"))

    @pytest.mark.parametrize(("raw", "slug"), [("text_stats", "text-stats"), ("CV screening", "cv-screening"), ("InvoiceTriage", "invoice-triage")])
    def test_a_name_is_kebab_cased(self, raw: str, slug: str):
        assert add_method.kebab_case(raw) == slug

    def test_every_name_derives_from_the_slug(self):
        names = add_method.derive_names("text-stats")
        assert names == ("text-stats", "text_stats", "text_stats", "TextStatsOutput")

    @pytest.mark.parametrize("slug", ["", "Text-Stats", "text--stats", "-text", "text stats"])
    def test_a_slug_that_cannot_be_a_directory_and_a_package_is_refused(self, slug: str):
        with pytest.raises(add_method.Refusal):
            add_method.derive_names(slug)

    def test_the_requested_pipe_wins_bare_or_qualified(self):
        report = build_report()
        assert add_method.choose_pipe(report=report, requested="analyze_text") == PIPE_REF
        assert add_method.choose_pipe(report=report, requested=PIPE_REF) == PIPE_REF

    def test_the_default_pipe_is_next(self):
        report = build_report(pipes={PIPE_REF: "stats.TextStats", "stats.other": "stats.Other"})
        assert add_method.choose_pipe(report=report, requested=None) == PIPE_REF

    def test_a_lone_pipe_is_taken_without_a_default(self):
        report = build_report(default_pipe_ref=None)
        assert add_method.choose_pipe(report=report, requested=None) == PIPE_REF

    def test_several_pipes_and_no_default_is_a_refusal_listing_them(self):
        report = build_report(pipes={PIPE_REF: "stats.TextStats", "stats.other": "stats.Other"}, default_pipe_ref=None)
        with pytest.raises(add_method.Refusal, match="stats.other"):
            add_method.choose_pipe(report=report, requested=None)

    def test_an_unknown_pipe_is_a_refusal_listing_what_the_method_declares(self):
        with pytest.raises(add_method.Refusal, match=PIPE_REF):
            add_method.choose_pipe(report=build_report(), requested="nope")

    def test_an_ambiguous_bare_code_is_a_refusal(self):
        report = build_report(pipes={"one.run": "one.Out", "two.run": "two.Out"}, default_pipe_ref=None)
        with pytest.raises(add_method.Refusal, match="ambiguous"):
            add_method.choose_pipe(report=report, requested="run")

    def test_required_inputs_come_before_optional_ones(self):
        """Forced by Python, not by taste: a parameter with no default cannot follow one with one."""
        fields = [text_field(name="note", required=False), text_field(name="text", required=True)]
        parameters = add_method.build_parameters(report=build_report(fields=fields), pipe_ref=PIPE_REF)
        assert [parameter.name for parameter in parameters] == ["text", "note"]

    def test_a_required_scalar_is_an_argument_and_an_optional_one_is_an_option(self):
        fields = [text_field(name="text", required=True), text_field(name="note", required=False)]
        parameters = add_method.build_parameters(report=build_report(fields=fields), pipe_ref=PIPE_REF)
        assert "typer.Argument(" in parameters[0].declaration
        assert 'typer.Option("--note"' in parameters[1].declaration
        assert parameters[1].declaration.endswith("= None,")

    def test_a_number_is_typed_by_what_the_method_says_it_is(self):
        integer = NumberField(name="top_n", required=True, presence=PresenceMarker.PLAIN, gating=True, integer=True)
        decimal = NumberField(name="ratio", required=True, presence=PresenceMarker.PLAIN, gating=True, integer=False)
        parameters = add_method.build_parameters(report=build_report(fields=[integer, decimal]), pipe_ref=PIPE_REF)
        assert [parameter.annotation for parameter in parameters] == ["int", "float"]

    def test_a_boolean_is_a_flag_pair_never_a_positional(self):
        field = BooleanField(name="strict", required=True, presence=PresenceMarker.PLAIN, gating=True)
        parameter = add_method.build_parameters(report=build_report(fields=[field]), pipe_ref=PIPE_REF)[0]
        assert '"--strict/--no-strict"' in parameter.declaration
        assert "typer.Argument(" not in parameter.declaration

    def test_an_enum_lists_its_choices_in_the_help(self):
        field = EnumField(name="tone", required=True, presence=PresenceMarker.PLAIN, gating=True, choices=["terse", "warm"])
        parameter = add_method.build_parameters(report=build_report(fields=[field]), pipe_ref=PIPE_REF)[0]
        assert "terse, warm" in parameter.declaration

    def test_a_document_is_uploaded_before_the_run(self):
        field = DocumentField(name="invoice", required=True, presence=PresenceMarker.PLAIN, gating=True)
        parameter = add_method.build_parameters(report=build_report(fields=[field]), pipe_ref=PIPE_REF)[0]
        assert "exists=True" in parameter.declaration
        assert parameter.assignment == ['    run_inputs["invoice"] = _run(upload_document_input(invoice))']

    @pytest.mark.parametrize(
        "field",
        [
            ObjectField(name="packet", required=True, presence=PresenceMarker.PLAIN, gating=True, fields=[]),
            ListField(name="items", required=True, presence=PresenceMarker.PLAIN, gating=True, item=TextItem(required=True)),
            ImageField(name="photo", required=True, presence=PresenceMarker.PLAIN, gating=True),
        ],
    )
    def test_an_input_with_no_honest_command_line_spelling_is_refused(self, field: InputFormField):
        """Refused, not guessed at. A JSON-encoded flag would be a hand-written input shape."""
        with pytest.raises(add_method.Refusal, match=field.name):
            add_method.build_parameters(report=build_report(fields=[field]), pipe_ref=PIPE_REF)

    def test_a_method_with_no_input_form_is_refused(self):
        report = build_report()
        report.input_form = None
        with pytest.raises(add_method.Refusal, match="input form"):
            add_method.build_parameters(report=report, pipe_ref=PIPE_REF)

    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    def test_the_emitted_command_parses(self, mode: str):
        compile(add_method.build_command_source(build_plan(mode=mode)), "<emitted>", "exec")

    def test_it_reads_the_selector_from_the_manifest_and_sends_the_qualified_pipe(self):
        """A bare code is ambiguous exactly when two domains declare it, which the pipe rule refused to guess at."""
        source = add_method.build_command_source(build_plan())
        assert f'selector = read_manifest(METHODS_DIR / "{SLUG}" / MANIFEST_FILENAME)' in source
        assert "method_id=selector.method_id, method_ref=selector.method_ref" in source
        assert f'pipe_code="{PIPE_REF}"' in source
        assert ADDRESS not in source
        assert "mthds_contents" not in source

    @pytest.mark.parametrize(
        "manifest", [MethodSelector(method_ref="github.com/Pipelex/methods/text_stats@v0.2.0"), MethodSelector(method_id="mt_abc123")]
    )
    def test_the_command_runs_whatever_the_manifest_names_when_it_runs(self, tmp_path: Path, mocker: MockerFixture, manifest: MethodSelector):
        """The documented upgrade is "edit the tag, run `make codegen`", so the run has to move with the models.

        The slice was scaffolded from `ADDRESS`; the manifest on disk now names something else, and
        the run must send what the manifest names rather than what was scaffolded.
        """
        module = load_merged_mode_file(plan=build_plan(mode="detached"), directory=tmp_path)
        method_dir = tmp_path / "methods" / SLUG
        method_dir.mkdir(parents=True)
        write_manifest(method_dir / "method.json", manifest)
        start_pipe = mocker.AsyncMock(return_value="run-1")
        mocker.patch.object(module, "METHODS_DIR", tmp_path / "methods")
        mocker.patch.object(module, "start_pipe", start_pipe)
        mocker.patch.object(module, "_print_run_id")

        module.fixture_method(text="hello")

        start_pipe.assert_awaited_once_with(
            pipe_code=PIPE_REF, method_id=manifest.method_id, method_ref=manifest.method_ref, inputs={"text": "hello"}
        )

    @pytest.mark.parametrize("mode", ["blocking", "attended"])
    @pytest.mark.parametrize("multiplicity", [IOMultiplicity.SINGLE, IOMultiplicity.VARIABLE])
    def test_a_result_with_a_date_field_prints_as_json(self, tmp_path: Path, mocker: MockerFixture, mode: str, multiplicity: IOMultiplicity):
        """A generated model reads a wire date as a `datetime.date`, which `print_json` cannot encode unless the dump is in JSON mode.

        Without it the run is billed and the command then crashes on its own result.
        """
        plan = build_plan(mode=mode, multiplicity=multiplicity)
        models = types.ModuleType("widget.generated.fixture_method.models")
        models.TextStats = pydantic.create_model("TextStats", day=(datetime.date, ...))  # type: ignore[attr-defined]
        mocker.patch.dict(
            sys.modules, {"widget.generated.fixture_method": types.ModuleType("widget.generated.fixture_method"), models.__name__: models}
        )
        module = load_merged_mode_file(plan=plan, directory=tmp_path)
        method_dir = tmp_path / "methods" / SLUG
        method_dir.mkdir(parents=True)
        write_manifest(method_dir / "method.json", MethodSelector(method_id="mt_abc123"))
        main_stuff: Any = [{"day": "2026-09-13"}] if multiplicity.is_plural else {"day": "2026-09-13"}
        output = io.StringIO()
        mocker.patch.object(module, "METHODS_DIR", tmp_path / "methods")
        results = RunResults(pipeline_run_id="run-1", main_stuff=main_stuff, tokens_usages=None, usage_assembly_error=None)
        mocker.patch.object(module, add_method.MODE_HELPERS[mode], mocker.AsyncMock(return_value=results))
        mocker.patch.object(module, "output_console", Console(file=output))
        mocker.patch.object(module, "print_cost_report")
        mocker.patch.object(module, "print_downloads")
        mocker.patch.object(module, "download_produced_files", mocker.AsyncMock(return_value=None))

        module.fixture_method(text="hello")

        assert json.loads(output.getvalue()) == main_stuff

    def test_a_single_output_narrows_into_the_generated_model(self):
        plan = build_plan()
        source = add_method.build_command_source(plan)
        assert "FixtureMethodOutput.model_validate(results.main_stuff)" in source
        assert add_method.import_lines(plan) == [
            MANIFEST_IMPORT,
            "from widget.artifacts import DEFAULT_DOWNLOAD_DIR, download_produced_files, print_downloads",
            "from widget.generated.fixture_method.models import TextStats as FixtureMethodOutput",
        ]

    def test_a_plural_output_goes_through_the_list_reader(self):
        """A plural output arrives as a bare array or an `items` envelope depending on the path."""
        plan = build_plan(multiplicity=IOMultiplicity.VARIABLE)
        source = add_method.build_command_source(plan)
        assert "list_items(results.main_stuff)" in source
        assert "from widget.outputs import list_items" in add_method.import_lines(plan)

    def test_detached_prints_the_run_id_and_narrows_nothing(self):
        """Consistent with detached's own demos: at start time there is no result to narrow."""
        plan = build_plan(mode="detached")
        source = add_method.build_command_source(plan)
        assert "_print_run_id(run_id)" in source
        assert "model_validate" not in source
        assert add_method.import_lines(plan) == [MANIFEST_IMPORT]

    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    def test_the_slice_lands_in_the_real_mode_file_and_still_parses(self, mode: str):
        plan = build_plan(mode=mode)
        merged = add_method.insert_into_mode_file(
            text=MODE_FILES[mode].read_text(),
            imports=add_method.import_lines(plan),
            command_source=add_method.build_command_source(plan),
        )
        compile(merged, "<merged>", "exec")
        assert f'@app.command(name="{SLUG}")' in merged

    def test_the_import_lands_in_sorted_position(self):
        """Sorted on insertion rather than fixed up afterwards, so `ruff check` stays green."""
        plan = build_plan(multiplicity=IOMultiplicity.VARIABLE)
        merged = add_method.insert_into_mode_file(
            text=MODE_FILES["attended"].read_text(),
            imports=add_method.import_lines(plan),
            command_source=add_method.build_command_source(plan),
        )
        first_party = [line for line in merged.splitlines() if line.startswith("from widget.")]
        assert first_party == sorted(first_party)
        assert "from widget.generated.fixture_method.models import TextStats as FixtureMethodOutput" in first_party

    def test_a_mode_file_that_lost_an_anchor_is_refused(self):
        plan = build_plan()
        stripped = MODE_FILES["attended"].read_text().replace(add_method.COMMAND_ANCHOR, "# gone")
        with pytest.raises(add_method.Refusal, match="anchor"):
            add_method.insert_into_mode_file(text=stripped, imports=[], command_source=add_method.build_command_source(plan))

    @pytest.mark.parametrize(
        ("advertised", "selector_raw"),
        [(["runs", "method_id"], "mt_abc123"), (["runs", "method_ref"], ADDRESS), (["method_id", "method_ref"], ADDRESS)],
    )
    def test_an_advertised_selector_proceeds(self, advertised: list[str], selector_raw: str):
        selector = add_method.parse_selector(selector_raw)
        assert add_method.unsupported_selector_reason(base_url="https://api.example.com", advertised=advertised, selector=selector) is None

    def test_a_selector_the_deployment_does_not_advertise_is_refused_naming_both(self):
        """Measured against production on 2026-09-13: it advertises `runs` and `method_id` only."""
        selector = add_method.parse_selector(ADDRESS)
        reason = add_method.unsupported_selector_reason(base_url="https://api.example.com", advertised=["runs", "method_id"], selector=selector)
        assert reason is not None
        assert "method_ref" in reason
        assert "https://api.example.com" in reason

    def test_a_deployment_that_advertises_nothing_proceeds(self):
        """An empty handshake is "no verdict", never "supports nothing" — the real call answers."""
        selector = add_method.parse_selector(ADDRESS)
        assert add_method.unsupported_selector_reason(base_url="https://api.example.com", advertised=[], selector=selector) is None

    def test_a_name_already_on_disk_is_refused(self):
        """One-shot on purpose: `make codegen` is the refresh, and the command files are yours."""
        report = build_report(fields=[text_field()])
        with pytest.raises(add_method.Refusal, match="already exists"):
            add_method.build_plan(
                report=report,
                selector=add_method.parse_selector(ADDRESS),
                slug="extract-entities",
                mode="attended",
                requested_pipe=None,
            )

    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    @pytest.mark.parametrize("slug", ["app", "output-console", "asyncio", "typer", "start-and-wait", "read-manifest", "list-items"])
    def test_a_command_named_like_a_name_the_mode_file_or_the_command_uses_is_refused(self, mode: str, slug: str):
        """A command is a module-level `def`: `NAME=app` would replace the mode's Typer instance and take the root CLI down."""
        with pytest.raises(add_method.Refusal, match="would replace it"):
            build_plan(mode=mode, slug=slug)

    @pytest.mark.parametrize("name", ["start_and_wait", "execute_pipe", "upload_document_input", "output_console", "_run", "selector", "run_inputs"])
    def test_an_input_named_like_a_name_the_command_uses_is_refused(self, name: str):
        """An attended command with a text input named `start_and_wait` would fail with `'str' object is not callable`."""
        with pytest.raises(add_method.Refusal, match="shadow"):
            add_method.build_parameter(text_field(name=name))

    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    @pytest.mark.parametrize("slug", ["print", "filter", "len", "str", "type"])
    def test_a_command_named_like_a_builtin_is_refused(self, mode: str, slug: str):
        """A detached command named `print` would replace the `print` in `_print_run_id`, so every run id it prints starts another run."""
        with pytest.raises(add_method.Refusal, match="Python builtin"):
            build_plan(mode=mode, slug=slug)

    @pytest.mark.parametrize("name", ["format", "type", "id", "input"])
    def test_an_input_named_like_a_builtin_is_refused(self, name: str):
        """Ruff refuses a parameter shadowing a builtin (A002) and cannot fix it, so the scaffold would fail `make agent-check`."""
        with pytest.raises(add_method.Refusal, match="Python builtin"):
            add_method.build_parameter(text_field(name=name))

    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    @pytest.mark.parametrize("slug", ["wait", "status", "result"])
    def test_a_command_named_like_a_detached_lifecycle_command_is_refused_in_every_mode(self, mode: str, slug: str):
        """`tests/unit/test_mode_symmetry.py` keeps these out of blocking and attended; detached already has them."""
        with pytest.raises(add_method.Refusal, match="run-lifecycle command|already has"):
            build_plan(mode=mode, slug=slug)

    @pytest.mark.parametrize("mode", sorted(MODE_FILES))
    @pytest.mark.parametrize("multiplicity", [IOMultiplicity.SINGLE, IOMultiplicity.VARIABLE])
    def test_every_name_an_emitted_command_reads_is_a_parameter_or_reserved(self, mode: str, multiplicity: IOMultiplicity):
        """What keeps `COMMAND_LOCALS` and `COMMAND_GLOBALS` honest: a template that starts reading a new name fails here."""
        fields = [
            DocumentField(name="invoice", required=True, presence=PresenceMarker.PLAIN, gating=True),
            text_field(name="text"),
            BooleanField(name="strict", required=False, presence=PresenceMarker.OPTIONAL, gating=False),
            DocumentField(name="appendix", required=False, presence=PresenceMarker.OPTIONAL, gating=False),
        ]
        plan = build_plan(mode=mode, multiplicity=multiplicity, fields=fields)
        function = ast.parse(add_method.build_command_source(plan)).body[0]
        assert isinstance(function, ast.FunctionDef)
        parameters = {parameter.name for parameter in plan.parameters}
        read: set[str] = set()
        bound: set[str] = set()
        for statement in function.body:
            # A local variable's annotation is never evaluated, so `run_inputs: dict[str, Any]` reads nothing.
            parts = [statement.target, statement.value] if isinstance(statement, ast.AnnAssign) else [statement]
            for node in (walked for part in parts if part is not None for walked in ast.walk(part)):
                if isinstance(node, ast.Name):
                    (bound if isinstance(node.ctx, ast.Store) else read).add(node.id)
        assert read - parameters <= add_method.COMMAND_LOCALS | add_method.COMMAND_GLOBALS | {plan.names.model_alias}
        assert bound <= add_method.COMMAND_LOCALS

    def test_module_bindings_reads_imports_assignments_and_definitions(self):
        bindings = add_method.module_bindings(text=MODE_FILES["attended"].read_text(), label="attended")
        assert {
            "app",
            "output_console",
            "progress_console",
            "asyncio",
            "typer",
            "start_and_wait",
            "_run",
            "METHODS_DIR",
            "upload_document_input",
        } <= bindings

    def test_a_mode_file_that_does_not_parse_is_refused(self):
        with pytest.raises(add_method.Refusal, match="does not parse"):
            add_method.module_bindings(text="def broken(:\n", label="widget/attended/cli.py")

    def test_a_failed_write_takes_back_everything_it_wrote(self, tmp_path: Path, mocker: MockerFixture):
        """A half-written slice would be refused by the next run as a name that already exists, and read by `make codegen`."""
        mode_file = tmp_path / "cli.py"
        original = MODE_FILES["attended"].read_text()
        mode_file.write_text(original)
        plan = build_plan()._replace(
            method_dir=tmp_path / "methods" / SLUG, generated_dir=tmp_path / "generated" / "fixture_method", mode_file=mode_file
        )
        mocker.patch.object(add_method, "REPO_ROOT", tmp_path)
        # A lock under another name is refused by the SDK's own writer, once the manifest is already on disk.
        report = CodegenValidReport(
            is_valid=True,
            kind="types",
            target="python-pydantic",
            crate_fingerprint="sha256:0",
            engine_version="0.0.0",
            artifacts=[],
            lock="",
            lock_filename="other.lock",
            message="",
        )

        with pytest.raises(CodegenError):
            add_method.write_slice(plan=plan, report=report)

        assert not plan.method_dir.exists()
        assert not plan.generated_dir.exists()
        assert mode_file.read_text() == original

    def test_a_ruff_that_fails_is_a_note_not_a_traceback(self, mocker: MockerFixture):
        """The slice is written and compiled by then, so only the formatting is missing."""
        mocker.patch.object(add_method.shutil, "which", return_value="ruff")
        mocker.patch.object(add_method.subprocess, "run", side_effect=subprocess.CalledProcessError(returncode=2, cmd=["ruff", "format"]))
        note = add_method.format_with_ruff(MODE_FILES["attended"])
        assert note is not None
        assert "exited 2" in note
        assert "make agent-check" in note
