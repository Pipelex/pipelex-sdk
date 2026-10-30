/**
 * The receiver side of a caller webhook: `verifyWebhook` held to the contract's known-answer
 * vectors, vendored byte for byte from the conformance repository in
 * `fixtures/caller-webhooks/`, then to the shared cases of `fixtures/webhook-events.json`, which
 * say what each verified body reads as and which secrets are refused. The Python SDK runs the same
 * two files in `tests/unit/test_webhooks.py`.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";
import { ProblemError } from "mthds/protocol";

import { RequestArgumentError } from "../src/errors.js";
import {
  RUN_FINISHED_EVENT_TYPE,
  WebhookEventUnreadableError,
  WebhookVerificationError,
  isRunFinishedEvent,
  verifyWebhook,
} from "../src/webhooks.js";
import type { RunFinishedEvent, WebhookEvent, WebhookRefusal } from "../src/webhooks.js";

interface Vectors {
  timestamp_tolerance_seconds: number;
  signing: {
    name: string;
    secrets: string[];
    webhook_id: string;
    webhook_timestamp: string;
    body: string;
    webhook_signature: string;
  }[];
  verification: {
    name: string;
    secret: string;
    headers: Record<string, string>;
    body: string;
    receiver_clock: number;
    verdict: "accepted" | "rejected";
    refusal?: WebhookRefusal | null;
  }[];
}

interface Vendored {
  source: { repository: string; commit: string };
  files: Record<string, { path: string; sha256: string }>;
}

interface ExpectedEvent {
  type: string;
  known: boolean;
  attempt?: number;
  error_code?: string | null;
  data?: Record<string, unknown>;
}

interface EventCall {
  name: string;
  summary: string;
  body?: string;
  body_base64?: string;
  webhook_timestamp?: string;
  signature_header?: string;
  expect:
    | { event: ExpectedEvent }
    | { refusal: WebhookRefusal }
    | { unreadable: { code: string; params: Record<string, unknown> } };
}

interface EventCases {
  secret: string;
  webhook_id: string;
  webhook_timestamp: string;
  receiver_clock: number;
  refusals: Record<WebhookRefusal, string>;
  calls: EventCall[];
  secrets: { name: string; summary: string; secret: unknown; reason: string }[];
}

function fixture(path: string): Buffer {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url));
}

const VECTOR_BYTES = fixture("caller-webhooks/signature-vectors.json");
const VECTORS = JSON.parse(VECTOR_BYTES.toString("utf8")) as Vectors;
const VENDORED = JSON.parse(fixture("caller-webhooks/vendored.json").toString("utf8")) as Vendored;
const CASES = JSON.parse(fixture("webhook-events.json").toString("utf8")) as EventCases;

function clockAt(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

/** What a call rejected with. */
async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => expect.fail("expected the call to throw"),
    (thrown: unknown) => thrown,
  );
}

