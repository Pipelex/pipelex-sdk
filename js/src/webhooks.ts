/**
 * Caller webhooks: the `run.finished` event a Pipelex runtime sends each URL a run registered in
 * `callback_urls` once the run has ended, the receiver's verification of a call, and the shapes of
 * the hosted delivery log and of an organization's signing secret.
 *
 * The contract is the spec `conformance/specs/pipelex-caller-webhooks.md`, in the `conformance`
 * repository: a call is a Standard Webhooks v1 `POST`, its `webhook-id`, `webhook-timestamp` and
 * `webhook-signature` headers signing `{webhook-id}.{webhook-timestamp}.{body}` with HMAC-SHA256
 * under a `whsec_` secret, and its body a `run.finished` event. `verifyWebhook` follows the spec's
 * verification procedure step by step and is held to its known-answer vectors, a byte-identical copy
 * of which this package's tests run (`tests/fixtures/caller-webhooks/`).
 *
 * Browser-safe, as the whole barrel is: the signature is computed with Web Crypto
 * (`globalThis.crypto.subtle`), which Node, Deno, Bun, edge runtimes and browsers carry, never with
 * `node:crypto`. See `docs/webhooks.md`.
 */

import { ProblemError, buildProblem, isProblem } from "mthds/protocol";
import type { Problem } from "mthds/protocol";

import { RequestArgumentError, argumentInvalidProblem } from "./errors.js";
import { isPlainObject } from "./records.js";
import type { RunStatus } from "./runs.js";

// ── The event ─────────────────────────────────────────────────────────

/** The `type` of the event a run's end sends: one type for every ending, the outcome in `data.status`. */
export const RUN_FINISHED_EVENT_TYPE = "run.finished";

/**
 * How far a call's `webhook-timestamp` may be from the receiver's clock, either way, in seconds:
 * five minutes, as the contract sets it. A call further away is refused, which bounds how long a
 * captured call can be replayed.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

/**
 * The status a `run.finished` event's `data` reports. A self-hosted runner sends the MTHDS
 * protocol's status read, `completed` or `failed`, a cancelled or timed-out run reading `failed`
 * with a code that says why. The hosted plane sends its own status read until it moves onto the
 * protocol's, so its event reads an ended `RunStatus` in uppercase, `COMPLETED`, `FAILED`,
 * `CANCELLED`, `TERMINATED` or `TIMED_OUT`, and its spelling turns lowercase when it does. Read
 * open: a status this SDK does not name arrives as its raw string. To tell a success from a
 * failure under both spellings, compare `status.toLowerCase()` with `"completed"`.
 */
export type RunFinishedStatus =
  | "completed"
  | "failed"
  | Extract<RunStatus, "COMPLETED" | "FAILED" | "CANCELLED" | "TERMINATED" | "TIMED_OUT">
  | (string & {});

/**
 * A `run.finished` event's `data`: the run as its caller's status read served it when the delivery
 * was created, the same on every attempt and replay of the delivery.
 *
 * Two shapes reach a receiver today, and this type accepts both. A self-hosted runner sends the
 * MTHDS protocol's status read (`pipeline_run_id`, a lowercase `status`, and for a failed run its
 * problem as `error`, a member with no value left out). The hosted plane sends the body of its own
 * `GET /v1/runs/{id}/status` (this SDK's `RunRead`) without `callback_urls`: an uppercase `status`,
 * a member with no value written as `null`, and the platform's own members, such as `finished_at`,
 * `method_id` and `request_id`. That shape does not validate against the contract's JSON Schema,
 * which describes the protocol's read; the hosted event follows its status read onto the
 * protocol's shape when that read moves, with no change of its own.
 */
export interface RunFinishedEventData {
  /** The run that ended. */
  pipeline_run_id: string;
  /** How it ended; see `RunFinishedStatus` for the two spellings. */
  status: RunFinishedStatus;
  /**
   * A failed run's problem, in its caller's view: never its `diagnostics`. Kept when it is a
   * problem document (`isProblem`), and read as `null` otherwise; absent on a completed run of a
   * self-hosted runner, `null` on one of the hosted plane.
   */
  error?: Problem | null;
  /** Every other member the status read served, as it served it. */
  [member: string]: unknown;
}

