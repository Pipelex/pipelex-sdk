/**
 * The caller side of a caller webhook: a run's `callback_urls`, sent by `execute`, `start` and
 * `startAndWaitForResult` with its blocking fallback, refused before anything is sent when it is
 * no list of strings, and never a run source; the acknowledgement's echo of it; and the routes of
 * the hosted delivery log and of an organization's signing secret. The Python SDK holds the same
 * requests to the same tests in `tests/unit/test_client_webhooks.py`.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { PipelexApiClient } from "../src/client.js";
import type { PipelexRunResultStart } from "../src/models.js";
import { ApiResponseError, RequestArgumentError } from "../src/errors.js";
import type {
  WebhookDeliveryDetail,
  WebhookDeliveryList,
  WebhookReplayAccepted,
  WebhookSecret,
} from "../src/webhooks.js";
import { problemResponse } from "./helpers/problems.js";

const BASE_URL = "http://localhost:8081";
const KEY = "5f0c6a52-2d3e-4c8b-9a51-7e1f0b6c2d44";
const RUN_ID = "84bbc909-cde4-4b99-a9ad-d09d3b1241a5";
const DELIVERY_ID = "whd_5d0c2a7e91f34b6c8a1e0d7f3b9c4e21";
const URLS = ["https://hooks.example.com/pipelex?token=abc", "https://backup.example.com/runs"];
const REDACTED = ["https://hooks.example.com/***", "https://backup.example.com/***"];

const DELIVERY = {
  delivery_id: DELIVERY_ID,
  pipeline_run_id: RUN_ID,
  url_index: 0,
  url: REDACTED[0],
  state: "failed",
  event_type: "run.finished",
  created_at: "2026-10-30T09:15:05.002Z",
  attempts: [
    {
      attempt: 1,
      attempted_at: "2026-10-30T09:15:05.120Z",
      status_code: 503,
      failure: null,
      duration_ms: 214,
    },
    {
      attempt: 2,
      attempted_at: "2026-10-30T09:15:35.401Z",
      status_code: null,
      failure: "timeout",
      duration_ms: 15000,
    },
  ],
};

const SECRET = {
  secret: "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  created_at: "2026-10-01T08:00:00Z",
  rotated_at: null,
  previous_secret_expires_at: null,
};

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A completed blocking-execute answer, for a bare runner's path. */
function executeBody(): Record<string, unknown> {
  return {
    pipeline_run_id: RUN_ID,
    created_at: "t0",
    state: "COMPLETED",
    main_stuff_name: "result",
    pipe_output: {
      working_memory: {
        root: { result: { concept: "native.Text", content: { text: "hello" } } },
        aliases: { main_stuff: "result" },
      },
      pipeline_run_id: RUN_ID,
    },
  };
}

/** The request the client sent on the fetch spy's call at `index`. */
function sentRequest(
  fetchSpy: { mock: { calls: unknown[][] } },
  index: number,
): { url: string; method: string; headers: Record<string, string>; body: unknown } {
  const [url, init] = fetchSpy.mock.calls[index] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : (JSON.parse(init.body as string) as unknown),
  };
}

