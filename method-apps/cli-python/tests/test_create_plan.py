"""`scripts/create_plan.py`: what `make create` decides about the method before anything is written.

Each decision is pinned over a table: the argument, the bundle the gesture reads, the name, the
title's spelling, the method's prose, the pipe, the output binding and `binding.py`. Then the two
halves: `plan_method` over the recorded client, refusing before any write, and `write_method`, which
removes what it wrote when a write fails.
"""

import os
from pathlib import Path

import pytest
from mthds.protocol.pipe_io_contracts import PipeIOContract
from pipelex_sdk.crate_models import CodegenValidReport, MthdsFileItem, PipeIORequest, PipeIOValidReport

from pipelex_method_cli_python.lib.binding import BINDING_FILENAME
from pipelex_method_cli_python.lib.manifest import MethodSelector
from pipelex_method_cli_python.lib.method_source import PACKAGE
from scripts.codegen_shared import Layout
from scripts.create_plan import (
    BundlePath,
    ChosenPipe,
    MethodArgs,
    OutputBinding,
    PlanError,
    bind_output,
    choose_pipe,
    format_python,
    kebab_case,
    looks_like_path,
    method_prose_of,
    method_vocabulary,
    parse_method_arg,
    plan_method,
    read_bundle_arg,
    refuse_a_method_in_place,
    render_binding,
    respell_acronyms,
    slug_source,
    spelled_words,
    title_from_name,
    write_method,
)
from tests.support_create import RECEIPT_REVIEW_BUNDLE, RECORDED, STORED_METHOD_ID, TEMPLATE_ROOT, TEXT_STATS_REF, RecordedClient


def recorded_codegen(name: str) -> CodegenValidReport:
    return CodegenValidReport.model_validate_json((RECORDED / f"{name}.codegen.json").read_text(encoding="utf-8"))


def recorded_pipe_io(name: str) -> PipeIOValidReport:
    return PipeIOValidReport.model_validate_json((RECORDED / f"{name}.pipe-io.json").read_text(encoding="utf-8"))


def contract(name: str, pipe_ref: str) -> PipeIOContract:
    return recorded_pipe_io(name).pipe_io_contracts[pipe_ref]


@pytest.fixture
def package(tmp_path: Path) -> Layout:
    """An empty package of the test's own, as the template ships its own: no method, no tree, no binding."""
    layout = Layout(tmp_path / "project" / "src" / PACKAGE)
    layout.package_dir.mkdir(parents=True)
    return layout


class TestParseMethodArg:
    @pytest.mark.parametrize(
        ("arg", "parsed"),
        [
            ("mt_abc-123", MethodSelector(method_id="mt_abc-123")),
            ("github.com/Pipelex/methods/text_stats@v0.1.1", MethodSelector(method_ref="github.com/Pipelex/methods/text_stats@v0.1.1")),
            ("https://github.com/o/r/", MethodSelector(method_ref="github.com/o/r")),
            ("github.com/o/r/pkg/sub@release/1.0", MethodSelector(method_ref="github.com/o/r/pkg/sub@release/1.0")),
            ("./bundle", BundlePath("./bundle")),
            ("bundles/cv", BundlePath("bundles/cv")),
            ("cv.mthds", BundlePath("cv.mthds")),
            ("~/methods/cv", BundlePath("~/methods/cv")),
        ],
    )
    def test_reads_each_form(self, arg: str, parsed: object):
        assert parse_method_arg(arg, lambda _: False) == parsed

    def test_a_path_that_exists_is_a_path_whatever_it_looks_like(self):
        assert parse_method_arg("mt_drafts", lambda value: value == "mt_drafts") == BundlePath("mt_drafts")
        assert parse_method_arg("bundles.v2/cv", lambda value: value == "bundles.v2/cv") == BundlePath("bundles.v2/cv")

    @pytest.mark.parametrize(
        ("arg", "says"),
        [
            ("  ", "METHOD is empty"),
            ("mt_", "not a well-formed catalog id"),
            ("github.com/o/r@v1@v2", "more than one @tag"),
            ("github.com/o/r@-v1", "not a tag name"),
            ("github.com/o", "at least a host, an owner and a repository"),
        ],
    )
    def test_refuses_what_is_neither(self, arg: str, says: str):
        with pytest.raises(PlanError, match=says):
            parse_method_arg(arg, lambda _: False)

    @pytest.mark.parametrize(("value", "path"), [("a/b", True), ("../cv", True), ("C:\\cv", True), ("x.mthds", True), ("github.com/o/r", False)])
    def test_tells_a_path_from_an_address(self, value: str, path: bool):
        assert looks_like_path(value) is path


