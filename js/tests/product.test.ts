import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import {
  ApiResponseError,
  PagingNotTerminatingError,
  RequestArgumentError,
} from "../src/errors.js";
import type { RunErrorReport } from "../src/error-models.js";
import type {
  Membership,
  MethodSummary,
  MethodVersionSummary,
  OrgRole,
  PipelineRun,
  RunHistoryItem,
  RunPage,
} from "../src/product-models.js";
import type { RunStatus } from "../src/runs.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/** The URL + parsed init of the single fetch call recorded by the spy. */
function lastRequest(spy: ReturnType<typeof vi.spyOn>): {
  url: string;
  method: string;
  body: unknown;
} {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: String(init.method),
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("user profile", () => {
  it("GETs /v1/me and returns the profile", async () => {
    const client = makeClient();
    const profile = {
      email: "a@b.com",
      user_id: "u1",
      full_name: "A B",
      onboarding_completed_at: null,
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, profile));

    const result = await client.getMe();

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/me");
    expect(req.method).toBe("GET");
    expect(result).toEqual(profile);
  });
});

describe("methods catalog", () => {
  it("GETs /v1/methods and maps the page envelope", async () => {
    const client = makeClient();
    const items = [{ method_id: "m1", name: "M", description: null, created_at: "t" }];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items, next_cursor: "c1" }));

    const result = await client.listMethods();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/methods");
    // snake_case on the wire -> camelCase on the surface, same as listRuns.
    expect(result).toEqual({ items, nextCursor: "c1" });
  });

  it("forwards q / limit / cursor as query params", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({ q: "invoice", limit: 10, cursor: "abc" });

    const url = new URL(lastRequest(spy).url);
    expect(url.pathname).toBe("/v1/methods");
    expect(url.searchParams.get("q")).toBe("invoice");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("abc");
  });

  it("sends a bare /v1/methods when no query is given", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({});

    // No trailing "?" — the URL must stay identical to the no-arg call.
    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/methods");
  });

  it("forwards an explicit empty q rather than dropping it", async () => {
    // Omission means "did not ask"; an explicit "" is bad input the API should
    // reject. Dropping it would turn a broken search into a silently UNFILTERED
    // query returning the whole catalog, which reads as working.
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({ q: "" });

    expect(new URL(lastRequest(spy).url).searchParams.has("q")).toBe(true);
  });

  it.each([
    [true, "published=true"],
    [false, "published=false"],
  ])("forwards published: %s as %s, beside q", async (published, expected) => {
    // `false` is a filter of its own (the methods never published), never omission.
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({ q: "invoice", published, limit: 10 });

    expect(lastRequest(spy).url).toBe(
      `http://localhost:8081/v1/methods?q=invoice&${expected}&limit=10`,
    );
  });

  it("omits published entirely when unset", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listMethods({ q: "invoice" });

    expect(new URL(lastRequest(spy).url).searchParams.has("published")).toBe(false);
  });

  it("types the publish state on a row as optional and nullable", () => {
    expectTypeOf<MethodSummary["latest_version"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<MethodSummary["latest_published"]>().toEqualTypeOf<
      MethodVersionSummary | null | undefined
    >();
    expectTypeOf<MethodSummary["draft_digest"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("hands back each row's publish state as the platform serves it", async () => {
    // Three rows, the three states a list tells apart from the row alone: never published,
    // published with an empty draft (`draft_digest: null`), and published with the draft ahead.
    const latestPublished: MethodVersionSummary = {
      version: 3,
      tree_digest: `sha256:${"a".repeat(64)}`,
      crate_fingerprint: null,
      runner_version: "0.73.0",
      description: "Reads invoices",
      published_at: "2026-10-12T09:00:00Z",
      published_by: "user_1",
    };
    const neverPublished: MethodSummary = {
      method_id: "m1",
      name: "Draft only",
      description: null,
      created_at: "2026-10-12T10:00:00Z",
      deletion_state: null,
      latest_version: null,
      latest_published: null,
      draft_digest: `sha256:${"b".repeat(64)}`,
    };
    const emptyDraft: MethodSummary = {
      method_id: "m2",
      name: "Published long ago",
      description: "Reads invoices",
      created_at: "2026-10-11T10:00:00Z",
      deletion_state: null,
      latest_version: 3,
      latest_published: latestPublished,
      draft_digest: null,
    };
    const draftAhead: MethodSummary = {
      ...emptyDraft,
      method_id: "m3",
      draft_digest: `sha256:${"c".repeat(64)}`,
    };
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [neverPublished, emptyDraft, draftAhead], next_cursor: null }),
    );

    const page = await client.listMethods({ published: true });

    expect(page.items).toEqual([neverPublished, emptyDraft, draftAhead]);
    expect(page.items[0]!.latest_version).toBeNull();
    expect(page.items[1]!.latest_published?.version).toBe(3);
    expect(page.items[1]!.draft_digest).toBeNull();
    expect(page.items[2]!.draft_digest).not.toBe(page.items[2]!.latest_published?.tree_digest);
  });

  it("hands back a row from a platform that serves no publish state, the fields absent", async () => {
    const client = makeClient();
    const row = { method_id: "m1", name: "M", description: null, created_at: "t" };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [row], next_cursor: null }),
    );

    const page = await client.listMethods();

    expect(page.items[0]).toEqual(row);
    expect(page.items[0]!.latest_version).toBeUndefined();
  });

  it("iterateMethods follows the cursor across pages", async () => {
    const client = makeClient();
    const page1 = { items: [{ method_id: "m1", name: "A", created_at: "t" }], next_cursor: "c1" };
    const page2 = { items: [{ method_id: "m2", name: "B", created_at: "t" }], next_cursor: null };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, page1))
      .mockResolvedValueOnce(jsonResponse(200, page2));

    const seen: string[] = [];
    for await (const method of client.iterateMethods()) seen.push(method.method_id);

    expect(seen).toEqual(["m1", "m2"]);
  });

  it("iterateMethods follows a cursor past an EMPTY page", async () => {
    // A filtered page can legitimately be empty WITH a continuation cursor:
    // the platform applies `q` as a post-read filter and walks a bounded
    // number of index pages per request, so a sparse match returns
    // `{items: [], next_cursor: "..."}` meaning "nothing here yet, keep going".
    // Stopping on the empty page silently drops every later match — the exact
    // truncation this pagination work exists to remove.
    const client = makeClient();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c1" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c2" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          items: [{ method_id: "m1", name: "Needle", created_at: "t" }],
          next_cursor: null,
        }),
      );

    const seen: string[] = [];
    for await (const method of client.iterateMethods({ q: "needle" })) seen.push(method.method_id);

    expect(seen).toEqual(["m1"]);
  });

  it("iterateMethods sends published on every page it follows", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          items: [{ method_id: "m1", name: "A", created_at: "t", latest_version: 1 }],
          next_cursor: null,
        }),
      );

    const seen: string[] = [];
    for await (const method of client.iterateMethods({ published: false })) {
      seen.push(method.method_id);
    }

    expect(seen).toEqual(["m1"]);
    const urls = spy.mock.calls.map((call) => new URL((call as [string, RequestInit])[0]));
    expect(urls.map((url) => url.searchParams.get("published"))).toEqual(["false", "false"]);
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "c1"]);
  });

  it("iterateMethods refuses to page forever against a server that never finishes", async () => {
    // A pure runaway guard, unreachable on real data. It must NOT silently
    // truncate: a caller that asked for every method and got a partial answer
    // with no error would be back to the original bug, one layer up. Note it
    // counts TOTAL pages, not empty ones — an empty page whose cursor advanced
    // is real progress and must never trip a limit (see the test above).
    const client = makeClient();
    // A genuinely FRESH cursor every time — a repeating one would trip the
    // no-progress guard instead, which is a different code path.
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      n += 1;
      return Promise.resolve(jsonResponse(200, { items: [], next_cursor: `c${n}` }));
    });

    const err = await (async () => {
      for await (const _ of client.iterateMethods()) {
        // no-op
      }
    })().then(
      () => expect.fail("expected iterateMethods to throw"),
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(PagingNotTerminatingError);
    const paging = err as PagingNotTerminatingError;
    expect(paging.message).toMatch(/did not terminate/i);
    expect(paging.pageLimit).toBe(10_000);
    // A server minting cursors forever is its own fault, and asking again meets it again.
    expect(paging.errorDomain).toBe("runtime");
    expect(paging.retryable).toBe(false);
  });

  it("iterateMethods stops when the server stops advancing the cursor", async () => {
    // A server repeating our own cursor has not advanced; yielding first and
    // stopping after would double-count rows for anyone aggregating the stream.
    const client = makeClient();
    const stuck = { items: [{ method_id: "m1", name: "A", created_at: "t" }], next_cursor: "c1" };
    // A fresh Response per call: a single mocked Response body can only be
    // read once, and the guard necessarily makes a SECOND request — detecting
    // a repeated cursor is what that request is for.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(jsonResponse(200, stuck)),
    );

    const seen: string[] = [];
    for await (const method of client.iterateMethods()) seen.push(method.method_id);

    expect(seen).toEqual(["m1"]);
  });

  it("GETs /v1/methods/{id} with an encoded id", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { method_id: "a/b", files: [] }));

    await client.getMethod("a/b");

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/methods/a%2Fb");
  });

  it("POSTs /v1/methods with the write body", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { method_id: "m1" }));

    await client.createMethod({
      name: "M",
      files: { "main.mthds": "src" },
      input_data: { a: 1 },
    });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/methods");
    expect(req.body).toEqual({ name: "M", files: { "main.mthds": "src" }, input_data: { a: 1 } });
  });

  it("DELETEs /v1/methods/{id} and returns the 202 acceptance, not void", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(202, {
        method_id: "m1",
        deletion_state: "pending",
        deletion_job_id: "job-1",
      }),
    );

    const accepted = await client.deleteMethod("m/1");

    const req = lastRequest(spy);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("http://localhost:8081/v1/methods/m%2F1");
    // The erasure is asynchronous: the caller gets the claim (a job id it can
    // log or correlate), never a "it's gone" signal — completion is the row
    // disappearing from listMethods.
    expect(accepted).toEqual({
      method_id: "m1",
      deletion_state: "pending",
      deletion_job_id: "job-1",
    });
  });

  it("surfaces a second delete of the same method as the platform's 409 conflict", async () => {
    const client = makeClient();
    // The claim is a conditional write, so a double-clicked delete cannot
    // enqueue two cascades over the same runs — the second call errors. Both
    // calls have to go out for that to mean anything: the client holds no
    // memory of an accepted deletion, so it is the platform that refuses the
    // second one.
    const accepted = {
      method_id: "m1",
      deletion_state: "pending",
      deletion_job_id: "job-1",
    };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(202, accepted))
      .mockResolvedValueOnce(
        jsonResponse(409, { code: "conflict", detail: "deletion already pending" }),
      );

    await expect(client.deleteMethod("m1")).resolves.toEqual(accepted);
    const err = await client.deleteMethod("m1").catch((caught: unknown) => caught);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).status).toBe(409);
  });

  it("POSTs /v1/methods with no tree, creating an empty draft", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { method_id: "m1" }));

    await client.createMethod({ name: "M" });

    // No `files` key at all: the platform creates the method with an empty draft.
    expect(lastRequest(spy).body).toEqual({ name: "M" });
  });

  it("the draft write sends the whole tree, and files: null empties it", async () => {
    const client = makeClient();
    // A fresh Response per call — the client reads the body, single-read across calls.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, { method_id: "m1" })));

    await client.writeDraft("m1", { files: { "main.mthds": "src", "helper.py": "x = 1\n" } });
    expect(lastRequest(spy).body).toEqual({
      files: { "main.mthds": "src", "helper.py": "x = 1\n" },
    });

    spy.mockClear();
    await client.writeDraft("m1", { files: null });
    expect(lastRequest(spy).body).toEqual({ files: null });
  });
});