/**
 * The body of the call a run's end makes to each URL it registered: a `run.finished` event. The
 * event never carries the run's results; fetch them with `getRunResult` and the `pipeline_run_id`
 * of `data`. A receiver deduplicates on the `webhook-id` header, never on the body or `attempt`.
 */
export interface RunFinishedEvent {
  type: typeof RUN_FINISHED_EVENT_TYPE;
  /** When the run ended, its `finished_at`, as an RFC 3339 date-time in UTC. Not the call's send time. */
  timestamp: string;
  /**
   * Which attempt of the delivery this call is, from 1. Informational: it increases with each retry
   * and a replay continues it, but a runtime that runs its delivery step again may skip numbers or
   * start again at 1 under the same `webhook-id`, so never rely on it being unique or gapless.
   */
  attempt: number;
  /** The run as its caller's status read served it; see `RunFinishedEventData`. */
  data: RunFinishedEventData;
  /** A member a later contract adds, which a receiver ignores. */
  [member: string]: unknown;
}

/**
 * An event whose `type` this SDK does not read. A receiver acknowledges it with a `2xx` rather
 * than failing it, so the sender does not retry an event the receiver has no use for.
 */
export interface UnknownWebhookEvent {
  type: string;
  [member: string]: unknown;
}

/** What `verifyWebhook` returns: a `run.finished` event, or one of a type this SDK does not read. */
export type WebhookEvent = RunFinishedEvent | UnknownWebhookEvent;

/** Whether `event` is a `run.finished` event, narrowing it to `RunFinishedEvent`. */
export function isRunFinishedEvent(event: WebhookEvent): event is RunFinishedEvent {
  return event.type === RUN_FINISHED_EVENT_TYPE;
}

// ── Verification ──────────────────────────────────────────────────────

/**
 * The headers of a call, as a receiver's framework hands them over: a fetch `Headers` (a Next.js
 * route handler, Hono, a worker) or a plain record (Node's `IncomingHttpHeaders`, Express). Names
 * are matched whatever their case. A header given as several values is read as those values
 * joined by spaces, which for `webhook-signature` lists every signature they carry.
 */
export type WebhookHeaders =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/** `verifyWebhook`'s options. */
export interface VerifyWebhookOptions {
  /**
   * The receiver's clock, which the call's `webhook-timestamp` must be within five minutes of;
   * the current time when absent. Given for a test, or to verify a call received earlier.
   */
  now?: Date;
}

/**
 * Why `verifyWebhook` refused a call, named as the contract's verification procedure names its
 * steps, in the order it takes them:
 *
 * - `missing_header`: `webhook-id`, `webhook-timestamp` or `webhook-signature` is absent or empty;
 * - `timestamp`: `webhook-timestamp` is not a whole number of Unix seconds, or is more than five
 *   minutes from the receiver's clock, either way;
 * - `signature`: no `v1` signature in `webhook-signature` is the call's under any secret given.
 */
export type WebhookRefusal = "missing_header" | "timestamp" | "signature";

/** The problem a refusal carries: the call's credential absent, or refused. */
function webhookRefusalProblem(refusal: WebhookRefusal): Problem {
  switch (refusal) {
    case "missing_header":
      return buildProblem("auth.missing_credential", {});
    case "timestamp":
    case "signature":
      return buildProblem("auth.invalid_credential", {});
  }
}

/**
 * A call `verifyWebhook` refused: it does not come from the runtime holding the secret, or not
 * within the last five minutes, so its body must not be acted on. Answer it with a status outside
 * `2xx`, such as `401`, which the sender counts as a failed attempt and retries.
 *
 * Branch on `refusal` (see `WebhookRefusal`). Its problem treats the signature as the call's
 * credential: `auth.missing_credential` for a missing header, `auth.invalid_credential` for a
 * timestamp or a signature refused. Nothing was requested, so it is no `PipelexRequestError`; it
 * is a `ProblemError`, as every error this SDK raises is.
 */
