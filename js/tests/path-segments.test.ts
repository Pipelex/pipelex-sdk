/**
 * Every id a route puts in its path — a method's, an example's, a run's, an organization's, an
 * API key's — goes through one guard. An id the URL would resolve rather than address, `.`, `..`
 * or an empty one, is refused before anything is sent: `..` given as an example id would
 * otherwise reach the method itself, and a delete of it would erase the method. Every other id
 * stays in its own segment once the URL is resolved, which these tests check through the URL
 * parser `fetch` itself applies (`new Request(url).url`), not by comparing raw strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemError } from "mthds/protocol";
import { PipelexApiClient } from "../src/client.js";
import { RequestArgumentError } from "../src/errors.js";

const BASE_URL = "http://localhost:8081";
const METHOD_ID = "mt_receipts01";
const EXAMPLE_ID = "ex_0192b3c4-d5e6-7f80-9a1b-2c3d4e5f6a7b";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

/** A refusal every route reads as a failure, so a call ends once its one request is recorded. */
function refusal(): Response {
  return new Response(
    JSON.stringify({ status: 400, code: "malformed_request", detail: "Refused by the test." }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * One route that puts an id in its path: its name as a refusal names it, the call given that id,
 * and the URL it addresses for an id already encoded as one segment.
 */
type IdRoute = [
  name: string,
  call: (client: PipelexApiClient, id: string) => Promise<unknown>,
  url: (segment: string) => string,
];

const METHOD_URL = (segment: string): string => `${BASE_URL}/v1/methods/${segment}`;
const EXAMPLE_URL = (segment: string): string =>
  `${BASE_URL}/v1/methods/${METHOD_ID}/examples/${segment}`;

/** The routes taking a method id, which name it "a method id". */
const METHOD_ID_ROUTES: IdRoute[] = [
  ["getMethod", (client, id) => client.getMethod(id), METHOD_URL],
  [
    "writeDraft",
    (client, id) => client.writeDraft(id, { files: null }),
    (segment) => `${METHOD_URL(segment)}/draft`,
  ],
  ["renameMethod", (client, id) => client.renameMethod(id, { name: "n" }), METHOD_URL],
  [
    "publishMethod",
    (client, id) => client.publishMethod(id, { expected_draft_updated_at: "t" }),
    (segment) => `${METHOD_URL(segment)}/publish`,
  ],
  [
    "listMethodVersions",
    (client, id) => client.listMethodVersions(id),
    (segment) => `${METHOD_URL(segment)}/versions`,
  ],
  [
    "getMethodVersion",
    (client, id) => client.getMethodVersion(id, 2),
    (segment) => `${METHOD_URL(segment)}/versions/2`,
  ],
  ["deleteMethod", (client, id) => client.deleteMethod(id), METHOD_URL],
  [
    "createMethodExample",
    (client, id) => client.createMethodExample(id, { name: "n", inputs: {} }),
    (segment) => `${METHOD_URL(segment)}/examples`,
  ],
  [
    "listMethodExamples",
    (client, id) => client.listMethodExamples(id),
    (segment) => `${METHOD_URL(segment)}/examples`,
  ],
  [
    "getMethodExample",
    (client, id) => client.getMethodExample(id, EXAMPLE_ID),
    (segment) => `${METHOD_URL(segment)}/examples/${EXAMPLE_ID}`,
  ],
  [
    "deleteMethodExample",
    (client, id) => client.deleteMethodExample(id, EXAMPLE_ID),
    (segment) => `${METHOD_URL(segment)}/examples/${EXAMPLE_ID}`,
  ],
];

/** The routes taking an example id. */
const EXAMPLE_ID_ROUTES: IdRoute[] = [
  ["getMethodExample", (client, id) => client.getMethodExample(METHOD_ID, id), EXAMPLE_URL],
  [
    "updateMethodExample",
    (client, id) => client.updateMethodExample(METHOD_ID, id, { name: "n" }),
    EXAMPLE_URL,
  ],
  [
    "recordMethodExampleLatestRun",
    (client, id) =>
      client.recordMethodExampleLatestRun(METHOD_ID, id, { run_id: "run_1", input_revision: 1 }),
    (segment) => `${EXAMPLE_URL(segment)}/latest-run`,
  ],
  ["deleteMethodExample", (client, id) => client.deleteMethodExample(METHOD_ID, id), EXAMPLE_URL],
];

/** The routes taking a run, an organization or an API key id. */
const OTHER_ID_ROUTES: [what: string, ...route: IdRoute][] = [
  [
    "a run id",
    "getRunStatus",
    (client, id) => client.getRunStatus(id),
    (segment) => `${BASE_URL}/v1/runs/${segment}/status`,
  ],
  [
    "a run id",
    "getRunResult",
    (client, id) => client.getRunResult(id),
    (segment) => `${BASE_URL}/v1/runs/${segment}/results`,
  ],
  [
    "a run id",
    "getRunDetail",
    (client, id) => client.getRunDetail(id),
    (segment) => `${BASE_URL}/v1/runs/${segment}`,
  ],
  [
    "a run id",
    "updateRun",
    (client, id) => client.updateRun(id, { status: "FAILED" }),
    (segment) => `${BASE_URL}/v1/runs/${segment}`,
  ],
  [
    "an organization id",
    "renameOrganization",
    (client, id) => client.renameOrganization(id, { name: "n" }),
    (segment) => `${BASE_URL}/v1/organizations/${segment}`,
  ],
  [
    "an organization id",
    "updateOrganizationBranding",
    (client, id) => client.updateOrganizationBranding(id, { colors: null }),
    (segment) => `${BASE_URL}/v1/organizations/${segment}/branding`,
  ],
  [
    "an organization id",
    "getWebhookSecret",
    (client, id) => client.getWebhookSecret(id),
    (segment) => `${BASE_URL}/v1/organizations/${segment}/webhook-secret`,
  ],
  [
    "an organization id",
    "rotateWebhookSecret",
    (client, id) => client.rotateWebhookSecret(id),
    (segment) => `${BASE_URL}/v1/organizations/${segment}/webhook-secret/rotate`,
  ],
  [
    "a run id",
    "listRunWebhookDeliveries",
    (client, id) => client.listRunWebhookDeliveries(id),
    (segment) => `${BASE_URL}/v1/runs/${segment}/webhook-deliveries`,
  ],
  [
    "a run id",
    "getRunWebhookDelivery",
    (client, id) => client.getRunWebhookDelivery(id, "whd_1"),
    (segment) => `${BASE_URL}/v1/runs/${segment}/webhook-deliveries/whd_1`,
  ],
  [
    "a delivery id",
    "getRunWebhookDelivery",
    (client, id) => client.getRunWebhookDelivery("run-1", id),
    (segment) => `${BASE_URL}/v1/runs/run-1/webhook-deliveries/${segment}`,
  ],
  [
    "a run id",
    "replayRunWebhookDelivery",
    (client, id) => client.replayRunWebhookDelivery(id, "whd_1"),
    (segment) => `${BASE_URL}/v1/runs/${segment}/webhook-deliveries/whd_1/replay`,
  ],
  [
    "a delivery id",
    "replayRunWebhookDelivery",
    (client, id) => client.replayRunWebhookDelivery("run-1", id),
    (segment) => `${BASE_URL}/v1/runs/run-1/webhook-deliveries/${segment}/replay`,
  ],
  [
    "an API key id",
    "revokePipelexApiKey",
    (client, id) => client.revokePipelexApiKey(id),
    (segment) => `${BASE_URL}/v1/pipelex-api-keys/${segment}`,
  ],
  [
    "an API key id",
    "rotatePipelexApiKey",
    (client, id) => client.rotatePipelexApiKey(id),
    (segment) => `${BASE_URL}/v1/pipelex-api-keys/${segment}/rotate`,
  ],
];

const ROUTES: [what: string, ...route: IdRoute][] = [
  ...METHOD_ID_ROUTES.map((route): [string, ...IdRoute] => ["a method id", ...route]),
  ...EXAMPLE_ID_ROUTES.map((route): [string, ...IdRoute] => ["an example id", ...route]),
  ...OTHER_ID_ROUTES,
];

/** What each refused id reads as in the refusal. */
const REFUSED: [id: string, got: string][] = [
  ["", "an empty string"],
  [".", `".", a dot segment, which the URL would resolve into another route's path`],
  ["..", `"..", a dot segment, which the URL would resolve into another route's path`],
  // A lone surrogate has no UTF-8 spelling, so `encodeURIComponent` throws a `URIError` for it.
  ["ex_\uD800", "a string holding a lone surrogate, which a URL cannot carry"],
  ["\uDC00ex", "a string holding a lone surrogate, which a URL cannot carry"],
];

/**
 * Ids that look like a dot segment or a path but are none once encoded: each must reach its
 * route as one segment.
 */
const KEPT: string[] = ["...", ".x", "x.", "%2e%2e", ".%2E", "a/..", "a\\b", "?q", "#f"];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a dot segment left in a path", () => {
  it("is resolved by the URL fetch sends, onto another route", () => {
    // The premise of the guard: an example id `..` would DELETE the method itself, and an
    // empty run id would read the runs list.
    expect(new Request(EXAMPLE_URL("..")).url).toBe(`${BASE_URL}/v1/methods/${METHOD_ID}/`);
    expect(new Request(EXAMPLE_URL(".")).url).toBe(`${BASE_URL}/v1/methods/${METHOD_ID}/examples/`);
  });
});

describe.each(ROUTES)("%s given to %s", (what, name, call, url) => {
  it.each(REFUSED)("refuses %j before sending anything", async (id, got) => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(refusal()));

    const err = await call(makeClient(), id).catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message).toMatch(new RegExp(`^${name}\\(\\) takes ${what}, `));
    expect((err as Error).message.endsWith(`; got ${got}.`)).toBe(true);
    expect((err as ProblemError).problem).toMatchObject({ domain: "input", retry: "no" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a string before sending anything", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(refusal()));

    const err = await call(makeClient(), undefined as unknown as string).catch(
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(RequestArgumentError);
    expect((err as Error).message.endsWith("; got undefined.")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(KEPT)("keeps %j in its own segment once the URL is resolved", async (id) => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(refusal()));

    await call(makeClient(), id).catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
    const [sent] = spy.mock.calls[0] as [string, RequestInit];
    expect(new Request(sent).url).toBe(url(encodeURIComponent(id)));
  });
});