describe("organizations", () => {
  it("GETs /v1/organizations/memberships", async () => {
    const client = makeClient();
    const body = { memberships: [], active_org_feature_flags: ["flag"] };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const result = await client.listMemberships();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/organizations/memberships");
    expect(result).toEqual(body);
  });

  it("POSTs /v1/organizations to create", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { org_id: "o1" }));

    await client.createOrganization({ name: "Acme" });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/organizations");
    expect(req.body).toEqual({ name: "Acme" });
  });

  it("PATCHes /v1/organizations/{id} to rename", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { org_id: "o1" }));

    await client.renameOrganization("o1", { name: "Beta" });

    const req = lastRequest(spy);
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("http://localhost:8081/v1/organizations/o1");
    expect(req.body).toEqual({ name: "Beta" });
  });

  it("types a membership's role as an OrgRole, read open", () => {
    expectTypeOf<OrgRole>().toEqualTypeOf<"admin" | "member" | "runner">();
    expectTypeOf<Membership["role_in_org"]>().toEqualTypeOf<OrgRole | (string & {})>();
  });

  it("reads a runner membership beside the other roles", async () => {
    const client = makeClient();
    const membership = (orgId: string, role: string): Membership => ({
      org_id: orgId,
      workos_organization_id: `wo-${orgId}`,
      name: orgId,
      is_personal: false,
      role_in_org: role,
    });
    const body = {
      memberships: [
        membership("o1", "admin"),
        membership("o2", "member"),
        membership("o3", "runner"),
      ],
      active_org_feature_flags: [],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const result = await client.listMemberships();

    expect(result.memberships.map((row) => row.role_in_org)).toEqual(["admin", "member", "runner"]);
  });

  it("relays a role this SDK does not know as its raw string, and reads the rest", async () => {
    const client = makeClient();
    const body = {
      memberships: [
        {
          org_id: "o1",
          workos_organization_id: "wo1",
          name: "Acme",
          is_personal: false,
          role_in_org: "runner",
        },
        {
          org_id: "o2",
          workos_organization_id: "wo2",
          name: "Beta",
          is_personal: false,
          role_in_org: "auditor",
        },
      ],
      active_org_feature_flags: ["flag"],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const result = await client.listMemberships();

    expect(result).toEqual(body);
    expect(result.memberships[1]?.role_in_org).toBe("auditor");
  });

  it.each(["runner", "auditor"])(
    "hands back the %s role of an organization it creates or renames",
    async (role) => {
      const client = makeClient();
      const body = {
        org_id: "o1",
        workos_organization_id: "wo1",
        name: "Acme",
        is_personal: false,
        role_in_org: role,
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(200, body));

      const created = await client.createOrganization({ name: "Acme" });
      const renamed = await client.renameOrganization("o1", { name: "Acme" });

      expect(created.role_in_org).toBe(role);
      expect(renamed.role_in_org).toBe(role);
    },
  );
});