/** What a call rejected with. */
async function failureOf(call: () => Promise<unknown>): Promise<unknown> {
  return call().then(
    () => expect.fail("expected the call to throw"),
    (thrown: unknown) => thrown,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a run's callback_urls", () => {
  it("rides start's body beside the run, and the acknowledgement echoes it redacted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(202, {
        pipeline_run_id: RUN_ID,
        state: "STARTED",
        created_at: "t0",
        callback_urls: REDACTED,
      }),
    );

    const ack = await makeClient().start({ method_id: "mt_abc123", callback_urls: URLS });

    expect(sentRequest(fetchSpy, 0)).toMatchObject({
      url: `${BASE_URL}/v1/start`,
      body: { method_id: "mt_abc123", callback_urls: URLS },
    });
    expect(ack.callback_urls).toEqual(REDACTED);
    expectTypeOf<PipelexRunResultStart["callback_urls"]>().toEqualTypeOf<
      string[] | null | undefined
    >();
  });

  it("rides execute's body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, executeBody()));

    await makeClient().execute({ pipe_code: "summarize", callback_urls: URLS });

    expect(sentRequest(fetchSpy, 0).body).toEqual({ pipe_code: "summarize", callback_urls: URLS });
  });

  it("keeps the list on the blocking fallback, so a bare runner calls the same webhooks", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { implementation: "pipelex-api" }))
      .mockResolvedValueOnce(jsonResponse(200, executeBody()));

    await makeClient().startAndWaitForResult({ pipe_code: "summarize", callback_urls: URLS });

    const execute = sentRequest(fetchSpy, 1);
    expect(execute.url).toBe(`${BASE_URL}/v1/execute`);
    expect(execute.body).toMatchObject({ callback_urls: URLS });
  });

  it.each([
    ["absent", {}],
    ["null", { callback_urls: null }],
    ["empty", { callback_urls: [] }],
  ])("is not sent when %s", async (_, urls) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(202, { pipeline_run_id: RUN_ID, state: "STARTED", created_at: "t0" }),
      );

    const ack = await makeClient().start({ method_id: "mt_abc123", ...urls });

    expect(sentRequest(fetchSpy, 0).body).toEqual({ method_id: "mt_abc123" });
    expect(ack.callback_urls).toBeUndefined();
  });

  it.each([
    ["a string", "https://hooks.example.com/pipelex", "not_a_list"],
    ["an object", { url: "https://hooks.example.com/pipelex" }, "not_a_list"],
    ["a list holding a number", ["https://hooks.example.com/pipelex", 42], "not_a_string"],
    ["a list holding null", [null], "not_a_string"],
  ])("refuses %s before anything is sent", async (_, urls, reason) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().start({ method_id: "mt_abc123", callback_urls: urls as unknown as string[] }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as RequestArgumentError).message).toMatch(/^start\(\) takes /);
    expect((err as RequestArgumentError).problem.params).toEqual({
      argument: "callback_urls",
      reason,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is no run source: a run of webhooks alone has nothing to run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() => makeClient().execute({ callback_urls: URLS }));

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as RequestArgumentError).problem.params).toEqual({
      argument: "pipe_code",
      reason: "nothing_to_run",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is refused through `extra`, where it would pass every check of the named option", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().start({ pipe_code: "summarize", extra: { callback_urls: URLS } }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as RequestArgumentError).message).toMatch(
      /reserved request args \[callback_urls\]/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces the platform's refusal of a URL by its code and field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      problemResponse("request.invalid", 422, { params: { field: "callback_urls.1" } }),
    );

    const err = await failureOf(() =>
      makeClient().start({ method_id: "mt_abc123", callback_urls: URLS }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("request.invalid");
    expect((err as ApiResponseError).problem.params).toEqual({ field: "callback_urls.1" });
  });
});