export class WebhookVerificationError extends ProblemError {
  /** Which step of the verification refused the call. */
  public readonly refusal: WebhookRefusal;

  constructor(message: string, refusal: WebhookRefusal) {
    super(webhookRefusalProblem(refusal));
    this.name = "WebhookVerificationError";
    this.message = message;
    this.refusal = refusal;
  }
}

/**
 * A verified call whose body is not a webhook event this SDK can read: bytes that are not UTF-8,
 * text that is not JSON, JSON that is not an object with a string `type`, or a `run.finished` event
 * missing a member the contract gives it or carrying one of the wrong type. The call does come from
 * the runtime holding the secret, so this is that runtime's fault, never the receiver's.
 *
 * Its problem is `request.malformed`, whose `reason` is `not_utf8` or `not_json`, for a body that
 * does not parse, and `request.invalid`, whose `field` names the member as a dotted path (`type`,
 * `attempt`, `data.status`), for one that parses but is no event.
 */
export class WebhookEventUnreadableError extends ProblemError {
  constructor(message: string, problem: Problem, options?: { cause?: unknown }) {
    super(problem, options);
    this.name = "WebhookEventUnreadableError";
    this.message = message;
  }
}

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1";
const ID_HEADER = "webhook-id";
const TIMESTAMP_HEADER = "webhook-timestamp";
const SIGNATURE_HEADER = "webhook-signature";
const UNIX_SECONDS = /^[0-9]+$/;
// Standard base64 (RFC 4648 §4) with its padding: whole quanta, then at most one padded one.
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TEXT_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Verify a call to a caller webhook and read its event.
 *
 * It follows the contract's procedure: it refuses a call missing one of the three headers, then
 * one whose `webhook-timestamp` is more than five minutes from `options.now`, then one whose
 * `webhook-signature` lists no `v1` signature matching its own, computed from the raw body under
 * each secret given and compared in constant time. Only then does it parse the body.
 *
 * Give `body` exactly as received, the raw bytes or their text, never a value parsed and written
 * again: the same JSON written with other bytes signs differently. In a framework that parses JSON
 * bodies by itself, read the raw body instead (`await request.text()` in a fetch handler,
 * `express.raw({ type: "application/json" })` in Express).
 *
 * `secret` is the `whsec_` secret the runtime signs with: the organization's, which its admins read
 * with `getWebhookSecret`, or the one a self-hosted runner's operator configured. During a rotation
 * give both, the call then verifying under either: the hosted plane signs every call with the new
 * secret and the previous one for 24 hours.
 *
 * Returns the event: a `RunFinishedEvent` (`isRunFinishedEvent`), or an `UnknownWebhookEvent` for a
 * `type` this SDK does not read, to acknowledge and ignore. Deduplicate on the `webhook-id` header,
 * since a delivery can arrive more than once.
 *
 * Throws `WebhookVerificationError` for a call refused, whose `refusal` says why;
 * `WebhookEventUnreadableError` for a verified call that holds no event this SDK reads; and
 * `RequestArgumentError` for a `secret` that is not a `whsec_` secret written in standard base64
 * with its padding, a `body` that is neither text nor bytes, or an `options.now` that is no valid
 * `Date`, before the call is looked at.
 */
