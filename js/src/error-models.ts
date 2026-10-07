/**
 * Error-report wire models — a failed run's stored report, and the typed members of a
 * problem document.
 *
 * **The runner owns these shapes; this SDK follows them.** A run that fails reports why as
 * the runner's `ErrorReport` (`pipelex.base_exceptions`), which the hosted platform stores
 * whole on the run row as `error` and serves as it was stored: on the status read
 * (`RunRead.error`), on the run records (`PipelineRun.error`), and inside the problem
 * document of the results read's `409`, where the client lifts it onto the failed arm of
 * `RunResultState` and onto `RunFailedError.error`. The same classification fields
 * (`error_domain`, `user_action`, …) ride a runner-rendered problem document as extension
 * members, which is why `ApiResponseError` types its members with the models declared here.
 *
 * Every field is optional and every interface keeps an index signature, for the reason
 * `TokensUsageRecord` gives: the runner adds fields without asking this SDK, and a field this
 * version does not name still reaches the caller. The enum-ish fields (`error_domain`,
 * `error_category`, `user_action.kind`) are open sets on the wire and stay `string`, never
 * frozen unions, so a value the runner adds is not an SDK break; their known values are listed
 * where they are declared.
 *
 * **A stored report is checked, not cast.** Every read that hands one back runs it through
 * `readRunErrorReport`, which keeps each named field only when it has the type declared here and
 * reads it as absent otherwise, as the Python twin does: a report written by an older runner, or
 * stored by hand, cannot hand a consumer a number where a string is typed.
 *
 * **Nothing else is stripped.** The platform serves the runner's VERBOSE report, so `message` and
 * `provider_metadata` can hold a provider's raw text. Deciding what of it a person should see
 * is each consumer's presentation, not this SDK's; the report arrives here whole, members this
 * SDK does not name included.
 */

import type { ValidationErrorItem } from "./models.js";

/**
 * The next step an error advises — the runner's `UserAction`, carried as `user_action` on a
 * stored report and on a runner's problem document. `kind` names the category of advice, so a
 * consumer can render consistent guidance; `detail` is the advice itself, in words (a billing
 * URL, a retry hint, the model to change).
 *
 * Known `kind` values: `wait_and_retry`, `check_billing`, `check_credentials`, `change_input`,
 * `change_model`, `contact_support`, `unknown`. The set is the runner's, so it is typed open.
 * The shape is the one `mthds`'s `UserAction` declares, so a value moves between the two
 * clients' errors unchanged.
 */
export interface UserAction {
  kind: string;
  detail: string;
}

/**
 * What the inference provider's SDK said about a failed call — the runner's
 * `ProviderErrorMetadata`. Present on a report whose failure came back from a model provider.
 * `message` is the provider SDK's own text, relayed raw; the provider's response body never
 * crosses the wire, because the runner excludes it from every serialization.
 *
 * **The hosted store turns its numbers into strings.** A report read back from the platform's
 * run store carries `status_code` and `retry_after_seconds` as JSON strings (`"404"`,
 * `"1.5"`), because the store hands its numbers back as decimals that the platform serializes
 * as strings. A problem document rendered by a runner carries them as numbers. Both are typed,
 * so read them with `Number(...)` when you need the value.
 */
export interface ProviderErrorMetadata {
  provider?: string | null;
  sdk_exception_type?: string | null;
  message?: string | null;
  /** The provider's HTTP status, when it answered one. */
  status_code?: number | string | null;
  /** The provider's own request id — what its support desk asks for. */
  request_id?: string | null;
  retry_after_seconds?: number | string | null;
  provider_error_code?: string | null;
  [extension: string]: unknown;
}

/**
 * A pending configuration migration that explains the failure — the runner's
 * `MigrationErrorBlock`. Present only on a configuration failure whose raiser scanned the
 * host's configuration directories; a consumer branches on its presence. `plans` is carried
 * opaquely: it is the shape `pipelex-agent migrate --dry-run --format json` emits, which no
 * published package declares.
 */
export interface MigrationErrorBlock {
  /** The command that applies whatever can be applied without a decision. */
  remedy?: string | null;
  /** Whether running `remedy` would rewrite any file. */
  would_write?: boolean | null;
  /** Whether something here is a person's to resolve rather than the tool's. */
  needs_attention?: boolean | null;
  plans?: Record<string, unknown>[] | null;
  [extension: string]: unknown;
}

/**
 * Why a run failed — the runner's `ErrorReport`, typed with every field it carries.
 *
 * The one type for a failed run's report wherever the SDK hands it back: `RunPublic.error`
 * (and so `RunRead.error` on the status read), `PipelineRun.error` on the run records, `error`
 * on the failed arm of `RunResultState` (the results read's `409`), and `RunFailedError.error`
 * when `waitForResult`, `startAndWaitForResult` or an artifact download throws for a run that
 * ended without a result.
 *
 * **Branch on `error_domain`, `type_uri` and `retryable`**, never on the wording of `message`.
 * `error_type` is the runner's open-ended exception class name: finer than `error_domain`,
 * useful in a support line, but not a closed set to match against. Which fault's identity a run
 * failure's report carries, and how its `message` names the failing pipe, is the runner's to
 * decide; read them as given.
 *
 * A report is `null` where the run has none — a cancelled, terminated or timed-out run, or one
 * the platform finalized itself — so the absence of a report says nothing about why.
 */
