"""The live account check (`tests/e2e/live_account.py`) against its shared cases, `tests/fixtures/live-account-cases.json`.

The file's source is `js/tests/fixtures/live-account-cases.json`, which `@pipelex/sdk`'s suite answers to its own check;
this copy is written by `make shared-files` at the repository's root and never edited.
"""

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from pytest_mock import MockerFixture

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiUnreachableError
from tests.e2e.live_account import PYTHON_E2E_TARGET, LiveTarget, MeAnswer, check_live_account, main, read_me_with_sdk
from tests.unit.conftest import problem_document

_CASES_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "live-account-cases.json"
_CASE_FILE: dict[str, Any] = json.loads(_CASES_PATH.read_text(encoding="utf-8"))
_CASES: list[dict[str, Any]] = _CASE_FILE["cases"]
_HOSTED_ENV = {
    "PIPELEX_E2E_BASE_URL": "https://api-dev.pipelex.com",
    "PIPELEX_API_KEY": "not-a-real-key",
    "PIPELEX_API_KEY_EXPECTED_ORG_ID": "org_1",
    "PIPELEX_API_KEY_EXPECTED_ROLE": "member",
    "PIPELEX_API_KEY_EXPECTED_EMAIL": "qa+builder@example.com",
}


def _target(name: str) -> LiveTarget:
    target = _CASE_FILE["targets"][name]
    return LiveTarget(base_url_env=target["base_url_env"], default_base_url=target["default_base_url"], run_command=target["run_command"])


class TestLiveAccount:
    @pytest.mark.parametrize("case", _CASES, ids=[case["name"] for case in _CASES])
    def test_answers_each_shared_case(self, case: dict[str, Any]) -> None:
        """Each shared case gets its verdict, asks /v1/me only when it must, at the base URL the case names, and says what it names."""
        asked: list[tuple[str, str]] = []

        async def read_me(base_url: str, api_key: str) -> MeAnswer:
            asked.append((base_url, api_key))
            if case["me"] is None:
                msg = "the check asked /v1/me where it must not"
                raise AssertionError(msg)
            return MeAnswer(status=case["me"]["status"], body=case["me"]["body"])

        verdict = asyncio.run(check_live_account(_target(case["target"]), environ=case["env"], read_me=read_me))

        assert verdict.verdict == case["verdict"]
        assert len(asked) == (0 if case["me"] is None else 1)
        if asked:
            assert asked[0] == (case["me_at"], case["env"]["PIPELEX_API_KEY"])
        for mention in case["mentions"]:
            assert mention in verdict.said
        for absent in case.get("absent", []):
            assert absent not in verdict.said

    def test_names_the_python_suite_target_as_the_shared_cases_do(self) -> None:
        """The suite's own target is the shared cases' `python_e2e`."""
        assert _target("python_e2e") == PYTHON_E2E_TARGET

    def test_reports_a_platform_out_of_reach_without_blaming_the_account(self) -> None:
        """A /v1/me that got no answer is a finding of its own, with no word for the registry's owner."""

        async def read_me(base_url: str, api_key: str) -> MeAnswer:
            msg = f"could not reach {base_url} with a key of {len(api_key)} characters"
            raise ApiUnreachableError(msg, api_url=base_url)

        verdict = asyncio.run(check_live_account(PYTHON_E2E_TARGET, environ=_HOSTED_ENV, read_me=read_me))

        assert verdict.verdict == "refused"
        assert "GET /v1/me gave no answer: could not reach https://api-dev.pipelex.com" in verdict.said
        assert "The registry's owner restores the account" not in verdict.said

    @pytest.mark.parametrize(
        ("status", "body", "expected"),
        [
            (
                200,
                {"user_id": "user_1", "email": "a@example.com", "full_name": "A", "organization": {"org_id": "org_1"}},
                MeAnswer(
                    status=200,
                    body={"user_id": "user_1", "email": "a@example.com", "full_name": "A", "organization": {"org_id": "org_1"}},
                ),
            ),
            (
                401,
                problem_document("auth.invalid_credential", 401, domain="account"),
                MeAnswer(status=401, body={"code": "auth.invalid_credential"}),
            ),
        ],
        ids=["the profile with the members it does not type, and none it adds", "a refusal as its status and code"],
    )
    def test_reads_me_through_the_sdk(self, mocker: MockerFixture, status: int, body: dict[str, Any], expected: MeAnswer) -> None:
        """The SDK's read hands the check what /v1/me answered, an absent member kept absent."""

        def answer(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/me"
            assert request.headers["authorization"] == "Bearer not-a-real-key"
            return httpx.Response(status, json=body, headers={"content-type": "application/problem+json"}, request=request)

        original_start = PipelexAPIClient.start_client

        def start_with_transport(client: PipelexAPIClient) -> PipelexAPIClient:
            original_start(client)
            assert client.client is not None
            client.client = httpx.AsyncClient(headers=client.client.headers, transport=httpx.MockTransport(answer))
            return client

        mocker.patch.object(PipelexAPIClient, "start_client", start_with_transport)

        assert asyncio.run(read_me_with_sdk("https://api-dev.pipelex.com", "not-a-real-key")) == expected

    def test_command_exits_on_a_refusal_with_its_message(self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
        """Run as a command, a refusal exits 1 with its message on standard error, before any request."""
        monkeypatch.delenv("PIPELEX_BASE_URL", raising=False)
        monkeypatch.delenv("PIPELEX_E2E_ALLOW_PRODUCTION", raising=False)

        status = main(
            ["--base-url-env", "PIPELEX_BASE_URL", "--default-base-url", "https://api.pipelex.com", "--run-command", "test-account run x -- y"]
        )

        assert status == 1
        captured = capsys.readouterr()
        assert "PIPELEX_BASE_URL is not set, so the live cases would call the production API" in captured.err
        assert "test-account run x -- y" in captured.err
        assert not captured.out

    def test_command_says_its_verdict_and_exits_0_otherwise(self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
        """Run as a command against a local runner, it says why nothing is checked and exits 0."""
        monkeypatch.setenv("PIPELEX_BASE_URL", "http://localhost:8081")

        status = main(["--base-url-env", "PIPELEX_BASE_URL", "--run-command", "test-account run x -- y"])

        assert status == 0
        assert "http://localhost:8081 is a local runner" in capsys.readouterr().out
