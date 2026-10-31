"""The account a live e2e run acts for, checked once before its first case.

Against the hosted plane, the live legs act for one registered test account: QA Builder (dev) in QA SDK (dev), whose
key the workspace's `test-account run` hands over in `PIPELEX_API_KEY`, beside what the Pipelex team's registry of
test accounts expects of it, in `PIPELEX_API_KEY_EXPECTED_ORG_ID`, `PIPELEX_API_KEY_EXPECTED_ROLE` and
`PIPELEX_API_KEY_EXPECTED_EMAIL`. Before any case, `GET /v1/me` says who the key is, through the SDK's own `get_me()`,
and any difference stops the run once, naming each variable, the value found and the value expected. In order, the
check:

1. finds the base URL, and does nothing when there is none, or when it is a loopback address, a local runner or
   stack, which holds no registered test account; a base URL that is not an http or https URL is refused;
2. refuses the production API, its host compared without case or a trailing dot, unless
   `PIPELEX_E2E_ALLOW_PRODUCTION=1` asks for it;
3. refuses a run with no key, or with an expectation unset, before any request, naming `test-account run`;
4. asks `/v1/me` and compares the account's email, ignoring case, its organization by id and its role there. A
   platform whose answer has no `organization` member predates it, and is reported as such, never as a pass.

Every line and message shows the base URL as its scheme and host alone, naming any credentials, path, query or
fragment it carried without their text.

`@pipelex/sdk`'s e2e suite runs the same check (`js/tests/e2e/live-account.ts`), and both answer the shared cases of
`tests/fixtures/live-account-cases.json`. The repository's root runs this module as a command before the starters'
live checks (`python -m tests.e2e.live_account --help`, from `python/`). The page for a person is
`docs/live-accounts.md` at the repository's root.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import os
import sys
from enum import StrEnum
from typing import TYPE_CHECKING, Literal, NamedTuple, cast
from urllib.parse import unquote, urlsplit

from pipelex_sdk.client import PipelexAPIClient
from pipelex_sdk.errors import ApiResponseError, PipelexRequestError

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Mapping, Sequence

#: The variable holding the key the live cases act with.
API_KEY_ENV = "PIPELEX_API_KEY"
#: The variable that lets a live run call the production API, when it holds exactly `1`.
ALLOW_PRODUCTION_ENV = "PIPELEX_E2E_ALLOW_PRODUCTION"
ALLOW_PRODUCTION_VALUE = "1"
#: The production API's host, which a live run calls only when asked to.
PRODUCTION_HOST = "api.pipelex.com"
OK_STATUS = 200

_ME_ROUTE = "GET /v1/me"
_DOC = "docs/live-accounts.md at the repository's root"


class Expectation(StrEnum):
    """What the registry expects of a key, each in the variable named after the key's with this suffix.

    The suffixes are the workspace's `test-account run` contract.
    """

    ORG_ID = "_EXPECTED_ORG_ID"
    ROLE = "_EXPECTED_ROLE"
    EMAIL = "_EXPECTED_EMAIL"

    @property
    def variable(self) -> str:
        """The variable holding this expectation of the key in `PIPELEX_API_KEY`."""
        return f"{API_KEY_ENV}{self}"


class LiveTarget(NamedTuple):
    """Where a suite's live cases go, and how a refusal tells the person to run them."""

    #: The variable naming the base URL.
    base_url_env: str
    #: The base URL when that variable is unset or empty; `None` when the live legs then skip.
    default_base_url: str | None
    #: The command a refusal names, the workspace's `test-account run` around the suite's target.
    run_command: str


#: The Python e2e suite's target: its live legs skip unless `PIPELEX_E2E_BASE_URL` names one.
PYTHON_E2E_TARGET = LiveTarget(
    base_url_env="PIPELEX_E2E_BASE_URL",
    default_base_url=None,
    run_command="test-account run pipelex-sdk-python-e2e -- make -C python e2e-test",
)


class MeAnswer(NamedTuple):
    """What `GET /v1/me` answered: its HTTP status and its JSON body."""

    status: int
    body: object