export interface RunErrorReport {
  /**
   * The runner's exception class name (`LLMCompletionError`, `PipeRunError`, …) — an open
   * set, for display and support, not for branching.
   */
  error_type?: string | null;
  /**
   * What went wrong, as the runner wrote it. On the VERBOSE report the platform serves, it can
   * carry a provider's raw text.
   */
  message?: string | null;
  /** A stable human label for the error class (`LLM completion`). */
  title?: string | null;
  /** The stable URI naming the error class — a branch field, and where its documentation lives. */
  type_uri?: string | null;
  /**
   * Who can fix it, the coarse branch field. Known values: `input` (the caller — a malformed
   * bundle, a bad input), `config` (a configuration change — a model not served, a missing
   * secret), `runtime` (nobody beforehand — a provider outage during execution).
   */
  error_domain?: string | null;
  /**
   * A finer classification of an inference failure, when the runner has one. Known values:
   * `transient`, `configuration`, `content`, `capacity`, `ambiguous`, `unknown`.
   */
  error_category?: string | null;
  /** Whether retrying the same run can succeed. Absent or `null` means unknown, never "no". */
  retryable?: boolean | null;
  /** The next step the runner advises. */
  user_action?: UserAction | null;
  /** The model the failing call used, when the failure is an inference failure. */
  model?: string | null;
  /** The provider the failing call reached, when the failure is an inference failure. */
  provider?: string | null;
  /** What the provider's SDK said, when the failure came back from a provider. */
  provider_metadata?: ProviderErrorMetadata | null;
  /** True when `message` was written as caller-facing copy. The runner emits it only when true. */
  caller_facing_message?: boolean | null;
  /**
   * The structured diagnostics of a bundle that failed validation — the same items the
   * validate report and a `422`'s `ApiResponseError.validationErrors` carry.
   */
  validation_errors?: ValidationErrorItem[] | null;
  /** A pending configuration migration that explains the failure. */
  migration?: MigrationErrorBlock | null;
  /** Fields a newer runner adds, reachable before this SDK names them. */
  [extension: string]: unknown;
}

/**
 * One field-level failure of a request — an item of the platform problem document's
 * `errors[]`. `field` is the dotted path to the offending attribute, `code` a stable sub-code
 * (`invalid_format`, `out_of_range`, …), `detail` optional human text.
 */
export interface FieldError {
  field?: string | null;
  code?: string | null;
  detail?: string | null;
  [extension: string]: unknown;
}

/**
 * The members of an RFC 9457 problem document that `ApiResponseError` exposes beyond its
 * message, as the client parsed them: the standard's own `type`, `title` and `instance`, the
 * request id, and the extension members the runner and the platform add to classify the
 * failure. Every member is optional — a server sends what it knows, and a body that is not a
 * problem document carries none of them.
 *
 * It is a superset of `mthds`'s `ProblemDetails`, member for member under the same names, so a
 * consumer reads one vocabulary whichever client raised the error; the members past that set
 * (`errorCategory`, `model`, `provider`, `providerMetadata`, `migration`, `errors`) are the ones
 * the standard's client leaves to this SDK.
 */
export interface ProblemDetails {
  /** RFC 9457 `type` — the stable URI of the error class. */
  type?: string;
  /** RFC 9457 `title` — the short human label of the error class. */
  title?: string;
  /** RFC 9457 `instance` — the occurrence (a request path or a request URN). */
  instance?: string;
  /** The request's correlation id: the body's `request_id`, else the `X-Request-ID` response header. */
  requestId?: string;
  /** The body's `error_domain` — `input`, `config` or `runtime`. */
  errorDomain?: string;
  /** The body's `error_category` — the finer classification of an inference failure. */
  errorCategory?: string;
  /** The body's `retryable` — whether retrying the same request can plausibly succeed. */
  retryable?: boolean;
  /** The body's `user_action` — what the caller should do next. */
  userAction?: UserAction;
  /** The body's `model` — the model an inference failure used. */
  model?: string;
  /** The body's `provider` — the provider an inference failure reached. */
  provider?: string;
  /** The body's `provider_metadata` — what the provider's SDK said. */
  providerMetadata?: ProviderErrorMetadata;
  /** The body's `migration` — a pending configuration migration that explains the failure. */
  migration?: MigrationErrorBlock;
  /** The platform's field-level `errors[]`. */
  errors?: FieldError[];
}

// ── Checking a stored report ─────────────────────────────────────────

/** The string fields of a report, kept when they are a string (empty included) or `null`. */
const REPORT_STRING_FIELDS = [
  "error_type",
  "message",
  "title",
  "type_uri",
  "error_domain",
  "error_category",
  "model",
  "provider",
] as const;

/** The boolean fields of a report, kept when they are a boolean or `null`. */
const REPORT_BOOLEAN_FIELDS = ["retryable", "caller_facing_message"] as const;

