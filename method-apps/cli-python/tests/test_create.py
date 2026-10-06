"""`scripts/create.py` and the Makefile's `create`: the gesture's arguments, its two halves, and the env file.

The Makefile forwards the method-app family's contract, pinned here with `make -n` (the family's own
test compares every template's forwarding). The gesture runs over a template of the test's own,
with the recorded client in place of `lib/client.py`'s `make_client` and a runner that records the
commands it is handed instead of running them; `TestWithTheRealBootstrap` and `test_create_tree.py`
run the real bootstrap over copies of the template.
"""

import os
import shlex
import stat
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

import pytest
from dotenv import dotenv_values
from pipelex_sdk.product_models import MethodData

from pipelex_method_cli_python.lib import client as client_module
from pipelex_method_cli_python.lib.binding import BINDING_FILENAME
from pipelex_method_cli_python.lib.method_source import PACKAGE
from scripts import create_plan
from scripts.codegen_shared import Layout
from scripts.create import (
    BOOTSTRAP_DIR,
    BOOTSTRAP_SCRIPT,
    TEMPLATE_NAME,
    CreateArgs,
    CreateDeps,
    CreateError,
    EnvPlan,
    RunCommand,
    ShellEnv,
    bootstrap_flags,
    derive_identity,
    parse_create_args,
    plan_env_file,
    quote_env_value,
    resolve_deps,
    run_create,
    set_env_line,
    write_env_file,
)
from scripts.create_plan import CatalogEntry, MethodArgs, MethodPlan, MethodProse, plan_method
from tests.support_create import RECEIPT_REVIEW_BUNDLE, STORED_METHOD_ID, TEMPLATE_ROOT, TEXT_STATS_REF, RecordedClient, copy_template, stored_method

#: Whether the tests run as root, who writes into a directory whose mode refuses everyone else.
AS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0

# ── The Makefile ────────────────────────────────────────────────────────────


