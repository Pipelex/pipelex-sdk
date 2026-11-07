/**
 * Public methods and the template catalog: `listMethodTemplates` and its iterator, another
 * organization's public method read in its narrower shape, a version read without its publisher,
 * the visibility and categories a method carries, a copy naming the version it took, and the
 * refusals of a public method's publish — all against a mocked fetch.
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";
import { problemResponse } from "./helpers/problems.js";
import type {
  MethodCopiedFrom,
  MethodData,
  MethodDetail,
  MethodPublishRefusalReason,
  MethodPublishRefused,
  MethodTemplatePage,
  MethodVersionSummary,
  PublicMethodDetail,
  SavedMethodFile,
} from "../src/product-models.js";

const BASE_URL = "http://localhost:8081";
const DIGEST = "sha256:5f8e2c9a41d07b3e6c1a9f20d4b8e7c35a6d1f0e9b2c4a7d8e3f1b0c6a9d2e47";
const SIGNED = "X-Amz-Signature=deadbeef";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The URL of each fetch call the spy recorded, in order. */
function requestedUrls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0]));
}

const THUMBNAIL = {
  path: "thumbnails/card.png",
  media_type: "image/png",
  width: 1600,
  height: 800,
  sha256: "8ff436def1451285599a1b1ad70800493b8dcafde2912e1a38345633054e4c26",
};

/** A template as the catalog serves it, its thumbnail with a signed link. */
const TEMPLATE = {
  method_id: "mt_cv01",
  name: "CV Analyzer",
  description: "Analyze a CV against a job offer",
  latest_version: 1,
  categories: ["human-resources"],
  organization_name: "Dev Templates",
  thumbnails: [
    {
      ...THUMBNAIL,
      url: `https://app-bucket.s3.amazonaws.com/org_t/blobs/${THUMBNAIL.sha256}?${SIGNED}`,
      expires_at: "2026-11-07T09:15:00+00:00",
    },
  ],
};

const CATEGORIES = [
  { slug: "finance", label: "Finance" },
  { slug: "human-resources", label: "Human resources" },
];

const PAGE = { items: [TEMPLATE], next_cursor: null, ordering: "default", categories: CATEGORIES };

/** A published version as its owner reads it. */
const SUMMARY: MethodVersionSummary = {
  version: 2,
  tree_digest: DIGEST,
  crate_fingerprint: "a1b2c3",
  runner_version: "0.97.0",
  description: "Count the words of a text",
  categories: ["general", "marketing"],
  thumbnails: [THUMBNAIL],
  published_at: "2026-11-07T09:00:00+00:00",
  published_by: "user_owner",
};

const { published_by: _publisher, ...PUBLIC_SUMMARY } = SUMMARY;

const FILES: SavedMethodFile[] = [
  {
    path: "main.mthds",
    sha256: "16c322ec9ceeb29cf54ef4553f087cba1683c3f20f3bf334e49ccc2ad0ecba3e",
    size: 19,
    url: `https://app-bucket.s3.amazonaws.com/org_owner/blobs/16c322ec?${SIGNED}`,
    expires_at: "2026-11-07T09:15:00+00:00",
  },
];

/** Another organization's public method, as a reader outside it reads it. */
const PUBLIC_METHOD: PublicMethodDetail = {
  method_id: "mt_stats01",
  org_id: "org_owner",
  name: "Text stats",
  description: "Count the words of a text",
  categories: ["general", "marketing"],
  created_at: "2026-11-01T09:00:00+00:00",
  latest_version: 2,
  latest_published: PUBLIC_SUMMARY,
  visibility: "public",
  files: FILES,
};