describe("billing", () => {
  it("GETs /v1/billing/subscription", async () => {
    const client = makeClient();
    const sub = { plan: "pro", status: "active", can_use_service: true };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, sub));

    const result = await client.getSubscription();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/billing/subscription");
    expect(result).toEqual(sub);
  });

  it("GETs /v1/billing/plans and /v1/billing/invoices", async () => {
    const client = makeClient();
    // A fresh Response per call — a body is single-read across the two requests.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(200, [])));

    await client.listPlans();
    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/billing/plans");

    spy.mockClear();
    await client.listInvoices();
    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/billing/invoices");
  });

  it("POSTs /v1/billing/checkout with the plan", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { checkout_url: "https://stripe" }));

    const result = await client.createCheckout({ plan: "pro" });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/billing/checkout");
    expect(req.body).toEqual({ plan: "pro" });
    expect(result.checkout_url).toBe("https://stripe");
  });

  it("surfaces a 409 conflict on change-plan via ApiResponseError.code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, { code: "conflict", message: "No subscription to change." }),
    );

    const err = await client.changePlan({ plan: "pro" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiResponseError);
    const e = err as ApiResponseError;
    expect(e.status).toBe(409);
    expect(e.code).toBe("conflict");
    expect(e.serverMessage).toBe("No subscription to change.");
  });

  it("surfaces a 409 conflict on the billing portal", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(409, { code: "conflict" }));

    const err = await client.getBillingPortal().catch((e: unknown) => e);

    expect((err as ApiResponseError).code).toBe("conflict");
  });
});