export async function verifyWebhook(
  body: string | Uint8Array | ArrayBuffer,
  headers: WebhookHeaders,
  secret: string | readonly string[],
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  const keys = signingKeys(secret);
  const bodyBytes = bytesOf(body);
  const clock: unknown = options.now ?? new Date();
  // An invalid date would read every timestamp as within tolerance, so it is refused rather than used.
  if (!(clock instanceof Date) || Number.isNaN(clock.getTime())) {
    throw new RequestArgumentError("verifyWebhook() takes options.now as a valid Date.", {
      problem: argumentInvalidProblem("now", "not_a_date"),
    });
  }

  const webhookId = headerValue(headers, ID_HEADER);
  const webhookTimestamp = headerValue(headers, TIMESTAMP_HEADER);
  const webhookSignature = headerValue(headers, SIGNATURE_HEADER);
  if (webhookId === undefined || webhookTimestamp === undefined || webhookSignature === undefined) {
    const missing =
      webhookId === undefined
        ? ID_HEADER
        : webhookTimestamp === undefined
          ? TIMESTAMP_HEADER
          : SIGNATURE_HEADER;
    throw new WebhookVerificationError(
      `The call carries no ${missing} header, so it cannot be verified.`,
      "missing_header",
    );
  }

  const sentAt = UNIX_SECONDS.test(webhookTimestamp) ? Number(webhookTimestamp) : Number.NaN;
  if (!Number.isSafeInteger(sentAt)) {
    throw new WebhookVerificationError(
      "The call's webhook-timestamp is not a whole number of Unix seconds.",
      "timestamp",
    );
  }
  const now = Math.floor(clock.getTime() / 1000);
  if (Math.abs(now - sentAt) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError(
      `The call's webhook-timestamp is ${Math.abs(now - sentAt)} seconds from this clock, more than the ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} the contract accepts.`,
      "timestamp",
    );
  }

  const signed = concatBytes(TEXT_ENCODER.encode(`${webhookId}.${webhookTimestamp}.`), bodyBytes);
  const given = givenSignatures(webhookSignature);
  let verified = false;
  for (const key of keys) {
    const expected = await signatureOf(key, signed);
    // Every given signature is compared, whatever an earlier comparison found.
    for (const candidate of given) {
      if (equalInConstantTime(expected, candidate)) verified = true;
    }
  }
  if (!verified) {
    throw new WebhookVerificationError(
      "No v1 signature of the call matches its body under the secret given.",
      "signature",
    );
  }

  return readWebhookEvent(bodyBytes);
}

/** Each secret's key, the bytes after its `whsec_` prefix decoded from standard base64. */
function signingKeys(secret: unknown): Uint8Array<ArrayBuffer>[] {
  const secrets: unknown[] = Array.isArray(secret) ? [...(secret as unknown[])] : [secret];
  if (secrets.length === 0) {
    throw new RequestArgumentError(
      "verifyWebhook() needs at least one secret to verify a call with.",
      { problem: argumentInvalidProblem("secret", "empty") },
    );
  }
  return secrets.map((value) => {
    if (typeof value !== "string") {
      throw new RequestArgumentError(
        `verifyWebhook() takes each secret as a string; got ${value === null ? "null" : typeof value}.`,
        { problem: argumentInvalidProblem("secret", "not_a_string") },
      );
    }
    const key = value.startsWith(SECRET_PREFIX)
      ? decodeStandardBase64(value.slice(SECRET_PREFIX.length))
      : undefined;
    if (key === undefined) {
      // The secret itself is never quoted: it is the receiver's credential.
      throw new RequestArgumentError(
        "verifyWebhook() takes a secret written `whsec_` and its key in standard base64 with its " +
          "padding, as the runtime gives it; give the whole value.",
        { problem: argumentInvalidProblem("secret", "malformed") },
      );
    }
    return key;
  });
}

/** `text` decoded from standard base64 with its padding, or `undefined` for anything else. */
function decodeStandardBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text.length === 0 || !STANDARD_BASE64.test(text)) return undefined;
  const bytes = Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  // A last quantum whose unused bits are not zero decodes, but is not how the key is written.
  return encodeStandardBase64(bytes) === text ? bytes : undefined;
}

function encodeStandardBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A call's body as the bytes it was signed over: text in UTF-8, bytes as given. */
function bytesOf(body: unknown): Uint8Array {
  if (typeof body === "string") return TEXT_ENCODER.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new RequestArgumentError(
    "verifyWebhook() takes the call's raw body as a string, a Uint8Array or an ArrayBuffer.",
    { problem: argumentInvalidProblem("body", "not_text_or_bytes") },
  );
}