def _make(args: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run make in the template with a clean make environment plus `env`: a parent make's variables would be "given" here too."""
    inherited = {key: value for key, value in os.environ.items() if key not in {"MAKEFLAGS", "MAKELEVEL", "MFLAGS"}}
    return subprocess.run(
        ["make", "--no-print-directory", *args], cwd=TEMPLATE_ROOT, env={**inherited, **(env or {})}, capture_output=True, text=True, check=False
    )


def _create_line(variables: list[str], *, env: dict[str, str] | None = None) -> str:
    """The line `make create <variables>` would run, with its spacing collapsed."""
    result = _make(["-n", "create", *variables], env=env)
    assert result.returncode == 0, result.stderr
    line = next((printed for printed in result.stdout.splitlines() if "-m scripts.create" in printed), None)
    assert line is not None, result.stdout
    return " ".join(line.split())


class TestMakefile:
    def test_passes_the_values_given_on_the_command_line_as_flags(self):
        line = _create_line(["METHOD=bundles/cv", "NAME=cv", "PIPE=screen", "LICENSE=mit", "DRY_RUN=1"])
        assert line == ".venv/bin/python -m scripts.create 'bundles/cv' --name 'cv' --pipe 'screen' --license 'mit' --dry-run"

    def test_treats_a_blank_value_and_a_0_switch_as_not_given(self):
        assert _create_line(["METHOD=cv", "NAME=", "TITLE= ", "DRY_RUN="]) == ".venv/bin/python -m scripts.create 'cv'"
        assert _create_line(["METHOD=cv", "DRY_RUN=0"]) == ".venv/bin/python -m scripts.create 'cv'"

    def test_ignores_a_variable_the_shell_exports(self):
        line = _create_line(["METHOD=cv"], env={"NAME": "from-shell", "LICENSE": "proprietary", "DRY_RUN": "1"})
        assert line == ".venv/bin/python -m scripts.create 'cv'"

    def test_hands_a_value_over_exactly_as_typed(self):
        line = _create_line(["METHOD=$(touch pwned)", 'TITLE=Bob\'s "$5" app, really'])
        assert line == ".venv/bin/python -m scripts.create '$(touch pwned)' --title 'Bob'\\''s \"$5\" app, really'"

    @pytest.mark.parametrize("variables", [[], ["METHOD="], ["METHOD=  "]])
    def test_refuses_a_missing_or_blank_method_with_the_usage_line(self, variables: list[str]):
        result = _make(["create", *variables])
        assert result.returncode == 2
        assert result.stdout.startswith("usage: make create METHOD=")
        assert "scripts.create" not in result.stdout


# ── The command line ────────────────────────────────────────────────────────


class TestParseCreateArgs:
    def test_reads_the_whole_contract(self):
        args = parse_create_args(
            ["bundles/cv", "--name", "cv", "--title", "CV", "--description", "Screens a CV.", "--pipe", "screen"]
            + ["--author-name", "Ada", "--author-email", "ada@example.com", "--repo-url", "https://example.com/cv"]
            + ["--license", "mit", "--license-holder", "Ada", "--license-year", "2026", "--dry-run"]
        )
        assert args == CreateArgs(
            method="bundles/cv",
            name="cv",
            title="CV",
            description="Screens a CV.",
            pipe="screen",
            author_name="Ada",
            author_email="ada@example.com",
            repo_url="https://example.com/cv",
            license="mit",
            license_holder="Ada",
            license_year="2026",
            dry_run=True,
        )

    def test_a_blank_value_is_not_given(self):
        assert parse_create_args(["cv", "--title", "  ", "--name", ""]) == CreateArgs(method="cv")

    @pytest.mark.parametrize(
        ("argv", "says"),
        [
            ([], "no method given"),
            (["  "], "no method given"),
            (["cv", "other"], "unexpected second method"),
            (["cv", "--label", "x"], "unknown argument '--label'"),
            # A value that looks like the next flag means the real one was dropped: the rehearsal must not turn real.
            (["cv", "--title", "--dry-run"], "--title: expected one argument"),
        ],
    )
    def test_refuses_with_the_usage_line(self, argv: list[str], says: str):
        with pytest.raises(CreateError, match=says) as caught:
            parse_create_args(argv)
        assert "usage: make create METHOD=" in str(caught.value)


# ── The identity ────────────────────────────────────────────────────────────


@pytest.fixture
async def text_stats_plan(tmp_path: Path) -> MethodPlan:
    layout = Layout(tmp_path / "src" / PACKAGE)
    layout.package_dir.mkdir(parents=True)
    return await plan_method(MethodArgs(method=TEXT_STATS_REF), RecordedClient(), layout=layout, root=tmp_path, cwd=tmp_path)


class TestDeriveIdentity:
    def test_a_published_method_is_named_after_its_package_and_described_by_its_domain(self, text_stats_plan: MethodPlan):
        identity = derive_identity(text_stats_plan, CreateArgs(method=TEXT_STATS_REF))
        assert (identity.name, identity.package, identity.title) == ("text-stats", "text_stats", "Text Stats")
        assert identity.description.startswith("Deterministic text statistics")

    def test_a_catalog_entry_names_and_describes_the_project(self, text_stats_plan: MethodPlan):
        plan = replace(text_stats_plan, slug="invoice-extraction", catalog=CatalogEntry(name="Invoice  extraction", description="Reads invoices."))
        identity = derive_identity(plan, CreateArgs(method=STORED_METHOD_ID))
        assert (identity.name, identity.title, identity.description) == ("invoice-extraction", "Invoice extraction", "Reads invoices.")

    def test_a_derived_title_keeps_the_method_s_own_spelling(self, text_stats_plan: MethodPlan):
        plan = replace(text_stats_plan, slug="cv-screening", prose=MethodProse(description="Score a batch of CVs.", pipe_descriptions={}))
        assert derive_identity(plan, CreateArgs(method="x")).title == "CV Screening"

    def test_the_description_falls_back_to_the_pipe_s_then_to_a_sentence(self, text_stats_plan: MethodPlan):
        pipe_only = replace(text_stats_plan, prose=MethodProse(description=None, pipe_descriptions={text_stats_plan.pipe.ref: "Counts.\n  Words."}))
        assert derive_identity(pipe_only, CreateArgs(method="x")).description == "Counts. Words."
        bare = replace(text_stats_plan, prose=MethodProse(description=None, pipe_descriptions={}))
        assert derive_identity(bare, CreateArgs(method="x")).description == "Runs the Text Stats method through the Pipelex API."

    def test_every_value_given_wins(self, text_stats_plan: MethodPlan):
        identity = derive_identity(text_stats_plan, CreateArgs(method="x", name="mine", title="Mine", description="My own."))
        assert (identity.name, identity.title, identity.description) == ("mine", "Mine", "My own.")

    def test_every_value_reaches_the_bootstrap_in_the_equals_form_whatever_it_starts_with(self, text_stats_plan: MethodPlan):
        plan = replace(text_stats_plan, catalog=CatalogEntry(name="-- CV", description="-- draft: screens CVs"))
        args = CreateArgs(method="x", license_holder="--Acme")
        flags = bootstrap_flags(derive_identity(plan, args), args)
        assert flags == ["--name=text-stats", "--title=-- CV", "--description=-- draft: screens CVs", "--clean", "--license-holder=--Acme"]


# ── The env file ────────────────────────────────────────────────────────────


class TestEnvFile:
    def test_sets_a_key_exactly_once(self):
        text = "# a comment\nexport PIPELEX_BASE_URL=one\nOTHER=x\nPIPELEX_BASE_URL=two\n"
        assert set_env_line(text, "PIPELEX_BASE_URL", "'three'") == "# a comment\nPIPELEX_BASE_URL='three'\nOTHER=x\n"
        assert set_env_line("OTHER=x\n", "PIPELEX_API_KEY", "'k'") == "OTHER=x\nPIPELEX_API_KEY='k'\n"

    @pytest.mark.parametrize("value", ["pk_abc#def", "pk_$HOME", "it's a \\ key", "  spaced  "])
    def test_a_quoted_value_reads_back_exactly(self, value: str, tmp_path: Path):
        (tmp_path / ".env").write_text(f"PIPELEX_API_KEY={quote_env_value('PIPELEX_API_KEY', value)}\n", encoding="utf-8")
        assert dotenv_values(tmp_path / ".env")["PIPELEX_API_KEY"] == value

    @pytest.mark.parametrize(
        ("value", "says"),
        [("a\nb", "line break"), ("pk_${HOME}", "expand as a variable"), ("pk_\udce9", "not UTF-8")],
    )
    def test_a_value_no_env_file_can_hold_is_refused(self, value: str, says: str):
        # The last is a shell's byte that is not UTF-8, as Python decodes it into the environment.
        with pytest.raises(CreateError, match=says):
            quote_env_value("PIPELEX_API_KEY", value)

    def test_a_key_the_shell_did_not_export_is_never_written(self, tmp_path: Path):
        # The gesture refuses a run with no key at all, so a key the shell did not export came from an env file above.
        plan = plan_env_file(tmp_path, ShellEnv(), None, "https://api.pipelex.com")
        assert plan.action == "skip"
        assert "copies a key only from your shell" in plan.notes[0]

    @pytest.mark.parametrize("content", [b"PIPELEX_BASE_URL=\xe9\n", None])
    def test_an_example_it_cannot_read_is_refused_naming_it(self, content: bytes | None, tmp_path: Path):
        example = tmp_path / ".env.example"
        if content is None:
            if AS_ROOT:
                pytest.skip("root reads a file whose mode refuses everyone else")
            example.write_text("PIPELEX_BASE_URL=\n", encoding="utf-8")
            example.chmod(0)
        else:
            example.write_bytes(content)
        try:
            with pytest.raises(CreateError, match=r"\.env\.example cannot be read"):
                plan_env_file(tmp_path, ShellEnv(key="k"), None, "https://api.pipelex.com")
        finally:
            example.chmod(0o644)

    def test_an_existing_one_it_cannot_read_is_refused_naming_it(self, tmp_path: Path):
        (tmp_path / ".env").write_bytes(b"PIPELEX_BASE_URL=\xe9\n")
        with pytest.raises(CreateError, match=r"\.env cannot be read"):
            plan_env_file(tmp_path, ShellEnv(base_url="https://api.example.com", key="k"), tmp_path / ".env", "https://api.example.com")

    def test_the_env_file_the_values_are_read_from_must_be_readable(self, tmp_path: Path):
        (tmp_path / ".env").write_bytes(b"PIPELEX_BASE_URL=\xe9\n")
        with pytest.raises(CreateError, match=r"\.env cannot be read"):
            resolve_deps(tmp_path)

    def test_is_written_from_the_example_with_one_base_url_and_the_shell_s_key(self, tmp_path: Path):
        (tmp_path / ".env.example").write_text("# comment\nPIPELEX_BASE_URL=https://api.pipelex.com\nPIPELEX_API_KEY=\n", encoding="utf-8")
        plan = plan_env_file(tmp_path, ShellEnv(key="pk_#1"), None, "https://api.example.com")
        assert plan.action == "write" and plan.content is not None
        assert plan.content == "# comment\nPIPELEX_BASE_URL='https://api.example.com'\nPIPELEX_API_KEY='pk_#1'\n"
        assert "(the default)" in plan.notes[0] and "from your shell" in plan.notes[0]

    def test_an_existing_one_is_kept_and_a_disagreement_said(self, tmp_path: Path):
        (tmp_path / ".env").write_text("PIPELEX_BASE_URL=https://other.example.com\n", encoding="utf-8")
        plan = plan_env_file(tmp_path, ShellEnv(base_url="https://api.example.com", key="k"), tmp_path / ".env", "https://api.example.com")
        assert plan.action == "keep"
        assert "but .env says https://other.example.com" in plan.notes[1]

    def test_a_key_read_from_a_file_above_is_left_there(self, tmp_path: Path):
        project = tmp_path / "project"
        project.mkdir()
        plan = plan_env_file(project, ShellEnv(), tmp_path / ".env", "https://api.pipelex.com")
        assert plan == EnvPlan(action="skip", content=None, notes=plan.notes)
        assert "copies a key only from your shell" in plan.notes[0]

    def test_a_file_above_is_named_as_hidden_when_one_is_written(self, tmp_path: Path):
        plan = plan_env_file(tmp_path, ShellEnv(key="k"), tmp_path.parent / ".env", "https://api.pipelex.com")
        assert plan.action == "write"
        assert any("hides" in note for note in plan.notes)

    def test_is_written_readable_by_its_owner_alone_and_never_over_one(self, tmp_path: Path):
        assert write_env_file(tmp_path / ".env", "A='b'\n")
        assert stat.S_IMODE((tmp_path / ".env").stat().st_mode) == 0o600
        assert not write_env_file(tmp_path / ".env", "C='d'\n")
        assert (tmp_path / ".env").read_text(encoding="utf-8") == "A='b'\n"


# ── The two halves ──────────────────────────────────────────────────────────


@dataclass
class Runner:
    """Records each command the gesture hands over, with the environment it was given, and answers with a status."""

    statuses: dict[str, int] = field(default_factory=dict[str, int])
    commands: list[list[str]] = field(default_factory=list[list[str]])
    environments: list[Mapping[str, str] | None] = field(default_factory=list[Mapping[str, str] | None])

    def __call__(self, command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
        del cwd
        self.commands.append(list(command))
        self.environments.append(env)
        return self.statuses.get(self.label(list(command)), 0)

    @staticmethod
    def label(command: list[str]) -> str:
        if command[:2] == ["uv", "sync"]:
            return "uv sync"
        if command[:2] == ["make", "all"]:
            return "make all"
        return "bootstrap --dry-run" if "--dry-run" in command else "bootstrap"

    @property
    def labels(self) -> list[str]:
        return [self.label(command) for command in self.commands]


@pytest.fixture
def template(tmp_path: Path) -> Path:
    """A template of the test's own: its manifest, its bootstrap, an empty package and the env example."""
    root = tmp_path / "template"
    (root / "src" / PACKAGE).mkdir(parents=True)
    (root / "pyproject.toml").write_text(f'[project]\nname = "{TEMPLATE_NAME}"\n', encoding="utf-8")
    (root / BOOTSTRAP_SCRIPT).parent.mkdir(parents=True)
    (root / BOOTSTRAP_SCRIPT).write_text("", encoding="utf-8")
    (root / ".env.example").write_text("PIPELEX_BASE_URL=https://api.pipelex.com\nPIPELEX_API_KEY=\n", encoding="utf-8")
    return root


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch) -> RecordedClient:
    """The recorded client in place of `make_client`, and a key in the shell."""
    client = RecordedClient()
    monkeypatch.setattr(client_module, "make_client", lambda: client)
    monkeypatch.setenv("PIPELEX_API_KEY", "pk_test#1")
    return client


def deps(root: Path, runner: RunCommand, *, shell: ShellEnv | None = None) -> CreateDeps:
    return CreateDeps(root=root, cwd=root, shell=shell or ShellEnv(key="pk_test#1"), env_file=None, run=runner)


def flag_value(command: list[str], flag: str) -> str:
    """The value a command hands a flag, in the `--flag=value` form the gesture uses."""
    return next(arg.removeprefix(f"{flag}=") for arg in command if arg.startswith(f"{flag}="))


def tree(root: Path) -> dict[str, bytes]:
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in sorted(root.rglob("*")) if path.is_file()}