describe("pipelex api keys", () => {
  it("GETs /v1/pipelex-api-keys (list)", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { keys: [] }));

    const result = await client.listPipelexApiKeys();

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/pipelex-api-keys");
    expect(result).toEqual({ keys: [] });
  });

  it("POSTs /v1/pipelex-api-keys and returns the once-only plaintext", async () => {
    const client = makeClient();
    const created = {
      api_key: "plx_sk_secret",
      id: "k1",
      label: "L",
      prefix: "plx_sk",
      created_at: "t",
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(201, created));

    const result = await client.createPipelexApiKey({ label: "L" });

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ label: "L" });
    expect(result.api_key).toBe("plx_sk_secret");
  });

  it("surfaces a 409 pipelex_api_key_limit_reached via ApiResponseError.code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(409, { code: "pipelex_api_key_limit_reached", message: "Limit reached." }),
    );

    const err = await client.createPipelexApiKey({ label: "L" }).catch((e: unknown) => e);

    expect((err as ApiResponseError).code).toBe("pipelex_api_key_limit_reached");
  });

  it("DELETEs /v1/pipelex-api-keys/{id} with an encoded id", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(204));

    await client.revokePipelexApiKey("a/b");

    const req = lastRequest(spy);
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("http://localhost:8081/v1/pipelex-api-keys/a%2Fb");
  });

  it("POSTs /v1/pipelex-api-keys/{id}/rotate with no body", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { api_key: "plx_sk_new", id: "k1" }));

    await client.rotatePipelexApiKey("k1");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8081/v1/pipelex-api-keys/k1/rotate");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });
});

