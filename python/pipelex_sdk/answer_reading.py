"""How the SDK reads an answer that is not the route's result as a problem: a refusal, a failure, or a `2xx` it
cannot read. `@pipelex/sdk` reads every answer the same way in its `answer-reading.ts`, and the shared case file
`tests/fixtures/sdk-problems.json` pins the readings both apply.

- A body that is a problem document reads as received, every member it carries kept, a `pipelex.*` code and the
  members the standard does not name included, its `status` taken from the answer when it leaves it out and its
  `retry_after` from the `Retry-After` header when it gives none and its `retry` is `yes` (`read_answer` in
  `mthds.protocol.problem.answers`). On a start or an execute too: the problem's own `retry` says whether a run
  may exist.
- A body that is no problem document is the hosted edge's, a gateway's or a proxy's, which nobody configures,
  and reads by the rules below. They stay written here until the registry records them and every client
  generates them.

On a request that creates a run, a `start` or an `execute`:

- a `2xx` the SDK could not read is `client.outcome_unknown`, since the server accepted the request and only its
  acknowledgement was lost, naming the run when the body names one;
- a `408`, which a proxy may answer for a request it forwarded, and a `5xx` but a `501`, which a gateway answers
  when the platform was slow or unreachable behind it, are `client.outcome_unknown` too, whatever the time it
  took: the run may have started behind it.

On any route, and on a start for every other status:

- a `401` is `auth.missing_credential`: the edge answers it before the platform when the request carries no
  credential;
- a `403` is `auth.invalid_credential`: the edge's authorizer refused the credential, or the route is outside
  what the credential may call;
- a `404` is `request.not_found`: no route matches;
- a `408` and a `429` are `runtime.unavailable`, with the `Retry-After` the answer gives: a proxy timed the
  request out, or the edge throttled it, and a later attempt can pass. The core registry's
  `account.rate_limited` names the limit and its window, which an edge throttle does not say, so a client
  cannot state it;
- a `500` is `runtime.unexpected`;
- a `502`, a `503` and a `504` are `runtime.unavailable`, with the `Retry-After` the answer gives;
- any other status reads as `read_answer` reads it: the one core code raised with that status when a client can
  state it (`request.method_not_allowed` for a `405`), and otherwise `client.response_unreadable` naming the
  status. A `2xx` the SDK could not read is `client.response_unreadable` too.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any, TypeAlias, cast

from mthds.protocol.problem.answers import (
    RETRY_AFTER_HEADER,
    AnswerReading,
    decode_json,
    parse_retry_after,
    read_answer,
    read_problem_document,
    unreadable_answer,
)
from mthds.protocol.problem.client_problems import make_client_problem
from mthds.protocol.problem.models import Problem
from mthds.protocol.problem.registry import CoreCode
from pydantic import WrapValidator

from pipelex_sdk._pydantic_utils import none_when_it_does_not_fit

if TYPE_CHECKING:
    from collections.abc import Mapping


def read_hosted_answer(*, status: int, headers: Mapping[str, str], body: str, creates_run: bool = False) -> AnswerReading:
    """Read an answer that is not the route's result as its problem, by the rules this module's docstring gives.

    Args:
        status: The answer's HTTP status.
        headers: The answer's headers, whatever the case of their names.
        body: The answer's body, as text.
        creates_run: Whether the request creates a run: true for a `start` and an `execute`, and only for them.

    Returns:
        The problem, and whether it is the body's own problem document, as received.
    """
    lower_case = {name.lower(): value for name, value in headers.items()}
    if read_problem_document(body, status=status, headers=lower_case) is not None:
        return read_answer(status=status, body=body, headers=lower_case, creates_run=False)
    return AnswerReading(problem=_bare_answer_problem(status=status, headers=lower_case, body=body, creates_run=creates_run), from_body=False)


def _is_success(status: int) -> bool:
    """Whether `status` is a success."""
    return 200 <= status < 300


def _bare_answer_problem(*, status: int, headers: Mapping[str, str], body: str, creates_run: bool) -> Problem:
    """The problem of an answer whose body is no problem document, by the edge's rules."""
    if creates_run and (_is_success(status) or status == 408 or (500 <= status <= 599 and status != 501)):
        return outcome_unknown_problem(pipeline_run_id=run_id_named_by(body))
    if _is_success(status):
        return unreadable_answer(status)
    match status:
        case 401:
            return make_client_problem(CoreCode.AUTH_MISSING_CREDENTIAL, status=status)
        case 403:
            return make_client_problem(CoreCode.AUTH_INVALID_CREDENTIAL, status=status)
        case 404:
            return make_client_problem(CoreCode.REQUEST_NOT_FOUND, status=status)
        case 500:
            return make_client_problem(CoreCode.RUNTIME_UNEXPECTED, status=status)
        case 408 | 429 | 502 | 503 | 504:
            return make_client_problem(CoreCode.RUNTIME_UNAVAILABLE, status=status, retry_after=parse_retry_after(headers.get(RETRY_AFTER_HEADER)))
        case _:
            return read_answer(status=status, body=body, headers=headers, creates_run=False).problem


def run_id_named_by(body: str) -> str | None:
    """The run a body that is no problem document names as its `pipeline_run_id`, when it names one.

    Args:
        body: The answer's body, as text.

    Returns:
        The run's id, or `None` when the body is no JSON object naming a run by a non-empty string.
    """
    decoded = decode_json(body)
    value: object = decoded.value
    if not decoded.is_json or not isinstance(value, dict):
        return None
    run_id: object = cast("dict[str, Any]", value).get("pipeline_run_id")
    return run_id if isinstance(run_id, str) and run_id else None


def outcome_unknown_problem(*, pipeline_run_id: str | None = None) -> Problem:
    """`client.outcome_unknown`, the problem of a request that may have started a run whose acknowledgement never
    reached the caller, naming the run in its parameters and as its member when its id is known.

    Args:
        pipeline_run_id: The run the request may have started, when its id is known.

    Returns:
        `client.outcome_unknown`.
    """
    if pipeline_run_id is None:
        return make_client_problem(CoreCode.CLIENT_OUTCOME_UNKNOWN)
    return make_client_problem(CoreCode.CLIENT_OUTCOME_UNKNOWN, params={"pipeline_run_id": pipeline_run_id}, pipeline_run_id=pipeline_run_id)


LenientProblem: TypeAlias = Annotated[Problem | None, WrapValidator(none_when_it_does_not_fit)]
"""A problem document a record carries as a member, such as a run's `error`: kept when it is one, and read as `None`
when it is absent or no problem document, so the record that carries it is still read whole, as `@pipelex/sdk` reads
it."""