/** A header's value whatever the case of its name, or `undefined` when it is absent or empty. */
function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  let value: string | readonly string[] | null | undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    value = (headers as Headers).get(name);
  } else {
    const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
    value = key === undefined ? undefined : record[key];
  }
  const text = Array.isArray(value) ? value.join(" ") : value;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

/** The `v1` signatures a `webhook-signature` lists, an entry of any other version ignored. */
function givenSignatures(header: string): string[] {
  const signatures: string[] = [];
  for (const entry of header.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma > 0 && entry.slice(0, comma) === SIGNATURE_VERSION) {
      signatures.push(entry.slice(comma + 1));
    }
  }
  return signatures;
}

/** The base64 HMAC-SHA256 of `content` under `key`. */
async function signatureOf(
  key: Uint8Array<ArrayBuffer>,
  content: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const hmacKey = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await subtle.sign("HMAC", hmacKey, content);
  return encodeStandardBase64(new Uint8Array(signature));
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  return joined;
}

/**
 * Whether two signatures are equal, compared in a time that depends on their length alone. A
 * signature of another length is no match, and the expected one's length is public.
 */
function equalInConstantTime(expected: string, given: string): boolean {
  if (expected.length !== given.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ given.charCodeAt(index);
  }
  return difference === 0;
}

/** The refusal of a verified body that is no event, naming the member at fault. */
function invalidMember(field: string): WebhookEventUnreadableError {
  return new WebhookEventUnreadableError(
    `The verified call's body is not a webhook event this SDK reads: its member \`${field}\` is missing or of the wrong type.`,
    buildProblem("request.invalid", { field }),
  );
}

/** The event a verified body holds; see `WebhookEventUnreadableError` for what it refuses. */
function readWebhookEvent(bodyBytes: Uint8Array): WebhookEvent {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bodyBytes);
  } catch (err) {
    throw new WebhookEventUnreadableError(
      "The verified call's body is not UTF-8 text.",
      buildProblem("request.malformed", { reason: "not_utf8" }),
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new WebhookEventUnreadableError(
      "The verified call's body is not JSON.",
      buildProblem("request.malformed", { reason: "not_json" }),
      { cause: err },
    );
  }
  if (!isPlainObject(parsed) || typeof parsed.type !== "string") throw invalidMember("type");
  if (parsed.type !== RUN_FINISHED_EVENT_TYPE) return parsed as UnknownWebhookEvent;
  if (typeof parsed.timestamp !== "string") throw invalidMember("timestamp");
  const attempt = parsed.attempt;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw invalidMember("attempt");
  }
  const data = parsed.data;
  if (!isPlainObject(data)) throw invalidMember("data");
  if (typeof data.pipeline_run_id !== "string") throw invalidMember("data.pipeline_run_id");
  if (typeof data.status !== "string") throw invalidMember("data.status");
  const readData: Record<string, unknown> = { ...data };
  if (Object.hasOwn(readData, "error") && !isProblem(readData.error)) readData.error = null;
  return { ...parsed, data: readData } as RunFinishedEvent;
}

// ── The hosted delivery log ───────────────────────────────────────────

/**
 * Where a delivery stands: `pending` while on its retry schedule, `delivered` once a receiver
 * answered `2xx`, `failed` past its last attempt, which a replay can still deliver. Read open: a
 * state this SDK does not name arrives as its raw string.
 */
export type WebhookDeliveryState = "pending" | "delivered" | "failed";

/**
 * Why an attempt got no HTTP answer: `timeout` (none within fifteen seconds), `connection` (none
 * could be made, or it was cut), `tls` (the handshake failed, the receiver's certificate
 * included), `refused_address` (the host resolved to a private, loopback, link-local or metadata
 * address, or to none). An attempt that got an answer records its `status_code` instead.
 */
export type WebhookAttemptFailure = "timeout" | "connection" | "tls" | "refused_address";