VerdictKind = Literal["no_target", "local", "confirmed", "refused"]


class LiveAccountVerdict(NamedTuple):
    """The check's verdict, with the line it reports, or the one message a refusal stops the run with."""

    verdict: VerdictKind
    said: str


class _Finding(NamedTuple):
    """One reason the account could not be confirmed, and whether only the registry's owner restores it."""

    text: str
    owner_restores: bool


def _rendered(value: object) -> str:
    """A value as a finding renders it: as JSON, a missing one as `null`."""
    return json.dumps(value, ensure_ascii=False)


def _listed(names: Sequence[str]) -> str:
    """'A is', 'A and B are', 'A, B and C are'."""
    if len(names) == 1:
        return f"{names[0]} is"
    return f"{', '.join(names[:-1])} and {names[-1]} are"


def _is_loopback(host: str) -> bool:
    """Whether a host is this machine: `localhost`, a subdomain of it, `127.x.x.x` or `::1`."""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _in_words(parts: Sequence[str]) -> str:
    """'A', 'A and B', 'A, B and C'."""
    if len(parts) == 1:
        return parts[0]
    return f"{', '.join(parts[:-1])} and {parts[-1]}"


_DEFAULT_PORTS = {"http": 80, "https": 443}


class _BaseUrl(NamedTuple):
    """A base URL the check can call, as it compares it and as its lines show it."""

    #: The host as the check compares it: percent-decoded, lowercased and without the trailing dot that names the same
    #: host to DNS, so `https://api.pipelex.com.` is the production API too.
    host: str
    #: The base URL as a line or a message shows it: its scheme and its host, then the names of the parts beyond them it
    #: carried, never their text, as the SDK's own refusal of a base URL shows one (`_describe_refused_base_url` in
    #: `pipelex_sdk/client.py`). Credentials, a path and a query are where a secret travels in a URL, and these lines
    #: reach a terminal or a CI log.
    shown: str


def _parse_base_url(base_url: str) -> _BaseUrl | None:
    """The base URL, or `None` when it is not an http or https URL with a host."""
    try:
        # Trailing slashes are stripped first, as the client strips them (`pipelex_sdk/client.py`).
        parts = urlsplit(base_url.rstrip("/"))
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in _DEFAULT_PORTS or not hostname:
        return None
    carried = [
        part
        for part, present in (
            ("credentials", parts.username is not None or parts.password is not None),
            ("a path", parts.path not in {"", "/"}),
            ("a query", bool(parts.query)),
            ("a fragment", bool(parts.fragment)),
        )
        if present
    ]
    # Percent-decoded, as a WHATWG URL parser decodes a host, so both SDKs' checks see and show the same host.
    decoded = unquote(hostname).lower()
    shown_host = f"[{decoded}]" if ":" in decoded else decoded
    shown_port = f":{port}" if port is not None and port != _DEFAULT_PORTS[parts.scheme] else ""
    origin = f"{parts.scheme}://{shown_host}{shown_port}"
    return _BaseUrl(
        host=decoded.rstrip("."),
        shown=f"{origin} with {_in_words(carried)} (not shown)" if carried else origin,
    )


def _organization_label(organization: Mapping[str, object]) -> str:
    """An organization as a finding names it: its name and its id, or its id alone when it states no name."""
    name = organization.get("name")
    org_id = organization.get("org_id")
    return f"{name} ({org_id})" if isinstance(name, str) and name else _rendered(org_id)


