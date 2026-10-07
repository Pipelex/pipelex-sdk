"""The wire-format table, replayed: the CLI sends what the form kernel, `@pipelex/mthds-form`, sends.

`fixtures/wire/table.json` is recorded from the real kernel, at the version it names, over the
contract fixtures in `fixtures/wire/contracts/`, one of them assembled to reach every field kind. It
is a regression of `lib/wire.py` and `lib/inputs.py`, so never edit it to make a test pass: it
records what the kernel sends, not what the CLI does. Each case is one pipe given every input, the
required ones only, or none, with the value each control holds, the option values the CLI is given
for the same value, and the kernel's verdict. This test gives the CLI those option values on a real
command line, over the fake client, and holds it to the verdict:

- where the kernel sends inputs, the run the CLI starts carries exactly the same inputs, uploads
  included, since a local file given to an option goes through the SDK's `prepare_inputs`;
- where the kernel refuses, the CLI refuses as a usage error and names every input the kernel names
  as missing. It may name one more only where the kernel's own errors name it too: the kernel's
  missing scan passes over an empty list of a fixed count, which only its schema errors report.

One disagreement is deliberate, and listed in `DISAGREEMENTS` with its reason: it is documented in
`docs/cli-kernel.md`, and a case listed there is held to what the CLI does instead.
"""

import json
import re
from pathlib import Path
from typing import Any

import pytest

from pipelex_method_cli_python.cli import RESERVED_FLAGS
from pipelex_method_cli_python.lib.contracts import contracts_for_pipe
from pipelex_method_cli_python.lib.inputs import InputOption, OptionStyle, derive_options
from tests.support import FIXTURES, FakeClient, invoke, make_binding, pipe_io_report, wire_contracts

#: The recorded table.
TABLE: dict[str, Any] = json.loads((FIXTURES / "wire" / "table.json").read_text(encoding="utf-8"))

#: An input the CLI's refusal names, as `collect_inputs` writes it: `name (--flag)`.
_NAMED_INPUT = re.compile(r"(\w+) \(--[\w-]+\)")

#: The cases where the CLI sends something other than the kernel, on purpose, by pipe and case.
#: The kernel sends an `unknown` input, a `native.JSON` one, as the raw string its text area holds,
#: which its own schema check then refuses as "must be object" and reports as missing: the web app
#: cannot run such a pipe. The CLI parses the JSON its option is given and sends the object, which is
#: what the input's schema asks for.
DISAGREEMENTS: dict[tuple[str, str], dict[str, Any]] = {
    ("every_kind.take_json", "every input"): {"payload": {"concept": "native.JSON", "content": {"json_obj": {"answer": 42}}}},
    ("every_kind.take_json", "required only"): {"payload": {"concept": "native.JSON", "content": {"json_obj": {"answer": 42}}}},
}


def _case_id(case: dict[str, Any]) -> str:
    return f"{case['pipe_ref']} · {case['case']}"


def command_line(options: tuple[InputOption, ...], given: dict[str, Any]) -> list[str]:
    """The arguments that give each input its recorded option values."""
    by_name = {option.name: option for option in options}
    args: list[str] = []
    for name, entry in given.items():
        option = by_name[name]
        values: list[str] = entry["cli"]
        if option.style is OptionStyle.FLAG:
            (value,) = values
            args.append(option.flag if value == "true" else f"--no-{option.flag.removeprefix('--')}")
        else:
            for value in values:
                args.extend([option.flag, value])
    return args


def test_the_table_was_recorded_from_the_kernel_webapp_js_installs():
    # The recorder names the kernel it ran; a table recorded by hand would not.
    assert TABLE["kernel"].startswith("@pipelex/mthds-form ")
    assert {case["case"] for case in TABLE["cases"]} == {"every input", "required only", "nothing"}


def test_every_disagreement_names_a_case_of_the_table():
    recorded = {(case["pipe_ref"], case["case"]) for case in TABLE["cases"]}
    assert set(DISAGREEMENTS) <= recorded


@pytest.mark.parametrize("case", TABLE["cases"], ids=_case_id)
def test_the_cli_sends_what_the_form_kernel_sends(case: dict[str, Any], fake_client: FakeClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    document = wire_contracts(case["fixture"])
    contracts = contracts_for_pipe(document, case["pipe_ref"])
    options = derive_options(contracts, reserved=RESERVED_FLAGS)
    # A file the case uploads is a local file the CLI is given by name, which the fake answers with the recorded reference.
    monkeypatch.chdir(tmp_path)
    for filename in case["uploads"]:
        (tmp_path / filename).write_bytes(b"\x89PNG")
    fake_client.upload_uris = dict(case["uploads"])
    fake_client.pipe_io_answer = pipe_io_report(document)

    result = invoke(make_binding(contracts=contracts), command_line(options, case["given"]))

    verdict = case["verdict"]
    disagreement = DISAGREEMENTS.get((case["pipe_ref"], case["case"]))
    if disagreement is not None:
        assert not verdict["ok"], "the kernel now sends this case: drop it from DISAGREEMENTS"
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"] == disagreement
        return
    if verdict["ok"]:
        assert result.exit_code == 0, result.stderr
        assert fake_client.started[0]["inputs"] == verdict["inputs"]
        assert sorted(fake_client.uploaded) == sorted(case["uploads"])
        return
    assert result.exit_code == 2, result.stderr
    assert result.stdout == ""
    assert fake_client.entered == 0
    named = set(_NAMED_INPUT.findall(result.stderr))
    assert set(verdict["missing_inputs"]) <= named
    reported = {error["property"].lstrip(".").split(".")[0] for error in verdict["errors"]}
    assert named - set(verdict["missing_inputs"]) <= reported