/** The string fields of `provider_metadata`. */
const PROVIDER_STRING_FIELDS = [
  "provider",
  "sdk_exception_type",
  "message",
  "request_id",
  "provider_error_code",
] as const;

/** The fields of `provider_metadata` the hosted store may serve as strings: a number or a string. */
const PROVIDER_NUMERIC_FIELDS = ["status_code", "retry_after_seconds"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop each of `fields` from `record` when it is present and fails `fits`. `null` always fits,
 * since every field of these shapes allows it.
 */
function dropUnfit(
  record: Record<string, unknown>,
  fields: readonly string[],
  fits: (value: unknown) => boolean,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) continue;
    const value = record[field];
    if (value !== null && !fits(value)) delete record[field];
  }
}

const isString = (value: unknown): boolean => typeof value === "string";
const isBoolean = (value: unknown): boolean => typeof value === "boolean";
const isNumberOrString = (value: unknown): boolean =>
  typeof value === "number" || typeof value === "string";

/** `user_action` is kept whole or not at all: an object whose `kind` and `detail` are strings. */
function readUserAction(value: Record<string, unknown>): UserAction | undefined {
  return typeof value.kind === "string" && typeof value.detail === "string"
    ? ({ ...value } as unknown as UserAction)
    : undefined;
}

function readProviderMetadata(value: Record<string, unknown>): ProviderErrorMetadata {
  const metadata: Record<string, unknown> = { ...value };
  dropUnfit(metadata, PROVIDER_STRING_FIELDS, isString);
  dropUnfit(metadata, PROVIDER_NUMERIC_FIELDS, isNumberOrString);
  return metadata as ProviderErrorMetadata;
}

function readMigration(value: Record<string, unknown>): MigrationErrorBlock {
  const migration: Record<string, unknown> = { ...value };
  dropUnfit(migration, ["remedy"], isString);
  dropUnfit(migration, ["would_write", "needs_attention"], isBoolean);
  if (Object.hasOwn(migration, "plans") && migration.plans !== null) {
    if (Array.isArray(migration.plans)) migration.plans = migration.plans.filter(isPlainObject);
    else delete migration.plans;
  }
  return migration as MigrationErrorBlock;
}

/** A validation item is kept when it is an object with a string `category` and `message`. */
function isValidationItem(value: unknown): boolean {
  return isPlainObject(value) && isString(value.category) && isString(value.message);
}

/**
 * A failed run's stored report, checked field by field — the one way every read in this SDK
 * hands a report back.
 *
 * - A value that is not a plain object reads as `null`, no report.
 * - Each string field (`error_type`, `message`, `title`, `type_uri`, `error_domain`,
 *   `error_category`, `model`, `provider`) is kept when it is a string, an empty one included, and
 *   is absent otherwise. Deciding that a blank field says nothing is presentation, left to each
 *   consumer.
 * - `retryable` and `caller_facing_message` are kept when they are booleans.
 * - `user_action` is kept whole or not at all: an object whose `kind` and `detail` are both
 *   strings, which is what `UserAction` promises. (The Python twin keeps a partial action, its
 *   stored-report action being a lenient type of its own; this is the one place the two differ.)
 * - `provider_metadata` is kept when it is an object, with each named field checked: the strings
 *   as strings, `status_code` and `retry_after_seconds` as a number or a string, since the hosted
 *   store serves its numbers as strings.
 * - `migration` is kept when it is an object: `remedy` as a string, `would_write` and
 *   `needs_attention` as booleans, and `plans` as an array keeping only its objects.
 * - `validation_errors` is kept when it is an array, keeping each item that is an object with a
 *   string `category` and a string `message`.
 * - `null` is kept wherever the type allows it, which is every named field; and members this SDK
 *   does not name, in the report and in each nested object, are relayed as sent.
 *
 * Internal: every report a consumer meets comes through one of the reads that apply it.
 */
export function readRunErrorReport(value: unknown): RunErrorReport | null {
  if (!isPlainObject(value)) return null;
  const report: Record<string, unknown> = { ...value };
  dropUnfit(report, REPORT_STRING_FIELDS, isString);
  dropUnfit(report, REPORT_BOOLEAN_FIELDS, isBoolean);
  readNested(report, "user_action", readUserAction);
  readNested(report, "provider_metadata", readProviderMetadata);
  readNested(report, "migration", readMigration);
  if (Object.hasOwn(report, "validation_errors") && report.validation_errors !== null) {
    if (Array.isArray(report.validation_errors)) {
      report.validation_errors = report.validation_errors.filter(isValidationItem);
    } else {
      delete report.validation_errors;
    }
  }
  return report as RunErrorReport;
}

/**
 * Replace the object at `field` with what `read` keeps of it, or drop the field when it is not an
 * object or `read` keeps nothing. `null` is kept.
 */
function readNested(
  record: Record<string, unknown>,
  field: string,
  read: (value: Record<string, unknown>) => unknown,
): void {
  if (!Object.hasOwn(record, field)) return;
  const value = record[field];
  if (value === null) return;
  const kept = isPlainObject(value) ? read(value) : undefined;
  if (kept === undefined) delete record[field];
  else record[field] = kept;
}