def _read_account(answer: MeAnswer, *, org_id: str, role: str, email: str) -> tuple[list[_Finding], str]:
    """Compare a `/v1/me` answer with what the registry expects of the key: every difference, and the confirmed account."""
    if answer.status != OK_STATUS:
        body = answer.body
        code = cast("dict[str, object]", body).get("code") if isinstance(body, dict) else None
        named = f" ({code})" if isinstance(code, str) and code else ""
        return [_Finding(f"{API_KEY_ENV}: {_ME_ROUTE} refused the key: HTTP {answer.status}{named}", owner_restores=True)], ""
    stated: object = answer.body
    if not isinstance(stated, dict):
        return [_Finding(f"{API_KEY_ENV}: {_ME_ROUTE} answered {_rendered(stated)}, not a profile", owner_restores=False)], ""
    body = cast("dict[str, object]", stated)

    findings: list[_Finding] = []
    stated_email = body.get("email")
    if not isinstance(stated_email, str) or stated_email.casefold() != email.casefold():
        findings.append(
            _Finding(
                f"{API_KEY_ENV}: {_ME_ROUTE} states the account {_rendered(stated_email)}, "
                f"where {Expectation.EMAIL.variable} expects {_rendered(email)}",
                owner_restores=True,
            )
        )
    if "organization" not in body:
        findings.append(
            _Finding(
                f"{API_KEY_ENV}: the platform does not state the key's organization yet, so its organization and role cannot be "
                f"compared with {Expectation.ORG_ID.variable} and {Expectation.ROLE.variable}",
                owner_restores=False,
            )
        )
        return findings, ""
    if not isinstance(body["organization"], dict):
        findings.append(
            _Finding(
                f"{API_KEY_ENV}: {_ME_ROUTE} states the key acts for no organization, "
                f"where {Expectation.ORG_ID.variable} expects {_rendered(org_id)}",
                owner_restores=True,
            )
        )
        return findings, ""
    organization = cast("dict[str, object]", body["organization"])

    label = _organization_label(organization)
    if organization.get("org_id") != org_id:
        findings.append(
            _Finding(
                f"{API_KEY_ENV}: {_ME_ROUTE} states the organization {label}, where {Expectation.ORG_ID.variable} expects {_rendered(org_id)}",
                owner_restores=True,
            )
        )
    stated_role = organization.get("role_in_org")
    if stated_role != role:
        findings.append(
            _Finding(
                f"{API_KEY_ENV}: {_ME_ROUTE} states the role {_rendered(stated_role)} in {label}, "
                f"where {Expectation.ROLE.variable} expects {_rendered(role)}",
                owner_restores=True,
            )
        )
    return findings, f"{API_KEY_ENV} acts for {label} as {stated_role}"


def _stop_message(shown_base_url: str, findings: Sequence[_Finding], target: LiveTarget) -> str:
    """The one message a run stops with when its account could not be confirmed."""
    headline = (
        f"The live cases did not start: the account {API_KEY_ENV} acts for at {shown_base_url} could not be confirmed as the one "
        "the registry of test accounts expects."
    )
    lines = [headline, *(f"- {finding.text}" for finding in findings)]
    if any(finding.owner_restores for finding in findings):
        lines.append("The registry's owner restores the account; never change the key or its expectations to get past this.")
    lines.append(f"On a laptop, run the live cases through the workspace's `{target.run_command}` ({_DOC}).")
    return "\n".join(lines)


async def read_me_with_sdk(base_url: str, api_key: str) -> MeAnswer:
    """The SDK's own read of `/v1/me`: the profile with every member it does not type, or the refusal's status and code."""
    async with PipelexAPIClient(api_key=api_key, base_url=base_url) as client:
        try:
            profile = await client.get_me()
        except ApiResponseError as exc:
            return MeAnswer(status=exc.status, body={"code": exc.problem.code})
    return MeAnswer(status=OK_STATUS, body=profile.model_dump(mode="json", exclude_unset=True))


def _refused(message: str) -> LiveAccountVerdict:
    return LiveAccountVerdict(verdict="refused", said=message)