class TestReadBundleArg:
    def test_reads_every_mthds_file_under_a_directory_in_path_order(self, package: Layout, tmp_path: Path):
        bundle = read_bundle_arg(str(RECEIPT_REVIEW_BUNDLE), cwd=tmp_path, root=tmp_path / "project", layout=package)
        assert [file.relative for file in bundle.files] == ["concepts.mthds", "main.mthds"]
        assert bundle.display == f"{RECEIPT_REVIEW_BUNDLE}/"
        assert bundle.files[1].label == f"{RECEIPT_REVIEW_BUNDLE}/main.mthds"

    def test_a_relative_path_is_read_from_the_directory_given_and_named_from_it(self, package: Layout, tmp_path: Path):
        (tmp_path / "cv.mthds").write_text('domain = "cv"\n', encoding="utf-8")
        bundle = read_bundle_arg("cv.mthds", cwd=tmp_path, root=tmp_path / "project", layout=package)
        assert [(file.relative, file.label) for file in bundle.files] == [("cv.mthds", "cv.mthds")]

    def test_refuses_a_missing_path(self, package: Layout, tmp_path: Path):
        with pytest.raises(PlanError, match="is not a file or a directory"):
            read_bundle_arg("absent", cwd=tmp_path, root=tmp_path / "project", layout=package)

    def test_refuses_a_file_that_is_not_mthds(self, package: Layout, tmp_path: Path):
        (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
        with pytest.raises(PlanError, match=r"is not a \.mthds file"):
            read_bundle_arg("notes.txt", cwd=tmp_path, root=tmp_path / "project", layout=package)

    def test_refuses_a_directory_with_no_mthds_file(self, package: Layout, tmp_path: Path):
        (tmp_path / "empty").mkdir()
        with pytest.raises(PlanError, match=r"holds no \.mthds file"):
            read_bundle_arg("empty", cwd=tmp_path, root=tmp_path / "project", layout=package)

    def test_refuses_a_symlink_given_and_one_inside(self, package: Layout, tmp_path: Path):
        (tmp_path / "real.mthds").write_text('domain = "cv"\n', encoding="utf-8")
        (tmp_path / "link.mthds").symlink_to(tmp_path / "real.mthds")
        with pytest.raises(PlanError, match="refusing a symlink"):
            read_bundle_arg("link.mthds", cwd=tmp_path, root=tmp_path / "project", layout=package)
        (tmp_path / "bundle").mkdir()
        (tmp_path / "bundle" / "inner.mthds").symlink_to(tmp_path / "real.mthds")
        with pytest.raises(PlanError, match="refusing a symlink"):
            read_bundle_arg("bundle", cwd=tmp_path, root=tmp_path / "project", layout=package)

    def test_refuses_a_file_that_is_not_utf8(self, package: Layout, tmp_path: Path):
        (tmp_path / "latin.mthds").write_bytes(b"domain = '\xe9'\n")
        with pytest.raises(PlanError, match="not valid UTF-8"):
            read_bundle_arg("latin.mthds", cwd=tmp_path, root=tmp_path / "project", layout=package)

    def test_refuses_a_directory_that_contains_the_project(self, package: Layout, tmp_path: Path):
        with pytest.raises(PlanError, match="contains this project"):
            read_bundle_arg(".", cwd=tmp_path, root=tmp_path / "project", layout=package)
        with pytest.raises(PlanError, match="contains this project"):
            read_bundle_arg("project", cwd=tmp_path, root=tmp_path / "project", layout=package)


class TestNames:
    @pytest.mark.parametrize(("text", "slug"), [("text_stats", "text-stats"), ("CV screening", "cv-screening"), ("Test-1", "test-1")])
    def test_kebab_cases_a_name(self, text: str, slug: str):
        assert kebab_case(text) == slug

    @pytest.mark.parametrize("text", ["3D model", "---", "42"])
    def test_refuses_a_text_that_yields_no_usable_name_naming_the_flag(self, text: str):
        with pytest.raises(PlanError, match="Pass --name"):
            kebab_case(text)

    def test_a_named_method_s_name_comes_from_its_catalog_name_or_its_address(self):
        assert slug_source(MethodSelector(method_id="mt_x"), "Invoice extraction") == "Invoice extraction"
        assert slug_source(MethodSelector(method_ref="github.com/o/r/pkg@v1"), None) == "pkg"
        assert slug_source(MethodSelector(method_ref="github.com/o/repo"), None) == "repo"
        with pytest.raises(PlanError, match="pass --name"):
            slug_source(MethodSelector(method_id="mt_x"), "  ")

    def test_titles_a_name(self):
        assert title_from_name("receipt-review") == "Receipt Review"
        assert title_from_name("text_stats.v2") == "Text Stats V2"

    def test_respells_what_the_method_spells_its_own_way(self):
        assert respell_acronyms("Cv Screening", "Score a batch of CVs against a job description.") == "CV Screening"
        assert respell_acronyms("Pdf Summary", "Summarize a PDF.") == "PDF Summary"
        # An ordinary word opening a sentence is no spelling.
        assert respell_acronyms("Build Report", "Build a hiring scorecard.") == "Build Report"

    def test_a_spelling_covers_its_singular_and_its_plural(self):
        assert spelled_words("CVs")["cv"] == "CV"
        assert spelled_words("PDF")["pdfs"] == "PDFs"


class TestMethodProse:
    def test_reads_the_primary_file_s_description_and_every_pipe_s(self):
        files = [
            MthdsFileItem(content='domain = "shared"\ndescription = "Shared concepts."\n[pipe.helper]\ndescription = "Helps."\n'),
            MthdsFileItem(content='domain = "cv"\ndescription = "Screen CVs."\nmain_pipe = "screen"\n[pipe.screen]\ndescription = "Screens."\n'),
        ]
        prose = method_prose_of(files)
        assert prose.description == "Screen CVs."
        assert list(prose.pipe_descriptions.items()) == [("cv.screen", "Screens."), ("shared.helper", "Helps.")]
        assert method_vocabulary(prose) == "Screen CVs. Screens. Helps."

    def test_a_file_that_does_not_parse_contributes_nothing(self):
        prose = method_prose_of([MthdsFileItem(content="not = [toml")])
        assert prose.description is None and prose.pipe_descriptions == {}


#: Three pipes, two of them with the same code in different domains.
CONTRACTS: dict[str, PipeIOContract] = {
    "cv.screen": contract("text-stats", "text_stats.analyze_text"),
    "cv.rank": contract("text-stats", "text_stats.analyze_text"),
    "other.screen": contract("text-stats", "text_stats.analyze_text"),
}


class TestChoosePipe:
    def test_a_requested_pipe_by_its_reference_or_its_unambiguous_code(self):
        assert choose_pipe(CONTRACTS, None, "cv.screen") == ChosenPipe(ref="cv.screen", domain="cv", code="screen")
        assert choose_pipe(CONTRACTS, None, "rank").ref == "cv.rank"

    def test_an_ambiguous_or_unknown_request_is_refused(self):
        with pytest.raises(PlanError, match="ambiguous"):
            choose_pipe(CONTRACTS, None, "screen")
        with pytest.raises(PlanError, match="not a pipe this method declares"):
            choose_pipe(CONTRACTS, None, "absent")

    def test_the_method_s_default_then_its_only_pipe(self):
        assert choose_pipe(CONTRACTS, "cv.rank", None).ref == "cv.rank"
        only = {"cv.screen": CONTRACTS["cv.screen"]}
        assert choose_pipe(only, None, None).ref == "cv.screen"

    def test_nothing_decides_between_several_pipes(self):
        with pytest.raises(PlanError, match="names no default: pass --pipe"):
            choose_pipe(CONTRACTS, None, None)
        with pytest.raises(PlanError, match="not among the pipes it declares"):
            choose_pipe(CONTRACTS, "cv.absent", None)
        with pytest.raises(PlanError, match="declares no pipes"):
            choose_pipe({}, None, None)


class TestBindOutput:
    def test_binds_a_list_of_records_and_a_single_text(self):
        assert bind_output(contract("receipt-review", "receipt_review.review_receipts"), recorded_codegen("receipt-review")) == OutputBinding(
            model="ReceiptSummary", plural=True
        )
        assert bind_output(contract("text-stats", "text_stats.analyze_text"), recorded_codegen("text-stats")) == OutputBinding(
            model="Text", plural=False
        )

    def test_refuses_a_model_the_generated_tree_does_not_define(self):
        report = recorded_codegen("text-stats")
        models = next(artifact for artifact in report.artifacts if artifact.path == "models.py")
        renamed = report.model_copy(
            update={"artifacts": [models.model_copy(update={"content": models.content.replace("class Text(", "class Prose(")})]}
        )
        with pytest.raises(PlanError, match="defines no Text"):
            bind_output(contract("text-stats", "text_stats.analyze_text"), renamed)

    def test_refuses_models_that_cannot_be_imported(self):
        # A generated tree the CLI could not load, as one using a native date is today, is refused before any write.
        report = recorded_codegen("text-stats")
        models = next(artifact for artifact in report.artifacts if artifact.path == "models.py")
        broken = models.model_copy(update={"content": models.content + "\nraise NameError('Date is not defined')\n"})
        with pytest.raises(PlanError, match="cannot be imported: NameError"):
            bind_output(contract("text-stats", "text_stats.analyze_text"), report.model_copy(update={"artifacts": [broken]}))


class TestRenderBinding:
    def test_renders_binding_py_formatted_as_ruff_formats_it(self):
        text = render_binding(
            ChosenPipe(ref="receipt_review.review_receipts", domain="receipt_review", code="review_receipts"), OutputBinding("ReceiptSummary", True)
        )
        assert f"from {PACKAGE}.generated.models import ReceiptSummary\n" in text
        assert 'PIPE_REF = "receipt_review.review_receipts"\n' in text
        assert "OUTPUT_MODEL = ReceiptSummary\n" in text
        assert "OUTPUT_IS_LIST = True\n" in text
        assert "make create" not in text
        formatted = format_python(text, path=TEMPLATE_ROOT / "src" / PACKAGE / BINDING_FILENAME, root=TEMPLATE_ROOT)
        assert formatted == text


class TestPlanMethod:
    async def test_plans_a_bundle_from_one_fetch_and_writes_nothing(self, package: Layout, tmp_path: Path):
        client = RecordedClient()
        plan = await plan_method(MethodArgs(method=str(RECEIPT_REVIEW_BUNDLE)), client, layout=package, root=tmp_path / "project", cwd=tmp_path)
        assert client.calls == ["codegen", "pipe_io", "codegen"]
        assert plan.slug == "receipt-review"
        assert plan.pipe.ref == "receipt_review.review_receipts"
        assert [option.flag for option in plan.options] == ["--receipts"]
        assert [relative for relative, _ in plan.method_files] == ["concepts.mthds", "main.mthds"]
        assert sorted(plan.source.source_hashes) == ["method/concepts.mthds", "method/main.mthds"]
        assert plan.prose.description is not None and plan.prose.description.startswith("Read a batch of receipts")
        assert list(package.package_dir.iterdir()) == []

    async def test_plans_an_address_reading_its_prose_from_the_files_the_route_echoes(self, package: Layout, tmp_path: Path):
        client = RecordedClient()
        plan = await plan_method(MethodArgs(method=TEXT_STATS_REF), client, layout=package, root=tmp_path / "project", cwd=tmp_path)
        assert client.calls == ["version", "codegen", "pipe_io", "codegen"]
        assert all(request.method_ref == TEXT_STATS_REF for request in client.requests)
        assert [request.include_files for request in client.requests if isinstance(request, PipeIORequest)] == [True]
        assert plan.slug == "text-stats"
        assert plan.method_files == (("method.json", f'{{\n  "method_ref": "{TEXT_STATS_REF}"\n}}\n'),)
        assert plan.prose.description is not None and plan.prose.description.startswith("Deterministic text statistics")
        assert plan.warnings == ()

    async def test_plans_a_catalog_id_named_after_its_catalog_entry_with_a_warning(self, package: Layout, tmp_path: Path):
        client = RecordedClient()
        plan = await plan_method(MethodArgs(method=STORED_METHOD_ID), client, layout=package, root=tmp_path / "project", cwd=tmp_path)
        assert client.calls[:2] == ["version", "get_method"]
        assert plan.slug == "stored-text-stats"
        assert plan.catalog is not None and plan.catalog.name == "Stored text stats"
        assert "scoped to your key's organization" in plan.warnings[0]

    async def test_a_given_name_is_never_derived_nor_refused(self, package: Layout, tmp_path: Path):
        plan = await plan_method(
            MethodArgs(method=TEXT_STATS_REF, named=True), RecordedClient(), layout=package, root=tmp_path / "project", cwd=tmp_path
        )
        assert plan.slug is None

    async def test_a_requested_pipe_the_method_lacks_is_refused(self, package: Layout, tmp_path: Path):
        with pytest.raises(PlanError, match="not a pipe this method declares"):
            await plan_method(MethodArgs(method=TEXT_STATS_REF, pipe="absent"), RecordedClient(), layout=package, root=tmp_path, cwd=tmp_path)

    @pytest.mark.parametrize("part", ["method", "binding", "tree"])
    async def test_a_package_holding_a_method_already_is_refused_before_any_request(self, part: str, package: Layout, tmp_path: Path):
        match part:
            case "method":
                package.method_dir.mkdir()
            case "binding":
                (package.package_dir / BINDING_FILENAME).write_text("", encoding="utf-8")
            case _:
                package.generated_dir.mkdir()
                (package.generated_dir / "models.py").write_text("", encoding="utf-8")
        client = RecordedClient()
        with pytest.raises(PlanError, match="holds a method already"):
            await plan_method(MethodArgs(method=TEXT_STATS_REF), client, layout=package, root=tmp_path, cwd=tmp_path)
        assert client.calls == []

    def test_a_tree_holding_only_bytecode_is_no_method(self, package: Layout):
        (package.generated_dir / "__pycache__").mkdir(parents=True)
        refuse_a_method_in_place(package)


class TestWriteMethod:
    async def test_writes_the_method_the_tree_and_the_binding(self, package: Layout, tmp_path: Path):
        plan = await plan_method(
            MethodArgs(method=str(RECEIPT_REVIEW_BUNDLE)), RecordedClient(), layout=package, root=tmp_path / "project", cwd=tmp_path
        )
        written = write_method(plan, package)
        assert len(written) == 3
        assert (package.method_dir / "main.mthds").read_bytes() == (RECEIPT_REVIEW_BUNDLE / "main.mthds").read_bytes()
        assert (package.generated_dir / "contracts.json").is_file()
        assert (package.package_dir / BINDING_FILENAME).read_text(encoding="utf-8") == plan.binding

    async def test_a_failed_write_removes_everything_it_wrote(self, package: Layout, tmp_path: Path):
        plan = await plan_method(MethodArgs(method=TEXT_STATS_REF), RecordedClient(), layout=package, root=tmp_path / "project", cwd=tmp_path)
        # A binding.py that appears meanwhile is the person's, and the write refuses to replace it.
        (package.package_dir / BINDING_FILENAME).write_text("# mine\n", encoding="utf-8")
        with pytest.raises(FileExistsError):
            write_method(plan, package)
        assert sorted(os.listdir(package.package_dir)) == [BINDING_FILENAME]
        assert (package.package_dir / BINDING_FILENAME).read_text(encoding="utf-8") == "# mine\n"
