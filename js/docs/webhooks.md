# Caller webhooks

A run can call webhooks of its caller once it has ended, so the caller learns of the end without polling. The run registers the URLs when it starts, in `callback_urls`; when it ends, the runtime sends each URL one signed `POST` carrying a `run.finished` event; the caller's receiver verifies the call, then fetches the results by the run's id. The contract is the spec `conformance/specs/pipelex-caller-webhooks.md`, in the `conformance` repository, which both the hosted plane and a self-hosted runner honour. This page covers the four parts the SDK takes: registering the URLs, verifying a call (`verifyWebhook`), reading the hosted delivery log, and reading or rotating the organization's signing secret. The Python SDK's twin is [`python/docs/webhooks.md`](../../python/docs/webhooks.md).

## Registering the webhooks — `callback_urls`

`execute`, `start` and `startAndWaitForResult` take `callback_urls`, an array of URLs:

```ts
const ack = await client.start({
  method_id: "mt_abc123",
  inputs,
  callback_urls: ["https://hooks.example.com/pipelex"],
});
ack.callback_urls; // ["https://hooks.example.com/***"]
```

It is a Pipelex API extension (`PipelexApiRunExtensions`), beside `method_ref`: the hosted API and a self-hosted runner both take it, and `startAndWaitForResult` keeps it on its blocking fallback, so a bare runner calls the same webhooks once its blocking run has ended. Each server holds the URLs to its own rules, which the client does not restate. The hosted API takes at most 5 HTTPS URLs of at most 2,048 characters, none repeated, and refuses a URL whose host resolves to a private, loopback, link-local or metadata address with a `422` `request.invalid` whose `field` names it as `callback_urls.<index>`; a deployment that does not deliver caller webhooks refuses the list with a `422` `request.unsupported`, and a self-hosted runner whose operator configured no signing secret with a `422` `pipelex.webhook.secret_not_configured`.

The client refuses, before anything is sent, a value that is not an array (`client.argument_invalid`, reason `not_a_list`) or an array holding anything but strings (`not_a_string`), and does not send an empty array, which the platform treats as absent. `callback_urls` is no run source: a run naming its webhooks and nothing to run is refused as any run with nothing to run is (`nothing_to_run`). It is reserved on `extra`, as `method_ref` is, so it reaches the body by its named option alone.

A URL may carry a credential of the receiver's in its path or query string. Every read of the run lists the URLs redacted to their scheme, host and a port other than the scheme's default, with `/***` in place of the rest: the start's acknowledgement (`PipelexRunResultStart.callback_urls`), the status read (`RunRead.callback_urls`) and the run record (`RunDetail.callback_urls`). For a run that registered none the acknowledgement leaves the member out, and the two reads answer `null`.

## Receiving a call — `verifyWebhook`

A call is a Standard Webhooks v1 `POST`. Its `webhook-id` header names the delivery, the same on every attempt and replay; `webhook-timestamp` is when the attempt was sent, in Unix seconds; and `webhook-signature` lists `v1,` and the base64 HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}` under each secret live when it was sent. `verifyWebhook(body, headers, secret, options?)` checks all three and returns the event:

```ts
import {
  WebhookEventUnreadableError,
  WebhookVerificationError,
  isRunFinishedEvent,
  verifyWebhook,
} from "@pipelex/sdk";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text(); // the raw body, never a parsed and re-serialized one
  let event;
  try {
    event = await verifyWebhook(body, request.headers, process.env.PIPELEX_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return new Response(null, { status: 401 });
    if (err instanceof WebhookEventUnreadableError) {
      // Verified, so sent by the runtime, but no event this SDK reads: every retry carries the same body.
      console.warn("Unreadable webhook", request.headers.get("webhook-id"), err.problem);
      return new Response(null, { status: 204 });
    }
    throw err;
  }
  if (!isRunFinishedEvent(event)) return new Response(null, { status: 204 }); // a type this receiver does not read
  if (await alreadyHandled(request.headers.get("webhook-id")!)) return new Response(null, { status: 204 });
  const results = await client.getRunResult(event.data.pipeline_run_id);
  // ...
  return new Response(null, { status: 204 });
}
```

It follows the contract's verification procedure, in its order:

1. **The headers.** A call missing `webhook-id`, `webhook-timestamp` or `webhook-signature`, or carrying one empty, is refused with the refusal `missing_header`. Header names are matched whatever their case; `headers` is a fetch `Headers` or a plain record such as Node's `IncomingHttpHeaders`, a header a record gives as several values, or names under several cases, being read as those values joined by spaces.
2. **The timestamp.** A `webhook-timestamp` that is not a whole number of Unix seconds, is past `Number.MAX_SAFE_INTEGER`, or is more than five minutes (`WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, 300) from the receiver's clock either way, is refused with `timestamp`; exactly five minutes is accepted. `options.now` sets the clock, for a test or a call received earlier.
3. **The signature.** The signature is computed from the raw body under each secret given and compared in constant time with every `v1` entry of `webhook-signature`, an entry of another version being ignored. Entries are separated by spaces, and a comma ending one is dropped, since a header sent more than once reaches a receiver joined by a comma and a space, as fetch's `Headers` and Node join it. No match is the refusal `signature`.