class TestReadOnlyHalf:
    async def test_refuses_anything_but_the_un_bootstrapped_template_before_any_request(
        self, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]
    ):
        (template / "pyproject.toml").write_text('[project]\nname = "receipt-review"\n', encoding="utf-8")
        assert await run_create([TEXT_STATS_REF], deps(template, Runner())) == 1
        assert 'pyproject.toml names "receipt-review"' in capsys.readouterr().err
        assert api.calls == []

    async def test_refuses_a_template_without_its_bootstrap(self, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]):
        (template / BOOTSTRAP_SCRIPT).unlink()
        assert await run_create([TEXT_STATS_REF], deps(template, Runner())) == 1
        assert f"{BOOTSTRAP_SCRIPT} is missing" in capsys.readouterr().err

    async def test_refuses_without_a_key_before_any_request(
        self, template: Path, api: RecordedClient, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ):
        monkeypatch.delenv("PIPELEX_API_KEY")
        assert await run_create([TEXT_STATS_REF], deps(template, Runner(), shell=ShellEnv())) == 1
        assert "PIPELEX_API_KEY is not set" in capsys.readouterr().err
        assert api.calls == []

    async def test_refuses_to_send_the_key_in_plaintext_to_another_machine(
        self, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]
    ):
        api.base_url = "http://api.example.com"
        assert await run_create([TEXT_STATS_REF], deps(template, Runner())) == 1
        assert "plaintext http:" in capsys.readouterr().err
        assert api.calls == []

    async def test_a_dry_run_prints_the_plan_and_writes_nothing(self, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]):
        before = tree(template)
        runner = Runner()
        assert await run_create([STORED_METHOD_ID, "--dry-run", "--license-holder", "Ada"], deps(template, runner)) == 0
        out = capsys.readouterr().out
        assert tree(template) == before
        assert runner.labels == ["bootstrap --dry-run"]
        command = runner.commands[0]
        assert flag_value(command, "--name") == "stored-text-stats"
        assert flag_value(command, "--title") == "Stored text stats"
        assert flag_value(command, "--license-holder") == "Ada"
        assert "--clean" in command and command[-1] == "--dry-run"
        assert "create: Stored text stats" in out
        assert "\n! a method_id is scoped to your key's organization" in out
        assert "  inputs: --text" in out
        assert "Nothing was written (--dry-run)." in out

    async def test_a_value_the_bootstrap_refuses_writes_nothing_and_names_the_flags(
        self, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]
    ):
        before = tree(template)
        runner = Runner(statuses={"bootstrap --dry-run": 1})
        assert await run_create([TEXT_STATS_REF, "--name", "json"], deps(template, runner)) == 1
        assert tree(template) == before
        assert runner.labels == ["bootstrap --dry-run"]
        assert "the bootstrap refused these values (see above). Nothing was written; pass the flag that fixes it: --name" in capsys.readouterr().err

    async def test_the_dry_run_checks_the_binding_the_gesture_will_write(self, template: Path, api: RecordedClient):
        planned: list[str] = []

        def read_the_binding(command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
            del cwd, env
            planned.append(Path(flag_value(list(command), "--binding")).read_text(encoding="utf-8"))
            return 0

        assert await run_create([TEXT_STATS_REF, "--dry-run"], replace(deps(template, Runner()), run=read_the_binding)) == 0
        assert len(planned) == 1
        assert 'PIPE_REF = "text_stats.analyze_text"\n' in planned[0]
        assert f"from {PACKAGE}.generated.models import Text\n" in planned[0]


class TestWriteHalf:
    async def test_runs_every_step_in_order_and_removes_the_bootstrap_last(
        self, template: Path, api: RecordedClient, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ):
        monkeypatch.setenv("UV_LOCKED", "1")
        monkeypatch.setenv("MAKEFLAGS", "METHOD=x")
        runner = Runner()
        assert await run_create([str(RECEIPT_REVIEW_BUNDLE)], deps(template, runner)) == 0
        assert runner.labels == ["bootstrap --dry-run", "bootstrap", "uv sync", "make all"]
        # `uv sync` must re-sync the lock the rename leaves stale, and `make all` must not read the gesture's variables.
        uv_env, make_env = runner.environments[2], runner.environments[3]
        assert uv_env is not None and "UV_LOCKED" not in uv_env
        assert make_env is not None and "MAKEFLAGS" not in make_env
        layout = Layout(template / "src" / PACKAGE)
        assert (layout.method_dir / "main.mthds").is_file() and (layout.package_dir / BINDING_FILENAME).is_file()
        assert not (template / BOOTSTRAP_DIR).exists() and not (template / ".claude").exists()
        env = template / ".env"
        assert stat.S_IMODE(env.stat().st_mode) == 0o600
        lines = env.read_text(encoding="utf-8").splitlines()
        assert [line for line in lines if line.startswith("PIPELEX_BASE_URL")] == ["PIPELEX_BASE_URL='https://api.example.com'"]
        assert dotenv_values(env)["PIPELEX_API_KEY"] == "pk_test#1"
        assert "create: done. Receipt Review (receipt-review) runs the pipe receipt_review.review_receipts" in capsys.readouterr().out

    async def test_a_failed_write_leaves_the_template_as_it_was(self, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]):
        before = tree(template)
        runner = Runner()
        original = runner.__call__

        def bind_meanwhile(command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
            # The binding appears between the halves, and the write refuses to replace it.
            (template / "src" / PACKAGE / BINDING_FILENAME).write_text("# mine\n", encoding="utf-8")
            return original(command, cwd, env)

        assert await run_create([TEXT_STATS_REF], replace(deps(template, runner), run=bind_meanwhile)) == 1
        assert "writing the method failed" in capsys.readouterr().err
        assert tree(template) == {**before, f"src/{PACKAGE}/{BINDING_FILENAME}": b"# mine\n"}

    @pytest.mark.parametrize(
        ("failing", "says", "left", "done"),
        [
            (
                "bootstrap",
                "the bootstrap failed after the method was written",
                [f".venv/bin/python {BOOTSTRAP_SCRIPT} --name=text-stats", "cp .env.example .env", "uv sync", "make all", f"rm -rf {BOOTSTRAP_DIR}"],
                [],
            ),
            ("uv sync", "re-syncing uv.lock failed", ["uv sync", "make all", f"rm -rf {BOOTSTRAP_DIR}"], []),
            ("make all", "make all is red", ["make all", f"rm -rf {BOOTSTRAP_DIR}"], ["uv sync"]),
        ],
    )
    async def test_a_failure_after_the_method_is_written_names_the_commands_left(
        self, failing: str, says: str, left: list[str], done: list[str], template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]
    ):
        runner = Runner(statuses={failing: 1})
        assert await run_create([TEXT_STATS_REF], deps(template, runner)) == 1
        err = capsys.readouterr().err
        assert says in err
        for command in left:
            assert f"\n  {command}" in err
        for command in done:
            assert f"\n  {command}" not in err
        # The method stays: the gesture cannot run again on a template it has started to turn into a project.
        assert (template / "src" / PACKAGE / BINDING_FILENAME).is_file()
        assert (template / BOOTSTRAP_DIR).is_dir()

    @pytest.mark.parametrize("renamed", [False, True])
    async def test_the_bootstrap_s_command_left_takes_force_once_pyproject_names_the_project(
        self, renamed: bool, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]
    ):
        def fail_the_bootstrap(command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
            del cwd, env
            if Runner.label(list(command)) != "bootstrap":
                return 0
            if renamed:
                # The bootstrap writes pyproject.toml last, so a failure after it found every other file written.
                (template / "pyproject.toml").write_text('[project]\nname = "text-stats"\n', encoding="utf-8")
            return 1

        assert await run_create([TEXT_STATS_REF], replace(deps(template, Runner()), run=fail_the_bootstrap)) == 1
        err = capsys.readouterr().err
        command = next(line.strip() for line in err.splitlines() if BOOTSTRAP_SCRIPT in line)
        assert command.endswith(" --force") is renamed

    @pytest.mark.skipif(AS_ROOT, reason="root writes into a directory whose mode refuses everyone else")
    async def test_an_env_file_it_cannot_write_names_the_commands_left(self, template: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]):
        def lock_the_root(command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
            del cwd, env
            if Runner.label(list(command)) == "bootstrap":
                template.chmod(0o555)
            return 0

        try:
            assert await run_create([TEXT_STATS_REF], replace(deps(template, Runner()), run=lock_the_root)) == 1
        finally:
            template.chmod(0o755)
        err = capsys.readouterr().err
        assert "writing .env failed" in err
        for command in ("cp .env.example .env", "uv sync", "make all", f"rm -rf {BOOTSTRAP_DIR}"):
            assert f"\n  {command}" in err
        assert not (template / ".env").exists()


@dataclass
class RealBootstrap:
    """Runs the bootstrap for real, its output on this process's own streams; `uv sync` and `make all` are not run.

    The real run's status is the test's to choose, so that a run that wrote everything can be reported as failed.
    """

    real_run_status: int = 0

    def __call__(self, command: Sequence[str], cwd: Path, env: Mapping[str, str] | None) -> int:
        label = Runner.label(list(command))
        if label in ("uv sync", "make all"):
            return 0
        result = subprocess.run(list(command), cwd=cwd, env=None if env is None else dict(env), capture_output=True, text=True, check=False)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if label == "bootstrap" and result.returncode == 0:
            return self.real_run_status
        return result.returncode


class TestWithTheRealBootstrap:
    """The gesture over a copy of the template, its bootstrap run for real."""

    async def test_the_command_left_finishes_a_bootstrap_that_failed_after_writing_pyproject(
        self, tmp_path: Path, api: RecordedClient, capsys: pytest.CaptureFixture[str]
    ):
        root = copy_template(tmp_path / "project")
        # The bootstrap writes every file, pyproject.toml last, and its run is then reported as failed.
        assert await run_create([TEXT_STATS_REF], deps(root, RealBootstrap(real_run_status=1))) == 1
        err = capsys.readouterr().err
        command = next(line.strip() for line in err.splitlines() if BOOTSTRAP_SCRIPT in line)
        again = subprocess.run(shlex.split(command), cwd=root, capture_output=True, text=True, check=False)
        assert again.returncode == 0, again.stdout + again.stderr

    async def test_a_derived_value_that_starts_with_dashes_reaches_the_bootstrap(
        self, tmp_path: Path, api: RecordedClient, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ):
        async def drafted(method_id: str) -> MethodData:
            return MethodData.model_validate(stored_method(method_id, name="Text stats", description="-- draft: screens CVs"))

        monkeypatch.setattr(api, "get_method", drafted)
        root = copy_template(tmp_path / "project")
        assert await run_create([STORED_METHOD_ID, "--dry-run"], deps(root, RealBootstrap())) == 0
        assert "Nothing was written (--dry-run)." in capsys.readouterr().out

    async def test_a_binding_the_bootstrap_would_refuse_is_refused_before_anything_is_written(
        self, tmp_path: Path, api: RecordedClient, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ):
        written_by_the_gesture = create_plan.BINDING_TEMPLATE.replace('"""The binding:', '"""Written by make create. The binding:', 1)
        monkeypatch.setattr(create_plan, "BINDING_TEMPLATE", written_by_the_gesture)
        root = copy_template(tmp_path / "project")
        before = tree(root)
        assert await run_create([TEXT_STATS_REF], deps(root, RealBootstrap())) == 1
        captured = capsys.readouterr()
        assert f"src/{PACKAGE}/{BINDING_FILENAME}:1: " in captured.err
        assert "Nothing was written" in captured.err
        assert tree(root) == before