describe("onboarding", () => {
  it("POSTs /v1/onboarding/submit and tolerates an empty 2xx body", async () => {
    const client = makeClient();
    const submission = {
      role: "developer" as const,
      use_case: "automate document review for the team",
      process_to_transform: "manual review",
      input_types: ["documents" as const],
      material_domain: "legal",
      current_tool: "none" as const,
      heard_from: "twitter" as const,
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(204));

    await expect(client.submitOnboarding(submission)).resolves.toBeUndefined();

    const req = lastRequest(spy);
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:8081/v1/onboarding/submit");
    expect(req.body).toEqual(submission);
  });
});

describe("storage", () => {
  it("POSTs /v1/resolve-storage-url", async () => {
    const client = makeClient();
    const resolved = { url: "https://s3", expires_at: "t", content_type: "application/pdf" };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, resolved));

    const result = await client.resolveStorageUrl({ uri: "s3://bucket/key" });

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/resolve-storage-url");
    expect(req.body).toEqual({ uri: "s3://bucket/key" });
    expect(result).toEqual(resolved);
  });

  it("POSTs /v1/resolve-storage-url/bulk with the list", async () => {
    const client = makeClient();
    const items = [
      {
        uri: "pipelex-storage://o/a.png",
        url: "https://s3/a",
        expires_at: "t",
        content_type: "image/png",
        error: null,
      },
      {
        uri: "pipelex-storage://x/b",
        url: null,
        expires_at: null,
        content_type: null,
        error: { code: "forbidden", detail: "another org" },
      },
    ];
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items }));
    const signal = new AbortController().signal;

    const result = await client.resolveStorageUrls(
      { uris: ["pipelex-storage://o/a.png", "pipelex-storage://x/b"] },
      { signal },
    );

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/resolve-storage-url/bulk");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ uris: ["pipelex-storage://o/a.png", "pipelex-storage://x/b"] });
    expect(result).toEqual({ items });
  });

  it("forwards the caller's signal to the bulk resolve request", async () => {
    const client = makeClient();
    const controller = new AbortController();
    let forwarded: boolean | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      controller.abort();
      forwarded = init?.signal?.aborted;
      return jsonResponse(200, { items: [] });
    });

    await client
      .resolveStorageUrls({ uris: [] }, { signal: controller.signal })
      .catch(() => undefined);

    expect(forwarded).toBe(true);
  });

  it("resolveArtifacts rides the bulk route through the client", async () => {
    const client = makeClient();
    const items = [
      {
        uri: "pipelex-storage://o/a.png",
        url: "https://s3/a",
        expires_at: "t",
        content_type: "image/png",
        error: null,
      },
    ];
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { items }));

    const resolved = await client.resolveArtifacts(["pipelex-storage://o/a.png"]);

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/resolve-storage-url/bulk");
    expect(resolved).toEqual(items);
  });

  it("POSTs /v1/upload with the base64 payload", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { uri: "s3://x", filename: "f.pdf" }));

    const result = await client.upload({
      filename: "f.pdf",
      data: "Zm9v",
      content_type: "application/pdf",
    });

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/upload");
    expect(req.body).toEqual({ filename: "f.pdf", data: "Zm9v", content_type: "application/pdf" });
    expect(result.uri).toBe("s3://x");
  });

  it("POSTs /v1/upload/grant with the file's description and returns the grant as sent", async () => {
    const client = makeClient();
    const grant = {
      uri: "pipelex-storage://org_1/assets/5f0c.pdf",
      url: "https://pipelex-app-dev.s3.amazonaws.com/org_1/assets/5f0c.pdf?X-Amz-Signature=abc",
      headers: { "If-None-Match": "*", "Content-Type": "application/pdf" },
      expires_at: "2026-09-23T10:05:00Z",
      max_bytes: 52428800,
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, grant));

    const result = await client.requestUploadGrant({
      filename: "report.pdf",
      content_type: "application/pdf",
      size: 5,
    });

    const req = lastRequest(spy);
    expect(req.url).toBe("http://localhost:8081/v1/upload/grant");
    expect(req.method).toBe("POST");
    expect(req.body).toEqual({ filename: "report.pdf", content_type: "application/pdf", size: 5 });
    expect(result).toEqual(grant);
  });

  it("forwards the caller's signal to the grant request", async () => {
    const client = makeClient();
    const controller = new AbortController();
    let forwarded: boolean | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      controller.abort();
      forwarded = init?.signal?.aborted;
      return jsonResponse(200, {});
    });

    await client
      .requestUploadGrant({ filename: "a.pdf", size: 1 }, { signal: controller.signal })
      .catch(() => undefined);

    expect(forwarded).toBe(true);
  });

  it("surfaces an oversized declaration as a 413 ApiResponseError with its code", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(413, {
        type: "about:blank",
        title: "Payload too large",
        status: 413,
        detail: "Declared file size exceeds the 50 MiB limit.",
        code: "payload_too_large",
      }),
    );

    const error = await client
      .requestUploadGrant({ filename: "big.pdf", size: 52428801 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).status).toBe(413);
    expect((error as ApiResponseError).code).toBe("payload_too_large");
  });
});