async def check_live_account(
    target: LiveTarget,
    *,
    environ: Mapping[str, str] | None = None,
    read_me: Callable[[str, str], Awaitable[MeAnswer]] | None = None,
) -> LiveAccountVerdict:
    """Check the account a live run acts for against the expectations its environment carries.

    Nothing is sent before the base URL, the production gate, the key and the expectations hold. `read_me` reads
    `/v1/me` from a base URL with a key, the SDK's own `get_me()` by default; a request that gets no answer, such as one
    whose platform cannot be reached, is reported as a finding rather than raised.
    """
    env = os.environ if environ is None else environ
    reader = read_me_with_sdk if read_me is None else read_me

    named = env.get(target.base_url_env, "").strip() or None
    base_url = named or target.default_base_url
    if base_url is None:
        return LiveAccountVerdict(verdict="no_target", said=f"{target.base_url_env} is not set, so the live legs skip and no account is checked.")

    parsed = _parse_base_url(base_url)
    if parsed is None:
        return _refused(
            f"The live cases did not start: {target.base_url_env} is not an http or https URL, so no request was sent. "
            "Its value is not shown, since nothing says which of its characters are a secret."
        )
    shown = parsed.shown
    if _is_loopback(parsed.host):
        return LiveAccountVerdict(
            verdict="local",
            said=f"{shown} is a local runner, which holds no registered test account, so the live cases run without an account check.",
        )

    if parsed.host == PRODUCTION_HOST and env.get(ALLOW_PRODUCTION_ENV) != ALLOW_PRODUCTION_VALUE:
        where = (
            f"{target.base_url_env} is not set, so the live cases would call the production API, {shown},"
            if named is None
            else f"{target.base_url_env} names the production API, {shown},"
        )
        return _refused(
            f"The live cases did not start: {where} which they call only when {ALLOW_PRODUCTION_ENV}={ALLOW_PRODUCTION_VALUE} asks for it, "
            f"so no request was sent. Run them through the workspace's `{target.run_command}`, which points them at the dev plane ({_DOC})."
        )

    api_key = env.get(API_KEY_ENV) or None
    if api_key is None:
        return _refused(
            f"The live cases did not start: {shown} is a hosted plane and {API_KEY_ENV} is not set, so no request was sent. "
            f"Run them through the workspace's `{target.run_command}`, which hands over the key of the test account they act for "
            f"beside what the registry expects of it ({_DOC})."
        )

    missing = [expectation.variable for expectation in Expectation if not env.get(expectation.variable)]
    if missing:
        return _refused(
            f"The live cases did not start: {_listed(missing)} not set, so nothing says which account {API_KEY_ENV} must act for, "
            f"and no request was sent. Run them through the workspace's `{target.run_command}`, which hands over the key beside what "
            f"the registry of test accounts expects of it; a CI job sets the same variables from the registry ({_DOC})."
        )

    try:
        answer = await reader(base_url, api_key)
    except PipelexRequestError as exc:
        finding = _Finding(f"{API_KEY_ENV}: {_ME_ROUTE} gave no answer: {exc}", owner_restores=False)
        return _refused(_stop_message(shown, [finding], target))

    findings, confirmed = _read_account(
        answer,
        org_id=env[Expectation.ORG_ID.variable],
        role=env[Expectation.ROLE.variable],
        email=env[Expectation.EMAIL.variable],
    )
    if findings:
        return _refused(_stop_message(shown, findings, target))
    return LiveAccountVerdict(verdict="confirmed", said=f"{confirmed} at {shown}, as the registry of test accounts expects.")


def main(argv: Sequence[str] | None = None) -> int:
    """Check the account of a live run whose target the arguments name; exit 1 on a refusal, 0 otherwise."""
    parser = argparse.ArgumentParser(
        prog="python -m tests.e2e.live_account",
        description="Check the account a live run acts for before its first case (docs/live-accounts.md at the repository's root).",
    )
    parser.add_argument("--base-url-env", required=True, help="The variable naming the base URL.")
    parser.add_argument("--default-base-url", default=None, help="The base URL when that variable is unset or empty.")
    parser.add_argument("--run-command", required=True, help="The `test-account run` command a refusal names.")
    arguments = parser.parse_args(argv)
    target = LiveTarget(base_url_env=arguments.base_url_env, default_base_url=arguments.default_base_url, run_command=arguments.run_command)
    verdict = asyncio.run(check_live_account(target))
    if verdict.verdict == "refused":
        sys.stderr.write(f"{verdict.said}\n")
        return 1
    sys.stdout.write(f"{verdict.said}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