/** The same method as its owner reads it. */
const OWN_METHOD: MethodDetail = {
  method_id: "mt_stats01",
  org_id: "org_owner",
  created_by_user_id: "user_owner",
  name: "Text stats",
  input_data: { text: "hello" },
  pipe_output: null,
  description: "Count the words of a text",
  categories: ["general", "marketing"],
  created_at: "2026-11-01T09:00:00+00:00",
  updated_at: "2026-11-07T08:00:00.123456+00:00",
  draft_digest: DIGEST,
  latest_version: 2,
  latest_published: SUMMARY,
  copied_from: null,
  visibility: "public",
  files: FILES,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("listMethodTemplates", () => {
  it("GETs /v1/method-templates with no query, and reads the page whole", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, PAGE));

    const page = await makeClient().listMethodTemplates();

    expect(requestedUrls(spy)).toEqual([`${BASE_URL}/v1/method-templates`]);
    expect(page).toEqual({
      items: [TEMPLATE],
      nextCursor: null,
      ordering: "default",
      categories: CATEGORIES,
    } satisfies MethodTemplatePage);
  });

  it("sends the ordering, the category, the limit and the cursor it is given", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ...PAGE, next_cursor: "c2" }));

    const page = await makeClient().listMethodTemplates({
      ordering: "home-test-b",
      category: "human-resources",
      limit: 8,
      cursor: "c1",
    });

    expect(requestedUrls(spy)).toEqual([
      `${BASE_URL}/v1/method-templates?ordering=home-test-b&category=human-resources&limit=8&cursor=c1`,
    ]);
    expect(page.nextCursor).toBe("c2");
  });

  it("reads a catalog with no ordering as null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...PAGE, ordering: null, items: [], categories: [] }),
    );

    const page = await makeClient().listMethodTemplates();

    expect(page.ordering).toBeNull();
    expect(page.items).toEqual([]);
    expect(page.categories).toEqual([]);
  });

  it.each([
    ["items that is not an array", { ...PAGE, items: {} }, "`items` is not an array"],
    [
      "a next_cursor that is neither a string nor null",
      { ...PAGE, next_cursor: 3 },
      "`next_cursor` is neither a string nor null",
    ],
    [
      "an ordering that is neither a string nor null",
      { ...PAGE, ordering: 1 },
      "`ordering` is neither a string nor null",
    ],
    [
      "categories that is not an array",
      { ...PAGE, categories: null },
      "`categories` is not an array",
    ],
    [
      "a template that is no object",
      { ...PAGE, items: [42] },
      "`items` holds an entry that is not an object, at [0]",
    ],
    [
      "a template whose version is a string",
      { ...PAGE, items: [{ ...TEMPLATE, latest_version: "1" }] },
      "`items` holds a template whose `latest_version` is not a positive integer, at [0]",
    ],
    [
      "a template with no organization name",
      { ...PAGE, items: [{ ...TEMPLATE, organization_name: undefined }] },
      "`items` holds a template whose `organization_name` is not a string, at [0]",
    ],
    [
      "a template whose thumbnails are null",
      { ...PAGE, items: [{ ...TEMPLATE, thumbnails: null }] },
      "`items` holds a template whose `thumbnails` is not an array, at [0]",
    ],
    [
      "a thumbnail with no link",
      { ...PAGE, items: [{ ...TEMPLATE, thumbnails: [{ ...TEMPLATE.thumbnails[0], url: null }] }] },
      "`items` holds a thumbnail whose `url` is not a string, at [0].thumbnails[0]",
    ],
    [
      "a category whose slug is no string",
      { ...PAGE, categories: [{ slug: 5, label: "Finance" }] },
      "`categories` holds an entry without a string `slug` and `label`, at [0]",
    ],
  ])("throws a typed ApiResponseError hiding every link for %s", async (_label, body, fault) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await makeClient()
      .listMethodTemplates()
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API GET /v1/method-templates answered 200 with a page of templates whose ${fault}`,
    );
    expect((err as ApiResponseError).responseBody).not.toContain(SIGNED);
  });

  it("throws the platform's refusal of a limit out of range as an ApiResponseError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse("request.invalid", 422, { detail: "limit must be at most 200" }),
    );

    const err = await makeClient()
      .listMethodTemplates({ limit: 500 })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).code).toBe("request.invalid");
  });
});

describe("iterateMethodTemplates", () => {
  it("follows the cursor with the same ordering and category on every page", async () => {
    const second = { ...TEMPLATE, method_id: "mt_invoice01", name: "Invoice Extraction" };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, { ...PAGE, next_cursor: "c1" }))
      .mockResolvedValueOnce(jsonResponse(200, { ...PAGE, items: [second] }));

    const seen: string[] = [];
    for await (const template of makeClient().iterateMethodTemplates({
      ordering: "default",
      category: "finance",
      limit: 1,
    })) {
      seen.push(template.method_id);
    }

    expect(seen).toEqual(["mt_cv01", "mt_invoice01"]);
    expect(requestedUrls(spy)).toEqual([
      `${BASE_URL}/v1/method-templates?ordering=default&category=finance&limit=1`,
      `${BASE_URL}/v1/method-templates?ordering=default&category=finance&limit=1&cursor=c1`,
    ]);
  });
});

describe("another organization's public method", () => {
  it("reads in the narrower shape, which `updated_at` tells from the owner's", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, PUBLIC_METHOD));

    const method = await makeClient().getMethod("mt_stats01");

    expect(method).toEqual(PUBLIC_METHOD);
    expect("updated_at" in method).toBe(false);
    expect(method.latest_published?.published_by).toBeUndefined();
  });

  it.each([
    [
      "an owner's read that lost its token",
      (() => {
        const { updated_at: _token, ...rest } = OWN_METHOD;
        return rest;
      })(),
      "a stored method without `updated_at` that carries the owner's `draft_digest`",
    ],
    [
      "a public read without its published version",
      { ...PUBLIC_METHOD, latest_published: null },
      "a stored method read as another organization's public method whose `latest_published` is not an object",
    ],
    [
      "a public read whose version is not a number",
      { ...PUBLIC_METHOD, latest_version: null },
      "a stored method read as another organization's public method whose `latest_version` is not a positive integer",
    ],
  ])("throws a typed ApiResponseError hiding every link for %s", async (_label, body, fault) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const err = await makeClient()
      .getMethod("mt_stats01")
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API GET /v1/methods/mt_stats01 answered 200 with ${fault}`,
    );
    expect((err as ApiResponseError).responseBody).not.toContain(SIGNED);
  });

  it("reads the caller's own method whole, with its visibility and categories", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, OWN_METHOD));

    const method = await makeClient().getMethod("mt_stats01");

    expect("updated_at" in method).toBe(true);
    if (!("updated_at" in method)) throw new Error("expected the owner's shape");
    expect(method.updated_at).toBe(OWN_METHOD.updated_at);
    expect(method.visibility).toBe("public");
    expect(method.categories).toEqual(["general", "marketing"]);
    expect(method.latest_published?.thumbnails).toEqual([THUMBNAIL]);
  });

  it("types the read as the union, narrowed by `updated_at`", () => {
    type Read = Awaited<ReturnType<PipelexApiClient["getMethod"]>>;
    expectTypeOf<Read>().toEqualTypeOf<MethodDetail | PublicMethodDetail>();
    expectTypeOf<PublicMethodDetail>().not.toHaveProperty("updated_at");
    expectTypeOf<PublicMethodDetail>().not.toHaveProperty("input_data");
    expectTypeOf<PublicMethodDetail>().not.toHaveProperty("draft_digest");
    expectTypeOf<PublicMethodDetail>().not.toHaveProperty("created_by_user_id");
    expectTypeOf<PublicMethodDetail["latest_version"]>().toEqualTypeOf<number>();
    expectTypeOf<MethodVersionSummary["published_by"]>().toEqualTypeOf<string | undefined>();
  });

  it("lists and reads its versions without their publisher", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(200, {
          items: [PUBLIC_SUMMARY, { ...PUBLIC_SUMMARY, version: 1 }],
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { ...PUBLIC_SUMMARY, method_id: "mt_stats01", files: FILES }),
      );
    const client = makeClient();

    const page = await client.listMethodVersions("mt_stats01");
    const version = await client.getMethodVersion("mt_stats01", 2);

    expect(page.items.map((item) => item.version)).toEqual([2, 1]);
    expect(page.items.every((item) => item.published_by === undefined)).toBe(true);
    expect(version.published_by).toBeUndefined();
    expect(version.files).toEqual(FILES);
    expect(requestedUrls(spy)).toEqual([
      `${BASE_URL}/v1/methods/mt_stats01/versions`,
      `${BASE_URL}/v1/methods/mt_stats01/versions/2`,
    ]);
  });

  it("names the version a copy of it took", async () => {
    const copiedFrom: MethodCopiedFrom = {
      org_id: "org_owner",
      method_id: "mt_stats01",
      draft_digest: null,
      version: 2,
    };
    const copy: MethodData = {
      ...OWN_METHOD,
      method_id: "mt_copy01",
      org_id: "org_reader",
      created_by_user_id: "user_reader",
      input_data: null,
      latest_version: null,
      latest_published: null,
      visibility: "internal",
      copied_from: copiedFrom,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        outcome: "copied",
        method: copy,
        examples_copied: 1,
        stored_files_copied: 0,
      }),
    );

    const result = await makeClient().copyMethod("mt_stats01", {
      destination_org_id: "org_reader",
    });

    expect(result.outcome).toBe("copied");
    if (result.outcome !== "copied") throw new Error("expected a copy");
    expect(result.method.copied_from).toEqual(copiedFrom);
    expectTypeOf<MethodCopiedFrom["version"]>().toEqualTypeOf<number | null | undefined>();
  });
});