describe("runs list / update", () => {
  // The slim history row the platform sends: no org, creator, method, workflow or result url.
  const RUN_ROW: RunHistoryItem = {
    pipeline_run_id: "r1",
    status: "RUNNING",
    created_at: "2026-10-01T09:00:00Z",
    finished_at: null,
    pipe_code: "p",
    error: null,
  };

  it("types a page item as the slim history row, not the whole run record", () => {
    expectTypeOf<RunHistoryItem>().toEqualTypeOf<{
      pipeline_run_id: string;
      status: RunStatus;
      created_at: string;
      finished_at?: string | null;
      pipe_code?: string | null;
      error?: RunErrorReport | null;
      method_version?: number | "draft" | null;
      source_digest?: string | null;
    }>();
    expectTypeOf<RunPage["items"]>().toEqualTypeOf<RunHistoryItem[]>();
    // The record the detail read returns keeps the fields the list no longer sends.
    expectTypeOf<PipelineRun>().toHaveProperty("org_id");
    expectTypeOf<PipelineRun>().toHaveProperty("method_id");
  });

  it("hands back a failed row's error report as it arrives", async () => {
    const client = makeClient();
    const failed: RunHistoryItem = {
      pipeline_run_id: "r9",
      status: "FAILED",
      created_at: "2026-10-01T09:00:00Z",
      finished_at: "2026-10-01T09:01:00Z",
      pipe_code: null,
      error: { error_type: "PipeRunError", message: "the model refused" },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { items: [failed], next_cursor: null }),
    );

    const page = await client.listRuns("m1");

    expect(page.items).toEqual([failed]);
    expect(page.items[0]!.error?.message).toBe("the model refused");
  });

  it("GETs /v1/runs?method_id={id} with an encoded query value and unwraps the page", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [RUN_ROW], next_cursor: "nxt" }));

    const result = await client.listRuns("m/1");

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/runs?method_id=m%2F1");
    expect(result.items).toEqual([RUN_ROW]);
    // snake_case on the wire, camelCase in the SDK surface.
    expect(result.nextCursor).toBe("nxt");
  });

  it("forwards the instant bounds and paging params", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listRuns("m1", {
      createdFrom: "2026-06-02T00:00:00+09:00",
      createdTo: "2026-06-02T23:59:59+09:00",
      limit: 10,
      cursor: "abc",
    });

    const url = new URL(lastRequest(spy).url);
    // These are server-side index KEY CONDITIONS; dropping them turns a bounded
    // page back into "read everything".
    expect(url.searchParams.get("created_from")).toBe("2026-06-02T00:00:00+09:00");
    expect(url.searchParams.get("created_to")).toBe("2026-06-02T23:59:59+09:00");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("cursor")).toBe("abc");
  });

  it("forwards an EXPLICIT empty instant instead of silently dropping the filter", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listRuns("m1", { createdFrom: "" });

    // Dropping it would turn a broken date into an UNFILTERED query that
    // returns every run and looks like it worked. Forwarded, it reaches the
    // API's instant parse and comes back a 400 saying what is wrong.
    const url = new URL(lastRequest(spy).url);
    expect(url.searchParams.has("created_from")).toBe(true);
    expect(url.searchParams.get("created_from")).toBe("");
  });

  it("omits optional params entirely when unset", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listRuns("m1");

    const url = new URL(lastRequest(spy).url);
    // An empty `created_from=` is a 400 from the API's instant parse.
    expect(url.searchParams.has("created_from")).toBe(false);
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("created_by")).toBe(false);
    expect(url.searchParams.has("status")).toBe(false);
  });

  it("sends createdBy as created_by=me and each status as a repeated status parameter", async () => {
    // The method screen's read: the caller's own latest unfinished run.
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [RUN_ROW], next_cursor: null }));

    await client.listRuns("m1", {
      createdBy: "me",
      status: ["PENDING", "STARTED", "RUNNING"],
      limit: 1,
    });

    expect(lastRequest(spy).url).toBe(
      "http://localhost:8081/v1/runs?method_id=m1&created_by=me" +
        "&status=PENDING&status=STARTED&status=RUNNING&limit=1",
    );
  });

  it("sends the statuses deduplicated, in the platform's order, as the Python twin does", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { items: [], next_cursor: null }));

    await client.listRuns("m1", { status: ["FAILED", "PENDING", "FAILED"] });

    const url = new URL(lastRequest(spy).url);
    expect(url.searchParams.getAll("status")).toEqual(["PENDING", "FAILED"]);
  });

  it("refuses an empty status list before any request, rather than list every status", async () => {
    // No `status=` parameter at all means "every status": sending an empty filter that way
    // would answer a different question than the one asked, and read as working.
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    await expect(client.listRuns("m1", { status: [] })).rejects.toBeInstanceOf(
      RequestArgumentError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a status that is no RunStatus before any request", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch");

    const error = await client.listRuns("m1", { status: ["RUNNING", "running" as RunStatus] }).then(
      () => expect.fail("expected listRuns to throw"),
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(RequestArgumentError);
    expect((error as RequestArgumentError).message).toContain("running");
    expect(spy).not.toHaveBeenCalled();
  });

  it("iterateRuns follows the cursor to exhaustion", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [RUN_ROW], next_cursor: "c1" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [{ ...RUN_ROW, pipeline_run_id: "r2" }], next_cursor: null }),
      );

    const seen: string[] = [];
    for await (const run of client.iterateRuns("m1")) seen.push(run.pipeline_run_id);

    expect(seen).toEqual(["r1", "r2"]);
    expect(spy).toHaveBeenCalledTimes(2);
    // Index the SECOND call explicitly — `lastRequest` reads `calls[0]`.
    const secondUrl = new URL((spy.mock.calls[1] as [string, RequestInit])[0]);
    expect(secondUrl.searchParams.get("cursor")).toBe("c1");
  });

  it("iterateRuns fetches lazily — breaking early stops the requests", async () => {
    const client = makeClient();
    // The property an all-at-once helper cannot have: the caller decides when
    // to stop, so a search that finds its run on page one never pays for page
    // two. A fresh Response per call — a body can only be consumed once.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [RUN_ROW], next_cursor: "more" })),
      );

    for await (const run of client.iterateRuns("m1")) {
      expect(run.pipeline_run_id).toBe("r1");
      break;
    }

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("iterateRuns terminates on a cursor that never advances", async () => {
    const client = makeClient();
    // The other misbehaving shape: NON-empty pages whose cursor is echoed back
    // unchanged. The empty-page guard does not catch this one, so a caller
    // draining to completion would yield the same page forever. Stopping on a
    // repeated cursor cannot truncate a healthy stream — a real cursor encodes
    // the last row read, so it always moves.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(jsonResponse(200, { items: [RUN_ROW], next_cursor: "stuck" })),
      );

    const seen: string[] = [];
    for await (const run of client.iterateRuns("m1")) seen.push(run.pipeline_run_id);

    // Each run is yielded EXACTLY ONCE. The repeat is caught before the second
    // page is emitted, not after — otherwise a caller aggregating the stream
    // (summing cost, counting runs) would double-count the rows it already saw.
    expect(seen).toEqual(["r1"]);
    // The second request still happens: a repeat is only detectable from the
    // response to it.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("iterateRuns follows a cursor past an EMPTY page, sending the filters on every page", async () => {
    // `createdBy` and `status` filter after the index read, so a page can hold no run and still
    // carry a cursor: "nothing matched in the slice just read, keep going". Stopping there
    // would drop every later match, the caller's unfinished run among them.
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c1" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [], next_cursor: "c2" }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [RUN_ROW], next_cursor: null }));

    const seen: string[] = [];
    for await (const run of client.iterateRuns("m1", { createdBy: "me", status: ["RUNNING"] })) {
      seen.push(run.pipeline_run_id);
    }

    expect(seen).toEqual(["r1"]);
    const urls = spy.mock.calls.map((call) => new URL((call as [string, RequestInit])[0]));
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
    for (const url of urls) {
      expect(url.searchParams.get("created_by")).toBe("me");
      expect(url.searchParams.getAll("status")).toEqual(["RUNNING"]);
    }
  });

  it("iterateRuns refuses to page forever against a server that never finishes", async () => {
    // Empty pages with a FRESH cursor each time: neither the null cursor nor the repeated one
    // ends this, so the page ceiling must, and it throws rather than return a truncated stream.
    const client = makeClient();
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      n += 1;
      return Promise.resolve(jsonResponse(200, { items: [], next_cursor: `c${n}` }));
    });

    const err = await (async () => {
      for await (const _ of client.iterateRuns("m1")) {
        // no-op
      }
    })().then(
      () => expect.fail("expected iterateRuns to throw"),
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(PagingNotTerminatingError);
    expect((err as PagingNotTerminatingError).message).toMatch(/listRuns did not terminate/);
    expect((err as PagingNotTerminatingError).pageLimit).toBe(10_000);
  });

  it("GETs /v1/runs/{id} for the whole record, bundle included", async () => {
    const client = makeClient();
    const detail = {
      ...RUN_ROW,
      mthds_contents: ['domain = "x"'],
      inputs: { name: "Ada" },
      request_id: "req_r1",
    };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, detail));

    const result = await client.getRunDetail("r1");

    expect(lastRequest(spy).url).toBe("http://localhost:8081/v1/runs/r1");
    expect(result.mthds_contents).toEqual(['domain = "x"']);
    expect(result.request_id).toBe("req_r1");
  });

  it("PUTs /v1/runs/{id} and tolerates an empty body", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(emptyResponse(204));

    await expect(
      client.updateRun("r1", { status: "COMPLETED", result_url: "https://x" }),
    ).resolves.toBeUndefined();

    const req = lastRequest(spy);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("http://localhost:8081/v1/runs/r1");
    expect(req.body).toEqual({ status: "COMPLETED", result_url: "https://x" });
  });
});

