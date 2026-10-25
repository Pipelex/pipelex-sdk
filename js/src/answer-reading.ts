/**
 * How the SDK reads an answer that is not the route's result as a problem: a refusal, a failure, or
 * a `2xx` it cannot read. The Python twin, `pipelex-sdk`, reads every answer the same way in
 * `pipelex_sdk.answer_reading`, and the shared case file `tests/fixtures/sdk-problems.json` pins the
 * readings both apply.
 *
 * - A body that is a problem document reads as received, every member it carries kept, a
 *   `pipelex.*` code and the members the standard does not name included, its `status` taken from
 *   the answer when it leaves it out and its `retry_after` from the `Retry-After` header when it
 *   gives none and its `retry` is `yes` (`readAnswer` in `mthds/protocol`). On a start or an
 *   execute too: the problem's own `retry` says whether a run may exist.
 * - A body that is no problem document is the hosted edge's, a gateway's or a proxy's, which
 *   nobody configures, and reads by the rules below. They stay written here until the registry
 *   records them and every client generates them.
 *
 * On a request that creates a run, a `start` or an `execute`:
 *
 * - a `2xx` the SDK could not read is `client.outcome_unknown`, since the server accepted the
 *   request and only its acknowledgement was lost, naming the run when the body names one;
 * - a `408`, which a proxy may answer for a request it forwarded, and a `5xx` but a `501`, which a
 *   gateway answers when the platform was slow or unreachable behind it, are
 *   `client.outcome_unknown` too, whatever the time it took: the run may have started behind it.
 *
 * On any route, and on a start for every other status:
 *
 * - a `401` is `auth.missing_credential`: the edge answers it before the platform when the request
 *   carries no credential;
 * - a `403` is `auth.invalid_credential`: the edge's authorizer refused the credential, or the
 *   route is outside what the credential may call;
 * - a `404` is `request.not_found`: no route matches;
 * - a `408` and a `429` are `runtime.unavailable`, with the `Retry-After` the answer gives: a
 *   proxy timed the request out, or the edge throttled it, and a later attempt can pass. The core
 *   registry's `account.rate_limited` names the limit and its window, which an edge throttle does
 *   not say, so a client cannot state it;
 * - a `500` is `runtime.unexpected`;
 * - a `502`, a `503` and a `504` are `runtime.unavailable`, with the `Retry-After` the answer
 *   gives;
 * - any other status reads as `readAnswer` reads it: the one core code raised with that status
 *   when a client can state it (`request.method_not_allowed` for a `405`), and otherwise
 *   `client.response_unreadable` naming the status. A `2xx` the SDK could not read is
 *   `client.response_unreadable` too.
 */

import {
  buildProblem,
  parseJsonBody,
  readAnswer,
  readProblemBody,
  retryAfterSeconds,
  unreadableAnswer,
} from "mthds/protocol";
import type { AnswerHeaders, Problem } from "mthds/protocol";

/** An answer the hosted API, its edge or a proxy in front of it gave. */
export interface HostedAnswer {
  status: number;
  headers: AnswerHeaders;
  body: string;
}

/** An answer read as its problem, and whether that problem is the answer's own body. */
export interface HostedAnswerReading {
  problem: Problem;
  /** Whether the body is the problem document `problem` was read from, as received. */
  fromBody: boolean;
}

/**
 * Read an answer that is not the route's result as its problem, by the rules this module's header
 * gives. `createsRun` is true for a `start` and an `execute`, and only for them.
 */
export function readHostedAnswer(
  answer: HostedAnswer,
  options: { createsRun?: boolean } = {},
): HostedAnswerReading {
  if (readProblemBody(answer.body) !== undefined) {
    return readAnswer(answer, { createsRun: false });
  }
  return { problem: bareAnswerProblem(answer, options.createsRun === true), fromBody: false };
}

/** Whether `status` is a success. */
function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** The problem of an answer whose body is no problem document, by the edge's rules. */
function bareAnswerProblem(answer: HostedAnswer, createsRun: boolean): Problem {
  const { status } = answer;
  if (createsRun && (isSuccess(status) || status === 408 || (status >= 500 && status !== 501))) {
    return outcomeUnknownProblem(runIdNamedBy(answer.body));
  }
  if (isSuccess(status)) return unreadableAnswer(status);
  switch (status) {
    case 401:
      return buildProblem("auth.missing_credential", {}, { status });
    case 403:
      return buildProblem("auth.invalid_credential", {}, { status });
    case 404:
      return buildProblem("request.not_found", {}, { status });
    case 500:
      return buildProblem("runtime.unexpected", {}, { status });
    case 408:
    case 429:
    case 502:
    case 503:
    case 504:
      return buildProblem(
        "runtime.unavailable",
        {},
        { status, retryAfter: retryAfterSeconds(answer.headers) },
      );
    default:
      return readAnswer(answer, { createsRun: false }).problem;
  }
}

/** The run a body that is no problem document names as its `pipeline_run_id`, when it names one. */
export function runIdNamedBy(body: string): string | undefined {
  const reading = parseJsonBody(body);
  if (!reading.ok) return undefined;
  const { value } = reading;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const runId = (value as { pipeline_run_id?: unknown }).pipeline_run_id;
  return typeof runId === "string" && runId !== "" ? runId : undefined;
}

/**
 * `client.outcome_unknown`, the problem of a request that may have started a run whose
 * acknowledgement never reached the caller, naming the run in its parameters and as its member
 * when its id is known.
 */
export function outcomeUnknownProblem(runId?: string): Problem {
  if (runId === undefined) return buildProblem("client.outcome_unknown", {});
  return buildProblem(
    "client.outcome_unknown",
    { pipeline_run_id: runId },
    { pipeline_run_id: runId },
  );
}
