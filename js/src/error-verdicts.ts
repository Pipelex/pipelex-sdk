/**
 * The verdict an `ApiResponseError` falls back to when the server sent no usable member.
 *
 * A problem document may carry `retryable` and `error_domain`, and the error reads the members
 * the server sent first (see `ApiResponseError`): the runner sends them on the problems it renders,
 * and the platform on those it renders itself once its deployment classifies them. Where one is
 * missing — a platform route that does not classify its refusals, as its Lambda-backed routes do
 * not yet, a gateway's HTML page, a bare runner's Starlette `{"detail": "Not Found"}` — that member
 * is read off this table instead, so a consumer never has to choose its own default. The one
 * exception is a `retryable` missing beside a sent `input` or `config` domain, which is not
 * retryable whatever the status. The table reads only the HTTP status, the platform's native
 * `code`, and whether the body names what it refused.
 *
 * It is also the platform's reference: the verdicts the platform sends on its own refusals are
 * decided against this table, so a refusal keeps its verdict whether the platform sent it or the
 * table supplied it. The Python twin, `pipelex-sdk`, applies the same table as its `fallback_verdict`.
 * The case file `tests/fixtures/error-verdicts.json` holds every row, and this package's suite
 * drives the table through it; the Python suite drives its own code through the copy that
 * `make shared-files` writes at the repository's root, byte for byte identical.
 */

import { problemDomain, problemRetry } from "mthds/protocol";
import type { Problem, ProblemDomain, RetryVerdict } from "mthds/protocol";

import type { ErrorDomain, ErrorVerdict } from "./errors.js";

const INPUT: ErrorVerdict = Object.freeze({ errorDomain: "input", retryable: false });
const CONFIG: ErrorVerdict = Object.freeze({ errorDomain: "config", retryable: false });
const TRANSIENT: ErrorVerdict = Object.freeze({ errorDomain: "runtime", retryable: true });
const FAULT: ErrorVerdict = Object.freeze({ errorDomain: "runtime", retryable: false });

/** The platform code a `409` carries when the organization holds as many API keys as it may. */
const API_KEY_LIMIT_CODE = "pipelex_api_key_limit_reached";

/**
 * The platform code a `409` carries when an earlier request under the same `Idempotency-Key` is
 * still being handled: nothing ran for this one, and the same request under the same key is
 * answered with the earlier one's outcome once it is stored.
 */
const IDEMPOTENCY_KEY_IN_USE_CODE = "idempotency_key_in_use";

/**
 * The verdict of a refused request whose problem document carried no usable member.
 *
 * - `status` is the HTTP status of the answer.
 * - `code` is the platform's native code, when the body carried one.
 * - `named` says whether the body names what it refused: a platform `code` or a runner
 *   `error_type`. It decides a `404`: a named one is a resource the caller asked for that does not
 *   exist (`input`), a bare one is a route the deployment does not serve (`config`).
 *
 * Every `4xx` the table does not list is the caller's request refused (`input`, not retryable),
 * every `5xx` it does not list is a fault in the service that may pass (`runtime`, retryable),
 * and any other status is one no refusal carries, such as the `2xx` of an answer the client could
 * not read, so nothing says a retry helps (`runtime`, not retryable).
 */
export function fallbackVerdict(
  status: number,
  code: string | undefined,
  named: boolean,
): ErrorVerdict {
  switch (status) {
    case 401:
    case 402:
    case 403:
      // The credential, the plan or the access must change.
      return CONFIG;
    case 404:
      return named ? INPUT : CONFIG;
    case 405:
      // The deployment does not serve this method on the route.
      return CONFIG;
    case 408:
    case 429:
      // Refused for its timing, not its content.
      return TRANSIENT;
    case 409:
      // The organization holds as many API keys as it may: someone lifts it by removing a key.
      if (code === API_KEY_LIMIT_CODE) return CONFIG;
      // An earlier request still holds the idempotency key, and releases it by finishing.
      if (code === IDEMPOTENCY_KEY_IN_USE_CODE) return TRANSIENT;
      // Any other conflict with the stored state is the caller's.
      return INPUT;
    case 501:
      // The deployment does not implement it, and asking again will not change that.
      return CONFIG;
  }
  if (status >= 400 && status < 500) return INPUT;
  if (status >= 500 && status < 600) return TRANSIENT;
  return FAULT;
}

/**
 * Who can fix a failure the MTHDS standard's problem says must be acted on by its `domain`, in
 * this SDK's vocabulary: the caller changes the request or the method it names (`input`, `method`),
 * someone changes the environment, the credential, the plan or the deployment (`account`,
 * `operator`), or nobody beforehand (`runtime`).
 */
const ERROR_DOMAIN_OF: Readonly<Record<ProblemDomain, ErrorDomain>> = Object.freeze({
  input: "input",
  method: "input",
  account: "config",
  operator: "config",
  runtime: "runtime",
});

/**
 * Whether asking again can succeed, by the standard's `retry`: only `yes` is retryable, since an
 * operation whose outcome is unknown may already have taken effect, and a run that may have
 * started is never retryable.
 */
const RETRYABLE_OF: Readonly<Record<RetryVerdict, boolean>> = Object.freeze({
  yes: true,
  no: false,
  outcome_unknown: false,
});

/**
 * The verdict of a problem of the MTHDS standard, in this SDK's vocabulary, so that an error of
 * the standard's own client (`mthds`) reads with `errorVerdictOf` as this SDK's errors do. The
 * standard's domain and retry verdict are read by its own fallbacks (`problemDomain`,
 * `problemRetry`): a domain it does not know reads by the code's family, else as `runtime`, and
 * a retry verdict it does not know as `no`. The Python twin, `pipelex-sdk`, applies the same
 * mapping.
 */
export function problemVerdict(problem: Pick<Problem, "code" | "domain" | "retry">): ErrorVerdict {
  return {
    errorDomain: ERROR_DOMAIN_OF[problemDomain(problem)],
    retryable: RETRYABLE_OF[problemRetry(problem)],
  };
}
