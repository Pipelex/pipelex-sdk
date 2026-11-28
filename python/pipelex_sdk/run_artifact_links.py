"""Result artifacts handed back by reference — `RunResults.artifact_links`.

The platform measures a completed run's results before answering, and when inline they would take the body past the
API Gateway's limit it hands its largest artifacts back as links: each such artifact's fields read `None` and
`artifact_links` maps its name to `{url, expires_at}`, a GET of its stored file signed for about fifteen minutes. This
module reads those files:

- `parse_run_artifact` — pure: the content of one such file as the result fields it fills, the usage envelope
  unpacked. No network, no key.
- `fetch_run_artifact` — one link fetched under `fetch_artifact`'s bounds, then parsed.
- `follow_artifact_links` — a result with every link (or the named ones) followed into its fields, the followed
  entries dropped from `artifact_links`. The result readers call it by default.

The file is the one the runner wrote, so the links inside it are as stored, never re-signed: a produced file's
`public_url` inside a followed artifact may have expired, and its `pipelex-storage://` reference is what to resolve
(`docs/run-results.md`).
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, cast

from mthds.protocol.problem.client_problems import make_client_problem
from mthds.protocol.problem.registry import CoreCode
from pydantic import ValidationError

from pipelex_sdk._answer_json import decode_json_as_written
from pipelex_sdk.artifacts import ArtifactFetchClient, read_signed_url
from pipelex_sdk.errors import ArtifactFetchError, RequestArgumentError, response_unreadable_problem
from pipelex_sdk.runs import RunArtifact, RunArtifactLink, RunResults

if TYPE_CHECKING:
    from collections.abc import Sequence

    from pipelex_sdk.artifact_models import FetchArtifactOptions

#: The reason an `ArtifactFetchError` gives for a referenced file that is not the artifact's JSON.
RUN_ARTIFACT_UNREADABLE = "unreadable"


def _known_artifact(artifact: RunArtifact | str) -> RunArtifact:
    """`artifact` as a `RunArtifact`, or the `RequestArgumentError` a name the platform does not know is refused with."""
    try:
        return RunArtifact(artifact)
    except ValueError as exc:
        msg = f"Unknown result artifact {artifact!r}; valid artifacts are: {', '.join(RunArtifact)}."
        problem = make_client_problem(CoreCode.CLIENT_ARGUMENT_INVALID, params={"argument": "artifact", "reason": "unknown_value"})
        raise RequestArgumentError(msg, problem=problem) from exc


def _link_label(artifact: RunArtifact) -> str:
    """The label that stands for an artifact's link in an error: the signed link itself is never written there."""
    return f"artifact_links.{artifact}"


def _unreadable(artifact: RunArtifact, detail: str, status: int) -> ArtifactFetchError:
    msg = f"The {artifact} artifact handed back by reference could not be read: {detail}."
    return ArtifactFetchError(
        msg, uri=_link_label(artifact), reason=RUN_ARTIFACT_UNREADABLE, status=status, problem=response_unreadable_problem(status=status)
    )


def parse_run_artifact(artifact: RunArtifact, content: bytes | str) -> dict[str, Any]:
    """The result fields one artifact's stored file fills, read from the file's content.

    `{"graph_spec": ...}`, `{"main_stuff": ...}` and so on, and `{"tokens_usages": ..., "usage_assembly_error": ...}`
    for `RunArtifact.TOKENS_USAGES`, whose file is the envelope holding both. The values are the JSON as written,
    read by the rules an inline answer is read by, its numbers kept as written; `follow_artifact_links` validates
    them as `RunResults` fields. Pure — no network, no key.

    Raises:
        RequestArgumentError: `artifact` is no `RunArtifact`.
        ArtifactFetchError: The content is not UTF-8 JSON, or a usage file is not the envelope object; its reason is
            `unreadable` (`RUN_ARTIFACT_UNREADABLE`).
    """
    return _parse(_known_artifact(artifact), content, status=200)


def _parse(artifact: RunArtifact, content: bytes | str, *, status: int) -> dict[str, Any]:
    if isinstance(content, bytes):
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise _unreadable(artifact, "it is not UTF-8 text", status) from exc
    else:
        text = content
    decoded = decode_json_as_written(text)
    if not decoded.is_json:
        raise _unreadable(artifact, "it is not JSON", status)
    value: Any = decoded.value
    match artifact:
        case RunArtifact.TOKENS_USAGES:
            if not isinstance(value, dict):
                raise _unreadable(artifact, "it is not the usage envelope object", status)
            envelope = cast("dict[str, Any]", value)
            return {"tokens_usages": envelope.get("tokens_usages"), "usage_assembly_error": envelope.get("usage_assembly_error")}
        case (
            RunArtifact.GRAPH_SPEC
            | RunArtifact.PIPE_IO_CONTRACTS
            | RunArtifact.INPUT_FORM
            | RunArtifact.OUTPUT_FORM
            | RunArtifact.MAIN_STUFF
            | RunArtifact.WORKING_MEMORY
        ):
            return {str(artifact): value}