describe("a page the SDK cannot read", () => {
  const ITEMS_NOT_AN_ARRAY = "a page whose `items` is not an array";
  const NO_CURSOR = "a page whose `next_cursor` is neither a string nor null";
  const ROW = { method_id: "m1", pipeline_run_id: "r1", name: "A", created_at: "t" };
  const MALFORMED_PAGES: [string, unknown, string][] = [
    ["no items", { next_cursor: null }, ITEMS_NOT_AN_ARRAY],
    ["null items", { items: null, next_cursor: null }, ITEMS_NOT_AN_ARRAY],
    ["items that are an object", { items: {}, next_cursor: null }, ITEMS_NOT_AN_ARRAY],
    ["no next_cursor", { items: [ROW] }, NO_CURSOR],
    ["a numeric next_cursor", { items: [ROW], next_cursor: 42 }, NO_CURSOR],
  ];
  /** Every row an iterator yields, so a case reads its whole stream as a list call reads a page. */
  async function drain<T>(rows: AsyncIterable<T>): Promise<T[]> {
    const seen: T[] = [];
    for await (const row of rows) seen.push(row);
    return seen;
  }
  const ROUTES: [string, (client: PipelexApiClient) => Promise<unknown>, string][] = [
    ["listMethods", (client) => client.listMethods(), "/v1/methods"],
    ["iterateMethods", (client) => drain(client.iterateMethods()), "/v1/methods"],
    ["listRuns", (client) => client.listRuns("m1"), "/v1/runs?method_id=m1"],
    ["iterateRuns", (client) => drain(client.iterateRuns("m1")), "/v1/runs?method_id=m1"],
    ["listFiles", (client) => client.listFiles(), "/v1/files"],
    ["iterateFiles", (client) => drain(client.iterateFiles()), "/v1/files"],
  ];
  const CASES = ROUTES.flatMap(([name, call, path]) =>
    MALFORMED_PAGES.map(([shape, page, what]) => [name, shape, call, path, page, what] as const),
  );

  it.each(CASES)(
    "%s throws a typed ApiResponseError on a page with %s, after one request",
    async (_, __, call, path, page, what) => {
      const client = makeClient();
      // A fresh Response per call, so a loop that kept paging would show in the call count
      // rather than fail on a body already read.
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(() =>
          Promise.resolve(jsonResponse(200, page, { "X-Request-ID": "req-p" })),
        );

      const err = await call(client).then(
        () => expect.fail("expected the read to throw"),
        (thrown: unknown) => thrown,
      );

      expect(err).toBeInstanceOf(ApiResponseError);
      const unreadable = err as ApiResponseError;
      expect(unreadable.message).toBe(`API GET ${path} answered 200 with ${what}`);
      expect(unreadable.status).toBe(200);
      expect(unreadable.responseBody).toBe(JSON.stringify(page));
      expect(unreadable.requestId).toBe("req-p");
      // A page the platform never serializes: runtime, and nothing says a retry helps.
      expect(unreadable.errorDomain).toBe("runtime");
      expect(unreadable.retryable).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );
});

describe("product transport", () => {
  it("attaches the bearer token to product requests", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, {}));

    await client.getMe();

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });
});