describe("a public method's publish refusals", () => {
  const VALID = { is_valid: true, is_runnable: true };

  it.each(["thumbnail_missing", "thumbnail_invalid", "storage_reference"] as const)(
    "answers %s as a refused verdict",
    async (reason) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(200, {
          outcome: "refused",
          reason,
          message:
            "The method is public, and its draft holds no thumbnail, so it was not published.",
          validation: VALID,
          method: OWN_METHOD,
        }),
      );

      const result = await makeClient().publishMethod("mt_stats01", {
        expected_draft_updated_at: OWN_METHOD.updated_at,
      });

      expect(result.outcome).toBe("refused");
      if (result.outcome !== "refused") throw new Error("expected a refusal");
      expect(result.reason).toBe(reason);
      expect(result.message).toContain("public");
    },
  );

  it("passes a reason it does not know through as its raw string, still a verdict", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        outcome: "refused",
        reason: "a_later_reason",
        message: "Refused for a reason a later platform added.",
        validation: VALID,
        method: OWN_METHOD,
      }),
    );

    const result = await makeClient().publishMethod("mt_stats01", {
      expected_draft_updated_at: OWN_METHOD.updated_at,
    });

    expect(result).toMatchObject({ outcome: "refused", reason: "a_later_reason" });
  });

  it.each([
    ["a reason that is not a string", { reason: 7 }, "`reason` is not a string"],
    ["no reason", { reason: undefined }, "`reason` is not a string"],
    ["a message that is not a string", { message: null }, "`message` is not a string"],
  ])("throws a typed ApiResponseError for a refusal with %s", async (_label, member, fault) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        outcome: "refused",
        reason: "thumbnail_missing",
        message: "m",
        validation: VALID,
        method: OWN_METHOD,
        ...member,
      }),
    );

    const err = await makeClient()
      .publishMethod("mt_stats01", { expected_draft_updated_at: OWN_METHOD.updated_at })
      .catch((thrown: unknown) => thrown);

    expect(err).toBeInstanceOf(ApiResponseError);
    expect((err as ApiResponseError).message).toBe(
      `API POST /v1/methods/mt_stats01/publish answered 200 with a publish result whose ${fault}`,
    );
  });

  it("types the reasons it knows, and reads the reason open", () => {
    expectTypeOf<MethodPublishRefusalReason>().toEqualTypeOf<
      "invalid" | "not_runnable" | "thumbnail_missing" | "thumbnail_invalid" | "storage_reference"
    >();
    expectTypeOf<"a_later_reason">().toExtend<MethodPublishRefused["reason"]>();
  });
});