/** One attempt of a delivery: when it was sent, what came back, how long it took. No response body is kept. */
export interface WebhookDeliveryAttempt {
  /** The attempt's number, from 1: the body's `attempt`. */
  attempt: number;
  /** When it was sent, ISO-8601 UTC. */
  attempted_at: string;
  /** The HTTP status the receiver answered; `null` when no answer came. */
  status_code: number | null;
  /** Why no answer came; `null` when one did. */
  failure: WebhookAttemptFailure | (string & {}) | null;
  /** How long it took, in milliseconds. */
  duration_ms: number | null;
}

/** One delivery of a run's webhook, as anyone who can read the run sees it. */
export interface WebhookDeliverySummary {
  /** `whd_` and hexadecimal digits: the receiver's `webhook-id`, the same on every attempt and replay. */
  delivery_id: string;
  /** The run whose event the delivery carries. */
  pipeline_run_id: string;
  /** The URL's position in the run's `callback_urls`, from 0. */
  url_index: number;
  /**
   * The URL redacted, as every view shows a registered URL: its scheme, its host and a port other
   * than the scheme's default, with `/***` in place of a path or query string, which may hold the
   * receiver's credential.
   */
  url: string;
  state: WebhookDeliveryState | (string & {});
  /** The event's `type`, `run.finished`. */
  event_type: string;
  /** When the delivery was recorded, ISO-8601 UTC. */
  created_at: string;
  /** Every attempt so far, oldest first, replays included. */
  attempts: WebhookDeliveryAttempt[];
}

/** One delivery with its event as sent — `GET /v1/runs/{id}/webhook-deliveries/{delivery_id}`. */
export interface WebhookDeliveryDetail extends WebhookDeliverySummary {
  /**
   * The body of the delivery's latest attempt, as sent: `type`, `timestamp`, `attempt` and `data`,
   * every attempt's body differing only in its `attempt`. Before any attempt, the body its first
   * attempt carries.
   */
  event: WebhookEvent;
}

/** A run's deliveries — `GET /v1/runs/{id}/webhook-deliveries`. */
export interface WebhookDeliveryList {
  pipeline_run_id: string;
  /**
   * One delivery per URL the run registered, in their order, once the run has ended; none for a
   * run that registered none or has not ended.
   */
  deliveries: WebhookDeliverySummary[];
}

/** A replay queued — the `202` of `POST /v1/runs/{id}/webhook-deliveries/{delivery_id}/replay`. */
export interface WebhookReplayAccepted {
  pipeline_run_id: string;
  /** The delivery replayed: the `webhook-id` the replay is sent under. */
  delivery_id: string;
  /**
   * The attempt number the replay is sent under. A replay asked again before this one is sent is
   * this same attempt.
   */
  attempt: number;
}

// ── The organization's signing secret ─────────────────────────────────

/**
 * An organization's webhook signing secret — `GET /v1/organizations/{org_id}/webhook-secret` and
 * its rotation. Only the current secret's value is served: the previous one, still signing until
 * `previous_secret_expires_at`, is the one a receiver already holds.
 */
export interface WebhookSecret {
  /** `whsec_` and the base64 of 32 random bytes: give the whole value to `verifyWebhook`. */
  secret: string;
  /** When the organization's first secret was generated, ISO-8601 UTC. */
  created_at: string;
  /** When it was last rotated; `null` when never. */
  rotated_at: string | null;
  /**
   * Until when the secret the last rotation replaced still signs beside this one, ISO-8601 UTC;
   * `null` once that has passed, or when nothing was replaced.
   */
  previous_secret_expires_at: string | null;
}

/** What a secret rotation sends beside its path: the request's own header. */
export interface WebhookSecretRotateOptions {
  /**
   * The rotation's idempotency key, sent as the `Idempotency-Key` header, and not sent at all when
   * absent or `null`. The answer carries the new secret, so the platform never replays it: the same
   * key sent again is refused `409` `request.already_executed`, rotating nothing more, and the
   * caller reads the secret with `getWebhookSecret`. A key is 1 to 255 visible ASCII characters,
   * anything else a `RequestArgumentError` before any request.
   */
  idempotencyKey?: string | null;
}