Only then is the body read. The body must be the bytes received, as a `string`, `Uint8Array` or `ArrayBuffer`: the same JSON written with other bytes, re-serialized or with its non-ASCII characters escaped, signs differently and is refused. In a framework that parses JSON bodies by itself, read the raw body instead, such as `express.raw({ type: "application/json" })` in Express.

The secret is the `whsec_` value the runtime signs with, given whole: the organization's on the hosted plane ([below](#the-organizations-signing-secret)), or the one a self-hosted runner's operator configured. During a rotation, give both the new and the previous secret as an array: the call verifies under either. A secret that is not `whsec_` and a key in standard base64 with its padding is refused with a `RequestArgumentError` (`client.argument_invalid` naming `secret`) before the call is looked at, and no refusal quotes it.

`verifyWebhook` uses Web Crypto (`globalThis.crypto.subtle`), so it runs in Node, Deno, Bun, an edge runtime or a worker, and stays out of the Node host like the rest of the barrel.

### What a refusal carries

| Error | When | `code` |
| --- | --- | --- |
| `WebhookVerificationError`, `refusal` `missing_header` | a header is absent or empty | `auth.missing_credential` |
| `WebhookVerificationError`, `refusal` `timestamp` | the timestamp is malformed or out of tolerance | `auth.invalid_credential` |
| `WebhookVerificationError`, `refusal` `signature` | no signature matches under any secret given | `auth.invalid_credential` |
| `WebhookEventUnreadableError` | a verified body that is not UTF-8 or not JSON | `request.malformed`, `reason` `not_utf8` or `not_json` |
| `WebhookEventUnreadableError` | a verified body that is no event this SDK reads | `request.invalid`, `field` the member at fault (`type`, `timestamp`, `attempt`, `data`, `data.pipeline_run_id`, `data.status`) |
| `RequestArgumentError` | a secret, a body or a clock of the wrong kind | `client.argument_invalid` naming `secret`, `body` or `now` |

Answer a `WebhookVerificationError` with a status outside `2xx`, such as `401`: the sender counts it as a failed attempt and retries, and a replay later sends the delivery again. Answer a `WebhookEventUnreadableError` with a `2xx` instead, and log it, as the example does: the call was verified, so the runtime sent it, and every retry and replay of the delivery carries the same body, so failing it would only spend the delivery's attempts on a body this SDK will never read. Both errors are `ProblemError`s, never a `PipelexRequestError`, since nothing was requested.

### The event

`verifyWebhook` returns a `RunFinishedEvent` (`isRunFinishedEvent`), or an `UnknownWebhookEvent` for a `type` this SDK does not read, which a receiver acknowledges with a `2xx` and ignores. A `run.finished` event holds:

- `type`, `run.finished` for every ending, the outcome being in `data.status`;
- `timestamp`, when the run ended (its `finished_at`), not when the call was sent;
- `attempt`, which attempt of the delivery this call is, from 1 to `Number.MAX_SAFE_INTEGER`. It is informational: it increases with each retry and a replay continues it, but a runtime that runs its delivery step again may skip numbers or start again at 1 under the same `webhook-id`. Deduplicate on the `webhook-id` header, never on `attempt` or the body;
- `data`, the run as its caller's status read served it when the delivery was created, the same on every attempt and replay.

The event never carries the run's results: fetch them with `getRunResult(event.data.pipeline_run_id)`.

**Two shapes of `data` reach a receiver today, and `RunFinishedEventData` accepts both.** A self-hosted runner sends the MTHDS protocol's status read: `pipeline_run_id`, a lowercase `status` (`completed` or `failed`, a cancelled or timed-out run reading `failed` with a code that says why), and for a failed run its problem as `error`, a member with no value left out. The hosted plane sends the body of its own `GET /v1/runs/{id}/status`, this SDK's `RunRead`, without `callback_urls`: an uppercase `status` (`COMPLETED`, `FAILED`, `CANCELLED`, `TERMINATED` or `TIMED_OUT`), a member with no value written as `null`, and the platform's own members, such as `finished_at`, `method_id` and `request_id`. That hosted shape does not validate against the contract's JSON Schema, which describes the protocol's read; the hosted event follows its status read onto the protocol's shape when that read moves, with no change of its own. Until then, tell a success from a failure under both spellings with `event.data.status.toLowerCase() === "completed"`. A failed run's `error` is kept when it is a problem document and read as `null` otherwise, as the status read keeps it.

## The hosted delivery log

The hosted plane records each delivery, one per URL a run registered, with every attempt. Any member of the organization reads them, by web session or API key:

- `listRunWebhookDeliveries(runId)` — `GET /v1/runs/{id}/webhook-deliveries`, a `WebhookDeliveryList` whose `deliveries` are `WebhookDeliverySummary` rows in the order of the run's URLs, none for a run that registered none or has not ended. Each has its `delivery_id` (the receiver's `webhook-id`), its `url_index` and redacted `url`, its `state` (`pending` on its retry schedule, `delivered` once a receiver answered `2xx`, `failed` past its last attempt) and its `attempts`, each with when it was sent, the HTTP `status_code` the receiver answered, or the `failure` that kept an answer from coming (`timeout`, `connection`, `tls`, `refused_address`), and its `duration_ms`. No response body is kept.
- `getRunWebhookDelivery(runId, deliveryId)` — one `WebhookDeliveryDetail`, the summary and its `event`: the body its latest attempt sent, or, before any attempt, the body its first attempt will send. Every attempt and replay of the delivery sends that body, only its `attempt` changing, so the `event` matches what a receiver logged only once an attempt was made: it then equals, as JSON, the body that attempt brought the receiver. Compare the two as parsed JSON values, never as text, since the read promises the same value, not the same bytes.
- `replayRunWebhookDelivery(runId, deliveryId, { idempotencyKey? })` — sends a settled delivery again: one new attempt under the same `webhook-id`, with the same `data`, the next `attempt`, a fresh timestamp and the signatures of the secrets live then. It answers `202` with a `WebhookReplayAccepted` naming the attempt; a replay asked again before it is sent is that same attempt. A delivery still `pending` is refused `409` `pipelex.org.not_manageable` with the reason `webhook_delivery_pending`, and one holding the most attempts a delivery holds with `webhook_delivery_attempts_exhausted`; past the organization's replay rate the platform answers `429` `account.rate_limited` with its `retry_after`.

### Retrying a replay — `idempotencyKey`

`replayRunWebhookDelivery`'s last argument takes an `idempotencyKey`, sent as the `Idempotency-Key` header of the replay and not sent at all when absent or `null`. The platform stores the replay's answer under the key, so the same replay sent again under the same key gets the stored answer, naming the same attempt, and the delivery is not sent twice: a replay whose answer was lost, as on a client timeout, can be sent again safely. Generate one key per replay you mean to ask for (a `crypto.randomUUID()` is a good one), and keep it across that replay's retries:

```ts
const idempotencyKey = crypto.randomUUID();
const accepted = await client.replayRunWebhookDelivery(runId, deliveryId, { idempotencyKey });
```

A key reused for another request is refused `409` `request.idempotency_conflict`, whose `retry` is `no`, and a key whose earlier request is still being handled `409` `request.idempotency_key_in_use`, whose `retry` is `yes`: send it again under the same key after its `retryAfter`. A key is 1 to 255 visible ASCII characters, `!` to `~`; anything else, an empty string included, is a `RequestArgumentError` naming `idempotency_key` before anything is sent, the rule a start's key is held to ([errors.md](./errors.md#a-starts-idempotency-key--idempotencykey)).

The states and failures are read open: one this SDK does not name arrives as its raw string.

## The organization's signing secret

On the hosted plane every caller webhook of an organization is signed with the organization's secret. Its admins read it, from a web session only, since the hosted gateway refuses an API key on these routes:

- `getWebhookSecret(orgId)` — `GET /v1/organizations/{org_id}/webhook-secret`, a `WebhookSecret`: the `secret`, when it was created, when it was last rotated, and until when the secret the last rotation replaced still signs (`previous_secret_expires_at`). The platform generates the first secret on this first read. Treat the answer as a credential: never log or cache it.
- `rotateWebhookSecret(orgId, { idempotencyKey? })` — `POST /v1/organizations/{org_id}/webhook-secret/rotate`. The new secret is current at once and the previous one keeps signing beside it for 24 hours, so a receiver configured with both, as `verifyWebhook` takes them, misses nothing. The answer carries a secret, so the platform never replays it: the same `Idempotency-Key` sent again is refused `409` `request.already_executed` and rotates nothing more, and the secret is then read with `getWebhookSecret`.

Both refuse another role with `403` `auth.forbidden` whose `params.requirement` is `admin`, an organization other than the caller's active one with `403` `pipelex.org.mismatch`, and one with no record with `404` `pipelex.org.not_found`.

## How the verification is held to the contract

The contract's known-answer vectors, `tests/caller_webhooks/fixtures/signature-vectors.json` in the `conformance` repository, are vendored byte for byte at `tests/fixtures/caller-webhooks/signature-vectors.json`, with `tests/fixtures/caller-webhooks/vendored.json` recording the commit it was copied at and its SHA-256. `tests/webhooks.test.ts` fails when the copy no longer has that digest, verifies every verification case at its `receiver_clock` and compares its verdict and refusal, and verifies every signing case under each secret that signed it. The shared case file `tests/fixtures/webhook-events.json` adds what the vectors leave to each SDK: the problem of each refusal, what each verified body reads as (the hosted and self-hosted shapes, an unknown type, the unreadable bodies) and the secrets refused.

All three files are shared with the Python SDK the way every case file is ([`docs/layout.md`](../../docs/layout.md)): the source is here, `scripts/shared-files.mjs` declares the copies under `python/tests/fixtures/`, and `make check-shared-files` fails on a stale copy. To refresh the vectors, copy the file from the conformance repository at the commit that last changed it, update the commit and the digest in `vendored.json`, and run `make shared-files` at the repository's root.