/** The base64 HMAC-SHA256 a sender writes for `body` under `secret`. */
function signatureOf(secret: string, webhookId: string, timestamp: string, body: Buffer): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`, "utf8"), body]))
    .digest("base64");
}

/** A shared case's call, signed under the case file's secret as its fields say. */
function signedCall(call: EventCall): { body: Uint8Array; headers: Record<string, string> } {
  const body =
    call.body_base64 !== undefined
      ? Buffer.from(call.body_base64, "base64")
      : Buffer.from(call.body!, "utf8");
  const timestamp = call.webhook_timestamp ?? CASES.webhook_timestamp;
  const signature = signatureOf(CASES.secret, CASES.webhook_id, timestamp, body);
  const header = (call.signature_header ?? "{v1}")
    .replaceAll("{v1}", `v1,${signature}`)
    .replaceAll("{signature}", signature);
  return {
    body: new Uint8Array(body),
    headers: {
      "webhook-id": CASES.webhook_id,
      "webhook-timestamp": timestamp,
      "webhook-signature": header,
    },
  };
}

describe("the vendored vectors", () => {
  it("are the conformance repository's file, byte for byte", () => {
    const record = VENDORED.files["signature-vectors.json"]!;
    expect(VENDORED.source.repository).toBe("Pipelex/conformance");
    expect(VENDORED.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.path).toBe("tests/caller_webhooks/fixtures/signature-vectors.json");
    expect(createHash("sha256").update(VECTOR_BYTES).digest("hex")).toBe(record.sha256);
  });

  it("set the tolerance the SDK applies", () => {
    expect(VECTORS.timestamp_tolerance_seconds).toBe(300);
  });
});

describe("verifyWebhook — the contract's verification vectors", () => {
  it.each(VECTORS.verification.map((vector) => [vector.name, vector] as const))(
    "%s",
    async (_, vector) => {
      const verifying = verifyWebhook(vector.body, vector.headers, vector.secret, {
        now: clockAt(vector.receiver_clock),
      });

      if (vector.verdict === "accepted") {
        const event = await verifying;
        expect(event).toEqual(JSON.parse(vector.body));
        expect(isRunFinishedEvent(event)).toBe(true);
        return;
      }
      const err = await failureOf(() => verifying);
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect(err).toBeInstanceOf(ProblemError);
      expect((err as WebhookVerificationError).refusal).toBe(vector.refusal);
    },
  );

  it.each(VECTORS.verification.map((vector) => [vector.name, vector] as const))(
    "%s, from the body's bytes and a fetch Headers",
    async (_, vector) => {
      const verifying = verifyWebhook(
        new TextEncoder().encode(vector.body),
        new Headers(vector.headers),
        [vector.secret],
        { now: clockAt(vector.receiver_clock) },
      );

      if (vector.verdict === "accepted") {
        await expect(verifying).resolves.toEqual(JSON.parse(vector.body));
      } else {
        await expect(verifying).rejects.toMatchObject({ refusal: vector.refusal });
      }
    },
  );
});

describe("verifyWebhook — the contract's signing vectors", () => {
  it.each(VECTORS.signing.map((vector) => [vector.name, vector] as const))(
    "%s verifies under each secret that signed it, and under all of them",
    async (_, vector) => {
      const headers = {
        "webhook-id": vector.webhook_id,
        "webhook-timestamp": vector.webhook_timestamp,
        "webhook-signature": vector.webhook_signature,
      };
      const now = clockAt(Number(vector.webhook_timestamp));
      for (const secret of [...vector.secrets.map((one) => [one]), vector.secrets]) {
        const event = await verifyWebhook(vector.body, headers, secret, { now });
        expect(event).toEqual(JSON.parse(vector.body));
      }
    },
  );

  it.each(VECTORS.signing.map((vector) => [vector.name, vector] as const))(
    "%s: the signature a sender writes is the vector's",
    (_, vector) => {
      const written = vector.secrets
        .map(
          (secret) =>
            `v1,${signatureOf(secret, vector.webhook_id, vector.webhook_timestamp, Buffer.from(vector.body, "utf8"))}`,
        )
        .join(" ");
      expect(written).toBe(vector.webhook_signature);
    },
  );
});

describe("verifyWebhook — the shared calls", () => {
  it.each(CASES.calls.map((call) => [call.name, call] as const))("%s", async (_, call) => {
    const { body, headers } = signedCall(call);
    const verifying = verifyWebhook(body, headers, CASES.secret, {
      now: clockAt(CASES.receiver_clock),
    });

    const expected = call.expect;
    if ("event" in expected) {
      const event = await verifying;
      expect(event.type).toBe(expected.event.type);
      expect(isRunFinishedEvent(event)).toBe(expected.event.known);
      if (!isRunFinishedEvent(event)) return;
      expect(event.attempt).toBe(expected.event.attempt);
      expect(event.data.error?.code ?? null).toBe(expected.event.error_code);
      expect(event.data).toMatchObject(expected.event.data ?? {});
    } else if ("refusal" in expected) {
      const err = await failureOf(() => verifying);
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect((err as WebhookVerificationError).refusal).toBe(expected.refusal);
      expect((err as WebhookVerificationError).code).toBe(CASES.refusals[expected.refusal]);
    } else {
      const err = await failureOf(() => verifying);
      expect(err).toBeInstanceOf(WebhookEventUnreadableError);
      expect(err).not.toBeInstanceOf(WebhookVerificationError);
      expect((err as WebhookEventUnreadableError).code).toBe(expected.unreadable.code);
      expect((err as WebhookEventUnreadableError).problem.params).toEqual(
        expected.unreadable.params,
      );
    }
  });

  it.each(Object.entries(CASES.refusals))(
    "a %s refusal carries %s, and is no request error",
    async (refusal, code) => {
      const vector = VECTORS.verification.find((one) => one.refusal === refusal)!;
      const err = await failureOf(() =>
        verifyWebhook(vector.body, vector.headers, vector.secret, {
          now: clockAt(vector.receiver_clock),
        }),
      );
      expect((err as WebhookVerificationError).code).toBe(code);
      expect((err as WebhookVerificationError).name).toBe("WebhookVerificationError");
    },
  );

  it("reads a header given as several values as those values joined", async () => {
    const vector = VECTORS.signing.find((one) => one.name === "rotation")!;
    const [current, previous] = vector.webhook_signature.split(" ");

    const event = await verifyWebhook(
      vector.body,
      {
        "webhook-id": vector.webhook_id,
        "webhook-timestamp": vector.webhook_timestamp,
        "webhook-signature": [current!, previous!],
      },
      vector.secrets[1]!,
      { now: clockAt(Number(vector.webhook_timestamp)) },
    );

    expect(event.type).toBe(RUN_FINISHED_EVENT_TYPE);
  });

  it("verifies against the current time when no clock is given", async () => {
    const call = CASES.calls.find((one) => one.name === "self-hosted/completed")!;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { body, headers } = signedCall({ ...call, webhook_timestamp: timestamp });

    await expect(verifyWebhook(body, headers, CASES.secret)).resolves.toMatchObject({
      type: RUN_FINISHED_EVENT_TYPE,
    });
  });

  it("verifies a body given as an ArrayBuffer", async () => {
    const call = CASES.calls.find((one) => one.name === "self-hosted/completed")!;
    const { body, headers } = signedCall(call);

    await expect(
      verifyWebhook(body.slice().buffer, headers, CASES.secret, {
        now: clockAt(CASES.receiver_clock),
      }),
    ).resolves.toMatchObject({ type: RUN_FINISHED_EVENT_TYPE });
  });
});

describe("verifyWebhook — the secrets it refuses", () => {
  it.each(CASES.secrets.map((one) => [one.name, one] as const))("%s", async (_, refused) => {
    const vector = VECTORS.verification[0]!;

    const err = await failureOf(() =>
      verifyWebhook(vector.body, vector.headers, refused.secret as string, {
        now: clockAt(vector.receiver_clock),
      }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    const problem = (err as RequestArgumentError).problem;
    expect(problem.code).toBe("client.argument_invalid");
    expect(problem.params).toMatchObject({ argument: "secret", reason: refused.reason });
    // The secret is the receiver's credential, so no refusal quotes it.
    const quoted = Array.isArray(refused.secret) ? refused.secret : [refused.secret];
    for (const value of quoted) {
      if (typeof value === "string" && value.length > "whsec_".length) {
        expect((err as Error).message).not.toContain(value);
      }
    }
  });

  it("refuses a body that is neither text nor bytes, before the call is looked at", async () => {
    const vector = VECTORS.verification[0]!;

    const err = await failureOf(() =>
      verifyWebhook(JSON.parse(vector.body) as string, vector.headers, vector.secret),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as RequestArgumentError).problem.params).toMatchObject({ argument: "body" });
  });
});

describe("verifyWebhook — the clock it refuses", () => {
  it.each([
    ["an invalid Date", new Date("not a date")],
    ["a number", 1792670403000 as unknown as Date],
  ])("refuses %s, which would read every timestamp as within tolerance", async (_, now) => {
    const vector = VECTORS.verification[0]!;

    const err = await failureOf(() =>
      verifyWebhook(vector.body, vector.headers, vector.secret, { now }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as RequestArgumentError).problem.params).toEqual({
      argument: "now",
      reason: "not_a_date",
    });
  });
});

describe("the event's types", () => {
  it("narrows a run.finished event to its data", () => {
    expectTypeOf<Extract<WebhookEvent, RunFinishedEvent>>().toEqualTypeOf<RunFinishedEvent>();
    expectTypeOf<RunFinishedEvent["data"]["pipeline_run_id"]>().toEqualTypeOf<string>();
    expectTypeOf<RunFinishedEvent["attempt"]>().toEqualTypeOf<number>();
  });
});