describe("the delivery log", () => {
  it("lists a run's deliveries", async () => {
    const answer = { pipeline_run_id: RUN_ID, deliveries: [DELIVERY] };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(200, answer));

    const list = await makeClient().listRunWebhookDeliveries(RUN_ID);

    expect(sentRequest(fetchSpy, 0)).toMatchObject({
      url: `${BASE_URL}/v1/runs/${RUN_ID}/webhook-deliveries`,
      method: "GET",
    });
    expect(list).toEqual(answer);
    expectTypeOf(list).toEqualTypeOf<WebhookDeliveryList>();
  });

  it("refuses an answer whose deliveries is not an array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse(200, { pipeline_run_id: RUN_ID, deliveries: null }),
    );

    const err = await failureOf(() => makeClient().listRunWebhookDeliveries(RUN_ID));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("client.response_unreadable");
  });

  it("reads one delivery with its event as sent", async () => {
    const event = {
      type: "run.finished",
      timestamp: "2026-10-30T09:15:04.512Z",
      attempt: 2,
      data: { pipeline_run_id: RUN_ID, status: "COMPLETED", error: null },
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { ...DELIVERY, event }));

    const detail = await makeClient().getRunWebhookDelivery(RUN_ID, DELIVERY_ID);

    expect(sentRequest(fetchSpy, 0)).toMatchObject({
      url: `${BASE_URL}/v1/runs/${RUN_ID}/webhook-deliveries/${DELIVERY_ID}`,
      method: "GET",
    });
    expect(detail.event).toEqual(event);
    expectTypeOf(detail).toEqualTypeOf<WebhookDeliveryDetail>();
  });

  it("replays a delivery, with no body and no idempotency key", async () => {
    const answer = { pipeline_run_id: RUN_ID, delivery_id: DELIVERY_ID, attempt: 3 };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(202, answer));

    const accepted = await makeClient().replayRunWebhookDelivery(RUN_ID, DELIVERY_ID);

    const request = sentRequest(fetchSpy, 0);
    expect(request).toMatchObject({
      url: `${BASE_URL}/v1/runs/${RUN_ID}/webhook-deliveries/${DELIVERY_ID}/replay`,
      method: "POST",
      body: undefined,
    });
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain(
      "idempotency-key",
    );
    expect(accepted).toEqual(answer);
    expectTypeOf(accepted).toEqualTypeOf<WebhookReplayAccepted>();
  });

  it.each([
    ["webhook_delivery_pending", 409, "pipelex.org.not_manageable"],
    ["webhook_delivery_attempts_exhausted", 409, "pipelex.org.not_manageable"],
  ])("surfaces a replay refused for %s by its code and reason", async (reason, status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      problemResponse(code, status, { params: { reason } }),
    );

    const err = await failureOf(() => makeClient().replayRunWebhookDelivery(RUN_ID, DELIVERY_ID));

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe(code);
    expect((err as ApiResponseError).problem.params).toEqual({ reason });
  });
});

describe("the organization's signing secret", () => {
  it("reads the secret", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(200, SECRET));

    const secret = await makeClient().getWebhookSecret("org-1");

    expect(sentRequest(fetchSpy, 0)).toMatchObject({
      url: `${BASE_URL}/v1/organizations/org-1/webhook-secret`,
      method: "GET",
    });
    expect(secret).toEqual(SECRET);
    expectTypeOf(secret).toEqualTypeOf<WebhookSecret>();
  });

  it("rotates the secret under the idempotency key given", async () => {
    const rotated = {
      ...SECRET,
      secret: "whsec_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=",
      rotated_at: "2026-10-30T10:00:00Z",
      previous_secret_expires_at: "2026-10-31T10:00:00Z",
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, rotated));

    const secret = await makeClient().rotateWebhookSecret("org-1", { idempotencyKey: KEY });

    const request = sentRequest(fetchSpy, 0);
    expect(request).toMatchObject({
      url: `${BASE_URL}/v1/organizations/org-1/webhook-secret/rotate`,
      method: "POST",
      body: undefined,
    });
    expect(request.headers["Idempotency-Key"]).toBe(KEY);
    expect(secret).toEqual(rotated);
  });

  it("rotates with no idempotency key when none is given", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(200, SECRET));

    await makeClient().rotateWebhookSecret("org-1");

    expect(
      Object.keys(sentRequest(fetchSpy, 0).headers).map((name) => name.toLowerCase()),
    ).not.toContain("idempotency-key");
  });

  it("refuses a malformed idempotency key before anything is sent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await failureOf(() =>
      makeClient().rotateWebhookSecret("org-1", { idempotencyKey: "two words" }),
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as RequestArgumentError).problem.params).toMatchObject({
      argument: "idempotency_key",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a key sent again by request.already_executed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      problemResponse("request.already_executed", 409),
    );

    const err = await failureOf(() =>
      makeClient().rotateWebhookSecret("org-1", { idempotencyKey: KEY }),
    );

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("request.already_executed");
  });
});