async def fetch_run_artifact(
    client: ArtifactFetchClient,
    artifact: RunArtifact,
    link: RunArtifactLink,
    options: FetchArtifactOptions | None = None,
) -> dict[str, Any]:
    """Fetch one artifact the platform handed back by reference and read it as the result fields it fills.

    The link is fetched under `fetch_artifact`'s bounds — redirects refused, no credential of ours sent, `max_bytes`
    (1 GiB by default) enforced before and while the body arrives, `timeout_seconds` (120 s by default) over the
    whole exchange, a plain `http:` link refused unless it is on the client's own origin or `allow_http` is set — then
    read as `parse_run_artifact` reads it.

    A link lasts about fifteen minutes from the read that handed it back; past that the store refuses it, an
    `ArtifactFetchError`, and reading the results again hands back a fresh one. Every failure is an
    `ArtifactFetchError` naming the link as `artifact_links.<name>`, never the signed link itself.
    """
    known = _known_artifact(artifact)
    body, status = await read_signed_url(client, _link_label(known), link.url, options)
    return _parse(known, body, status=status)


async def follow_artifact_links(
    client: ArtifactFetchClient,
    results: RunResults,
    *,
    artifacts: Sequence[RunArtifact] | None = None,
    options: FetchArtifactOptions | None = None,
) -> RunResults:
    """`results` with the artifacts it handed back by reference fetched into their fields.

    Every link is followed, or only those `artifacts` names; each followed entry is dropped from `artifact_links`,
    which reads `None` once none is left, so a followed result reads as one answered inline. A link under a name this
    version does not know is left in place. The links are fetched at once, and the first that fails cancels the others
    and is raised (`fetch_run_artifact`); the fetched fields are validated as `RunResults` fields, a file that does not
    validate raising `ArtifactFetchError` (`unreadable`). The result passed in is never changed: a new one is returned,
    or the same one when it holds no link to follow.

    The result readers (`get_run_result`, `wait_for_result`, `start_and_wait`) call it by default; a caller that read
    with `follow_artifact_links=False`, to pass the links on rather than pull the files through itself, calls it where
    the content is wanted after all.
    """
    only = None if artifacts is None else {_known_artifact(artifact) for artifact in artifacts}
    links = results.artifact_links or {}
    followed: list[RunArtifact] = []
    for name in links:
        known = _maybe_artifact(name)
        if known is not None and (only is None or known in only):
            followed.append(known)
    if not followed:
        return results
    # `gather`, not a `TaskGroup`: the first failure is raised as itself, never wrapped in an exception group, and the
    # `finally` cancels the fetches still in flight.
    tasks = [asyncio.ensure_future(fetch_run_artifact(client, artifact, links[str(artifact)], options)) for artifact in followed]
    try:
        fetched = await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    fields: dict[str, Any] = {}
    for one_artifact in fetched:
        fields.update(one_artifact)
    try:
        validated = RunResults.model_validate({"pipeline_run_id": results.pipeline_run_id, **fields})
    except ValidationError as exc:
        names = ", ".join(str(artifact) for artifact in followed)
        msg = f"The artifacts handed back by reference ({names}) could not be read as the run's results: {exc}."
        raise ArtifactFetchError(
            msg,
            uri=_link_label(followed[0]),
            reason=RUN_ARTIFACT_UNREADABLE,
            problem=response_unreadable_problem(status=200, pipeline_run_id=results.pipeline_run_id),
        ) from exc
    remaining = {name: link for name, link in links.items() if _maybe_artifact(name) not in followed}
    update: dict[str, Any] = {field_name: getattr(validated, field_name) for field_name in fields}
    update["artifact_links"] = remaining or None
    return results.model_copy(update=update)


def _maybe_artifact(name: str) -> RunArtifact | None:
    """The `RunArtifact` a link's key names, or `None` for a name this version does not know."""
    try:
        return RunArtifact(name)
    except ValueError:
        return None


def holds_artifact_links(results: RunResults, artifacts: Sequence[RunArtifact]) -> bool:
    """Whether `results` holds a link for any of `artifacts`."""
    return any(results.artifact_link(artifact) is not None for artifact in artifacts)
